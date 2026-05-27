import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type {
  BatchResult,
  OperationError,
  OperationResult,
} from "../src/operations/types.js";

const MB = 1024 * 1024;
const MAX_PART_BYTES = 5 * MB;

// Mock signatures that mirror the SDK shapes we exercise. Typing the
// fakes (rather than `as`-casting their call args later) makes
// notionStub.fileUploads.send.mock.calls[n][0] strongly typed for free.
type CreateArgs = {
  mode: "single_part" | "multi_part" | "external_url";
  filename?: string;
  content_type?: string;
  number_of_parts?: number;
  external_url?: string;
};

type SendArgs = {
  file_upload_id: string;
  file: { filename?: string; data: Blob | string };
  part_number?: string;
};

type FileUploadIdArg = { file_upload_id: string };

type ListArgs = {
  status?: "pending" | "uploaded" | "expired" | "failed";
  start_cursor?: string;
  page_size?: number;
};

type FileUploadShape = {
  id: string;
  status?: string;
  filename?: string;
  content_type?: string;
  content_length?: number;
  expiry_time?: string | null;
};

type ListShape = {
  object: "list";
  results: FileUploadShape[];
  has_more: boolean;
  next_cursor: string | null;
};

const notionStub = {
  fileUploads: {
    create: vi.fn<(args: CreateArgs) => Promise<FileUploadShape>>(),
    send: vi.fn<(args: SendArgs) => Promise<FileUploadShape>>(),
    complete: vi.fn<(args: FileUploadIdArg) => Promise<FileUploadShape>>(),
    retrieve: vi.fn<(args: FileUploadIdArg) => Promise<FileUploadShape>>(),
    list: vi.fn<(args: ListArgs) => Promise<ListShape>>(),
  },
};

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => notionStub,
}));

import { initOperations } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  for (const fn of Object.values(notionStub.fileUploads)) fn.mockReset();
});

// ──────────────────────────────────────────────────────────────────────────
// Narrowing helpers — let TypeScript prove the shape instead of `as` casts.
// ──────────────────────────────────────────────────────────────────────────

type DispatchResult = OperationResult | BatchResult;

function assertOk(
  res: DispatchResult
): asserts res is { ok: true; data: unknown } {
  if (!res.ok || !("data" in res)) {
    throw new Error(`Expected ok single result, got: ${JSON.stringify(res)}`);
  }
}

function assertErr(
  res: DispatchResult
): asserts res is { ok: false; error: OperationError } {
  if (res.ok || !("error" in res)) {
    throw new Error(`Expected error result, got: ${JSON.stringify(res)}`);
  }
}

function sendArgs(callIndex: number): SendArgs {
  const calls = notionStub.fileUploads.send.mock.calls;
  if (calls.length <= callIndex) {
    throw new Error(`fileUploads.send was not called ${callIndex + 1} times`);
  }
  return calls[callIndex][0];
}

async function sendBytes(callIndex: number): Promise<Buffer> {
  const data = sendArgs(callIndex).file.data;
  if (typeof data === "string") return Buffer.from(data);
  return Buffer.from(await data.arrayBuffer());
}

// ──────────────────────────────────────────────────────────────────────────
// upload_file: single-part
// ──────────────────────────────────────────────────────────────────────────

