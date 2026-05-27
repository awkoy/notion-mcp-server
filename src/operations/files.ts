import { z } from "zod";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { slimFileUpload, slimList } from "../utils/slim.js";
import type {
  CreateFileUploadBody,
  SendFileUploadBody,
} from "../utils/notion-types.js";

// Notion's documented per-part ceiling for multi-part uploads.
const MAX_PART_BYTES = 5 * 1024 * 1024;

const FILE_UPLOAD_STATUS = ["pending", "uploaded", "expired", "failed"] as const;

const VERBOSE = z.boolean().optional();

const SourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("base64"),
    data: z.string().describe("Base64-encoded file bytes."),
  }),
  z.object({
    type: z.literal("url"),
    url: z.url().describe("Public URL to fetch the file bytes from."),
  }),
]);

type Source = z.infer<typeof SourceSchema>;

async function resolveBytes(source: Source): Promise<Buffer> {
  if (source.type === "base64") return Buffer.from(source.data, "base64");
  const res = await fetch(source.url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${source.url}: ${res.status} ${res.statusText}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

function splitIntoParts(buf: Buffer, partSize = MAX_PART_BYTES): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < buf.length; offset += partSize) {
    parts.push(buf.subarray(offset, Math.min(offset + partSize, buf.length)));
  }
  return parts;
}

// Notion's File Upload API requires the Blob's type on send() to match
// the content_type stored at create(). It does NOT accept
// application/octet-stream as a fallback. The allowlist below mirrors the
// MIME types documented at
// https://developers.notion.com/docs/working-with-files-and-media — when the
// caller doesn't pass content_type, infer it from the filename extension so
// create + send agree.
const EXTENSION_TO_MIME: Record<string, string> = {
  // Audio
  aac: "audio/aac",
  flac: "audio/x-flac",
  m4a: "audio/mp4",
  mid: "audio/midi",
  midi: "audio/midi",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  weba: "audio/webm",
  wma: "audio/x-ms-wma",
  // Image
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  ico: "image/vnd.microsoft.icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  // Video
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
  amv: "video/x-amv",
  asf: "video/x-ms-asf",
  avi: "video/x-msvideo",
  f4v: "video/x-f4v",
  flv: "video/x-flv",
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  ogv: "video/ogg",
  qt: "video/quicktime",
  webm: "video/webm",
  // Documents
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  txt: "text/plain",
};

function inferContentType(filename: string): string | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return undefined;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_MIME[ext];
}

// ──────────────────────────────────────────────────────────────────────────
// upload_file
// ──────────────────────────────────────────────────────────────────────────

const UploadFileParams = z.object({
  mode: z
    .enum(["single", "multi"])
    .optional()
    .describe("'single' (default) = one create+send call. 'multi' = chunk into 5MB parts then complete."),
  filename: z.string(),
  content_type: z.string().optional(),
  source: SourceSchema,
});

