import { z } from "zod";
import { constants, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getClient, proxyAwareFetch } from "../services/notion.js";
import { bodyStream, discardBody, fetchPublicUrl } from "../services/public-fetch.js";
import { getActiveTransport } from "../config/http.js";
import { register } from "./registry.js";
import { tryHandler } from "../utils/handler.js";
import { readCapped } from "../utils/read-capped.js";
import { slimFileUpload, slimList } from "../utils/slim.js";
import { asSdk } from "../utils/notion-types.js";
import type {
  AppendBlockBody,
  AppendBlockChildren,
  CreateFileUploadBody,
  SendFileUploadBody,
} from "../utils/notion-types.js";
import { FILE_REF_PREFIX, blockFileRef, parseFileRef } from "../utils/file-ref.js";
import { notionId } from "../schema/id.js";
import type { OperationError, OperationResult } from "./types.js";

// Part size for multi-part uploads. Notion takes parts of 5 to 20 MiB, the
// last one smaller.
const MAX_PART_BYTES = 5 * 1024 * 1024;

// The largest file Notion takes in a single-part upload. Anything bigger has
// to go in parts.
const SINGLE_PART_MAX_BYTES = 20 * 1024 * 1024;

// The whole file is held in memory while it is sent, so the server caps it.
// Notion's own per-file limit is 5 MiB on free workspaces and 5 GiB on paid.
const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const DEFAULT_URL_TIMEOUT_MS = 30_000;

const FILE_UPLOAD_STATUS = ["pending", "uploaded", "expired", "failed"] as const;

const VERBOSE = z.boolean().optional();

const SourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("base64"),
    data: z.string().describe("Base64-encoded file bytes."),
  }),
  z.object({
    type: z.literal("url"),
    url: z
      .url({ protocol: /^https?$/ })
      .describe("Public http(s) URL the server fetches the bytes from. Hosts that resolve to private, loopback or link-local addresses are refused, redirects included."),
  }),
  z.object({
    type: z.literal("path"),
    path: z
      .string()
      .describe(
        "Local filesystem path (absolute, or ~-relative). The server reads the file directly — bytes never pass through the tool call, so this is the fastest, cheapest source for files on the same machine as the server. Confined to NOTION_UPLOAD_ROOT when it is set."
      ),
  }),
]);

