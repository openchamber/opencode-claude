/**
 * The cases of fail-fast-regression.ts and turn-errors-regression.ts that
 * fail by a finding on the chain (from chain/turn-by-names) — a failure after
 * the answer started is noted twice: the CLI's error, then the SDK's
 * "Claude Code process exited with code 1" for the same failure. The turn
 * stays a 200 stream, its text kept, the error noted once, the stream ended.
 * When the finding is fixed, each case goes back to its file.
 *
 * On the simulators (BEHAVIOR.md "Failures of a model call", "How a query
 * reaches the simulator"): a user's turn in a new chat
 * (test/simulators/turns.ts `failFastTurn`); Claude Code cuts the answer at
 * the output limit as CLI 2.1.312 does (`failures` `maxTokens`: the cut answer
 * streams, three continuations, then the synthetic `max_output_tokens` record
 * and an error result); with a uuid on the prompt the SDK then throws
 * "Claude Code process exited with code 1". Independent cases.
 *
 * Run: bun test/turn-error-noted-twice-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { failFastTurn } from "./simulators/turns.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("turn-error-noted-twice");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();

await cases.run("a failure after content: a 200 stream, the text kept, the error noted once, the stream ended", async () => {
  // CLI 2.1.312's max_output_tokens: the cut answer streams, three continuations, then the synthetic
  // `max_output_tokens` record and an error result (the old test's "max_output_tokens follows a truncated answer:
  // not a failed turn" and "error AFTER content" are this one turn now).
  const { first, journal } = await failFastTurn(world, "FF-LATE", () => (claude.state.failures = ["maxTokens"]));
  const reply = first.reply!;
  assert.equal(reply.status, 200);
  assert.match(reply.text, /a cut answer/);
  assert.equal(reply.text.match(/\[claude-code error\]/g)?.length ?? 0, 1, `mid-stream error note appears exactly once: ${JSON.stringify(reply.text)}`);
  assert.equal(reply.streamError, undefined, "the stream ended, not broke");
  assert.equal(reply.finish, "stop");
  assert.ok(journal.some((line) => /mid-stream turn error/.test(line)), "the journal records the error mid-stream");
});

await cases.run("an error after the answer streamed shows once, though the SDK reports it twice", async () => {
  const { first } = await failFastTurn(world, "write a lot", () => (claude.state.failures = ["maxTokens"]));
  const reply = first.reply!;
  assert.equal(reply.status, 200);
  assert.match(reply.text, /a cut answer/);
  assert.equal(reply.text.match(/exceeded the 32000 output token maximum/g)?.length, 1, `the error once: ${JSON.stringify(reply.text)}`);
  // With a uuid on the prompt the SDK's throw is "Claude Code process exited with code 1" (BEHAVIOR.md "How a
  // query reaches the simulator"): the same failure again, in words that tell the user nothing.
  assert.doesNotMatch(reply.text, /process exited with code/, `the SDK's second report is not shown: ${JSON.stringify(reply.text)}`);
  assert.ok(world.journal().some((line) => /mid-stream turn error/.test(line)), "the journal records the error mid-stream");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
