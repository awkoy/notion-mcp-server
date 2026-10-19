import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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
  blocks: {
    children: {
      append: vi.fn<(args: any) => Promise<{ results: { id: string }[] }>>(),
    },
  },
};

// Only getClient is replaced: proxyAwareFetch stays real (it is what the URL
// source goes through) and node-fetch underneath it is the stub.
vi.mock("../src/services/notion.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/notion.js")>()),
  getClient: async () => notionStub,
}));

// vi.mock is hoisted above the imports, so the stub it hands out must be too.
const { fetchStub } = vi.hoisted(() => ({ fetchStub: vi.fn() }));
vi.mock("node-fetch", () => ({ default: fetchStub }));

// The url source resolves the host before it fetches, to refuse private
// addresses. Every name resolves to a public address unless a test says not.
const PUBLIC_IP = "93.184.215.14";
const { lookupStub } = vi.hoisted(() => ({
  lookupStub: vi.fn<(host: string, options: { all: true }) => Promise<LookupAddress[]>>(),
}));
vi.mock("node:dns/promises", () => ({ lookup: lookupStub, default: { lookup: lookupStub } }));

// The path source's open goes through the real fs, with a hook that lets a
// test swap the file between the policy check and the open.
const { fsHooks } = vi.hoisted(() => ({
  fsHooks: { beforeOpen: undefined as ((path: string) => void) | undefined },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      fsHooks.beforeOpen?.(String(args[0]));
      return actual.open(...args);
    },
  };
});

import { initOperations } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";
import { setActiveTransport } from "../src/config/http.js";

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  for (const fn of Object.values(notionStub.fileUploads)) fn.mockReset();
  notionStub.blocks.children.append.mockReset();
  fetchStub.mockReset();
  lookupStub.mockReset();
  lookupStub.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
});

// What node-fetch resolves to: headers, and the body as a Node Readable.
function fakeResponse({
  status = 200,
  headers = {},
  body = [],
}: {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer[] | Readable;
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: http.STATUS_CODES[status] ?? "",
    headers: new Headers(headers),
    body: body instanceof Readable ? body : Readable.from(body),
  };
}

function redirectTo(location: string, status = 302) {
  return fakeResponse({ status, headers: { location } });
}

// A fetch that never answers on its own, only rejects when its signal aborts.
function hangUntilAborted(_url: string, init: { signal: AbortSignal }) {
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
}

// Set env vars for one test; afterEach puts the old values back.
const savedEnv = new Map<string, string | undefined>();
function setEnv(vars: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(vars)) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  setActiveTransport("stdio");
  fsHooks.beforeOpen = undefined;
});

