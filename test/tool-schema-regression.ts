/**
 * A tool OpenCode offers reaches Claude with its schema verbatim, and every
 * argument Claude calls it with reaches OpenCode, also one the schema does
 * not name; the result goes back to the parked turn.
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): OpenCode offers its
 * `edit` tool, Claude Code calls it, OpenCode runs it and sends the result.
 *
 * Run: bun test/tool-schema-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { listPluginTools } from "./simulators/claude-code.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("tool-schema");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();

await cases.run("a tool's schema reaches Claude verbatim and an argument it does not name reaches OpenCode", async () => {
  const parameters = {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Absolute path" },
      mode: { type: "string", enum: ["a", "b"] },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: { old: { type: "string" }, new: { type: "string" } },
          required: ["old", "new"],
        },
      },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["filePath"],
  };
  const tools = opencode.state.tools;
  opencode.state.tools = { edit: { description: "Edit a file", input: parameters } };
  try {
    const chat = opencode.newChat();
    await opencode.say(chat, "edit /a");
    const args = { filePath: "/a", extra: 1, edits: [{ old: "x", new: "y" }] };
    claude.state.toolSteps = [[{ name: "edit", input: args }]];
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
    const listed = await listPluginTools(claude.queries.at(-1)!.params);
    assert.deepEqual(listed.find((tool) => tool.name === "edit")?.inputSchema, parameters, "Claude sees the schema verbatim");
    const [call] = turn.requests[0]!.reply!.toolCalls;
    assert.equal(call?.name, "edit");
    assert.deepEqual(call?.input, args, "OpenCode gets every argument");
    assert.ok(
      world.journal().some((line) => line.includes("resuming parked bridge") && line.includes(`"conversationKey":"${chat}"`) && line.includes(`"resolved":1`)),
      "the result went back to the parked turn",
    );
  } finally {
    opencode.state.tools = tools;
    claude.state.toolSteps = [];
  }
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
