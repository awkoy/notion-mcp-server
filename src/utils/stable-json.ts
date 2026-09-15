/**
 * Deterministic JSON text: object keys sorted, `undefined` members dropped
 * (as `JSON.stringify` drops them), so two structurally equal values always
 * produce the same string. Used wherever a value is hashed or used as a map
 * key — the confirmation digest, the schema emitter's `$ref` dedupe.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
