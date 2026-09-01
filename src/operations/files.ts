import { z } from "zod";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getClient } from "../services/notion.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { slimFileUpload, slimList } from "../utils/slim.js";
import type {
  CreateFileUploadBody,
  SendFileUploadBody,
} from "../utils/notion-types.js";
import { FILE_REF_PREFIX, blockFileRef, parseFileRef } from "../utils/file-ref.js";
import type { OperationError } from "./types.js";

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
  z.object({
    type: z.literal("path"),
    path: z
      .string()
      .describe(
        "Local filesystem path (absolute, or ~-relative). The server reads the file directly — bytes never pass through the tool call, so this is the fastest, cheapest source for files on the same machine as the server."
      ),
  }),
]);

type Source = z.infer<typeof SourceSchema>;

// Expand a leading ~ or ~/ to the current user's home directory. Node's fs
// does not do this itself, and ~-relative paths are the common shape a caller
// hands to a local stdio server.
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * Resolve symlinks as far down the path as it actually exists, keeping the
 * rest lexically.
 *
 * realpath() throws ENOENT the moment a segment is missing, but a segment that
 * does not exist cannot be a symlink either — so the unresolved tail is safe to
 * re-append. That keeps a missing file an ordinary ENOENT from readFile instead
 * of turning it into a confinement error.
 */
