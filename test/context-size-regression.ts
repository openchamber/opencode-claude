/**
 * A response reports the context size as one Anthropic API call's usage: the
 * last call the response started, after Claude Code last compacted. OpenCode
 * compacts when the reported size reaches the input limit, so any sum of
 * calls compacts a chat that still fits:
 * - summing the prompts of a turn's calls made a 1M chat at 500k compact as
 *   soon as one turn had two calls (a tool ran inside Claude Code, or the CLI
 *   called the model once more);
 * - a turn that failed right after a tool call, before the next call
 *   answered, reported the SDK result's totals: the result's `modelUsage`
 *   sums every call of the session (64M of a 1M window, seen live), and
 *   OpenCode compacted before every next message.
 * A call belongs to the response that saw it first: a turn parked on a tool
 * before the call's `message_delta` reports the call's opening snapshot, and
 * the continuation does not count that call again. The SDK result lends the
 * response its cost and per-model breakdown, never its tokens.
 *
 * On the simulators (test/simulators/): the model calls read the context of
 * the live case, each call its own (`claude.state.usage` as a list: 500,059
 * tokens, then 501,050); two calls in one response are a refused answer (the
 * CLI calls the model once more, BEHAVIOR.md "Failures of a model call"); a
 * call reported by an earlier response is a tool step whose stream stalls
 * before `message_delta` (`stallBeforeStop`) until OpenCode runs the tool
 * (BEHAVIOR.md "The stream of a model call, usage"); a failure after a tool
 * step is `failingCall: 2`; the result's `total_cost_usd` and `modelUsage`
 * are the whole session's (BEHAVIOR.md "What a result counts": the transcript's
 * `cost-state` lines); the CLI compacting inside a turn is
 * `compactBeforeAnswer`. What OpenCode got: each request's `reply.usage`.
 * Each case runs in a chat of its own; a failed case does not stop the
 * others.
 *
 * Run: bun test/context-size-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { createWorld } from "./simulators/world.ts";

type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  cost_usd?: number;
  model_usage?: Record<string, unknown>;
};

async function main() {
  const world = await createWorld("context-size");
  const { opencode, claude } = world;
  const cases = testCases();
  /** Chats whose turn fails on purpose: their journal lines may hold errors. */
  const failing = new Set<string>();
  const reset = () => {
    claude.state.usage = {};
    claude.state.failures = [];
    claude.state.failingCall = 1;
    claude.state.toolTurn = false;
    claude.state.stallBeforeStop = undefined;
    claude.state.compactBeforeAnswer = undefined;
  };
  const run = (name: string, body: () => Promise<string | void>) =>
    cases.run(name, async () => {
      try {
        return await body();
      } finally {
        reset();
      }
    });
  try {
    await opencode.startPlugin();
    // Seen live: 500,059 then 501,050 of context in two calls of one turn; the plugin reported 1,001,109.
    const first = { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 500_057, output_tokens: 168 };
    const second = { input_tokens: 2, cache_creation_input_tokens: 991, cache_read_input_tokens: 500_057, output_tokens: 40 };
    const contextOf = (call: typeof first) => call.input_tokens + call.cache_creation_input_tokens + call.cache_read_input_tokens;
    const usageOf = (turn: Awaited<ReturnType<typeof opencode.turn>>) => turn.requests.map((r) => r.reply?.usage as Usage | undefined);
    /** The session's spending the CLI last wrote in the chat's transcript (what its next result restores and adds to). */
    const spentSoFar = () => {
      const record = claude.records(claude.queries.at(-1)!.name).findLast((r) => r.type === "cost-state") as
        | { totalCostUSD?: number; modelUsage?: Record<string, { inputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }> }
        | undefined;
      assert.ok(record, "the transcript holds the session's spending (cost-state)");
      const context = Object.values(record.modelUsage ?? {}).reduce((sum, m) => sum + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0);
      return { cost: record.totalCostUSD ?? 0, context, models: Object.keys(record.modelUsage ?? {}) };
    };

    await run("one call: its own usage, the final output (message_delta), not the opening snapshot", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "one call");
      claude.state.usage = [second];
      const single = await opencode.turn(chat);
      assert.ok(single.ok);
      const [one] = usageOf(single);
      assert.equal(one?.prompt_tokens, contextOf(second));
      assert.equal(one?.prompt_tokens_details?.cached_tokens, second.cache_read_input_tokens);
      assert.equal(one?.prompt_tokens_details?.cache_write_tokens, second.cache_creation_input_tokens);
      assert.equal(one?.completion_tokens, second.output_tokens, `the final output: ${JSON.stringify(one)}`);
    });

    await run("two calls in one response (a refusal, the CLI calls once more): the last call, not a sum", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "two calls");
      claude.state.failures = ["refusal"];
      claude.state.usage = [first, second];
      const refused = await opencode.turn(chat);
      assert.equal(refused.requests.length, 1, "one response");
      assert.equal(claude.queries.at(-1)!.outcome, "refusal");
      const [two] = usageOf(refused);
      assert.equal(two?.prompt_tokens, contextOf(second), `the context size, not the sum of both calls' prompts: ${JSON.stringify(two)}`);
      assert.equal(two?.prompt_tokens_details?.cached_tokens, second.cache_read_input_tokens);
      assert.equal(two?.prompt_tokens_details?.cache_write_tokens, second.cache_creation_input_tokens);
      assert.equal(two?.completion_tokens, second.output_tokens, `the last call's output, not a sum of the calls: ${JSON.stringify(two)}`);
      assert.equal(two?.total_tokens, two!.prompt_tokens + two!.completion_tokens);
    });

    await run("a turn parked before the call's message_delta: the first response its opening snapshot, the continuation its own call only", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "a tool");
      claude.state.toolTurn = true;
      claude.state.usage = [first, second];
      let release!: () => void;
      claude.state.stallBeforeStop = new Promise<void>((resolve) => (release = resolve));
      const tool = await opencode.turn(chat, {
        toolOutput: () => {
          release();
          return "a.txt";
        },
      });
      assert.ok(tool.ok);
      assert.equal(tool.requests.length, 2, "one request with the call, one with its result");
      const [parked, resumed] = usageOf(tool);
      assert.equal(parked?.prompt_tokens, contextOf(first));
      assert.equal(parked?.completion_tokens, 1, `the parked response has the call's opening snapshot: ${JSON.stringify(parked)}`);
      assert.equal(resumed?.prompt_tokens, contextOf(second), `the context size, not the sum of the calls' prompts: ${JSON.stringify(resumed)}`);
      assert.equal(resumed?.completion_tokens, second.output_tokens, `the continuation reports its own call, the parked one not again: ${JSON.stringify(resumed)}`);
    });

    await run("a turn refused after its tool step in a chat that spent more than the window: no usage, not the session's totals", async () => {
      const chat = opencode.newChat();
      failing.add(chat);
      // Two answered turns of one session, each a call of 600,000 tokens of context: 1.2M spent, more than the 1M window.
      for (const text of ["the first question", "the second question"]) {
        await opencode.say(chat, text);
        claude.state.usage = { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 600_000, output_tokens: 50 };
        assert.ok((await opencode.turn(chat)).ok);
      }
      const spent = spentSoFar();
      assert.ok(spent.context > 1_000_000, `the session spent more than the window: ${spent.context}`);
      // The next turn parks on a tool call; the call after the tool result is refused (the account, 403).
      await opencode.say(chat, "run it");
      claude.state.usage = { input_tokens: 2, cache_read_input_tokens: 50_167, cache_creation_input_tokens: 1_895, output_tokens: 3_801 };
      claude.state.toolTurn = true;
      claude.state.failures = ["oauthOrg"];
      claude.state.failingCall = 2;
      const turn = await opencode.turn(chat);
      const [toolStep, continuation] = turn.requests;
      assert.ok(toolStep && continuation, `a tool step and its continuation: ${turn.requests.length} requests`);
      assert.equal(toolStep.reply?.finish, "tool_calls", "the first response parks on the tool call");
      const reported = toolStep.reply?.usage as Usage | undefined;
      assert.equal(reported?.prompt_tokens, 2 + 50_167 + 1_895, `the tool call's response reports its call: ${JSON.stringify(reported)}`);
      assert.equal(reported?.completion_tokens, 3_801);
      assert.equal(claude.queries.at(-1)!.outcome, "oauthOrg", "the call after the tool result was refused");
      assert.equal(continuation.reply?.usage, undefined, `the refused continuation reports no usage, got ${JSON.stringify(continuation.reply?.usage)}`);
      assert.doesNotMatch(continuation.reply?.raw ?? "", /"usage"/, "no usage in the failed body either");
      const ofChat = world.journal().filter((line) => line.includes(`"conversationKey":"${chat}"`));
      assert.ok(ofChat.some((line) => /disabled Claude subscription access/.test(line)), "the journal names the refused call");
    });

    await run("Claude Code compacts after a tool step: the continuation reports the call after the boundary", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "a tool, then too long");
      claude.state.toolTurn = true;
      claude.state.usage = [first, second];
      claude.state.compactBeforeAnswer = {};
      const tool = await opencode.turn(chat);
      assert.ok(tool.ok);
      assert.equal(tool.requests.length, 2, "one request with the call, one with its result");
      assert.ok(claude.records(claude.queries.at(-1)!.name).some((r) => r.type === "system" && r.subtype === "compact_boundary"), "Claude Code compacted");
      const [parked, resumed] = usageOf(tool);
      assert.equal(parked?.prompt_tokens, contextOf(first));
      assert.equal(resumed?.prompt_tokens, contextOf(second), `the call after the boundary, not the context before it: ${JSON.stringify(resumed)}`);
      assert.equal(resumed?.completion_tokens, second.output_tokens);
    });

    await run("a resumed chat's response lends the result's cost and per-model breakdown, never its tokens", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "the first question");
      claude.state.usage = { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 300_000, output_tokens: 50 };
      assert.ok((await opencode.turn(chat)).ok);
      await opencode.say(chat, "the second question");
      claude.state.usage = [second];
      const answered = await opencode.turn(chat);
      assert.ok(answered.ok);
      assert.ok(claude.queries.at(-1)!.at, "the second turn resumed the session");
      const spent = spentSoFar();
      const [usage] = usageOf(answered);
      assert.equal(usage?.prompt_tokens, contextOf(second), `the call's tokens, not the session's: ${JSON.stringify(usage)}`);
      assert.equal(usage?.completion_tokens, second.output_tokens);
      assert.ok(spent.cost > 0, "the session has a cost");
      assert.ok(Math.abs((usage?.cost_usd ?? 0) - spent.cost) < 1e-9, `the session's cost (${spent.cost}) lent, got ${usage?.cost_usd}`);
      assert.deepEqual(Object.keys(usage?.model_usage ?? {}).sort(), spent.models.sort(), "the per-model breakdown lent");
    });

    await run("the plugin's journal holds no error but the refused turn's", async () => {
      const errors = world.journal().filter((line) => /level=error/.test(line) && ![...failing].some((chat) => line.includes(`"conversationKey":"${chat}"`)));
      assert.deepEqual(errors, [], "no error in the plugin's journal");
    });
  } finally {
    reset();
    await world.dispose();
  }
  cases.done();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
