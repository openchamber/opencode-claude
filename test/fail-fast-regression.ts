/**
 * Dead turns get truthful HTTP statuses: a process that dies before any
 * content is a 500 OpenCode sends again, Anthropic's refusal before any
 * content keeps its 4xx and is not sent again, an empty answer is a legit
 * 200, and a model silent past Bun's default idle timeout does not reset the
 * socket. The failure classifier on the plugin's parser. A failure after
 * content (a 200 stream, the text kept, the error noted once) fails by a
 * finding on the chain: turn-error-noted-twice-regression.ts, until it is
 * fixed.
 *
 * On the simulators (BEHAVIOR.md "Failures of a model call"): a user's turn in
 * OpenCode; Claude Code fails the way CLI 2.1.312 reports it
 * (`claude.state.failures`: a synthetic error record, a result with
 * `is_error`, the SDK's throw), and OpenCode reads the answer and retries by
 * its own rules. Waiting for the simulator to learn these (no check of their own
 * until it has them): a signed-out CLI's turn → 401
 * authentication_error claude_auth with the `claude auth login` hint, in one
 * query, not retried; a plain 400 Anthropic refuses the request
 * with → its 400 invalid_request_error before any stream; a 408 /
 * 409 the CLI gives up on → 500 server_error, which OpenCode retries. The old `stream: false` variants are dropped: OpenCode always streams.
 * Independent cases (test/simulators/cases.ts); the turn: test/simulators/turns.ts `failFastTurn`.
 *
 * Run: bun test/fail-fast-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { failFastTurn as failFastTurnOf } from "./simulators/turns.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

const world = await createWorld("fail-fast");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();

const failFastTurn = (ask: string, setup: () => void) => failFastTurnOf(world, ask, setup);

await cases.run("the failure classifier", async () => {
  const { classifyClaudeFailure } = await pluginModule("failure");
  assert.equal(classifyClaudeFailure("token refresh rejected (HTTP 400): invalid_grant"), "auth");
  assert.equal(classifyClaudeFailure("Invalid API key · Please run /login"), "auth");
  assert.equal(classifyClaudeFailure("You've hit your session limit · resets 1:10am"), "rate_limit");
  assert.equal(classifyClaudeFailure("boom"), "unknown");
});

await cases.run("the process dies before any content: 500 server_error, which OpenCode sends again", async () => {
  const { turn, first, error, queries, journal } = await failFastTurn("FF-KILLED", () => (claude.state.failures = ["killed"]));
  assert.equal(first.status, 500, first.reply?.raw);
  assert.equal(error?.type, "server_error");
  assert.equal(first.counted[1] - first.counted[0], 1, "one Claude Code query for the request");
  assert.equal(queries[0]!.outcome, "killed");
  assert.ok(turn.ok, "OpenCode sent it again and the next query answered");
  assert.ok(journal.some((line) => /turn failed fast/.test(line) && /unknown/.test(line)), `the journal records the failed turn: ${journal.join("\n")}`);
});

await cases.run("Anthropic's refusal before any content keeps its 4xx and is not sent again", async () => {
  // A synthetic assistant message whose error is not rate_limit; CLI 2.1.312's 402 "API Error: 402 Payment
  // required…", error "unknown": its 4xx, not a fake 200 carrying "[claude-code error]" as the answer, and not sent
  // again. (Fork ad13d30.)
  const { first, error, retries, journal } = await failFastTurn("FF-REFUSED", () => (claude.state.failures = ["billing"]));
  assert.notEqual(first.status, 200, "not a fake 200");
  assert.match(error?.message ?? "", /Payment required/);
  assert.ok(journal.some((line) => /turn failed fast/.test(line)), `the journal records the failed turn: ${journal.join("\n")}`);
  assert.equal(first.status, 402, `the refusal keeps its 4xx: ${first.reply?.raw}`);
  assert.equal(retries.length, 0, "OpenCode does not send the refusal again");
});

await cases.run("an empty but successful answer is a legit 200 with empty content", async () => {
  const { turn, first, queries, journal } = await failFastTurn("FF-EMPTY", () => (claude.state.replies = [""]));
  assert.equal(first.status, 200, first.reply?.raw);
  assert.equal(first.reply!.text, "");
  assert.equal(first.reply!.finish, "stop");
  assert.ok(turn.ok);
  assert.equal(queries[0]!.outcome, "answered");
  assert.ok(!journal.some((line) => /turn failed fast/.test(line)), "not a failed turn");
});

await cases.run("first content after Bun's default 10 s idle timeout does not reset the socket", async () => {
  // OpenCode surfaces a reset as a retryable "Connection reset by server". Claude Code starts the query, then the
  // model is silent over 11 s (the hold starts a moment before OpenCode sends the request).
  const { turn, first, retries } = await failFastTurn("FF-SLOW", () => (claude.state.hold = new Promise((resolve) => setTimeout(resolve, 11_500))));
  assert.equal(first.status, 200, "probe longer than Bun's 10s default must not RST the socket");
  assert.equal(first.reply!.streamError, undefined);
  assert.match(first.reply!.text, /answer L/);
  assert.ok(turn.ok);
  assert.equal(retries.length, 0, "no retry");
  assert.ok(first.doneAt - first.sentAt >= 11_000, "slow-first-byte test did not actually wait out the default idleTimeout");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
