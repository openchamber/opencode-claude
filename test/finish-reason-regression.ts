/**
 * Regression: finish_reason follows Claude's stop_reason.
 * - A plain answer → "stop".
 * - A parked turn still ends its response with "tool_calls".
 * - max_tokens → "length", refusal → "content_filter" plus a short note that
 *   Claude declined: these fail by a finding (both reach OpenCode as "stop")
 *   and live in finish-reason-length-and-refusal-regression.ts until it is
 *   fixed.
 *
 * On the simulators (test/simulators/): a turn of a new chat
 * (test/simulators/turns.ts `answerTurn`); a tool step: `state.toolTurn`. The
 * old case of a subagent's stop_reason is gone: the plugin starts Claude Code
 * without its built-in tools (`tools: []`), so no Claude Code subagent streams
 * in a turn. Independent cases (test/simulators/cases.ts).
 *
 * Run: bun test/finish-reason-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { answerTurn } from "./simulators/turns.ts";
import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("finish-reason");
  const { opencode, claude } = world;
  const cases = testCases();
  try {
    await opencode.startPlugin();

    await cases.run("a plain answer: stop", async () => {
      const plain = await answerTurn(world);
      assert.ok(plain.turn.ok);
      assert.equal(plain.reply.finish, "stop");
      assert.doesNotMatch(plain.reply.reasoning, /declined/);
    });

    await cases.run("parked tool calls are still tool_calls, the step after the tool ends with stop", async () => {
      claude.state.toolTurn = true;
      const parked = await answerTurn(world);
      assert.ok(parked.turn.ok);
      assert.equal(parked.reply.finish, "tool_calls");
      assert.equal(parked.turn.requests.at(-1)!.reply!.finish, "stop", "the step after the tool ends with stop");
    });

    await cases.run("no error in the plugin's journal", () => {
      assert.equal(opencode.retries.length, 0, "OpenCode sent nothing again");
      assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    });
  } finally {
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
