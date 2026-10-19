import type { Readable } from "node:stream";

/**
 * Read a stream in chunks with a running total and stop the moment it passes
 * the cap; undefined means it did. Reading it all first (arrayBuffer(),
 * readFile()) would hold the whole thing in memory before the size could be
 * checked, and a chunked response carries no content-length.
 *
 * An abort of `signal` destroys the stream, and the read rejects with the
 * signal's reason.
 */
export async function readCapped(
  body: Readable | null,
  max: number,
  signal?: AbortSignal
): Promise<Buffer | undefined> {
  if (!body) return Buffer.alloc(0);
  if (signal?.aborted) {
    body.destroy();
    throw signal.reason;
  }
  const onAbort = () => body.destroy(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > max) {
        // Returning from inside for-await also destroys the stream; doing it
        // explicitly keeps the intent visible.
        body.destroy();
        return undefined;
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
