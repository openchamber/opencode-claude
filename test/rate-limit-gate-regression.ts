/**
 * The plan's rate limits on the plugin's proxy: the window notes in an
 * answer's reasoning, the counter a UI reads (GET /v1/rate-limit, /health),
 * the gate that answers OpenCode's retries of a limited request with a real
 * 429 + Retry-After without a doomed Claude Code turn, the limit met after a
 * tool step, and a limit that heals by itself; the limit texts and reset
 * wordings on the plugin's parser.
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): the window events of
 * Claude Code (`claude.state.rateLimitEvents`, the CLI's `rate_limit_event`
 * by its own code, on a sign-in by subscription; not probed live), its 429
 * after its own retries (`failures` "rateLimit"; after a tool step:
 * `failingCall` 2: test/simulators/turns.ts `failingTurn`), OpenCode's
 * retries of a failed request. Each case starts
 * with the plugin's limit store emptied: the window has passed. Independent
 * cases (test/simulators/cases.ts).
 *
 * Run: bun test/rate-limit-gate-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { testCases } from "./simulators/cases.ts";
import { failingTurn } from "./simulators/turns.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

const world = await createWorld("rate-limit-gate");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();
const rateLimit = await pluginModule("rate-limit");
const proxyRoot = String(world.plugin.proxy.getClaudeProxyBaseUrl()).replace(/\/v1$/, "");
/** What a UI reads: the plugin's live counter. */
const counter = async () => (await (await fetch(`${proxyRoot}/v1/rate-limit`)).json()) as Record<string, any>;
const windowPassed = () => rmSync(process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE!, { force: true });
const notesIn = (reasoning: string) => reasoning.match(/\[rate-limit\]/g)?.length ?? 0;
const offeredTools = opencode.state.tools;
const futureSec = Math.floor(Date.now() / 1000) + 5400;

/** Runs `body` as a case with the window passed before it and the simulators' failure switches reset after it. */
const limitCase = (name: string, body: () => Promise<void>) =>
  cases.run(name, async () => {
    windowPassed();
    rateLimit.__resetRateLimitNoteDedupe();
    try {
      await body();
    } finally {
      claude.state.failures = [];
      claude.state.summaryFailures = [];
      claude.state.rateLimitEvents = [];
      claude.state.replies = [];
      claude.state.usage = {};
      claude.state.toolTurn = false;
      claude.state.failingCall = 1;
      opencode.state.tools = offeredTools;
      delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL;
      windowPassed();
      rateLimit.__resetRateLimitNoteDedupe();
    }
  });

/** A hard limit before any content on a new chat (Claude Code's 429 after its own retries): the chat and its turn. */
const hitLimit = async () => {
  const chat = opencode.newChat();
  await opencode.say(chat, "hi");
  claude.state.failures = ["rateLimit"];
  const queries = claude.queries.length;
  const turn = await opencode.turn(chat);
  claude.state.failures = [];
  return { chat, turn, queries: claude.queries.length - queries };
};

await cases.run("the limit texts Claude Code writes, their normalization, reset times and the countdown", () => {
  assert.equal(rateLimit.isClaudeRateLimitText("You've hit your session limit · resets 1:10am (Europe/Kyiv)"), true);
  assert.equal(rateLimit.isClaudeRateLimitText("all good"), false);
  assert.equal(
    rateLimit.normalizeClaudeErrorText("Claude Code returned an error result: You've hit your session limit · resets 1:10am (Europe/Kyiv)"),
    rateLimit.normalizeClaudeErrorText("[claude-code error] You've hit your session limit · resets 1:10am (Europe/Kyiv)"),
  );
  // Reset-time parsing (wall clock + IANA zone, ISO, none) and the countdown
  const wallReset = rateLimit.parseResetTimeFromText("You've hit your session limit · resets 1:10am (Europe/Kyiv)");
  assert.ok(wallReset, "expected wall-clock reset parse");
  assert.ok(wallReset! > Date.now(), "reset must be in the future");
  assert.ok(wallReset! <= Date.now() + 26 * 3600_000, "reset must be within 26h");
  assert.equal(rateLimit.parseResetTimeFromText("usage limit reached, resets at 2099-01-02T03:04:05Z"), Date.parse("2099-01-02T03:04:05Z"));
  assert.equal(rateLimit.parseResetTimeFromText("no reset hint"), undefined);
  assert.equal(rateLimit.formatResetCountdown(0), "now");
  assert.equal(rateLimit.formatResetCountdown(3_900_000), "65m");
  assert.match(rateLimit.formatResetCountdown(5_700_000), /^1h 35m$/);
});