const NO_PROXY_ENV = {
  HTTPS_PROXY: undefined,
  https_proxy: undefined,
  HTTP_PROXY: undefined,
  http_proxy: undefined,
};

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

  it("infers content_type from the filename extension when caller omits it", async () => {
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

  it.each([
    ["notes.md", "text/markdown"],
    ["deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["doc.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["page.html", "text/html"],
    ["page.htm", "text/html"],
    ["plan.dwg", "image/vnd.dwg"],
    ["plan.dxf", "image/vnd.dxf"],
    ["part.step", "model/step"],
    ["part.stp", "model/step"],
    ["part.stl", "model/stl"],
    ["mesh.obj", "model/obj"],
    ["scene.glb", "model/gltf-binary"],
    ["scene.gltf", "model/gltf+json"],
    ["PART.STL", "model/stl"],
  ])("infers content_type for %s", async (filename, expectedType) => {
    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-infer" });
    notionStub.fileUploads.send.mockResolvedValue({
      id: "fu-infer",
      status: "uploaded",
    });

    await dispatch("upload_file", {
      filename,
      source: { type: "base64", data: Buffer.from("x").toString("base64") },
    });

    expect(notionStub.fileUploads.create).toHaveBeenCalledWith({
      mode: "single_part",
      filename,
      content_type: expectedType,
    });
  });

  // Since 2026-09-22 Notion reads application/octet-stream as "unspecified"
  // and resolves the type from the extension, so an extension the server
  // does not map is Notion's call, not a refusal here.
  it("sends an extension the server does not map as application/octet-stream", async () => {
    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-octet" });
    notionStub.fileUploads.send.mockResolvedValue({ id: "fu-octet", status: "uploaded" });

    const res = await dispatch("upload_file", {
      mode: "single",
      filename: "weird.xyz",
      source: { type: "base64", data: Buffer.from("x").toString("base64") },
    });

    assertOk(res);
    expect(notionStub.fileUploads.create).toHaveBeenCalledWith({
      mode: "single_part",
      filename: "weird.xyz",
      content_type: "application/octet-stream",
    });
    const blob = sendArgs(0).file.data;
    if (typeof blob === "string" || !(blob instanceof Blob)) {
      throw new Error("Expected file.data to be a Blob");
    }
    expect(blob.type).toBe("application/octet-stream");
  });

  it.each(["README", "trailing."])(
    "refuses %s, a filename with no extension, when content_type is omitted",
    async (filename) => {
      const res = await dispatch("upload_file", {
        filename,
        source: { type: "base64", data: Buffer.from("x").toString("base64") },
      });
      assertErr(res);
      expect(res.error.code).toBe("validation_error");
      expect(res.error.message).toContain(filename);
      expect(res.error.fix).toContain("content_type");
      expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
    }
  );

  it("takes a filename with no extension when content_type is given", async () => {
    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-noext" });
    notionStub.fileUploads.send.mockResolvedValue({ id: "fu-noext", status: "uploaded" });
    const res = await dispatch("upload_file", {
      filename: "README",
      content_type: "text/plain",
      source: { type: "base64", data: Buffer.from("x").toString("base64") },
    });
    assertOk(res);
    expect(notionStub.fileUploads.create).toHaveBeenCalledWith({
      mode: "single_part",
      filename: "README",
      content_type: "text/plain",
    });
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
// upload_file: size limits
// ──────────────────────────────────────────────────────────────────────────

describe("upload_file (size limits)", () => {
  beforeEach(() => {
    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-size", status: "pending" });
    notionStub.fileUploads.send.mockResolvedValue({ id: "fu-size", status: "uploaded" });
    notionStub.fileUploads.complete.mockResolvedValue({ id: "fu-size", status: "uploaded" });
  });

  const base64Of = (bytes: number) => Buffer.alloc(bytes).toString("base64");

  it("refuses base64 over NOTION_UPLOAD_MAX_BYTES and makes no SDK calls", async () => {
    setEnv({ NOTION_UPLOAD_MAX_BYTES: "10" });
    const res = await dispatch("upload_file", {
      filename: "big.pdf",
      source: { type: "base64", data: base64Of(11) },
    });
    assertErr(res);
    expect(res.error.code).toBe("too_large");
    expect(res.error.message).toContain("11 bytes");
    expect(res.error.fix).toContain("NOTION_UPLOAD_MAX_BYTES");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  it("takes a file exactly at NOTION_UPLOAD_MAX_BYTES", async () => {
    setEnv({ NOTION_UPLOAD_MAX_BYTES: "10" });
    const res = await dispatch("upload_file", {
      filename: "ten.pdf",
      source: { type: "base64", data: base64Of(10) },
    });
    assertOk(res);
  });

  it('holds an explicit mode: "single" to Notion\'s 20 MiB single-part limit', async () => {
    const res = await dispatch("upload_file", {
      mode: "single",
      filename: "big.pdf",
      source: { type: "base64", data: base64Of(20 * MB + 1) },
    });
    assertErr(res);
    expect(res.error.code).toBe("too_large");
    expect(res.error.message).toContain("single-part");
    expect(res.error.fix).toContain('mode: "multi"');
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  it("stays single-part up to 20 MiB when mode is omitted", async () => {
    await dispatch("upload_file", {
      filename: "edge.pdf",
      source: { type: "base64", data: base64Of(20 * MB) },
    });
    expect(notionStub.fileUploads.create).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "single_part" })
    );
  });

  it("switches to multi-part above 20 MiB when mode is omitted", async () => {
    const res = await dispatch("upload_file", {
      filename: "big.pdf",
      source: { type: "base64", data: base64Of(21 * MB) },
    });
    assertOk(res);
    expect(notionStub.fileUploads.create).toHaveBeenCalledWith({
      mode: "multi_part",
      filename: "big.pdf",
      content_type: "application/pdf",
      number_of_parts: 5,
    });
    expect(notionStub.fileUploads.send).toHaveBeenCalledTimes(5);
    expect(notionStub.fileUploads.complete).toHaveBeenCalledTimes(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// upload_file: URL source
// ──────────────────────────────────────────────────────────────────────────

describe("upload_file (URL source)", () => {
  beforeEach(() => {
    setEnv(NO_PROXY_ENV);
    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-url" });
    notionStub.fileUploads.send.mockResolvedValue({ id: "fu-url", status: "uploaded" });
  });

  const upload = (url: string) =>
    dispatch("upload_file", { filename: "blob.pdf", source: { type: "url", url } });

  it("fetches the URL and forwards the exact bytes to fileUploads.send", async () => {
    const remoteBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x42, 0x00, 0x99]);
    fetchStub.mockResolvedValue(
      fakeResponse({ body: [remoteBytes.subarray(0, 3), remoteBytes.subarray(3)] })
    );

    const res = await dispatch("upload_file", {
      mode: "single",
      filename: "blob.pdf",
      source: { type: "url", url: "https://example.com/blob.pdf" },
    });

    expect(res).toMatchObject({ ok: true });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][0]).toBe("https://example.com/blob.pdf");
    // Redirects are followed by hand, so each Location gets the same check.
    expect(fetchStub.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
    expect(lookupStub).toHaveBeenCalledWith("example.com", { all: true });
    expect((await sendBytes(0)).equals(remoteBytes)).toBe(true);
  });

  it("goes through the proxy in HTTPS_PROXY, like every Notion API call", async () => {
    setEnv({ HTTPS_PROXY: "http://proxy.local:3128" });
    fetchStub.mockResolvedValue(fakeResponse({ body: [Buffer.alloc(4)] }));

    const res = await upload("https://example.com/blob.pdf");

    expect(res).toMatchObject({ ok: true });
    const init = fetchStub.mock.calls[0][1] as { agent?: HttpsProxyAgent<string> };
    expect(init.agent).toBeInstanceOf(HttpsProxyAgent);
    expect(init.agent?.proxy.href).toBe("http://proxy.local:3128/");
  });

  // Behind a proxy the proxy connects, so the check runs on the local DNS
  // answer; a host that resolves to a private address is still refused.
  it("still refuses a private host behind a proxy", async () => {
    setEnv({ HTTPS_PROXY: "http://proxy.local:3128" });
    lookupStub.mockResolvedValue([{ address: "10.0.0.7", family: 4 }]);
    const res = await upload("https://intranet.example/blob.pdf");
    assertErr(res);
    expect(res.error.code).toBe("url_refused");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  // Resolving again at connect time would let a DNS server that answers
  // differently the second time (rebinding) send the request to 127.0.0.1.
  it("pins the connection to the address it checked", async () => {
    lookupStub.mockResolvedValue([
      { address: PUBLIC_IP, family: 4 },
      { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
    ]);
    fetchStub.mockResolvedValue(fakeResponse({ body: [Buffer.from("x")] }));
    await upload("https://example.com/blob.pdf");

    const agent = (fetchStub.mock.calls[0][1] as { agent?: http.Agent }).agent;
    expect(agent).toBeInstanceOf(https.Agent);
    const { lookup } = (agent as unknown as { options: { lookup: LookupFunction } }).options;
    const ask = (options: { family?: number; all?: boolean }) =>
      new Promise<unknown[]>((resolve, reject) =>
        lookup("example.com", options, (err, address, family) =>
          err ? reject(err) : resolve([address, family])
        )
      );
    expect(await ask({ family: 4 })).toEqual([PUBLIC_IP, 4]);
    expect(await ask({ family: 6 })).toEqual(["2606:2800:21f:cb07:6820:80da:af6b:8b2c", 6]);
    // Node's happy-eyeballs connect asks for every address at once.
    expect(await ask({ all: true })).toEqual([
      [
        { address: PUBLIC_IP, family: 4 },
        { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
      ],
      undefined,
    ]);
    expect(lookupStub).toHaveBeenCalledTimes(1);
  });

  it("pins an http URL through an http agent", async () => {
    fetchStub.mockResolvedValue(fakeResponse({ body: [Buffer.from("x")] }));
    await upload("http://example.com/blob.pdf");
    const agent = (fetchStub.mock.calls[0][1] as { agent?: http.Agent }).agent;
    expect(agent).toBeInstanceOf(http.Agent);
    expect(agent).not.toBeInstanceOf(https.Agent);
  });

  it.each([
    "http://127.0.0.1/blob.pdf",
    "http://127.1.2.3:8080/blob.pdf",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/blob.pdf",
    "http://172.16.5.5/blob.pdf",
    "http://192.168.1.10/blob.pdf",
    "http://100.64.0.1/blob.pdf",
    "http://0.0.0.0/blob.pdf",
    // Other spellings of 127.0.0.1 that the URL parser turns into it.
    "http://2130706433/blob.pdf",
    "http://0x7f.1/blob.pdf",
    "http://[::1]/blob.pdf",
    "http://[::]/blob.pdf",
    "http://[fc00::1]/blob.pdf",
    "http://[fe80::1]/blob.pdf",
    "http://[fd00:ec2::254]/blob.pdf",
    "http://[::ffff:127.0.0.1]/blob.pdf",
    "http://[::ffff:169.254.169.254]/blob.pdf",
    "http://[64:ff9b::a00:1]/blob.pdf",
  ])("refuses %s without fetching it", async (url) => {
    const res = await upload(url);
    assertErr(res);
    expect(res.error.code).toBe("url_refused");
    expect(res.error.fix).toContain("base64 or path");
    expect(lookupStub).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  it.each<[string, LookupAddress[]]>([
    ["10.0.0.1", [{ address: "10.0.0.1", family: 4 }]],
    ["127.0.0.1", [{ address: "127.0.0.1", family: 4 }]],
    ["::1", [{ address: "::1", family: 6 }]],
    // One private address among public ones is enough: the connection may use any.
    [
      "public and 169.254.169.254",
      [
        { address: PUBLIC_IP, family: 4 },
        { address: "169.254.169.254", family: 4 },
      ],
    ],
    ["no address", []],
  ])("refuses a host that resolves to %s", async (_label, addresses) => {
    lookupStub.mockResolvedValue(addresses);
    const res = await upload("https://files.example/blob.pdf");
    assertErr(res);
    expect(res.error.code).toBe("url_refused");
    expect(res.error.message).toContain("files.example");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("reports a host that does not resolve as fetch_failed", async () => {
    lookupStub.mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND nope.example"), { code: "ENOTFOUND" })
    );
    const res = await upload("https://nope.example/blob.pdf");
    assertErr(res);
    expect(res.error.code).toBe("fetch_failed");
    expect(res.error.message).toContain("ENOTFOUND");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each(["ftp://example.com/blob.pdf", "file:///etc/passwd", "gopher://example.com/blob.pdf"])(
    "rejects %s at the schema",
    async (url) => {
      const res = await upload(url);
      assertErr(res);
      expect(res.error.code).toBe("validation_error");
      expect(lookupStub).not.toHaveBeenCalled();
      expect(fetchStub).not.toHaveBeenCalled();
    }
  );

  it("fetches a private host when NOTION_UPLOAD_ALLOW_PRIVATE_URLS is on", async () => {
    setEnv({ NOTION_UPLOAD_ALLOW_PRIVATE_URLS: "true" });
    fetchStub.mockResolvedValue(fakeResponse({ body: [Buffer.from("intranet")] }));
    const res = await upload("http://10.0.0.1/blob.pdf");
    assertOk(res);
    expect(lookupStub).not.toHaveBeenCalled();
    expect((await sendBytes(0)).toString()).toBe("intranet");
  });

  it("reports a non-2xx answer as fetch_failed", async () => {
    const notFound = fakeResponse({ status: 404, body: [Buffer.from("nope")] });
    fetchStub.mockResolvedValue(notFound);
    const res = await upload("https://example.com/blob.pdf");
    assertErr(res);
    expect(res.error.code).toBe("fetch_failed");
    expect(res.error.message).toContain("404 Not Found");
    expect(notFound.body.destroyed).toBe(true);
  });
});

describe("upload_file (URL source redirects)", () => {
  beforeEach(() => {
    setEnv(NO_PROXY_ENV);
    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-redirect" });
    notionStub.fileUploads.send.mockResolvedValue({ id: "fu-redirect", status: "uploaded" });
  });

  const upload = () =>
    dispatch("upload_file", {
      filename: "blob.pdf",
      source: { type: "url", url: "https://example.com/blob.pdf" },
    });

  it("follows a redirect to a public URL, a relative Location included", async () => {
    fetchStub
      .mockResolvedValueOnce(redirectTo("/files/real.pdf", 301))
      .mockResolvedValueOnce(fakeResponse({ body: [Buffer.from("moved")] }));
    const res = await upload();
    assertOk(res);
    expect(fetchStub.mock.calls.map((c) => c[0])).toEqual([
      "https://example.com/blob.pdf",
      "https://example.com/files/real.pdf",
    ]);
    // One deadline for the whole fetch: every hop gets the same signal.
    expect(fetchStub.mock.calls[1][1].signal).toBe(fetchStub.mock.calls[0][1].signal);
    expect((await sendBytes(0)).toString()).toBe("moved");
  });

  it("refuses a redirect to the metadata address after one fetch", async () => {
    const first = redirectTo("http://169.254.169.254/latest/meta-data/iam/");
    fetchStub.mockResolvedValueOnce(first);
    const res = await upload();
    assertErr(res);
    expect(res.error.code).toBe("url_refused");
    expect(res.error.message).toContain("169.254.169.254");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(first.body.destroyed).toBe(true);
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  it("refuses a redirect to a host that resolves to a private address", async () => {
    lookupStub
      .mockResolvedValueOnce([{ address: PUBLIC_IP, family: 4 }])
      .mockResolvedValueOnce([{ address: "192.168.0.10", family: 4 }]);
    fetchStub.mockResolvedValueOnce(redirectTo("https://router.example/admin"));
    const res = await upload();
    assertErr(res);
    expect(res.error.code).toBe("url_refused");
    expect(res.error.message).toContain("router.example");
    expect(lookupStub).toHaveBeenLastCalledWith("router.example", { all: true });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    fetchStub.mockResolvedValueOnce(redirectTo("file:///etc/passwd"));
    const res = await upload();
    assertErr(res);
    expect(res.error.code).toBe("url_refused");
    expect(res.error.message).toContain("file:///etc/passwd");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("gives up after five redirects", async () => {
    fetchStub.mockImplementation(async () => redirectTo("https://example.com/again"));
    const res = await upload();
    assertErr(res);
    expect(res.error.code).toBe("fetch_failed");
    expect(res.error.message).toContain("more than 5");
    expect(fetchStub).toHaveBeenCalledTimes(6);
  });

  it("reports a redirect with no Location", async () => {
    fetchStub.mockResolvedValueOnce(fakeResponse({ status: 302 }));
    const res = await upload();
    assertErr(res);
    expect(res.error.code).toBe("fetch_failed");
    expect(res.error.message).toContain("no Location");
  });
});

describe("upload_file (URL source limits)", () => {
  beforeEach(() => {
    setEnv(NO_PROXY_ENV);
    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-limit" });
    notionStub.fileUploads.send.mockResolvedValue({ id: "fu-limit", status: "uploaded" });
  });

  const upload = () =>
    dispatch("upload_file", {
      filename: "blob.pdf",
      source: { type: "url", url: "https://example.com/blob.pdf" },
    });

  it("refuses a Content-Length over NOTION_UPLOAD_MAX_BYTES before reading the body", async () => {
    setEnv({ NOTION_UPLOAD_MAX_BYTES: "10" });
    const big = fakeResponse({ headers: { "content-length": "11" }, body: [Buffer.alloc(11)] });
    fetchStub.mockResolvedValueOnce(big);
    const res = await upload();
    assertErr(res);
    expect(res.error.code).toBe("too_large");
    expect(res.error.message).toContain("11 bytes");
    expect(res.error.fix).toContain("NOTION_UPLOAD_MAX_BYTES");
    expect(big.body.destroyed).toBe(true);
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  // A chunked response carries no Content-Length, and a server can lie in it.
  it("stops reading a body the moment it passes the limit", async () => {
    setEnv({ NOTION_UPLOAD_MAX_BYTES: "4096" });
    let produced = 0;
    const endless = new Readable({
      highWaterMark: 1024,
      read() {
        produced += 1024;
        this.push(Buffer.alloc(1024));
      },
    });
    fetchStub.mockResolvedValueOnce(fakeResponse({ body: endless }));
    const res = await upload();
    assertErr(res);
    expect(res.error.code).toBe("too_large");
    expect(res.error.message).toContain("over 4096 bytes");
    expect(endless.destroyed).toBe(true);
    expect(produced).toBeLessThan(64 * 1024);
  });

  describe("timeout", () => {
    beforeEach(() => {
      setEnv({ NOTION_UPLOAD_URL_TIMEOUT_MS: "50" });
    });

    it("gives up on a server that never answers", async () => {
      fetchStub.mockImplementation(hangUntilAborted);
      const res = await upload();
      assertErr(res);
      expect(res.error.code).toBe("timeout");
      expect(res.error.message).toContain("50 ms");
      expect(res.error.fix).toContain("NOTION_UPLOAD_URL_TIMEOUT_MS");
      expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
    });

    it("gives up on a body that stalls halfway", async () => {
      const stalled = new Readable({ read() {} });
      stalled.push(Buffer.from("partial"));
      fetchStub.mockResolvedValueOnce(fakeResponse({ body: stalled }));
      const res = await upload();
      assertErr(res);
      expect(res.error.code).toBe("timeout");
      expect(stalled.destroyed).toBe(true);
    });

    it("gives up on a DNS lookup that never answers", async () => {
      lookupStub.mockReturnValue(new Promise(() => {}));
      const res = await upload();
      assertErr(res);
      expect(res.error.code).toBe("timeout");
      expect(fetchStub).not.toHaveBeenCalled();
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// upload_file: local path source
// ──────────────────────────────────────────────────────────────────────────

describe("upload_file (path source)", () => {
  it("reads the file from disk and derives filename from the path basename", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "notion-upload-"));
    const filePath = join(dir, "report.txt");
    const payload = Buffer.from("local bytes on disk");
    await writeFile(filePath, payload);

    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-path" });
    notionStub.fileUploads.send.mockResolvedValue({
      id: "fu-path",
      status: "uploaded",
    });

    try {
      const res = await dispatch("upload_file", {
        source: { type: "path", path: filePath },
      });

      expect(res).toMatchObject({ ok: true });
      // filename derived from basename, content_type inferred from .txt
      expect(notionStub.fileUploads.create).toHaveBeenCalledWith({
        mode: "single_part",
        filename: "report.txt",
        content_type: "text/plain",
      });
      expect((await sendBytes(0)).equals(payload)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honors an explicit filename over the path basename", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "notion-upload-"));
    const filePath = join(dir, "tmpname.bin");
    await writeFile(filePath, Buffer.from("x"));

    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-path2" });
    notionStub.fileUploads.send.mockResolvedValue({
      id: "fu-path2",
      status: "uploaded",
    });

    try {
      await dispatch("upload_file", {
        filename: "real.txt",
        source: { type: "path", path: filePath },
      });
      expect(notionStub.fileUploads.create).toHaveBeenCalledWith({
        mode: "single_part",
        filename: "real.txt",
        content_type: "text/plain",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing path as a validation_error and makes no SDK calls", async () => {
    const res = await dispatch("upload_file", {
      source: { type: "path", path: "/no/such/file-xyz.txt" },
    });
    assertErr(res);
    expect(res.error.code).toBe("validation_error");
    expect(res.error.message).toBe("/no/such/file-xyz.txt does not exist (ENOENT).");
    expect(res.error.fix).toContain("Check the path");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
    expect(notionStub.fileUploads.send).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// upload_file: which paths may be read
// ──────────────────────────────────────────────────────────────────────────

describe("upload_file (path policy)", () => {
  const dir = mkdtempSync(join(tmpdir(), "notion-policy-"));
  writeFileSync(join(dir, "plain.txt"), "plain");
  writeFileSync(join(dir, ".hidden.txt"), "hidden");
  mkdirSync(join(dir, ".secret"));
  writeFileSync(join(dir, ".secret", "key.txt"), "secret");
  symlinkSync(join(dir, ".secret", "key.txt"), join(dir, "innocent.txt"));

  beforeEach(() => {
    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-policy", status: "pending" });
    notionStub.fileUploads.send.mockResolvedValue({ id: "fu-policy", status: "uploaded" });
  });

  const uploadPath = (path: string, filename?: string) =>
    dispatch("upload_file", { ...(filename ? { filename } : {}), source: { type: "path", path } });

  it("over HTTP, refuses a path source when NOTION_UPLOAD_ROOT is unset", async () => {
    setActiveTransport("http");
    const res = await uploadPath(join(dir, "plain.txt"));
    assertErr(res);
    expect(res.error.code).toBe("path_not_allowed");
    expect(res.error.message).toContain("HTTP transport");
    expect(res.error.fix).toContain("base64");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  it("over HTTP, reads a path inside NOTION_UPLOAD_ROOT", async () => {
    setActiveTransport("http");
    setEnv({ NOTION_UPLOAD_ROOT: dir });
    const res = await uploadPath("plain.txt");
    assertOk(res);
    expect((await sendBytes(0)).toString()).toBe("plain");
  });

  it("over HTTP, still takes a base64 source with no root", async () => {
    setActiveTransport("http");
    const res = await dispatch("upload_file", {
      filename: "a.txt",
      source: { type: "base64", data: Buffer.from("x").toString("base64") },
    });
    assertOk(res);
  });

  it("over stdio with no root, reads an ordinary path", async () => {
    const res = await uploadPath(join(dir, "plain.txt"));
    assertOk(res);
  });

  it.each([
    [".secret/key.txt", ".secret"],
    [".hidden.txt", ".hidden.txt"],
  ])("over stdio with no root, refuses %s, a dot-named path", async (rel, segment) => {
    const res = await uploadPath(join(dir, rel));
    assertErr(res);
    expect(res.error.code).toBe("path_not_allowed");
    expect(res.error.message).toContain(`"${segment}"`);
    expect(res.error.fix).toContain("NOTION_UPLOAD_ROOT");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  it("over stdio, checks the real path, so a symlink cannot hide a dot directory", async () => {
    const res = await uploadPath(join(dir, "innocent.txt"));
    assertErr(res);
    expect(res.error.code).toBe("path_not_allowed");
    expect(res.error.message).toContain('".secret"');
  });

  it("over stdio, refuses ~/.ssh whether or not the file exists", async () => {
    const res = await uploadPath("~/.ssh/id_ed25519");
    assertErr(res);
    expect(res.error.code).toBe("path_not_allowed");
    expect(res.error.message).toContain('".ssh"');
  });

  it("inside NOTION_UPLOAD_ROOT, dot names are allowed", async () => {
    setEnv({ NOTION_UPLOAD_ROOT: dir });
    const res = await uploadPath(".secret/key.txt");
    assertOk(res);
    expect((await sendBytes(0)).toString()).toBe("secret");
  });

  it("NOTION_UPLOAD_ROOT=/ lifts the restriction", async () => {
    setEnv({ NOTION_UPLOAD_ROOT: "/" });
    const res = await uploadPath(join(dir, ".secret", "key.txt"));
    assertOk(res);
  });

  it("refuses a file over NOTION_UPLOAD_MAX_BYTES before reading it", async () => {
    setEnv({ NOTION_UPLOAD_MAX_BYTES: "4" });
    const res = await uploadPath(join(dir, "plain.txt"));
    assertErr(res);
    expect(res.error.code).toBe("too_large");
    expect(res.error.message).toContain("5 bytes");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  it("refuses a directory", async () => {
    const res = await uploadPath(dir, "dir.txt");
    assertErr(res);
    expect(res.error.code).toBe("validation_error");
    expect(res.error.message).toContain("not a regular file");
  });

  // /dev/zero passes any size check (its size is 0) and never ends.
  it.skipIf(process.platform === "win32")("over stdio with no root, refuses /dev/zero", async () => {
    const res = await uploadPath("/dev/zero", "zero.bin");
    assertErr(res);
    expect(res.error.code).toBe("path_not_allowed");
    expect(res.error.message).toContain("under /dev");
  });

  it.skipIf(process.platform === "win32")(
    "with the policy off, still refuses /dev/zero as not a regular file",
    async () => {
      setEnv({ NOTION_UPLOAD_ROOT: "/" });
      const res = await uploadPath("/dev/zero", "zero.bin");
      assertErr(res);
      expect(res.error.code).toBe("validation_error");
      expect(res.error.message).toContain("not a regular file");
    }
  );

  // A regular file of size 0 that holds the server's environment, NOTION_TOKEN
  // included: it passes the regular-file and size checks.
  it.skipIf(process.platform !== "linux")(
    "over stdio with no root, refuses /proc/self/environ",
    async () => {
      const res = await uploadPath("/proc/self/environ", "environ.txt");
      assertErr(res);
      expect(res.error.code).toBe("path_not_allowed");
      expect(res.error.message).toContain("under /proc");
      expect(res.error.fix).toContain("NOTION_UPLOAD_ROOT");
      expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
    }
  );

  describe("app-data folders, with a stand-in home directory", () => {
    const home = mkdtempSync(join(tmpdir(), "notion-home-"));
    const write = (rel: string, body: string) => {
      const full = join(home, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body);
      return full;
    };

    // Where the README tells Claude Desktop users to put NOTION_TOKEN.
    it.skipIf(process.platform !== "darwin")(
      "on macOS, refuses ~/Library/Application Support/Claude/claude_desktop_config.json",
      async () => {
        write("Library/Application Support/Claude/claude_desktop_config.json", "{}");
        setEnv({ HOME: home });
        const res = await uploadPath("~/Library/Application Support/Claude/claude_desktop_config.json");
        assertErr(res);
        expect(res.error.code).toBe("path_not_allowed");
        expect(res.error.message).toContain("Library");
        expect(res.error.message).toContain("NOTION_TOKEN");
        expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
      }
    );

    it.skipIf(process.platform !== "darwin")(
      "on macOS, refuses the Cursor, Windsurf and VS Code user folders",
      async () => {
        setEnv({ HOME: home });
        for (const app of ["Cursor", "Windsurf", "Code"]) {
          write(`Library/Application Support/${app}/User/settings.json`, "{}");
          const res = await uploadPath(`~/Library/Application Support/${app}/User/settings.json`);
          assertErr(res);
          expect(res.error.code).toBe("path_not_allowed");
        }
      }
    );

    it.skipIf(process.platform !== "darwin")("on macOS, still reads iCloud Drive", async () => {
      write("Library/Mobile Documents/com~apple~CloudDocs/report.txt", "icloud");
      setEnv({ HOME: home });
      const res = await uploadPath("~/Library/Mobile Documents/com~apple~CloudDocs/report.txt");
      assertOk(res);
      expect((await sendBytes(0)).toString()).toBe("icloud");
    });

    it.skipIf(process.platform !== "win32")(
      "on Windows, refuses %APPDATA%\\Claude\\claude_desktop_config.json",
      async () => {
        const config = write("AppData/Roaming/Claude/claude_desktop_config.json", "{}");
        setEnv({ APPDATA: join(home, "AppData", "Roaming") });
        const res = await uploadPath(config);
        assertErr(res);
        expect(res.error.code).toBe("path_not_allowed");
      }
    );

    it.skipIf(process.platform === "win32")(
      "refuses XDG_CONFIG_HOME when it points outside dot-names, through a symlink too",
      async () => {
        const config = write("config/Claude/claude_desktop_config.json", "{}");
        symlinkSync(join(home, "config"), join(home, "innocent-dir"));
        setEnv({ XDG_CONFIG_HOME: join(home, "config") });
        for (const path of [config, join(home, "innocent-dir/Claude/claude_desktop_config.json")]) {
          const res = await uploadPath(path);
          assertErr(res);
          expect(res.error.code).toBe("path_not_allowed");
        }
        expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
      }
    );
  });

  describe("file-system errors", () => {
    it.skipIf(process.platform === "win32")("reports a symlink loop as a validation_error", async () => {
      symlinkSync(join(dir, "loop-b"), join(dir, "loop-a"));
      symlinkSync(join(dir, "loop-a"), join(dir, "loop-b"));
      const res = await uploadPath(join(dir, "loop-a"), "loop.txt");
      assertErr(res);
      expect(res.error.code).toBe("validation_error");
      expect(res.error.message).toContain("symlink loop (ELOOP)");
      expect(res.error.fix).toBeTruthy();
    });

    it("reports a file used as a directory as a validation_error", async () => {
      const res = await uploadPath(join(dir, "plain.txt", "child.txt"));
      assertErr(res);
      expect(res.error.code).toBe("validation_error");
      expect(res.error.message).toContain("(ENOTDIR)");
      expect(res.error.fix).toBeTruthy();
    });

    // root reads everything, so the permission bits do not stop it.
    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "reports an unreadable directory as a validation_error",
      async () => {
        const locked = join(dir, "locked");
        mkdirSync(locked);
        writeFileSync(join(locked, "a.txt"), "a");
        chmodSync(locked, 0o000);
        try {
          const res = await uploadPath(join(locked, "a.txt"));
          assertErr(res);
          expect(res.error.code).toBe("validation_error");
          expect(res.error.message).toContain("(EACCES)");
          expect(res.error.fix).toContain("readable");
        } finally {
          chmodSync(locked, 0o755);
        }
      }
    );
  });

  // The policy approves a real path; the read then opens it by name. A file
  // swapped in between must not be read.
  describe("a file swapped after the check", () => {
    it("refuses a different file moved over the path", async () => {
      const target = join(dir, "swap-target.txt");
      writeFileSync(target, "approved");
      writeFileSync(join(dir, "swap-other.txt"), "swapped");
      fsHooks.beforeOpen = (path) => {
        if (path.endsWith("swap-target.txt")) renameSync(join(dir, "swap-other.txt"), path);
      };
      const res = await uploadPath(target);
      assertErr(res);
      expect(res.error.code).toBe("validation_error");
      expect(res.error.message).toContain("changed while it was being opened");
      expect(notionStub.fileUploads.send).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform === "win32")("refuses a symlink put in its place", async () => {
      const target = join(dir, "swap-link.txt");
      writeFileSync(target, "approved");
      fsHooks.beforeOpen = (path) => {
        if (!path.endsWith("swap-link.txt")) return;
        unlinkSync(path);
        symlinkSync(join(dir, ".secret", "key.txt"), path);
      };
      const res = await uploadPath(target);
      assertErr(res);
      expect(res.error.code).toBe("validation_error");
      expect(res.error.message).toContain("changed while it was being opened");
      expect(notionStub.fileUploads.send).not.toHaveBeenCalled();
    });

    it("reads the file when nothing changed", async () => {
      let opened = 0;
      fsHooks.beforeOpen = () => {
        opened++;
      };
      const res = await uploadPath(join(dir, "plain.txt"));
      assertOk(res);
      expect(opened).toBe(1);
    });
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

  it("rejects a base64 source with no filename (nothing to derive) and makes no SDK calls", async () => {
    const res = await dispatch("upload_file", {
      source: { type: "base64", data: Buffer.from("x").toString("base64") },
    });
    assertErr(res);
    expect(res.error.code).toBe("validation_error");
    expect(res.error.message).toContain("filename is required");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
    expect(notionStub.fileUploads.send).not.toHaveBeenCalled();
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

// ──────────────────────────────────────────────────────────────────────────
// upload_file: NOTION_UPLOAD_ROOT
// ──────────────────────────────────────────────────────────────────────────

describe("upload_file (upload root)", () => {
  const root = mkdtempSync(join(tmpdir(), "notion-root-"));
  writeFileSync(join(root, "inside.txt"), "in");
  const outside = mkdtempSync(join(tmpdir(), "notion-out-"));
  writeFileSync(join(outside, "outside.txt"), "out");

  beforeEach(() => {
    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-root", status: "pending" });
    notionStub.fileUploads.send.mockResolvedValue({
      id: "fu-root",
      status: "uploaded",
      filename: "inside.txt",
    });
  });

  afterEach(() => {
    delete process.env.NOTION_UPLOAD_ROOT;
  });

  it("takes a relative path inside the root", async () => {
    process.env.NOTION_UPLOAD_ROOT = root;
    const res = await dispatch("upload_file", { source: { type: "path", path: "inside.txt" } });
    assertOk(res);
  });

  it("refuses a path outside the root", async () => {
    process.env.NOTION_UPLOAD_ROOT = root;
    const res = await dispatch("upload_file", {
      source: { type: "path", path: join(outside, "outside.txt") },
    });
    assertErr(res);
    expect(res.error.code).toBe("path_not_allowed");
    expect(res.error.message).toContain("outside NOTION_UPLOAD_ROOT");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  it("refuses a traversal out of the root", async () => {
    process.env.NOTION_UPLOAD_ROOT = root;
    const res = await dispatch("upload_file", {
      source: { type: "path", path: "../../etc/passwd" },
    });
    assertErr(res);
    expect(res.error.message).toContain("outside NOTION_UPLOAD_ROOT");
  });

  it("leaves absolute paths alone when no root is set", async () => {
    const res = await dispatch("upload_file", {
      source: { type: "path", path: join(outside, "outside.txt") },
    });
    assertOk(res);
  });

  // A prefix check on the lexical path is not confinement: resolve() never
  // touches the filesystem, so a symlink sitting inside the root passes the
  // check and then open() follows it straight out of the root.
  it("refuses a symlink inside the root that points outside it", async () => {
    process.env.NOTION_UPLOAD_ROOT = root;
    symlinkSync(join(outside, "outside.txt"), join(root, "escape.txt"));
    const res = await dispatch("upload_file", {
      source: { type: "path", path: "escape.txt" },
    });
    assertErr(res);
    expect(res.error.message).toContain("outside NOTION_UPLOAD_ROOT");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  it("refuses a symlinked directory inside the root that points outside it", async () => {
    process.env.NOTION_UPLOAD_ROOT = root;
    symlinkSync(outside, join(root, "escape-dir"));
    const res = await dispatch("upload_file", {
      source: { type: "path", path: "escape-dir/outside.txt" },
    });
    assertErr(res);
    expect(res.error.message).toContain("outside NOTION_UPLOAD_ROOT");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  it("still follows a symlink that stays inside the root", async () => {
    process.env.NOTION_UPLOAD_ROOT = root;
    symlinkSync(join(root, "inside.txt"), join(root, "link-inside.txt"));
    const res = await dispatch("upload_file", {
      source: { type: "path", path: "link-inside.txt" },
    });
    assertOk(res);
  });

  // A path that does not exist cannot be a symlink, so the confinement check
  // must fall through to a plain ENOENT rather than a resolution error.
  it("reports a missing in-root file as a normal fs error", async () => {
    process.env.NOTION_UPLOAD_ROOT = root;
    const res = await dispatch("upload_file", {
      source: { type: "path", path: "nope.txt" },
    });
    assertErr(res);
    expect(res.error.code).toBe("validation_error");
    expect(res.error.message).toContain("does not exist (ENOENT)");
    expect(res.error.message).not.toContain("outside NOTION_UPLOAD_ROOT");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  // A dangling symlink does exist. Kept as a lexical tail it would pass the
  // check, and a target created outside the root later would then be read.
  it("stops at a dangling symlinked directory instead of treating it as missing", async () => {
    process.env.NOTION_UPLOAD_ROOT = root;
    symlinkSync(join(outside, "not-yet"), join(root, "later"));
    const res = await dispatch("upload_file", {
      source: { type: "path", path: "later/file.txt" },
    });
    assertErr(res);
    expect(res.error.code).toBe("validation_error");
    expect(res.error.message).toBe(`${join(realpathSync(root), "later")} does not exist (ENOENT).`);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// upload_file: attach_to
// ──────────────────────────────────────────────────────────────────────────

describe("upload_file (attach_to)", () => {
  const PAGE_BARE = "3ab5030fc6e5801eb170cd93167dd607";
  const PAGE = "3ab5030f-c6e5-801e-b170-cd93167dd607";
  const BLOCK_BARE = "1f2e3d4c5b6a79880011223344556677";
  const BLOCK = "1f2e3d4c-5b6a-7988-0011-223344556677";
  const source = { type: "base64", data: Buffer.from("x").toString("base64") };

  beforeEach(() => {
    notionStub.fileUploads.create.mockResolvedValue({ id: "fu-att", status: "pending" });
    notionStub.fileUploads.send.mockResolvedValue({
      id: "fu-att",
      status: "uploaded",
      filename: "a.png",
      content_type: "image/png",
    });
    notionStub.fileUploads.complete.mockResolvedValue({ id: "fu-att", status: "uploaded" });
    notionStub.blocks.children.append.mockResolvedValue({ results: [{ id: "blk-1" }] });
  });

  it("appends nothing when attach_to is absent", async () => {
    const res = await dispatch("upload_file", { filename: "a.png", source });
    assertOk(res);
    expect(res.data).toMatchObject({ file_upload_id: "fu-att" });
    expect(res.data).not.toHaveProperty("block_id");
    expect(notionStub.blocks.children.append).not.toHaveBeenCalled();
  });

  it("appends an image block with a caption and returns both ids", async () => {
    const res = await dispatch("upload_file", {
      filename: "a.png",
      source,
      attach_to: { block_id: PAGE_BARE, caption: "from disk" },
    });
    assertOk(res);
    expect(res.data).toMatchObject({
      file_upload_id: "fu-att",
      block_id: "blk-1",
      block_type: "image",
    });

    expect(notionStub.blocks.children.append).toHaveBeenCalledTimes(1);
    const body = notionStub.blocks.children.append.mock.calls[0][0];
    expect(body.block_id).toBe(PAGE);
    expect(body.position).toBeUndefined();
    expect(body.children).toEqual([
      {
        object: "block",
        type: "image",
        image: {
          type: "file_upload",
          file_upload: { id: "fu-att" },
          caption: [{ type: "text", text: { content: "from disk" } }],
        },
      },
    ]);
  });

  it("omits the caption when none is given", async () => {
    await dispatch("upload_file", { filename: "a.png", source, attach_to: { block_id: PAGE } });
    const block = notionStub.blocks.children.append.mock.calls[0][0].children[0];
    expect(block.image).not.toHaveProperty("caption");
  });

  it.each([
    ["chart.svg", "image/svg+xml", "image"],
    ["photo.webp", "image/webp", "image"],
    ["icon.ico", "image/vnd.microsoft.icon", "image"],
    ["clip.mp4", "video/mp4", "video"],
    ["clip.mov", "video/quicktime", "video"],
    ["clip.webm", "video/webm", "video"],
    ["song.mp3", "audio/mpeg", "audio"],
    ["song.m4a", "audio/mp4", "audio"],
    ["report.pdf", "application/pdf", "pdf"],
    ["notes.txt", "text/plain", "file"],
    ["data.csv", "text/csv", "file"],
    [
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "file",
    ],
  ])("%s (%s) becomes a %s block", async (filename, content_type, kind) => {
    const res = await dispatch("upload_file", {
      filename,
      content_type,
      source,
      attach_to: { block_id: PAGE },
    });
    assertOk(res);
    expect(res.data).toMatchObject({ block_type: kind });
    const block = notionStub.blocks.children.append.mock.calls[0][0].children[0];
    expect(block.type).toBe(kind);
    expect(block[kind]).toMatchObject({ type: "file_upload", file_upload: { id: "fu-att" } });
  });

  it("infers the block type from the filename when content_type is omitted", async () => {
    await dispatch("upload_file", { filename: "clip.mp4", source, attach_to: { block_id: PAGE } });
    expect(notionStub.blocks.children.append.mock.calls[0][0].children[0].type).toBe("video");
  });

  // dwg and dxf are registered under image/, but Notion takes CAD and 3D
  // files as file blocks.
  it.each(["plan.dwg", "plan.dxf", "part.step", "part.stl", "mesh.obj", "scene.glb", "page.html"])(
    "attaches %s as a file block",
    async (filename) => {
      const res = await dispatch("upload_file", { filename, source, attach_to: { block_id: PAGE } });
      assertOk(res);
      expect(res.data).toMatchObject({ block_type: "file" });
      expect(notionStub.blocks.children.append.mock.calls[0][0].children[0].type).toBe("file");
    }
  );

  it("for an extension the server does not map, picks the block from the type Notion resolved", async () => {
    notionStub.fileUploads.send.mockResolvedValue({
      id: "fu-att",
      status: "uploaded",
      content_type: "audio/ogg",
    });
    const res = await dispatch("upload_file", {
      filename: "track.xyz",
      source,
      attach_to: { block_id: PAGE },
    });
    assertOk(res);
    expect(res.data).toMatchObject({ block_type: "audio" });
  });

  it("falls back to a file block when Notion does not say what it resolved", async () => {
    notionStub.fileUploads.send.mockResolvedValue({ id: "fu-att", status: "uploaded" });
    const res = await dispatch("upload_file", {
      filename: "track.xyz",
      source,
      attach_to: { block_id: PAGE },
    });
    assertOk(res);
    expect(res.data).toMatchObject({ block_type: "file" });
  });

  it("takes a Notion link for block_id and a block link for after", async () => {
    const res = await dispatch("upload_file", {
      filename: "a.png",
      source,
      attach_to: {
        block_id: `https://www.notion.so/Page-${PAGE_BARE}?pvs=4`,
        after: `https://www.notion.so/Page-${PAGE_BARE}#${BLOCK_BARE}`,
      },
    });
    assertOk(res);
    const body = notionStub.blocks.children.append.mock.calls[0][0];
    expect(body.block_id).toBe(PAGE);
    expect(body.position).toEqual({ type: "after_block", after_block: { id: BLOCK } });
  });

  it("passes position through like append_blocks", async () => {
    await dispatch("upload_file", {
      filename: "a.png",
      source,
      attach_to: { block_id: PAGE, position: "start" },
    });
    expect(notionStub.blocks.children.append.mock.calls[0][0].position).toEqual({ type: "start" });
  });

  it("rejects after together with position before uploading anything", async () => {
    const res = await dispatch("upload_file", {
      filename: "a.png",
      source,
      attach_to: { block_id: PAGE, position: "end", after: BLOCK },
    });
    assertErr(res);
    expect(res.error.code).toBe("validation_error");
    expect(JSON.stringify(res.error)).toContain("at most one of `after` or `position`");
    expect(notionStub.fileUploads.create).not.toHaveBeenCalled();
  });

  it("attaches after a multi-part upload too", async () => {
    const res = await dispatch("upload_file", {
      mode: "multi",
      filename: "a.png",
      source,
      attach_to: { block_id: PAGE },
    });
    assertOk(res);
    expect(notionStub.fileUploads.complete).toHaveBeenCalledTimes(1);
    expect(res.data).toMatchObject({ file_upload_id: "fu-att", block_id: "blk-1" });
    const block = notionStub.blocks.children.append.mock.calls[0][0].children[0];
    expect(block.image.file_upload).toEqual({ id: "fu-att" });
  });

  it("keeps the file_upload_id in the error when the append fails", async () => {
    notionStub.blocks.children.append.mockRejectedValue(new Error("Could not find block"));
    const res = await dispatch("upload_file", {
      filename: "a.png",
      source,
      attach_to: { block_id: PAGE },
    });
    assertErr(res);
    expect(res.error.code).toBe("attach_failed");
    expect(res.error.message).toContain("fu-att");
    expect(res.error.message).toContain("Could not find block");
    expect(res.error.fix).toContain("append_blocks");
    expect(res.error.fix).toContain("fu-att");
    expect(res.error.fix).toContain('"image"');
  });
});
