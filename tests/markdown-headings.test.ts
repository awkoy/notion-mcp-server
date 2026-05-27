import { describe, it, expect } from "vitest";
import { parseMarkdownToBlocks } from "../src/markdown/parse.js";

describe("markdown headings", () => {
  it("parses #### as heading_4", () => {
    const blocks = parseMarkdownToBlocks("#### Hello") as Array<{ type: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("heading_4");
  });

  it("treats ##### and deeper as heading_4 ceiling", () => {
    const blocks = parseMarkdownToBlocks("##### Hi") as Array<{ type: string }>;
    expect(blocks).toHaveLength(1);
    expect(["heading_4", "paragraph"]).toContain(blocks[0].type);
  });
});
