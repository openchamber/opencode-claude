/**
 * The case of session-context-regression.ts that fails by a finding - the
 * turn after an update and a message of the user's, both sent while a tool
 * ran, sends neither again: the transcript holds both. On
 * chain/turn-by-names the user's message goes again on the next turn as
 * missed (chain/content-from-list reads it from OpenCode's list). When the
 * finding is fixed everywhere, the case goes back to
 * session-context-regression.ts.
 *
 * On the simulators: OpenCode's system update and the user's message while a
 * tool of an answered chat ran (test/simulators/turns.ts `updateWhileTool`),
 * then the next question; what Claude Code got is that query's input, the
 * plugin's plan the journal's line.
 *
 * Run: bun test/session-context-sent-again-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { testCases } from "./simulators/cases.ts";
import { updateWhileTool } from "./simulators/turns.ts";
import { createWorld } from "./simulators/world.ts";

const CHANGED =
  'The context under "openchamber.pinned" changed and supersedes the previous value:\n<context key="openchamber.pinned">\nShip on Friday.\n</context>';

const world = await createWorld("session-context-sent-again");
const { opencode, claude } = world;
await opencode.startPlugin();
opencode.state.contextEntries = { "openchamber.guidance": "Link to this session with the openchamber tool's session.link each pull request you open." };
const cases = testCases();

await cases.run("the turn after an update and a message of the user's sent while a tool ran sends neither again", async () => {
  const { chat } = await updateWhileTool(world, CHANGED, "stop");
  await opencode.say(chat, "NEXT");
  assert.ok((await opencode.turn(chat)).ok);
  const input = claude.queries.at(-1)!.input.map((m) => contentText(m.content));
  assert.deepEqual(input, ["NEXT"], `both are in the transcript: only the new question goes (${JSON.stringify(input).slice(0, 400)})`);
  const resuming = world.journal().filter((line) => line.includes("resuming the chat's Claude transcript") && line.includes(`"${chat}"`)).at(-1);
  assert.ok(resuming === undefined || /"missed":0/.test(resuming), `nothing missed: ${resuming}`);
});

await cases.run("no error in the plugin's journal", () => {
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
