import { describe, expect, it, vi } from "vitest";
import { TOOL_PAYLOAD_SCHEMA, normalizeToolPayload } from "../src/tools/arguments.js";

describe("MCP serialized operation payload compatibility", () => {
  const payload = { page_id: "page-1", properties: { Status: "Done" } };

  it("accepts a normal object without copying or modifying it", () => {
    expect(TOOL_PAYLOAD_SCHEMA.safeParse(payload).success).toBe(true);
    expect(normalizeToolPayload(payload)).toBe(payload);
  });

  it("accepts one, two, or three JSON string wrappers around an object", () => {
    let encoded: string = JSON.stringify(payload);
    for (let depth = 1; depth <= 3; depth += 1) {
      expect(TOOL_PAYLOAD_SCHEMA.parse(encoded)).toEqual(payload);
      expect(normalizeToolPayload(encoded)).toEqual(payload);
      encoded = JSON.stringify(encoded);
    }
  });

  it("decodes three wrappers once during validation, not twice", () => {
    const encoded = JSON.stringify(JSON.stringify(JSON.stringify(payload)));
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(TOOL_PAYLOAD_SCHEMA.parse(encoded)).toEqual(payload);
      expect(parse).toHaveBeenCalledTimes(3);
    } finally {
      parse.mockRestore();
    }
  });

  it("preserves user-provided JSON-looking values inside an object", () => {
    const object = {
      title: '{"type":"text","text":"literal user content"}',
      nested: { body: '["literal","array"]', message: '"quoted string"' },
      children: ['{"id":"literal"}'],
    };
    expect(normalizeToolPayload(object)).toEqual(object);
    expect(normalizeToolPayload(JSON.stringify(object))).toEqual(object);
  });

  it("preserves special object keys and whitespace without prototype mutation", () => {
    const encoded = `  ${JSON.stringify({
      ...JSON.parse('{"__proto__":{"polluted":true}}'),
      constructor: "literal",
      body: '{"x":1}',
    })}  `;
    const result = TOOL_PAYLOAD_SCHEMA.parse(encoded) as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(result.constructor).toBe("literal");
    expect(result.body).toBe('{"x":1}');
  });

  it("rejects arrays and scalars at the root even when serialized", () => {
    for (const input of ["plain", "[]", "null", '"hello"', "123", "true"]) {
      expect(TOOL_PAYLOAD_SCHEMA.safeParse(input).success).toBe(false);
      expect(() => normalizeToolPayload(input)).toThrow(TypeError);
    }
  });

  it("rejects malformed JSON without guessing at corrections", () => {
    const input = '{"page_id":';
    expect(TOOL_PAYLOAD_SCHEMA.safeParse(input).success).toBe(false);
  });

  it("limits decoding to three layers", () => {
    const four = JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify(payload))));
    expect(TOOL_PAYLOAD_SCHEMA.safeParse(four).success).toBe(false);
    expect(() => normalizeToolPayload(four)).toThrow(TypeError);
  });
});
