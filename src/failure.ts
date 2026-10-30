/**
 * Classify terminal Claude turn failures so the proxy can answer with a
 * truthful HTTP status instead of a fake-200 stream that carries the error
 * as assistant text (which makes hosts retry and burn quota on doom loops).
 *
 * Mapping:
 * - auth             → 401 (non-retryable: credentials must be fixed by a human)
 * - rate_limit       → 429 + Retry-After (the gate store already knows the reset)
 * - context_overflow → 400 context_length_exceeded (OpenCode compacts the chat)
 * - image            → 400 (the same image fails the same way on retry)
 * - billing          → 402 (Anthropic moved this usage off the plan; retrying
 *                      can't change that, only the user's account settings can)
 * - account          → 403 (the subscription can't serve Claude Code: payment
 *                      past due, account on hold, access disabled by the
 *                      organization; only the user can fix it)
 * - request_too_large → 413 (the API's size limit, almost always by the
 *                      images and documents the transcript gathered; a chat
 *                      turn answers it as context_overflow, see
 *                      failureResponse in proxy.ts)
 * - refusal          → 400 refusal (Claude declined; a retry is refused too)
 * - overloaded       → 503 overloaded_error (retryable; OpenCode backs off)
 * - unknown          → 500
 *
 * The kind comes from what the SDK states outright when it does
 * (statedFailureKind), else from the text: Claude Code words one failure
 * differently from case to case (the same `oauth_org_not_allowed` read
 * "a payment is past due" live and "your organization has disabled Claude
 * subscription access" against a stub).
 */
import { isClaudeRateLimitText } from "./rate-limit.js";

export type ClaudeFailureKind =
  | "auth"
  | "rate_limit"
  | "context_overflow"
  | "image"
  | "refusal"
  | "overloaded"
  | "billing"
  | "account"
  | "request_too_large"
  | "unknown";

const AUTH_FAILURE_PATTERN =
  /invalid_grant|refresh token (not found|invalid|expired)|invalid[_ -]?api[_ -]?key|authentication_error|authentication failed|unauthorized|not logged in|not authenticated|please (run )?\/?login|oauth token (is )?(expired|invalid|revoked)|access token (is )?(expired|invalid|revoked)|credentials (are )?(expired|invalid|revoked)|token (has )?expired|\b401\b/i;

/**
 * Anthropic's and Claude Code's wordings for a conversation that no longer
 * fits the context window. Kept to phrases OpenCode's own overflow check
 * also knows (packages/ai/src/provider-error.ts).
 */
