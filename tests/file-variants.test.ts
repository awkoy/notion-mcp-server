import { describe, it, expect } from "vitest";
import { FILE_SCHEMA } from "../src/schema/file.js";
import { IMAGE_BLOCK_REQUEST_SCHEMA } from "../src/schema/blocks.js";
import { FILES_PROPERTY_VALUE_SCHEMA } from "../src/schema/page-properties.js";

const UPLOAD_ID = "3ab5030f-c6e5-8135-890d-00b28c70747b";

describe("FILE_SCHEMA", () => {
  it("takes an external url", () => {
    const parsed = FILE_SCHEMA.safeParse({
      type: "external",
      external: { url: "https://example.com/a.png" },
    });
    expect(parsed.success).toBe(true);
  });

  it("takes a file_upload id", () => {
    const parsed = FILE_SCHEMA.safeParse({
      type: "file_upload",
      file_upload: { id: UPLOAD_ID },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown source type", () => {
    expect(FILE_SCHEMA.safeParse({ type: "file", file: { url: "x" } }).success).toBe(false);
  });
});

describe("image block", () => {
  it("takes a file_upload with a caption", () => {
    const parsed = IMAGE_BLOCK_REQUEST_SCHEMA.safeParse({
      type: "image",
      image: {
        type: "file_upload",
        file_upload: { id: UPLOAD_ID },
        caption: [{ type: "text", text: { content: "from disk" } }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("still takes an external url with a caption", () => {
    const parsed = IMAGE_BLOCK_REQUEST_SCHEMA.safeParse({
      type: "image",
      image: {
        type: "external",
        external: { url: "https://example.com/a.png" },
        caption: [{ type: "text", text: { content: "remote" } }],
      },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("files property value", () => {
  it("takes a file_upload entry, which carries no type tag", () => {
    const parsed = FILES_PROPERTY_VALUE_SCHEMA.safeParse({
      files: [{ name: "dot.png", file_upload: { id: UPLOAD_ID } }],
    });
    expect(parsed.success).toBe(true);
  });

  it("still takes an external entry", () => {
    const parsed = FILES_PROPERTY_VALUE_SCHEMA.safeParse({
      files: [{ name: "dot.png", external: { url: "https://example.com/dot.png" } }],
    });
    expect(parsed.success).toBe(true);
  });
});
