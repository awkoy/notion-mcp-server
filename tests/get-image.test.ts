import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { Readable } from "node:stream";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { OperationError, OperationResult } from "../src/operations/types.js";
import { blockFileRef, propertyFileRef } from "../src/utils/file-ref.js";

const notionStub = {
  blocks: { retrieve: vi.fn() },
  pages: { retrieve: vi.fn() },
};

// Only getClient is replaced: proxyAwareFetch stays real, so these tests cover
// the proxy-agent wiring, and node-fetch underneath it is the stub.
vi.mock("../src/services/notion.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/notion.js")>()),
  getClient: async () => notionStub,
}));

// vi.mock is hoisted above the imports, so the stub it hands out must be too.
const { fetchStub } = vi.hoisted(() => ({ fetchStub: vi.fn() }));
vi.mock("node-fetch", () => ({ default: fetchStub }));

import { initOperations } from "../src/operations/index.js";
import { dispatch } from "../src/dispatch/index.js";

const MB = 1024 * 1024;
const BLOCK = "3ab5030f-c6e5-8182-a41b-e48b46176e7b";
const PAGE = "3ab5030f-c6e5-8109-b32f-dbd2c4093059";
const SIGNED =
  "https://prod-files-secure.s3.us-west-2.amazonaws.com/a/b/dot.png?X-Amz-Signature=deadbeef";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type ImageContent = { type: "image"; data: string; mimeType: string };
type ImageData = { _mcp_content: ImageContent[] };

function imageBlock(image: Record<string, unknown>) {
  return { object: "block", id: BLOCK, type: "image", has_children: false, image };
}

// A node-fetch style Response whose body is a real Node Readable, so the
// handler's chunked read and destroy paths run for real. `pulls` counts chunks
// the handler asked for (highWaterMark 0 stops the stream pre-fetching one on
// its own); `cancelled` flips when the handler destroys the body before it
// has ended — a stream that was read to the end is not "cancelled".
function fakeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Uint8Array[];
}) {
  const chunks = opts.chunks ?? [PNG];
  const status = opts.status ?? 200;
  const probe = { pulls: 0, cancelled: false };
  let i = 0;
  const body = new Readable({
    highWaterMark: 0,
    read() {
      if (i >= chunks.length) {
        this.push(null);
        return;
      }
      probe.pulls += 1;
      this.push(Buffer.from(chunks[i++]));
    },
    destroy(error, callback) {
      if (!this.readableEnded) probe.cancelled = true;
      callback(error);
    },
  });
  const res = {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Forbidden",
    headers: new Headers(opts.headers ?? { "content-type": "image/png" }),
    body,
  };
  return { res, probe };
}

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;
type ProxyVar = (typeof PROXY_VARS)[number];

// Run fn with the proxy variables set to exactly `vars` (every other one
// unset, whatever the developer's shell has), and put the environment back
// afterwards whether or not fn threw.
async function withProxyEnv(
  vars: Partial<Record<ProxyVar, string>>,
  fn: () => Promise<void>
): Promise<void> {
  const saved = new Map(PROXY_VARS.map((k) => [k, process.env[k]] as const));
  const apply = (k: ProxyVar, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  try {
    for (const k of PROXY_VARS) apply(k, vars[k]);
    await fn();
  } finally {
    for (const k of PROXY_VARS) apply(k, saved.get(k));
  }
}

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  notionStub.blocks.retrieve.mockReset();
  notionStub.pages.retrieve.mockReset();
  fetchStub.mockReset();
});

async function getImage(ref: string) {
  return (await dispatch("get_image", { ref })) as OperationResult<ImageData>;
}

function errorOf(result: OperationResult<unknown>): OperationError {
  expect(result.ok).toBe(false);
  return (result as { ok: false; error: OperationError }).error;
}

