/**
 * A chat compacted by another provider's model never reaches the summary
 * route, so the turn parked on the old history must be stopped by the next
 * request instead of re-emitting its calls.
 *
 * On the simulators (test/simulators/): Claude calls a tool; while OpenCode
 * runs it the context reaches the ceiling, and OpenCode's compaction agent,
 * on another provider's model (`opencode.state.compactionElsewhere`), compacts
 * before the step's next request: that request carries only the checkpoint,
 * the old call is text in its recent part. Claude then calls a tool on the
 * new history and the step goes on.
 *
 * Run: bun test/cross-provider-compaction-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("cross-provider-compaction");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    opencode.state.compactionElsewhere = true;
    const chat = opencode.newChat();
    await opencode.say(chat, "original long conversation");
    // The first answer measures a context near the window: OpenCode compacts before the step's next request.
    const window = (opencode.instances[0]!.provider.models as any[]).find((m) => /sonnet/.test(m.id))!.limit.context as number;
    claude.state.usage = { input_tokens: Math.ceil(window * 0.95) };
    claude.state.toolTurn = true;
    const summariesBefore = claude.queries.filter((q) => q.kind === "summary").length;
    let runs = 0;
    const turn = await opencode.turn(chat, {
      toolOutput: () => {
        runs += 1;
        if (runs > 1) return "new-work finished";
        // Claude calls a tool again on the compacted history, with a small context this time.
        claude.state.usage = {};
        claude.state.toolTurn = true;
        return "old-work finished";
      },
    });
    assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
    const [old, fresh, continued] = turn.requests;
    assert.equal(turn.requests.length, 3, "the call, the call on the new history, the answer");
    assert.equal(old!.reply!.finish, "tool_calls");

    // Another provider compacted: no summary reached the plugin, the next request holds only the checkpoint.
    assert.equal(claude.queries.filter((q) => q.kind === "summary").length, summariesBefore, "the compaction never reached the plugin");
    assert.ok(opencode.session(chat).messages.some((m) => m.type === "compaction"), "OpenCode compacted the chat");
    assert.match(JSON.stringify(fresh!.list[0]?.content ?? ""), /another model's summary/, "the request after the compaction starts with the checkpoint");

    const [first, second] = claude.queries.filter((q) => q.kind === "chat");
    assert.equal(claude.queries.filter((q) => q.kind === "chat").length, 2, "the checkpoint replaced the parked turn with one new turn");
    assert.equal(first!.outcome, "stopped", "the old process was stopped");
    assert.notEqual(second!.params.resume, first!.name, "compacted history must not resume the old Claude session");
    assert.match(second!.view, /another model's summary/, "Claude got the checkpoint");
    assert.equal(fresh!.reply!.finish, "tool_calls");
    const call = fresh!.reply!.toolCalls[0]!;
    assert.notEqual(call.id, old!.reply!.toolCalls[0]!.id, "a new call, not the parked one re-emitted");

    // The usual continuation after the checkpoint stays on the same turn.
    assert.equal(continued!.reply!.finish, "stop");
    assert.equal(continued!.counted[1] - continued!.counted[0], 0, "the tool result continues the new turn");
    const results = claude.records(second!.name).filter((r) => r.toolUseResult).map((r) => JSON.stringify(r.toolUseResult));
    assert.ok(results.some((r) => r.includes("new-work finished")), `the new turn got its tool's result: ${results}`);

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    console.log("cross-provider-compaction regression ok: stale park replaced; the new turn continues");
  } finally {
    await world.dispose();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