register({
  name: "upload_file",
  description:
    "Upload a file via Notion's file_uploads API. Handles single-part (one create + one send) and multi-part (create + N sends + complete) transparently.\n\nSource shapes:\n  • Base64 bytes: `source: { type: \"base64\", data: \"<b64 string>\" }`\n  • Public URL:   `source: { type: \"url\", url: \"https://example.com/file.pdf\" }` (the server fetches it server-side).\n\n`mode` defaults to \"single\"; only pass \"multi\" for files larger than ~5MB.",
  batchable: false,
  schema: UploadFileParams,
  example: {
    filename: "report.pdf",
    content_type: "application/pdf",
    source: { type: "base64", data: "JVBERi0xLjQK..." },
  },
  handler: tryHandler(async ({ mode, filename, content_type, source }) => {
    const effectiveMode = mode ?? "single";
    const notion = await getClient();
    const bytes = await resolveBytes(source);
    // Notion rejects send() when the Blob's MIME doesn't match the
    // content_type stored at create(), and rejects application/octet-stream
    // outright. Resolve a single MIME for both sides: caller's content_type
    // wins, else infer from the filename extension.
    const effectiveType = content_type ?? inferContentType(filename);
    if (!effectiveType) {
      return {
        ok: false,
        error: {
          code: "validation_error",
          message: `Could not infer content_type from filename "${filename}". Notion's File Upload API rejects application/octet-stream and only accepts a fixed allowlist of MIME types.`,
          fix: "Pass `content_type` explicitly (e.g. \"application/pdf\", \"image/png\", \"text/plain\"). See https://developers.notion.com/docs/working-with-files-and-media for the full list.",
        },
      };
    }

    if (effectiveMode === "single") {
      const createBody: CreateFileUploadBody = {
        mode: "single_part",
        filename,
        content_type: effectiveType,
      };
      const created = await notion.fileUploads.create(createBody);
      const sendBody: SendFileUploadBody = {
        file_upload_id: created.id,
        file: { filename, data: new Blob([bytes], { type: effectiveType }) },
      };
      const sent = await notion.fileUploads.send(sendBody);
      return { ok: true, data: slimFileUpload(sent) };
    }

    const parts = splitIntoParts(bytes);
    const createBody: CreateFileUploadBody = {
      mode: "multi_part",
      filename,
      content_type: effectiveType,
      number_of_parts: parts.length,
    };
    const created = await notion.fileUploads.create(createBody);

    for (const [index, part] of parts.entries()) {
      const partNumber = index + 1;
      const sendBody: SendFileUploadBody = {
        file_upload_id: created.id,
        file: { filename, data: new Blob([part], { type: effectiveType }) },
        part_number: String(partNumber),
      };
      try {
        await notion.fileUploads.send(sendBody);
      } catch (err) {
        // Notion has no abort endpoint — the upload object expires on its
        // own. Surface part number + upload id so the caller can either
        // retry the upload from scratch or look up the dangling object.
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Multi-part upload ${created.id} failed on part ${partNumber}/${parts.length}: ${reason}. The upload object will expire automatically; re-call upload_file to retry.`
        );
      }
    }

    const completed = await notion.fileUploads.complete({
      file_upload_id: created.id,
    });
    return { ok: true, data: slimFileUpload(completed) };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// list_file_uploads
// ──────────────────────────────────────────────────────────────────────────

const ListFileUploadsParams = z.object({
  status: z.enum(FILE_UPLOAD_STATUS).optional(),
  start_cursor: z.string().optional(),
  page_size: z.number().min(1).max(100).optional(),
  verbose: VERBOSE,
});

register({
  name: "list_file_uploads",
  description: "List file uploads, optionally filtered by status.",
  batchable: false,
  schema: ListFileUploadsParams,
  example: { status: "uploaded" },
  handler: tryHandler(async ({ status, start_cursor, page_size, verbose }) => {
    const notion = await getClient();
    const response = await notion.fileUploads.list({
      ...(status !== undefined ? { status } : {}),
      ...(start_cursor !== undefined ? { start_cursor } : {}),
      ...(page_size !== undefined ? { page_size } : {}),
    });
    return {
      ok: true,
      data: slimList(response, slimFileUpload, verbose ?? false),
    };
  }),
});

// ──────────────────────────────────────────────────────────────────────────
// get_file_upload
// ──────────────────────────────────────────────────────────────────────────

const GetFileUploadParams = z.object({
  file_upload_id: z.string(),
  verbose: VERBOSE,
});

register({
  name: "get_file_upload",
  description: "Retrieve a single file upload by ID.",
  batchable: true,
  schema: GetFileUploadParams,
  example: { file_upload_id: "<file-upload-id>" },
  exampleBatch: {
    items: [
      { file_upload_id: "<fu-1>" },
      { file_upload_id: "<fu-2>" },
    ],
  },
  handler: tryHandler(async ({ file_upload_id, verbose }) => {
    const notion = await getClient();
    const response = await notion.fileUploads.retrieve({ file_upload_id });
    return { ok: true, data: slimFileUpload(response, verbose ?? false) };
  }),
});