type Source = z.infer<typeof SourceSchema>;

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]?.trim() || undefined);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function truthyEnv(name: string): boolean {
  return ["true", "1", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}

// A source the server will not read, carrying the envelope to return. The
// helpers below throw it and the handler turns it into { ok: false }, so a
// refusal reads as one, not as an internal_error.
class UploadRefused extends Error {
  constructor(readonly error: OperationError) {
    super(error.message);
  }
}

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
 * re-append. That keeps a missing file an ordinary ENOENT from the read instead
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

// The first dot-named segment of a path: ~/.ssh, ~/.aws, ~/.config, .env,
// .git, .npmrc. Credentials and tokens live under names like these.
function hiddenSegment(p: string): string | undefined {
  return p.split(sep).find((s) => s.startsWith(".") && s !== "." && s !== "..");
}

/**
 * Decide whether a path source may be read, and return the real path to read.
 *
 * A path source hands the server a filename and the server reads it, so
 * whoever writes the tool call can read any file the server user can: a model
 * following instructions it found in a page, or, over HTTP, anyone who can
 * reach the endpoint. So:
 *
 * - NOTION_UPLOAD_ROOT set: the path must resolve inside it, and a relative
 *   path resolves against it. NOTION_UPLOAD_ROOT=/ turns confinement off.
 * - Unset, HTTP transport: refused. The caller is remote.
 * - Unset, stdio: allowed, except a path with a dot-named segment, checked on
 *   the real path so a symlink cannot hide one. A heuristic that keeps the
 *   usual credential stores out; the root is the boundary.
 */
async function resolveUploadPath(p: string): Promise<string> {
  const root = process.env.NOTION_UPLOAD_ROOT?.trim();
  if (!root) {
    if (getActiveTransport() === "http") {
      throw new UploadRefused({
        code: "path_not_allowed",
        message:
          "Path sources are off over the HTTP transport unless NOTION_UPLOAD_ROOT is set: the caller is remote, and could otherwise read any file the server can.",
        fix: "Send the bytes as a base64 source, or ask the server's operator to set NOTION_UPLOAD_ROOT to the directory uploads may come from.",
      });
    }
    const target = await realpathAsDeepAsPossible(resolve(expandHome(p)));
    const hidden = hiddenSegment(target);
    if (hidden) {
      throw new UploadRefused({
        code: "path_not_allowed",
        message: `Refusing to upload ${p}: the path goes through "${hidden}", and dot-named files and directories are where credentials and config live (~/.ssh, ~/.aws, .env).`,
        fix: "Copy the file out of the dot-named directory first, or set NOTION_UPLOAD_ROOT to the directory uploads may come from: inside the root, dot names are allowed.",
      });
    }
    return target;
  }

  // Compare real paths, not lexical ones. resolve() never touches the disk, so
  // on its own it green-lights a symlink that sits inside the root and points
  // out of it: the prefix matches, and then open() follows the link anyway.
  const base = await realpathAsDeepAsPossible(resolve(expandHome(root)));
  const target = await realpathAsDeepAsPossible(resolve(base, expandHome(p)));
  const withSep = base.endsWith(sep) ? base : base + sep;
  if (target !== base && !target.startsWith(withSep)) {
    throw new UploadRefused({
      code: "path_not_allowed",
      message: `Path is outside NOTION_UPLOAD_ROOT: ${p}. Uploads are confined to ${base}.`,
      fix: "Pass a path inside the upload root, or a path relative to it.",
    });
  }
  return target;
}

type Limit = { bytes: number; tooLarge: (size: string) => OperationError };

/**
 * Read a path source: a regular file no larger than the limit, checked before
 * a byte is read. /dev/zero or a FIFO would never end, and a huge file would
 * be in memory before any later check ran. The open is non-blocking, so a
 * path swapped for a FIFO after the stat cannot hang it, and the stat is
 * repeated on the open handle.
 */
async function readUploadFile(path: string, limit: Limit): Promise<Buffer> {
  const notAFile = () =>
    new UploadRefused({
      code: "validation_error",
      message: `${path} is not a regular file.`,
      fix: "Pass the path of a file, not a directory, device or pipe.",
    });
  const before = await stat(path);
  if (!before.isFile()) throw notAFile();
  if (before.size > limit.bytes) throw new UploadRefused(limit.tooLarge(`${before.size} bytes`));
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw notAFile();
    if (opened.size > limit.bytes) throw new UploadRefused(limit.tooLarge(`${opened.size} bytes`));
    // The cap again while reading: a file that grows after the stat is cut off.
    const bytes = await readCapped(handle.createReadStream({ autoClose: false }), limit.bytes);
    if (!bytes) throw new UploadRefused(limit.tooLarge(`over ${limit.bytes} bytes`));
    return bytes;
  } finally {
    await handle.close();
  }
}

// Returns Uint8Array<ArrayBuffer> — the DOM Blob constructor's BlobPart type
// rejects Uint8Array<ArrayBufferLike> under newer @types/node (it widens to
// include SharedArrayBuffer). Allocating fresh guarantees the concrete type.
async function resolveBytes(
  source: Source,
  resolvedPath: string | undefined,
  limit: Limit
): Promise<Uint8Array<ArrayBuffer>> {
  let buf: Buffer;
  if (source.type === "base64") {
    // The decoded size is known from the string's length, so an oversized
    // payload is refused without decoding it.
    const size = Buffer.byteLength(source.data, "base64");
    if (size > limit.bytes) throw new UploadRefused(limit.tooLarge(`${size} bytes`));
    buf = Buffer.from(source.data, "base64");
  } else if (source.type === "path") {
    buf = await readUploadFile(resolvedPath ?? (await resolveUploadPath(source.path)), limit);
  } else {
    const fetched = await fetchPublicUrl(source.url, {
      maxBytes: limit.bytes,
      timeoutMs: positiveIntEnv("NOTION_UPLOAD_URL_TIMEOUT_MS", DEFAULT_URL_TIMEOUT_MS),
      allowPrivate: truthyEnv("NOTION_UPLOAD_ALLOW_PRIVATE_URLS"),
      tooLarge: limit.tooLarge,
    });
    if (!fetched.ok) throw new UploadRefused(fetched.error);
    buf = fetched.bytes;
  }
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
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

// Notion's File Upload API requires the Blob's type on send() to match the
// content_type stored at create(). The map below mirrors the MIME types
// documented at https://developers.notion.com/docs/working-with-files-and-media
// so a known extension gets its exact type, which also picks the block type
// for attach_to. An extension not listed here is sent as
// application/octet-stream: since 2026-09-22 Notion treats that as
// unspecified and resolves the type from the filename's extension, rejecting
// only extensions it does not support.
const OCTET_STREAM = "application/octet-stream";

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
  htm: "text/html",
  html: "text/html",
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
  // CAD and 3D (accepted since 2026-09-22; attached as file blocks)
  "3dm": "application/vnd.mcneel.3dm",
  "3mf": "model/3mf",
  dae: "model/vnd.collada+xml",
  dwf: "model/vnd.dwf",
  dwg: "image/vnd.dwg",
  dxf: "image/vnd.dxf",
  fbx: "application/vnd.autodesk.fbx",
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  iges: "model/iges",
  igs: "model/iges",
  obj: "model/obj",
  rfa: "application/vnd.autodesk.revit",
  rvt: "application/vnd.autodesk.revit",
  step: "model/step",
  stl: "model/stl",
  stp: "model/step",
  usdz: "model/vnd.usdz+zip",
};

