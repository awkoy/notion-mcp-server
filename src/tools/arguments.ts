import { z } from "zod";

type ToolPayload = Record<string, unknown>;
const MAX_UNWRAP_DEPTH = 3;

function isPayloadObject(value: unknown): value is ToolPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only decode the whole payload field. Recursively parsing property strings
// would change user content that intentionally contains JSON-formatted text.
function parseEncodedPayload(value: string): ToolPayload | null {
  let current: unknown = value;
  for (let i = 0; i < MAX_UNWRAP_DEPTH; i += 1) {
    if (typeof current !== "string") return null;
    try {
      current = JSON.parse(current);
    } catch {
      return null;
    }
    if (isPayloadObject(current)) return current;
  }
  return null;
}

export const TOOL_PAYLOAD_SCHEMA = z.union([
  z.record(z.string(), z.unknown()),
  z.string().refine(
    (value) => parseEncodedPayload(value) !== null,
    "Payload string must encode a JSON object (at most three layers)."
  ),
]);

export function normalizeToolPayload(value: ToolPayload | string): ToolPayload {
  if (typeof value !== "string") return value;
  const decoded = parseEncodedPayload(value);
  if (decoded === null) throw new TypeError("Tool payload must encode a JSON object.");
  return decoded;
}
