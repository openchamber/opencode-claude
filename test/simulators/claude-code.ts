/**
 * The Claude Code simulator: what the CLI (through the Agent SDK) does with
 * the plugin's queries, for every version of the plugin. It writes
 * transcript files of the real shape and answers with the events the CLI
 * emits. Checked against the real CLI by test/cli-contract-live.ts (on the
 * chain) and the live probes of October 2026 (the real CLI with a subscription, mostly Haiku; numbered
 * 1, 5–12, 23, 25, 29, 39, 41, 47 in the comments below). Unless a comment says otherwise, "the <topic> probe"
 * is the real CLI 2.1.312 started by the real SDK 0.3.300 against a local stub of the Messages API, a dummy key,
 * no subscription; a quoted name after it is one of its cases:
 * - transcript files: `user` records with the caller's uuid
 *   (`queueTranscriptOnly` for a record without a turn), `assistant`
 *   records, a tool result as a `user` record with `toolUseResult`, a
 *   message absorbed mid-turn as an `attachment` with its `source_uuid`; the
 *   CLI's service records on the chain (`environment`, `model`,
 *   `total_tokens_reminder`, `session_context`, `date`, `prompt_snapshot`)
 *   and its lines off the chain (`queue-operation`, `api-request…`,
 *   `tools-used`, `last-prompt`, `cost-state`, `mode`, `atis-latch`), with
 *   their contents and at their moments as CLI 2.1.312 writes them;
 * - names: `sessionId` names a new file (the chain); a query with neither
 *   `sessionId` nor `resume` gets a name the CLI makes up, reported in
 *   `init` (main); a new query on a name in use is refused; `resume` +
 *   `resumeSessionAt` only along the leaf chain (the last record written and
 *   its ancestors), else "No message found";
 * - a record whose uuid the file holds is dropped silently, and a turn
 *   whose prompt is dropped ends with no `result`;
 * - copies: `resume` + `forkSession: true` + `sessionId` (+ `resumeSessionAt`)
 *   copies the source's chain down to the point with the same uuids, then
 *   the prompt's records (the chain); two copies under one name write it all
 *   twice; main's revert through the SDK's `forkSession` is not simulated:
 *   it runs no process, and the real one copies these files;
 * - the input is read as it comes: a record without a turn is answered with
 *   an init and an empty `result` naming it before the next is taken;
 *   records without a turn already waiting together are joined into one
 *   under the last one's uuid; a plain `resume` on one is answered "No
 *   response requested." first; a blank text reaches the model as nothing;
 * - a turn parked on a tool call and interrupted: the rejected result, then
 *   "[Request interrupted by user for tool use]", then an error result;
 * - failures: the spawn fails (nothing written); an API error (`user` and an
 *   `assistant` with `isApiErrorMessage`); the process killed (`user` only);
 *   a process that was not stopped writes its answer later (zombie); a
 *   copying process killed after the file appeared, before any record.
 *
 * The CLI is a process (claude-cli.mjs, laid out by `installCli`): the
 * plugin finds it on PATH and starts it for the version, the sign-in and the
 * model list; the plugin's real starter and the real SDK start it for every
 * query, and the process carries the query to this simulator (`serve`),
 * which runs it here (`runQuery`) on what the process received.
 *
 * Nothing here imports the plugin: the world installs its starter
 * (`starter`), so the same file runs any tree (main, a preliminary branch, a
 * chain step). New behaviour a test needs goes into this file, never into a
 * copy.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { release as osRelease, tmpdir, type as osType, version as osVersion } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The plugin's in-process MCP servers as the CLI reaches them: through the SDK's control channel
 * (`mcp_message` requests), each server's tools listed once (from the manifest the SDK sent with `initialize`,
 * else by the MCP handshake), each call `tools/call` with the call's id in `_meta` (probe 43).
 */
export type McpChannel = {
  servers: string[];
  list(server: string): Promise<Array<Record<string, any>>>;
  call(server: string, name: string, args: Record<string, unknown>, toolUseId: string): Promise<{ content: Array<Record<string, any>>; isError?: boolean }>;
};

/**
 * A query as the CLI process received it (`paramsOfProcess`): its arguments read as Claude Code reads them, under
 * the SDK options' names (`model`, `resume`, `resumeSessionAt`, `sessionId`, `forkSession`, `persistSession`,
 * `settings`, `maxTurns`, `permissionMode`, `allowedTools`, `effort`, `thinking`…), its folder and environment,
 * the system prompt from `initialize`, the plugin's MCP servers by name (`mcpServers`, `mcp`), the input stream.
 */
export type QueryParams = {
  prompt: string | AsyncIterable<any>;
  resume?: string;
  resumeSessionAt?: string;
  sessionId?: string;
  forkSession?: boolean;
  persistSession?: boolean;
  mcpServers?: Record<string, any>;
  mcp?: McpChannel;
  /** The input's commands as the CLI handles them (`serve` reports them as `command_lifecycle`). */
  commands?: { read(message: any): void; taken(message: any): void; absorbed(message: any): void };
  /** The query this process runs, once it is logged (`serve` marks on it when the SDK closed the input). */
  onQuery?: (query: ClaudeQuery) => void;
  [key: string]: unknown;
};

/** One query the plugin started. */
export type ClaudeQuery = {
  kind: "chat" | "summary";
  /** The transcript (CLI session id). */
  name: string;
  /** A copy: the transcript it was copied from. */
  copiedFrom?: string;
  /** The record it resumed at, or null for a new transcript. */
  at: string | null;
  /** What the model got: the chain up to `at`, then every prompt message, as text. */
  view: string;
  /** The uuid of the record the turn ran on; undefined when none was written. */
  trigger?: string;
  /**
   * The prompt stream's messages as the CLI read them, in order (`noTurn`: `shouldQuery: false`): `readAt` when
   * the SDK took it from the plugin's stream (performance.now), `confirmedAt` when the empty result naming it came
   * (a record without a turn the CLI wrote under its own name; none for one joined into the next or dropped).
   */
  input: Array<{ content: unknown; uuid?: string; noTurn: boolean; priority?: string; readAt: number; confirmedAt?: number }>;
  /** When the plugin closed the process (`close()`), and when the query's stream ended (performance.now). */
  closedAt?: number;
  endedAt?: number;
  /** When the CLI process of the query started and reached the simulator (performance.now), for the load stands. */
  startedAt: number;
  /** A chat query: the same moment, from which the CLI reads its input (`CONFIRM_MS`). */
  handedAt?: number;
  /** Characters of the prompt the plugin sent (this query's records), without the resumed chain. */
  promptChars: number;
  /** What happened: answered, parked, stopped, a failure kind, dropped, records, refused: … */
  outcome: string;
  /** The query's parameters as the CLI process received them (`QueryParams`; the prompt left out). */
  params: Omit<QueryParams, "prompt">;
};

/** How a chat query fails. */
export type ClaudeFailure = "spawn" | "api" | "killed" | "killedAfterRecords" | "killedWhileTool" | "killedAfterResult" | "killedBeforeFlush" | "zombie" | "copyKilled" | ApiFailure;

/**
 * How a model call fails, as Claude Code 2.1.312 reports it (the real CLI
 * against a local stub of the Messages API: the failures probe, the
 * context-size probe): the retries the CLI makes by
 * itself (`api_retry` events, ten for 429/529/5xx), then a synthetic
 * `assistant` record with `isApiErrorMessage` and its error code, a result
 * with `is_error`, `terminal_reason`, `api_error_status`, and the SDK's throw
 * "Claude Code returned an error result: <text>". `refusal` and `maxTokens`
 * are answers the CLI handles first (one retry with a note; three
 * continuations), then the same synthetic record. "api" is `serverError`.
 */
export type ApiFailure =
  | "promptTooLong" | "requestTooLarge" | "imageTooLarge" | "badRequest" | "rateLimit" | "overloaded" | "serverError"
  | "oauthOrg" | "permission" | "authentication" | "creditBalance" | "billing" | "modelNotFound" | "verificationRequired"
  | "cloudCredentials" | "accountOnHold" | "refusal" | "maxTokens";
/**
 * A failure's shape: the CLI's own retries (`retryError` the `api_retry` event's `error`), the HTTP status (null: no
 * answer of the API — the synthetic record has no `apiErrorStatus`, the result's `api_error_status` is null), the
 * synthetic record's `error` code (and `apiErrorCode`), the result's terminal reason and text. `withoutBeta`: the
 * request sent once more without the last beta; `nonStreaming`: once more without streaming.
 */
type FailureShape = {
  retries: number; retryError?: string; withoutBeta?: boolean; nonStreaming?: boolean; status: number | null; error: string;
  apiErrorCode?: string; terminal: string; text: string;
};
/**
 * The `error` code of the synthetic record, CLI 2.1.312 (its code: the function that turns a failed call into the
 * record, beside `cqn`, which names the `api_retry` event's error, read in the binary; measured by the stream-usage probe):
 * 404 `model_not_found`; a 403 whose body names `details.error_code: "verification_required"` `verification_required`;
 * no cloud credentials (Bedrock, Vertex) `cloud_credential_error`; 529 `server_error` — `overloaded` is only the
 * `api_retry` event's `error` (`cqn`), never a record's; `account_on_hold` only from the OAuth token's refresh.
 */
const API_FAILURES: Record<Exclude<ApiFailure, "refusal" | "maxTokens">, FailureShape> = {
  promptTooLong: { retries: 0, status: 400, error: "invalid_request", terminal: "prompt_too_long", text: "Prompt is too long" },
  // Any other 400 `invalid_request_error` (the service-records probe "400-generic", CLI 2.1.312, the stub's message
  // "stub failure"): the CLI sends the request once more without the beta `thinking-token-count-2026-05-13`, no
  // `api_retry`; that one failing too, the synthetic record "API Error: 400 <message>" with the code "unknown".
  badRequest: { retries: 0, withoutBeta: true, status: 400, error: "unknown", terminal: "api_error", text: "API Error: 400 stub failure" },
  requestTooLarge: {
    retries: 0, status: 413, error: "invalid_request", terminal: "image_error",
    text: "Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit. Remove older images or compact the conversation.",
  },
  // The API's 400 "image exceeds 5 MB maximum" (the failures probe "400 image too large", CLI 2.1.312).
  imageTooLarge: { retries: 0, status: 400, error: "invalid_request", terminal: "image_error", text: "Image was too large. Try resizing the image or using a different approach." },
  rateLimit: { retries: 10, retryError: "rate_limit", status: 429, error: "rate_limit", terminal: "api_error", text: "API Error: Request rejected (429) · This request would exceed the rate limit for your organization." },
  overloaded: {
    retries: 10, retryError: "overloaded", status: 529, error: "server_error", terminal: "api_error",
    text: "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.{persists}",
  },
  serverError: {
    retries: 10, retryError: "server_error", status: 500, error: "server_error", terminal: "api_error",
    text: "API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.{persists}",
  },
  oauthOrg: { retries: 0, status: 403, error: "oauth_org_not_allowed", terminal: "api_error", text: "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access" },
  permission: { retries: 0, status: 403, error: "authentication_failed", terminal: "api_error", text: "Failed to authenticate. API Error: 403 Your account does not have permission to use this model." },
  // 401 with an API key, followed to its end (the failures probe "401 authentication", 29.10.2026): ten retries
  // of the CLI (about 3 minutes), then the synthetic record and the result. On a sign-in by subscription not probed.
  authentication: { retries: 10, retryError: "authentication_failed", status: 401, error: "authentication_failed", terminal: "api_error", text: "Invalid API key · Fix external API key" },
  creditBalance: { retries: 0, status: 400, error: "billing_error", terminal: "api_error", text: "Credit balance is too low" },
  billing: { retries: 0, status: 402, error: "unknown", terminal: "api_error", text: "API Error: 402 Payment required: your subscription payment is past due." },
  // 404 `not_found_error` "model: <id>" (the stream-usage probe "fail-404-model"): the streaming request, then the
  // same request without streaming (`stream: false`), no `api_retry`; the text names the query's model.
  modelNotFound: {
    retries: 0, nonStreaming: true, status: 404, error: "model_not_found", terminal: "api_error",
    text: "There's an issue with the selected model ({model}). It may not exist or you may not have access to it.",
  },
  // 403 `permission_error` with `details.error_code: "verification_required"` ("fail-403-verification"): "API Error: "
  // and the API's message (the probe's stub wrote this one), the record's `apiErrorCode` the body's code.
  verificationRequired: {
    retries: 0, status: 403, error: "verification_required", apiErrorCode: "verification_required", terminal: "api_error",
    text: "API Error: Verify your identity to keep using Claude: https://claude.ai/verify",
  },
  // No credentials of the cloud provider ("fail-bedrock-default-retries", "fail-vertex-no-credentials"): no request
  // reaches the API; two retries of the CLI (`api_retry` with `error_status: null`, `max_retries: 2`), then the record
  // with no status. The text by the provider the query's environment names (`cloudCredentialText`).
  cloudCredentials: { retries: 2, retryError: "cloud_credential_error", status: null, error: "cloud_credential_error", terminal: "api_error", text: "{cloud}" },
  // Read from the CLI's code only (a sign-in by subscription whose token refresh the server answers "account_on_hold",
  // behind a server flag; a probe with an API key cannot reach it — "fail-403-on-hold-body": such a body on a
  // Messages API 403 gives `authentication_failed`). The default page of the text (`L6t`); no status.
  accountOnHold: {
    retries: 0, status: null, error: "account_on_hold", terminal: "api_error",
    text: "Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted",
  },
};
/**
 * The text of a cloud provider's credentials failure (the stream-usage probe "fail-bedrock-no-credentials",
 * "fail-vertex-no-credentials", CLI 2.1.312): Bedrock with no AWS credentials anywhere; Vertex with
 * GOOGLE_APPLICATION_CREDENTIALS naming a file that is not there. Other forms were not probed.
 */
function cloudCredentials(env: Record<string, string | undefined>) {
  if (/^(1|true)$/i.test(env.CLAUDE_CODE_USE_BEDROCK ?? "")) {
    return {
      text: "API Error: Could not load AWS credentials · Could not load credentials from any providers. Check or refresh your AWS credentials and try again.",
      error: {
        message: "Failed to resolve AWS credentials from the credential provider chain.", formatted: "Could not load credentials from any providers",
        connection: null, isNetworkDown: false, rateLimits: null, noResponse: null, isCloudCredentialError: true,
      },
    };
  }
  const key = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (/^(1|true)$/i.test(env.CLAUDE_CODE_USE_VERTEX ?? "") && key) {
    const missing = `The file at ${key} does not exist, or it is not a file. ENOENT: no such file or directory, lstat '${key}'`;
    return {
      text: `API Error: Could not load Google Cloud credentials · ${missing}. Check or refresh your Google Cloud credentials and try again.`,
      error: {
        message: "Failed to acquire Google OAuth credentials.", formatted: missing, connection: { code: "ENOENT", message: missing, isSSLError: false },
        isNetworkDown: false, rateLimits: null, noResponse: null, isCloudCredentialError: true,
      },
    };
  }
  throw new Error("the Claude Code simulator writes a cloud credentials failure only for Bedrock, or Vertex with GOOGLE_APPLICATION_CREDENTIALS set (probe it against the real CLI first)");
}
/**
 * The API's error body of a failed call, by its status, as the probes' stub sent it (Anthropic's error shape):
 * the `api_error` record keeps it whole in `message`, its text in `formatted`.
 */
const API_ERROR_BODIES: Record<number, { type: string; message: string }> = {
  401: { type: "authentication_error", message: "invalid x-api-key" },
  429: { type: "rate_limit_error", message: "This request would exceed the rate limit for your organization." },
  500: { type: "api_error", message: "Internal server error" },
  529: { type: "overloaded_error", message: "Overloaded" },
};
/**
 * The `error` of an `api_error` record, CLI 2.1.312 word for word (the failures probe, the second failures probe:
 * 401, 429, 500, 529, a dropped connection). `rateLimits` is set only from the unified rate-limit headers, which the
 * API sends on a sign-in by subscription.
 */
function apiErrorObject(status: number | null, requestId?: string) {
  if (status === null) {
    return {
      message: "Connection error.", formatted: "Connection dropped (ECONNRESET)",
      connection: { code: "ECONNRESET", message: "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()", isSSLError: false },
      isNetworkDown: false, rateLimits: null, noResponse: null,
    };
  }
  const body = API_ERROR_BODIES[status];
  if (!body) throw new Error(`the Claude Code simulator has no API error body for ${status} (probe it against the real CLI first)`);
  // The API's `request-id` header follows the status (the service-records probe "529", the stream-usage probe "fail-529").
  return {
    message: `${status} ${JSON.stringify({ type: "error", error: body })}`, status, ...(requestId ? { requestId } : {}), formatted: `${status} ${body.message}`,
    connection: null, isNetworkDown: false, rateLimits: null, noResponse: null,
  };
}
/**
 * A failure's text for a query: the 5xx texts end on where to look (the CLI's code, `NDr`): the status page when the CLI
 * talks to Anthropic's own address (no `ANTHROPIC_BASE_URL`, or api.anthropic.com), else "your inference gateway (<host>)"
 * as the probes' stub saw it.
 */
function failureText(shape: { text: string }, params: { env?: unknown; model?: unknown }): string {
  const env = (params.env ?? {}) as Record<string, string | undefined>;
  const base = env.ANTHROPIC_BASE_URL ?? "";
  const host = base ? (URL.parse(base)?.host ?? base) : "";
  const persists = !host || host === "api.anthropic.com" ? " If it persists, check https://status.claude.com." : ` If it persists, check your inference gateway (${host}).`;
  return shape.text
    .replace("{persists}", persists)
    .replace("{model}", typeof params.model === "string" ? params.model : "claude-sonnet-5-5")
    .replace("{cloud}", () => cloudCredentials(env).text);
}
/**
 * Whether the CLI compacts by itself (its code: the `autoCompactEnabled` setting, on by default, and the
 * DISABLE_AUTO_COMPACT / DISABLE_COMPACT variables): `settings` as the process got them (`--settings`), an object
 * or its JSON. Main's starter leaves the setting alone (on), the chain's sets it off.
 */
function autoCompactOn(params: { settings?: unknown; env?: unknown }): boolean {
  const env = (params.env ?? {}) as Record<string, string | undefined>;
  if (/^(1|true|yes)$/i.test(env.DISABLE_AUTO_COMPACT ?? "") || /^(1|true|yes)$/i.test(env.DISABLE_COMPACT ?? "")) return false;
  if (params.settings === undefined) return true;
  let settings = params.settings as Record<string, unknown> | string | undefined;
  if (typeof settings === "string") {
    try {
      settings = JSON.parse(settings) as Record<string, unknown>;
    } catch {
      settings = undefined;
    }
  }
  return (settings as Record<string, unknown> | undefined)?.autoCompactEnabled !== false;
}
/**
 * The summary's text after an auto compaction, CLI 2.1.312 word for word (the open-cases probe "compact-reactive";
 * the too-long probe "tool-then-too-long", "side-too-long"): the tools the
 * conversation used before (the CLI's code joins them by ", "), the transcript's path (none for a side query, which
 * has no file; the note on the earliest part then names no transcript), and the note on the messages kept verbatim
 * after it (none when nothing was kept: the compaction after a tool step).
 */
