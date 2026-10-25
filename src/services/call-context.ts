import { AsyncLocalStorage } from "node:async_hooks";
import type { OperationAccess } from "../operations/types.js";
import { CALL_WAIT_BUDGET_MS } from "../dispatch/retry.js";

// The dispatched operation a Notion request belongs to.
//
// Dispatch opens one context per handler call. The SDK client reads it to
// decide which failed requests it may send again (PacedClient in notion.ts):
// a request made by a read operation is safe to repeat whatever its method,
// so search and data source queries (POSTs) retry on 5xx like a GET does.
// The call's requests also share one budget of retry waits (retryWait).
//
// The SDK fetch adapter marks the context when a request other than GET comes
// back 2xx. No write operation sends a read as POST (search, data source
// query), so inside a write that means something in Notion has changed; if
// the call fails after that, dispatch says the call was partly applied.

export type CallContext = {
  readonly access: OperationAccess;
  wrote: boolean;
  readonly retryWait: { remainingMs: number };
};

const storage = new AsyncLocalStorage<CallContext>();

export function withCallContext<T>(
  access: OperationAccess,
  fn: (call: CallContext) => Promise<T>
): Promise<T> {
  const call: CallContext = {
    access,
    wrote: false,
    retryWait: { remainingMs: CALL_WAIT_BUDGET_MS },
  };
  return storage.run(call, () => fn(call));
}

export function currentCall(): CallContext | undefined {
  return storage.getStore();
}

export function markWrite(): void {
  const call = storage.getStore();
  if (call) call.wrote = true;
}

// For a handler that undid what its call changed (create_page trashing a page
// it could not finish): the failure then leaves nothing to read back.
export function clearWrite(): void {
  const call = storage.getStore();
  if (call) call.wrote = false;
}
