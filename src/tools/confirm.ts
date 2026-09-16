import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { isFullBlock, isFullDatabase, isFullDataSource, isFullPage } from "@notionhq/client";
import { getOperation } from "../operations/registry.js";
import {
  CONFIRM_DESTRUCTIVE_ENV_VAR,
  confirmDestructiveEnabled,
  isOperationAllowed,
} from "../operations/access.js";
import type { OperationDef, OperationDomain, OperationError } from "../operations/types.js";
import { getClient } from "../services/notion.js";
import { extractBlockText, extractRichText, extractTitle } from "../utils/slim.js";
import { callDigest, requestStateCodec, type ConfirmState } from "../server/request-state.js";
import { isModernRequest } from "../utils/mcp-era.js";

// Opt-in confirmation of destructive operations (NOTION_CONFIRM_DESTRUCTIVE).
//
// Before notion_write dispatches an operation the registry marks
// `destructive: true`, the server asks the human and only proceeds on an
// explicit yes. The prompt names the operation and its target — with the
// title when one cheap retrieve can fetch it — so the user knows what they
// are approving, and a "no" comes back to the model as a
// confirmation_declined error it must not retry.
//
// The question is asked the 2026-07-28 way (multi-round-trip, SEP-2322): the
// tool call returns an `input_required` result carrying one elicitation and
// a sealed `requestState`; the client shows the dialog and retries the same
// call with the answer, and this handler runs again from the top with
// `ctx.mcpReq.inputResponses` filled in. A 2025-era client never sees any of
// that: the SDK's legacy shim turns the return into a real
// `elicitation/create` request on the connection and re-enters the handler
// itself, so both eras run this one code path.

/** How long one title lookup may take before the prompt goes out without it. */
const LOOKUP_TIMEOUT_MS = 5_000;
/** Ids listed in a batch prompt before the rest collapse into "and N more". */
const MAX_LISTED_IDS = 5;
const MAX_TITLE_CHARS = 80;
/** Key of the one input request a confirmation round carries. */
const CONFIRM_KEY = "confirm";

type TargetKind = "page" | "database" | "data source" | "block" | "comment" | "view";

const KIND_BY_DOMAIN: Partial<Record<OperationDomain, TargetKind>> = {
  pages: "page",
  databases: "database",
  data_sources: "data source",
  blocks: "block",
  comments: "comment",
  views: "view",
};

const ID_FIELDS = [
  "page_id",
  "database_id",
  "data_source_id",
  "block_id",
  "comment_id",
  "view_id",
] as const;

type Target = { kind: TargetKind; id: string };

/** What a call would remove: the targets, and how many candidates were looked at. */
type Plan = {
  form: "single" | "batch" | "mixed";
  targets: Target[];
  /** Items in a batch, or operations in batch_mixed_blocks. */
  total: number;
};

/**
 * Ask the user to confirm `operation` if the flag is on and the call is
 * destructive. Resolves to `null` when dispatch may go ahead (flag off,
 * non-destructive call, restore, or the user said yes), to an
 * `input_required` result when the question has to go out first, and to an
 * error envelope otherwise.
 */
