/**
 * OpenCode 2.0.19 moved built-in date/environment instructions after Code Mode.
 * These blocks have no level-one heading and must not become part of the catalog.
 * Synthetic fixtures only; no Claude login, network requests, or private prompts.
 */
import assert from "node:assert/strict";
import { codeModeCatalog, customAgentPrompt, skillsCatalog } from "../src/request-kind.ts";

const extract = (system: string) => codeModeCatalog([{ role: "system", content: system }]);
const catalog = [
  "# Code Mode",
  "",
  "Use the `execute` tool to call the tools listed below.",
  "",
  "The catalog is complete. Do not guess tool names.",
  "",
  "## Available tools",
  "",
  "- demo (2 tools) // Example tools",
  "  - tools.demo.read({",
  "  path: string,",
  "}): Promise<string> // Read a file",
  "  - tools.demo.status(): Promise<string> // Status",
].join("\n");
const environment = [
  "Today's date: Thu Oct 01 2026",
  "",
  "Here is some useful information about the environment you are running in:",
  "<env>",
  "  Working directory: /example/project",
  "  Workspace root folder: /example/project",
  "  Is directory a git repo: yes",
  "  Platform: linux",
  "</env>",
].join("\n");
const trailingSections = [
  "<mcp_instructions>Example MCP instructions</mcp_instructions>",
  "Skills provide specialized instructions and workflows for specific tasks.",
  "<available_skills>Example skill</available_skills>",
  environment,
  "When creating a worktree, consider moving the session.",
];

// Old and new instruction orders, plus a catalog with no following section.
assert.equal(extract(`${environment}\n\n${catalog}`), catalog);
assert.equal(extract(catalog), catalog);
assert.equal(extract(`${catalog}\n\n${trailingSections.join("\n\n")}`), catalog);
for (const section of trailingSections) {
  assert.equal(extract(`${catalog}\n\n${section}`), catalog);
}

// Do not truncate the multiline TypeScript signature or later tool entries.
const selected = extract(`${catalog}\n\n${environment}`);
assert.match(selected, /path: string,[\s\S]*tools\.demo\.status/);
assert.doesNotMatch(selected, /Today's date:|<env>|available_skills|mcp_instructions/);

// Partial catalogs have search guidance before the listings; empty namespaces
// are still a valid catalog when additional tools are discovered through search.
const partial = [
  "# Code Mode",
  "",
  "The catalog is partial. Use `search(...)` to find a tool.",
  "",
  "- search(query: string)",
  "",
  "## Available tools",
  "",
  "- demo (4 tools, none shown)",
].join("\n");
assert.equal(extract(`${partial}\n\n${environment}`), partial);

// OpenCode 2.2.1 renamed the listing heading to "## Code Mode tools (call
// only inside `execute`)"; the old one matched nothing, so no catalog went out.
const catalog221 = [
  "# Code Mode",
  "",
  "The tools listed below, and `search`, cannot be called directly: they only work as JavaScript inside the `execute` tool. Every other tool you have is a normal tool call: call it directly, never inside `execute`.",
  "",
  "The catalog is partial. Before calling a tool that is not listed below, find it with the global `search(...)` function. Do not guess tool names.",
  "",
  "- search(query: string)",
  "",
  "## Code Mode tools (call only inside `execute`)",
  "",
  "- demo (2 tools) // Example tools",
  "  - tools.demo.read({",
  "  path: string,",
  "}): Promise<string> // Read a file",
  "  - tools.demo.status(): Promise<string> // Status",
].join("\n");
assert.equal(extract(`${catalog221}\n\n${trailingSections.join("\n\n")}`), catalog221);

// Markdown headings, CRLF, and whitespace-only separators.
for (const heading of ["# Other instructions", "## Other instructions"]) {
  assert.equal(extract(`${catalog}\n${heading}\nExample`), catalog);
}
const windows = catalog.replaceAll("\n", "\r\n");
assert.equal(extract(`${windows}\r\n \t\r\n${environment}`), windows);

// System content may be split into messages and represented as text blocks.
assert.equal(codeModeCatalog([
  { role: "system", content: [{ type: "text", text: catalog }] },
  { role: "system", content: `\n${environment}` },
  { role: "user", content: "Unrelated user message" },
]), catalog);
assert.equal(codeModeCatalog([{ role: "user", content: catalog }]), "");

// Missing, inline, and malformed catalogs should not forward arbitrary context.
for (const system of [
  environment,
  "Mention # Code Mode inline",
  "# Code Mode\n\nNo catalog heading",
  "# Code Mode\n\n## Available tools\n\nNot a namespace listing",
]) {
  assert.equal(extract(system), "");
}

// The skills list lives only in the system prompt; Claude needs its ids
// to use the skill tool, and nothing after the list comes along.
const skillsBlock = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "<available_skills>",
  "  <skill>",
  "    <id>demo</id>",
  "    <name>demo</name>",
  "    <description>Demo skill</description>",
  "  </skill>",
  "</available_skills>",
].join("\n");
const skillsOf = (system: string) => skillsCatalog([{ role: "system", content: system }]);
assert.equal(skillsOf(`${catalog}\n\n${skillsBlock}\n\n${environment}`), skillsBlock);
assert.equal(
  skillsOf("Skills provide specialized instructions and workflows for specific tasks.\nNo skills are currently available.\n\nToday's date: x"),
  "Skills provide specialized instructions and workflows for specific tasks.\nNo skills are currently available.",
);
assert.equal(skillsOf(environment), "");
assert.equal(skillsCatalog([{ role: "user", content: skillsBlock }]), "");

// A custom agent's own prompt sits before OpenCode's "# Your Model"; stock
// prompts (build, plan, model-specific variants) are not forwarded.
const identity = "# Your Model\n- Name: Opus 5.5\n- Provider ID: claude-code";
const persona = "You hand-write text and data for the task you are given.\n\nNever use templates.";
const agentOf = (system: string) => customAgentPrompt([{ role: "system", content: system }]);
assert.equal(agentOf(`${persona}\n\n${identity}\n\n${catalog}`), persona);
assert.equal(agentOf(`You are an AI agent running in OpenCode, a coding agent harness.\n\n# Harness\n- x\n\n${identity}`), "");
assert.equal(agentOf(`You are OpenCode, an interactive general AI agent.\n\n${identity}`), "");
assert.equal(agentOf(`${persona}\n\n${catalog}`), "", "no identity heading: layout unknown");

console.log("code mode catalog regression ok");
