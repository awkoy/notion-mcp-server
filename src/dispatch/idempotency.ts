import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LEDGER_VERSION = 1;
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 2048;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;
const ENFORCING_LAYER = "notion-mcp-server:dispatch-v1";

type LedgerState = "pending" | "completed";

type LedgerEntry = {
  receipt_id: string;
  operation: string;
  key_hash: string;
  request_fingerprint: string;
  state: LedgerState;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  submitted_attempt_count: number;
  downstream_write_count: number;
  stored_result?: unknown;
  effect_identifiers?: string[];
};

type Ledger = {
  version: number;
  salt: string;
  entries: Record<string, LedgerEntry>;
};

export type IdempotencyDecision =
  | "accepted"
  | "deduplicated"
  | "rejected"
  | "indeterminate";

export type IdempotencyReceipt = {
  receipt_id: string;
  decision: IdempotencyDecision;
  operation: string;
  key_hash: string;
  request_fingerprint: string;
  state: LedgerState | "indeterminate";
  submitted_attempt_count: number;
  downstream_write_count: number;
  effect_identifiers: string[];
  enforcing_layer: string;
  replay_of?: string;
  reason?: string;
};

export type IdempotencyContext = {
  entry_key: string;
  receipt_id: string;
  operation: string;
  key_hash: string;
  request_fingerprint: string;
};

type Admission =
  | { action: "accepted"; context: IdempotencyContext }
  | {
      action: "deduplicated";
      receipt: IdempotencyReceipt;
      stored_result: unknown;
    }
  | {
      action: "rejected" | "indeterminate";
      receipt: IdempotencyReceipt;
      error: { code: string; message: string; fix: string };
    };

let mutationQueue = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function statePath(): string {
  return (
    process.env.NOTION_IDEMPOTENCY_STATE_PATH ||
    join(homedir(), ".notion-mcp-server", "idempotency-ledger.json")
  );
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestFingerprint(operation: string, payload: unknown): string {
  return sha256(stableJson({ operation, payload }));
}

function newLedger(): Ledger {
  return {
    version: LEDGER_VERSION,
    salt: randomBytes(32).toString("hex"),
    entries: {},
  };
}

function isLedger(value: unknown): value is Ledger {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Ledger>;
  return (
    candidate.version === LEDGER_VERSION &&
    typeof candidate.salt === "string" &&
    candidate.salt.length >= 32 &&
    !!candidate.entries &&
    typeof candidate.entries === "object" &&
    !Array.isArray(candidate.entries)
  );
}

function infrastructureError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function readLedgerCandidate(path: string): Promise<Ledger | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isLedger(parsed) ? parsed : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return null;
  }
}