// The MIME type for a filename: the mapped one, octet-stream for an extension
// the map lacks (Notion resolves it), undefined for no extension at all.
function inferContentType(filename: string): string | undefined {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return undefined;
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? OCTET_STREAM;
}

function isOctetStream(contentType: string): boolean {
  return contentType.split(";")[0].trim().toLowerCase() === OCTET_STREAM;
}

// ──────────────────────────────────────────────────────────────────────────
// upload_file
// ──────────────────────────────────────────────────────────────────────────

// Notion picks the block type from the media kind, and rejects a file_upload
// in a block whose type does not match the upload's content_type ("You can't
// use a video in an image block"). Its supported-types table groups formats
// by the same MIME families, so the prefix is the rule: image/* covers svg,
// webp, avif and ico as well as png/jpeg; video/* covers webm, mkv and 3gp;
// audio/* covers flac, opus and weba. The exception is CAD: dwg and dxf are
// registered under image/, but Notion attaches CAD and 3D files as file blocks.
type MediaBlockType = "image" | "video" | "audio" | "pdf" | "file";

const CAD_IMAGE_TYPES = new Set(["image/vnd.dwg", "image/vnd.dxf"]);

function blockTypeFor(contentType: string): MediaBlockType {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (CAD_IMAGE_TYPES.has(type)) return "file";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  return "file";
}

// Same placement fields as append_blocks, so a caller who knows one knows both.
const AttachToSchema = z
  .object({
    block_id: notionId("block").describe("Page or block to append the uploaded file to."),
    caption: z.string().optional().describe("Caption for the new block, as plain text."),
    after: notionId("block").optional().describe("Append immediately after this block ID (legacy ordering)."),
    position: z.enum(["start", "end"]).optional().describe("Append at start or end. Preferred over `after`."),
  })
  .refine((v) => !(v.after && v.position), {
    message: "Pass at most one of `after` or `position`.",
  });

const UploadFileParams = z.object({
  mode: z
    .enum(["single", "multi"])
    .optional()
    .describe("Omit to pick by size: 'single' (one create+send call) up to 20 MiB, 'multi' (5 MiB parts, then complete) above."),
  attach_to: AttachToSchema.optional().describe(
    "Append the file to a page as a block, in the same call. Without this, upload_file returns a file_upload_id and nothing references it."
  ),
  filename: z
    .string()
    .optional()
    .describe(
      "Required for base64 and url sources. Optional for a path source — defaults to the file's basename."
    ),
  content_type: z
    .string()
    .optional()
    .describe("Defaults to the type for the filename's extension. An extension the server does not know is sent as application/octet-stream, and Notion resolves it."),
  source: SourceSchema,
});

