/**
 * Claude Code cuts MCP tool descriptions at 2048 chars by default (4096 from
 * 2.1.296), which hid the end of OpenChamber's longer tool instructions. The
 * child env must raise the limit unless the user set their own.
 *
 * Run: bun test/mcp-description-limit-regression.ts
 */
import assert from "node:assert/strict";
import { pluginModule } from "./simulators/world.ts";

// The plugin of the tree under test (OPENCODE_CLAUDE_PLUGIN_DIR), as every test reads it.
const { buildClaudeCodeChildEnv, MCP_DESCRIPTION_LIMIT } = await pluginModule("auth-env");

const env = buildClaudeCodeChildEnv({ PATH: "/bin" });
assert.equal(env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, String(MCP_DESCRIPTION_LIMIT));
assert.ok(MCP_DESCRIPTION_LIMIT >= 5132 + 1000, "room for openchamber_render's full description");

const own = buildClaudeCodeChildEnv({ CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "3000" });
assert.equal(own.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, "3000", "the user's limit wins");

console.log("mcp-description-limit regression ok");
