import { describe, it, expect, beforeAll } from "vitest";
import { initOperations, listOperations } from "../src/operations/index.js";

// `notion_describe` hands `example` / `exampleBatch` to the model as the
// canonical call shape. An example that fails its own schema teaches the
// model a call that the server then rejects, so every one of them must parse.

beforeAll(async () => {
  await initOperations();
});

function issues(op: { name: string; schema: { safeParse: (v: unknown) => any } }, value: unknown, label: string): string[] {
  const r = op.schema.safeParse(value);
  if (r.success) return [];
  return [
    `${op.name} ${label}: ` +
      r.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join(".") || "<root>"} ${i.message}`).join("; "),
  ];
}

describe("operation examples", () => {
  it("every example validates against its operation schema", () => {
    const failures = listOperations().flatMap((op) => issues(op, op.example, "example"));
    expect(failures).toEqual([]);
  });

  it("every exampleBatch item validates against its operation schema", () => {
    const failures = listOperations().flatMap((op) => {
      const batch = op.exampleBatch as { items?: unknown[] } | undefined;
      if (!batch) return [];
      expect(op.batchable, `${op.name} has exampleBatch but is not batchable`).toBe(true);
      expect(Array.isArray(batch.items), `${op.name} exampleBatch.items must be an array`).toBe(true);
      return (batch.items ?? []).flatMap((item, i) => issues(op, item, `exampleBatch.items[${i}]`));
    });
    expect(failures).toEqual([]);
  });
});
