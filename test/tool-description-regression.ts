/**
 * Regression: the subagent list OpenCode appends to the task tool description
 * must survive Claude Code's 2048-char MCP description cut.
 *
 * Run: bun test/tool-description-regression.ts
 */
import assert from "node:assert/strict";

async function main() {
  const { fitToolDescription, CLAUDE_TOOL_DESCRIPTION_LIMIT } = await import(
    "../src/tool-description.ts"
  );

  const guidance =
    "Launch a new agent to handle complex, multistep tasks autonomously.\n\n" +
    "When to use the Task tool:\n".concat("- guidance line\n".repeat(150));
  const agents = [
    "Available agent types and the tools they have access to:",
    "- general: General-purpose agent for multi-step tasks.",
    "- explore: Fast codebase exploration agent.",
    "- critic: Reviews plans and code.",
  ].join("\n");
  const taskDescription = `${guidance}\n\n${agents}`;
  assert.ok(taskDescription.length > CLAUDE_TOOL_DESCRIPTION_LIMIT);

  // Unpatched, the cut drops every agent.
  assert.ok(
    !taskDescription.slice(0, CLAUDE_TOOL_DESCRIPTION_LIMIT).includes("critic"),
  );

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
  const long = "x".repeat(CLAUDE_TOOL_DESCRIPTION_LIMIT + 10);
  assert.equal(fitToolDescription(long), long);

  console.log("ok — tool description regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
