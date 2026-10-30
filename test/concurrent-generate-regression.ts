/**
 * Regression: a generate call without a session was keyed by the first 200
 * characters of its prompt, and a new turn stops any other turn with the
 * same key. Concurrent calls sharing an instruction preamble stopped each
 * other ("Claude Code ended the turn without any output"). Each standalone
 * call now gets its own key.
 *
 * On the simulators (test/simulators/): OpenCode's `Generate.text`
 * (`generateText`: no session, no hook) four times at once with one
 * preamble; Claude Code answers each slowly (`state.blockPauseMs`), so the
 * four queries run side by side, as they did in the old test (a stub turn of
 * 200 ms that ended without output when stopped); a query the plugin
 * stopped would end without its answer.
 *
 * Run: bun test/concurrent-generate-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

const PAUSE_MS = 200;

async function main() {
  const world = await createWorld("concurrent-generate");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    claude.state.summaryReplies = ["NO", "NO", "NO", "NO"];
    claude.state.blockPauseMs = PAUSE_MS;
    const preamble = "You classify items. Answer with YES or NO only. ".repeat(8);
    const before = claude.queries.length;
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => opencode.generateText(`${preamble}\nItem ${i}: is ${i} even?`)),
    );
    claude.state.blockPauseMs = 0;
    for (const result of results) {
      assert.equal(result.reply.status, 200, `${result.reply.raw ?? ""}`);
      assert.equal(result.failure, undefined, `${JSON.stringify(result.failure)}`);
      assert.equal(result.text, "NO");
    }
    const queries = claude.queries.slice(before);
    assert.equal(queries.length, 4, "one Claude Code query per call");
    assert.deepEqual(queries.map((q) => q.outcome), ["answered", "answered", "answered", "answered"], "no call stopped another");
    // The four ran side by side: each query was still running when the last one started.
    const lastStart = Math.max(...queries.map((q) => q.startedAt));
    assert.ok(
      queries.every((q) => q.endedAt !== undefined && q.endedAt - q.startedAt >= PAUSE_MS * 0.75 && q.endedAt > lastStart),
      `the queries overlapped (${queries.map((q) => Math.round((q.endedAt ?? NaN) - q.startedAt)).join(", ")} ms)`,
    );
    assert.ok(queries.every((q) => q.closedAt === undefined || q.closedAt >= q.endedAt!), "none was closed before its answer ended");
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — concurrent-generate regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