async function loadLedger(path: string): Promise<Ledger> {
  const canonical = await readLedgerCandidate(path);
  if (canonical) return canonical;

  const recoveryPath = `${path}.tmp`;
  const recovery = await readLedgerCandidate(recoveryPath);
  if (recovery) {
    await rm(path, { force: true });
    await rename(recoveryPath, path);
    return recovery;
  }

  try {
    await stat(path);
    throw infrastructureError(
      "idempotency_ledger_corrupt",
      `The idempotency ledger is invalid: ${path}`
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return newLedger();
}

async function atomicWriteLedger(path: string, ledger: Ledger): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });

  const handle = await open(temporaryPath, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(ledger)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporaryPath, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EACCES", "EEXIST", "EPERM"].includes(code)) throw error;
    await rm(path, { force: true });
    await rename(temporaryPath, path);
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function staleLock(lockPath: string): Promise<boolean> {
  try {
    const [metadata, raw] = await Promise.all([
      stat(lockPath),
      readFile(lockPath, "utf8").catch(() => ""),
    ]);
    const pid = Number(raw.trim());
    if (Date.now() - metadata.mtimeMs > LOCK_STALE_MS) return true;
    return Number.isSafeInteger(pid) && pid > 0 && !isProcessAlive(pid);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  await mkdir(dirname(path), { recursive: true });

  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(String(process.pid), "utf8");
      await handle.sync();
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await staleLock(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      await sleep(40);
    }
  }
  throw infrastructureError(
    "idempotency_lock_timeout",
    `Timed out waiting for the idempotency ledger lock: ${lockPath}`
  );
}

function pruneLedger(ledger: Ledger): void {
  const ttl = positiveInteger(process.env.NOTION_IDEMPOTENCY_TTL_MS, DEFAULT_TTL_MS);
  const maxEntries = positiveInteger(
    process.env.NOTION_IDEMPOTENCY_MAX_ENTRIES,
    DEFAULT_MAX_ENTRIES
  );
  const cutoff = Date.now() - ttl;
  const completed = Object.entries(ledger.entries)
    .filter(([, entry]) => entry.state === "completed")
    .sort(([, a], [, b]) => Date.parse(a.updated_at) - Date.parse(b.updated_at));

  for (const [key, entry] of completed) {
    if (Date.parse(entry.updated_at) < cutoff) delete ledger.entries[key];
  }

  const remainingCompleted = Object.entries(ledger.entries)
    .filter(([, entry]) => entry.state === "completed")
    .sort(([, a], [, b]) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
  const overflow = Math.max(0, remainingCompleted.length - maxEntries);
  for (const [key] of remainingCompleted.slice(0, overflow)) delete ledger.entries[key];
}

async function withLedgerMutation<T>(mutator: (ledger: Ledger) => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const path = statePath();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireLock(path);
      const ledger = await loadLedger(path);
      pruneLedger(ledger);
      const value = await mutator(ledger);
      await atomicWriteLedger(path, ledger);
      return value;
    } finally {
      await release?.();
    }
  };

  const task = mutationQueue.then(run, run);
  mutationQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

const SENSITIVE_KEY =
  /(token|secret|authorization|cookie|password|credential|signed|content|markdown|rich_text|plain_text|caption|title|name|url|href)/i;
const SAFE_LITERAL_STRING_KEY = /^(code|type|object|status|state|decision|operation)$/i;
const SAFE_IDENTIFIER_KEY =
  /^(id|ids|page_id|block_id|database_id|data_source_id|receipt_id|replay_of)$/i;
const SAFE_IDENTIFIER_VALUE =
  /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTIFIER_VALUE.test(value);
}

function sanitizeResult(value: unknown, key = ""): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (SAFE_LITERAL_STRING_KEY.test(key)) return value;
    if (SAFE_IDENTIFIER_KEY.test(key) && isSafeIdentifier(value)) return value;
    return undefined;
  }
  if (Array.isArray(value)) {
    const sanitized = value
      .map((item) => sanitizeResult(item, key))
      .filter((item) => item !== undefined);
    return sanitized;
  }
  if (!value || typeof value !== "object") return undefined;

  const sanitized: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(childKey)) continue;
    const child = sanitizeResult(childValue, childKey);
    if (child !== undefined) sanitized[childKey] = child;
  }
  return sanitized;
}

function collectEffectIdentifiers(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectEffectIdentifiers(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SAFE_IDENTIFIER_KEY.test(key) && isSafeIdentifier(child)) output.add(child);
    collectEffectIdentifiers(child, output);
  }
  return output;
}

function receiptFrom(
  entry: LedgerEntry,
  decision: IdempotencyDecision,
  replayOf?: string,
  reason?: string
): IdempotencyReceipt {
  return {
    receipt_id: entry.receipt_id,
    decision,
    operation: entry.operation,
    key_hash: entry.key_hash.slice(0, 16),
    request_fingerprint: entry.request_fingerprint,
    state: decision === "indeterminate" ? "indeterminate" : entry.state,
    submitted_attempt_count: entry.submitted_attempt_count,
    downstream_write_count: entry.downstream_write_count,
    effect_identifiers: entry.effect_identifiers ?? [],
    enforcing_layer: ENFORCING_LAYER,
    ...(replayOf ? { replay_of: replayOf } : {}),
    ...(reason ? { reason } : {}),
  };
}

