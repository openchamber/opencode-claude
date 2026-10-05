/**
 * OpenCode's instruction files (AGENTS.md) reach Claude unless Claude Code
 * already loads the same rules as CLAUDE.md; MCP server notes are forwarded
 * as OpenCode rendered them.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "oc-claude-instr-"));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const { mcpInstructions, openCodeInstructionFiles } = await import("../src/opencode-context.ts");

const system = (blocks: string[]) => [{ role: "system", content: blocks.join("\n\n") }];
const block = (path: string, text: string) => `Instructions from: ${path}\n${text}`;

// A project's own AGENTS.md: Claude Code loads it itself, not forwarded.
const onlyAgents = join(root, "only-agents");
mkdirSync(onlyAgents);
writeFileSync(join(onlyAgents, "AGENTS.md"), "The codeword is PELICAN-77.\n");
assert.equal(
  openCodeInstructionFiles(system([block(join(onlyAgents, "AGENTS.md"), "The codeword is PELICAN-77.")]), onlyAgents),
  "",
);

// An OpenCode-only file outside the project (global AGENTS.md, configured
// instructions): forwarded.
const opencodeGlobal = join(root, "opencode-config", "AGENTS.md");
mkdirSync(join(root, "opencode-config"));
writeFileSync(opencodeGlobal, "OpenCode-only rules.\n");
assert.equal(
  openCodeInstructionFiles(system([block(opencodeGlobal, "OpenCode-only rules.")]), onlyAgents),
  `Instructions from: ${opencodeGlobal}\nOpenCode-only rules.`,
);

// CLAUDE.md symlinked to AGENTS.md: Claude Code reads it already.
const linked = join(root, "linked");
mkdirSync(linked);
writeFileSync(join(linked, "AGENTS.md"), "Linked rules.\n");
symlinkSync("AGENTS.md", join(linked, "CLAUDE.md"));
assert.equal(openCodeInstructionFiles(system([block(join(linked, "AGENTS.md"), "Linked rules.")]), linked), "");

// A global AGENTS.md with the same text as the global CLAUDE.md: skipped.
const globalAgents = join(root, "global-AGENTS.md");
writeFileSync(globalAgents, "Global rules.\n");
writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, "CLAUDE.md"), "Global rules.\n");
assert.equal(openCodeInstructionFiles(system([block(globalAgents, "Global rules.")]), onlyAgents), "");

// A path whose text isn't in the prompt (changed on disk since) is not sent.
assert.equal(openCodeInstructionFiles(system([block(opencodeGlobal, "Older text.")]), onlyAgents), "");

// The global CLAUDE.md imports the OpenCode-only file with `@path`: Claude
// Code expands the import itself, so the file is not forwarded again.
const imports = join(root, "imports");
mkdirSync(imports);
writeFileSync(join(imports, "chain-b.md"), "Chained rules.\n");
writeFileSync(join(imports, "chain-a.md"), "See @./chain-b.md for the chain.\n");
const chained = join(root, "chained-AGENTS.md");
writeFileSync(chained, "Chained rules.\n");
const other = join(root, "other-AGENTS.md");
writeFileSync(other, "Other rules.\n");
writeFileSync(
  join(process.env.CLAUDE_CONFIG_DIR, "CLAUDE.md"),
  `@${opencodeGlobal}\n\n- chain @${join(imports, "chain-a.md")}\n- literal \`@${other}\`\n`,
);
const forwarded = openCodeInstructionFiles(
  system([
    block(opencodeGlobal, "OpenCode-only rules."),
    block(chained, "Chained rules."),
    block(other, "Other rules."),
  ]),
  onlyAgents,
);
assert.equal(forwarded, `Instructions from: ${other}\nOther rules.`);

const mcp = "<mcp_instructions>\n  <server name=\"linear\">\n    Use tools.\n  </server>\n</mcp_instructions>";
assert.equal(mcpInstructions(system(["# Code Mode", mcp, "Today's date: x"])), mcp);
assert.equal(mcpInstructions(system(["Today's date: x"])), "");

console.log("instruction files regression ok");