function compactSummaryText(summary: string, transcript: string | undefined, options: { tools?: string[]; kept?: boolean } = {}): string {
  const kept = options.kept ?? true;
  return [
    "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
    "",
    `<system-reminder>\n<tools-used-before-summary>${(options.tools ?? []).join(", ")}</tools-used-before-summary>\n</system-reminder>`,
    `Summary:\n${summary}`,
    "",
    ...(transcript === undefined
      ? ["Note: the earliest part of the conversation was too large to include and is NOT covered by this summary. If the task turns out to depend on something from that part, say so plainly rather than guessing at it."]
      : [
          `If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcript}`,
          "",
          "Note: the earliest part of the conversation was too large to include and is NOT covered by this summary (the full transcript mentioned above still has it). If the task turns out to depend on something from that part, say so plainly rather than guessing at it.",
        ]),
    'Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I\'ll continue" or similar. Pick up the last task as if the break never happened.',
    ...(kept
      ? ["", "The messages after this summary are the most recent messages from before compaction, kept verbatim. The summary was written without seeing them, so something it says has not happened yet may already have happened in them."]
      : []),
  ].join("\n");
}
/** A thinking block's signature as Opus 5.5 sent it (a live probe with a subscription; its bytes carry the tag "thinking"). */
export const THINKING_SIGNATURE =
  "CAQSrwUKEAgTGAI4AUIIdGhpbmtpbmcSDDxfnr6/1itwlXGzzBoMrifp94fP01Bx1hcRIjCxNXhuAti8PKXHHZmYVR1YoUWPOuHoS2Je4ifrwJ89LHtioWFx2eFXrTLiIjoK8owqzAT4tSTRBwVfufmH3eAneqyX0pIi/SP5lcU64JyLk1524AGUwW5v5H7HfBO5kLqw/FOOo8nJDZs2r06SM827ut+awdx3RCwDuwOEwlLMwOalbG517YDp7FjQXr53qSGNcbjFUY+RBjLOWpNk9kaUI7qltUEAOXgnuOVbEA/OEkUG3/j2JKtdwU1U4xVwY4owSdRiNchbzNyqGC7RSn3W5rLOY/WChR061CDRqh4+UgnOHWMUOQgzEFiApPI3zuNwWMnfNigB4VtZ+y3vldTbbfchSmyQKTeXygOu+U1BO91MfOJNlED3iLuyyNcPKiNe9kZojrFxpYyG9J3gUFJQDm/LO77AVSdRbImOl08QgQ6mMGN3+IenhB2s0W1RN/MHwYtmYwKIPbwVv31LZe8+s+e005tHcvhSjxHHDagziXxNxFK8FxwxYKvO9I7UYuhG+dnQ2oj5MuLmWLZATiLvSLuWaREssl6A3W0AyBRGHHFRcm1iqUzSwLa5VovBDOy6TT/OXRpkqnttNlplUB1aY+Q0Yxnjq/2ep+/QStUNi+fZ4i1RtWXGS3aRwOfjKPnr1FE/VoMj2IVBBJ57jDhhfrZGl4NRcLYQPRJtIIHQ0RguFJhLuLXvSkqJDHdHNxGhZNvC6GMukjcdSh60pn5hZLNyfmPx/rZo1voZxc0xZXqyvW/JYUACfmlePH4QFOUPP05tFC9/AmXr6MC7nlBwrCONOxzuICa7OgBvdlFeF/L58AZO8v2ZqPNj8IvQ8NgJjDXLPi9lbovveRpUhX0YAQ==";
/** The result the CLI writes for a call it rejects when the turn is interrupted (CLI 2.1.312, the interrupt probe). */
const REJECTED_TOOL_USE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
/** A malformed tool use (the leaf-loss probe "malformed", CLI 2.1.312): the answer the CLI takes back, and its note. */
export const MALFORMED_TOOL_USE_TEXT = "FIRST-TEXT, then a call that never came";
const MALFORMED_TOOL_USE_NOTE = "The previous response failed to produce a valid tool call. Please retry the tool call now.";
const REFUSAL_NOTE = "Your response above was stopped by a safety classifier — this is not a tool or API error. The rest of it was withheld, and tool calls in it that had not finished did not run. Do not produce that content again, even reworded.";
const MAX_TOKENS_NOTE = "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";
const MAX_TOKENS_TEXT = "API Error: Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";
/**
 * The model that answers a refusal instead, by the refused model and the API's category (CLI 2.1.312 against a local
 * stub, the open-cases probe "refusal-*"; the CLI's code, `Rc` and `Ac`): Sonnet 5.5 for cyber alone, Opus 5.5 and
 * Fable 5.1 for cyber, bio and frontier_llm; Haiku 4.5 and other categories never.
 */
const REFUSAL_FALLBACK: Record<string, Record<string, string>> = {
  "claude-sonnet-5-5": { cyber: "claude-sonnet-5" },
  "claude-opus-5-5": { cyber: "claude-opus-4-8", bio: "claude-opus-5", frontier_llm: "claude-opus-5" },
  "claude-fable-5-1": { cyber: "claude-opus-4-8", bio: "claude-opus-5", frontier_llm: "claude-opus-5" },
};
const BIO_SAFEGUARDS = "Our intentionally broad safeguards allow us to deliver more capabilities faster, but can sometimes flag legitimate biology tasks.";
const NORMAL_CONVERSATIONS = "This sometimes happens with safe, normal conversations.";
/** The notice of `model_refusal_fallback` (the open-cases probe "refusal-*", word for word). */
function refusalFallbackNotice(model: string, fallback: string, category: string): string {
  const name = modelDisplayName(model);
  const other = modelDisplayName(fallback);
  const details = `\n\nDetails: \`[${category}]\``;
  if (model === "claude-fable-5-1") {
    const why = category === "cyber" ? "Our intentionally broad safeguards allow us to deliver more capabilities faster, but can sometimes flag legitimate coding and cybersecurity tasks." : category === "bio" ? BIO_SAFEGUARDS : NORMAL_CONVERSATIONS;
    return `${name}'s safeguards flagged this message. ${why} Switched to ${other}. You can learn more: https://support.claude.com/en/articles/15363606${details}`;
  }
  const flags = category === "cyber" ? ", which can sometimes flag non-cybersecurity work" : category === "bio" ? ", which can sometimes flag biology-research-adjacent work" : "";
  const firstTime = model === "claude-sonnet-5-5" ? " on a Sonnet model" : "";
  return `${name}'s safeguards flagged this session. You may be seeing this for the first time${firstTime}: ${name} is more capable and has stronger safeguards as a result${flags}. We're improving these safeguards to reduce the amount of incorrectly flagged messages. ${other} is answering instead, or you can edit and retry with ${name}. You can learn more: https://support.claude.com/en/articles/8106465${details}`;
}
/**
 * The error text of a refusal nobody answered instead, by the model that refused and the category (the second failures probe,
 * the open-cases probe "refusal-*", word for word): cyber the same for every model measured; Haiku 4.5 its own text; Sonnet 5.5,
 * Opus 5.5, Opus 5 and Fable 5.1 one more, with the page by model. A model or category not measured throws "probe it".
 */
function refusalText(model: string, category: string | undefined, messageId: string): string {
  const name = modelDisplayName(model);
  const details = category ? `\n\nDetails: \`[${category}]\`` : "";
  const base = model.replace(/\[.*\]$/, "");
  if (category === "cyber" && ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-4-8"].includes(base)) {
    return `API Error: ${name}'s safeguards flagged this message. Our intentionally broad safeguards allow us to deliver more capabilities faster, but can sometimes flag legitimate cybersecurity work. Learn more: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude${details}\n\nMessage ID: ${messageId}`;
  }
  if (base === "claude-haiku-4-5") return `API Error: ${name} can't help with this. Start a new session to continue.\n\nLearn more: https://www.anthropic.com/legal/aup${details}\n\nMessage ID: ${messageId}`;
  const pages: Record<string, string> = {
    "claude-sonnet-5-5": "https://support.claude.com/en/articles/8106465",
    "claude-opus-5-5": "https://support.claude.com/en/articles/8106465",
    "claude-opus-5": "https://support.claude.com/en/articles/16049681",
    "claude-fable-5-1": "https://support.claude.com/en/articles/15363606",
  };
  if (!pages[base] || category === "cyber") throw new Error(`the Claude Code simulator does not know the refusal text of ${model} for category ${category ?? "none"} (probe it against the real CLI first)`);
  const why = category === "bio" ? BIO_SAFEGUARDS : NORMAL_CONVERSATIONS;
  return `API Error: ${name}'s safeguards flagged this message (https://www.anthropic.com/legal/aup). ${why} Claude Code can't respond to this message with ${name}.\n\nTry rephrasing the request in a new session or change your model.\n\nLearn more: ${pages[base]}${details}\n\nMessage ID: ${messageId}`;
}
/** A model's name as the CLI says it: "claude-haiku-4-5" → "Haiku 4.5". */
export const modelDisplayName = (model: string) => {
  const [family = "", ...version] = model.replace(/^claude-/, "").replace(/\[.*\]$/, "").split("-");
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version.join(".")}`.trim();
};

/** The CLI's version in its records (`version`), the CLI the service records were probed on. */
const CLI_VERSION = "2.1.312";
/**
 * Each model's identity in the `model` attachment (CLI 2.1.312, the service-records probe "models"): its marketing
 * name and knowledge cutoff. An alias names its model; `[1m]` is dropped; a model the CLI does not know has neither
 * name nor cutoff, and its text is "You are powered by the model <id>.".
 */
const MODEL_IDENTITIES: Record<string, [name: string, cutoff: string]> = {
  "claude-opus-5-5": ["Opus 5.5", "June 2026"],
  "claude-sonnet-5-5": ["Sonnet 5.5", "June 2026"],
  "claude-haiku-5-5": ["Haiku 5.5", "June 2026"],
  "claude-fable-5-1": ["Fable 5.1", "June 2026"],
  "claude-opus-5": ["Opus 5", "May 2026"],
  "claude-sonnet-5": ["Sonnet 5", "January 2026"],
  "claude-fable-5": ["Fable 5", "January 2026"],
  "claude-opus-4-8": ["Opus 4.8", "January 2026"],
  "claude-opus-4-7": ["Opus 4.7", "January 2026"],
  "claude-opus-4-6": ["Opus 4.6", "May 2025"],
  "claude-sonnet-4-6": ["Sonnet 4.6", "August 2025"],
  "claude-haiku-4-5": ["Haiku 4.5", "February 2025"],
  "claude-haiku-4-5-20251001": ["Haiku 4.5", "February 2025"],
};
const MODEL_ALIASES: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-1" };
/** The `model` attachment of a model id or alias, as CLI 2.1.312 writes it. */
export function modelAttachment(model: string) {
  const bare = model.replace(/\[.*\]$/, "");
  const modelId = MODEL_ALIASES[bare] ?? bare;
  const known = MODEL_IDENTITIES[modelId];
  if (!known) return { type: "model", identity: { modelId, marketingName: null, knowledgeCutoff: null }, text: `You are powered by the model ${modelId}.` };
  const [marketingName, knowledgeCutoff] = known;
  return {
    type: "model",
    identity: { modelId, marketingName, knowledgeCutoff },
    text: `You are powered by the model named ${marketingName}. The exact model ID is ${modelId}. Assistant knowledge cutoff is ${knowledgeCutoff}.`,
  };
}
/** The first block of the system prompt the CLI sends under a system prompt of the caller's own (the service-records probe). */
const CLI_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
/** The betas of a model request (CLI 2.1.312, the probe's requests and `api-request` lines); a generic 400 is sent again without the last. */
const REQUEST_BETAS = ["interleaved-thinking-2025-05-14", "context-management-2025-06-27", "claude-code-20250219", "thinking-token-count-2026-05-13"];
/** The line of the environment text after the OS (CLI 2.1.312). */
const ENVIRONMENT_NOTE =
  "Downloaded files and extracted archives are untrusted data: put each in its own new, empty directory, keep scripts you write in a different directory, and pass paths as arguments instead of running an interpreter or build tool from inside it. Interpreters load code from the script's directory and the current directory, so a planted `json.py` runs on `import json`. Run any Python that reads them with `-I`. This does not apply to code the user asked you to build or run.";
/** The tokens a turn starts with in `total_tokens_reminder`; each later reminder of the turn says this less what its model calls read and wrote. */
const TURN_TOKENS = 15_000_000;
/** The OS as the `environment` attachment names it: "Windows 11 Pro 10.0.26300" (probed); elsewhere the system's name and release (not probed). */
const osVersionText = () => (process.platform === "win32" ? `${osVersion()} ${osRelease()}` : `${osType()} ${osRelease()}`);
const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type Rec = Record<string, any> & { type: string; uuid?: string };

/**
 * The record types on a transcript's chain, with a uuid: the CLI's own set,
 * as the SDK's transcript loader has it (sdk.mjs 0.3.300, `Dxe` and the two
 * loaders beside it). Every other line (`last-prompt`, `custom-title`,
 * `mode`, `queue-operation`…) is not on the chain. The one rule for every test:
 * `isChainRecord`, `leafOf`; simulators-regression checks it against the SDK.
 */
export const CHAIN_TYPES = new Set(["user", "assistant", "progress", "system", "attachment"]);
export const isChainRecord = (record: { type?: unknown; uuid?: unknown }) => typeof record.uuid === "string" && CHAIN_TYPES.has(String(record.type));

/**
 * The text of a message content: a string, or its parts' texts (nested tool
 * results too); an image block reads as `[image <data>]`, a document as
 * `[document <data>]`.
 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: unknown; text?: unknown; content?: unknown; result?: { value?: unknown }; source?: { data?: unknown } };
      if (p.type === "image") return `[image ${String(p.source?.data ?? "")}]`;
      if (p.type === "document") return `[document ${String(p.source?.data ?? "")}]`;
      if (typeof p.text === "string") return p.text;
      if (typeof p.result?.value === "string") return p.result.value;
      return contentText(p.content);
    })
    .join("\n");
}

/** A query as the simulator runs it: its messages, and what the CLI does on a stop and when the SDK closes it. */
function handleOf(stream: AsyncIterable<unknown>, onClose?: () => void) {
  return {
    stream,
    interrupt: async () => {},
    close: () => onClose?.(),
    getPid: () => null,
  };
}

const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

/** A text as the model streams it: a few deltas (words with their spaces). */
/**
 * The project folder a working folder's sessions go to, under the profile's `projects` (CLI 2.1.312,
 * the folders probe; the same rule as the SDK's `iu`, sdk.mjs 0.3.300): the real
 * path (a junction resolved) with every character outside [a-zA-Z0-9] a "-" (each UTF-16 unit: an emoji makes two),
 * cut at 200 characters with the path's hash in base 36 after a "-".
 */
export function projectFolderName(cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {}
  const slug = real.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let i = 0; i < real.length; i++) hash = ((hash << 5) - hash + real.charCodeAt(i)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

export function piecesOf(text: string): string[] {
  const words = text.match(/\S+\s*|\s+/g) ?? [""];
  const size = Math.max(1, Math.ceil(words.length / 3));
  const pieces: string[] = [];
  for (let i = 0; i < words.length; i += size) pieces.push(words.slice(i, i + size).join(""));
  return pieces;
}

/** An MCP content part as the CLI keeps it in a tool result: text, an `image` block, a document. */
export function blockOfMcp(part: Record<string, any>): Record<string, unknown> {
  if (part.type === "image") return { type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } };
  if (part.type === "resource" && part.resource?.blob) {
    return { type: "document", source: { type: "base64", media_type: part.resource.mimeType, data: part.resource.blob } };
  }
  return { type: "text", text: String(part.text ?? part.resource?.text ?? "") };
}

/**
 * The plugin's MCP tools as the CLI listed them for a query (`tools/list` of its `opencode` server): names,
 * annotations, `_meta`. Kept from the query's start, so a test may read them after the turn.
 */
export async function listPluginTools(params: { mcp?: McpChannel }): Promise<Array<Record<string, any>>> {
  assert.ok(params.mcp?.servers.includes("opencode"), "the query carries the plugin's MCP server (clear OPENCHAMBER_RUNTIME)");
  return params.mcp!.list("opencode");
}

/**
 * The tools the model is offered, as the CLI names them (`mcp__<server>__<tool>`), with description and input
 * schema, sorted by name: every tool of every in-process MCP server, allowed or not (the service-records probe
 * "tool-steps": a tool missing from allowedTools is listed too). None when the query has no such server.
 */
async function offeredTools(params: { mcp?: McpChannel }): Promise<Array<{ name: string; description: string; input_schema: unknown; server: string }>> {
  const tools: Array<{ name: string; description: string; input_schema: unknown; server: string }> = [];
  for (const server of params.mcp?.servers ?? []) {
    for (const tool of await params.mcp!.list(server)) {
      tools.push({ name: `mcp__${server}__${tool.name}`, description: String(tool.description ?? ""), input_schema: tool.inputSchema, server });
    }
  }
  return tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** One tool call of a step: the OpenCode tool (without the `mcp__opencode__` prefix) and its input. */
export type ToolCallSpec = { name: string; input: Record<string, unknown> };

/** Call one of the plugin's MCP tools the way the CLI does: the call's id in `_meta` (probe 43), or none. */
export function callPluginTool(
  params: { mcp?: McpChannel },
  name: string,
  args: Record<string, unknown>,
  toolUseId: string,
): Promise<{ content: Array<Record<string, any>> }> {
  assert.ok(params.mcp?.servers.includes("opencode"), "the query carries the plugin's MCP server (clear OPENCHAMBER_RUNTIME)");
  return params.mcp!.call("opencode", name, args, toolUseId);
}

/** A flag's value as Claude Code reads its arguments: `--name=value` (SDK 0.3.300) or `--name value`. */
function flagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith(`${name}=`)) return args[i]!.slice(name.length + 1);
    if (args[i] === name && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

/**
 * A query as the CLI process received it, under the SDK options' names: the arguments the SDK wrote (sdk.mjs
 * 0.3.300, ProcessTransport: `--model`, `--resume`, `--resume-session-at`, `--session-id`, `--fork-session`,
 * `--no-session-persistence`, `--settings`, `--max-turns`, `--permission-mode`, `--allowedTools`, `--effort`,
 * `--thinking`…), the system prompt and the MCP servers from `initialize`, the process's folder and environment.
 */
function paramsOfProcess(
  start: { args: string[]; cwd: string; env: Record<string, string | undefined> },
  initialize: Record<string, any>,
  prompt: AsyncIterable<any>,
  mcp: McpChannel,
): QueryParams {
  const { args } = start;
  const value = (name: string) => flagValue(args, name);
  const has = (name: string) => args.includes(name);
  const list = (name: string) => value(name)?.split(",").filter(Boolean);
  const params: QueryParams = { prompt, args, cwd: start.cwd, env: start.env, initialize };
  const set = (key: string, v: unknown) => {
    if (v !== undefined) params[key] = v;
  };
  set("model", value("--model"));
  set("resume", value("--resume"));
  set("resumeSessionAt", value("--resume-session-at"));
  set("sessionId", value("--session-id"));
  if (has("--fork-session")) params.forkSession = true;
  if (has("--no-session-persistence")) params.persistSession = false;
  const settings = value("--settings");
  if (settings !== undefined) {
    try {
      params.settings = JSON.parse(settings);
    } catch {
      params.settings = settings;
    }
  }
  const maxTurns = value("--max-turns");
  if (maxTurns !== undefined) params.maxTurns = Number(maxTurns);
  set("permissionMode", value("--permission-mode"));
  set("allowedTools", list("--allowedTools"));
  set("disallowedTools", list("--disallowedTools"));
  set("tools", list("--tools"));
  set("settingSources", list("--setting-sources"));
  if (Array.isArray(initialize.skills)) params.skills = initialize.skills;
  if (initialize.toolAliases && typeof initialize.toolAliases === "object") params.toolAliases = initialize.toolAliases;
  if (initialize.agents && typeof initialize.agents === "object") params.agents = initialize.agents;
  set("effort", value("--effort"));
  set("agent", value("--agent"));
  const thinking = value("--thinking");
  const budget = value("--max-thinking-tokens");
  if (thinking === "adaptive" || thinking === "disabled") params.thinking = { type: thinking };
  else if (budget !== undefined) params.thinking = { type: "enabled", budgetTokens: Number(budget) };
  if (has("--include-partial-messages")) params.includePartialMessages = true;
  if (has("--strict-mcp-config")) params.strictMcpConfig = true;
  // The system prompt: a custom one comes as `systemPrompt` (a list), the preset's addition as `appendSystemPrompt`.
  if (Array.isArray(initialize.systemPrompt)) params.systemPrompt = initialize.systemPrompt.join("\n");
  else if (typeof initialize.systemPrompt === "string") params.systemPrompt = initialize.systemPrompt;
  else {
    params.systemPrompt = {
      type: "preset", preset: "claude_code",
      ...(typeof initialize.appendSystemPrompt === "string" ? { append: initialize.appendSystemPrompt } : {}),
      ...(initialize.excludeDynamicSections === true ? { excludeDynamicSections: true } : {}),
    };
  }
  params.mcpServers = Object.fromEntries(mcp.servers.map((server) => [server, { type: "sdk", name: server }]));
  params.mcp = mcp;
  return params;
}

export type CliSignIn = "subscription" | "loggedOut" | "apiKey" | "bedrock" | "oauthToken" | "apiKeyHelper";

/**
 * The CLI as a process outside a turn (claude-cli.mjs): what `claude
 * --version`, `claude auth status` and the SDK's control requests answer.
 * Unset fields answer as the probed CLI did (claude-cli-answers.json).
 */
export type CliState = {
  /** `claude --version` and `claude_code_version` at initialize. */
  version?: string;
  /**
   * The sign-in `auth status` reports: a Claude plan, signed out, an API key, Bedrock, a long-lived OAuth token
   * (`claude setup-token`, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_AUTH_TOKEN), settings.json `apiKeyHelper`.
   */
  auth?: CliSignIn;
  /** The sign-in of a Claude profile folder (`CLAUDE_CONFIG_DIR`), over `auth`. */
  authByConfigDir?: Record<string, CliSignIn>;
  /** The rows of the model list (initialize `models`, the SDK's supportedModels). */
  models?: Array<Record<string, unknown>>;
  /** The window `get_context_usage` reports after `set_model` to this id. */
  windows?: Record<string, number>;
  /**
   * `set_model` to this id is refused with this text and code; null lifts a refusal the probed account got (an
   * account with access to that `[1m]`: the switch then passes and reports the window the CLI gave for it).
   */
  setModelErrors?: Record<string, { error: string; error_code: string } | null>;
  /** Every start answers only after this many milliseconds (a slow CLI). */
  delayMs?: number;
  /** What `--version` prints instead of "<version> (Claude Code)": another program in the CLI's place (#80933). */
  versionText?: string;
  /** A process the SDK started is killed once it has the prompt (probes 8 and 10). */
  killOnPrompt?: boolean;
  /** Fields of the account `initialize` reports, over the probed one (e.g. `subscriptionType`); signed out has none. */
  account?: Record<string, unknown>;
  /** The network is cut: a `set_model` the CLI must check fails "Network error…" (`check_failed`; CLI 2.1.312 with every connection sent to a dead proxy). */
  offline?: boolean;
  /** Control requests this CLI does not have (an older release): each is answered "Unsupported control request subtype: <subtype>". */
  unsupported?: string[];
  /**
   * What the next `claude update` of a native install does (default: up to date). `updated` moves the
   * install to `to` (the next `--version` reports it); `launcherHeld` reports the update but stays on the
   * old version (the launcher held open, live on 2.1.300); `hang` never ends. `afterExit`: a helper keeps
   * the process's output open `ms` after it exits, writing `text` then.
   */
  update?: {
    outcome?: "updated" | "upToDate" | "launcherHeld" | "busy" | "winget" | "checkFailed" | "noNetwork" | "cutMidway" | "hang" | "silent" | "fetchRefused" | "eexist" | "socketClosed" | "bunImpostor" | "homebrew" | "npmOffline" | "npmPermissions" | "npmBusy" | "npmPlaceholderLeft";
    to?: string;
    /** `silent`: the exit code (the issues that saw it name none). */
    code?: number;
    /** The PATH warning 2.1.308 printed on every run (anthropics/claude-code #104403). */
    pathWarning?: boolean;
    afterExit?: { ms: number; text?: string };
  };
};

/**
 * How Claude Code is installed in a folder (the plugin's executable-path.ts
 * finds each; npm view @anthropic-ai/claude-code@2.1.312: `bin` is
 * `bin/claude.exe`, the native binary its postinstall puts there):
 * - `npm-legacy`: npm's `claude.cmd` with the package's `cli.js` (older
 *   releases), run through node — the world's default;
 * - `npm`: npm's `claude.cmd` with the package's `bin/claude.exe`;
 * - `local-bin`: the official installer's `claude.exe` alone (`~/.local/bin`);
 * - `orphan`: npm's `claude.cmd` and sh shim left with no package.
 * Elsewhere than Windows, `claude` is a script or the binary itself.
 */
export type CliLayout = "npm-legacy" | "npm" | "local-bin" | "orphan";

const simulatorDir = dirname(fileURLToPath(import.meta.url));
/**
 * The probed answers the CLI process reads at every start (claude-cli.mjs): the world names the file in
 * OPENCODE_CLAUDE_SIMULATOR_ANSWERS (world.ts) and beside each install (`installCli`, `answers-path.txt`).
 */
export function cliAnswersPath(): string {
  return join(simulatorDir, "claude-cli-answers.json");
}
/**
 * The simulator's CLI compiled into one executable (`bun build --compile`),
 * built once per version of claude-cli.mjs into the system's temp and linked
 * from there (about 110 MB). The answers are not built in: the process reads
 * them at start (`OPENCODE_CLAUDE_SIMULATOR_ANSWERS`, world.ts), so a change of
 * them needs no new build.
 */
function compiledCli(): string {
  const digest = createHash("sha256").update(readFileSync(join(simulatorDir, "claude-cli.mjs"))).digest("hex").slice(0, 12);
  const exe = join(tmpdir(), "opencode-claude-simulator-cli", digest, process.platform === "win32" ? "claude.exe" : "claude");
  if (existsSync(exe)) return exe;
  mkdirSync(dirname(exe), { recursive: true });
  // Built under a name of this process, then renamed: tests running side by side never start a half-written file.
  // On Windows `bun build --compile` adds ".exe" to a name without it.
  const building = process.platform === "win32" ? join(dirname(exe), `claude.${process.pid}.building.exe`) : `${exe}.${process.pid}.building`;
  const built = spawnSync(process.execPath, ["build", "--compile", join(simulatorDir, "claude-cli.mjs"), "--outfile", building], { encoding: "utf8" });
  assert.equal(built.status, 0, `bun build --compile of claude-cli.mjs: ${built.stderr}`);
  try {
    renameSync(building, exe);
  } catch (error) {
    // Another process placed it first.
    rmSync(building, { force: true });
    if (!existsSync(exe)) throw error;
  }
  return exe;
}
/** The program an install runs: npm's `cli.js` (through node) or the executable; none for `orphan`. */
function executableOf(binDir: string, layout: CliLayout = "npm-legacy"): string | undefined {
  const windows = process.platform === "win32";
  const pkg = join(binDir, "node_modules", "@anthropic-ai", "claude-code");
  if (layout === "orphan") return undefined;
  if (layout === "local-bin") return join(binDir, windows ? "claude.exe" : "claude");
  if (layout === "npm") return join(pkg, "bin", windows ? "claude.exe" : "claude");
  return join(pkg, "cli.js");
}
/** The folder an install laid out by `layOutCli` keeps its state in (undefined for `orphan`). */
function homeOfCli(binDir: string, layout: CliLayout = "npm-legacy"): string | undefined {
  const pkg = join(binDir, "node_modules", "@anthropic-ai", "claude-code");
  if (layout === "orphan") return undefined;
  if (layout === "local-bin") return binDir;
  if (layout === "npm") return join(pkg, "bin");
  return pkg;
}
/** A hard link of the compiled CLI (a copy where linking fails). */
function placeExe(at: string) {
  mkdirSync(dirname(at), { recursive: true });
  try {
    linkSync(compiledCli(), at);
  } catch {
    copyFileSync(compiledCli(), at);
  }
}

/**
 * Lays the CLI process out in `binDir` as `layout` installs it. Returns the
 * folder where that install keeps its state and log (beside `cli.js` or the
 * executable), or undefined for an install that cannot run (`orphan`).
 */
function layOutCli(binDir: string, layout: CliLayout = "npm-legacy"): string | undefined {
  const pkg = join(binDir, "node_modules", "@anthropic-ai", "claude-code");
  const windows = process.platform === "win32";
  const npmShim = () => {
    writeFileSync(join(binDir, "claude.cmd"), `@echo off\r\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`);
    writeFileSync(join(binDir, "claude"), `#!/bin/sh\nexec node "${join(pkg, "cli.js")}" "$@"\n`);
    chmodSync(join(binDir, "claude"), 0o755);
  };
  mkdirSync(binDir, { recursive: true });
  if (layout === "orphan") {
    npmShim();
    return undefined;
  }
  if (layout === "local-bin") {
    placeExe(join(binDir, windows ? "claude.exe" : "claude"));
    return binDir;
  }
  if (layout === "npm") {
    placeExe(join(pkg, "bin", windows ? "claude.exe" : "claude"));
    if (windows) writeFileSync(join(binDir, "claude.cmd"), `@echo off\r\n"%~dp0node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n`);
    else {
      writeFileSync(join(binDir, "claude"), `#!/bin/sh\nexec "${join(pkg, "bin", "claude")}" "$@"\n`);
      chmodSync(join(binDir, "claude"), 0o755);
    }
    return join(pkg, "bin");
  }
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "cli.js"), `import(${JSON.stringify(pathToFileURL(join(simulatorDir, "claude-cli.mjs")).href)});\n`);
  if (windows) writeFileSync(join(binDir, "claude.cmd"), `@echo off\r\nnode "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`);
  else {
    writeFileSync(join(binDir, "claude"), `#!/bin/sh\nexec node "${join(pkg, "cli.js")}" "$@"\n`);
    chmodSync(join(binDir, "claude"), 0o755);
  }
  return pkg;
}

