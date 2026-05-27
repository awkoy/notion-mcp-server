import { z, type ZodType } from "zod";

type JsonSchema = Record<string, unknown> & { $defs?: Record<string, unknown> };

const SHARED_REFS: Record<string, ZodType<unknown>> = {};

export function registerSharedRef(name: string, schema: ZodType<unknown>): void {
  SHARED_REFS[name] = schema;
}

export function emitJsonSchema(schema: ZodType<unknown>): JsonSchema {
  const raw = z.toJSONSchema(schema, {
    target: "draft-7",
    unrepresentable: "any",
  }) as JsonSchema;
  return hoistSharedRefs(raw);
}

function hoistSharedRefs(root: JsonSchema): JsonSchema {
  const sharedSchemas: Record<string, JsonSchema> = {};
  for (const [name, zodSchema] of Object.entries(SHARED_REFS)) {
    const raw = z.toJSONSchema(zodSchema, {
      target: "draft-7",
      unrepresentable: "any",
    }) as JsonSchema;
    // Root-level emission adds `$schema`, but nested inline usages don't carry it.
    // Strip it so the equality key matches inline sites.
    const { $schema: _drop, ...rest } = raw as JsonSchema & { $schema?: string };
    void _drop;
    sharedSchemas[name] = rest as JsonSchema;
  }

  const refByJson = new Map<string, string>();
  for (const [name, json] of Object.entries(sharedSchemas)) {
    refByJson.set(stableStringify(json), name);
  }

  let usedNames = new Set<string>();

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    const key = stableStringify(obj);
    const match = refByJson.get(key);
    if (match) {
      usedNames.add(match);
      return { $ref: `#/$defs/${match}` };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
    return out;
  }

  const walked = walk(root) as JsonSchema;
  if (usedNames.size === 0) return walked;

  const defs: Record<string, unknown> = walked.$defs ?? {};
  for (const name of usedNames) {
    if (!(name in defs)) defs[name] = walk(sharedSchemas[name]);
  }
  return { ...walked, $defs: defs };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}