register({
  name: "upload_file",
  access: "write",
  domain: "files",
  description:
    "Upload a file via Notion's file_uploads API. Handles single-part (one create + one send) and multi-part (create + N sends + complete) transparently.\n\nSource shapes:\n  • Local path:   `source: { type: \"path\", path: \"/abs/or/~/file.pdf\" }` (server reads the file directly — preferred for local files; filename is derived from the path if omitted). Confined to NOTION_UPLOAD_ROOT when it is set. Without it, refused over the HTTP transport, and over stdio refused for paths through a dot-named file or directory (~/.ssh, .env).\n  • Base64 bytes: `source: { type: \"base64\", data: \"<b64 string>\" }`\n  • Public URL:   `source: { type: \"url\", url: \"https://example.com/file.pdf\" }` (the server fetches it: http(s) only, public addresses only, redirects checked the same way, time-limited).\n\n`mode` is picked from the size when omitted: \"single\" up to 20 MiB, \"multi\" above. Files over NOTION_UPLOAD_MAX_BYTES (default 1 GiB) are refused before they are read; Notion's own limit is 5 MiB per file on free workspaces and 5 GiB on paid.\n\n`content_type` defaults to the type for the filename's extension; an extension the server does not know is sent as application/octet-stream and Notion resolves it from the filename.\n\nPass `attach_to` to place the file on a page in the same call — without it the result is a file_upload_id that nothing references yet.\n  • `attach_to: { block_id: \"<page-or-block-id>\", caption?: \"...\", position?: \"start\"|\"end\", after?: \"<block-id>\" }` — same placement fields as append_blocks.\n  • The block type follows the content type: image/* → image, video/* → video, audio/* → audio, application/pdf → pdf, anything else (CAD and 3D included) → file.\n  • The result then carries `block_id` and `block_type` next to `file_upload_id`. If the append fails after the upload, the error names the file_upload_id so it can be placed with append_blocks instead of re-uploaded.\n\nExample: `{ source: { type: \"path\", path: \"~/Desktop/chart.png\" }, attach_to: { block_id: \"<page-id>\", caption: \"Q3 revenue\" } }`",
  batchable: false,
  schema: UploadFileParams,
  example: {
    filename: "report.pdf",
    content_type: "application/pdf",
    source: { type: "base64", data: "JVBERi0xLjQK..." },
  },
  handler: tryHandler(async (params) => {
    try {
      return await uploadFile(params);
    } catch (err) {
      if (err instanceof UploadRefused) return { ok: false, error: err.error };
      throw err;
    }
  }),
});

