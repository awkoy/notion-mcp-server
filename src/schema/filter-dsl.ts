import { z } from "zod";

// Typed shorthand for Notion `filter` payloads on data source queries.
// The user writes `{Status: "Done", Priority: {gte: 3}}` and we compile to
// the verbose Notion JSON. Multi-key clauses are implicit AND; explicit
// {AND/OR/NOT: ...} blocks compose. Property TYPE is inferred from value
// shape — pass `__type: "multi_select"` etc. when inference is wrong.

// ─── Property types — single source of truth ────────────────────────────────

const PROPERTY_TYPES = [
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "people",
  "files",
  "relation",
  "url",
  "email",
  "phone_number",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "unique_id",
] as const;
type PropertyType = (typeof PROPERTY_TYPES)[number];

// ─── DSL operator surface ───────────────────────────────────────────────────

const SCALAR = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const OPERATORS_SCHEMA = z
  .object({
    eq: z.union([SCALAR, z.array(SCALAR)]).optional(),
    ne: z.union([SCALAR, z.array(SCALAR)]).optional(),
    gt: SCALAR.optional(),
    gte: SCALAR.optional(),
    lt: SCALAR.optional(),
    lte: SCALAR.optional(),
    contains: z.string().optional(),
    notContains: z.string().optional(),
    startsWith: z.string().optional(),
    endsWith: z.string().optional(),
    in: z.array(SCALAR).optional(),
    notIn: z.array(SCALAR).optional(),
    is_empty: z.boolean().optional(),
    is_not_empty: z.boolean().optional(),
    before: z.string().optional(),
    after: z.string().optional(),
    on_or_before: z.string().optional(),
    on_or_after: z.string().optional(),
    __type: z.enum(PROPERTY_TYPES).optional(),
  })
  .strict();

// OPERATORS_SCHEMA documents the accepted operator shape but isn't used to
// validate WHERE_SCHEMA directly — we keep the outer schema permissive
// (record of unknown) so compileWhere can point at the offending property
// in its error messages.
export type Operators = z.infer<typeof OPERATORS_SCHEMA>;

export const WHERE_SCHEMA = z.record(z.string(), z.unknown()).describe(
  "Typed filter DSL. Property names map to scalar values (equals shorthand) or operator objects like {gte:3, contains:'x'}. Top-level AND/OR arrays and NOT compose."
);

export type Where = z.infer<typeof WHERE_SCHEMA>;

// ─── Internal types & helpers ───────────────────────────────────────────────

type NotionFilter = Record<string, unknown>;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

function isDateLike(v: unknown): boolean {
  return typeof v === "string" && ISO_DATE_RE.test(v);
}

