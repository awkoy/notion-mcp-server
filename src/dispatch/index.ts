import { z } from "zod";
import { getOperation } from "../operations/registry.js";
import type {
  BatchItemResult,
  BatchResult,
  OperationDef,
  OperationError,
  OperationResult,
} from "../operations/types.js";
import {
  attachIdempotencyReceipt,
  beginIdempotentRequest,
  completeIdempotentRequest,
  ephemeralIndeterminateReceipt,
  isIdempotencyInfrastructureError,
  markDownstreamAttempt,
  type IdempotencyContext,
  type IdempotencyReceipt,
} from "./idempotency.js";
import { mapWithConcurrency } from "./concurrency.js";
import { rateLimiter } from "./rate-limit.js";
import { isRetryableErrorCode, withRetry } from "./retry.js";
import { buildValidationError } from "../utils/learning-error.js";
import { toErrorEnvelope } from "../utils/error.js";
import {
  isOperationAllowed,
  operationNotAllowedError,
  enabledOperationNames,
} from "../operations/access.js";

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;

type RawPayload = unknown;

type BatchPayload = {
  items: unknown[];
  atomic?: boolean;
  idempotency_key?: string;
  concurrency?: number;
};

type IdempotencyFailure = {
  ok: false;
  error: OperationError;
  idempotency_receipt: IdempotencyReceipt;
};

type DispatchResult = OperationResult | BatchResult | IdempotencyFailure;

function isBatchPayload(payload: RawPayload): payload is BatchPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as BatchPayload).items)
  );
}

function unknownOperationError(name: string): OperationError {
  return {
    code: "unknown_operation",
    message: `Unknown operation: "${name}". Use notion_describe with a valid operation name, or check the notion://operations resource for the available list.`,
    fix: `Available operations: ${enabledOperationNames().join(", ")}`,
  };
}

export async function dispatch(
  operationName: string,
  payload: RawPayload
): Promise<DispatchResult> {
  const def = getOperation(operationName);
  if (!def) {
    return { ok: false, error: unknownOperationError(operationName) };
  }

  if (!isOperationAllowed(operationName)) {
    return { ok: false, error: operationNotAllowedError(operationName) };
  }

  if (isBatchPayload(payload)) {
    if (!def.batchable) {
      // batch_mixed_blocks looks batch-shaped but uses its own `operations[]`
      // envelope (mixed op kinds, no per-item rollback). Point callers at the
      // right shape instead of the generic not_batchable message.
      if (operationName === "batch_mixed_blocks") {
        return {
          ok: false,
          error: {
            code: "wrong_envelope",
            message:
              'batch_mixed_blocks uses its own envelope: { operations: [{ op: "append"|"update"|"delete", ... }] }. The universal { items: [...] } envelope does not apply here.',
            fix: 'Wrap your operations as { operations: [{ op: "append", block_id, markdown }, { op: "update", ... }, { op: "delete", ... }] }. Or use the items[] form on append_blocks / update_block / delete_block for single-kind batches.',
          },
        };
      }
      return {
        ok: false,
        error: {
          code: "not_batchable",
          message: `Operation "${operationName}" does not support batch mode.`,
          fix: "Call it with a single payload object instead of { items: [...] }.",
        },
      };
    }
    return runBatch(def, payload);
  }

  return runSingle(def, payload);
}

// Run the handler under the shared rate limiter, retrying on transient SDK
// failures. Token is acquired inside withRetry so each retry attempt counts
// against the per-second budget instead of bursting on retry storms.
function runHandlerWithLimitAndRetry(
  def: OperationDef,
  params: unknown
): Promise<OperationResult> {
  return withRetry(
    async () => {
      await rateLimiter.acquire();
      return def.handler(params);
    },
    { isRetryableResult: (r) => r.ok === false && isRetryableErrorCode(r.error.code) }
  );
}

async function runSingle(
  def: OperationDef,
  payload: RawPayload
): Promise<OperationResult> {
  const parsed = def.schema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: buildValidationError(def, parsed.error) };
  }
  try {
    return await runHandlerWithLimitAndRetry(def, parsed.data);
  } catch (error) {
    return { ok: false, error: toErrorEnvelope(error) };
  }
}

