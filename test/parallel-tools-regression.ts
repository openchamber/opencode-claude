/**
 * Regression: every tool call of one assistant message reaches OpenCode in
 * one tool_calls response (the park is held until message_stop or a quiet
 * period), and read-only tools, subagents included, carry readOnlyHint in the
 * tools/list Claude Code reads. (Ported from the fork's 1c66cb8.)
 *
 * On the simulators (test/simulators/): Claude Code starts each call as soon
 * as its block is complete, while the message still streams, read-only tools
 * side by side (CLI 2.1.312, BEHAVIOR.md "Tool calls and stops");
 * `blockPauseMs` makes the model stream slowly, `stallBeforeStop` holds the
 * message's end.
 *
 * Run: bun test/parallel-tools-regression.ts
 */
import assert from "node:assert/strict";

import { listPluginTools } from "./simulators/claude-code.ts";
import type { ToolDefinitions } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

const tool = (name: string) => ({ description: name, input: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } });
const TOOLS: ToolDefinitions = { read: tool("read"), edit: tool("edit"), task: tool("task"), subagent: tool("subagent") };
const READS = [
  { name: "read", input: { filePath: "a.txt" } },
  { name: "read", input: { filePath: "b.txt" } },
];

async function main() {
  const world = await createWorld("parallel");
  const { opencode, claude } = world;
  opencode.state.tools = TOOLS;

  /** Claude reads two files in one message; OpenCode answers each read with the file's letter. */
  async function roundTrip() {
    const chat = opencode.newChat();
    await opencode.say(chat, "read a.txt and b.txt");
    claude.state.toolSteps = [READS];
    const turn = await opencode.turn(chat, { toolOutput: (call) => (call.input.filePath === "a.txt" ? "A" : "B") });
    assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
    const [first, second] = turn.requests;
    assert.equal(turn.requests.length, 2, "one request with the calls, one with their results");
    assert.equal(first!.reply!.finish, "tool_calls");
    assert.equal(first!.reply!.toolCalls.length, 2, "both calls of the message in one response");
    assert.deepEqual(first!.reply!.toolCalls.map((c) => c.input.filePath), ["a.txt", "b.txt"]);
    assert.equal(second!.reply!.finish, "stop");
    const results = claude.records(claude.queries.at(-1)!.name).filter((r) => r.toolUseResult).map((r) => JSON.stringify(r.toolUseResult));
    assert.equal(results.length, 2);
    assert.ok(results[0]!.includes('"A"') && results[1]!.includes('"B"'), `Claude got each file's result: ${results}`);
    return first!;
  }

  try {
    await opencode.startPlugin();
    // The model streams slowly: the second call arrives after the first has already parked.
    claude.state.blockPauseMs = 150;
    await roundTrip();
    claude.state.blockPauseMs = 0;

    // Annotation: only read-only tools (and task) may run side by side, in
    // the tools/list Claude Code read.
    const params = claude.queries.at(-1)!.params as Record<string, any>;
    const byName = Object.fromEntries((await listPluginTools(params)).map((t) => [t.name, t]));
    assert.equal(byName.read.annotations?.readOnlyHint, true);
    assert.equal(byName.task.annotations?.readOnlyHint, true);
    assert.equal(byName.subagent.annotations?.readOnlyHint, true);
    assert.equal(byName.edit.annotations, undefined);
    assert.equal(byName.edit._meta?.["anthropic/alwaysLoad"], true);

    // A message that ends at once: message_stop completes the hold, no quiet wait. The quiet period is 3 s after the
    // stream's last event, so a hold it released takes longer than that from the request; a loaded machine spends
    // over 2 s on the query's start alone (the PR assembly's runs, 30.10.2026: 2160 and 2365 ms).
    const fast = await roundTrip();
    assert.ok(fast.doneAt - fast.sentAt < 3_000, `the group completes the hold at message_stop (${Math.round(fast.doneAt - fast.sentAt)} ms)`);

    // A stream that stalls before message_stop: the quiet period releases the park.
    claude.state.stallBeforeStop = new Promise((resolve) => setTimeout(resolve, 3_500));
    const quiet = await roundTrip();
    assert.ok(quiet.doneAt - quiet.sentAt >= 2_500, `quiet period released the park (${Math.round(quiet.doneAt - quiet.sentAt)} ms)`);

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — parallel tools regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