async function uploadFile({
  mode,
  filename,
  content_type,
  source,
  attach_to,
}: z.infer<typeof UploadFileParams>): Promise<OperationResult> {
  // Resolved once: the policy check, the default filename and the read all
  // use the same real path.
  const resolvedPath =
    source.type === "path" ? await resolveUploadPath(source.path) : undefined;
  // A path source carries its own name; fall back to the basename when the
  // caller doesn't pass filename explicitly. base64/url have no name to
  // derive, so filename stays required there.
  const effectiveFilename = filename ?? (resolvedPath ? basename(resolvedPath) : undefined);
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
  // Notion rejects send() when the Blob's MIME doesn't match the
  // content_type stored at create(). Resolve a single MIME for both sides:
  // caller's content_type wins, else infer from the filename extension.
  // Checked before any bytes are read or fetched.
  const effectiveType = content_type ?? inferContentType(effectiveFilename);
  if (!effectiveType) {
    return {
      ok: false,
      error: {
        code: "validation_error",
        message: `Could not infer content_type from filename "${effectiveFilename}": it has no extension, and Notion resolves the type from one or the other.`,
        fix: "Give `filename` its extension (e.g. \"report.pdf\"), or pass `content_type` explicitly (e.g. \"application/pdf\"). See https://developers.notion.com/docs/working-with-files-and-media for the supported types.",
      },
    };
  }

  // An explicit "single" is held to Notion's single-part limit; otherwise
  // the mode follows the size and only the server's own cap applies.
  const maxBytes = positiveIntEnv("NOTION_UPLOAD_MAX_BYTES", DEFAULT_MAX_UPLOAD_BYTES);
  const singleCapped = mode === "single" && SINGLE_PART_MAX_BYTES < maxBytes;
  const limit: Limit = {
    bytes: singleCapped ? SINGLE_PART_MAX_BYTES : maxBytes,
    tooLarge: (size) =>
      singleCapped
        ? {
            code: "too_large",
            message: `${effectiveFilename} is ${size}, over Notion's ${SINGLE_PART_MAX_BYTES} byte (20 MiB) limit for a single-part upload.`,
            fix: 'Omit `mode` (the size picks it) or pass mode: "multi".',
          }
        : {
            code: "too_large",
            message: `${effectiveFilename} is ${size}, over this server's upload limit of ${maxBytes} bytes.`,
            fix: "The server operator can raise NOTION_UPLOAD_MAX_BYTES. Notion itself takes up to 5 MiB per file on free workspaces and 5 GiB on paid.",
          },
  };

  const notion = await getClient();
  const bytes = await resolveBytes(source, resolvedPath, limit);
  const effectiveMode = mode ?? (bytes.byteLength > SINGLE_PART_MAX_BYTES ? "multi" : "single");

  // Both modes end the same way: slim the upload, and append a block for it
  // when the caller asked for one.
  const finish = async (
    uploaded: Parameters<typeof slimFileUpload>[0]
  ): Promise<OperationResult> => {
    const data = slimFileUpload(uploaded);
    if (!attach_to) return { ok: true, data };
    // For octet-stream, the type Notion resolved from the extension is the
    // one the block has to match.
    const kind = blockTypeFor(
      isOctetStream(effectiveType) && uploaded.content_type ? uploaded.content_type : effectiveType
    );
    const block = {
      object: "block",
      type: kind,
      [kind]: {
        type: "file_upload",
        file_upload: { id: uploaded.id },
        ...(attach_to.caption
          ? { caption: [{ type: "text", text: { content: attach_to.caption } }] }
          : {}),
      },
    };
    // Same placement rule as append_blocks.
    const position = attach_to.position
      ? { type: attach_to.position }
      : attach_to.after
        ? { type: "after_block" as const, after_block: { id: attach_to.after } }
        : undefined;
    try {
      const appended = await notion.blocks.children.append(
        asSdk<AppendBlockBody>({
          block_id: attach_to.block_id,
          children: asSdk<AppendBlockChildren>([block]),
          ...(position ? { position } : {}),
        })
      );
      // Notion returns just the new block for end/after, but the full child
      // set for position "start" — the new block comes first either way.
      return {
        ok: true,
        data: { ...data, block_id: appended.results[0]?.id, block_type: kind },
      };
    } catch (err) {
      // The upload itself succeeded and its id is still usable. A thrown
      // error would hide that, and the caller would upload the same bytes
      // again to get an id it already has.
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          code: "attach_failed",
          message: `Uploaded as file_upload_id ${uploaded.id}, but appending a ${kind} block to ${attach_to.block_id} failed: ${reason}`,
          fix: `The upload is done — do not re-upload. Place it with append_blocks: { block_id: "${attach_to.block_id}", children: [{ type: "${kind}", ${kind}: { type: "file_upload", file_upload: { id: "${uploaded.id}" } } }] }`,
        },
      };
    }
  };

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
    return finish(sent);
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
  return finish(completed);
}

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

// A file url and where it came from. `hosted` means Notion minted the url (a
// signed S3 link) for a file it stores. An external url is whatever a
// workspace member — or a model, via append_blocks — typed in, so the server
// hands it back as text but never fetches it.
type ResolvedFile = { url: string; hosted: boolean };

type FileBody = {
  type?: string;
  file?: { url?: string };
  external?: { url?: string };
};

function fileFrom(body: FileBody | undefined): ResolvedFile | undefined {
  if (body?.file?.url) return { url: body.file.url, hosted: true };
  if (body?.external?.url) return { url: body.external.url, hosted: false };
  return undefined;
}

// Pull the file out of whichever media block this is. Notion keys the body
// by block type, and every media type carries the same {type, file|external}
// shape underneath.
function fileFromBlock(block: unknown): ResolvedFile | undefined {
  const b = block as { type?: string } & Record<string, unknown>;
  if (!b?.type) return undefined;
  return fileFrom(b[b.type] as FileBody | undefined);
}

async function resolveFileRef(
  ref: string
): Promise<ResolvedFile | OperationError> {
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
    const file = fileFromBlock(block);
    if (!file) {
      return {
        code: "not_found",
        message: `Block ${parsed.blockId} carries no file.`,
        fix: "Point the ref at an image, video, audio, pdf or file block.",
      };
    }
    return file;
  }

  const page = await notion.pages.retrieve({ page_id: parsed.pageId });
  const props = (page as { properties?: Record<string, unknown> }).properties;
  const prop = props?.[parsed.property] as
    | { type?: string; files?: FileBody[] }
    | undefined;
  const file = fileFrom(prop?.files?.[parsed.index]);
  if (!file) {
    return {
      code: "not_found",
      message: `Page ${parsed.pageId} has no file at ${parsed.property}[${parsed.index}].`,
      fix: "Re-read the page: a files property changes index when an entry is removed.",
    };
  }
  return file;
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