async function runBatch(
  def: OperationDef,
  payload: BatchPayload
): Promise<OperationResult | BatchResult | IdempotencyFailure> {
  const idempotencyKey = payload.idempotency_key;
  let idempotencyContext: IdempotencyContext | undefined;
  if (idempotencyKey !== undefined) {
    if (typeof idempotencyKey !== "string" || !idempotencyKey.trim() || idempotencyKey.length > 256) {
      return {
        ok: false,
        error: {
          code: "invalid_idempotency_key",
          message: "idempotency_key must be a non-empty string of at most 256 characters.",
          fix: "Provide a stable, non-secret key for this batch request.",
        },
      };
    }
    try {
      const admission = await beginIdempotentRequest(def.name, payload, idempotencyKey);
      if (admission.action === "deduplicated") {
        return attachIdempotencyReceipt(
          admission.stored_result as BatchResult,
          admission.receipt
        );
      }
      if (admission.action === "accepted") {
        idempotencyContext = admission.context;
      } else {
        return attachIdempotencyReceipt(
          { ok: false, error: admission.error },
          admission.receipt
        );
      }
    } catch (error) {
      return indeterminateResult(def.name, payload, error);
    }
  }

  const atomic = payload.atomic === true;
  // Atomic mode requires serial execution: with concurrency > 1, the `aborted`
  // flag is set only after the first failure resolves, but other workers have
  // already started in-flight requests, so later items execute when they
  // shouldn't. Force concurrency=1 to make the abort barrier reliable.
  const requested = payload.concurrency ?? DEFAULT_CONCURRENCY;
  const concurrency =
    atomic || idempotencyContext
      ? 1
      : Math.max(1, Math.min(requested, MAX_CONCURRENCY));
  const items = payload.items;
  const createdForRollback: { item: BatchItemResult }[] = [];

  let aborted = false;
  let results: BatchItemResult[];
  try {
    results = await mapWithConcurrency(items, concurrency, async (item, index) => {
      if (aborted) {
        return {
          index,
          ok: false as const,
          error: {
            code: "aborted",
            message: "Skipped: a prior item failed in atomic batch.",
          },
        };
      }

      const parsed = def.schema.safeParse(item);
      if (!parsed.success) {
        const failure: BatchItemResult = {
          index,
          ok: false,
          error: buildValidationError(def, parsed.error),
        };
        if (atomic) aborted = true;
        return failure;
      }

      try {
        if (idempotencyContext) await markDownstreamAttempt(idempotencyContext);
        const result = await runHandlerWithLimitAndRetry(def, parsed.data);
        if (result.ok) {
          const success: BatchItemResult = { index, ok: true, data: result.data };
          if (atomic && def.rollback) createdForRollback.push({ item: success });
          return success;
        }
        const failure: BatchItemResult = {
          index,
          ok: false,
          error: result.error,
        };
        if (atomic) aborted = true;
        return failure;
      } catch (error) {
        if (isIdempotencyInfrastructureError(error)) throw error;
        const failure: BatchItemResult = {
          index,
          ok: false,
          error: toErrorEnvelope(error),
        };
        if (atomic) aborted = true;
        return failure;
      }
    });
  } catch (error) {
    if (idempotencyContext && isIdempotencyInfrastructureError(error)) {
      return indeterminateResult(def.name, payload, error, idempotencyContext);
    }
    throw error;
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  let rolledBack: number | undefined;
  if (atomic && failed > 0 && def.rollback && createdForRollback.length > 0) {
    rolledBack = 0;
    for (const { item } of createdForRollback) {
      if (!item.ok) continue;
      try {
        if (idempotencyContext) await markDownstreamAttempt(idempotencyContext);
        await def.rollback(item.data);
        rolledBack++;
      } catch (error) {
        if (idempotencyContext && isIdempotencyInfrastructureError(error)) {
          return indeterminateResult(def.name, payload, error, idempotencyContext);
        }
        // best-effort: swallow rollback errors so we still return the original failure
      }
    }
  }

  const batchResult: BatchResult = {
    ok: failed === 0,
    summary: { total: results.length, succeeded, failed },
    results,
    ...(rolledBack !== undefined ? { rolled_back: rolledBack } : {}),
  };

  if (!idempotencyContext) return batchResult;
  try {
    const receipt = await completeIdempotentRequest(idempotencyContext, batchResult);
    return attachIdempotencyReceipt(batchResult, receipt);
  } catch (error) {
    return indeterminateResult(def.name, payload, error, idempotencyContext);
  }
}

function indeterminateResult(
  operation: string,
  payload: unknown,
  error: unknown,
  context?: Partial<IdempotencyContext>
): IdempotencyFailure {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "idempotency_indeterminate";
  const reason = error instanceof Error ? error.message : "idempotency infrastructure failure";
  const receipt = ephemeralIndeterminateReceipt(operation, payload, reason, context);
  return attachIdempotencyReceipt(
    {
      ok: false,
      error: {
        code,
        message: "The mutation outcome cannot be safely finalized in the durable idempotency ledger.",
        fix: "Do not retry automatically. Reconcile authoritative Notion state before using a new explicitly authorized key.",
      },
    },
    receipt
  );
}

export const BATCH_ENVELOPE_HELP = `Batch mode: pass { items: [...], atomic?: boolean, idempotency_key?: string, concurrency?: 1-10 }. Each item is validated independently; failures are reported per-item. atomic:true forces serial execution (concurrency=1) and triggers best-effort rollback of created entities on first failure. idempotency_key durably binds the operation and canonical payload, deduplicates identical replays, rejects conflicting reuse, and blocks pending or indeterminate automatic replay.`;

export const _internal = { isBatchPayload };

// Re-export Zod for downstream operation files to share a single version
export { z };