describe("upload_file (single-part)", () => {
  it("does one create + one send and roundtrips the file_upload_id", async () => {
    const payload = Buffer.from("hello world");

    notionStub.fileUploads.create.mockResolvedValue({
      id: "fu-single",
      status: "pending",
    });
    notionStub.fileUploads.send.mockResolvedValue({
      id: "fu-single",
      status: "uploaded",
      filename: "hi.txt",
      content_type: "text/plain",
      content_length: payload.length,
    });

    const res = await dispatch("upload_file", {
      mode: "single",
      filename: "hi.txt",
      content_type: "text/plain",
      source: { type: "base64", data: payload.toString("base64") },
    });

    expect(res).toMatchObject({
      ok: true,
      data: { file_upload_id: "fu-single", status: "uploaded" },
    });

    expect(notionStub.fileUploads.create).toHaveBeenCalledTimes(1);
    expect(notionStub.fileUploads.create).toHaveBeenCalledWith({
      mode: "single_part",
      filename: "hi.txt",
      content_type: "text/plain",
    });

    expect(notionStub.fileUploads.send).toHaveBeenCalledTimes(1);
    const args = sendArgs(0);
    expect(args.file_upload_id).toBe("fu-single");
    expect(args.part_number).toBeUndefined();

    expect((await sendBytes(0)).equals(payload)).toBe(true);
    // Notion rejects send() when the Blob's MIME doesn't match the
    // content_type declared at create(); the Blob must echo content_type.
    const sentBlob = args.file.data;
    if (typeof sentBlob === "string" || !(sentBlob instanceof Blob)) {
      throw new Error("Expected file.data to be a Blob");
    }
    expect(sentBlob.type).toBe("text/plain");
    expect(notionStub.fileUploads.complete).not.toHaveBeenCalled();
  });

  it("infers content_type from the filename extension when caller omits it (Notion rejects octet-stream)", async () => {
    notionStub.fileUploads.create.mockResolvedValue({
      id: "fu-inferred",
      status: "pending",
    });
    notionStub.fileUploads.send.mockResolvedValue({
      id: "fu-inferred",
      status: "uploaded",
    });

    await dispatch("upload_file", {
      mode: "single",
      filename: "anything.txt",
      source: { type: "base64", data: Buffer.from("x").toString("base64") },
    });

    expect(notionStub.fileUploads.create).toHaveBeenCalledWith({
      mode: "single_part",
      filename: "anything.txt",
      content_type: "text/plain",
    });
    const blob = sendArgs(0).file.data;
    if (typeof blob === "string" || !(blob instanceof Blob)) {
      throw new Error("Expected file.data to be a Blob");
    }
    expect(blob.type).toBe("text/plain");
  });

  it("returns validation_error envelope when content_type is omitted and the extension isn't on the allowlist", async () => {
    const res = await dispatch("upload_file", {
      mode: "single",
      filename: "weird.xyz",
      source: { type: "base64", data: Buffer.from("x").toString("base64") },
    });
    assertErr(res);
    expect(res.error.code).toBe("validation_error");
    expect(res.error.message).toContain("weird.xyz");
    expect(res.error.fix).toContain("content_type");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
    expect(notionStub.fileUploads.send).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// upload_file: multi-part
// ──────────────────────────────────────────────────────────────────────────

describe("upload_file (multi-part)", () => {
  it("splits a 12MB payload into 3 parts and calls complete once", async () => {
    const totalBytes = 12 * MB;
    // Sequential byte pattern lets us verify each part is the right slice.
    const payload = Buffer.alloc(totalBytes);
    for (let i = 0; i < totalBytes; i++) payload[i] = i & 0xff;

    notionStub.fileUploads.create.mockResolvedValue({
      id: "fu-multi",
      status: "pending",
    });
    notionStub.fileUploads.send.mockResolvedValue({
      id: "fu-multi",
      status: "pending",
    });
    notionStub.fileUploads.complete.mockResolvedValue({
      id: "fu-multi",
      status: "uploaded",
      filename: "big.pdf",
      content_length: totalBytes,
    });

    const res = await dispatch("upload_file", {
      mode: "multi",
      filename: "big.pdf",
      content_type: "application/pdf",
      source: { type: "base64", data: payload.toString("base64") },
    });

    expect(res).toMatchObject({
      ok: true,
      data: { file_upload_id: "fu-multi", status: "uploaded" },
    });

    expect(notionStub.fileUploads.create).toHaveBeenCalledWith({
      mode: "multi_part",
      filename: "big.pdf",
      content_type: "application/pdf",
      number_of_parts: 3,
    });

    expect(notionStub.fileUploads.send).toHaveBeenCalledTimes(3);
    const expectedSizes = [MAX_PART_BYTES, MAX_PART_BYTES, totalBytes - 2 * MAX_PART_BYTES];
    for (let i = 0; i < 3; i++) {
      const args = sendArgs(i);
      expect(args.part_number).toBe(String(i + 1));
      const chunk = await sendBytes(i);
      expect(chunk.length).toBe(expectedSizes[i]);
      const expected = payload.subarray(
        i * MAX_PART_BYTES,
        i * MAX_PART_BYTES + expectedSizes[i]
      );
      expect(chunk.equals(expected)).toBe(true);
    }

    expect(notionStub.fileUploads.complete).toHaveBeenCalledTimes(1);
    expect(notionStub.fileUploads.complete).toHaveBeenCalledWith({
      file_upload_id: "fu-multi",
    });
  });

  it("surfaces the failed part number and skips complete when a send rejects mid-upload", async () => {
    const totalBytes = 12 * MB;
    const payload = Buffer.alloc(totalBytes);

    notionStub.fileUploads.create.mockResolvedValue({
      id: "fu-broken",
      status: "pending",
    });
    notionStub.fileUploads.send
      .mockResolvedValueOnce({ id: "fu-broken", status: "pending" })
      .mockRejectedValueOnce(new Error("network blew up"));

    const res = await dispatch("upload_file", {
      mode: "multi",
      filename: "big.pdf",
      source: { type: "base64", data: payload.toString("base64") },
    });

    expect((res as { ok: boolean }).ok).toBe(false);
    const err = (res as { error: { message: string } }).error;
    // Must identify which part failed AND the upload id so the caller can triage.
    expect(err.message).toContain("part 2/3");
    expect(err.message).toContain("fu-broken");
    expect(err.message).toContain("network blew up");
    expect(notionStub.fileUploads.send).toHaveBeenCalledTimes(2);
    expect(notionStub.fileUploads.complete).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// upload_file: URL source
// ──────────────────────────────────────────────────────────────────────────

describe("upload_file (URL source)", () => {
  it("fetches the URL and forwards the exact bytes to fileUploads.send", async () => {
    const remoteBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x42, 0x00, 0x99]);
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        remoteBytes.buffer.slice(
          remoteBytes.byteOffset,
          remoteBytes.byteOffset + remoteBytes.byteLength
        ),
    });
    vi.stubGlobal("fetch", fetchStub);

    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-url" });
    notionStub.fileUploads.send.mockResolvedValue({
      id: "fu-url",
      status: "uploaded",
    });

    try {
      const res = await dispatch("upload_file", {
        mode: "single",
        filename: "blob.pdf",
        source: { type: "url", url: "https://example.com/blob.pdf" },
      });

      expect(res).toMatchObject({ ok: true });
      expect(fetchStub).toHaveBeenCalledWith("https://example.com/blob.pdf");
      expect((await sendBytes(0)).equals(remoteBytes)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// upload_file: validation error path
// ──────────────────────────────────────────────────────────────────────────

describe("upload_file (validation)", () => {
  it("rejects payload with neither data nor url, returns validation_error with example, makes no SDK calls", async () => {
    const res = await dispatch("upload_file", {
      mode: "single",
      filename: "missing.bin",
      source: {},
    });

    assertErr(res);
    expect(res.error.code).toBe("validation_error");
    expect(res.error).toMatchObject({
      code: "validation_error",
      example: {
        filename: expect.any(String),
        source: expect.any(Object),
      },
    });

    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
    expect(notionStub.fileUploads.send).not.toHaveBeenCalled();
    expect(notionStub.fileUploads.complete).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// list_file_uploads / get_file_upload
// ──────────────────────────────────────────────────────────────────────────

describe("list_file_uploads", () => {
  it("returns slim entries with file_upload_id + status", async () => {
    notionStub.fileUploads.list.mockResolvedValue({
      object: "list",
      results: [
        { id: "fu-a", status: "uploaded", filename: "a.txt" },
        { id: "fu-b", status: "pending" },
      ],
      has_more: false,
      next_cursor: null,
    });

    const res = await dispatch("list_file_uploads", { status: "uploaded" });

    assertOk(res);
    expect(notionStub.fileUploads.list).toHaveBeenCalledWith({
      status: "uploaded",
    });
    expect(res.data).toMatchObject({
      results: [
        { file_upload_id: "fu-a", status: "uploaded", filename: "a.txt" },
        { file_upload_id: "fu-b", status: "pending" },
      ],
      has_more: false,
      next_cursor: null,
    });
  });
});

describe("get_file_upload", () => {
  it("retrieves a single upload by ID and slims the response", async () => {
    notionStub.fileUploads.retrieve.mockResolvedValue({
      id: "fu-x",
      status: "uploaded",
      filename: "doc.pdf",
      content_type: "application/pdf",
      content_length: 1234,
    });

    const res = await dispatch("get_file_upload", { file_upload_id: "fu-x" });

    expect(notionStub.fileUploads.retrieve).toHaveBeenCalledWith({
      file_upload_id: "fu-x",
    });
    expect(res).toMatchObject({
      ok: true,
      data: {
        file_upload_id: "fu-x",
        status: "uploaded",
        filename: "doc.pdf",
        content_type: "application/pdf",
        content_length: 1234,
      },
    });
  });
});