/**
 * When the CLI confirms a record without a turn, from the SDK's write of it (the confirmation probe,
 * CLI 2.1.312, SDK 0.3.300, Windows, 24 processes): the first record of a process once the process has started —
 * 353 ms median (318–493) on a new transcript, 426 (342–519) on a resumed one —, every later one 7 ms (481 records,
 * 4–49), one by one or 50–300 ms apart alike. The CLI reads its input `starting` ms after its start, then takes each
 * record and confirms it `running` ms later; here `starting` is the measured median less `running`.
 */
export const CONFIRM_MS = { startingNew: 345, startingResume: 420, running: 7 };

/**
 * What the CLI counts a model's tokens at, in USD a million (input, output, cache write, cache read), and the
 * window and output limit it reports in `modelUsage` - CLI 2.1.312 against a local stub, one call of each kind per
 * model (the open-cases probe "prices"). No higher price for a long prompt (300 000 tokens priced as 100 000). A model
 * the CLI has no price for costs as `DEFAULT_PRICE` (its code: `uee[e] ?? Zqt`, Zqt = $5 / $25 / $6.25 / $0.50).
 */
export const MODEL_PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number; contextWindow: number; maxOutputTokens: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1, contextWindow: 200_000, maxOutputTokens: 32_000 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3, contextWindow: 200_000, maxOutputTokens: 32_000 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2, contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25, contextWindow: 1_000_000, maxOutputTokens: 64_000 },
};
const DEFAULT_PRICE = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, contextWindow: 200_000, maxOutputTokens: 32_000 };
type Tokens = { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; output_tokens: number };
/** A call's cost as the CLI counts it (`MODEL_PRICES`). */
export const costOf = (model: string, usage: Tokens) => {
  const price = MODEL_PRICES[model.replace(/\[.*\]$/, "")] ?? DEFAULT_PRICE;
  return (usage.input_tokens * price.input + usage.output_tokens * price.output + usage.cache_creation_input_tokens * price.cacheWrite + usage.cache_read_input_tokens * price.cacheRead) / 1e6;
};
/** One model's entry of `modelUsage` as `cost-state` keeps it (no window: those the result adds). */
type ModelTotals = { inputTokens: number; outputTokens: number; thinkingTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; cacheCreationEphemeral5mInputTokens: number; cacheCreationEphemeral1hInputTokens: number; webSearchRequests: number; costUSD: number };
/**
 * A session's spending as the CLI keeps it (the open-cases probe "usage-resume", "usage-copy-and-side"): a query
 * starts from the last `cost-state` line of the file it resumes (a copy: of its source; a side query too, and it
 * writes none), adds each model call, and its result reports the sum: `total_cost_usd`, and `modelUsage` per model
 * with the model's window and output limit; a model this query called also names itself (`canonicalModel`,
 * `provider`, `costBasis`), one only restored does not.
 */
function sessionSpend(resumed: Rec[]) {
  const last = resumed.findLast((record) => record.type === "cost-state");
  const models: Record<string, ModelTotals> = structuredClone(last?.modelUsage ?? {});
  let cost = typeof last?.totalCostUSD === "number" ? last.totalCostUSD : 0;
  const called = new Set<string>();
  return {
    get cost() {
      return cost;
    },
    models,
    add(model: string, usage: Tokens, thinking = 0) {
      const entry = (models[model] ??= { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationEphemeral5mInputTokens: 0, cacheCreationEphemeral1hInputTokens: 0, webSearchRequests: 0, costUSD: 0 });
      const callCost = costOf(model, usage);
      entry.inputTokens += usage.input_tokens;
      entry.outputTokens += usage.output_tokens;
      // The call's `output_tokens_details.thinking_tokens` (the stream-usage probe "usage-thinking": 120 in cost-state).
      entry.thinkingTokens += thinking;
      entry.cacheReadInputTokens += usage.cache_read_input_tokens;
      entry.cacheCreationInputTokens += usage.cache_creation_input_tokens;
      entry.costUSD += callCost;
      cost += callCost;
      called.add(model);
    },
    result() {
      const modelUsage: Record<string, Record<string, unknown>> = {};
      for (const [model, entry] of Object.entries(models)) {
        const price = MODEL_PRICES[model.replace(/\[.*\]$/, "")] ?? DEFAULT_PRICE;
        modelUsage[model] = {
          ...entry, contextWindow: price.contextWindow, maxOutputTokens: price.maxOutputTokens,
          ...(called.has(model) ? { canonicalModel: model, provider: "firstParty", costBasis: "list" } : {}),
        };
      }
      return { total_cost_usd: cost, modelUsage };
    },
  };
}
/**
 * A result's `usage` (the query's token totals) and a call's record's `message.usage` (the call's final count): the
 * tokens and the fields CLI 2.1.312 adds (the open-cases probe "usage-resume", the stream-usage probe "usage-thinking").
 */
const resultTokens = (totals: Tokens, thinking = 0) => ({
  input_tokens: totals.input_tokens,
  cache_creation_input_tokens: totals.cache_creation_input_tokens,
  cache_read_input_tokens: totals.cache_read_input_tokens,
  output_tokens: totals.output_tokens,
  output_tokens_details: { thinking_tokens: thinking },
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: "",
  iterations: [],
  speed: "standard",
  fallback_credit: null,
});
/** The usage of the CLI's synthetic error record: no call, its fields empty (the stream-usage probe, every "fail-" case). */
const SYNTHETIC_USAGE = {
  output_tokens_details: null, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: null,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: null, iterations: null, speed: null,
  fallback_credit: null,
};
/** A model call's usage as a scenario sets it (`state.usage`): the API's counts, thinking tokens as the API reports them. */
export type CallUsage = Partial<Tokens> & { output_tokens_details?: { thinking_tokens: number } };

