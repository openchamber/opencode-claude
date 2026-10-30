/**
 * Regression: a turn stopped while parked on a tool call leaves the Claude
 * session at the CLI's interruption entries, not at the unanswered tool_use.
 *
 * Checked live (CLI 2.1.224 and 2.1.284): interrupting a parked MCP call
 * makes the CLI append a rejected tool_result and "[Request interrupted by
 * user for tool use]" and emit both as user events. The leaf follows them,
 * so the resumed history stays faithful: Claude sees that the call was
 * interrupted. Everything after the old leaf descends from it, so the
 * resume stays a plain one, no fork.
 *
 * On the simulators (test/simulators/): the user stops the turn in OpenCode
 * while its tool runs (`stopParked`: OpenCode emits
 * session.execution.interrupted, the plugin interrupts the parked turn);
 * Claude Code writes and streams the rejected result and its interruption
 * record, then ends with `aborted_tools` (CLI 2.1.312 against a local stub of
 * the API, as live probe 41 saw before; BEHAVIOR.md "Tool calls and stops"); the leaf is
 * read from main's record of the chat (`session-store`).
 *
 * Run: bun test/interrupted-leaf-main-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld, pluginModule } from "./simulators/world.ts";

const MARKER = "[Request interrupted by user for tool use]";

async function main() {
  const world = await createWorld("interrupted-leaf");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    const { getSessionLeafUuid } = await pluginModule("session-store");
    const chat = opencode.newChat();
    await opencode.say(chat, "run it");
    claude.state.toolTurn = true;
    const stopped = await opencode.turn(chat, { stopParked: true });
    assert.ok(stopped.stopped, "the user stopped the turn while its tool ran");
    assert.equal(stopped.requests[0]!.reply!.finish, "tool_calls");
    const name = claude.queries.at(-1)!.name;
    const toolUse = claude.records(name).findLast((r) => r.type === "assistant" && r.message?.content?.[0]?.type === "tool_use");
    assert.ok(toolUse, "Claude's tool call is in the transcript");

    // The CLI ends the interrupted turn with its own records; the plugin's leaf follows them.
    const until = async (what: string, ok: () => boolean) => {
      for (let waited = 0; !ok(); waited += 20) {
        assert.ok(waited < 5_000, `no ${what} in 5 s`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await until("interruption record", () => claude.records(name).some((r) => JSON.stringify(r.message?.content ?? "").includes(MARKER)));
    await until("end of the stopped turn", () => claude.queries.at(-1)!.outcome === "stopped");
    const marker = claude.records(name).find((r) => r.type === "user" && JSON.stringify(r.message?.content ?? "").includes(MARKER))!;
    await until("leaf at the interruption record", () => getSessionLeafUuid(chat) !== toolUse!.uuid);
    assert.equal(getSessionLeafUuid(chat), marker.uuid, "the chat's leaf is the CLI's interruption record, not the unanswered tool_use");

    // The next message resumes after the interruption: plainly, no fork.
    await opencode.say(chat, "do something else");
    const next = await opencode.turn(chat);
    assert.ok(next.ok, `the next turn answered: ${next.requests.map((r) => r.status).join(",")}`);
    const query = claude.queries.at(-1)!;
    assert.equal(query.params.resume, name);
    assert.equal("resumeSessionAt" in query.params, false);
    assert.ok(query.view.includes(MARKER), "Claude sees that the call was interrupted");
    assert.ok(!world.journal().some((line) => line.includes("resuming a fork of the Claude session")), "no fork");
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok - interrupted leaf regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
