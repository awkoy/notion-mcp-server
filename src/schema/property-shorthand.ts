import { normalizeNotionId } from "./id.js";
import type { DataSourceSchema, PropertySchema } from "../services/schema-cache.js";
import type { OperationError } from "../operations/types.js";

/**
 * Plain-value shorthand for page properties.
 *
 * A database row's property value in the Notion API is a typed object —
 * `{ select: { name: "Done" } }`, `{ date: { start: "2026-01-01" } }`,
 * `{ rich_text: [{ type: "text", text: { content: "…" } }] }` — and a model
 * that has just read the row back (where the same values arrive flattened)
 * has to remember fifteen shapes to write one back. Given the data source's
 * property definitions, every shape is determined by the property type, so
 * `coerceProperties` turns `{ Status: "Done", Due: "2026-01-01", Tags: ["a"] }`
 * into the typed objects Notion wants and leaves typed objects untouched.
 */

/** Keys of a typed value object, i.e. a value that is already in API shape. */
const TYPED_KEYS = new Set([
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "people",
  "files",
  "checkbox",
  "url",
  "email",
  "phone_number",
  "relation",
  "verification",
]);

/** Property types that cannot be written through the API. */
const READ_ONLY_TYPES = new Set([
  "formula",
  "rollup",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "unique_id",
  "button",
  "place",
]);

/** Plain values understood per property type, for error messages. */
const SHORTHAND_HELP: Record<string, string> = {
  title: "a string",
  rich_text: "a string",
  number: "a number",
  select: "an option name (string)",
  status: "an option name (string)",
  multi_select: "an option name or an array of option names",
  date: 'an ISO date string, or { start, end? }',
  checkbox: "true or false",
  url: "a string",
  email: "a string",
  phone_number: "a string",
  people: "a user id or an array of user ids",
  relation: "a page id or an array of page ids",
  files: "a URL, or an array of URLs / { name, url } objects",
};

export type CoerceResult =
  | { ok: true; properties: Record<string, unknown>; warnings: string[] }
  | { ok: false; error: OperationError };

type Coerced = { ok: true; value: unknown } | { ok: false; error: OperationError };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `{ select: {...} }`, `{ title: [...] }` … — a value already in API shape. */
export function isTypedValue(v: unknown): boolean {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v).filter((k) => k !== "type" && k !== "id");
  return keys.length === 1 && TYPED_KEYS.has(keys[0]);
}

/** True when any property carries a plain value rather than a typed object. */
export function hasShorthandValues(properties: Record<string, unknown>): boolean {
  return Object.entries(properties).some(([name, v]) => !isTypedValue(v) && !isTitleShorthand(name, v));
}

/** `title: "…"` is understood without a schema. */
function isTitleShorthand(name: string, v: unknown): boolean {
  return name === "title" && typeof v === "string";
}

function text(content: string) {
  return [{ type: "text", text: { content } }];
}

function mismatch(name: string, type: string, value: unknown): Coerced {
  const got = Array.isArray(value) ? "an array" : value === null ? "null" : `a ${typeof value}`;
  return {
    ok: false,
    error: {
      code: "property_type_mismatch",
      message: `Property "${name}" is a ${type} property; got ${got}.`,
      path: ["properties", name],
      fix: `Pass ${SHORTHAND_HELP[type] ?? `a typed { ${type}: … } object`} for "${name}", or the typed Notion value object.`,
    },
  };
}

function ids(value: unknown): string[] | undefined {
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === "string") out.push(normalizeNotionId(item));
    else if (isPlainObject(item) && typeof item.id === "string") out.push(normalizeNotionId(item.id));
    else return undefined;
  }
  return out;
}

function fileEntry(item: unknown): Record<string, unknown> | undefined {
  if (typeof item === "string") {
    let name = item;
    try {
      const last = new URL(item).pathname.split("/").filter(Boolean).pop();
      if (last) name = decodeURIComponent(last);
    } catch {
      /* not a URL: keep the string as the name */
    }
    return { type: "external", name, external: { url: item } };
  }
  if (isPlainObject(item)) {
    if ("external" in item || "file_upload" in item) return item;
    if (typeof item.url === "string") {
      return {
        type: "external",
        name: typeof item.name === "string" ? item.name : item.url,
        external: { url: item.url },
      };
    }
    if (typeof item.file_upload_id === "string") {
      return { type: "file_upload", file_upload: { id: item.file_upload_id } };
    }
  }
  return undefined;
}