export async function confirmDestructiveCall(
  server: McpServer,
  ctx: ServerContext,
  operation: string,
  payload: unknown
): Promise<OperationError | InputRequiredResult | null> {
  if (!confirmDestructiveEnabled()) return null;
  const def = getOperation(operation);
  if (!def?.destructive) return null;
  // Access checks come first: a blocked operation is rejected by dispatch
  // with operation_not_allowed, and the user should not be asked about it.
  if (!isOperationAllowed(operation)) return null;

  // Second round: the answer is in. The state was verified (HMAC, TTL, bound
  // to tools/call) before this handler ran; what is left to check is that it
  // was minted for *this* call.
  const state = ctx.mcpReq.requestState<ConfirmState>();
  const responses = ctx.mcpReq.inputResponses;
  if (state !== undefined || responses !== undefined) {
    return answered(state, responses, callDigest(operation, payload));
  }

  const plan = planFor(def, payload);
  if (!plan || plan.targets.length === 0) return null;

  const digest = callDigest(operation, payload);
  const target = await describeTargets(plan);
  const subject = `run ${def.name} on ${target}`;

  if (!supportsFormElicitation(server, ctx)) {
    return {
      code: "confirmation_unavailable",
      message: `${CONFIRM_DESTRUCTIVE_ENV_VAR} is on but this MCP client does not support elicitation, so ${def.name} cannot be confirmed.`,
      fix: `Use a client that supports elicitation, unset ${CONFIRM_DESTRUCTIVE_ENV_VAR}, or block destructive operations outright with NOTION_BLOCKED_OPERATIONS=destructive.`,
    };
  }

  return inputRequired({
    inputRequests: {
      [CONFIRM_KEY]: inputRequired.elicit({
        message: promptMessage(def, plan, target),
        // No fields: the client shows the message with a plain
        // accept/decline, and accepting *is* the yes. A boolean field here
        // asks the same question twice — clients render it as a checkbox,
        // and an approval given without also ticking it comes back as
        // `confirm: false`, reading the user's yes as a no.
        requestedSchema: { type: "object", properties: {} },
      }),
    },
    // Sealed: the retry has to echo it, and it names the call it was minted
    // for. `subject` rides along so the declined message can name the target
    // without a second lookup.
    requestState: await requestStateCodec.mint({ kind: "confirm", digest, subject }, ctx),
  });
}

/**
 * Can this client show the dialog? On 2026-07-28 the answer travels with the
 * request (`io.modelcontextprotocol/clientCapabilities` in the envelope; the
 * SDK does not copy it onto the server on every serving path, so it is read
 * from there); before that it was declared once at `initialize`, which the
 * SDK keeps on the server.
 */
function supportsFormElicitation(server: McpServer, ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = (
    isModernRequest(ctx)
      ? envelope?.[CLIENT_CAPABILITIES_META_KEY]
      : server.server.getClientCapabilities()
  ) as ClientCapabilities | undefined;
  const elicitation = capabilities?.elicitation;
  if (!elicitation || typeof elicitation !== "object") return false;
  // A bare `elicitation: {}` is the 2025-06-18 spelling of form support.
  return "form" in elicitation || Object.keys(elicitation).length === 0;
}

/** The retried call: did the user say yes, and to this call? */
function answered(
  state: ConfirmState | undefined,
  responses: Record<string, unknown> | undefined,
  digest: string
): OperationError | null {
  if (!state || state.kind !== "confirm") {
    return {
      code: "confirmation_mismatch",
      message:
        "The answer came back without the sealed requestState that was issued with the question, so nothing ran.",
      fix: "Call again without inputResponses and requestState to be asked afresh.",
    };
  }
  if (state.digest !== digest) {
    return {
      code: "confirmation_mismatch",
      message:
        "The confirmation that came back was minted for a different call, so nothing ran.",
      fix: "Call again without inputResponses and requestState to be asked afresh.",
    };
  }
  if (responses === undefined) {
    return declined(
      `The retry carried the confirmation state but no answer, so the request to ${state.subject} was treated as declined.`
    );
  }
  // Accepting the dialog is the yes; declining, cancelling, or an answer
  // that is not an elicitation at all are the no. Nothing is read out of
  // `content` — the form has no fields to fill in.
  const answer = inputResponse(responses, CONFIRM_KEY);
  if (answer.kind === "elicit" && answer.action === "accept") return null;
  return declined(`The user declined to ${state.subject}.`);
}

function declined(message: string): OperationError {
  return {
    code: "confirmation_declined",
    message,
    fix: "Do not retry this call. Ask the user what they want instead.",
  };
}

// ── What does this call remove? ────────────────────────────────────────────

function planFor(def: OperationDef, payload: unknown): Plan | null {
  if (!isRecord(payload)) return null;

  if (def.name === "batch_mixed_blocks") {
    // Its own envelope: appends and updates alone are not destructive; only
    // a delete entry earns the prompt.
    const parsed = def.schema.safeParse(payload);
    if (!parsed.success || !isRecord(parsed.data)) return null;
    const operations = parsed.data.operations;
    if (!Array.isArray(operations)) return null;
    const targets: Target[] = [];
    for (const op of operations) {
      if (isRecord(op) && op.op === "delete" && typeof op.block_id === "string") {
        targets.push({ kind: "block", id: op.block_id });
      }
    }
    return { form: "mixed", targets, total: operations.length };
  }

  const kind = KIND_BY_DOMAIN[def.domain];
  if (!kind) return null;

  if (Array.isArray(payload.items)) {
    const targets: Target[] = [];
    for (const item of payload.items) {
      const target = targetOf(def, kind, item);
      if (target) targets.push(target);
    }
    return { form: "batch", targets, total: payload.items.length };
  }

  const target = targetOf(def, kind, payload);
  return target ? { form: "single", targets: [target], total: 1 } : null;
}

