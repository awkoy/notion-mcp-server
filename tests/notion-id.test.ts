import { describe, it, expect } from "vitest";
import { normalizeNotionId, notionId } from "../src/schema/id.js";

const DASHED = "3ab5030f-c6e5-801e-b170-cd93167dd607";
const BARE = "3ab5030fc6e5801eb170cd93167dd607";

describe("normalizeNotionId", () => {
  it("dashes a bare id", () => {
    expect(normalizeNotionId(BARE)).toBe(DASHED);
  });

  it("leaves a dashed id alone", () => {
    expect(normalizeNotionId(DASHED)).toBe(DASHED);
  });

  it("takes the id out of a page URL", () => {
    expect(
      normalizeNotionId(`https://app.notion.com/p/Varuag-s-Testing-Playground-${BARE}`)
    ).toBe(DASHED);
  });

  it("ignores a view id in the query string", () => {
    const view = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
    expect(normalizeNotionId(`https://www.notion.so/Tasks-${BARE}?v=${view}&pvs=4`)).toBe(
      DASHED
    );
  });

  it("passes a property id through untouched", () => {
    expect(normalizeNotionId("%40APf")).toBe("%40APf");
  });

  it("passes an unrecognized string through, so a bad id still fails", () => {
    expect(normalizeNotionId("not-an-id")).toBe("not-an-id");
  });

  it("leaves a non-string alone", () => {
    expect(normalizeNotionId(42)).toBe(42);
  });
});

describe("notionId schema", () => {
  it("normalizes on parse", () => {
    expect(notionId().parse(`https://www.notion.so/X-${BARE}`)).toBe(DASHED);
  });

  it("still rejects a non-string", () => {
    expect(notionId().safeParse(42).success).toBe(false);
  });
});