/** Coerce one plain value into the typed object for `prop.type`. */
export function coerceValue(name: string, value: unknown, prop: PropertySchema): Coerced {
  const { type } = prop;
  if (isTypedValue(value)) return { ok: true, value };

  if (value === null) {
    switch (type) {
      case "title":
        return { ok: true, value: { title: [] } };
      case "rich_text":
        return { ok: true, value: { rich_text: [] } };
      case "multi_select":
      case "people":
      case "files":
      case "relation":
        return { ok: true, value: { [type]: [] } };
      case "checkbox":
        return { ok: true, value: { checkbox: false } };
      default:
        return { ok: true, value: { [type]: null } };
    }
  }

  switch (type) {
    case "title":
    case "rich_text": {
      if (typeof value === "string" || typeof value === "number") {
        return { ok: true, value: { [type]: text(String(value)) } };
      }
      if (Array.isArray(value) && value.every((i) => isPlainObject(i) && "type" in i)) {
        return { ok: true, value: { [type]: value } };
      }
      return mismatch(name, type, value);
    }
    case "number": {
      if (typeof value === "number") return { ok: true, value: { number: value } };
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return { ok: true, value: { number: Number(value) } };
      }
      return mismatch(name, type, value);
    }
    case "select":
    case "status": {
      const optionName =
        typeof value === "string" ? value : isPlainObject(value) && typeof value.name === "string" ? value.name : undefined;
      if (optionName === undefined) return mismatch(name, type, value);
      if (type === "status" && prop.options && !prop.options.includes(optionName)) {
        return {
          ok: false,
          error: {
            code: "unknown_option",
            message: `"${optionName}" is not an option of status property "${name}".`,
            path: ["properties", name],
            fix: `Use one of: ${prop.options.join(", ")}.`,
          },
        };
      }
      return { ok: true, value: { [type]: { name: optionName } } };
    }
    case "multi_select": {
      const list = Array.isArray(value) ? value : [value];
      const names: { name: string }[] = [];
      for (const item of list) {
        if (typeof item === "string") names.push({ name: item });
        else if (isPlainObject(item) && typeof item.name === "string") names.push({ name: item.name });
        else return mismatch(name, type, value);
      }
      return { ok: true, value: { multi_select: names } };
    }
    case "date": {
      if (typeof value === "string") return { ok: true, value: { date: { start: value } } };
      if (isPlainObject(value) && typeof value.start === "string") return { ok: true, value: { date: value } };
      return mismatch(name, type, value);
    }
    case "checkbox": {
      if (typeof value === "boolean") return { ok: true, value: { checkbox: value } };
      if (value === "true" || value === "false") return { ok: true, value: { checkbox: value === "true" } };
      return mismatch(name, type, value);
    }
    case "url":
    case "email":
    case "phone_number": {
      if (typeof value === "string") return { ok: true, value: { [type]: value } };
      return mismatch(name, type, value);
    }
    case "people": {
      const list = ids(value);
      if (!list) return mismatch(name, type, value);
      return { ok: true, value: { people: list.map((id) => ({ object: "user", id })) } };
    }
    case "relation": {
      const list = ids(value);
      if (!list) return mismatch(name, type, value);
      return { ok: true, value: { relation: list.map((id) => ({ id })) } };
    }
    case "files": {
      const list = Array.isArray(value) ? value : [value];
      const files: Record<string, unknown>[] = [];
      for (const item of list) {
        const entry = fileEntry(item);
        if (!entry) return mismatch(name, type, value);
        files.push(entry);
      }
      return { ok: true, value: { files } };
    }
    default:
      if (READ_ONLY_TYPES.has(type)) {
        return {
          ok: false,
          error: {
            code: "property_read_only",
            message: `Property "${name}" is a ${type} property, which the API cannot write.`,
            path: ["properties", name],
            fix: `Drop "${name}" from properties; ${type} values are computed by Notion.`,
          },
        };
      }
      return mismatch(name, type, value);
  }
}

function titlePropertyName(schema: DataSourceSchema | undefined): string | undefined {
  if (!schema) return undefined;
  return Object.keys(schema).find((k) => schema[k].type === "title");
}

/**
 * Resolve every property in `properties` against `schema`.
 *
 * - typed values pass through under their given name;
 * - plain values are coerced by the property's type;
 * - `title` addresses the title property whatever it is called;
 * - a name that differs only in case from one property is corrected, with a warning;
 * - anything else is an `unknown_property` error listing the valid names.
 *
 * With `schema` undefined (the page is not a database row) only `title` and
 * typed values are accepted.
 */
export function coerceProperties(
  properties: Record<string, unknown>,
  schema: DataSourceSchema | undefined
): CoerceResult {
  const out: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const [name, value] of Object.entries(properties)) {
    if (isTitleShorthand(name, value)) {
      out[titlePropertyName(schema) ?? "title"] = { title: text(value as string) };
      continue;
    }
    if (!schema) {
      if (isTypedValue(value)) {
        out[name] = value;
        continue;
      }
      return {
        ok: false,
        error: {
          code: "not_a_database_page",
          message: `Property "${name}" was given a plain value, but the page is not a database row, so its type is unknown.`,
          path: ["properties", name],
          fix: 'Plain values work for rows of a data source. For other pages pass the typed value, e.g. { rich_text: [{ type: "text", text: { content: "…" } }] }, or use `title`.',
        },
      };
    }

    let resolved = name;
    let prop: PropertySchema | undefined = schema[name];
    if (!prop && name === "title") {
      const titleName = titlePropertyName(schema);
      if (titleName) {
        resolved = titleName;
        prop = schema[titleName];
      }
    }
    if (!prop) {
      const matches = Object.keys(schema).filter((k) => k.toLowerCase() === name.toLowerCase());
      if (matches.length === 1) {
        resolved = matches[0];
        prop = schema[resolved];
        warnings.push(`Property "${name}" was read as "${resolved}" (names are case-sensitive).`);
      }
    }
    if (!prop) {
      if (isTypedValue(value)) {
        // Let Notion decide; it knows about properties added a moment ago.
        out[name] = value;
        continue;
      }
      return {
        ok: false,
        error: {
          code: "unknown_property",
          message: `The data source has no property "${name}".`,
          path: ["properties", name],
          fix: `Use one of: ${Object.keys(schema).join(", ")}.`,
        },
      };
    }

    const coerced = coerceValue(resolved, value, prop);
    if (!coerced.ok) return coerced;
    out[resolved] = coerced.value;
  }

  return { ok: true, properties: out, warnings };
}