export async function beginIdempotentRequest(
  operation: string,
  payload: unknown,
  rawKey: string
): Promise<Admission> {
  return withLedgerMutation(async (ledger) => {
    const keyHash = sha256(`${ledger.salt}\0${operation}\0${rawKey}`);
    const entryKey = `${operation}::${keyHash}`;
    const fingerprint = requestFingerprint(operation, payload);
    const existing = ledger.entries[entryKey];

    if (existing) {
      existing.submitted_attempt_count++;
      existing.updated_at = new Date().toISOString();
      if (existing.request_fingerprint !== fingerprint) {
        return {
          action: "rejected",
          receipt: receiptFrom(existing, "rejected"),
          error: {
            code: "idempotency_conflict",
            message: "This idempotency key was already used with a different payload.",
            fix: "Use the original payload, or use a new explicitly authorized idempotency key.",
          },
        };
      }
      if (existing.state === "completed") {
        return {
          action: "deduplicated",
          receipt: receiptFrom(existing, "deduplicated", existing.receipt_id),
          stored_result: existing.stored_result,
        };
      }
      return {
        action: "indeterminate",
        receipt: receiptFrom(
          existing,
          "indeterminate",
          existing.receipt_id,
          "A prior attempt is still pending."
        ),
        error: {
          code: "idempotency_indeterminate",
          message: "A prior attempt may have reached Notion, so automatic replay is blocked.",
          fix: "Reconcile authoritative Notion state before using a new explicitly authorized key.",
        },
      };
    }

    const now = new Date().toISOString();
    const entry: LedgerEntry = {
      receipt_id: randomUUID(),
      operation,
      key_hash: keyHash,
      request_fingerprint: fingerprint,
      state: "pending",
      created_at: now,
      updated_at: now,
      submitted_attempt_count: 1,
      downstream_write_count: 0,
    };
    ledger.entries[entryKey] = entry;
    return {
      action: "accepted",
      context: {
        entry_key: entryKey,
        receipt_id: entry.receipt_id,
        operation,
        key_hash: keyHash,
        request_fingerprint: fingerprint,
      },
    };
  });
}

export async function markDownstreamAttempt(context: IdempotencyContext): Promise<void> {
  await withLedgerMutation(async (ledger) => {
    const entry = ledger.entries[context.entry_key];
    if (!entry || entry.receipt_id !== context.receipt_id || entry.state !== "pending") {
      throw infrastructureError(
        "idempotency_context_invalid",
        "The durable idempotency context is missing or no longer pending."
      );
    }
    entry.downstream_write_count++;
    entry.updated_at = new Date().toISOString();
  });
}

export async function completeIdempotentRequest(
  context: IdempotencyContext,
  result: unknown
): Promise<IdempotencyReceipt> {
  return withLedgerMutation(async (ledger) => {
    const entry = ledger.entries[context.entry_key];
    if (!entry || entry.receipt_id !== context.receipt_id || entry.state !== "pending") {
      throw infrastructureError(
        "idempotency_context_invalid",
        "The durable idempotency context is missing or no longer pending."
      );
    }
    const sanitized = sanitizeResult(result);
    entry.stored_result = sanitized;
    entry.effect_identifiers = [...collectEffectIdentifiers(sanitized)];
    entry.state = "completed";
    entry.completed_at = new Date().toISOString();
    entry.updated_at = entry.completed_at;
    return receiptFrom(entry, "accepted");
  });
}

export function attachIdempotencyReceipt<T extends object>(
  result: T,
  receipt: IdempotencyReceipt
): T & { idempotency_receipt: IdempotencyReceipt } {
  return { ...result, idempotency_receipt: receipt };
}

export function ephemeralIndeterminateReceipt(
  operation: string,
  payload: unknown,
  reason: string,
  context?: Partial<IdempotencyContext>
): IdempotencyReceipt {
  return {
    receipt_id: context?.receipt_id ?? randomUUID(),
    decision: "indeterminate",
    operation,
    key_hash: context?.key_hash?.slice(0, 16) ?? "unavailable",
    request_fingerprint:
      context?.request_fingerprint ?? requestFingerprint(operation, payload),
    state: "indeterminate",
    submitted_attempt_count: 1,
    downstream_write_count: 0,
    effect_identifiers: [],
    enforcing_layer: ENFORCING_LAYER,
    reason,
  };
}

export function isIdempotencyInfrastructureError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code.startsWith("idempotency_")
  );
}