await limitCase("a window reported twice the same way: one note, the counter shows it, the turn's tools as aliases", async () => {
  // Events alone never gate.
  const warning = { status: "allowed_warning", resetsAt: futureSec, rateLimitType: "five_hour", utilization: 0.99 };
  opencode.state.tools = { todowrite: { description: "Write the todo list", input: { type: "object", properties: {} } } };
  const chat = opencode.newChat();
  await opencode.say(chat, "plan something");
  claude.state.rateLimitEvents = [warning, { ...warning }];
  claude.state.replies = ["WINDOW-OK"];
  claude.state.usage = { input_tokens: 11, output_tokens: 3 };
  const turn = await opencode.turn(chat);
  assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
  const reply = turn.requests.at(-1)!.reply!;
  assert.equal(reply.text, "WINDOW-OK");
  assert.equal(notesIn(reply.reasoning), 1, `one note for two identical warnings: ${reply.reasoning}`);
  assert.match(reply.reasoning, /99%/);
  assert.equal((reply.usage as { prompt_tokens?: number } | undefined)?.prompt_tokens, 11);

  const window = await counter();
  assert.equal(window.limited, false);
  assert.equal(window.status, "allowed_warning");
  assert.equal(window.utilization, 0.99);
  assert.equal(window.resetsAt, futureSec * 1000);
  const health = (await (await fetch(`${proxyRoot}/health`)).json()) as { rateLimit?: { limited?: boolean; utilization?: number } };
  assert.equal(health.rateLimit?.limited, false);
  assert.equal(health.rateLimit?.utilization, 0.99);

  // The query got the cwd of OpenCode's directory, the tool aliases and the tool note.
  const params = claude.queries.at(-1)!.params as Record<string, any>;
  assert.equal(params.cwd, world.tmp);
  // OpenCode 2 has no todo tools; no Claude Code todo alias or plan nag.
  assert.equal(params.toolAliases?.TodoWrite, undefined);
  assert.equal(params.toolAliases?.todowrite, "mcp__opencode__todowrite");
  const append = String(params.systemPrompt?.append ?? "");
  assert.doesNotMatch(append, /todowrite/);
  assert.match(append, /[Bb]atch independent tool calls/);
  assert.match(append, /^<runtime_info>In case you're asked: you are running in OpenCode through the Claude Code harness/);
  assert.equal(params.systemPrompt?.preset, "claude_code");
});

await limitCase("an allowed event of a new window without utilization does not resurrect the old 99%", async () => {
  // The CLI sends plenty of them: no note, and the counter drops it. Fresh utilization the event itself reports
  // still surfaces.
  const chat = opencode.newChat();
  await opencode.say(chat, "warm up");
  claude.state.rateLimitEvents = [{ status: "allowed_warning", resetsAt: futureSec, rateLimitType: "five_hour", utilization: 0.99 }];
  assert.ok((await opencode.turn(chat)).ok);
  assert.equal((await counter()).utilization, 0.99);

  await opencode.say(chat, "go on");
  claude.state.rateLimitEvents = [{ status: "allowed", resetsAt: futureSec + 3600, rateLimitType: "five_hour" }];
  const quiet = await opencode.turn(chat);
  assert.ok(quiet.ok);
  assert.equal(notesIn(quiet.requests.at(-1)!.reply!.reasoning), 0, "no warning note for an allowed event without fresh utilization");
  const window = await counter();
  assert.equal(window.status, "allowed");
  assert.equal(window.utilization, undefined, "stale utilization must be cleared by an allowed event");

  await opencode.say(chat, "more");
  claude.state.rateLimitEvents = [{ status: "allowed_warning", resetsAt: futureSec + 3600, rateLimitType: "five_hour", utilization: 0.95 }];
  const warned = await opencode.turn(chat);
  assert.ok(warned.ok);
  const reasoning = warned.requests.at(-1)!.reply!.reasoning;
  assert.equal(notesIn(reasoning), 1, "fresh warning noted");
  assert.match(reasoning, /95%/);
});

await limitCase("a hard limit before any content: a real 429, OpenCode's retries answered by the gate without a CLI turn", async () => {
  // Not a fake-200 error stream; the store flips to limited. The subscription's own limit text ("You've hit your
  // session limit · resets …") is not simulated yet: Claude Code's 429 here is the API's.
  const { chat, turn, queries } = await hitLimit();
  const first = turn.requests[0]!;
  assert.equal(first.status, 429, `hard limit must fail fast with 429: ${first.reply?.raw}`);
  assert.ok(first.reply!.headers.get("retry-after"), "429 carries Retry-After");
  const error = JSON.parse(first.reply!.raw!).error as { type?: string; message?: string; code?: string };
  assert.equal(error.type, "rate_limit_error");
  assert.equal(error.code, "claude_session_limit");
  assert.match(error.message ?? "", /rate limit/);
  assert.match(error.message ?? "", /limit resets in/);
  assert.equal(turn.failure?.kind, "rate-limit", "OpenCode reads it as a rate limit");
  assert.ok(turn.requests.length > 1, "OpenCode retried the request");
  for (const retry of turn.requests.slice(1)) {
    assert.equal(retry.status, 429);
    assert.ok(retry.reply!.headers.get("retry-after"));
    const blocked = JSON.parse(retry.reply!.raw!).error as { type?: string; message?: string; retry_after?: number };
    assert.equal(blocked.type, "rate_limit_error");
    assert.match(blocked.message ?? "", /limit resets in/);
    assert.ok((blocked.retry_after ?? 0) > 0);
  }
  assert.equal(queries, 1, "the gate answers OpenCode's retries without a CLI turn");
  assert.ok(world.journal().some((line) => /turn failed fast/.test(line) && /"kind":"rate_limit"/.test(line)));
  assert.ok(world.journal().some((line) => /rate-limit gate blocked a turn/.test(line) && line.includes(chat)));
  // The non-streaming path of the old smoke test is gone: OpenCode 2.0.32 always streams.

  const snap = rateLimit.getRateLimitSnapshot();
  assert.equal(snap.limited, true);
  assert.ok(snap.resetInSeconds !== undefined && snap.resetInSeconds > 0, "expected a countdown while limited");
  const gate = rateLimit.rateLimitGate();
  assert.equal(gate.blocked, true);
  if (gate.blocked) assert.ok(gate.retryAfterSeconds > 0);
  // The counter reports the active limit with its countdown.
  const window = await counter();
  assert.equal(window.limited, true);
  assert.ok((window.resetInSeconds ?? 0) > 0);
  assert.match(window.message ?? "", /rate limit/);
});

await limitCase("a title while the limit holds gets the same 429", async () => {
  // Utility requests run on Claude Code too.
  const { chat } = await hitLimit();
  claude.state.summaryFailures = ["rateLimit"];
  const titled = await opencode.title(chat);
  assert.equal(titled.title, undefined, "no title from a limited account");
  assert.equal(titled.requests[0]?.status, 429, titled.requests[0]?.reply?.raw);
});

await limitCase("the gate's kill switch", async () => {
  await hitLimit();
  assert.equal(rateLimit.rateLimitGate().blocked, true);
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL = "0";
  assert.equal(rateLimit.rateLimitGate().blocked, false);
  delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL;
  assert.equal(rateLimit.rateLimitGate().blocked, true);
});

await limitCase("a stale limit: a new message still reaches Claude once and an allowed event lifts the gate", async () => {
  // The limits were reset early.
  const { chat } = await hitLimit();
  await opencode.say(chat, "limits were reset, go on");
  claude.state.rateLimitEvents = [{ status: "allowed" }];
  claude.state.replies = ["back to work"];
  const queries = claude.queries.length;
  const turn = await opencode.turn(chat);
  assert.ok(turn.ok, `a new message is not gated: ${turn.requests.map((r) => r.status).join(",")}`);
  assert.equal(turn.answer!.text, "back to work");
  assert.equal(claude.queries.length - queries, 1);
  assert.equal(rateLimit.rateLimitGate().blocked, false, "allowed event lifts the gate");
});

await limitCase("the limit after a tool step: a real 429 the gate holds, OpenCode's retry meets the gate", async () => {
  // The limit hits after the run already did work (the model call after a tool step). There is no new user request
  // for the pre-flight gate, so the failure itself must start the timer: the continuation is a real 429 +
  // Retry-After, as before any content. OpenCode retries a request whose answer had not started (BEHAVIOR.md "A
  // failed request"): the gate answers the retry with the stored reset as a real 429 + Retry-After, Claude is not
  // asked again, and the turn ends as a retryable rate limit. Whether the plugin rebuilds the turn before the gate
  // answers fails by a finding: rate-limit-gate-rebuild-log-regression.ts, until it is fixed.
  const { turn, queries } = await failingTurn(world, "rateLimit", 2);
  const [, after, retry] = turn.requests;
  const statuses = turn.requests.map((r) => r.status).join(",");
  assert.equal(after!.status, 429, `the continuation is a real HTTP error: ${after!.reply?.raw}`);
  assert.equal(JSON.parse(after!.reply!.raw!).error.code, "claude_session_limit");
  assert.ok(Number(after!.reply!.headers.get("retry-after")) > 0, "with Retry-After");
  assert.equal(rateLimit.getRateLimitSnapshot().limited, true, "the failure recorded the limit");
  const window = await counter();
  assert.equal(window.limited, true);
  assert.ok((window.resetInSeconds ?? 0) > 0);
  const gate = rateLimit.rateLimitGate();
  assert.equal(gate.blocked, true);
  if (gate.blocked) assert.ok(gate.retryAfterSeconds > 0);
  assert.equal(retry?.status, 429, `OpenCode's retry meets the gate: ${statuses}`);
  assert.ok(Number(retry?.reply?.headers.get("retry-after")) > 0, "the retry gets Retry-After");
  assert.equal(queries.length, 1, "Claude is not asked again");
  assert.equal(turn.failure?.kind, "rate-limit", "OpenCode reads it as a rate limit");
  assert.ok(turn.failure?.retryable, "a retryable one");
});

await limitCase("an expired hard block heals by itself", async () => {
  // A recent `rejected` window event vouches for its reset, the next 429 blocks until then, and once the reset
  // passed the store reads as not limited.
  const chat = opencode.newChat();
  await opencode.say(chat, "hi");
  const resetsAt = Math.floor(Date.now() / 1000) + 3;
  claude.state.rateLimitEvents = [{ status: "rejected", rateLimitType: "five_hour", resetsAt, isUsingOverage: false }];
  assert.ok((await opencode.turn(chat)).ok);
  await opencode.say(chat, "more");
  claude.state.failures = ["rateLimit"];
  const turn = await opencode.turn(chat);
  claude.state.failures = [];
  assert.equal(turn.requests[0]!.status, 429);
  assert.equal(rateLimit.getRateLimitSnapshot().limited, true);
  await Bun.sleep(Math.max(0, resetsAt * 1000 - Date.now()) + 500);
  assert.equal(rateLimit.getRateLimitSnapshot().limited, false, "the reset passed");
  assert.equal(rateLimit.rateLimitGate().blocked, false);
  assert.equal((await counter()).limited, false);
});

await cases.run("no error in the plugin's journal after the limits", () => {
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