/**
 * The target of one item, or null when the item is not destructive: it fails
 * validation (dispatch reports that, nothing runs) or it is a restore.
 * Parsing through the operation's own schema also turns a pasted Notion URL
 * into the id the lookup needs.
 */
function targetOf(def: OperationDef, kind: TargetKind, item: unknown): Target | null {
  const parsed = def.schema.safeParse(item);
  if (!parsed.success || !isRecord(parsed.data)) return null;
  const data = parsed.data;
  // delete_database / delete_data_source: `in_trash` wins over the deprecated
  // `archived` alias, and either being false restores instead of trashing.
  if ((data.in_trash ?? data.archived ?? true) === false) return null;
  for (const field of ID_FIELDS) {
    const id = data[field];
    if (typeof id === "string" && id) return { kind, id };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── Wording ────────────────────────────────────────────────────────────────

function promptMessage(def: OperationDef, plan: Plan, target: string): string {
  const what = firstSentence(def.description);
  switch (plan.form) {
    case "single":
      return `Run ${def.name} on ${target}? ${what}`;
    case "batch": {
      const n = plan.targets.length;
      const count = n < plan.total ? `${n} of ${plan.total} items` : `${n} item${n === 1 ? "" : "s"}`;
      return `Run ${def.name} on ${count}: ${target}? ${what}`;
    }
    case "mixed": {
      const n = plan.targets.length;
      return `Run ${def.name}? ${n} of its ${plan.total} operations delete${n === 1 ? "s" : ""} ${target}.`;
    }
  }
}

function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s|$)/.exec(text);
  return match ? match[0] : text;
}

/** "page "Roadmap" (id)" for one target, "pages id1, id2" for several. */
async function describeTargets(plan: Plan): Promise<string> {
  const { targets } = plan;
  if (targets.length === 1) {
    const [{ kind, id }] = targets;
    const title = await lookupTitle(kind, id);
    return title ? `${kind} "${title}" (${id})` : `${kind} ${id}`;
  }
  const ids = targets.slice(0, MAX_LISTED_IDS).map((t) => t.id);
  const more = targets.length - ids.length;
  return `${targets[0].kind}s ${ids.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

// ── Title lookup ───────────────────────────────────────────────────────────

/**
 * One retrieve for the prompt, bounded by LOOKUP_TIMEOUT_MS. Any failure —
 * not found, no access, a slow API — is swallowed: the prompt then names the
 * id alone, which is still a usable question.
 */
async function lookupTitle(kind: TargetKind, id: string): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), LOOKUP_TIMEOUT_MS);
  });
  try {
    const title = await Promise.race([retrieveTitle(kind, id), timeout]);
    return title ? truncate(title.trim()) || undefined : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function retrieveTitle(kind: TargetKind, id: string): Promise<string | undefined> {
  const notion = await getClient();
  switch (kind) {
    case "page": {
      const page = await notion.pages.retrieve({ page_id: id });
      return isFullPage(page) ? extractTitle(page.properties) : undefined;
    }
    case "database": {
      const db = await notion.databases.retrieve({ database_id: id });
      return isFullDatabase(db) ? extractRichText(db.title) : undefined;
    }
    case "data source": {
      const ds = await notion.dataSources.retrieve({ data_source_id: id });
      return isFullDataSource(ds) ? extractRichText(ds.title) : undefined;
    }
    case "block": {
      const block = await notion.blocks.retrieve({ block_id: id });
      if (!isFullBlock(block)) return undefined;
      const text = extractBlockText(block);
      return text ? `${block.type}: ${text}` : block.type;
    }
    // Comments and views have no title worth a round-trip; the id will do.
    default:
      return undefined;
  }
}

function truncate(text: string): string {
  return text.length > MAX_TITLE_CHARS ? `${text.slice(0, MAX_TITLE_CHARS - 1)}…` : text;
}