async function realpathAsDeepAsPossible(p: string): Promise<string> {
  const tail: string[] = [];
  let current = p;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length > 0 ? join(real, ...tail) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(current);
      if (parent === current) return p; // walked up to the filesystem root
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Confine a path source to NOTION_UPLOAD_ROOT when it is set.
 *
 * A path source hands the server a filename and the server reads it, so
 * whoever writes the tool call can read any file the server user can. Callers
 * that want the model to upload only from one directory set the root, and a
 * relative path then resolves inside it.
 *
 * Unset means no confinement, which is the behavior before this existed.
 */
async function resolveUploadPath(p: string): Promise<string> {
  const root = process.env.NOTION_UPLOAD_ROOT;
  if (!root) return expandHome(p);

  // Compare real paths, not lexical ones. resolve() never touches the disk, so
  // on its own it green-lights a symlink that sits inside the root and points
  // out of it: the prefix matches, and then open() follows the link anyway.
  const base = await realpathAsDeepAsPossible(resolve(expandHome(root)));
  const target = await realpathAsDeepAsPossible(resolve(base, expandHome(p)));
  const withSep = base.endsWith(sep) ? base : base + sep;
  if (target !== base && !target.startsWith(withSep)) {
    throw new Error(
      `Path is outside NOTION_UPLOAD_ROOT: ${p}. Uploads are confined to ${base}.`
    );
  }
  return target;
}

// Returns Uint8Array<ArrayBuffer> — the DOM Blob constructor's BlobPart type
// rejects Uint8Array<ArrayBufferLike> under newer @types/node (it widens to
// include SharedArrayBuffer). Allocating fresh guarantees the concrete type.
async function resolveBytes(source: Source): Promise<Uint8Array<ArrayBuffer>> {
  if (source.type === "base64") {
    const buf = Buffer.from(source.data, "base64");
    const out = new Uint8Array(buf.byteLength);
    out.set(buf);
    return out;
  }
  if (source.type === "path") {
    const buf = await readFile(await resolveUploadPath(source.path));
    const out = new Uint8Array(buf.byteLength);
    out.set(buf);
    return out;
  }
  const res = await fetch(source.url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch ${source.url}: ${res.status} ${res.statusText}`
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

function splitIntoParts(
  buf: Uint8Array<ArrayBuffer>,
  partSize = MAX_PART_BYTES
): Uint8Array<ArrayBuffer>[] {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < buf.length; offset += partSize) {
    const end = Math.min(offset + partSize, buf.length);
    const part = new Uint8Array(end - offset);
    part.set(buf.subarray(offset, end));
    parts.push(part);
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
  md: "text/markdown",
  markdown: "text/markdown",
  pdf: "application/pdf",
  txt: "text/plain",
  // Microsoft Office
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
  filename: z
    .string()
    .optional()
    .describe(
      "Required for base64 and url sources. Optional for a path source — defaults to the file's basename."
    ),
  content_type: z.string().optional(),
  source: SourceSchema,
});

register({
  name: "upload_file",
  access: "write",
  domain: "files",
  description:
    "Upload a file via Notion's file_uploads API. Handles single-part (one create + one send) and multi-part (create + N sends + complete) transparently.\n\nSource shapes:\n  • Local path:   `source: { type: \"path\", path: \"/abs/or/~/file.pdf\" }` (server reads the file directly — preferred for local files; filename is derived from the path if omitted).\n  • Base64 bytes: `source: { type: \"base64\", data: \"<b64 string>\" }`\n  • Public URL:   `source: { type: \"url\", url: \"https://example.com/file.pdf\" }` (the server fetches it server-side).\n\n`mode` defaults to \"single\"; only pass \"multi\" for files larger than ~5MB.",
  batchable: false,
  schema: UploadFileParams,
  example: {
    filename: "report.pdf",
    content_type: "application/pdf",
    source: { type: "base64", data: "JVBERi0xLjQK..." },
  },
  handler: tryHandler(async ({ mode, filename, content_type, source }) => {
    const effectiveMode = mode ?? "single";
    // A path source carries its own name; fall back to the basename when the
    // caller doesn't pass filename explicitly. base64/url have no name to
    // derive, so filename stays required there.
    const effectiveFilename =
      filename ??
      (source.type === "path"
        ? basename(await resolveUploadPath(source.path))
        : undefined);
    if (!effectiveFilename) {
      return {
        ok: false,
        error: {
          code: "validation_error",
          message:
            "filename is required for base64 and url sources (there is no name to derive).",
          fix: 'Pass `filename` (e.g. "report.pdf"), or use a path source to derive it from the path.',
        },
      };
    }
    const notion = await getClient();
    const bytes = await resolveBytes(source);
    // Notion rejects send() when the Blob's MIME doesn't match the
    // content_type stored at create(), and rejects application/octet-stream
    // outright. Resolve a single MIME for both sides: caller's content_type
    // wins, else infer from the filename extension.
    const effectiveType = content_type ?? inferContentType(effectiveFilename);
    if (!effectiveType) {
      return {
        ok: false,
        error: {
          code: "validation_error",
          message: `Could not infer content_type from filename "${effectiveFilename}". Notion's File Upload API rejects application/octet-stream and only accepts a fixed allowlist of MIME types.`,
          fix: "Pass `content_type` explicitly (e.g. \"application/pdf\", \"image/png\", \"text/plain\"). See https://developers.notion.com/docs/working-with-files-and-media for the full list.",
        },
      };
    }

    if (effectiveMode === "single") {
      const createBody: CreateFileUploadBody = {
        mode: "single_part",
        filename: effectiveFilename,
        content_type: effectiveType,
      };
      const created = await notion.fileUploads.create(createBody);
      const sendBody: SendFileUploadBody = {
        file_upload_id: created.id,
        file: {
          filename: effectiveFilename,
          data: new Blob([bytes], { type: effectiveType }),
        },
      };
      const sent = await notion.fileUploads.send(sendBody);
      return { ok: true, data: slimFileUpload(sent) };
    }

    const parts = splitIntoParts(bytes);
    const createBody: CreateFileUploadBody = {
      mode: "multi_part",
      filename: effectiveFilename,
      content_type: effectiveType,
      number_of_parts: parts.length,
    };
    const created = await notion.fileUploads.create(createBody);

    for (const [index, part] of parts.entries()) {
      const partNumber = index + 1;
      const sendBody: SendFileUploadBody = {
        file_upload_id: created.id,
        file: {
          filename: effectiveFilename,
          data: new Blob([part], { type: effectiveType }),
        },
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
  access: "read",
  domain: "files",
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
  access: "read",
  domain: "files",
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

// ──────────────────────────────────────────────────────────────────────────
// get_file_url / get_image
// ──────────────────────────────────────────────────────────────────────────

// Pull the file url out of whichever media block this is. Notion keys the body
// by block type, and every media type carries the same {type, file|external}
// shape underneath.
function urlFromBlock(block: unknown): string | undefined {
  const b = block as { type?: string } & Record<string, unknown>;
  if (!b?.type) return undefined;
  const body = b[b.type] as
    | { type?: string; file?: { url?: string }; external?: { url?: string } }
    | undefined;
  if (!body) return undefined;
  return body.file?.url ?? body.external?.url;
}

async function resolveFileRef(
  ref: string
): Promise<{ url: string } | OperationError> {
  const parsed = parseFileRef(ref);
  if (!parsed) {
    return {
      code: "validation_error",
      message: `Not a file ref: "${ref}".`,
      fix: `A ref looks like "${FILE_REF_PREFIX}block/<block-id>" or "${FILE_REF_PREFIX}page/<page-id>/<property>/<index>". Read one from a block or a files property with NOTION_FILE_URLS=ref.`,
    };
  }
  const notion = await getClient();

  if (parsed.kind === "block") {
    const block = await notion.blocks.retrieve({ block_id: parsed.blockId });
    const url = urlFromBlock(block);
    if (!url) {
      return {
        code: "not_found",
        message: `Block ${parsed.blockId} carries no file.`,
        fix: "Point the ref at an image, video, audio, pdf or file block.",
      };
    }
    return { url };
  }

  const page = await notion.pages.retrieve({ page_id: parsed.pageId });
  const props = (page as { properties?: Record<string, unknown> }).properties;
  const prop = props?.[parsed.property] as
    | { type?: string; files?: { file?: { url?: string }; external?: { url?: string } }[] }
    | undefined;
  const entry = prop?.files?.[parsed.index];
  const url = entry?.file?.url ?? entry?.external?.url;
  if (!url) {
    return {
      code: "not_found",
      message: `Page ${parsed.pageId} has no file at ${parsed.property}[${parsed.index}].`,
      fix: "Re-read the page: a files property changes index when an entry is removed.",
    };
  }
  return { url };
}

const FileRefParams = z.object({
  ref: z.string().describe(`A ref emitted under NOTION_FILE_URLS=ref, e.g. "${FILE_REF_PREFIX}block/<block-id>".`),
});

register({
  name: "get_file_url",
  access: "read",
  domain: "files",
  description:
    "Turn a notion-file: ref into a fresh signed URL. Nothing is cached: the ref names its source object, so this re-reads it. The URL expires in about an hour.",
  batchable: true,
  schema: FileRefParams,
  example: { ref: `${FILE_REF_PREFIX}block/<block-id>` },
  handler: tryHandler(async ({ ref }) => {
    const resolved = await resolveFileRef(ref);
    if ("code" in resolved) return { ok: false, error: resolved };
    return { ok: true, data: { ref, url: resolved.url } };
  }),
});

// 5 MB of base64 is roughly 6.7 MB on the wire and far past what a model reads
// usefully. Refuse rather than blow up the response.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

register({
  name: "get_image",
  access: "read",
  domain: "files",
  description:
    "Fetch an image and return it as image content, so the model can see it. Takes a notion-file: ref, a block id, or a URL. Every other operation returns text only.",
  batchable: false,
  schema: z.object({
    ref: z
      .string()
      .describe("A notion-file: ref, a block id, or a direct image URL."),
  }),
  example: { ref: `${FILE_REF_PREFIX}block/<block-id>` },
  handler: tryHandler(async ({ ref }) => {
    let url: string;
    if (/^https?:\/\//i.test(ref)) {
      url = ref;
    } else {
      const asRef = ref.startsWith(FILE_REF_PREFIX) ? ref : blockFileRef(ref);
      const resolved = await resolveFileRef(asRef);
      if ("code" in resolved) return { ok: false, error: resolved };
      url = resolved.url;
    }

    const res = await fetch(url);
    if (!res.ok) {
      return {
        ok: false,
        error: {
          code: "fetch_failed",
          message: `Could not fetch the image: ${res.status} ${res.statusText}.`,
          fix: "A signed URL expires in about an hour. Call get_file_url again for a fresh one.",
        },
      };
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        error: {
          code: "too_large",
          message: `Image is ${bytes.length} bytes, over the ${MAX_IMAGE_BYTES} byte limit.`,
          fix: "Use get_file_url and fetch it outside the tool call.",
        },
      };
    }
    const mimeType = res.headers.get("content-type")?.split(";")[0] ?? "image/png";
    // _mcp_content leaves the JSON envelope and becomes MCP content blocks in
    // the tool layer. Nothing else in this server returns non-text content.
    return {
      ok: true,
      data: {
        _mcp_content: [{ type: "image", data: bytes.toString("base64"), mimeType }],
      },
    };
  }),
});
