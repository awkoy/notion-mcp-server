import { describe, it, expect } from "vitest";
import { parseMarkdownToBlocks } from "../src/markdown/parse.js";

type Block = { type: string; [k: string]: any };

function richText(block: Block): any[] {
  return block[block.type].rich_text;
}

describe("parseMarkdownToBlocks", () => {
  it("returns empty array for blank input", () => {
    expect(parseMarkdownToBlocks("")).toEqual([]);
    expect(parseMarkdownToBlocks("   \n\n  ")).toEqual([]);
  });

  it("parses a paragraph", () => {
    const [b] = parseMarkdownToBlocks("hello world") as Block[];
    expect(b.type).toBe("paragraph");
    expect(richText(b)[0].text.content).toBe("hello world");
  });

  it("parses headings (h1, h2, h3, h4) and clamps deeper levels to h4", () => {
    const blocks = parseMarkdownToBlocks("# A\n## B\n### C\n#### D") as Block[];
    expect(blocks.map((b) => b.type)).toEqual([
      "heading_1",
      "heading_2",
      "heading_3",
      "heading_4",
    ]);
  });

  it("parses bulleted and numbered list items", () => {
    const blocks = parseMarkdownToBlocks(
      "- one\n- two\n\n1. first\n2. second"
    ) as Block[];
    expect(blocks.map((b) => b.type)).toEqual([
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
      "numbered_list_item",
    ]);
  });

  it("parses to-do items with checked state", () => {
    const blocks = parseMarkdownToBlocks("- [ ] open\n- [x] done") as Block[];
    expect(blocks.map((b) => b.type)).toEqual(["to_do", "to_do"]);
    expect(blocks[0].to_do.checked).toBe(false);
    expect(blocks[1].to_do.checked).toBe(true);
  });

  it("parses a quote with nested children", () => {
    const blocks = parseMarkdownToBlocks("> first line\n>\n> second line") as Block[];
    expect(blocks[0].type).toBe("quote");
    expect(blocks[0].quote.rich_text[0].text.content).toBe("first line");
    expect(blocks[0].quote.children?.[0]?.type).toBe("paragraph");
  });

  it("parses a fenced code block with language normalization", () => {
    const [b] = parseMarkdownToBlocks(
      "```ts\nconst x = 1;\n```"
    ) as Block[];
    expect(b.type).toBe("code");
    expect(b.code.language).toBe("typescript");
    expect(b.code.rich_text[0].text.content).toBe("const x = 1;");
  });

  it("falls back to plain text for unknown languages", () => {
    const [b] = parseMarkdownToBlocks("```weirdlang\nhi\n```") as Block[];
    expect(b.code.language).toBe("plain text");
  });

  it("parses thematic break as divider", () => {
    const [b] = parseMarkdownToBlocks("---") as Block[];
    expect(b.type).toBe("divider");
  });

  it("parses inline annotations (bold, italic, strikethrough, code)", () => {
    const [b] = parseMarkdownToBlocks(
      "**bold** *italic* ~~strike~~ `code`"
    ) as Block[];
    const rts = richText(b);
    const bold = rts.find((r) => r.text.content === "bold");
    const italic = rts.find((r) => r.text.content === "italic");
    const strike = rts.find((r) => r.text.content === "strike");
    const code = rts.find((r) => r.text.content === "code");
    expect(bold.annotations.bold).toBe(true);
    expect(italic.annotations.italic).toBe(true);
    expect(strike.annotations.strikethrough).toBe(true);
    expect(code.annotations.code).toBe(true);
  });

  it("merges adjacent runs with the same annotations", () => {
    // Hard break (`  \n`) emits a `\n` text node between two plain text nodes,
    // all three with no annotations — they should collapse to a single run.
    const [b] = parseMarkdownToBlocks("hello  \nworld") as Block[];
    const rts = richText(b);
    expect(rts).toHaveLength(1);
    expect(rts[0].text.content).toBe("hello\nworld");
  });

  it("attaches link URL to text runs", () => {
    const [b] = parseMarkdownToBlocks("[hello](https://example.com)") as Block[];
    const rt = richText(b)[0];
    expect(rt.text.link.url).toBe("https://example.com");
    expect(rt.text.content).toBe("hello");
  });

  it("parses a standalone image as a block with caption from alt", () => {
    const [b] = parseMarkdownToBlocks(
      "![alt text](https://example.com/x.png)"
    ) as Block[];
    expect(b.type).toBe("image");
    expect(b.image.external.url).toBe("https://example.com/x.png");
    expect(b.image.caption[0].text.content).toBe("alt text");
  });
});
