/**
 * Regression: parked turns must not leak their Claude Code process.
 * - A turn parked only on StructuredOutput is never resumed by OpenCode (it
 *   treats the call as terminal), so it is reaped after a short grace period.
 * - A turn parked on regular tools stays parked, but only up to the
 *   parked-turn TTL (OPENCODE_CLAUDE_PARKED_TURN_TTL_MS).
 * - Results that arrive after the reap rebuild the turn around them instead
 *   of re-sending the original request.
 * - stopProxy closes whatever is still parked.
 * (Ported from the fork's 2357db8 + f203658.)
 *
 * On the simulators (test/simulators/): OpenCode's tool runs a while (an
 * async `toolOutput`: the next request of the turn goes when it settles),
 * so the turn stays parked in the plugin meanwhile; a stop reaches Claude
 * Code as an interrupt of the parked turn (probe 41: the rejected result,
 * "[Request interrupted by user for tool use]"). The StructuredOutput case is
 * dropped: the plugin serves OpenCode 2.x, and OpenCode 2.0.32 has no
 * StructuredOutput tool (only 1.x's `format: json_schema` had one); a
 * regular park still has to outlive that short grace.
 *
 * Run: bun test/park-reap-regression.ts
 */
// The StructuredOutput grace, short: a regular park must outlive it.
process.env.OPENCODE_CLAUDE_STRUCTURED_OUTPUT_REAP_MS = "200";
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { createWorld } from "./simulators/world.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MARKER = "[Request interrupted by user for tool use]";

async function main() {
  const world = await createWorld("reap");
  const { opencode, claude } = world;

  /** A turn whose bash call runs in OpenCode until `finish` is called: the turn is parked in the plugin meanwhile. */
  async function parkOnRunningTool(ask: string) {
    const chat = opencode.newChat();
    await opencode.say(chat, ask);
    claude.state.toolSteps = [[{ name: "bash", input: { command: "sleep 100" } }]];
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    let finish!: (output: string) => void;
    const output = new Promise<string>((resolve) => (finish = resolve));
    const from = claude.queries.length;
    const turn = opencode.turn(chat, {
      toolOutput: () => {
        started();
        return output;
      },
    });
    await Promise.race([running, turn.then(() => assert.fail(`${ask}: the turn ended before its tool ran`))]);
    return { chat, turn, finish, query: () => claude.queries[from]! };
  }
  const interrupted = (name: string) => claude.records(name).some((r) => contentText(r.message?.content) === MARKER);

  try {
    await opencode.startPlugin();

    // A regular tool that runs past the StructuredOutput grace: the park is kept,
    // and the result resumes the same Claude Code process.
    {
      const regular = await parkOnRunningTool("regular");
      await sleep(600);
      assert.equal(interrupted(regular.query().name), false, "regular tool park is kept");
      const finishedAt = performance.now();
      regular.finish("exit 0");
      const turn = await regular.turn;
      assert.ok(turn.ok, "the result resumed the parked turn");
      assert.ok(turn.requests[1]!.sentAt >= finishedAt, "OpenCode sent the result once its tool finished");
      assert.equal(turn.requests[1]!.counted[1] - turn.requests[1]!.counted[0], 0, "no new query for the result");
      const results = claude.records(regular.query().name).filter((r) => r.toolUseResult);
      assert.deepEqual(results.map((r) => contentText(r.toolUseResult)), ["exit 0"], "Claude got the tool's own output");
    }

    // A park past the TTL is reaped; the late result rebuilds the turn
    // around it: the step and its result are the prompt, the original ask
    // stays history (never the request again).
    {
      process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS = "200";
      const abandoned = await parkOnRunningTool("ORIGINAL-ASK");
      await sleep(600);
      delete process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS;
      assert.ok(interrupted(abandoned.query().name), "regular park is reaped past the TTL");
      assert.ok(world.journal().some((line) => line.includes("reaping parked turn past its TTL")));
      const from = claude.queries.length;
      abandoned.finish("LATE-RESULT");
      const turn = await abandoned.turn;
      assert.ok(turn.ok, "the late result was answered");
      const rebuilt = claude.queries[from]!;
      assert.equal(rebuilt.outcome, "answered");
      const prompt = rebuilt.input.map((m) => contentText(m.content)).join("\n");
      assert.match(prompt, /<tool_results>/);
      assert.match(prompt, /LATE-RESULT/);
      assert.match(prompt, /Continue the task/);
      assert.match(prompt, /not from the user/, "the interruption isn't blamed on the user");
      assert.doesNotMatch(prompt, /ORIGINAL-ASK/, "the original ask is not sent again");
      assert.ok(world.journal().some((line) => line.includes("tool results arrived with no parked turn; rebuilding the turn with them")));
    }

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");

    // OpenCode's server goes away while a tool runs: stopProxy closes the parked turn.
    {
      const pending = await parkOnRunningTool("shutdown");
      await sleep(50);
      assert.equal(interrupted(pending.query().name), false);
      await world.plugin.proxy.stopProxy();
      assert.ok(interrupted(pending.query().name), "stopProxy stops parked turns");
      // The SDK's close() ends the process's input; the CLI process reports that to the simulator a moment later.
      for (let waited = 0; pending.query().closedAt === undefined && waited < 2_000; waited += 10) await sleep(10);
      assert.notEqual(pending.query().closedAt, undefined, "stopProxy closes their processes");
      pending.finish("too late");
      await pending.turn;
    }
  } finally {
    await world.dispose();
  }
  console.log("ok — park reap regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