export function createClaudeCodeSimulator(projectDir: string) {
  mkdirSync(projectDir, { recursive: true });

  /** Knobs a scenario turns: what the next queries do. */
  const state = {
    /** How the next chat queries fail, one entry per query. */
    failures: [] as ClaudeFailure[],
    /** Zombie processes: each writes its answer when called. */
    zombies: [] as Array<() => void>,
    /** The next chat query calls a tool before it answers. */
    toolTurn: false,
    /**
     * The next chat query's tool steps: each the number of `bash` calls
     * (`[1, 2]`: a step of one call, then a step of two) or the calls
     * themselves (`[[{ name: "read", input: { filePath: "a" } }, …]]`);
     * empty: `toolTurn` decides.
     */
    toolSteps: [] as Array<number | ToolCallSpec[]>,
    /** The model streams slowly: a pause after each content block of a model call, in ms. */
    blockPauseMs: 0,
    /** Which model call of the next chat query fails with its `failures` entry (an ApiFailure): 1 the first; 2 the one after the first tool step. */
    failingCall: 1,
    /** The CLI retries the next query's first model call this many times by itself, then it answers. */
    apiRetries: undefined as { failure: "overloaded" | "serverError" | "rateLimit" | "connection"; attempts: number } | undefined,
    /** The CLI really waits its announced retry delays (else no wait). */
    waitRetries: false,
    /** The `stop_details` of the next refusal (`category`, `explanation`) and its text (`""`: nothing streamed). */
    refusalDetails: undefined as { category?: string; explanation?: string; text?: string; fallbackAnswers?: boolean } | undefined,
    /** The CLI compacts the chat by itself before the next answer (its auto compaction; `summary`: the summary's text). */
    compactBeforeAnswer: undefined as { summary?: string } | undefined,
    /** A hung CLI: `interrupt()` does nothing (the plugin then closes the process after its grace). */
    ignoreInterrupt: false,
    /** The next model call's stream stalls after its blocks, before `message_delta`, until this settles. */
    stallBeforeStop: undefined as Promise<void> | undefined,
    /** The next chat query holds its answer until this settles: the chat mid-turn. */
    hold: undefined as Promise<void> | undefined,
    /**
     * The next start of a query holds until this settles: the plugin's real starter is called after it (a start
     * slower than usual: the starter awaits the SDK's import and the CLI's lookup before the SDK's `query()`).
     * `heldStarts` counts the starts held so far.
     */
    holdStart: undefined as Promise<void> | undefined,
    /** Copies started at once by two processes: both pass the name check (probe 25). */
    copyRace: false,
    /** The next copy is refused with "No message found", nothing written. */
    refuseCopy: false,
    /** The texts of the next answers, one per answered chat query; empty: `answer L<n>`. */
    replies: [] as string[],
    /**
     * The CLI takes records without a turn that wait in its input at once:
     * all that came while it started, and those that came while it wrote the
     * one before. Off for load stands that time the plugin alone.
     */
    joinWaitingRecords: true,
    /**
     * How long the CLI takes to confirm a record without a turn, in ms: undefined — as measured (`CONFIRM_MS`:
     * `starting` from the process's start until it reads its input, by a new or a resumed transcript; `running`
     * per record after); a pair — those for every next chat query (`{ starting: 0, running: 0 }`: at once).
     */
    confirmMs: undefined as { starting: number; running: number } | undefined,
    /** What Claude saw keeps images as `[image]`, without their data (load stands with big files). */
    viewWithoutImageData: false,
    /** The texts of the next summaries and side questions, one per query; empty: a summary in OpenCode's template. */
    summaryReplies: [] as string[],
    /** How the next summaries and side queries fail, one entry per query (ApiFailure, or "maxTurns": the model asked for a tool in a query of one step). */
    summaryFailures: [] as Array<ApiFailure | "maxTurns">,
    /** The next answer stops after its first delta until this settles: a stop while the answer streams. */
    holdMidAnswer: undefined as Promise<void> | undefined,
    /**
     * When the user stops the next answer (under `holdMidAnswer`, or `hold` - before the reader got any of it), the
     * CLI had this many more pieces of it from the API than its reader had read: they go into the answer's record
     * and reach the reader only after the stop (the stop-lag probe "slow-reader", "first-piece", "burst"). As many
     * as the block has left: the block's record is whole.
     */
    unreadAtStop: 0,
    /**
     * The next answer's first model call ends `stop_reason: "tool_use"` with no call in it (the leaf-loss probe
     * "malformed"): its text streams to the reader, the CLI takes the message back (a tombstone: never written, it
     * was still in the batch), writes "The previous response failed to produce a valid tool call…" as a meta user
     * record and calls the model again. The record after the taken-back one keeps its uuid as the parent.
     */
    malformedToolUse: false,
    /**
     * `rate_limit_info` of the `rate_limit_event`s the next model call emits as its response starts (after
     * `status: requesting`), and after the answer before the result (a window that changed). Fields as a
     * subscription near its limit sent them (a live probe, Fable at 85% of a weekly window): `status` (allowed, allowed_warning,
     * rejected), `resetsAt`, `rateLimitType` (five_hour, seven_day, seven_day_overage_included…),
     * `utilization`, `surpassedThreshold`, `overageStatus`, `overageDisabledReason`, `isUsingOverage`,
     * `unifiedWindows` ({ five_hour: { utilization, resetsAt }, … }), `overageEnabled`.
     */
    rateLimitEvents: [] as Array<Record<string, unknown>>,
    rateLimitEventsAfter: [] as Array<Record<string, unknown>>,
    /**
     * Notices the next chat query emits before its first model call, as the CLI's schemas have them:
     * `{ subtype: "notification", key, text, priority: "low" | "medium" | "high" | "immediate", color?, timeout_ms? }`,
     * `{ subtype: "informational", content, level: "info" | "notice" | "suggestion" | "warning", prevent_continuation?, tag? }`.
     */
    notices: [] as Array<Record<string, unknown> & { subtype: "notification" | "informational" }>,
    /** The next tool step's model call says what it is about to do first: a text block before its calls. */
    toolPreamble: undefined as string | undefined,
    /** The answers think first: a thinking block with this text before the text ("": redacted, as Opus 5.5 sends it). */
    thinking: undefined as string | undefined,
    /**
     * Usage of the model calls, over the estimate (4 characters a token read and written, no cache): one object for
     * every call, or a list — each next model call (of any query) takes the next entry, the estimate once it is empty
     * (the live case of two calls of one turn: 500 059, then 501 050 of context). `output_tokens_details` (thinking
     * tokens) comes with the call's `message_delta`, as the API sends it.
     */
    usage: {} as CallUsage | CallUsage[],
  };
  let modelCalls = 0;
  /** HTTP requests to the Messages API so far: each answers with its `request-id` (`req_sim_<n>`). */
  let apiRequests = 0;
  /**
   * One model call's usage (`state.usage` over the estimate) in the forms the CLI passes it on (CLI 2.1.312,
   * the stream-usage probe "usage-*", the context-size probe): `opening` the API's `message_start` snapshot (output 1)
   * — also what every `assistant` event of the call carries, and the record of an answer stopped while it streams;
   * `delta` the `message_delta` usage (the output, the thinking tokens); `tokens` the call's final count, `final` its
   * record's `message.usage` (the result's fields), `thinking` its thinking tokens.
   */
  const callUsage = (read: number, written: number) => {
    const set = Array.isArray(state.usage) ? (state.usage.shift() ?? {}) : state.usage;
    const { output_tokens_details: details, ...counts } = set;
    const tokens: Tokens = { input_tokens: read, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: Math.max(1, written), ...counts };
    const thinking = details?.thinking_tokens ?? 0;
    return {
      tokens, thinking,
      opening: { input_tokens: tokens.input_tokens, cache_read_input_tokens: tokens.cache_read_input_tokens, cache_creation_input_tokens: tokens.cache_creation_input_tokens, output_tokens: 1 },
      delta: { output_tokens: tokens.output_tokens, ...(details ? { output_tokens_details: details } : {}) },
      final: resultTokens(tokens, thinking),
    };
  };

  /**
   * The transcript files of one Claude profile (`projects`: its folder of project folders). A query reads and
   * writes the profile its `env.CLAUDE_CONFIG_DIR` names (the plugin's `configDirs` option), else the world's. A
   * session's file is found in whichever project folder holds it, as `--resume <id>` finds it from any working
   * folder and appends to it there (the folders probe: a resume, a resume at a point); a new file, a copy too, goes
   * to `home`, the project folder of the working folder (`projectFolderName`).
   */
  const filesIn = (projects: string, home: string) => {
    const located = new Map<string, string>();
    const fileOf = (name: string) => {
      const known = located.get(name);
      if (known && existsSync(known)) return known;
      for (const folder of existsSync(projects) ? readdirSync(projects) : []) {
        const file = join(projects, folder, `${name}.jsonl`);
        if (existsSync(file)) {
          located.set(name, file);
          return file;
        }
      }
      return join(home, `${name}.jsonl`);
    };
    const records = (name: string): Rec[] =>
      existsSync(fileOf(name))
        ? readFileSync(fileOf(name), "utf8")
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as Rec)
        : [];
    const write = (name: string, record: Rec) => {
      const file = fileOf(name);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(record) + "\n");
    };
    /** Records with a uuid, the first of each uuid (the CLI collapses repeats when it reads). */
    const byUuid = (name: string) => {
      const map = new Map<string, Rec>();
      for (const record of records(name)) {
        if (typeof record.uuid === "string" && !map.has(record.uuid)) map.set(record.uuid, record);
      }
      return map;
    };
    /** The last chain record written: what a plain resume continues from (`isChainRecord`). */
    const leafOf = (name: string): Rec | undefined => records(name).filter(isChainRecord).at(-1);
    /**
     * The records from the first one down to `uuid`, along parents, with what the calls of one model message left
     * off that line put back, as the CLI's loader does (sdk.mjs 0.3.300, `lve`; the two-calls probe "follow-ups"):
     * each result's parent is its own call's record, so of two calls' results only the last written lies on the
     * line. After the line's last record of a message (`message.id`): the message's records off the line, then the
     * results of its calls off the line, each in file order.
     */
    const chainTo = (name: string, uuid: string): Rec[] => {
      const all = byUuid(name);
      const chain: Rec[] = [];
      const seen = new Set<string>();
      const ordered = [...all.values()];
      const position = new Map(ordered.map((record, i) => [record.uuid!, i]));
      let current = all.get(uuid);
      while (current && !seen.has(current.uuid!)) {
        seen.add(current.uuid!);
        chain.unshift(current);
        const parent = parentOf(current);
        const next = parent ? all.get(parent) : undefined;
        // A parent the CLI took back (a tombstone, "Where a resume continues"): its own loader still reads what
        // lies before it (the leaf-loss probe "malformed": a plain resume sent the question before the gap). The
        // rule was not found in its code; taken from the probe: the chain record written just before the orphan.
        current = next ?? (parent ? ordered.slice(0, position.get(current.uuid!)).findLast(isChainRecord) : undefined);
      }
      const lastOf = new Map<string, string>();
      for (const record of chain) if (record.type === "assistant" && typeof record.message?.id === "string") lastOf.set(record.message.id, record.uuid!);
      if (lastOf.size === 0) return chain;
      const blocksOf = (record: Rec, type: string, key: string): string[] =>
        Array.isArray(record.message?.content) ? record.message.content.filter((b: any) => b?.type === type).map((b: any) => String(b[key])) : [];
      const answered = new Set(chain.flatMap((r) => (r.type === "user" ? blocksOf(r, "tool_result", "tool_use_id") : [])));
      const after = new Map<string, Rec[]>();
      for (const [id, last] of lastOf) {
        const group = [...all.values()].filter((r) => r.type === "assistant" && r.message?.id === id);
        const members = new Set(group.map((r) => r.uuid));
        const calls = new Set(group.flatMap((r) => blocksOf(r, "tool_use", "id")));
        const results = [...all.values()].filter((r) => {
          if (seen.has(r.uuid!) || r.type !== "user" || !r.parentUuid) return false;
          const ids = blocksOf(r, "tool_result", "tool_use_id");
          if (ids.length === 0) return false;
          // Hung off one of the message's records: always; else found by its call's id, when that call has no result yet.
          if (members.has(r.parentUuid)) return true;
          return (members.has(r.sourceToolAssistantUUID) || ids.some((i) => calls.has(i))) && ids.some((i) => calls.has(i) && !answered.has(i));
        });
        const back = [...group.filter((r) => !seen.has(r.uuid!)), ...results];
        for (const record of back) {
          seen.add(record.uuid!);
          for (const i of blocksOf(record, "tool_result", "tool_use_id")) answered.add(i);
        }
        if (back.length > 0) after.set(last, back);
      }
      return after.size === 0 ? chain : chain.flatMap((r) => [r, ...(after.get(r.uuid!) ?? [])]);
    };
    const onLeafChain = (name: string, uuid: string) => {
      const leaf = leafOf(name);
      return !!leaf && chainTo(name, leaf.uuid!).some((r) => r.uuid === uuid);
    };
    return { projects, home, fileOf, records, write, byUuid, leafOf, chainTo, onLeafChain };
  };
  const parentOf = (record: Rec): string | null => record.parentUuid || record.logicalParentUuid || null;
  /** The world's profile (`projectDir` is the project folder of the world's working folder): what tests read by default. */
  const worldProjects = dirname(projectDir);
  const { fileOf, records, write, byUuid, leafOf, chainTo, onLeafChain } = filesIn(worldProjects, projectDir);
  /** The files a query works on: its profile's (`env.CLAUDE_CONFIG_DIR`), else the world's; new ones in its working folder's project folder. */
  const dirOf = (params: QueryParams) => {
    const configDir = (params.env as Record<string, string | undefined> | undefined)?.CLAUDE_CONFIG_DIR;
    const projects = configDir ? join(configDir, "projects") : worldProjects;
    return filesIn(projects, params.cwd ? join(projects, projectFolderName(String(params.cwd))) : projectDir);
  };
  /** What a content holds for the model, as text (images without their data when `viewWithoutImageData`). */
  const textOf = (content: unknown): string => {
    const text = contentText(content);
    return state.viewWithoutImageData ? text.replace(/\[(image|document) [^\]]*\]/g, "[$1]") : text;
  };
  /**
   * What the model reads of a chain: from the last compaction boundary on
   * (the CLI's summary stands for what came before; a resume point may still
   * lie before it — the chain crosses it by `logicalParentUuid`, check C 22).
   */
  const sinceCompaction = (chain: Rec[]) => {
    const at = chain.findLastIndex((r) => r.type === "system" && r.subtype === "compact_boundary");
    const part = chain.slice(Math.max(0, at));
    // The records the compaction kept verbatim come right after its summary (the open-cases probe "compact-reactive":
    // the request after it holds the summary, then the turn's question).
    const segment = at >= 0 ? chain[at]!.compactMetadata?.preservedSegment : undefined;
    if (!segment) return part;
    const head = chain.findIndex((r) => r.uuid === segment.headUuid);
    const tail = chain.findIndex((r) => r.uuid === segment.tailUuid);
    const anchor = part.findIndex((r) => r.uuid === segment.anchorUuid);
    if (head < 0 || tail < head || tail >= at || anchor < 0) return part;
    return [...part.slice(0, anchor + 1), ...chain.slice(head, tail + 1), ...part.slice(anchor + 1)];
  };
  /** What a record holds for the model, as text. */
  const recordText = (record: Rec): string =>
    record.type === "attachment" ? String(record.attachment?.prompt ?? "") : textOf(record.message?.content);
  /** Every transcript file of the world's profile, by file name, and its text: to tell which ones an action changed. */
  const snapshot = () =>
    new Map(
      readdirSync(worldProjects).flatMap((folder) =>
        readdirSync(join(worldProjects, folder), { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => [entry.name, readFileSync(join(worldProjects, folder, entry.name), "utf8")] as const),
      ),
    );

  const queries: ClaudeQuery[] = [];
  /** Where each answer went: its token (`L7`) → transcript and record. */
  const answers = new Map<string, { name: string; uuid: string }>();
  let answerCount = 0;
  const nextReply = (token: string) => state.replies.shift() ?? `answer ${token}`;

  /**
   * A query the CLI refuses before any turn, nothing written: a result with the error, then the process exits with
   * code 1 and the SDK throws "Claude Code returned an error result: <text>" (live
   * probes 39 and 47: "No message found…", "No conversation found…").
   */
  const refusal = (name: string, text: string) =>
    handleOf(
      (async function* () {
        yield { type: "result", subtype: "error_during_execution", is_error: true, errors: [text], session_id: name };
        throw new Error(`Claude Code returned an error result: ${text}`);
      })(),
    );
  /** A new file under a name in use: no result, the text on stderr, exit code 1 (the same probes). */
  const nameInUse = (name: string) =>
    handleOf(
      (async function* () {
        throw Object.assign(new Error("Claude Code process exited with code 1"), { stderr: `Error: Session ID ${name} is already in use.\n` });
      })(),
    );
  const paramsOf = (params: QueryParams): Omit<QueryParams, "prompt"> => {
    const { prompt: _prompt, ...rest } = params;
    return rest;
  };

  /** A query of a CLI process (`serve`): a chat turn, or a summary or side question (`persistSession: false`). */
  const runQuery = async (params: QueryParams) => {
    if (params.persistSession === false) return summary(params);
    const { fileOf, records, write, byUuid, leafOf, chainTo, onLeafChain } = dirOf(params);
    // A copy (probe 12): `resume` the source, write into `sessionId`. With
    // neither `resume` nor `sessionId` (main) the CLI makes the name up.
    const from = params.resume ?? params.sessionId ?? randomUUID();
    const copy = params.resume && params.forkSession === true && params.sessionId ? params.sessionId : undefined;
    const name = copy ?? from;
    const startedAt = performance.now();
    const query: ClaudeQuery = { kind: "chat", name, at: null, view: "", outcome: "", input: [], startedAt, handedAt: startedAt, promptChars: 0, params: paramsOf(params), ...(copy ? { copiedFrom: from } : {}) };
    queries.push(query);
    params.onQuery?.(query);
    // A new file, or a copy, under a name in use: refused (probe 39, S6 and S8:
    // a file with only service lines counts). Two copies started at once both
    // pass (probe 25): `state.copyRace`.
    if ((!params.resume || (copy && !state.copyRace)) && existsSync(fileOf(name))) {
      query.outcome = "refused: in use";
      return nameInUse(name);
    }
    if (copy && state.refuseCopy) {
      state.refuseCopy = false;
      query.outcome = "refused: no message";
      return refusal(name, `No message found with message.uuid ${params.resumeSessionAt}`);
    }
    if (params.resume && !existsSync(fileOf(from))) {
      query.outcome = "refused: no conversation";
      return refusal(name, `No conversation found with session ID: ${from}`);
    }
    if (params.resumeSessionAt && !onLeafChain(from, params.resumeSessionAt)) {
      query.outcome = "refused: no message";
      return refusal(name, `No message found with message.uuid ${params.resumeSessionAt}`);
    }
    const failure = state.failures.shift();
    if (failure === "spawn") {
      query.outcome = "spawn";
      throw new Error("Claude Code process exited with code 1");
    }
    // What the file held when the process started: all a process killed before it flushed its writes leaves
    // (`killedBeforeFlush`).
    const fileAtStart = failure === "killedBeforeFlush" && existsSync(fileOf(name)) ? readFileSync(fileOf(name)) : undefined;
    let parent: string | null = params.resumeSessionAt ?? leafOf(from)?.uuid ?? null;
    // The uuids this process knows: the file it loaded at the start (a copy:
    // only the source's chain it copies, probe 39 S9), then what it writes.
    const known = new Set(copy ? (parent ? chainTo(from, parent).map((r) => r.uuid!) : []) : byUuid(from).keys());
    const spend = sessionSpend(params.resume ? records(from) : []);
    if (copy) {
      if (failure === "copyKilled") {
        // The copying process died as soon as the file appeared: service lines, no record (probe 39, S2).
        write(name, { type: "mode", mode: "normal", sessionId: name });
        query.outcome = "killed";
        return handleOf(
          (async function* () {
            yield { type: "system", subtype: "init", session_id: name };
            throw new Error("Claude Code process exited with code 143");
          })(),
        );
      }
      // A copying process's own lines first; the chain follows in one write after the first message's queue lines
      // (the service-records probe "new-then-resume": mode, atis-latch, enqueue, dequeue, the copied chain).
      write(name, { type: "mode", mode: "normal", sessionId: name });
      write(name, { type: "atis-latch", atis: "", sessionId: name });
    }
    const copiedChain = copy && parent ? chainTo(from, parent) : [];
    let copyPending = !!copy;
    const writeCopy = () => {
      if (!copyPending) return;
      copyPending = false;
      if (copiedChain.length > 0) appendFileSync(fileOf(name), copiedChain.map((record) => JSON.stringify({ ...record, sessionId: name })).join("\n") + "\n");
    };
    // A plain resume on a record without a turn: the CLI first answers it
    // with a record of its own, which the model then reads (probe 47).
    const leaf = leafOf(from);
    if (params.resume && !params.resumeSessionAt && leaf?.type === "user" && leaf.queueTranscriptOnly) {
      const uuid = randomUUID();
      writeCopy();
      write(name, { type: "assistant", uuid, parentUuid: leaf.uuid, sessionId: name, message: { role: "assistant", content: [{ type: "text", text: "No response requested." }] } });
      known.add(uuid);
      parent = uuid;
    }
    query.at = parent;
    const view: string[] = parent ? sinceCompaction(chainTo(copyPending ? from : name, parent)).map(recordText) : [];
    // Resumed at a result of two calls whose other result lies off its parent line: the model reads the chain the
    // loader rebuilt down to that point, and the CLI hangs what it writes next off that chain's latest-written
    // record (the two-calls probe "follow-ups"); at any other record that record is the latest.
    if (params.resumeSessionAt && parent) {
      const order = new Map([...byUuid(from).keys()].map((uuid, i) => [uuid, i]));
      parent = chainTo(from, parent).reduce((a, b) => ((order.get(b.uuid!) ?? -1) > (order.get(a.uuid!) ?? -1) ? b : a)).uuid!;
    }

    /*
     * The CLI's service records (CLI 2.1.312: test/cli-contract-live.ts, the service-records probe; BEHAVIOR.md
     * "Transcript files"). On the chain, each the parent of the next: after the first record of a file (or of the
     * part after a compaction boundary) `environment` and `model`; after every question `total_tokens_reminder`,
     * before it `environment` again when the working folder changed, after it on the file's first question
     * `session_context`, `date` and a partial `prompt_snapshot`; after the first model call that answered, the full
     * `prompt_snapshot`. Off the chain: `queue-operation` around each input message; per model request
     * `api-request-shape` (once a file), `api-request-blob` (each new message the CLI folded its reminders into) and
     * `api-request`; `tools-used` before the record of a call of a tool new to the file; after a turn `last-prompt`
     * and `cost-state`, `mode` between them in a resumed process; `atis-latch` at a new file's first question;
     * `mode` and `atis-latch` first in a copy.
     */
    const cwd = String(params.cwd ?? "");
    const modelId = typeof params.model === "string" ? params.model : "claude-sonnet-5-5";
    const systemText = typeof params.systemPrompt === "string" ? [params.systemPrompt] : typeof (params.systemPrompt as any)?.append === "string" ? [(params.systemPrompt as any).append] : [];
    const processStarted = Date.now();
    /** The tools the model is offered, listed once a process at its first model request. */
    let tools: Awaited<ReturnType<typeof offeredTools>> | undefined;
    const loadTools = async () => (tools ??= await offeredTools(params));
    /** The chain down to where the process writes now, from the last compaction boundary on. */
    const epochChain = (): Rec[] => (parent ? sinceCompaction(chainTo(name, parent)) : []);
    const lastAttachment = (type: string, full?: boolean) =>
      epochChain().findLast((r) => r.type === "attachment" && r.attachment?.type === type && (full === undefined || Array.isArray(r.attachment?.tools) === full));
    /** An attachment on the chain; `rendered`: the text the model reads of it, kept beside as a system reminder. */
    const attach = (attachment: Record<string, unknown>, rendered?: string) => {
      const uuid = randomUUID();
      const text = rendered === undefined ? {} : { rendered: [{ content: `<system-reminder>\n${rendered}\n</system-reminder>` }], renderedRole: "system" };
      write(name, { type: "attachment", uuid, parentUuid: parent, sessionId: name, attachment, ...text });
      parent = uuid;
    };
    const attachEnvironment = (changes?: unknown) => {
      const snapshot = { workingDirectory: cwd, isWorktree: false, isGitRepo: false, additionalWorkingDirectories: [], platform: process.platform, shell: "bash", osVersion: osVersionText() };
      const text = `# Environment\nYou have been invoked in the following environment: \n - Primary working directory: ${cwd}\n - Is a git repository: false\n - Platform: ${process.platform}\n - Shell: bash\n - OS Version: ${snapshot.osVersion}\n - ${ENVIRONMENT_NOTE}`;
      // The text of a changed folder was not probed: that record goes without one.
      attach({ type: "environment", snapshot, ...(changes ? { changes } : {}) }, changes ? undefined : text);
    };
    const attachModel = () => {
      const model = modelAttachment(modelId);
      attach(model, model.text);
    };
    /** The tokens left: the turn's, less what its model calls so far read and wrote (the service-records probe "tool-image"). */
    const attachTokensLeft = (used = 0) => {
      const text = `<total_tokens>${TURN_TOKENS - used} tokens left</total_tokens>`;
      attach({ type: "total_tokens_reminder", text }, text);
    };
    const attachDate = () => {
      const date = new Date().toISOString().slice(0, 10);
      attach({ type: "date", date }, `Today's date is ${date}.`);
    };
    const partialSnapshot = () => ({ type: "prompt_snapshot", systemPrompt: systemText, reminderFold: false, echoWireToolInputs: false, contextRendering: "announced" });
    /** After a record of the input: the file's environment and model, once per file and per compaction. */
    const afterRecord = () => {
      if (lastAttachment("environment")) return;
      attachEnvironment();
      attachModel();
    };
    /** After a question: the folder again when it changed, the tokens left, the first question's context. */
    const afterQuestion = () => {
      const known = lastAttachment("environment")?.attachment?.snapshot?.workingDirectory;
      if (known !== undefined && known !== cwd) attachEnvironment([{ field: "workingDirectory", from: known }]);
      attachTokensLeft();
      // The process that started the file marks it at its first question, after the tokens left (a copy did at its start).
      if (!params.resume && !records(name).some((r) => r.type === "atis-latch")) write(name, { type: "atis-latch", atis: "", sessionId: name });
      if (!lastAttachment("prompt_snapshot")) {
        attach({ type: "session_context", context: {} });
        attachDate();
        attach(partialSnapshot());
      }
    };
    /** After a model call that answered: the full snapshot, once per file and per compaction (not after a refused or cut call). */
    const afterModelCall = () => {
      if (lastAttachment("prompt_snapshot", true)) return;
      const offered = (tools ?? []).map(({ name, description, input_schema, server }) => ({ name, description, schema: { name, description, input_schema }, server }));
      attach({ type: "prompt_snapshot", systemPrompt: systemText, tools: offered, cliPrefix: CLI_PREFIX, reminderFold: false, echoWireToolInputs: false, contextRendering: "announced" });
    };
    const queueOperation = (operation: "enqueue" | "dequeue" | "remove", content?: unknown, extra: Record<string, unknown> = {}) =>
      write(name, { type: "queue-operation", operation, timestamp: new Date().toISOString(), sessionId: name, ...(content === undefined ? {} : { content: contentText(content) }), ...extra });

    /**
     * The messages of a model request, from the chain (the service-records probe): an answer's records as one
     * `assistant` message; a run of `user` records and attachments as one `user` message, the attachments' texts
     * folded in — before the question (the last of them ending in a newline), or at the end of the last tool
     * result's content (its last text ending in a newline). Attachments without a text (`session_context`,
     * `prompt_snapshot`), `system` records and the synthetic record of an API error are not sent.
     */
    const requestMessages = () => {
      const messages: Array<{ role: "user" | "assistant"; content: any[]; folded: boolean }> = [];
      let blocks: any[] = [];
      let reminders: string[] = [];
      let answerId: unknown;
      const endUser = () => {
        if (blocks.length === 0 && reminders.length === 0) return;
        const texts = reminders.map((text) => ({ type: "text", text }));
        const result = blocks.findLast((block) => block?.type === "tool_result");
        let content: any[];
        if (result && texts.length > 0) {
          const inner: any[] = Array.isArray(result.content) ? [...result.content] : [{ type: "text", text: String(result.content ?? "") }];
          const last = inner.at(-1);
          if (last?.type === "text") inner[inner.length - 1] = { ...last, text: `${last.text}\n` };
          content = blocks.map((block) => (block === result ? { ...block, content: [...inner, ...texts] } : block));
        } else {
          if (texts.length > 0) texts[texts.length - 1] = { type: "text", text: `${texts.at(-1)!.text}\n` };
          content = [...texts, ...blocks];
        }
        messages.push({ role: "user", content, folded: reminders.length > 0 });
        blocks = [];
        reminders = [];
      };
      for (const record of epochChain()) {
        if (record.type === "assistant") {
          if (record.isApiErrorMessage) continue;
          endUser();
          const content = Array.isArray(record.message?.content) ? record.message.content : [{ type: "text", text: String(record.message?.content ?? "") }];
          const last = messages.at(-1);
          if (last?.role === "assistant" && record.message?.id !== undefined && record.message.id === answerId) last.content.push(...content);
          else messages.push({ role: "assistant", content: [...content], folded: false });
          answerId = record.message?.id;
        } else if (record.type === "user") {
          const content = record.message?.content;
          blocks.push(...(typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []));
        } else if (record.type === "attachment") {
          const text = record.rendered?.[0]?.content ?? (record.attachment?.type === "queued_command" ? String(record.attachment.prompt ?? "") : undefined);
          if (typeof text === "string") reminders.push(text);
        }
      }
      endUser();
      return messages;
    };
    /** This process's previous model request: its id and its messages' hashes (`base`, `keep`). */
    let previousRequest: { id: string; hashes: string[] } | undefined;
    /** The `request-id` the API gave this process's latest model request (`requestLines`). */
    let apiRequestId: string | undefined;
    /**
     * A model request's lines off the chain (the service-records probe): the shape (system and tools) when the
     * file has no line of that shape; a blob for each message the CLI folded reminders into that the file has no
     * blob of (its content as sent: the reminders, a question's image data, a tool result's image data again);
     * then the request — `base` the process's previous request, `keep` how many of its messages this one starts
     * with, `tail` the hashes of the rest, answers and notes included. Returns its id (the answer's `requestRef`).
     */
    const requestLines = async (betas = REQUEST_BETAS, model = modelId): Promise<string> => {
      const offered = await loadTools();
      const shape = { system: [CLI_PREFIX, ...systemText].map((text) => ({ type: "text", text })), tools: offered.map(({ name, description, input_schema }) => ({ name, description, input_schema })) };
      const shapeHash = sha256(shape);
      const lines = records(name);
      const timestamp = new Date().toISOString();
      if (!lines.some((r) => r.type === "api-request-shape" && r.shapeHash === shapeHash)) write(name, { type: "api-request-shape", sessionId: name, shapeHash, timestamp, version: CLI_VERSION, shape });
      const messages = requestMessages();
      const hashes = messages.map(({ role, content }) => sha256({ role, content }));
      const stored = new Set(lines.filter((r) => r.type === "api-request-blob").map((r) => r.hash));
      for (const [i, { role, content, folded }] of messages.entries()) {
        if (!folded || stored.has(hashes[i])) continue;
        stored.add(hashes[i]);
        write(name, { type: "api-request-blob", sessionId: name, hash: hashes[i], message: { role, content } });
      }
      let keep = 0;
      while (previousRequest && keep < previousRequest.hashes.length && keep < hashes.length && previousRequest.hashes[keep] === hashes[keep]) keep++;
      const id = randomUUID();
      const lastMessage = messages.at(-1);
      write(name, {
        type: "api-request", sessionId: name, id, timestamp, version: CLI_VERSION, querySource: "sdk", shapeHash,
        params: { model: modelAttachment(model).identity.modelId, betas, max_tokens: 32_000, thinking: (params as any).thinking ?? { type: "disabled" }, temperature: 1 },
        ...(previousRequest ? { base: previousRequest.id } : {}),
        keep,
        tail: hashes.slice(keep),
        cacheControl: [
          ...shape.system.map((_, k) => ({ path: ["system", k], value: { type: "ephemeral" } })),
          ...(lastMessage ? [{ path: ["messages", messages.length - 1, "content", lastMessage.content.length - 1], value: { type: "ephemeral" } }] : []),
        ],
        requestDigest: sha256({ shapeHash, betas, hashes }),
      });
      previousRequest = { id, hashes };
      // The API's `request-id` of this request: an answer's records and a failure's records name it.
      apiRequestId = `req_sim_${++apiRequests}`;
      return id;
    };
    /** Before the record of a tool call: the tools the file used so far with this one, when it is new to the file. */
    const toolUsed = (tool: string) => {
      const used: string[] = records(name).findLast((r) => r.type === "tools-used")?.tools ?? [];
      if (!used.includes(tool)) write(name, { type: "tools-used", tools: [...used, tool], sessionId: name });
    };

    /** How long this process's model calls that ended and its tool calls took. */
    const spent = { apiMs: 0, toolMs: 0 };
    /** The session's durations so far: the file's last `cost-state` (a copy: its source's), which this process adds to. */
    const priorCost = records(copy ? from : name).findLast((r) => r.type === "cost-state");
    /**
     * The session's cost after this process's calls (the service-records probe): its money and tokens per model as
     * `spend` counts them (`sessionSpend`, the prices by model), its durations from the file's last line on.
     */
    const costState = () => {
      const prior = (key: string) => Number(priorCost?.[key] ?? 0);
      return {
        type: "cost-state", sessionId: name, totalCostUSD: spend.cost,
        totalAPIDuration: prior("totalAPIDuration") + spent.apiMs, totalAPIDurationWithoutRetries: prior("totalAPIDurationWithoutRetries") + spent.apiMs,
        totalToolDuration: prior("totalToolDuration") + spent.toolMs, totalLinesAdded: prior("totalLinesAdded"), totalLinesRemoved: prior("totalLinesRemoved"),
        totalDuration: prior("totalDuration") + (Date.now() - processStarted), startTime: priorCost?.startTime ?? processStarted,
        modelUsage: structuredClone(spend.models), hasUnknownModelCost: false,
      };
    };
    /** A copy's `last-prompt` names the copied chain's first question, not the new one (the service-records probe "new-then-resume", twice). */
    const copiedPrompt = copiedChain.find((r) => r.type === "user" && !r.isMeta && r.toolUseResult === undefined && !r.isCompactSummary);
    let modeWritten = false;
    /** The end of a turn off the chain: the last prompt with the chain's end, `mode` (a resumed process, once), the session's cost. */
    const turnEnded = (prompt: string) => {
      write(name, { type: "last-prompt", lastPrompt: copiedPrompt ? contentText(copiedPrompt.message?.content) : prompt, leafUuid: parent, sessionId: name });
      if (params.resume && !copy && !modeWritten) {
        modeWritten = true;
        write(name, { type: "mode", mode: "normal", sessionId: name });
      }
      write(name, costState());
    };

    // The prompt stream: records until the one with a turn; what comes later
    // (a message sent while a tool runs) is read as it arrives.
    const incoming: any[] = [];
    // While a step's calls run, a message's queue line is written as it arrives (the two-calls probe).
    let callsRunning = false;
    const enqueued = new WeakSet<object>();
    /** Each message's entry in `query.input`, to note its confirmation. */
    const entryOf = new WeakMap<object, ClaudeQuery["input"][number]>();
    /**
     * When the CLI reads its input (`CONFIRM_MS`): `starting` after the process's start; records without a turn
     * that came before wait until then, and every one is confirmed `running` after the CLI took it.
     */
    const confirm = state.confirmMs ?? { starting: params.resume ? CONFIRM_MS.startingResume : CONFIRM_MS.startingNew, running: CONFIRM_MS.running };
    const readyAt = (query.handedAt ?? performance.now()) + confirm.starting;
    let streamEnded = false;
    let wake: (() => void) | undefined;
    const source: AsyncIterable<any> =
      typeof params.prompt === "string"
        ? (async function* () {
            yield { type: "user", message: { role: "user", content: params.prompt } };
          })()
        : params.prompt;
    void (async () => {
      try {
        for await (const message of source) {
          const entry = { content: message?.message?.content, uuid: message?.uuid, noTurn: message?.shouldQuery === false, ...(message?.priority ? { priority: message.priority } : {}), readAt: performance.now() };
          params.commands?.read(message);
          query.input.push(entry);
          if (message && typeof message === "object") entryOf.set(message, entry);
          // "next" and none are taken into the running turn (probe "next", "plain"); "later" starts a
          // turn of its own after the result (probe "later"), which the plugin never asks for.
          if (message?.priority === "later") throw new Error("the Claude Code simulator does not model priority \"later\" (the real CLI starts a turn of its own after the result)");
          if (callsRunning && message && typeof message === "object") {
            queueOperation("enqueue", message.message?.content);
            enqueued.add(message);
          }
          incoming.push(message);
          wake?.();
        }
      } finally {
        streamEnded = true;
        wake?.();
      }
    })();
    const nextMessage = async () => {
      while (incoming.length === 0 && !streamEnded) await new Promise<void>((resolve) => (wake = resolve));
      return incoming.shift();
    };
    let trigger: string | undefined;
    /** The question's text, for `last-prompt`. */
    let promptText = "";
    let dropped = false;
    let withoutTurn = 0;
    // The proxy stopped the process (the user stopped the turn): no answer is written after that.
    let closed = false;
    // The proxy interrupted the turn (graceful stop): a turn parked on its tool call ends there.
    // The proxy interrupted the turn (`Query.interrupt()`): it ends where it is, as the CLI ends it
    // (the interrupt probe); a hung CLI (`state.ignoreInterrupt`) does nothing.
    let interruptRequested = false;
    let interrupt!: () => void;
    const interrupted = new Promise<"interrupted">((resolve) => (interrupt = () => {
      if (state.ignoreInterrupt) return;
      interruptRequested = true;
      resolve("interrupted");
    }));
    const turn = async function* () {
      for (;;) {
        // The CLI idle, waiting for its input: a record that comes now is taken alone (the confirmation probe).
        const idle = incoming.length === 0;
        let message = await nextMessage();
        if (!message) break;
        params.commands?.taken(message);
        const noTurn = message.shouldQuery === false;
        let join = false;
        if (noTurn) {
          // A process still starting reads its input once started, taking what waits by then
          // (cli-contract-live.ts, check 5.1); a running one takes what came while it wrote the one before.
          const starting = readyAt - performance.now();
          if (starting > 0) await new Promise((resolve) => setTimeout(resolve, starting));
          join = state.joinWaitingRecords && (starting > 0 || !idle);
        }
        let uuid: string = message.uuid ?? randomUUID();
        let content: unknown = message.message?.content ?? "";
        view.push(textOf(content));
        query.promptChars += contentText(content).length;
        if (noTurn) {
          while (join && incoming[0]?.shouldQuery === false) {
            const joined = incoming.shift();
            params.commands?.taken(joined);
            view.push(textOf(joined.message?.content));
            query.promptChars += contentText(joined.message?.content).length;
            content = `${contentText(content)}\n${contentText(joined.message?.content)}`;
            uuid = joined.uuid ?? randomUUID();
            message = joined;
          }
          // Writing it takes the CLI `running` ms; what comes meanwhile waits for the next round.
          if (confirm.running > 0) await new Promise((resolve) => setTimeout(resolve, confirm.running));
          if (closed) break;
        }
        // The process killed once its records without a turn were confirmed, before the record with the
        // turn (`killedAfterRecords`; a process killed after the prompt, probes 8 and 10, a moment earlier).
        if (!noTurn && failure === "killedAfterRecords") {
          query.view = view.slice(0, -1).filter((text) => text.trim()).join("\n");
          query.outcome = "killed";
          throw new Error("Claude Code process exited with code 143");
        }
        // The CLI drops a record whose uuid the file holds, without a word.
        if (known.has(uuid)) {
          if (noTurn) continue;
          dropped = true;
          break;
        }
        known.add(uuid);
        queueOperation("enqueue", content);
        queueOperation("dequeue");
        writeCopy();
        write(name, {
          type: "user",
          uuid,
          parentUuid: parent,
          sessionId: name,
          message: { role: "user", content },
          ...(noTurn ? { queueTranscriptOnly: true } : {}),
        });
        parent = uuid;
        afterRecord();
        if (!noTurn) {
          trigger = uuid;
          promptText = contentText(content);
          break;
        }
        withoutTurn += 1;
        const entry = entryOf.get(message);
        if (entry) entry.confirmedAt = performance.now();
        yield { type: "system", subtype: "init", session_id: name };
        yield { type: "result", is_error: false, num_turns: 0, result: "", user_message_uuid: uuid, usage: {}, session_id: name };
      }
      // A blank text reaches the model as nothing (probe 47).
      query.view = view.filter((text) => text.trim()).join("\n");
      query.trigger = trigger;
      if (!trigger) {
        query.outcome = dropped || withoutTurn === 0 ? "dropped" : "records";
        return;
      }
      // The CLI writes its service records after a question before the model answers: a turn killed now has
      // its question's record and these, but no answer.
      afterQuestion();
      const afterPrompt = parent;
      const model = typeof params.model === "string" ? params.model : "claude-sonnet-5-5";
      const totals = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
      let thinkingTotal = 0;
      /**
       * What a result reports of the model calls (CLI 2.1.312, the context-size probe, the error result of
       * the second failures probe "tool-then-400", the open-cases probe "usage-resume", the stream-usage probe
       * "usage-two-calls"): `usage` this query's calls summed (the thinking tokens too), `total_cost_usd` and
       * `modelUsage` the whole session's (`sessionSpend`).
       */
      const resultUsage = () => ({ usage: resultTokens(totals, thinkingTotal), ...spend.result() });
      /**
       * The end of an interrupted turn (the interrupt probe, CLI 2.1.312):
       * the CLI's interruption record (written and streamed), `between`, an
       * error result with the terminal reason; then the process exits with
       * code 1 and the SDK throws.
       */
      const interruptedTurn = async function* (marker: string, terminal: string, stopReason: string | null, between: unknown[] = []) {
        const uuid = randomUUID();
        const content = [{ type: "text", text: marker }];
        write(name, { type: "user", uuid, parentUuid: parent, sessionId: name, message: { role: "user", content } });
        parent = uuid;
        turnEnded(promptText);
        query.outcome = "stopped";
        yield { type: "user", uuid, session_id: name, parent_tool_use_id: null, message: { role: "user", content } };
        yield* between;
        yield {
          type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: terminal, stop_reason: stopReason,
          errors: [`[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=${stopReason}`], usage: totals, session_id: name,
        };
        throw new Error("Claude Code process exited with code 1");
      };
      /**
       * One model call as the CLI streams it (CLI 2.1.312, the context-size probe):
       * message_start with the call's usage, each content block (start, its
       * deltas, the `assistant` event of that block, stop), message_delta with
       * the stop reason and the output tokens, message_stop. Each block is a
       * record of its own in the file, written when the block is complete
       * (with the call's stop reason). Returns false when the process was
       * stopped before the call ended.
       */
      let retracting = false;
      let lastBlockUuid: string | undefined;
      /** The pieces the CLI had from the API when the user stopped the answer; `unread` of them its reader had not read. */
      const unread = state.unreadAtStop;
      state.unreadAtStop = 0;
      let stopAt: number | undefined;
      const modelCall = async function* (
        blocks: Array<Record<string, any>>, stopReason: string, pause?: Promise<void>, onBlock?: (block: Record<string, any>) => void,
        /** The results of tool calls that ended meanwhile, and a promise of the next one ending (a tool step). */
        ended?: { write: () => Generator<Record<string, unknown>>; next: () => Promise<void> },
        model_ = model,
      ) {
        const model = model_;
        const id = `msg_sim_${++modelCalls}`;
        const written = blocks.reduce((n, b) => n + String(b.text ?? b.thinking ?? JSON.stringify(b.input ?? "")).length, 0);
        // The call's usage: the `assistant` events carry the `message_start` snapshot (output 1), only `message_delta`
        // the final output; the records hold the final count (the stream-usage probe "usage-*"), as the CLI fills the
        // message it writes from the delta.
        const usage = callUsage(Math.ceil(view.join("\n").length / 4), Math.ceil(written / 4));
        for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += usage.tokens[key];
        thinkingTotal += usage.thinking;
        const event = (e: Record<string, unknown>) => ({ type: "stream_event", event: e, session_id: name, parent_tool_use_id: null, uuid: randomUUID() });
        // The request's lines off the chain: its shape, the blobs of its new messages, the request (to this call's model).
        const requestRef = await requestLines(REQUEST_BETAS, model);
        const callStarted = performance.now();
        yield { type: "system", subtype: "status", status: "requesting", session_id: name, uuid: randomUUID() };
        // The API's rate-limit headers as the CLI reports them when the response starts (a live probe with a subscription:
        // after `status: requesting`, before `message_start`).
        for (const info of state.rateLimitEvents.splice(0)) yield { type: "rate_limit_event", rate_limit_info: info, uuid: randomUUID(), session_id: name };
        const requestId = apiRequestId;
        yield event({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], usage: usage.opening } });
        for (const [index, block] of blocks.entries()) {
          const empty = block.type === "text" ? { type: "text", text: "" } : block.type === "thinking" ? { type: "thinking", thinking: "" } : { ...block, input: {} };
          yield event({ type: "content_block_start", index, content_block: empty });
          const pieces = block.type === "tool_use" ? [JSON.stringify(block.input)] : piecesOf(String(block.text ?? block.thinking));
          /** The block came whole before the stop: its record is whole, then the turn ends (the stop-lag probe "burst"). */
          let wholeBeforeStop = false;
          for (const [k, piece] of pieces.entries()) {
            const delta = block.type === "text" ? { type: "text_delta", text: piece } : block.type === "thinking" ? { type: "thinking_delta", thinking: piece } : { type: "input_json_delta", partial_json: piece };
            yield event({ type: "content_block_delta", index, delta });
            if (index === 0 && k === 0 && pause) await Promise.race([pause, interrupted]);
            if (closed) return false;
            if (interruptRequested && block.type !== "tool_use") {
              // The pieces the CLI had already taken from the API go on to the reader after the stop (`unreadAtStop`).
              stopAt ??= k + 1 + unread;
              if (k + 1 < Math.min(stopAt, pieces.length)) continue;
              // More than the block's pieces: the CLI had the block's end too.
              if (stopAt > pieces.length) {
                wholeBeforeStop = true;
                break;
              }
              // Interrupted while the answer streams (the interrupt probe "answer"): what was
              // streamed is written as an aborted answer, then the interruption record, the end of
              // the message, an error result `aborted_streaming`; the process exits with code 1.
              const shown = { ...block, [block.type === "text" ? "text" : "thinking"]: pieces.slice(0, k + 1).join("") };
              const uuid = randomUUID();
              // Its usage is the `message_start` snapshot as the API sent it (the interrupt probe "answer").
              const message = { id, role: "assistant", model, content: [shown], usage: usage.opening, stop_reason: null };
              write(name, { type: "assistant", uuid, parentUuid: parent, sessionId: name, requestRef, requestId, isAbortedMidStream: true, message });
              parent = uuid;
              yield { type: "assistant", uuid, session_id: name, parent_tool_use_id: null, aborted: true, message: { ...message, type: "message" } };
              yield* interruptedTurn("[Request interrupted by user]", "aborted_streaming", null, [
                event({ type: "content_block_stop", index }),
                event({ type: "message_delta", delta: { stop_reason: null, stop_sequence: null }, usage: usage.delta }),
                event({ type: "message_stop" }),
              ]);
            }
          }
          // A thinking block ends with its signature (a live probe with a subscription, Opus 5.5: the signature's
          // bytes carry the tag "thinking").
          if (block.type === "thinking") yield event({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
          const uuid = randomUUID();
          lastBlockUuid = uuid;
          // A call the CLI retracts (a refusal it answers with another model) streams its blocks but writes none.
          if (!retracting) {
            // A call of a tool new to the file: the file's tools used so far, before the call's record (the service-records probe).
            if (block.type === "tool_use") toolUsed(String(block.name));
            // A block stopped before the message's end keeps no stop reason (the stop-lag probe "burst"; the CLI
            // fills it in when `message_delta` comes before it writes the record).
            write(name, { type: "assistant", uuid, parentUuid: parent, sessionId: name, requestRef, requestId, message: { id, role: "assistant", model, content: [block], usage: usage.final, stop_reason: wholeBeforeStop ? null : stopReason } });
            parent = uuid;
          }
          yield { type: "assistant", uuid, session_id: name, parent_tool_use_id: null, message: { id, type: "message", role: "assistant", model, content: [block], usage: usage.opening, stop_reason: null } };
          yield event({ type: "content_block_stop", index });
          if (wholeBeforeStop) {
            // The block came whole before the stop: the interruption record follows it, then the message's end.
            yield* interruptedTurn("[Request interrupted by user]", "aborted_streaming", null, [
              event({ type: "message_delta", delta: { stop_reason: null, stop_sequence: null }, usage: usage.delta }),
              event({ type: "message_stop" }),
            ]);
          }
          // A tool call starts as soon as its block is complete, while the message still streams (the tool-timing probe).
          onBlock?.(block);
          if (state.blockPauseMs > 0) await new Promise((resolve) => setTimeout(resolve, state.blockPauseMs));
          if (closed) return false;
          if (ended) yield* ended.write();
        }
        const stall = state.stallBeforeStop;
        state.stallBeforeStop = undefined;
        if (stall) {
          // A result that comes while the stream stalls is streamed before the message ends.
          let stalled = true;
          void stall.then(() => (stalled = false));
          while (stalled && !closed) {
            await Promise.race([stall, ...(ended ? [ended.next()] : [])]);
            if (ended && !closed) yield* ended.write();
          }
        }
        if (closed) return false;
        // The call ended: the session's cost counts it at its model's prices (a call stopped before this does not
        // count; a refused one does, a retracted one too).
        spend.add(model, usage.tokens, usage.thinking);
        spent.apiMs += Math.round(performance.now() - callStarted);
        yield event({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: usage.delta });
        yield event({ type: "message_stop" });
        return true;
      };

      /**
       * A model call that fails (ApiFailure): the CLI's retries, records and
       * result as the probes saw them (the failures probe,
       * the second failures probe); the first call of the turn, or the one
       * `failingCall` names (after tool steps).
       */
      const failedCall = async function* (kind: ApiFailure) {
        query.outcome = kind;
        const synthetic = (error: string, text: string, stopReason: string, extra: Record<string, unknown> = {}, messageExtra: Record<string, unknown> = {}) => {
          const uuid = randomUUID();
          const message = { id: uuid, role: "assistant", model: "<synthetic>", stop_reason: stopReason, ...messageExtra, content: [{ type: "text", text }], usage: SYNTHETIC_USAGE };
          write(name, { type: "assistant", uuid, parentUuid: parent, sessionId: name, isApiErrorMessage: true, error, ...extra, message });
          parent = uuid;
          return { type: "assistant", uuid, error, session_id: name, parent_tool_use_id: null, message };
        };
        const ended = (text: string, terminal: string, stopReason: string, status: number | null, turns: number) => ({
          type: "result", subtype: "success", is_error: true, result: text, terminal_reason: terminal, stop_reason: stopReason,
          api_error_status: status, num_turns: turns, ...resultUsage(), session_id: name,
        });
        if (kind === "refusal" || kind === "maxTokens") {
          // Answers the CLI handles first (probe: stop_reason refusal / max_tokens). A refusal's
          // `stop_details` (category, explanation) as the API sends them: `state.refusalDetails`;
          // `text: ""` — the refused calls streamed nothing.
          const details = state.refusalDetails;
          state.refusalDetails = undefined;
          const said = kind === "refusal" ? (details?.text ?? "I can't help with that.") : "a cut answer";
          const calls = kind === "refusal" ? 2 : 4;
          // Which model answers this refusal instead (`REFUSAL_FALLBACK`), if any.
          const fallback = kind === "refusal" && details?.category ? REFUSAL_FALLBACK[model.replace(/\[.*\]$/, "")]?.[details.category] : undefined;
          for (let call = 1; call <= calls; call++) {
            retracting = fallback !== undefined && call === calls;
            const done = yield* modelCall(said === "" ? [] : [{ type: "text", text: said }], kind === "refusal" ? "refusal" : "max_tokens");
            retracting = false;
            if (!done) return;
            if (call === calls) break;
            if (kind === "refusal") {
              const notice = { type: "system", subtype: "informational", isMeta: false, level: "notice", content: `${modelDisplayName(model)}'s safeguards stopped the response above · continuing once with that noted` };
              const uuid = randomUUID();
              write(name, { ...notice, uuid, parentUuid: parent, sessionId: name });
              parent = uuid;
              yield { ...notice, uuid, session_id: name };
            }
            const note = randomUUID();
            const noteText = kind === "refusal" ? REFUSAL_NOTE : MAX_TOKENS_NOTE;
            write(name, { type: "user", uuid: note, parentUuid: parent, sessionId: name, isMeta: true, message: { role: "user", content: noteText } });
            parent = note;
            yield {
              type: "user", uuid: note, session_id: name, parent_tool_use_id: null, isMeta: true,
              message: { role: "user", content: [{ type: "text", text: noteText }] },
              ...(kind === "refusal" ? { isSynthetic: true, refused_message_id: `msg_sim_${modelCalls}` } : {}),
            };
          }
          if (kind === "refusal") {
            let refusedBy = model;
            if (fallback) {
              // The CLI answers the refusal with another model (the open-cases probe "refusal-cyber-sonnet", "refusal-<category>-
              // claude-opus-5-5", "-claude-fable-5-1"): the second refused call is retracted - streamed, not written -, a
              // `model_refusal_fallback` notice, then one call of the fallback model with no note of its own.
              const content = refusalFallbackNotice(model, fallback, details!.category!);
              const uuid = randomUUID();
              const common = { trigger: "refusal", direction: "retry", scope: "session" };
              write(name, {
                type: "system", subtype: "model_refusal_fallback", content, level: "warning", ...common, originalModel: model, fallbackModel: fallback,
                requestId: null, apiRefusalCategory: details!.category, apiRefusalExplanation: details?.explanation ?? null,
                retractedMessageUuids: [lastBlockUuid], refusedUserMessageUuid: trigger, isMeta: false, uuid, parentUuid: parent, sessionId: name,
              });
              parent = uuid;
              yield {
                type: "system", subtype: "model_refusal_fallback", ...common, original_model: model, fallback_model: fallback, request_id: null,
                api_refusal_category: details!.category, api_refusal_explanation: details?.explanation ?? null,
                retracted_message_uuids: [lastBlockUuid], refused_user_message_uuid: trigger, content, uuid, session_id: name,
              };
              if (details?.fallbackAnswers) {
                // The fallback model answers ("refusal-cyber-sonnet-fallback-answers"): the turn ends as answered.
                const token = `L${++answerCount}`;
                const text = nextReply(token);
                if (!(yield* modelCall([{ type: "text", text }], "end_turn", undefined, undefined, undefined, fallback))) return;
                const uuid = parent!;
                afterModelCall();
                turnEnded(promptText);
                answers.set(token, { name, uuid });
                query.outcome = "answered";
                yield { type: "result", subtype: "success", is_error: false, num_turns: 2, result: text, stop_reason: "end_turn", user_message_uuid: trigger, ...resultUsage(), session_id: name };
                return;
              }
              if (!(yield* modelCall(said === "" ? [] : [{ type: "text", text: said }], "refusal", undefined, undefined, undefined, fallback))) return;
              refusedBy = fallback;
            }
            const uuid = randomUUID();
            write(name, { type: "system", subtype: "model_refusal_no_fallback", isMeta: false, level: "warning", content: "", uuid, parentUuid: parent, sessionId: name });
            parent = uuid;
            yield {
              type: "system", subtype: "model_refusal_no_fallback", original_model: refusedBy, request_id: null,
              api_refusal_category: details?.category ?? null, api_refusal_explanation: details?.explanation ?? null,
              refused_user_message_uuid: trigger, content: "", uuid, session_id: name,
            };
            const text = refusalText(refusedBy, details?.category, `msg_sim_${modelCalls}`);
            const stopDetails = { type: "refusal", category: details?.category ?? null, explanation: details?.explanation ?? null };
            // The turn's end off the chain after the synthetic record, as after an answer (the service-records probe "refusal").
            const record = synthetic("invalid_request", text, "refusal", {}, { stop_details: stopDetails });
            turnEnded(promptText);
            yield record;
            yield ended(text, "api_error", "refusal", null, 2);
            throw new Error(`Claude Code returned an error result: ${text}`);
          }
          const record = synthetic("max_output_tokens", MAX_TOKENS_TEXT, "stop_sequence", { apiError: "max_output_tokens" });
          turnEnded(promptText);
          yield record;
          yield ended(MAX_TOKENS_TEXT, "api_error", "stop_sequence", null, 4);
          throw new Error(`Claude Code returned an error result: ${MAX_TOKENS_TEXT}`);
        }
        const shape = API_FAILURES[kind];
        if (!shape) throw new Error(`the Claude Code simulator does not know the failure ${kind} of a chat turn`);
        // Each attempt writes its request line (the service-records probe "529", "400-prompt-too-long"): the
        // retried ones before their `api_error` record, the last one here; a generic 400 is sent once more without
        // the last beta ("400-generic").
        // No credentials of a cloud provider: no request reaches the API, its error is the provider's ("fail-bedrock-*").
        const cloudError = kind === "cloudCredentials" ? cloudCredentials((params.env ?? {}) as Record<string, string | undefined>).error : undefined;
        yield* retries(shape.retries, shape.status, shape.retryError!, shape.retries, cloudError);
        await requestLines();
        // A 404 is sent once more without streaming ("fail-404-model"): a request line of its own.
        if (shape.withoutBeta) await requestLines(REQUEST_BETAS.slice(0, -1));
        if (shape.nonStreaming) await requestLines();
        const text = failureText(shape, params);
        // The record names the status, the API's error code and the last request's `request-id` when the API answered
        // (the stream-usage probe "fail-*"); a failure with no answer of the API has none of them.
        const record = synthetic(shape.error, text, "stop_sequence", {
          ...(shape.status !== null ? { apiErrorStatus: shape.status } : {}),
          ...(shape.apiErrorCode ? { apiErrorCode: shape.apiErrorCode } : {}),
          ...(shape.status !== null ? { requestId: apiRequestId } : {}),
        });
        turnEnded(promptText);
        yield record;
        yield ended(text, shape.terminal, "stop_sequence", shape.status, 1);
        throw new Error(`Claude Code returned an error result: ${text}`);
      };
      /**
       * The CLI's own retries of a model call (the second failures probe): an
       * `api_error` record and an `api_retry` event each, the wait doubling
       * from about 0.5 s up to 40 s (waited only with `state.waitRetries`).
       * The record names the API's `request-id` of the attempt when the API answered and `source: "request_retry"`
       * (the service-records probe "529", the stream-usage probe "fail-529"); `errorObject` stands for the API's when
       * no request reached it (a cloud provider's credentials).
       */
      const retries = async function* (count: number, status: number | null, error: string, maxRetries = 10, errorObject?: Record<string, unknown>) {
        for (let attempt = 1; attempt <= count; attempt++) {
          // Doubling from 0.5 s up to 32 s (the failures probe "401 authentication": 575, 1249 … 18219, 34067,
          // 37239, 32110 ms); the CLI adds up to a quarter at random, which the simulator leaves out: no test reads it.
          const delay = Math.min(500 * 2 ** (attempt - 1), 32_000);
          // The failed attempt's request line, then its error record (the service-records probe "529").
          await requestLines();
          const uuid = randomUUID();
          write(name, {
            type: "system", subtype: "api_error", level: "error", uuid, parentUuid: parent, sessionId: name,
            error: errorObject ?? apiErrorObject(status, status === null ? undefined : apiRequestId), retryInMs: delay, retryAttempt: attempt, maxRetries,
            source: "request_retry",
          });
          parent = uuid;
          yield { type: "system", subtype: "api_retry", attempt, max_retries: maxRetries, retry_delay_ms: delay, error_status: status, error, session_id: name };
          if (state.waitRetries) await new Promise((resolve) => setTimeout(resolve, delay));
        }
      };
      const apiKind: ApiFailure | undefined =
        failure === undefined || failure === "spawn" || failure === "killed" || failure === "killedAfterRecords" || failure === "zombie" || failure === "copyKilled" || failure === "killedWhileTool" ||
        failure === "killedAfterResult" || failure === "killedBeforeFlush"
          ? undefined
          : failure === "api" ? "serverError" : failure;
      const failingCall = state.failingCall;
      state.failingCall = 1;
      // The CLI's auto compaction is reactive (the open-cases probe "compact-reactive", "compact-threshold"): a usage
      // near the window starts none; the API refusing a turn's request as too long does, when the setting leaves it
      // on (`autoCompactOn`) - the CLI compacts and answers instead of failing. Measured on a turn's first call with no
      // tools, and on the call after a tool step's results (the too-long probe "tool-then-too-long"): the answer's
      // call after the last step; a refusal of a later step's own call is not probed and fails as before.
      const steps0 = state.toolSteps.length > 0 || state.toolTurn;
      const stepCount = state.toolSteps.length > 0 ? state.toolSteps.length : state.toolTurn ? 1 : 0;
      const reactive = apiKind === "promptTooLong" && autoCompactOn(params) && (failingCall <= 1 ? !steps0 : failingCall === stepCount + 1);
      const failKind = reactive ? undefined : apiKind;
      if (failKind && failingCall <= 1) {
        yield { type: "system", subtype: "init", session_id: name };
        yield* failedCall(apiKind);
        return;
      }
      if (failure === "killed" || failure === "zombie") {
        query.outcome = failure;
        if (failure === "zombie") {
          const token = `L${++answerCount}`;
          const text = nextReply(token);
          state.zombies.push(() => {
            const uuid = randomUUID();
            write(name, { type: "assistant", uuid, parentUuid: afterPrompt, sessionId: name, message: { role: "assistant", content: [{ type: "text", text }] } });
            write(name, { type: "last-prompt", lastPrompt: promptText, leafUuid: uuid, sessionId: name });
            answers.set(token, { name, uuid });
          });
        }
        yield { type: "system", subtype: "init", session_id: name };
        throw new Error("Claude Code process exited with code 143");
      }

      const gate = state.hold;
      state.hold = undefined;
      const midAnswer = state.holdMidAnswer;
      state.holdMidAnswer = undefined;
      const toolTurn = state.toolTurn;
      state.toolTurn = false;
      const token = `L${++answerCount}`;
      query.outcome = toolTurn ? "parked" : "answered";
      yield { type: "system", subtype: "init", session_id: name };
      // The CLI retried the first model call by itself, then it answered (the second failures probe).
      const before = state.apiRetries;
      state.apiRetries = undefined;
      if (before) {
        const [status, error] = ({ overloaded: [529, "overloaded"], serverError: [500, "server_error"], rateLimit: [429, "rate_limit"], connection: [null, "unknown"] } as const)[before.failure];
        yield* retries(before.attempts, status, error);
      }
      // The CLI's notices (`system` / `notification`, `informational`; their schemas from the CLI's code).
      for (const notice of state.notices.splice(0)) yield { type: "system", ...notice, uuid: randomUUID(), session_id: name };
      let callNumber = 0;
      let turns = 1;
      // The turn's tool steps: `toolSteps` gives the calls of each step (Claude
      // writes every call of a step before its first result); `toolTurn`
      // alone is one step of one call.
      const steps = state.toolSteps.length > 0 ? [...state.toolSteps] : toolTurn ? [1] : [];
      state.toolSteps = [];
      // The CLI lists the plugin's tools when it starts: read-only ones (annotations.readOnlyHint) run side by side.
      const readOnly = steps.length > 0 ? new Set((await listPluginTools(params)).filter((t) => t.annotations?.readOnlyHint).map((t) => String(t.name))) : new Set<string>();
      for (const [stepIndex, step] of steps.entries()) {
        const specs: ToolCallSpec[] = typeof step === "number" ? Array.from({ length: step }, () => ({ name: "bash", input: { command: "ls" } })) : step;
        const toolUses = specs.map((spec, k) => ({
          type: "tool_use",
          id: steps.length === 1 && specs.length === 1 ? `toolu_${token}` : `toolu_${token}_${stepIndex}${"abcdefgh"[k]}`,
          name: `mcp__opencode__${spec.name}`,
          input: spec.input,
        }));
        // Each call starts when its block is complete (the tool-timing probe, CLI 2.1.312), in the
        // order of the blocks: read-only tools side by side with the read-only calls before them; any other tool
        // after every earlier call ended, and a read-only call after an earlier other one ended (the open-cases probe
        // "readonly-during-edit", "edit-during-readonly"). The CLI hands the plugin the call's id; the plugin gives
        // it to OpenCode.
        const calls: Array<Promise<{ content: Array<Record<string, any>> }>> = [];
        /** Every call so far ended; everything up to the last call of another tool ended. */
        let allEnded: Promise<unknown> = Promise.resolve();
        let barrier: Promise<unknown> = Promise.resolve();
        /** The calls in the order they ended, not yet written. */
        const endedCalls: Array<{ k: number; result?: { content: Array<Record<string, any>> }; error?: unknown }> = [];
        let callEnded: (() => void) | undefined;
        /** When the step's first call started: the step's tool time runs from it until its results (`cost-state`). */
        let callsStarted: number | undefined;
        const start = (block: Record<string, any>) => {
          if (block.type !== "tool_use") return;
          callsRunning = true;
          callsStarted ??= performance.now();
          const tool = String(block.name).replace(/^mcp__opencode__/, "");
          const run = () => callPluginTool(params, tool, block.input, block.id);
          const k = calls.length;
          const call = (readOnly.has(tool) ? barrier : allEnded).then(run);
          const settled = call.catch(() => {});
          allEnded = Promise.all([allEnded, settled]);
          if (!readOnly.has(tool)) barrier = allEnded;
          // A stopped turn's pending call is rejected by the proxy.
          call.then(
            (result) => endedCalls.push({ k, result }),
            (error: unknown) => endedCalls.push({ k, error }),
          ).finally(() => callEnded?.());
          calls.push(call);
        };
        const written = new Set<number>();
        /**
         * The results of the calls that ended, each written and streamed at once - also while the model's message
         * still streams, before its `message_stop` (the open-cases probe "result-before-stop"); the next block's
         * record then hangs off that result ("result-between-blocks").
         */
        const writeEnded = function* () {
          while (endedCalls.length > 0) {
            const next = endedCalls.shift()!;
            if ("error" in next && next.error !== undefined) throw next.error;
            const { k, result } = next as { k: number; result: { content: Array<Record<string, any>> } };
            written.add(k);
            const toolUse = toolUses[k]!;
            // The MCP result as blocks (the tool-result probe): text blocks, an image
            // block followed by the CLI's note of the file it saved the image to.
            const blocks = result.content.flatMap((part) => {
              const block = blockOfMcp(part) as { type: string; source?: { media_type: string; data: string } };
              if (block.type !== "image" || !block.source) return [block];
              const file = join(dirname(fileOf(name)), name, "tool-results", `mcp-opencode-blob-${Date.now()}-${randomUUID().slice(0, 6)}.${block.source.media_type.split("/")[1] ?? "bin"}`);
              mkdirSync(dirname(file), { recursive: true });
              writeFileSync(file, Buffer.from(block.source.data, "base64"));
              return [block, { type: "text", text: `[Image: source: ${file}]` }];
            });
            view.push(textOf(blocks));
            const content = [{ tool_use_id: toolUse.id, type: "tool_result", content: blocks }];
            const resultUuid = randomUUID();
            const useRecord = records(name).findLast((r) => r.type === "assistant" && r.message?.content?.[0]?.id === toolUse.id)?.uuid;
            write(name, {
              type: "user",
              uuid: resultUuid,
              parentUuid: useRecord ?? parent,
              sessionId: name,
              toolUseResult: blocks,
              ...(useRecord ? { sourceToolAssistantUUID: useRecord } : {}),
              message: { role: "user", content },
            });
            parent = resultUuid;
            yield {
              type: "user",
              uuid: resultUuid,
              session_id: name,
              parent_tool_use_id: null,
              message: { role: "user", content },
              tool_use_result: blocks,
              tool_result_meta: [{ id: toolUse.id, permission_decision: { decision: "accept", source: "config", reason_type: "mode" } }],
            };
          }
        };
        const nextCallEnded = () => new Promise<void>((resolve) => (callEnded = resolve));
        if (failKind && ++callNumber === failingCall) {
          yield* failedCall(failKind);
          return;
        }
        // Opus 5.5 may say what it is about to do first: a text block before the calls (a live probe with a subscription).
        const preamble = stepIndex === 0 ? state.toolPreamble : undefined;
        state.toolPreamble = undefined;
        if (!(yield* modelCall([...(preamble ? [{ type: "text", text: preamble }] : []), ...toolUses], "tool_use", undefined, start, { write: writeEnded, next: nextCallEnded }))) {
          query.outcome = "stopped";
          return;
        }
        if (failure === "killedWhileTool") {
          // The process dies while its calls run (the second failures probe "killed-while-tool"): the
          // file holds the calls and no result; the SDK throws.
          query.outcome = "killed";
          throw new Error("Claude Code process terminated by signal SIGKILL");
        }
        // Each call's result is written and streamed as soon as the call ended, whatever the order of the calls
        // (the two-calls probe, CLI 2.1.312), its parent the call's own record: of two results only the last
        // written lies on the parent line (the loader puts the other back, `chainTo`).
        while (written.size < calls.length) {
          yield* writeEnded();
          if (written.size === calls.length) break;
          const next = await Promise.race([nextCallEnded(), interrupted]);
          if (next === "interrupted") break;
        }
        if (callsStarted !== undefined) spent.toolMs += Math.round(performance.now() - callsStarted);
        if (written.size < calls.length) {
          // Probe 41 and the interrupt probe "parked" (CLI 2.1.312): a rejected result for every call
          // of the step, each written and streamed, then the CLI's interruption record, an error
          // result `aborted_tools`, and the process exits with code 1. A call that had ended keeps its result;
          // the rejected ones follow in the order of the calls, each hung off its own call's record as a result
          // is (the two-calls-interrupt probe, five cases).
          for (const [k, toolUse] of toolUses.entries()) {
            if (written.has(k)) continue;
            const uuid = randomUUID();
            const content = [{ type: "tool_result", content: REJECTED_TOOL_USE, is_error: true, tool_use_id: toolUse.id }];
            const useRecord = records(name).findLast((r) => r.type === "assistant" && r.message?.content?.[0]?.id === toolUse.id)?.uuid;
            write(name, {
              type: "user", uuid, parentUuid: useRecord ?? parent, sessionId: name, toolUseResult: "User rejected tool use",
              ...(useRecord ? { sourceToolAssistantUUID: useRecord } : {}),
              message: { role: "user", content },
            });
            parent = uuid;
            yield { type: "user", uuid, session_id: name, parent_tool_use_id: null, message: { role: "user", content }, tool_use_result: "User rejected tool use" };
          }
          // The first call's full snapshot behind the rejected results too (cli-contract-live check 20).
          afterModelCall();
          yield* interruptedTurn("[Request interrupted by user for tool use]", "aborted_tools", "tool_use");
          return;
        }
        if (failure === "killedBeforeFlush") {
          // The process dies right after its results' events, before it flushed what it wrote: the CLI writes its
          // file in batches some 50-130 ms after the events (the killed-after-result probe "on-event", "on-request",
          // "resumed"; the stop-lag probe "flush"), so the file is as the process found it - no file at all for a
          // new session - though the reader saw the turn's question, calls and results. The SDK throws.
          if (fileAtStart) writeFileSync(fileOf(name), fileAtStart);
          else rmSync(fileOf(name), { force: true });
          query.outcome = "killed";
          throw new Error("Claude Code process terminated by signal SIGKILL");
        }
        // Behind the last result, after every call of the step ended, whenever the message came (the two-calls probe:
        // before the first result or between the two, priority "next" or none): the first call's full snapshot; a
        // message the user sent while the calls ran, absorbed into the turn as an attachment carrying the message's
        // uuid (its queue line written as it came, removed now); the tokens left before the next call.
        afterModelCall();
        callsRunning = false;
        const absorbed = incoming.splice(0);
        for (const message of absorbed) {
          params.commands?.absorbed(message);
          if (!enqueued.has(message)) queueOperation("enqueue", message.message?.content);
          attach({ type: "queued_command", prompt: contentText(message.message?.content), source_uuid: message.uuid });
        }
        // The removal names the message (the two-calls probe: its text, the reason, its uuid as `commandUuid`).
        for (const message of absorbed) queueOperation("remove", message.message?.content, { reason: "absorbed_mid_turn", ...(message.uuid ? { commandUuid: message.uuid } : {}) });
        attachTokensLeft(totals.input_tokens + totals.cache_read_input_tokens + totals.cache_creation_input_tokens + totals.output_tokens);
        if (failure === "killedAfterResult") {
          // The process dies once its results are on disk (the killed-after-result probe "on-line"): the results,
          // the full snapshot, the tokens left and the next model request's lines, then nothing - no answer, no
          // `last-prompt`, no `cost-state`. The SDK throws.
          await requestLines();
          query.outcome = "killed";
          throw new Error("Claude Code process terminated by signal SIGKILL");
        }
        turns = 2;
      }
      if (failure === "killedAfterResult" || failure === "killedBeforeFlush") throw new Error(`state.failures "${failure}" needs a tool step (state.toolTurn or state.toolSteps)`);
      if (gate) await Promise.race([gate, interrupted]);
      // Interrupted before the answer reached the reader, while the CLI had some of it (`unreadAtStop`;
      // the stop-lag probe "first-piece"): the answer goes on as far as the CLI had it, then the stop.
      if (interruptRequested && !closed && unread > 0) stopAt = unread;
      // Interrupted before the answer started (the interrupt probe "waiting"): the record, no answer.
      else if (interruptRequested && !closed) {
        yield* interruptedTurn("[Request interrupted by user]", "aborted_streaming", null);
        return;
      }
      if (closed) {
        query.outcome = "stopped";
        return;
      }
      if (failKind && ++callNumber === failingCall) {
        yield* failedCall(failKind);
        return;
      }
      if (failKind) throw new Error(`state.failingCall ${failingCall}: the turn made only ${callNumber} model calls`);
      const compaction = state.compactBeforeAnswer ?? (reactive ? {} : undefined);
      state.compactBeforeAnswer = undefined;
      if (compaction) {
        // The CLI's auto compaction (the open-cases probe "compact-reactive", CLI 2.1.312): the API refuses the turn's
        // request as too long (its request lines, no record), then a boundary off the chain (parentUuid null,
        // logicalParentUuid the last record) whose metadata keeps the turn's own records as the preserved segment
        // (from its question to the last record), the part's context and date, the summary as a user record,
        // then its environment, model and partial snapshot, and the answer. The summary's own model call writes
        // nothing in the file. The model then reads the summary, then the preserved records (`sinceCompaction`).
        // After a tool step (the too-long probe "tool-then-too-long"): nothing kept verbatim - no preserved
        // segment, the summary alone (its text names the tools used, no note on kept messages), then environment and
        // model before the part's context and date; one more turn in the result either way.
        const afterTool = steps.length > 0;
        await requestLines();
        modelCalls++;
        turns++;
        yield { type: "system", subtype: "status", status: "requesting", session_id: name, uuid: randomUUID() };
        const boundary = randomUUID();
        const summary = randomUUID();
        const logicalParent = parent!;
        const preservedChain = chainTo(name, logicalParent);
        const preserved = afterTool ? [] : preservedChain.slice(Math.max(0, preservedChain.findIndex((r) => r.uuid === trigger)));
        const segment = { headUuid: preserved[0]?.uuid ?? logicalParent, anchorUuid: summary, tailUuid: logicalParent };
        const metadata = { trigger: "auto", preTokens: Math.ceil(view.join("\n").length / 4), postTokens: 500, cumulativeDroppedTokens: 0, durationMs: 1, ...(afterTool ? {} : { preservedSegment: segment }) };
        // The tools the conversation called before, in the order first called (the CLI's tools-used record).
        const usedTools = [...new Set(sinceCompaction(preservedChain).flatMap((r) => (r.type === "assistant" && Array.isArray(r.message?.content) ? r.message.content.filter((b: any) => b.type === "tool_use").map((b: any) => String(b.name)) : [])))];
        yield { type: "system", subtype: "status", status: "compacting", compact_output_chars: 0, session_id: name, uuid: randomUUID() };
        write(name, { type: "system", subtype: "compact_boundary", uuid: boundary, parentUuid: null, logicalParentUuid: logicalParent, sessionId: name, content: "Conversation compacted", isMeta: false, level: "info", compactMetadata: metadata });
        parent = boundary;
        if (!afterTool) {
          attach({ type: "session_context", context: {} });
          attachDate();
        }
        const summaryText = compactSummaryText(compaction.summary ?? "the earlier conversation.", fileOf(name), { tools: usedTools, kept: !afterTool });
        write(name, { type: "user", uuid: summary, parentUuid: parent, sessionId: name, isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: summaryText } });
        yield { type: "system", subtype: "status", status: null, compact_result: "success", session_id: name, uuid: randomUUID() };
        const preservedUuids = preserved.map((r) => r.uuid!);
        yield {
          type: "system", subtype: "compact_boundary", uuid: boundary, session_id: name, logical_parent_uuid: logicalParent,
          compact_metadata: {
            trigger: "auto", pre_tokens: metadata.preTokens, post_tokens: metadata.postTokens, cumulative_dropped_tokens: 0, duration_ms: 1,
            ...(afterTool
              ? {}
              : {
                  preserved_segment: { head_uuid: segment.headUuid, anchor_uuid: summary, tail_uuid: logicalParent },
                  preserved_messages: { anchor_uuid: summary, uuids: preservedUuids, all_uuids: preservedUuids },
                }),
          },
        };
        yield { type: "user", uuid: summary, session_id: name, parent_tool_use_id: null, isReplay: false, isSynthetic: true, message: { role: "user", content: [{ type: "text", text: summaryText }] } };
        parent = summary;
        afterRecord();
        if (afterTool) {
          attach({ type: "session_context", context: {} });
          attachDate();
        }
        attach(partialSnapshot());
        view.length = 0;
        view.push(summaryText, ...preserved.map(recordText));
        // What Claude saw for the answer: the compacted chat.
        query.view = view.filter((text) => text.trim()).join("\n");
      }
      if (state.malformedToolUse) {
        state.malformedToolUse = false;
        // The answer the CLI takes back: streamed, not written; what it writes next hangs off its uuid.
        retracting = true;
        const streamed = yield* modelCall([{ type: "text", text: MALFORMED_TOOL_USE_TEXT }], "tool_use");
        retracting = false;
        if (!streamed) {
          query.outcome = "stopped";
          return;
        }
        parent = lastBlockUuid ?? parent;
        afterModelCall();
        const note = randomUUID();
        write(name, { type: "user", uuid: note, parentUuid: parent, sessionId: name, isMeta: true, message: { role: "user", content: MALFORMED_TOOL_USE_NOTE } });
        parent = note;
        yield { type: "user", uuid: note, session_id: name, parent_tool_use_id: null, isMeta: true, message: { role: "user", content: [{ type: "text", text: MALFORMED_TOOL_USE_NOTE }] } };
      }
      const text = nextReply(token);
      const thinking = state.thinking;
      const blocks = [...(thinking !== undefined ? [{ type: "thinking", thinking, signature: THINKING_SIGNATURE }] : []), { type: "text", text }];
      // A process stopped while the answer streams writes no answer record (probe 40).
      if (!(yield* modelCall(blocks, "end_turn", midAnswer))) {
        query.outcome = "stopped";
        return;
      }
      const uuid = parent!;
      // The first model call's full snapshot behind the answer: the chain's end is then that record, not the answer.
      afterModelCall();
      turnEnded(promptText);
      answers.set(token, { name, uuid });
      query.outcome = "answered";
      // A window that changed with this answer (a live probe with a subscription: `allowed_warning` after `message_stop`).
      for (const info of state.rateLimitEventsAfter.splice(0)) yield { type: "rate_limit_event", rate_limit_info: info, uuid: randomUUID(), session_id: name };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: turns,
        result: text,
        stop_reason: "end_turn",
        user_message_uuid: trigger,
        ...resultUsage(),
        session_id: name,
      };
    };
    const ended = async function* () {
      try {
        yield* turn();
      } finally {
        // A copy that took no message still holds its chain.
        writeCopy();
        query.endedAt = performance.now();
      }
    };
    const handle = handleOf(ended(), () => {
      closed = true;
      query.closedAt ??= performance.now();
    });
    handle.interrupt = async () => interrupt();
    return handle;
  };

  /** A summary or a side question (`persistSession: false`): an in-memory fork, or the history as text; nothing written. */
  const summary = async (params: QueryParams) => {
    const { fileOf, leafOf, chainTo, onLeafChain, records } = dirOf(params);
    const name = params.resume ?? "";
    const query: ClaudeQuery = { kind: "summary", name, at: null, view: "", outcome: "", input: [], startedAt: performance.now(), promptChars: 0, params: paramsOf(params) };
    queries.push(query);
    params.onQuery?.(query);
    if (params.resume) {
      if (!existsSync(fileOf(name))) {
        query.outcome = "refused: no conversation";
        return refusal(name, `No conversation found with session ID: ${name}`);
      }
      if (params.resumeSessionAt && !onLeafChain(name, params.resumeSessionAt)) {
        query.outcome = "refused: no message";
        return refusal(name, `No message found with message.uuid ${params.resumeSessionAt}`);
      }
      query.at = params.resumeSessionAt ?? leafOf(name)?.uuid ?? null;
    }
    const view: string[] = query.at ? sinceCompaction(chainTo(name, query.at)).map(recordText) : [];
    if (typeof params.prompt === "string") {
      query.input.push({ content: params.prompt, noTurn: false, readAt: performance.now() });
      view.push(params.prompt);
      query.promptChars += params.prompt.length;
    } else {
      // The CLI takes its input as it comes and answers the first message with a turn: the input stays open (the
      // SDK closes it after the result), so the query reads up to that message, not to the input's end.
      const input = params.prompt[Symbol.asyncIterator]();
      for (let next = await input.next(); !next.done; next = await input.next()) {
        const message = next.value as any;
        params.commands?.read(message);
        params.commands?.taken(message);
        query.input.push({ content: message.message?.content, uuid: message.uuid, noTurn: message.shouldQuery === false, readAt: performance.now() });
        view.push(textOf(message.message?.content));
        query.promptChars += contentText(message.message?.content).length;
        if (message.shouldQuery !== false) break;
      }
    }
    query.view = view.filter((text) => text.trim()).join("\n");
    const failure = state.summaryFailures.shift();
    if (failure === "maxTurns") {
      // The model asked for a tool in a query of one step (the second failures probe "max-turns-meta"):
      // the call's block, the call runs (the plugin's tool, when the query lists it), then `error_max_turns`,
      // and the SDK throws.
      query.outcome = "maxTurns";
      const text = "Reached maximum number of turns (1)";
      return handleOf(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "summary" };
          const toolUse = { type: "tool_use", id: "toolu_sim_meta", name: "mcp__opencode__bash", input: { command: "ls" } };
          yield { type: "assistant", session_id: "summary", parent_tool_use_id: null, message: { role: "assistant", content: [toolUse] } };
          const listed = params.mcp?.servers.includes("opencode") ? (await listPluginTools(params)).some((tool) => tool.name === "bash") : false;
          if (listed) {
            const result = await callPluginTool(params, "bash", toolUse.input, toolUse.id).catch((error: unknown) => ({ content: [{ type: "text", text: String(error) }], isError: true }));
            const content = [{ tool_use_id: toolUse.id, type: "tool_result", content: result.content.map(blockOfMcp) }];
            yield { type: "user", session_id: "summary", parent_tool_use_id: null, message: { role: "user", content }, tool_use_result: content[0]!.content };
          }
          yield { type: "result", subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns", errors: [text], stop_reason: "tool_use", num_turns: 2, session_id: "summary" };
          throw new Error(`Claude Code returned an error result: ${text}`);
        })(),
      );
    }
    // Refused as too long with the CLI's auto compaction on (the too-long probe "side-too-long"): the side query
    // compacts as a turn does and answers - writing nothing: the boundary keeps the query's question verbatim, the
    // summary names no transcript; one more turn in the result. Off: it fails as the API did.
    const compacted = failure === "promptTooLong" && autoCompactOn(params);
    if (failure && !compacted && failure !== "refusal" && failure !== "maxTokens") {
      // The same failure a chat turn gets (API_FAILURES); nothing is written for a summary.
      const shape = { ...API_FAILURES[failure], text: failureText(API_FAILURES[failure], params) };
      query.outcome = failure;
      const message = { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: shape.text }] };
      return handleOf(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "summary" };
          for (let attempt = 1; attempt <= shape.retries; attempt++) yield { type: "system", subtype: "api_retry", error_status: shape.status, attempt, max_retries: shape.retries, error: shape.retryError };
          yield { type: "assistant", error: shape.error, message: { ...message, usage: SYNTHETIC_USAGE }, session_id: "summary" };
          yield { type: "result", subtype: "success", is_error: true, result: shape.text, terminal_reason: shape.terminal, stop_reason: "stop_sequence", api_error_status: shape.status, num_turns: 1, session_id: "summary" };
          throw new Error(`Claude Code returned an error result: ${shape.text}`);
        })(),
      );
    }
    query.outcome = "answered";
    const text = state.summaryReplies.shift() ?? "## Objective\n- the summary";
    const question = query.input.at(-1)?.content;
    const usedTools = query.at ? [...new Set(sinceCompaction(chainTo(name, query.at)).flatMap((r) => (r.type === "assistant" && Array.isArray(r.message?.content) ? r.message.content.filter((b: any) => b.type === "tool_use").map((b: any) => String(b.name)) : [])))] : [];
    const summaryText = compacted ? compactSummaryText("the earlier conversation.", undefined, { tools: usedTools }) : "";
    if (compacted) query.view = [summaryText, textOf(question)].filter((part) => part.trim()).join("\n");
    // Streamed like a turn's model call: the text in a few deltas, a pause after the block
    // (`blockPauseMs`); a process the plugin closed writes nothing more.
    let closed = false;
    return handleOf(
      (async function* () {
        try {
          yield { type: "system", subtype: "init", session_id: "summary" };
          if (compacted) {
            modelCalls++;
            const head = randomUUID();
            const tail = randomUUID();
            const anchor = randomUUID();
            yield { type: "system", subtype: "status", status: "requesting", session_id: "summary", uuid: randomUUID() };
            yield { type: "system", subtype: "status", status: "compacting", compact_output_chars: 0, session_id: "summary", uuid: randomUUID() };
            yield { type: "system", subtype: "status", status: null, compact_result: "success", session_id: "summary", uuid: randomUUID() };
            yield {
              type: "system", subtype: "compact_boundary", uuid: randomUUID(), session_id: "summary", logical_parent_uuid: tail,
              compact_metadata: {
                trigger: "auto", pre_tokens: Math.ceil(view.join("\n").length / 4), post_tokens: 500, cumulative_dropped_tokens: 0, duration_ms: 1,
                preserved_segment: { head_uuid: head, anchor_uuid: anchor, tail_uuid: tail },
                preserved_messages: { anchor_uuid: anchor, uuids: [head, tail], all_uuids: [head, tail] },
              },
            };
            yield { type: "user", uuid: anchor, session_id: "summary", parent_tool_use_id: null, isSynthetic: true, message: { role: "user", content: [{ type: "text", text: summaryText }] } };
            yield { type: "system", subtype: "status", status: "requesting", session_id: "summary", uuid: randomUUID() };
          }
          const stream = (event: Record<string, unknown>) => ({ type: "stream_event", event, session_id: "summary", parent_tool_use_id: null });
          const usage = callUsage(Math.ceil(query.view.length / 4), Math.ceil(text.length / 4));
          const id = `msg_sim_${++modelCalls}`;
          yield stream({ type: "message_start", message: { id, type: "message", role: "assistant", model: params.model ?? "claude-sonnet-5-5", content: [], usage: usage.opening } });
          yield stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
          for (const piece of piecesOf(text)) {
            yield stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
            if (closed) {
              query.outcome = "stopped";
              return;
            }
          }
          yield { type: "assistant", session_id: "summary", parent_tool_use_id: null, message: { id, type: "message", role: "assistant", model: params.model ?? "claude-sonnet-5-5", content: [{ type: "text", text }], usage: usage.opening, stop_reason: null } };
          yield stream({ type: "content_block_stop", index: 0 });
          if (state.blockPauseMs > 0) await new Promise((resolve) => setTimeout(resolve, state.blockPauseMs));
          if (closed) {
            query.outcome = "stopped";
            return;
          }
          yield stream({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: usage.delta });
          yield stream({ type: "message_stop" });
          // A side query counts on the session it resumes and writes no cost of its own (the open-cases probe "usage-copy-and-side").
          const spend = sessionSpend(params.resume && existsSync(fileOf(name)) ? records(name) : []);
          spend.add(String(params.model ?? "claude-sonnet-5-5"), usage.tokens, usage.thinking);
          // The compaction's own summary call counts on the session's totals, not on the result's usage (the probe).
          if (compacted) spend.add(String(params.model ?? "claude-sonnet-5-5"), { input_tokens: Math.ceil(view.join("\n").length / 4), cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 7 });
          yield { type: "result", subtype: "success", is_error: false, num_turns: compacted ? 2 : 1, result: text, stop_reason: "end_turn", usage: usage.final, ...spend.result(), session_id: "summary" };
        } finally {
          query.endedAt = performance.now();
        }
      })(),
      () => {
        closed = true;
        query.closedAt ??= performance.now();
      },
    );
  };

  /**
   * The CLI processes' other end. The plugin's real starter and the real SDK start the simulated CLI
   * (claude-cli.mjs) for every query, as they start Claude Code; the process connects here
   * (`OPENCODE_CLAUDE_SIMULATOR_HOST`, the address this returns) and the query runs in this process
   * (`runQuery`), reading what the SDK really handed the CLI: the arguments, folder and environment of the
   * process, `initialize` (system prompt, MCP servers), the input. The process writes what the query answers;
   * the plugin's MCP tools are called back through the SDK (`mcp_message`); the user's stop arrives as the SDK's
   * `interrupt`; the SDK's `close()` ends the process. How a query ends becomes how the process ends, which the
   * SDK then reports as it does for Claude Code: a failure's result and exit code 1 ("Claude Code returned an
   * error result: …"), an exit code, a signal, a text on stderr. What the SDK does without a process (main's
   * revert through `forkSession`) stays the real SDK, reading the files this simulator writes.
   */
  const serve = async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      hostProcess(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      address: `127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    };
  };

  /** One CLI process: its frames (claude-cli.mjs `link`), its query, its end. */
  const hostProcess = (socket: Socket) => {
    socket.setEncoding("utf8");
    const out = (frame: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(JSON.stringify(frame) + "\n");
    };
    const send = (message: unknown) => out({ stdout: message });
    let start: { args: string[]; cwd: string; env: Record<string, string | undefined>; pid: number } | undefined;
    let initialize: Record<string, any> | undefined;
    let handle: ReturnType<typeof handleOf> | undefined;
    let query: ClaudeQuery | undefined;
    /** The query: not begun, running, or ended (its stream finished). */
    let phase: "waiting" | "running" | "ended" = "waiting";
    let inputEnded = false;
    let gone = false;
    let exited = false;
    const exit = (frame: { exit?: number; kill?: string; stderr?: string }) => {
      if (exited) return;
      exited = true;
      if (frame.stderr) out({ stderr: frame.stderr });
      out(frame.kill ? { kill: frame.kill } : { exit: frame.exit ?? 0 });
    };
    // The input as the CLI reads it: the user messages, in order.
    const waiting: any[] = [];
    let wake: (() => void) | undefined;
    const input: AsyncIterable<any> = {
      [Symbol.asyncIterator]: () => ({
        async next() {
          while (waiting.length === 0 && !inputEnded && !gone) await new Promise<void>((resolve) => (wake = resolve));
          return waiting.length > 0 ? { value: waiting.shift(), done: false } : { value: undefined, done: true };
        },
      }),
    };
    const awake = () => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    // The CLI's own requests to the SDK (the plugin's MCP servers), answered by `control_response`.
    const pending = new Map<string, { resolve: (response: any) => void; reject: (error: Error) => void }>();
    const controlRequest = (request: Record<string, unknown>) =>
      new Promise<any>((resolve, reject) => {
        if (gone) return reject(new Error("the CLI process has ended"));
        const id = `sim_${randomUUID()}`;
        pending.set(id, { resolve, reject });
        send({ type: "control_request", request_id: id, request });
      });
    let rpcId = 0;
    const rpc = async (server: string, method: string, rpcParams?: Record<string, unknown>, notification = false) => {
      const message = { jsonrpc: "2.0", ...(notification ? {} : { id: ++rpcId }), method, ...(rpcParams ? { params: rpcParams } : {}) };
      const reply = (await controlRequest({ subtype: "mcp_message", server_name: server, message }))?.mcp_response;
      if (reply?.error) throw new Error(`MCP ${method} of ${server}: ${reply.error.message ?? JSON.stringify(reply.error)}`);
      return reply?.result;
    };
    const lists = new Map<string, Promise<Array<Record<string, any>>>>();
    const mcp: McpChannel = {
      servers: [],
      list(server) {
        let listed = lists.get(server);
        if (!listed) {
          listed = (async () => {
            // SDK 0.3.300 hands the servers' manifests with `initialize` (its own handshake in process); without one
            // the CLI makes the handshake over the control channel.
            let manifest = initialize?.sdkMcpServerManifests?.[server];
            if (typeof manifest === "string") manifest = JSON.parse(manifest);
            if (Array.isArray(manifest?.toolsListResult?.tools)) return manifest.toolsListResult.tools;
            await rpc(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: CLI_VERSION } });
            await rpc(server, "notifications/initialized", undefined, true);
            return (await rpc(server, "tools/list"))?.tools ?? [];
          })();
          lists.set(server, listed);
        }
        return listed;
      },
      call: (server, name, args, toolUseId) =>
        rpc(server, "tools/call", { name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId } }),
    };
    /** How the query ended → how the process ends (the SDK's own texts come from it). */
    const ended = (error?: unknown) => {
      phase = "ended";
      if (error === undefined) {
        if (inputEnded) exit({ exit: 0 });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const stderr = (error as { stderr?: string })?.stderr;
      if (/^Claude Code returned an error result: /.test(message)) return exit({ exit: 1, stderr });
      const code = /^Claude Code process exited with code (\d+)$/.exec(message);
      if (code) return exit({ exit: Number(code[1]), stderr });
      const signal = /^Claude Code process terminated by signal (\w+)$/.exec(message);
      if (signal) return exit({ kill: signal[1] });
      // The simulator's own complaint (a behaviour it lacks): loud, as claude-cli.mjs `fail`.
      exit({ exit: 70, stderr: `${message}\n` });
    };
    const begin = () => {
      if (phase !== "waiting" || !start || !initialize) return;
      phase = "running";
      mcp.servers = Array.isArray(initialize.sdkMcpServers) ? initialize.sdkMcpServers : [];
      const params = paramsOfProcess(start, initialize, input, mcp);
      const partial = params.includePartialMessages === true;
      /**
       * The input's commands (the lifecycle probe: the real CLI 2.1.312 and SDK
       * 0.3.300): a message with a uuid is `queued` when the CLI reads it, `started` when it takes it (a record,
       * a question, a message absorbed mid-turn), and after the result that ends it `completed` — `cancelled`
       * after an error result or a stop. A message without a uuid has none. The SDK keeps an error result's text
       * only while nothing follows it: with a uuid the process's exit code 1 is what it throws.
       */
      params.onQuery = (logged) => (query = logged);
      let session = String(params.sessionId ?? params.resume ?? "");
      let current: string | undefined;
      const absorbed: string[] = [];
      const lifecycle = (uuid: string, state: string) => send({ type: "command_lifecycle", command_uuid: uuid, state, uuid: randomUUID(), session_id: session });
      params.commands = {
        read: (message) => message?.uuid && lifecycle(message.uuid, "queued"),
        taken: (message) => {
          if (!message?.uuid) return;
          lifecycle(message.uuid, "started");
          current = message.uuid;
        },
        absorbed: (message) => {
          if (!message?.uuid) return;
          lifecycle(message.uuid, "started");
          absorbed.push(message.uuid);
        },
      };
      void (async () => {
        try {
          handle = await runQuery(params);
          if (gone) handle.close();
          for await (const message of handle.stream as AsyncIterable<any>) {
            // Partial messages only when the SDK asked for them (`--include-partial-messages`).
            if (message?.type === "stream_event" && !partial) continue;
            if (typeof message?.session_id === "string" && message.session_id) session = message.session_id;
            if (message?.type !== "result") {
              send(message);
              continue;
            }
            // A record's confirmation ends its command; a turn's result ends the absorbed ones, then the turn's.
            const record = message.num_turns === 0 && message.result === "" && message.user_message_uuid;
            if (!record) for (const uuid of absorbed.splice(0)) lifecycle(uuid, "completed");
            send(message);
            if (current) lifecycle(current, message.is_error ? "cancelled" : "completed");
            current = undefined;
          }
          ended();
        } catch (error) {
          ended(error);
        }
      })();
    };
    const onFrame = (frame: Record<string, any>) => {
      if (frame.start) start = frame.start;
      if (frame.initialize) {
        initialize = frame.initialize;
        // A query with a model or a transcript is a turn, a title or a summary; one with neither (the model list
        // read in the background) begins only if a message comes.
        if (start && (flagValue(start.args, "--model") !== undefined || !start.args.includes("--no-session-persistence"))) begin();
      }
      const message = frame.stdin;
      if (message?.type === "user") {
        if (phase === "ended") {
          // One turn a process here: a second question in the same process is not modelled.
          exit({ exit: 70, stderr: "the Claude Code simulator does not model a second turn in one CLI process (add it from a probe)\n" });
          return;
        }
        waiting.push(message);
        begin();
        awake();
      }
      if (message?.type === "control_request" && message.request?.subtype === "interrupt") {
        // The stop is confirmed at once (the interrupt probe), then the turn ends as the CLI ends it.
        send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
        if (handle) void handle.interrupt();
        else if (phase === "waiting") {
          // Stopped before any turn began: as CLI 2.1.312 before an answer — the record, `aborted_streaming`, exit 1.
          send({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, parent_tool_use_id: null, session_id: "sim", uuid: randomUUID() });
          send({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", stop_reason: null, errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"], session_id: "sim", uuid: randomUUID() });
          exit({ exit: 1 });
        }
      }
      if (message?.type === "control_response") {
        const response = message.response ?? {};
        const waiter = pending.get(response.request_id);
        pending.delete(response.request_id);
        if (response.subtype === "error") waiter?.reject(new Error(String(response.error)));
        else waiter?.resolve(response.response);
      }
      if (frame.end) {
        // The SDK ended the input: the plugin closed the query (`close()`; the SDK kills the process 2 s later, on
        // Windows 7 s, if it is still there) or its prompt ended. The CLI finishes what it is doing, then exits.
        inputEnded = true;
        if (query) query.closedAt ??= performance.now();
        awake();
        if (phase !== "running") exit({ exit: 0 });
      }
    };
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (line.trim()) onFrame(JSON.parse(line));
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      // The process is gone (the SDK closed or killed it): the query writes nothing more.
      gone = true;
      awake();
      handle?.close();
      for (const waiter of pending.values()) waiter.reject(new Error("the CLI process has ended"));
      pending.clear();
    });
  };

  /**
   * The plugin's real query starter as the world installs it: `state.holdStart` holds a start before it (a slow
   * start), then the starter runs as it is.
   */
  let heldStarts = 0;
  const starter = (real: (params: Record<string, any>) => Promise<unknown>) => async (params: Record<string, any>) => {
    const gate = state.holdStart;
    state.holdStart = undefined;
    if (gate) {
      heldStarts++;
      await gate;
    }
    return real(params);
  };

  /**
   * A query through the real SDK into the world's CLI (its `install`): the SDK options as a test names them
   * (`prompt`, `model`, `sessionId`, `resume`, `resumeSessionAt`, `forkSession`, `persistSession`, `settings`,
   * `mcpServers`…), partial messages on, no setting sources. The simulator's own checks drive it the way the
   * plugin's starter does.
   */
  const chat = async (options: Record<string, any>) => {
    assert.ok(primary?.executable, "installCli first");
    const sdk: any = await import("@anthropic-ai/claude-agent-sdk");
    const { prompt, env, ...rest } = options;
    const executable = primary.executable;
    const before = queries.length;
    const q = sdk.query({
      prompt,
      options: {
        includePartialMessages: true,
        settingSources: [],
        ...rest,
        env: { ...process.env, ...env },
        pathToClaudeCodeExecutable: executable,
        ...(/\.(c|m)?js$/i.test(executable) ? { executable: "node" } : {}),
      },
    });
    // Returned once the process reached the simulator and the query began (`claude.queries` holds it).
    if (options.model !== undefined || options.persistSession !== false) {
      for (let waited = 0; queries.length === before; waited += 5) {
        if (waited > 15_000) throw new Error("the SDK's CLI process did not reach the simulator in 15 s");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    return { stream: q as AsyncIterable<unknown>, interrupt: () => q.interrupt(), close: () => q.close(), getPid: () => null };
  };

  /** What a test turns on one install of the CLI: its answers, and its starts. */
  const cliHandle = (home: string | undefined, executable: string | undefined) => ({
    /** The folder the install keeps its state in (undefined: an install that cannot run). */
    home,
    /** The program the install runs (npm's `cli.js`, or the executable). */
    executable,
    /** Changes what the next starts of this install answer (the fields given; `undefined` restores the probed answer). */
    set(patch: CliState) {
      assert.ok(home, "this install of the CLI cannot run");
      const file = join(home, "state.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
    },
    /**
     * Every start of this install: its arguments, the profile folder it ran with, what ran it (`runner`: node
     * or the executable), and for a start by the SDK the `initialize` request it got (what the plugin's
     * options became: system prompt, MCP servers, `excludeDynamicSections`…).
     */
    calls(): Array<{ args: string[]; configDir: string; at: number; runner?: string; initialize?: Record<string, any> }> {
      if (!home || !existsSync(join(home, "calls.jsonl"))) return [];
      return readFileSync(join(home, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    /**
     * Every control request a started process answered (`subtype`, `model` of a `set_model`, `detail`), and
     * `end: "stdin-closed"` when its input ended (the SDK's `close()`); `pid` tells the processes apart.
     */
    controls(): Array<{ pid: number; at: number; subtype?: string; model?: string; detail?: string; end?: string }> {
      if (!home || !existsSync(join(home, "controls.jsonl"))) return [];
      return readFileSync(join(home, "controls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  });
  /** The CLI on the world's PATH: the first install (`claude.cli`). */
  let primary: ReturnType<typeof cliHandle> | undefined;
  /**
   * Puts the CLI process in `binDir` as `layout` installs it; its state starts
   * as the probed CLI. The first install is the world's (`claude.cli`); each
   * returns its own handle. `existing`: the install another process of the
   * same machine laid out there (`createWorld(label, { machine })`): a handle
   * on it as it is, its state and its log shared.
   */
  const installCli = (binDir: string, options: { layout?: CliLayout; existing?: boolean } = {}) => {
    if (options.existing) {
      const home = homeOfCli(binDir, options.layout);
      assert.ok(!home || existsSync(join(home, "state.json")), `no CLI laid out in ${binDir}`);
      const handle = cliHandle(home, home ? executableOf(binDir, options.layout) : undefined);
      primary ??= handle;
      return handle;
    }
    const home = layOutCli(binDir, options.layout);
    if (home) {
      writeFileSync(join(home, "state.json"), "{}");
      // Where the process finds the answers when its environment lacks the world's variable (claude-cli.mjs).
      writeFileSync(join(home, "answers-path.txt"), cliAnswersPath());
    }
    const handle = cliHandle(home, home ? executableOf(binDir, options.layout) : undefined);
    primary ??= handle;
    return handle;
  };
  /**
   * The plugin's installers as the simulator's processes in `binDir` (the
   * world's bin by default): `curl` and `bash` (the official script: it puts
   * `claude` in ~/.local/bin), and `npm` where the plugin can start it — not
   * on Windows, where npm is a `.cmd` the plugin cannot spawn without a shell.
   * Absent until installed: a host without them.
   */
  let installersDir: string | undefined;
  const installers = {
    install(binDir: string) {
      installersDir = binDir;
      const exe = process.platform === "win32" ? ".exe" : "";
      for (const command of process.platform === "win32" ? ["curl", "bash"] : ["npm", "curl", "bash"]) {
        const at = join(binDir, `${command}${exe}`);
        mkdirSync(binDir, { recursive: true });
        try {
          linkSync(compiledCli(), at);
        } catch {
          copyFileSync(compiledCli(), at);
        }
      }
      writeFileSync(join(binDir, "installers.json"), "{}");
    },
    /** What each installer does next: "ok" (the default), "fail" (exit 1), "hang". */
    set(plan: Partial<Record<"npm" | "curl" | "bash", "ok" | "fail" | "hang">>) {
      assert.ok(installersDir, "installers.install first");
      const file = join(installersDir, "installers.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...plan }));
    },
    /** Every start of an installer: the command and its arguments. */
    calls(): Array<{ command: string; args: string[]; at: number }> {
      if (!installersDir || !existsSync(join(installersDir, "installer-calls.jsonl"))) return [];
      return readFileSync(join(installersDir, "installer-calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };
  const cli = {
    set: (patch: CliState) => {
      assert.ok(primary, "installCli first");
      primary.set(patch);
    },
    calls: (): ReturnType<ReturnType<typeof cliHandle>["calls"]> => primary?.calls() ?? [],
    controls: (): ReturnType<ReturnType<typeof cliHandle>["controls"]> => primary?.controls() ?? [],
  };

  return {
    projectDir, state, queries, answers,
    fileOf, records, byUuid, leafOf, chainTo, onLeafChain, recordText, snapshot,
    /** Another profile's files (`projects`: its folder of project folders), found in any project folder. */
    filesIn: (projects: string) => filesIn(projects, projects),
    chat, serve, starter, installCli, cli, installers,
    /** How many starts `state.holdStart` held so far. */
    get heldStarts() {
      return heldStarts;
    },
  };
}

export type ClaudeCodeSimulator = ReturnType<typeof createClaudeCodeSimulator>;
