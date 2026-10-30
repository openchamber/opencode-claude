/**
 * OpenCode's instruction files (AGENTS.md) reach Claude unless Claude Code
 * already loads the same rules as CLAUDE.md; MCP server notes are forwarded
 * as OpenCode rendered them.
 *
 * On the simulators (test/simulators/): OpenCode loads the instruction files
 * as OpenCode 2.2.0 does (BEHAVIOR.md "The system prompt"; 2.0.32 the same): its global
 * AGENTS.md (in the world's home), the project's AGENTS.md, the files the
 * configuration's `instructions` name (`opencode.state.instructions`), each as
 * an "Instructions from: <path>" block of its system prompt; the MCP servers'
 * instructions from `opencode.state.mcpServers`. Each case is a chat turn in
 * its own project folder (OpenCode starts the plugin there), and what Claude
 * got is the query's system prompt. The files are the user's, on disk: in the
 * world's folders, the global CLAUDE.md in the world's Claude profile
 * (`CLAUDE_CONFIG_DIR`). The link case runs on Windows too: a file symlink
 * needs Developer Mode there, so a hard link (the same file for Claude Code)
 * stands in when it is refused. A long test of independent cases.
 *
 * Run: bun test/instruction-files-regression.ts
 */
import assert from "node:assert/strict";
import { linkSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mcpInstructionsBlock, openCodeConfigDir } from "./simulators/opencode.ts";
import { chatInFolder } from "./simulators/turns.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("instruction-files");
const { opencode } = world;
const root = join(world.tmp, "instructions");
mkdirSync(root);
const claudeConfig = process.env.CLAUDE_CONFIG_DIR!;
const failures: string[] = [];
const check = async (name: string, body: () => Promise<void>) => {
  const saved = { instructions: opencode.state.instructions, codeMode: opencode.state.codeMode, mcpServers: opencode.state.mcpServers };
  try {
    await body();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    Object.assign(opencode.state, saved);
  }
};
const folder = (name: string) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const chatIn = (directory: string, between: Array<() => void> = []) => chatInFolder(world, directory, between);
/** The instruction files the plugin forwarded: its section's blocks, "" for none. */
const forwarded = (append: string) => {
  const heading = /# Project instructions \(loaded by [^)]+\)\n\n/.exec(append);
  if (!heading) return "";
  const rest = append.slice(heading.index + heading[0].length);
  const next = rest.search(/\n\n# Session context \(/);
  return next < 0 ? rest : rest.slice(0, next);
};
const block = (path: string, text: string) => `Instructions from: ${realpathSync(path)}\n${text}`;
const shared = join(root, "opencode-only.md");
writeFileSync(shared, "OpenCode-only rules.\n");

try {
  await opencode.startPlugin();

  // A project's own AGENTS.md: OpenCode loads it, and Claude Code loads it itself: not forwarded.
  await check("the project's AGENTS.md", async () => {
    const project = folder("only-agents");
    writeFileSync(join(project, "AGENTS.md"), "The codeword is PELICAN-77.\n");
    const [{ system, append }] = await chatIn(project);
    assert.ok(system.includes(`${block(join(project, "AGENTS.md"), "The codeword is PELICAN-77.\n")}`), "OpenCode's prompt holds it");
    assert.equal(forwarded(append), "");
    assert.doesNotMatch(append, /PELICAN-77/);
  });

  // A file the configuration names, outside the project: OpenCode-only, forwarded.
  await check("a configured file", async () => {
    opencode.state.instructions = [shared];
    const [{ system, append }] = await chatIn(folder("configured"));
    assert.ok(system.includes(block(shared, "OpenCode-only rules.\n")));
    assert.equal(forwarded(append), block(shared, "OpenCode-only rules."));
  });

  // CLAUDE.md symlinked to an AGENTS.md outside the project, which the configuration names: Claude Code reads it
  // already. Windows refuses file symlinks without Developer Mode; a hard link there is the same file for Claude Code.
  await check("a CLAUDE.md linked to the configured file", async () => {
    const sharedAgents = join(folder("shared"), "AGENTS.md");
    writeFileSync(sharedAgents, "Linked rules.\n");
    const linked = folder("linked");
    try {
      symlinkSync(join("..", "shared", "AGENTS.md"), join(linked, "CLAUDE.md"));
    } catch (err) {
      if (process.platform !== "win32" || (err as NodeJS.ErrnoException).code !== "EPERM") throw err;
      linkSync(sharedAgents, join(linked, "CLAUDE.md"));
    }
    opencode.state.instructions = [sharedAgents];
    const [{ system, append }] = await chatIn(linked);
    assert.ok(system.includes(block(sharedAgents, "Linked rules.\n")));
    assert.equal(forwarded(append), "");
  });

  // A file changed on disk after OpenCode loaded it: OpenCode's prompt keeps the text it loaded (its update comes as
  // a message), and the plugin sends no text OpenCode's prompt does not hold.
  await check("a file changed since OpenCode loaded it", async () => {
    const file = join(folder("changing"), "rules.md");
    writeFileSync(file, "Older text.\n");
    opencode.state.instructions = [file];
    const [first, second] = await chatIn(folder("changing-project"), [() => writeFileSync(file, "Newer text.\n")]);
    assert.equal(forwarded(first!.append), block(file, "Older text."));
    assert.ok(second!.system.includes("Older text.") && !second!.system.includes("Newer text."), "OpenCode's prompt as first loaded");
    assert.equal(forwarded(second!.append), "");
  });

  // OpenCode's global AGENTS.md: forwarded; with the same text as the global CLAUDE.md, skipped.
  const globalAgents = join(openCodeConfigDir(), "AGENTS.md");
  mkdirSync(openCodeConfigDir(), { recursive: true });
  writeFileSync(globalAgents, "Global rules.\n");
  await check("OpenCode's global AGENTS.md", async () => {
    const [{ system, append }] = await chatIn(folder("global"));
    assert.ok(system.includes(block(globalAgents, "Global rules.\n")));
    assert.equal(forwarded(append), block(globalAgents, "Global rules."));
  });
  await check("the global AGENTS.md with the global CLAUDE.md's text", async () => {
    writeFileSync(join(claudeConfig, "CLAUDE.md"), "Global rules.\n");
    const [{ append }] = await chatIn(folder("global-same"));
    assert.equal(forwarded(append), "");
  });

  // The global CLAUDE.md imports files with `@path`: Claude Code expands the imports itself (nested, not inside code
  // spans), so a configured file imported, or with an imported file's text, is not forwarded again; the global
  // AGENTS.md (no longer the CLAUDE.md's text) comes first, as OpenCode orders them.
  await check("files the global CLAUDE.md imports", async () => {
    const imports = folder("imports");
    writeFileSync(join(imports, "chain-b.md"), "Chained rules.\n");
    writeFileSync(join(imports, "chain-a.md"), "See @./chain-b.md for the chain.\n");
    const chained = join(root, "chained-AGENTS.md");
    writeFileSync(chained, "Chained rules.\n");
    const other = join(root, "other-AGENTS.md");
    writeFileSync(other, "Other rules.\n");
    writeFileSync(join(claudeConfig, "CLAUDE.md"), `@${shared}\n\n- chain @${join(imports, "chain-a.md")}\n- literal \`@${other}\`\n`);
    opencode.state.instructions = [shared, chained, other];
    const [{ append }] = await chatIn(folder("importing"));
    assert.equal(forwarded(append), [block(globalAgents, "Global rules."), block(other, "Other rules.")].join("\n\n"));
  });

  // The MCP servers' instructions, as OpenCode rendered them (sorted by server, the line naming the server's
  // namespace for `execute`).
  await check("MCP servers' instructions", async () => {
    opencode.state.codeMode = { tools: [] };
    opencode.state.mcpServers = [
      { server: "linear", instructions: "Use tools.\nKeep issues short.", tools: [{ name: "list_issues", description: "List issues" }] },
      { server: "docs.site", instructions: "Search first.", tools: [{ name: "search" }] },
      { server: "silent", tools: [{ name: "ping" }] },
    ];
    const [{ system, append }] = await chatIn(folder("mcp"));
    const rendered = mcpInstructionsBlock(opencode.state.mcpServers.filter((server) => server.instructions));
    assert.match(rendered, /^<mcp_instructions>\n  <server name="docs.site">\n    Use tools from this server through `execute` under `tools\["docs_site"\]`\.\n    Search first\.\n  <\/server>\n  <server name="linear">/);
    assert.ok(system.includes(rendered), "OpenCode's prompt holds the block");
    assert.ok(append.includes(rendered), `the block as OpenCode rendered it: ${append}`);
    assert.doesNotMatch(append, /Today's date|<env>/);
  });
  // With `execute` denied: instruction-files-mcp-without-execute-regression.ts (a finding).

  const errors = world.journal().filter((line) => /level=error/.test(line));
  if (errors.length > 0) failures.push(`the plugin's journal has errors: ${errors.join("\n")}`);
} finally {
  await world.dispose();
}
if (failures.length > 0) {
  console.error(`instruction files regression: ${failures.length} failed\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("instruction files regression ok");
process.exit(0);
