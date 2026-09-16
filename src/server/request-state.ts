import { createHash, randomBytes } from "node:crypto";
import { createRequestStateCodec, type ServerContext } from "@modelcontextprotocol/server";
import { stableStringify } from "../utils/stable-json.js";

// Multi-round-trip (MRTR) `requestState` for the destructive-operation
// confirmation (protocol revision 2026-07-28, SEP-2322).
//
// A 2026-07-28 client fulfils an `input_required` result by retrying the
// tool call with the user's answer plus the opaque `requestState` we handed
// out. That string comes back through the client, so it is attacker-controlled
// on return: the codec seals it with an HMAC and a TTL, and the handler
// checks that the sealed digest matches the call it is about to run — a
// "yes" to archiving page X cannot be replayed to archive page Y.
//
// The key is random per process. Confirmations therefore do not survive a
// restart (the retry is answered "invalid or expired", and the client asks
// again), and several HTTP replicas behind one load balancer would need a
// shared key — a follow-up if anyone runs that topology.

/** How long the user gets to answer, matching the pre-MRTR elicitation timeout. */
export const CONFIRM_TTL_SECONDS = 5 * 60;

/**
 * Slack between the answer window and the sealed state's expiry. On the
 * 2025-era path the SDK shim verifies the state *after* the elicitation
 * answer arrives, so an answer given right at the end of the window would
 * otherwise meet an already-expired state and be rejected instead of applied.
 */
const STATE_GRACE_SECONDS = 30;

/** What a minted confirmation state carries; sealed, so `subject` can be echoed. */
export type ConfirmState = {
  kind: "confirm";
  /** `callDigest(operation, payload)` of the call the user was asked about. */
  digest: string;
  /** "run archive_page on page "Roadmap" (p-1)" — for the declined message. */
  subject: string;
};

export const requestStateCodec = createRequestStateCodec<ConfirmState>({
  key: randomBytes(32),
  ttlSeconds: CONFIRM_TTL_SECONDS + STATE_GRACE_SECONDS,
  // A state minted for tools/call is rejected when echoed on any other method.
  bind: (ctx: ServerContext) => ctx.mcpReq.method,
});

/** Stable digest of one call: same operation and payload → same digest, key order aside. */
export function callDigest(operation: string, payload: unknown): string {
  return createHash("sha256")
    .update(stableStringify([operation, payload]))
    .digest("hex");
}
