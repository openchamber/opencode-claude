/**
 * Regression: a turn that compacts and then fails resumes after the compact
 * summary, never before the compaction and never at the bare boundary.
 *
 * Checked live (CLI 2.1.284, manual /compact): the CLI emits
 * system/compact_boundary, then the summary as a user event with
 * isSynthetic (not isReplay), then a replayed "Compacted" stdout entry.
 * Cutting the chain at the boundary uuid starts the compacted chain
 * without its summary and Claude remembered nothing. The summary entry is
 * the right leaf; the transcript after it descends from it, so the next
 * turn is a plain resume.
 *
 * On the simulators (test/simulators/): Claude Code compacts its own context
 * at the start of a turn (`state.compactBeforeAnswer`: the boundary off the
 * chain, the summary record and their events, CLI 2.1.312,
 * against a local stub of the API; BEHAVIOR.md "The CLI's own compaction"), the
 * answer starts to stream and the user stops
 * it (`holdMidAnswer`, `stop`: what was shown stays with the error; Claude
 * Code writes it as an aborted answer and its interruption record,
 * the same CLI against the stub); the next message continues the chat. The leaf is read
 * from main's record of the chat (`session-store`).
 *
 * Run: bun test/compact-leaf-main-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("compact-leaf");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    const { getSessionLeafUuid } = await pluginModule("session-store");
    const chat = opencode.newChat();
    await opencode.say(chat, "long work");
    assert.ok((await opencode.turn(chat)).ok, "the first turn");
    const name = claude.queries.at(-1)!.name;
    const beforeCompaction = getSessionLeafUuid(chat);

    // Claude Code compacts its context, starts the answer, and the user stops it.
    await opencode.say(chat, "more work");
    claude.state.compactBeforeAnswer = { summary: "SUMMARY-OF-EARLIER" };
    let release!: () => void;
    claude.state.holdMidAnswer = new Promise<void>((resolve) => (release = resolve));
    claude.state.replies = ["PARTIAL and the rest of an answer that never arrives"];
    const stop = new AbortController();
    const queries = claude.queries.length;
    const running = opencode.turn(chat, { stop: stop.signal });
    // The answer has started to stream (its first delta), then the user stops it.
    for (let i = 0; i < 200 && !(claude.queries.length > queries && claude.queries.at(-1)!.outcome === "answered"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(claude.queries.length, queries + 1, "one query for the turn");
    await new Promise((r) => setTimeout(r, 50));
    stop.abort();
    const stopped = await running;
    // The plugin's interrupt reaches the CLI while its answer still waits: the hold is let go once the query ended.
    for (let waited = 0; claude.queries.at(-1)!.endedAt === undefined; waited += 10) {
      assert.ok(waited < 10_000, "the CLI ended the stopped turn");
      await new Promise((r) => setTimeout(r, 10));
    }
    release();
    claude.state.replies = [];
    assert.ok(stopped.stopped, "the user stopped the answer");
    assert.ok(opencode.session(chat).messages.some((m) => m.text.startsWith("PARTIAL")), "what was shown stays");

    const records = claude.records(name);
    const boundary = records.find((r) => r.type === "system" && r.subtype === "compact_boundary");
    assert.ok(boundary, `Claude Code compacted: ${records.map((r) => r.subtype ?? r.type).join(",")}`);
    // The summary hangs off the boundary through the part's context and date, as CLI 2.1.312 writes it
    // (test/cli-contract-live.ts check 22; BEHAVIOR.md "Transcript files").
    const summary = records.find((r) => r.isCompactSummary);
    const above = summary ? claude.chainTo(name, summary.uuid!).slice(-4, -1) : [];
    assert.ok(summary && summary.type === "user" && above[0]?.uuid === boundary!.uuid, "the summary follows the boundary");
    const leaf = getSessionLeafUuid(chat);
    assert.notEqual(leaf, beforeCompaction, "not before the compaction");
    assert.notEqual(leaf, boundary!.uuid, "not at the bare boundary");
    // The stop writes what was shown and the CLI's interruption record after the summary (CLI 2.1.312 against a local stub of the API).
    assert.ok(records.some((r) => r.type === "assistant" && r.isAbortedMidStream), "the CLI wrote the part it had as an aborted answer");
    assert.ok(claude.chainTo(name, leaf).some((r) => r.uuid === summary!.uuid), "the chat's leaf is the compact summary or descends from it");

    // The next message: a plain resume, no fork; Claude has the summary.
    await opencode.say(chat, "go on");
    const next = await opencode.turn(chat);
    assert.ok(next.ok, `the next turn: ${next.requests.map((r) => r.status).join(",")}`);
    const query = claude.queries.at(-1)!;
    assert.equal(query.params.resume, name);
    assert.equal("resumeSessionAt" in query.params, false);
    assert.ok(query.view.includes(claude.recordText(summary!)), "Claude continues after the summary");
    assert.ok(!world.journal().some((line) => line.includes("resuming a fork of the Claude session")), "no fork");
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok - compact leaf regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
