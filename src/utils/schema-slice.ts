// Slice a JSON Schema down to the failing field at a given path, and
// summarize any unions / deep nesting so the error envelope stays small.
//
// The full schema is always available via `notion_describe`; in a validation
// error we only need to show the LLM what the failing field expects, plus a
// working example. The unsliced schemas can be 10+KB (set_page_property's
// value union, update_database's properties propertyNames union, etc.).

type JsonSchema = Record<string, unknown> & { $defs?: Record<string, unknown> };
type Defs = Record<string, unknown> | undefined;

const DEFAULT_SUMMARY_DEPTH = 2;

function resolveRef(node: JsonSchema, defs: Defs): JsonSchema {
  const ref = node["$ref"];
  if (typeof ref !== "string" || !defs) return node;
  const match = /^#\/\$defs\/(.+)$/.exec(ref);
  if (!match) return node;
  if (!Object.hasOwn(defs, match[1])) return node;
  const resolved = defs[match[1]];
  if (typeof resolved !== "object" || resolved === null) return node;
  return resolved as JsonSchema;
}

function asObject(value: unknown): JsonSchema | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return value as JsonSchema;
}

export function sliceJsonSchema(
  root: JsonSchema,
  path: readonly (string | number)[]
): JsonSchema {
  const defs = root.$defs;
  let cur: JsonSchema = root;
  for (const seg of path) {
    cur = resolveRef(cur, defs);
    if (typeof seg === "string") {
      // Only follow own-property keys: a Zod error path comes from caller-supplied
      // payload field names, so `__proto__` / `constructor` could otherwise walk
      // the prototype chain when slicing.
      const props = asObject(cur.properties);
      if (props && Object.hasOwn(props, seg)) {
        const next = asObject(props[seg]);
        if (next) {
          cur = next;
          continue;
        }
      }
      const branches = (cur.oneOf ?? cur.anyOf) as JsonSchema[] | undefined;
      if (Array.isArray(branches)) {
        const matched = branches
          .map((b) => resolveRef(b, defs))
          .find((b) => {
            const p = asObject(b.properties);
            return p !== undefined && Object.hasOwn(p, seg);
          });
        if (matched) {
          const props = asObject(matched.properties);
          if (props) {
            const next = asObject(props[seg]);
            if (next) {
              cur = next;
              continue;
            }
          }
        }
      }
      return cur;
    }
    if (typeof seg === "number") {
      const items = cur.items;
      if (Array.isArray(items)) {
        const next = asObject(items[seg]);
        if (next) {
          cur = next;
          continue;
        }
      } else if (items) {
        const next = asObject(items);
        if (next) {
          cur = next;
          continue;
        }
      }
      return cur;
    }
  }
  return resolveRef(cur, defs);
}

// Replace large unions with a one-line-per-branch discriminator summary,
// and cap nested objects/arrays at DEFAULT_SUMMARY_DEPTH.
export function summarizeSchema(
  schema: JsonSchema,
  depth = DEFAULT_SUMMARY_DEPTH,
  defs?: Defs
): JsonSchema {
  const allDefs: Defs = defs ?? schema.$defs;
  const resolved = resolveRef(schema, allDefs);

  if (depth < 0) {
    const t = resolved.type;
    return { _truncated: true, ...(t ? { type: t } : {}) } as JsonSchema;
  }

  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = resolved[key];
    if (Array.isArray(branches)) {
      const summary = (branches as JsonSchema[]).map((b) => discriminatorSummary(b, allDefs));
      const out: JsonSchema = { [key]: summary } as JsonSchema;
      if (resolved.description) out.description = resolved.description;
      return out;
    }
  }

  if (resolved.type === "object" && asObject(resolved.properties)) {
    const props = resolved.properties as Record<string, JsonSchema>;
    const summarizedProps: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(props)) {
      summarizedProps[k] = summarizeSchema(v, depth - 1, allDefs);
    }
    const out: JsonSchema = { ...resolved, properties: summarizedProps };
    delete (out as { $defs?: unknown }).$defs;
    return out;
  }

  if (resolved.type === "array") {
    const items = resolved.items;
    if (items && !Array.isArray(items)) {
      const out: JsonSchema = {
        ...resolved,
        items: summarizeSchema(items as JsonSchema, depth - 1, allDefs),
      };
      delete (out as { $defs?: unknown }).$defs;
      return out;
    }
  }

  const out: JsonSchema = { ...resolved };
  delete (out as { $defs?: unknown }).$defs;
  return out;
}

// One-line-per-branch: if a branch has a property with a literal `const`
// (Zod literals emit as such), surface it as the discriminator tag. Otherwise
// fall back to `type` + the first required field name.
function discriminatorSummary(
  branch: JsonSchema,
  defs: Defs
): JsonSchema {
  const resolved = resolveRef(branch, defs);
  const props = asObject(resolved.properties);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      const val = asObject(v);
      if (val && val.const !== undefined) {
        return { [k]: val.const } as JsonSchema;
      }
    }
    const required = resolved.required;
    if (Array.isArray(required) && required.length > 0) {
      return { type: "object", required } as JsonSchema;
    }
  }
  if (resolved.type) return { type: resolved.type } as JsonSchema;
  if (resolved.const !== undefined) return { const: resolved.const } as JsonSchema;
  if (Array.isArray(resolved.enum)) return { enum: resolved.enum } as JsonSchema;
  return resolved;
}
