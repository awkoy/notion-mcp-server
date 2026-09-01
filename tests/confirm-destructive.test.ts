import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";

// NOTION_CONFIRM_DESTRUCTIVE end to end: a destructive notion_write call
// must reach the client as an elicitation/create request, and only an
// explicit yes lets it dispatch. Same in-memory transport pair as
// tests/wrapper.test.ts, with the client side answering the prompt.

const notionStub = {
  pages: { retrieve: vi.fn(), update: vi.fn() },
  databases: { retrieve: vi.fn(), update: vi.fn() },
  dataSources: { retrieve: vi.fn(), update: vi.fn() },
  blocks: { retrieve: vi.fn(), delete: vi.fn(), children: { append: vi.fn() } },
  comments: { delete: vi.fn() },
  views: { delete: vi.fn() },
};

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => notionStub,
}));

// Imports must come after vi.mock() — these load operations that pull the
// stubbed `getClient`.
import { createServer } from "../src/server/index.js";
import { initOperations, getOperation } from "../src/operations/index.js";
import { configureOperationAccess } from "../src/operations/access.js";

const FLAG = "NOTION_CONFIRM_DESTRUCTIVE";

const PAGE = {
  object: "page",
  id: "p-1",
  url: "https://notion.so/p-1",
  in_trash: false,
  properties: {
    Name: {
      id: "title",
      type: "title",
      title: [{ type: "text", plain_text: "Roadmap", text: { content: "Roadmap", link: null } }],
    },
  },
  parent: { type: "page_id", page_id: "parent" },
  created_time: "t1",
  last_edited_time: "t2",
  icon: null,
};

const BLOCK = {
  object: "block",
  id: "b-2",
  type: "paragraph",
  has_children: false,
  in_trash: false,
  paragraph: { rich_text: [{ type: "text", plain_text: "Old text" }] },
};

/** The client that can be asked: declares elicitation and answers with `answer`. */
let client: Client;
/** A client that never declared the capability. */
let bareClient: Client;
let prompts: ElicitRequest["params"][] = [];
let answer: ElicitResult = { action: "accept", content: { confirm: true } };

async function connect(c: Client): Promise<Client> {
  const server = createServer();
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await c.connect(clientTransport);
  return c;
}

beforeAll(async () => {
  await initOperations();

  const asking = new Client(
    { name: "confirm-test", version: "0.0.0" },
    { capabilities: { elicitation: {} } }
  );
  asking.setRequestHandler("elicitation/create", async (request) => {
    prompts.push(request.params);
    return answer;
  });
  client = await connect(asking);

  bareClient = await connect(new Client({ name: "confirm-test-bare", version: "0.0.0" }));
});

beforeEach(() => {
  const reset = (obj: unknown): void => {
    if (typeof obj === "function" && "mockReset" in (obj as object)) {
      (obj as ReturnType<typeof vi.fn>).mockReset();
      return;
    }
    if (obj && typeof obj === "object") {
      for (const v of Object.values(obj as Record<string, unknown>)) reset(v);
    }
  };
  reset(notionStub);
  prompts = [];
  answer = { action: "accept", content: { confirm: true } };
  notionStub.pages.retrieve.mockResolvedValue(PAGE);
  notionStub.pages.update.mockResolvedValue({ ...PAGE, in_trash: true });
});

/** Run `fn` with the flag set to `value` (unset when undefined), restoring it after. */
async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

function readJson(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const block = result.content[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error(`Expected text content, got: ${JSON.stringify(result)}`);
  }
  return JSON.parse(block.text);
}

type Envelope = { ok: boolean; error?: { code: string; message: string; fix?: string } };

async function execute(c: Client, operation: string, payload: Record<string, unknown>) {
  const name = getOperation(operation)?.access === "read" ? "notion_read" : "notion_write";
  const result = await c.callTool({ name, arguments: { operation, payload } });
  return { result, body: readJson(result as Parameters<typeof readJson>[0]) as Envelope };
}

