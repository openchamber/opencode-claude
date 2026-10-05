/**
 * A turn with several Anthropic API calls (a tool ran inside Claude Code, so
 * the turn did not return to OpenCode in between) reports the last call's
 * prompt as the context size, not the sum of all calls' prompts. OpenCode
 * compacts when the reported prompt reaches the input limit: summing made a
 * 1M chat at 500k compact as soon as one turn had two calls.
 */
import assert from "node:assert/strict";

const { TurnUsageTracker, usageFromAnthropic } = await import("../src/usage.ts");

// Seen live: 500,059 then 501,050 of context; the plugin reported 1,001,109.
const first = usageFromAnthropic({
  input_tokens: 2,
  cache_creation_input_tokens: 991,
  cache_read_input_tokens: 500_059,
  output_tokens: 168,
})!;
const second = usageFromAnthropic({
  input_tokens: 32,
  cache_creation_input_tokens: 335,
  cache_read_input_tokens: 501_050,
  output_tokens: 557,
  output_tokens_details: { thinking_tokens: 212 },
})!;

const tracker = new TurnUsageTracker(new Map());
tracker.add(first, "msg_a");
tracker.add(second, "msg_b");
const total = tracker.total()!;
assert.equal(total.prompt_tokens, 32 + 335 + 501_050);
assert.equal(total.prompt_tokens_details?.cached_tokens, 501_050);
assert.equal(total.prompt_tokens_details?.cache_write_tokens, 335);
assert.equal(total.completion_tokens, 168 + 557);
assert.equal(total.completion_tokens_details?.reasoning_tokens, 212);
assert.equal(total.total_tokens, total.prompt_tokens + total.completion_tokens);

// One call: unchanged.
const single = new TurnUsageTracker(new Map());
single.add(first, "msg_a");
assert.deepEqual(single.total(), first);

// A call reported by an earlier response (parked, then resumed) still gives
// the context size when it is the last call of this response.
const reported = new Map<string, any>();
const parked = new TurnUsageTracker(reported);
parked.add(usageFromAnthropic({ input_tokens: 2, cache_read_input_tokens: 500_059, output_tokens: 4 })!, "msg_p");
assert.equal(parked.total()!.prompt_tokens, 500_061);
const resumed = new TurnUsageTracker(reported);
resumed.add(first, "msg_p");
const grown = resumed.total()!;
assert.equal(grown.completion_tokens, 168 - 4);
assert.equal(grown.prompt_tokens, 500_061 + 991);

// Nothing new: nothing reported.
const again = new TurnUsageTracker(reported);
again.add(first, "msg_p");
assert.equal(again.total(), null);

console.log("context size regression ok");