// The media type alone, lowercased, parameters such as charset dropped. Only
// image/* is returned as image content: a model handed an HTML error page
// labelled image/png has no way to tell.
function imageMimeType(contentType: string | null): string | undefined {
  const type = contentType?.split(";")[0].trim().toLowerCase();
  return type && type.startsWith("image/") ? type : undefined;
}

const tooLarge = (size: string): OperationError => ({
  code: "too_large",
  message: `Image is ${size}, over the ${MAX_IMAGE_BYTES} byte limit.`,
  fix: "Use get_file_url and fetch it outside the tool call.",
});

// A scheme followed by "//" is a URL, not a ref or an id. Checked before
// anything is resolved so a caller-supplied URL never reaches fetch.
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

register({
  name: "get_image",
  access: "read",
  domain: "files",
  description:
    "Fetch a Notion-hosted image and return it as image content, so the model can see it. Takes a notion-file: ref or a block id — never a URL: the server fetches only the signed URL Notion returns for that object. Refuses non-image files and images over 5 MB. Every other operation returns text only.",
  batchable: false,
  schema: z.object({
    ref: z
      .string()
      .describe("A notion-file: ref or a block id. Not a URL."),
  }),
  example: { ref: `${FILE_REF_PREFIX}block/<block-id>` },
  handler: tryHandler(async ({ ref }) => {
    // The server must never GET a URL the caller chose. From a local stdio
    // server that would reach the user's LAN and 169.254.169.254; from a
    // hosted one, the VPC. It is also an exfil channel out of a process that
    // otherwise only talks to api.notion.com. So the only URL fetched here is
    // one Notion returned, in this same call, for a file Notion hosts.
    if (URL_LIKE.test(ref)) {
      return {
        ok: false,
        error: {
          code: "validation_error",
          message: "get_image does not fetch URLs.",
          fix: `Pass a "${FILE_REF_PREFIX}" ref or the id of an image block. To read a URL you already have, fetch it outside the tool call.`,
        },
      };
    }
    const asRef = ref.startsWith(FILE_REF_PREFIX) ? ref : blockFileRef(ref);
    const resolved = await resolveFileRef(asRef);
    if ("code" in resolved) return { ok: false, error: resolved };
    if (!resolved.hosted) {
      return {
        ok: false,
        error: {
          code: "external_file",
          message: `${asRef} points at an external URL, which the server does not fetch.`,
          fix: `The URL is ${resolved.url}. Fetch it outside the tool call.`,
        },
      };
    }
    let url: URL | undefined;
    try {
      url = new URL(resolved.url);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== "https:") {
      return {
        ok: false,
        error: {
          code: "unexpected_url",
          message: `Notion returned a non-https URL for ${asRef}; not fetching it.`,
          fix: "Use get_file_url and fetch it outside the tool call.",
        },
      };
    }

    // proxyAwareFetch, not the global fetch, so HTTPS_PROXY applies here as it
    // does to every Notion API call.
    const res = await proxyAwareFetch(url);
    if (!res.ok) {
      discardBody(res);
      return {
        ok: false,
        error: {
          code: "fetch_failed",
          message: `Could not fetch the image: ${res.status} ${res.statusText}.`,
          fix: "A signed URL expires in about an hour. Call get_image again for a fresh read.",
        },
      };
    }
    const mimeType = imageMimeType(res.headers.get("content-type"));
    if (!mimeType) {
      discardBody(res);
      return {
        ok: false,
        error: {
          code: "not_an_image",
          message: `${asRef} is not an image: the response is ${res.headers.get("content-type") ?? "of unknown type"}.`,
          fix: "get_image only returns image/* content. For any other file, use get_file_url and fetch it outside the tool call.",
        },
      };
    }
    // content-length catches most oversized responses before a byte of body
    // is read; the capped read below covers a missing or wrong header.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      discardBody(res);
      return { ok: false, error: tooLarge(`${declared} bytes`) };
    }
    const bytes = await readCapped(bodyStream(res), MAX_IMAGE_BYTES);
    if (!bytes) {
      return { ok: false, error: tooLarge(`over ${MAX_IMAGE_BYTES} bytes`) };
    }
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