describe("get_image", () => {
  it("fetches exactly the signed URL Notion returned and hands back the bytes with the response's mime type", async () => {
    notionStub.blocks.retrieve.mockResolvedValue(
      imageBlock({ type: "file", file: { url: SIGNED } })
    );
    const { res } = fakeResponse({ headers: { "content-type": "image/jpeg" } });
    fetchStub.mockResolvedValue(res);

    const result = await getImage(blockFileRef(BLOCK));

    expect(notionStub.blocks.retrieve).toHaveBeenCalledWith({ block_id: BLOCK });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(String(fetchStub.mock.calls[0][0])).toBe(SIGNED);
    expect(result.ok).toBe(true);
    const [content] = (result as { ok: true; data: ImageData }).data._mcp_content;
    expect(content).toEqual({
      type: "image",
      mimeType: "image/jpeg",
      data: PNG.toString("base64"),
    });
  });

  it("takes a bare block id as shorthand for a block ref", async () => {
    notionStub.blocks.retrieve.mockResolvedValue(
      imageBlock({ type: "file", file: { url: SIGNED } })
    );
    fetchStub.mockResolvedValue(fakeResponse({}).res);

    const result = await getImage(BLOCK);

    expect(notionStub.blocks.retrieve).toHaveBeenCalledWith({ block_id: BLOCK });
    expect(result.ok).toBe(true);
  });

  it.each([
    "https://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5:8080/admin",
    "file:///etc/passwd",
    "ftp://example.com/x",
  ])("refuses the URL %s without touching Notion or the network", async (url) => {
    const error = errorOf(await getImage(url));

    expect(error.code).toBe("validation_error");
    expect(error.message).toMatch(/does not fetch URLs/);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(notionStub.blocks.retrieve).not.toHaveBeenCalled();
    expect(notionStub.pages.retrieve).not.toHaveBeenCalled();
  });

  it("refuses to fetch an external URL, even one that came back from Notion", async () => {
    notionStub.blocks.retrieve.mockResolvedValue(
      imageBlock({ type: "external", external: { url: "http://10.0.0.5/secret.png" } })
    );

    const error = errorOf(await getImage(blockFileRef(BLOCK)));

    expect(error.code).toBe("external_file");
    expect(error.fix).toContain("http://10.0.0.5/secret.png");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses a non-https URL from Notion instead of fetching it", async () => {
    notionStub.blocks.retrieve.mockResolvedValue(
      imageBlock({ type: "file", file: { url: "http://prod-files-secure.s3.amazonaws.com/x.png" } })
    );

    const error = errorOf(await getImage(blockFileRef(BLOCK)));

    expect(error.code).toBe("unexpected_url");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses a non-image content-type rather than relabelling it image/png", async () => {
    notionStub.blocks.retrieve.mockResolvedValue(
      imageBlock({ type: "file", file: { url: SIGNED } })
    );
    const { res, probe } = fakeResponse({
      headers: { "content-type": "text/html; charset=utf-8" },
      chunks: [Buffer.from("<html>expired</html>")],
    });
    fetchStub.mockResolvedValue(res);

    const result = await getImage(blockFileRef(BLOCK));

    const error = errorOf(result);
    expect(error.code).toBe("not_an_image");
    expect(error.message).toContain("text/html");
    expect(probe.pulls).toBe(0);
    expect(probe.cancelled).toBe(true);
  });

  it("refuses a missing content-type", async () => {
    notionStub.blocks.retrieve.mockResolvedValue(
      imageBlock({ type: "file", file: { url: SIGNED } })
    );
    fetchStub.mockResolvedValue(fakeResponse({ headers: {} }).res);

    expect(errorOf(await getImage(blockFileRef(BLOCK))).code).toBe("not_an_image");
  });

  it("refuses on content-length before reading a byte of the body", async () => {
    notionStub.blocks.retrieve.mockResolvedValue(
      imageBlock({ type: "file", file: { url: SIGNED } })
    );
    const { res, probe } = fakeResponse({
      headers: { "content-type": "image/png", "content-length": String(6 * MB) },
    });
    fetchStub.mockResolvedValue(res);

    const error = errorOf(await getImage(blockFileRef(BLOCK)));

    expect(error.code).toBe("too_large");
    expect(error.message).toContain(String(6 * MB));
    expect(probe.pulls).toBe(0);
    expect(probe.cancelled).toBe(true);
  });

  it("stops reading a body with no content-length once it passes the cap", async () => {
    notionStub.blocks.retrieve.mockResolvedValue(
      imageBlock({ type: "file", file: { url: SIGNED } })
    );
    const meg = new Uint8Array(MB);
    const { res, probe } = fakeResponse({
      headers: { "content-type": "image/png" },
      chunks: Array.from({ length: 12 }, () => meg),
    });
    fetchStub.mockResolvedValue(res);

    const error = errorOf(await getImage(blockFileRef(BLOCK)));

    expect(error.code).toBe("too_large");
    // The sixth megabyte tips it over the 5 MB cap; nothing after it is read.
    expect(probe.pulls).toBe(6);
    expect(probe.cancelled).toBe(true);
  });

  it("accepts a body that arrives in chunks and stays under the cap", async () => {
    notionStub.blocks.retrieve.mockResolvedValue(
      imageBlock({ type: "file", file: { url: SIGNED } })
    );
    const { res, probe } = fakeResponse({
      headers: { "content-type": "image/png" },
      chunks: [PNG.subarray(0, 3), PNG.subarray(3)],
    });
    fetchStub.mockResolvedValue(res);

    const result = await getImage(blockFileRef(BLOCK));

    expect(result.ok).toBe(true);
    const [content] = (result as { ok: true; data: ImageData }).data._mcp_content;
    expect(Buffer.from(content.data, "base64")).toEqual(PNG);
    expect(probe.pulls).toBe(2);
    expect(probe.cancelled).toBe(false);
  });

  it("reports an expired signed URL as fetch_failed", async () => {
    notionStub.blocks.retrieve.mockResolvedValue(
      imageBlock({ type: "file", file: { url: SIGNED } })
    );
    const { res, probe } = fakeResponse({
      status: 403,
      headers: { "content-type": "application/xml" },
    });
    fetchStub.mockResolvedValue(res);

    const error = errorOf(await getImage(blockFileRef(BLOCK)));

    expect(error.code).toBe("fetch_failed");
    expect(error.message).toContain("403");
    expect(probe.cancelled).toBe(true);
  });

  it("reports a block with no file as not_found", async () => {
    notionStub.blocks.retrieve.mockResolvedValue({
      object: "block",
      id: BLOCK,
      type: "paragraph",
      paragraph: { rich_text: [] },
    });

    expect(errorOf(await getImage(BLOCK)).code).toBe("not_found");
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("get_image behind a proxy", () => {
  it("hands node-fetch an agent for the proxy in HTTPS_PROXY", async () => {
    await withProxyEnv({ HTTPS_PROXY: "http://proxy.local:3128" }, async () => {
      notionStub.blocks.retrieve.mockResolvedValue(
        imageBlock({ type: "file", file: { url: SIGNED } })
      );
      fetchStub.mockResolvedValue(fakeResponse({}).res);

      const result = await getImage(blockFileRef(BLOCK));

      expect(result.ok).toBe(true);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(String(fetchStub.mock.calls[0][0])).toBe(SIGNED);
      const init = fetchStub.mock.calls[0][1] as { agent?: HttpsProxyAgent<string> };
      expect(init.agent).toBeInstanceOf(HttpsProxyAgent);
      expect(init.agent?.proxy.href).toBe("http://proxy.local:3128/");
    });
  });

  it("reuses one agent per proxy URL across calls", async () => {
    await withProxyEnv({ https_proxy: "http://proxy.local:3128" }, async () => {
      notionStub.blocks.retrieve.mockResolvedValue(
        imageBlock({ type: "file", file: { url: SIGNED } })
      );
      fetchStub.mockResolvedValue(fakeResponse({}).res);
      await getImage(blockFileRef(BLOCK));
      fetchStub.mockResolvedValue(fakeResponse({}).res);
      await getImage(blockFileRef(BLOCK));

      const [first, second] = fetchStub.mock.calls.map(
        (call) => (call[1] as { agent?: unknown }).agent
      );
      expect(first).toBeInstanceOf(HttpsProxyAgent);
      expect(second).toBe(first);
    });
  });

  it("passes no agent when no proxy variable is set", async () => {
    await withProxyEnv({}, async () => {
      notionStub.blocks.retrieve.mockResolvedValue(
        imageBlock({ type: "file", file: { url: SIGNED } })
      );
      fetchStub.mockResolvedValue(fakeResponse({}).res);

      const result = await getImage(blockFileRef(BLOCK));

      expect(result.ok).toBe(true);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      const init = fetchStub.mock.calls[0][1] as { agent?: unknown } | undefined;
      expect(init?.agent).toBeUndefined();
    });
  });
});

describe("get_file_url", () => {
  it("resolves a property ref through pages.retrieve and returns the fresh URL", async () => {
    notionStub.pages.retrieve.mockResolvedValue({
      object: "page",
      id: PAGE,
      properties: {
        "Cover Shot": {
          type: "files",
          files: [
            { name: "old.png", type: "external", external: { url: "https://example.com/old.png" } },
            { name: "dot.png", type: "file", file: { url: SIGNED } },
          ],
        },
      },
    });
    const ref = propertyFileRef(PAGE, "Cover Shot", 1);

    const result = await dispatch("get_file_url", { ref });

    expect(notionStub.pages.retrieve).toHaveBeenCalledWith({ page_id: PAGE });
    expect(result).toEqual({ ok: true, data: { ref, url: SIGNED } });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("passes an external URL through as text", async () => {
    notionStub.pages.retrieve.mockResolvedValue({
      object: "page",
      id: PAGE,
      properties: {
        Asset: {
          type: "files",
          files: [{ name: "a", type: "external", external: { url: "https://example.com/a.png" } }],
        },
      },
    });

    const result = await dispatch("get_file_url", { ref: propertyFileRef(PAGE, "Asset", 0) });

    expect(result).toMatchObject({ ok: true, data: { url: "https://example.com/a.png" } });
  });

  it("reports a missing index as not_found", async () => {
    notionStub.pages.retrieve.mockResolvedValue({
      object: "page",
      id: PAGE,
      properties: { Asset: { type: "files", files: [] } },
    });

    const error = errorOf(
      (await dispatch("get_file_url", {
        ref: propertyFileRef(PAGE, "Asset", 3),
      })) as OperationResult<unknown>
    );

    expect(error.code).toBe("not_found");
    expect(error.message).toContain("Asset[3]");
  });

  it("rejects anything that is not a ref without calling Notion", async () => {
    const error = errorOf(
      (await dispatch("get_file_url", { ref: SIGNED })) as OperationResult<unknown>
    );

    expect(error.code).toBe("validation_error");
    expect(notionStub.blocks.retrieve).not.toHaveBeenCalled();
    expect(notionStub.pages.retrieve).not.toHaveBeenCalled();
  });
});