// Single place where we narrow unknown → keyed object. Throws so the caller
// surfaces a helpful where_compile_error rather than silently mis-typing.
function asObject(value: unknown, context: string): NotionFilter {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected object, got ${JSON.stringify(value)}`);
  }
  return value as NotionFilter;
}

// ─── Operator maps per property-type family ─────────────────────────────────

const NUMERIC_OP_MAP: Record<string, string> = {
  eq: "equals",
  ne: "does_not_equal",
  gt: "greater_than",
  gte: "greater_than_or_equal_to",
  lt: "less_than",
  lte: "less_than_or_equal_to",
};

const DATE_OP_MAP: Record<string, string> = {
  eq: "equals",
  ne: "does_not_equal",
  gt: "after",
  gte: "on_or_after",
  lt: "before",
  lte: "on_or_before",
  before: "before",
  after: "after",
  on_or_before: "on_or_before",
  on_or_after: "on_or_after",
};

const TEXT_OP_MAP: Record<string, string> = {
  eq: "equals",
  ne: "does_not_equal",
  contains: "contains",
  notContains: "does_not_contain",
  startsWith: "starts_with",
  endsWith: "ends_with",
};

const SELECT_OP_MAP: Record<string, string> = {
  eq: "equals",
  ne: "does_not_equal",
};

const MULTI_SELECT_OP_MAP: Record<string, string> = {
  eq: "contains",
  ne: "does_not_contain",
  contains: "contains",
  notContains: "does_not_contain",
};

const EMPTINESS_OPS = new Set(["is_empty", "is_not_empty"]);

const TYPE_OP_MAP: Record<PropertyType, Record<string, string>> = {
  number: NUMERIC_OP_MAP,
  unique_id: NUMERIC_OP_MAP,
  date: DATE_OP_MAP,
  created_time: DATE_OP_MAP,
  last_edited_time: DATE_OP_MAP,
  title: TEXT_OP_MAP,
  rich_text: TEXT_OP_MAP,
  url: TEXT_OP_MAP,
  email: TEXT_OP_MAP,
  phone_number: TEXT_OP_MAP,
  select: SELECT_OP_MAP,
  status: SELECT_OP_MAP,
  multi_select: MULTI_SELECT_OP_MAP,
  relation: MULTI_SELECT_OP_MAP,
  people: MULTI_SELECT_OP_MAP,
  files: MULTI_SELECT_OP_MAP,
  checkbox: SELECT_OP_MAP,
  created_by: SELECT_OP_MAP,
  last_edited_by: SELECT_OP_MAP,
};

function opMapFor(type: PropertyType): Record<string, string> {
  return TYPE_OP_MAP[type] ?? SELECT_OP_MAP;
}

// ─── Type inference ─────────────────────────────────────────────────────────

const DATE_ONLY_OPS = ["before", "after", "on_or_before", "on_or_after"] as const;
const TEXT_ONLY_OPS = ["contains", "notContains", "startsWith", "endsWith"] as const;

function inferTypeFromScalar(v: string | number | boolean): PropertyType {
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "checkbox";
  return isDateLike(v) ? "date" : "select";
}

function inferTypeFromOps(ops: NotionFilter): PropertyType {
  const hint = ops.__type;
  if (typeof hint === "string" && (PROPERTY_TYPES as readonly string[]).includes(hint)) {
    return hint as PropertyType;
  }
  if (DATE_ONLY_OPS.some((k) => k in ops)) return "date";
  if (TEXT_ONLY_OPS.some((k) => k in ops)) return "rich_text";

  const sample =
    ops.eq ?? ops.ne ?? ops.gt ?? ops.gte ?? ops.lt ?? ops.lte ?? ops.in ?? ops.notIn;
  if (Array.isArray(sample)) {
    const first = sample[0];
    if (typeof first === "number") return "number";
    if (typeof first === "string" && isDateLike(first)) return "date";
    return "select";
  }
  if (typeof sample === "number" || typeof sample === "boolean") {
    return inferTypeFromScalar(sample);
  }
  if (typeof sample === "string") return inferTypeFromScalar(sample);
  // is_empty / is_not_empty alone → rich_text default (works on most types)
  return "rich_text";
}

// ─── Leaf compilation ───────────────────────────────────────────────────────

function buildLeaf(
  propertyName: string,
  type: PropertyType,
  condition: Record<string, unknown>
): NotionFilter {
  return { property: propertyName, [type]: condition };
}

function compilePropertyClause(propertyName: string, value: unknown): NotionFilter {
  // Bare scalar shorthand → equals
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const type = inferTypeFromScalar(value);
    const opMap = opMapFor(type);
    return buildLeaf(propertyName, type, { [opMap.eq]: value });
  }
  if (value === null) {
    return buildLeaf(propertyName, "rich_text", { is_empty: true });
  }

  const ops = asObject(value, `filter value for property "${propertyName}"`);
  const type = inferTypeFromOps(ops);
  const opMap = opMapFor(type);

  // {in: [...]} → OR of equals on the same property
  if (Array.isArray(ops.in)) {
    if (ops.in.length === 0) {
      throw new Error(`"in" on property "${propertyName}" must be non-empty`);
    }
    return {
      or: ops.in.map((v) => buildLeaf(propertyName, type, { [opMap.eq]: v })),
    };
  }
  if (Array.isArray(ops.notIn)) {
    if (ops.notIn.length === 0) {
      throw new Error(`"notIn" on property "${propertyName}" must be non-empty`);
    }
    return {
      and: ops.notIn.map((v) => buildLeaf(propertyName, type, { [opMap.ne]: v })),
    };
  }

  const conditions: Array<[string, unknown]> = [];
  for (const [opKey, opVal] of Object.entries(ops)) {
    if (opKey === "__type" || opVal === undefined) continue;
    if (EMPTINESS_OPS.has(opKey)) {
      if (opVal !== true) continue;
      conditions.push([opKey, true]);
      continue;
    }
    const notionOp = opMap[opKey];
    if (!notionOp) {
      throw new Error(
        `Unsupported operator "${opKey}" on property "${propertyName}" (inferred type: ${type}). Use __type to override.`
      );
    }
    conditions.push([notionOp, opVal]);
  }
  if (conditions.length === 0) {
    throw new Error(`No usable operators on property "${propertyName}"`);
  }
  if (conditions.length === 1) {
    const [notionOp, opVal] = conditions[0];
    return buildLeaf(propertyName, type, { [notionOp]: opVal });
  }
  return {
    and: conditions.map(([k, v]) => buildLeaf(propertyName, type, { [k]: v })),
  };
}

// ─── Negation (De Morgan + per-leaf inversion) ──────────────────────────────

const INVERSE_LEAF_OP: Record<string, string> = {
  equals: "does_not_equal",
  does_not_equal: "equals",
  contains: "does_not_contain",
  does_not_contain: "contains",
  is_empty: "is_not_empty",
  is_not_empty: "is_empty",
  greater_than: "less_than_or_equal_to",
  less_than: "greater_than_or_equal_to",
  greater_than_or_equal_to: "less_than",
  less_than_or_equal_to: "greater_than",
  before: "on_or_after",
  after: "on_or_before",
  on_or_before: "after",
  on_or_after: "before",
};

function negateChildren(arr: unknown[]): NotionFilter[] {
  return arr.map((f, i) => negate(asObject(f, `NOT child[${i}]`)));
}

function negate(filter: NotionFilter): NotionFilter {
  if (Array.isArray(filter.and)) return { or: negateChildren(filter.and) };
  if (Array.isArray(filter.or)) return { and: negateChildren(filter.or) };

  if (typeof filter.property !== "string") {
    throw new Error(`Cannot negate filter: unsupported shape ${JSON.stringify(filter)}`);
  }
  const typeKeys = Object.keys(filter).filter((k) => k !== "property");
  if (typeKeys.length !== 1) {
    throw new Error("NOT requires a single typed leaf or a logical compound");
  }
  const typeKey = typeKeys[0];
  const inner = asObject(filter[typeKey], `NOT leaf "${filter.property}"`);
  const innerKeys = Object.keys(inner);
  if (innerKeys.length !== 1) {
    throw new Error("NOT cannot negate a leaf with multiple operators; rewrite as AND/OR first");
  }
  const op = innerKeys[0];
  const inv = INVERSE_LEAF_OP[op];
  if (!inv) {
    throw new Error(`Operator "${op}" has no inverse; rewrite without NOT`);
  }
  return { property: filter.property, [typeKey]: { [inv]: inner[op] } };
}

// ─── Top-level recursion ────────────────────────────────────────────────────

// Boolean combinator keywords are case-insensitive. Lowercase is the
// canonical form (matches Notion's own filter JSON), but uppercase is
// accepted so callers who think of AND/OR/NOT as SQL-style keywords
// don't trip on case. A column literally named "and"/"AND" must be
// disambiguated with __type via an operator object — collision is
// documented in the resource.
const AND_KEYS = new Set(["and", "AND"]);
const OR_KEYS = new Set(["or", "OR"]);
const NOT_KEYS = new Set(["not", "NOT"]);

function compileCombinator(
  value: unknown,
  keyword: string,
  wrapKey: "and" | "or"
): NotionFilter | undefined {
  if (!Array.isArray(value)) {
    throw new Error(`${keyword} must be an array of where clauses`);
  }
  const inner: NotionFilter[] = [];
  for (const child of value) {
    const compiled = compileWhere(child);
    if (compiled) inner.push(compiled);
  }
  if (inner.length === 0) return undefined;
  if (inner.length === 1) return inner[0];
  return { [wrapKey]: inner };
}

export function compileWhere(where: unknown): NotionFilter | undefined {
  if (where === undefined || where === null) return undefined;
  const obj = asObject(where, "where clause");
  const entries = Object.entries(obj);
  if (entries.length === 0) return undefined;

  const parts: NotionFilter[] = [];

  for (const [key, value] of entries) {
    if (AND_KEYS.has(key)) {
      const compiled = compileCombinator(value, key, "and");
      if (compiled) parts.push(compiled);
      continue;
    }
    if (OR_KEYS.has(key)) {
      const compiled = compileCombinator(value, key, "or");
      if (compiled) parts.push(compiled);
      continue;
    }
    if (NOT_KEYS.has(key)) {
      const inner = compileWhere(value);
      if (inner) parts.push(negate(inner));
      continue;
    }
    parts.push(compilePropertyClause(key, value));
  }

  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { and: parts };
}