describe("confirm destructive: flag off", () => {
  it("dispatches archive_page without asking", async () => {
    await withFlag(undefined, async () => {
      const { result, body } = await execute(client, "archive_page", { page_id: "p-1" });
      expect(result.isError).toBeFalsy();
      expect(body.ok).toBe(true);
      expect(prompts).toHaveLength(0);
      expect(notionStub.pages.update).toHaveBeenCalledWith({ page_id: "p-1", in_trash: true });
    });
  });
});

describe("confirm destructive: the prompt", () => {
  it("accept with confirm:true dispatches, and the message names the operation and the page title", async () => {
    await withFlag("true", async () => {
      const { result, body } = await execute(client, "archive_page", { page_id: "p-1" });
      expect(result.isError).toBeFalsy();
      expect(body.ok).toBe(true);
      expect(prompts).toHaveLength(1);
      const prompt = prompts[0];
      expect(prompt.message).toContain("archive_page");
      expect(prompt.message).toContain('page "Roadmap" (p-1)');
      expect(prompt.mode ?? "form").toBe("form");
      if (!("requestedSchema" in prompt)) throw new Error("expected a form prompt");
      expect(prompt.requestedSchema.required).toEqual(["confirm"]);
      expect(prompt.requestedSchema.properties.confirm).toMatchObject({ type: "boolean" });
      expect(notionStub.pages.retrieve).toHaveBeenCalledTimes(1);
      expect(notionStub.pages.update).toHaveBeenCalledTimes(1);
    });
  });

  it("accepts '1' as on", async () => {
    await withFlag("1", async () => {
      await execute(client, "archive_page", { page_id: "p-1" });
      expect(prompts).toHaveLength(1);
    });
  });

  it("falls back to the id when the title lookup throws", async () => {
    notionStub.pages.retrieve.mockRejectedValue(new Error("object_not_found"));
    await withFlag("true", async () => {
      const { body } = await execute(client, "archive_page", { page_id: "p-1" });
      expect(body.ok).toBe(true);
      expect(prompts[0].message).toContain("page p-1");
      expect(prompts[0].message).not.toContain("Roadmap");
    });
  });

  it("normalizes a Notion URL before the lookup", async () => {
    await withFlag("true", async () => {
      await execute(client, "archive_page", {
        page_id: "https://www.notion.so/Roadmap-0123456789abcdef0123456789abcdef",
      });
      expect(notionStub.pages.retrieve).toHaveBeenCalledWith({
        page_id: "01234567-89ab-cdef-0123-456789abcdef",
      });
      expect(prompts[0].message).toContain("01234567-89ab-cdef-0123-456789abcdef");
    });
  });

  it("gives up on a slow lookup after 5 s and still asks", async () => {
    vi.useFakeTimers();
    notionStub.pages.retrieve.mockReturnValue(new Promise(() => {}));
    try {
      await withFlag("true", async () => {
        const pending = execute(client, "archive_page", { page_id: "p-1" });
        await vi.advanceTimersByTimeAsync(5_100);
        const { body } = await pending;
        expect(body.ok).toBe(true);
        expect(prompts).toHaveLength(1);
        expect(prompts[0].message).toContain("page p-1");
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("confirm destructive: refusals", () => {
  it("decline returns confirmation_declined and does not dispatch", async () => {
    answer = { action: "decline" };
    await withFlag("true", async () => {
      const { result, body } = await execute(client, "archive_page", { page_id: "p-1" });
      expect(result.isError).toBe(true);
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("confirmation_declined");
      expect(body.error?.message).toContain("archive_page");
      expect(body.error?.fix).toContain("Do not retry");
      expect(notionStub.pages.update).not.toHaveBeenCalled();
    });
  });

  it("cancel is a refusal too", async () => {
    answer = { action: "cancel" };
    await withFlag("true", async () => {
      const { body } = await execute(client, "archive_page", { page_id: "p-1" });
      expect(body.error?.code).toBe("confirmation_declined");
      expect(notionStub.pages.update).not.toHaveBeenCalled();
    });
  });

  it("accept with confirm:false is a refusal", async () => {
    answer = { action: "accept", content: { confirm: false } };
    await withFlag("true", async () => {
      const { result, body } = await execute(client, "archive_page", { page_id: "p-1" });
      expect(result.isError).toBe(true);
      expect(body.error?.code).toBe("confirmation_declined");
      expect(notionStub.pages.update).not.toHaveBeenCalled();
    });
  });

  it("a client without the elicitation capability gets confirmation_unavailable", async () => {
    await withFlag("true", async () => {
      const { result, body } = await execute(bareClient, "archive_page", { page_id: "p-1" });
      expect(result.isError).toBe(true);
      expect(body.error?.code).toBe("confirmation_unavailable");
      expect(body.error?.message).toContain("archive_page");
      expect(body.error?.fix).toContain("NOTION_BLOCKED_OPERATIONS=destructive");
      expect(prompts).toHaveLength(0);
      expect(notionStub.pages.update).not.toHaveBeenCalled();
    });
  });

  it("a blocked operation is rejected before anyone is asked", async () => {
    process.env.NOTION_BLOCKED_OPERATIONS = "archive_page";
    configureOperationAccess();
    try {
      await withFlag("true", async () => {
        const { body } = await execute(client, "archive_page", { page_id: "p-1" });
        expect(body.error?.code).toBe("operation_not_allowed");
        expect(prompts).toHaveLength(0);
        expect(notionStub.pages.update).not.toHaveBeenCalled();
      });
    } finally {
      delete process.env.NOTION_BLOCKED_OPERATIONS;
      configureOperationAccess();
    }
  });
});

describe("confirm destructive: what does not prompt", () => {
  it("a read operation", async () => {
    await withFlag("true", async () => {
      const { body } = await execute(client, "get_page", { page_id: "p-1" });
      expect(body.ok).toBe(true);
      expect(prompts).toHaveLength(0);
      expect(notionStub.pages.retrieve).toHaveBeenCalledTimes(1);
    });
  });

  it("a non-destructive write", async () => {
    await withFlag("true", async () => {
      const { body } = await execute(client, "set_page_title", { page_id: "p-1", title: "New" });
      expect(body.ok).toBe(true);
      expect(prompts).toHaveLength(0);
      expect(notionStub.pages.update).toHaveBeenCalledTimes(1);
    });
  });

  it("a restore: delete_database with in_trash:false", async () => {
    notionStub.databases.update.mockResolvedValue({ object: "database", id: "d-1" });
    await withFlag("true", async () => {
      const { body } = await execute(client, "delete_database", { database_id: "d-1", in_trash: false });
      expect(body.ok).toBe(true);
      expect(prompts).toHaveLength(0);
      expect(notionStub.databases.update).toHaveBeenCalledWith({ database_id: "d-1", in_trash: false });
    });
  });

  it("an invalid payload: validation fails without a prompt", async () => {
    await withFlag("true", async () => {
      const { body } = await execute(client, "archive_page", {});
      expect(body.error?.code).toBe("validation_error");
      expect(prompts).toHaveLength(0);
    });
  });
});

describe("confirm destructive: batches", () => {
  it("a batch of a destructive op asks once and says how many items", async () => {
    await withFlag("true", async () => {
      const { result } = await execute(client, "archive_page", {
        items: [{ page_id: "p-1" }, { page_id: "p-2" }],
      });
      expect(result.isError).toBeFalsy();
      expect(prompts).toHaveLength(1);
      expect(prompts[0].message).toContain("archive_page");
      expect(prompts[0].message).toContain("2 items");
      expect(prompts[0].message).toContain("p-1, p-2");
      // Several targets: no per-item title lookups.
      expect(notionStub.pages.retrieve).not.toHaveBeenCalled();
      expect(notionStub.pages.update).toHaveBeenCalledTimes(2);
    });
  });

  it("a declined batch runs nothing", async () => {
    answer = { action: "decline" };
    await withFlag("true", async () => {
      const { body } = await execute(client, "archive_page", {
        items: [{ page_id: "p-1" }, { page_id: "p-2" }],
      });
      expect(body.error?.code).toBe("confirmation_declined");
      expect(notionStub.pages.update).not.toHaveBeenCalled();
    });
  });

  it("delete_database batch: only the trash items count, restores do not", async () => {
    notionStub.databases.retrieve.mockResolvedValue({
      object: "database",
      id: "d-1",
      title: [{ type: "text", plain_text: "Tasks" }],
    });
    notionStub.databases.update.mockResolvedValue({ object: "database", id: "d-x" });
    await withFlag("true", async () => {
      const { body } = await execute(client, "delete_database", {
        items: [{ database_id: "d-1" }, { database_id: "d-2", in_trash: false }],
      });
      expect(body.ok).toBe(true);
      expect(prompts).toHaveLength(1);
      expect(prompts[0].message).toContain("1 of 2 items");
      expect(prompts[0].message).toContain('database "Tasks" (d-1)');
      expect(notionStub.databases.update).toHaveBeenCalledTimes(2);
    });
  });
});

describe("confirm destructive: batch_mixed_blocks", () => {
  beforeEach(() => {
    notionStub.blocks.children.append.mockResolvedValue({
      results: [{ object: "block", id: "nb-1", type: "paragraph", paragraph: { rich_text: [] } }],
    });
    notionStub.blocks.retrieve.mockResolvedValue(BLOCK);
    notionStub.blocks.delete.mockResolvedValue({ ...BLOCK, in_trash: true });
  });

  it("append only: no prompt", async () => {
    await withFlag("true", async () => {
      const { body } = await execute(client, "batch_mixed_blocks", {
        operations: [{ op: "append", block_id: "b-1", markdown: "Hello" }],
      });
      expect(body.ok).toBe(true);
      expect(prompts).toHaveLength(0);
      expect(notionStub.blocks.children.append).toHaveBeenCalledTimes(1);
    });
  });

  it("with a delete: one prompt naming the block", async () => {
    await withFlag("true", async () => {
      const { body } = await execute(client, "batch_mixed_blocks", {
        operations: [
          { op: "append", block_id: "b-1", markdown: "Hello" },
          { op: "delete", block_id: "b-2" },
        ],
      });
      expect(body.ok).toBe(true);
      expect(prompts).toHaveLength(1);
      expect(prompts[0].message).toContain("batch_mixed_blocks");
      expect(prompts[0].message).toContain("1 of its 2 operations");
      expect(prompts[0].message).toContain('block "paragraph: Old text" (b-2)');
      expect(notionStub.blocks.delete).toHaveBeenCalledWith({ block_id: "b-2" });
    });
  });

  it("with a delete, declined: nothing runs, not even the append", async () => {
    answer = { action: "decline" };
    await withFlag("true", async () => {
      const { body } = await execute(client, "batch_mixed_blocks", {
        operations: [
          { op: "append", block_id: "b-1", markdown: "Hello" },
          { op: "delete", block_id: "b-2" },
        ],
      });
      expect(body.error?.code).toBe("confirmation_declined");
      expect(notionStub.blocks.children.append).not.toHaveBeenCalled();
      expect(notionStub.blocks.delete).not.toHaveBeenCalled();
    });
  });
});

describe("confirm destructive: id-only targets", () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it("delete_comment names the comment id", async () => {
    notionStub.comments.delete.mockResolvedValue({});
    await withFlag("true", async () => {
      const { body } = await execute(client, "delete_comment", { comment_id: "c-1" });
      expect(body.ok).toBe(true);
      expect(prompts[0].message).toContain("comment c-1");
      expect(notionStub.comments.delete).toHaveBeenCalledWith({ comment_id: "c-1" });
    });
  });

  it("delete_view names the view id", async () => {
    notionStub.views.delete.mockResolvedValue({ id: "v-1", deleted: true });
    await withFlag("true", async () => {
      const { body } = await execute(client, "delete_view", { view_id: "v-1" });
      expect(body.ok).toBe(true);
      expect(prompts[0].message).toContain("view v-1");
    });
  });
});
