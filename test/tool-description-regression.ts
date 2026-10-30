/**
 * Regression: the subagent list OpenCode appends to its subagent tool
 * description must survive Claude Code's MCP description cut, in
 * the served tools/list too. (Ported from the fork's 16f9a4c, extended to
 * V2's `subagent` tool and "Available subagents:" heading.)
 *
 * On the simulators (test/simulators/): OpenCode offers a `subagent` tool
 * with the long description; what Claude Code lists of the plugin's MCP
 * server (`listPluginTools`, the query's parameters) carries the fitted
 * description. `fitToolDescription` itself is a pure function of the proxy.
 *
 * Run: bun test/tool-description-regression.ts
 */
import assert from "node:assert/strict";

import { listPluginTools } from "./simulators/claude-code.ts";
import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("tool-description");
  const { opencode, claude } = world;
  const { fitToolDescription, CLAUDE_TOOL_DESCRIPTION_LIMIT } = world.plugin.proxy;
  try {
    await opencode.startPlugin();
    const guidance =
      "Launch a new agent to handle complex, multistep tasks autonomously.\n\n" +
      "When to use the Task tool:\n".concat("- guidance line\n".repeat(Math.ceil(CLAUDE_TOOL_DESCRIPTION_LIMIT / 16) + 10));
    for (const heading of [
      "Available agent types and the tools they have access to:",
      "Available subagents:",
    ]) {
      const agents = [
        heading,
        "- general: General-purpose agent for multi-step tasks.",
        "- explore: Fast codebase exploration agent.",
        "- critic: Reviews plans and code.",
      ].join("\n");
      const taskDescription = `${guidance}\n\n${agents}`;
      assert.ok(taskDescription.length > CLAUDE_TOOL_DESCRIPTION_LIMIT);
      // Unpatched, the cut drops every agent.
      assert.ok(!taskDescription.slice(0, CLAUDE_TOOL_DESCRIPTION_LIMIT).includes("critic"));

      const fitted = fitToolDescription(taskDescription);
      const visible = fitted.slice(0, CLAUDE_TOOL_DESCRIPTION_LIMIT);
      for (const name of ["general", "explore", "critic"]) {
        assert.ok(visible.includes(`- ${name}:`), `${name} visible after the cut`);
      }
      // Guidance is kept (after the list), nothing is dropped by us.
      assert.ok(fitted.includes(guidance.trim()));
      assert.ok(fitted.includes(agents));
      assert.ok(visible.includes("Launch a new agent"));

      // Short descriptions and descriptions without the list are untouched.
      const short = `Short guidance.\n\n${agents}`;
      assert.equal(fitToolDescription(short), short);

      // A turn with OpenCode's subagent tool: the tools/list Claude Code reads carries the fitted description.
      opencode.state.tools = { subagent: { description: taskDescription, input: { type: "object", properties: {} } } };
      const chat = opencode.newChat();
      await opencode.say(chat, "who can help?");
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
      const params = claude.queries.at(-1)!.params as Record<string, any>;
      const listed = await listPluginTools(params);
      // Every tool OpenCode offers (its skill tool and `execute` besides the subagent tool), in its order.
      assert.deepEqual(listed.map((tool) => tool.name), Object.keys(opencode.offeredTools()));
      assert.equal(listed.find((tool) => tool.name === "subagent")!.description, fitted);
    }
    const long = "x".repeat(CLAUDE_TOOL_DESCRIPTION_LIMIT + 10);
    assert.equal(fitToolDescription(long), long);
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — tool description regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
