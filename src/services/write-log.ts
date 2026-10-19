import { AsyncLocalStorage } from "node:async_hooks";

// Whether a dispatched call has already changed something in Notion.
//
// Dispatch opens one log per handler call, across all its retry attempts. The
// SDK fetch adapter in notion.ts marks it when a request other than GET comes
// back 2xx. The retry policy reads it: a handler that already wrote (one
// append of batch_mixed_blocks, the create step of upload_file) would repeat
// that write if it ran again, so the call is not retried after that.
//
// No write operation sends a read as POST (search, data source query), so a
// 2xx POST, PATCH or DELETE inside a write handler is a write.

export type WriteLog = { wrote: boolean };

const storage = new AsyncLocalStorage<WriteLog>();

export function withWriteLog<T>(fn: (log: WriteLog) => Promise<T>): Promise<T> {
  const log: WriteLog = { wrote: false };
  return storage.run(log, () => fn(log));
}

export function markWrite(): void {
  const log = storage.getStore();
  if (log) log.wrote = true;
}
