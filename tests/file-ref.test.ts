import { describe, it, expect, afterEach } from "vitest";
import {
  blockFileRef,
  propertyFileRef,
  parseFileRef,
  fileRefsEnabled,
} from "../src/utils/file-ref.js";
import { slimBlock, slimPage } from "../src/utils/slim.js";

const BLOCK = "3ab5030f-c6e5-8182-a41b-e48b46176e7b";
const PAGE = "3ab5030f-c6e5-8109-b32f-dbd2c4093059";
const SIGNED = "https://prod-files-secure.s3.us-west-2.amazonaws.com/a/b/dot.png?X-Amz-Signature=deadbeef";

afterEach(() => {
  delete process.env.NOTION_FILE_URLS;
});

describe("file refs", () => {
  it("round-trips a block ref", () => {
    expect(parseFileRef(blockFileRef(BLOCK))).toEqual({ kind: "block", blockId: BLOCK });
  });

  it("round-trips a property ref, including a name with a space", () => {
    const ref = propertyFileRef(PAGE, "Cover Shot", 2);
    expect(parseFileRef(ref)).toEqual({
      kind: "property",
      pageId: PAGE,
      property: "Cover Shot",
      index: 2,
    });
  });

  it("rejects anything that is not a ref", () => {
    expect(parseFileRef(SIGNED)).toBeUndefined();
    expect(parseFileRef("notion-file:block")).toBeUndefined();
    expect(parseFileRef("notion-file:page/p/prop/x")).toBeUndefined();
  });

  it("is off unless NOTION_FILE_URLS says ref", () => {
    expect(fileRefsEnabled()).toBe(false);
    process.env.NOTION_FILE_URLS = "ref";
    expect(fileRefsEnabled()).toBe(true);
  });
});

const imageBlock = {
  object: "block",
  id: BLOCK,
  type: "image",
  has_children: false,
  in_trash: false,
  image: { type: "file", file: { url: SIGNED } },
} as any;

describe("slimBlock under refs", () => {
  it("emits the signed url by default", () => {
    expect((slimBlock(imageBlock) as any).image).toBe(SIGNED);
  });

  it("emits a ref when refs are on", () => {
    process.env.NOTION_FILE_URLS = "ref";
    expect((slimBlock(imageBlock) as any).image).toBe(blockFileRef(BLOCK));
  });

  it("leaves an external url alone even when refs are on", () => {
    process.env.NOTION_FILE_URLS = "ref";
    const external = {
      ...imageBlock,
      image: { type: "external", external: { url: "https://example.com/a.png" } },
    };
    expect((slimBlock(external as any) as any).image).toBe("https://example.com/a.png");
  });
});

describe("slimPage files property under refs", () => {
  const page = {
    object: "page",
    id: PAGE,
    url: "https://notion.so/x",
    parent: { type: "page_id", page_id: "p" },
    in_trash: false,
    icon: null,
    properties: {
      Asset: {
        type: "files",
        files: [{ name: "dot.png", type: "file", file: { url: SIGNED } }],
      },
    },
  } as any;

  it("emits a ref carrying the page, property and index", () => {
    process.env.NOTION_FILE_URLS = "ref";
    const slimmed = slimPage(page, false, true) as any;
    expect(slimmed.properties.Asset[0].url).toBe(propertyFileRef(PAGE, "Asset", 0));
  });

  it("emits the signed url by default", () => {
    const slimmed = slimPage(page, false, true) as any;
    expect(slimmed.properties.Asset[0].url).toBe(SIGNED);
  });
});
