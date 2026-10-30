/**
 * Regression: the step OpenCode shows for a tool call carries the id Claude
 * gave the call. The CLI passes that id to the plugin's MCP tool in the
 * request's `_meta` as `claudecode/toolUseId` (probe 43); the proxy hands it
 * to OpenCode as the tool call's id, so the screen and the transcript name
 * the call alike. (The proxy also refuses an id it already holds for a
 * parked call; the real CLI never repeats a call's id, so no test reaches
 * that guard.)
 *
 * On the simulators (test/simulators/): Claude Code calls the plugin's tool
 * with the id of the call's `tool_use` block (`callPluginTool`, BEHAVIOR.md
 * "Tool calls and stops"). The ids OpenCode got are the `tool_calls` of its
 * request's reply; the ids Claude gave are the `tool_use` blocks of the
 * transcript.
 *
 * Run: bun test/tool-call-ids-regression.ts
 */
import assert from "node:assert/strict";

import type { ToolCallSpec } from "./simulators/claude-code.ts";
import type { ToolDefinitions } from "./simulators/opencode.ts";
import { testCases } from "./simulators/cases.ts";
import { createWorld } from "./simulators/world.ts";

const TOOLS: ToolDefinitions = {
  read: { description: "read", input: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
};
const read = (filePath: string): ToolCallSpec => ({ name: "read", input: { filePath } });

async function main() {
  const world = await createWorld("tool-call-ids");
  const { opencode, claude } = world;
  opencode.state.tools = TOOLS;

  /**
   * One turn: Claude reads `files` in one message, OpenCode answers each by
   * the id it was shown, and Claude gets every answer. Returns the ids
   * OpenCode saw and the ids of Claude's calls.
   */
  async function turn(files: string[]) {
    const chat = opencode.newChat();
    await opencode.say(chat, "read the files");
    claude.state.toolSteps = [files.map(read)];
    const done = await opencode.turn(chat, { toolOutput: (call) => `R-${call.input.filePath}` });
    assert.ok(done.ok, `the turn answered: ${done.requests.map((r) => r.status).join(",")}`);
    assert.equal(done.requests.length, 2, "one request with the calls, one with their results");
    const [first, second] = done.requests;
    assert.equal(first!.reply!.finish, "tool_calls");
    assert.deepEqual(first!.reply!.toolCalls.map((c) => c.input.filePath), files);
    assert.equal(second!.reply!.finish, "stop");
    const records = claude.records(claude.queries.at(-1)!.name);
    const given = records
      .filter((r) => r.type === "assistant")
      .flatMap((r) => (r.message?.content ?? []) as Array<Record<string, any>>)
      .filter((block) => block.type === "tool_use")
      .map((block) => String(block.id));
    // Claude got each answer under its own call.
    const results = records
      .filter((r) => r.toolUseResult)
      .flatMap((r) => (r.message?.content ?? []) as Array<Record<string, any>>)
      .map((block) => `${block.tool_use_id}=${JSON.stringify(block.content)}`);
    assert.equal(results.length, files.length);
    files.forEach((file, k) => assert.ok(results[k]!.startsWith(`${given[k]}=`) && results[k]!.includes(`R-${file}`), `Claude got ${file}'s result: ${results}`));
    return { seen: first!.reply!.toolCalls.map((c) => c.id), given };
  }

  const cases = testCases();
  try {
    await opencode.startPlugin();

    await cases.run("one call: OpenCode shows the step under the id Claude gave it", async () => {
      const one = await turn(["a.txt"]);
      assert.equal(one.given.length, 1);
      assert.deepEqual(one.seen, one.given, "OpenCode got the id of Claude's call");
    });

    await cases.run("two calls of one message: each under its own id", async () => {
      const two = await turn(["a.txt", "b.txt"]);
      assert.equal(new Set(two.given).size, 2);
      assert.deepEqual(two.seen, two.given, "OpenCode got the ids of both calls");
    });

    await cases.run("no error in the plugin's journal", () => {
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
