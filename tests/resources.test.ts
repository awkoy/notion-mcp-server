import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const notionStub = {
  pages: { retrieveMarkdown: vi.fn() },
  dataSources: { retrieve: vi.fn() },
};

vi.mock("../src/services/notion.js", () => ({
  getClient: async () => notionStub,
}));

import { initOperations } from "../src/operations/index.js";
import { readNotionResource } from "../src/tools/resources.js";

beforeAll(async () => {
  await initOperations();
});

beforeEach(() => {
  notionStub.pages.retrieveMarkdown.mockReset();
  notionStub.dataSources.retrieve.mockReset();
});

describe("readNotionResource", () => {
  it("reads a page as markdown", async () => {
    notionStub.pages.retrieveMarkdown.mockResolvedValueOnce({
      markdown: "# Hello\n\nbody",
    });

    const res = await readNotionResource("page", "page-123");

    expect(res.mimeType).toBe("text/markdown");
    expect(res.text).toBe("# Hello\n\nbody");
    expect(notionStub.pages.retrieveMarkdown).toHaveBeenCalledWith({
      page_id: "page-123",
    });
  });

  it("reads a database as JSON", async () => {
    notionStub.dataSources.retrieve.mockResolvedValueOnce({
      id: "ds-1",
      title: [],
      properties: { Name: { type: "title" } },
    });

    const res = await readNotionResource("database", "ds-1");

    expect(res.mimeType).toBe("application/json");
    expect(JSON.parse(res.text)).toMatchObject({ id: "ds-1" });
    expect(notionStub.dataSources.retrieve).toHaveBeenCalledWith({
      data_source_id: "ds-1",
    });
  });

  it("returns the error envelope as JSON when the read fails", async () => {
    notionStub.pages.retrieveMarkdown.mockRejectedValueOnce(
      new Error("object_not_found")
    );

    const res = await readNotionResource("page", "missing");

    expect(res.mimeType).toBe("application/json");
    expect(res.text).toContain("object_not_found");
  });
});