const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|exceeds the context window|context[_ ]length[_ ]exceeded|exceeds (?:the )?(?:model'?s )?maximum context length|input is too long for requested model|model_context_window_exceeded/i;

/**
 * Anthropic refusing to count this usage against the plan ("Third-party
 * apps now draw from extra usage, not plan limits"), or extra usage being
 * off or exhausted, or a 402 the CLI passed on without a code of its own
 * ("API Error: 402 …"). A billing decision on the account, not a transient
 * error.
 */
const BILLING_FAILURE_PATTERN =
  /draw from extra usage|extra usage (?:is )?(?:not enabled|disabled|required|exhausted|limit)|out of extra usage|credit balance is too low|\bAPI Error: 402\b/i;

const IMAGE_FAILURE_PATTERN =
  /could not process image|\bimage\b[^\n]*?\b(?:exceeds?|too large|could not be processed|is not valid|invalid|unsupported|not supported|dimensions)\b/i;

/** Prefix of the proxy's own text for a refusal no fallback model retried. */
const REFUSAL_PATTERN = /^Claude declined this request\b/;

/** Prefix of the proxy's own text for a 5xx the CLI reported as success. */
const OVERLOADED_PATTERN = /^Anthropic (?:is overloaded|returned 5\d\d)\b/;

export function classifyClaudeFailure(text: string): ClaudeFailureKind {
  if (!text) return "unknown";
  if (REFUSAL_PATTERN.test(text)) return "refusal";
  if (OVERLOADED_PATTERN.test(text)) return "overloaded";
  if (isClaudeRateLimitText(text)) return "rate_limit";
  if (AUTH_FAILURE_PATTERN.test(text)) return "auth";
  if (BILLING_FAILURE_PATTERN.test(text)) return "billing";
  if (CONTEXT_OVERFLOW_PATTERN.test(text)) return "context_overflow";
  if (IMAGE_FAILURE_PATTERN.test(text)) return "image";
  return "unknown";
}

/**
 * The kind the SDK states for a failed model call, or null when it states
 * none and the text has to tell. A synthetic assistant record names it in
 * `error` (SDKAssistantMessageError); an error result carries the refused
 * call's HTTP status in `api_error_status`. General codes (`invalid_request`,
 * `server_error`, `unknown`) and other statuses say nothing the text does
 * not: "Prompt is too long" under `invalid_request` is a context overflow.
 * An overload is `server_error` with status 529 (Claude Code 2.1.300 and
 * later name `overloaded` only in the `api_retry` event; the 2.1.300 probe).
 */
export function statedFailureKind(event: Record<string, unknown>): ClaudeFailureKind | null {
  switch (event.error) {
    case "rate_limit":
      return "rate_limit";
    case "authentication_failed":
    case "cloud_credential_error":
      return "auth";
    case "billing_error":
      return "billing";
    case "oauth_org_not_allowed":
    case "account_on_hold":
    case "verification_required":
      return "account";
  }
  if (event.type === "result" && event.is_error) {
    if (event.api_error_status === 401) return "auth";
    if (event.api_error_status === 402) return "billing";
    // The API's 413: the request outgrew its size limit, almost always by
    // the images and documents the transcript gathered ("Request too large
    // (max 32MB). Accumulated images and attachments …").
    if (event.api_error_status === 413) return "request_too_large";
  }
  return null;
}

export function failureStatusFor(kind: ClaudeFailureKind): number {
  switch (kind) {
    case "auth":
      return 401;
    case "rate_limit":
      return 429;
    case "context_overflow":
    case "image":
    case "refusal":
      return 400;
    case "overloaded":
      return 503;
    case "billing":
      return 402;
    case "account":
      return 403;
    case "request_too_large":
      return 413;
    default:
      return 500;
  }
}

export function failureTypeFor(kind: ClaudeFailureKind): string {
  switch (kind) {
    case "auth":
      return "authentication_error";
    case "rate_limit":
      return "rate_limit_error";
    case "context_overflow":
    case "image":
    case "refusal":
      return "invalid_request_error";
    case "billing":
      return "billing_error";
    case "account":
      return "permission_error";
    case "request_too_large":
      return "invalid_request_error";
    default:
      return "server_error";
  }
}

export function failureCodeFor(kind: ClaudeFailureKind): string {
  switch (kind) {
    case "auth":
      return "claude_auth";
    case "rate_limit":
      return "claude_session_limit";
    // The OpenAI code OpenCode reads as "compact, don't retry".
    case "context_overflow":
      return "context_length_exceeded";
    case "image":
      return "claude_image_error";
    case "billing":
      return "claude_extra_usage";
    case "account":
      return "claude_account";
    // Without the words `request_too_large`, which OpenCode reads anywhere in
    // the reply as an overflow and would cut a summary's history instead of
    // resending it without media (packages/ai/src/provider-error.ts; the
    // status 413 makes it payload-too-large, compaction.ts deliver).
    case "request_too_large":
      return "claude_payload_too_large";
    // OpenCode reads this code as a content-policy block, not a retry.
    case "refusal":
      return "refusal";
    // One of the server codes OpenCode retries with its own backoff.
    case "overloaded":
      return "overloaded_error";
    default:
      return "claude_turn_failed";
  }
}

/**
 * Error results list what went wrong in `errors`, next to internal CLI
 * diagnostics ("[ede_diagnostic] result_type=user …") that mean nothing to
 * a user.
 */
function isDiagnostic(line: string): boolean {
  return /^\[ede_diagnostic\]/i.test(line.trim());
}

/** Error text without the CLI's internal diagnostic entries. */
export function withoutDiagnostics(text: string): string {
  return text
    .split(/;\s*(?=\[ede_diagnostic\])|\n/)
    .map((part) => part.trim())
    .filter((part) => part && !isDiagnostic(part))
    .join("\n")
    .replace(/;\s*$/, "")
    .trim();
}

/** Readable cause for a result that carries no usable error text. */
function terminalReasonText(reason: unknown, subtype: unknown): string | null {
  switch (reason) {
    case "prompt_too_long":
    case "blocking_limit":
      return "Prompt is too long: the conversation exceeds the context window.";
    case "rapid_refill_breaker":
      return "The conversation exceeds the context window: it refilled right after Claude Code compacted it.";
    case "image_error":
      return "Claude could not process an image in the conversation (image error).";
    case "max_turns":
      return "Claude reached the turn limit for this request before finishing.";
    case "budget_exhausted":
      return "Claude stopped: the turn's budget was exhausted.";
    case "structured_output_retry_exhausted":
      return "Claude could not produce the requested structured output.";
    case "malformed_tool_use_exhausted":
      return "Claude gave up after repeated malformed tool calls.";
    case "tool_deferred_unavailable":
      return "Claude could not resume a deferred tool call: the tool is no longer available.";
    case "turn_setup_failed":
      return "Claude Code could not start the turn.";
    case "model_error":
      return "Claude stopped: the model returned an error.";
    case "api_error":
      return "Claude gave up after repeated Anthropic API errors.";
    case "aborted_streaming":
    case "aborted_tools":
      return "The Claude turn was interrupted.";
    case "hook_stopped":
    case "stop_hook_prevented":
      return "A Claude Code hook stopped the turn.";
  }
  switch (subtype) {
    case "error_max_turns":
      return "Claude reached the turn limit for this request before finishing.";
    case "error_max_budget_usd":
      return "Claude stopped: the turn's budget was exhausted.";
    case "error_max_structured_output_retries":
      return "Claude could not produce the requested structured output.";
  }
  return null;
}

/**
 * Failure text of an SDK result event. Error results carry `errors` and
 * `terminal_reason`, not `result`; a success-typed result flagged is_error
 * carries its text in `result`.
 */
export function resultErrorText(event: Record<string, unknown>): string {
  const listed = Array.isArray(event.errors)
    ? event.errors
        .filter((e): e is string => typeof e === "string")
        .map((e) => e.trim())
        .filter((e) => e && !isDiagnostic(e))
    : [];
  // Joined like the SDK's own iterator error, so the two dedupe.
  if (listed.length > 0) return listed.join("; ");
  if (typeof event.result === "string" && event.result.trim()) return event.result.trim();
  if (typeof event.error === "string" && event.error.trim()) return event.error.trim();
  return terminalReasonText(event.terminal_reason, event.subtype) ?? "Claude turn failed";
}

/**
 * Text of an error the SDK iterator threw. After an error result it throws
 * "Claude Code returned an error result: <errors joined>"; when those were
 * only diagnostics, null says there is nothing to add to what the result
 * event already reported.
 */
export function thrownErrorText(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : String(error);
  const prefix = /^claude code returned an error result:\s*/i;
  if (!prefix.test(raw)) return raw;
  const rest = withoutDiagnostics(raw.replace(prefix, ""));
  return rest ? `Claude Code returned an error result: ${rest}` : null;
}

/**
 * The CLI can end a turn as subtype "success" after its own API retries ran
 * out: no content, is_error false, and the last HTTP status only in
 * api_error_status (529 overloaded, or another 5xx). Returns the failure
 * text for such a result, null for a real success.
 */
export function overloadedResultText(event: Record<string, unknown>): string | null {
  if (event.type !== "result" || event.is_error) return null;
  const status = event.api_error_status;
  if (typeof status !== "number" || status < 500) return null;
  return status === 529
    ? "Anthropic is overloaded (529) and Claude Code gave up after its own retries. Try again shortly."
    : `Anthropic returned ${status} and Claude Code gave up after its own retries. Try again shortly.`;
}

/**
 * Meta requests (title, compaction summary, generate) run with maxTurns 1.
 * Claude trying a second step there is not a limit the user can act on.
 */
export function metaFailureText(text: string, metaKind: string | null | undefined): string {
  if (!metaKind || !/turn limit/i.test(text)) return text;
  const what =
    metaKind === "title"
      ? "the session title"
      : metaKind === "summary"
        ? "the compaction summary"
        : "the requested text";
  return `Claude could not write ${what} in the single step it is allowed, so nothing was generated.`;
}

/** User-facing guidance appended to hard failures. */
export function failureHintFor(kind: ClaudeFailureKind): string {
  switch (kind) {
    case "auth":
      return "Claude Code is signed out. Run `claude auth login` in a terminal, then send the message again.";
    case "rate_limit":
      return "Claude subscription limit is active; wait for the reset instead of retrying.";
    default:
      return "";
  }
}
