/**
 * Regression: OpenCode compacts a chat whose turn is parked on a tool call.
 * The parked turn belongs to the uncompacted Claude session. Left alive, it
 * re-emitted its call to every continuation of the compacted chat, with the
 * old context size, and OpenCode compacted again, over and over. The summary
 * leaves the turn alone (background compaction writes it while the chat goes
 * on); the continuation carrying the compacted history stops it and starts a
 * new one.
 *
 * On the simulators (test/simulators/): Claude calls a tool and reports a
 * context at the ceiling (`state.usage`); OpenCode runs the tool, then
 * compacts by itself before the step's next request, and the continuation
 * goes out after the checkpoint (BEHAVIOR.md "Compaction"). When the parked
 * query ended, against the summary's end: `endedAt` of the two queries.
 *
 * Run: bun test/compaction-park-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("compaction-park");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    const chat = opencode.newChat();
    await opencode.say(chat, "run it");
    claude.state.toolSteps = [1];
    // The step's answer reports a context past the ceiling: OpenCode compacts before sending the result.
    claude.state.usage = { input_tokens: 990_000 };
    const turn = await opencode.turn(chat);
    claude.state.usage = {};
    assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);

    const [step, next] = turn.requests;
    assert.equal(step!.reply!.finish, "tool_calls");
    assert.equal(turn.compactions.length, 1, "one compaction, no loop");
    assert.equal(turn.compactions[0]!.status, "completed");
    assert.equal(turn.requests.length, 2, "the continuation after the checkpoint");
    assert.equal(next!.reply!.finish, "stop", "no stale tool call re-emitted");
    assert.deepEqual(next!.reply!.toolCalls, []);

    const [parked, summary, continuation] = claude.queries;
    assert.equal(summary!.kind, "summary");
    assert.equal(parked!.outcome, "stopped", "the compacted history stops the parked turn");
    assert.ok(summary!.endedAt !== undefined && parked!.endedAt !== undefined && parked!.endedAt > summary!.endedAt, "the summary does not stop the chat's turn: it ends after the summary");
    assert.equal(continuation!.kind, "chat");
    assert.equal(continuation!.outcome, "answered", "continuation ran as a new turn");
    assert.notEqual(continuation!.params.resume, parked!.name, "the continuation leaves the uncompacted session");
    assert.equal(next!.counted[1] - next!.counted[0], 1, "the continuation started its own query");

    const journal = world.journal();
    assert.ok(journal.some((line) => /\[opencode-claude\] summarizing .*"liveTurn":true/.test(line)), "the summary saw the chat's turn live and left it");
    assert.ok(!journal.some((line) => line.includes("stopped the turn of a chat being compacted")), "the summary stops nothing");
    assert.ok(!journal.some((line) => line.includes("re-emitting parked tool_calls")), "no parked call re-emitted");
    assert.deepEqual(journal.filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("compaction-park regression ok");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
