/**
 * The usage OpenCode gets for a turn from what Claude Code streams: per model
 * call a message_start snapshot (output 1), an assistant event per content
 * block, message_delta with the final output; at the end the query's result
 * with its totals and cost. How the outputs of several calls of one response
 * count, and a park handed off before the call's message_delta:
 * context-size-regression.
 *
 * On the simulators (BEHAVIOR.md "The stream of a model call"): a turn of a
 * new chat with `claude.state.usage` for its model calls
 * (test/simulators/turns.ts `usageTurn`), the usage read from OpenCode's
 * reply. Independent cases (test/simulators/cases.ts). An answer cut at
 * max_tokens fails by a finding (the CLI's synthetic error record taken as
 * the last call): turn-usage-max-tokens-regression.ts, until it is fixed.
 *
 * Run: bun test/turn-usage-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { usageOf, usageTurn as usageTurnOf } from "./simulators/turns.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("turn-usage");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();

const usageTurn = (usage: typeof claude.state.usage, setup?: () => void) => usageTurnOf(world, usage, setup);

await cases.run("one call: the final count wins over the snapshot, the cached part in the prompt, reasoning tokens, cost", async () => {
  // A call that two blocks report (a thinking block, then the text) counts once, the prompt holds the cached part
  // (OpenAI's convention), the thinking tokens the API reported with the final count are the reasoning tokens, the
  // cost and the per-model breakdown come from the result.
  const turn = await usageTurn(
    { input_tokens: 8, cache_read_input_tokens: 800, cache_creation_input_tokens: 30, output_tokens: 191, output_tokens_details: { thinking_tokens: 120 } },
    () => (claude.state.thinking = "a thought"),
  );
  assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
  const usage = usageOf(turn.requests[0])!;
  assert.equal(usage.completion_tokens, 191);
  assert.equal(usage.completion_tokens_details?.reasoning_tokens, 120, `the thinking tokens: ${JSON.stringify(usage)}`);
  assert.equal(usage.prompt_tokens, 838);
  assert.equal(usage.prompt_tokens_details?.cached_tokens, 800);
  assert.equal(usage.prompt_tokens_details?.cache_write_tokens, 30);
  assert.ok((usage.cost_usd ?? 0) > 0, "the result's cost");
  assert.deepEqual(Object.keys(usage.model_usage ?? {}), [claude.queries.at(-1)!.params.model], "the result's breakdown per model");
});

await cases.run("two calls of one response: the prompt is the last call's context, not the sum", async () => {
  // A refusal: the CLI calls once more with a note, each call with its own usage.
  const turn = await usageTurn([{ input_tokens: 2, cache_read_input_tokens: 1000, output_tokens: 50 }, { input_tokens: 2, cache_read_input_tokens: 1090, output_tokens: 30 }], () => (claude.state.failures = ["refusal"]));
  const usage = usageOf(turn.requests[0])!;
  assert.equal(usage.prompt_tokens, 1092);
  assert.equal(usage.prompt_tokens_details?.cached_tokens, 1090);
});

await cases.run("a park after the call's message_delta: each call counts once, each response its own call's context", async () => {
  // A park hands off at the tool_use block; the call's message_delta streams right after the block: over the two
  // responses each call counts once and nothing is lost, and the result's totals (both calls) do not stand for the
  // last call's context.
  const turn = await usageTurn([{ input_tokens: 3, output_tokens: 9 }, { input_tokens: 5, output_tokens: 7 }], () => (claude.state.toolTurn = true));
  assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
  assert.equal(turn.requests.length, 2, "the call, then the continuation");
  const [parked, resumed] = turn.requests.map((request) => usageOf(request));
  assert.ok(parked, "the parked response has usage");
  assert.ok(resumed, "the continuation has usage");
  assert.equal(parked.completion_tokens + resumed.completion_tokens, 16);
  assert.equal(parked.prompt_tokens, 3);
  assert.equal(resumed.prompt_tokens, 5);
  assert.ok((resumed.cost_usd ?? 0) > 0, "the result's cost");
});

await cases.run("the CLI compacts by itself before the answer: the note with its token counts", async () => {
  const chat = opencode.newChat();
  await opencode.say(chat, "first");
  await opencode.turn(chat);
  await opencode.say(chat, "second");
  claude.state.compactBeforeAnswer = {};
  try {
    const turn = await opencode.turn(chat);
    assert.match(turn.requests.at(-1)?.reply?.reasoning ?? "", /\[compact\] Conversation compacted \(auto\); tokens \d+ → \d+/);
  } finally {
    claude.state.compactBeforeAnswer = undefined;
  }
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
