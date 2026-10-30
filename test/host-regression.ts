/**
 * The host Claude is told about and the name of the tool bridge follow
 * OPENCHAMBER_RUNTIME: OpenChamber's managed OpenCode sets it, an OpenCode
 * the user started does not.
 */
import assert from "node:assert/strict";
import { pluginModule } from "./simulators/world.ts";

// The plugin of the tree under test (OPENCODE_CLAUDE_PLUGIN_DIR), as every test reads it.
const { currentHost, mcpToolName, openCodeToolName } = await pluginModule("host");

const chamber = currentHost({ OPENCHAMBER_RUNTIME: "desktop" });
assert.deepEqual(chamber, { name: "OpenChamber", mcpServer: "openchamber" });
assert.equal(mcpToolName("read", chamber), "mcp__openchamber__read");

const plain = currentHost({});
assert.deepEqual(plain, { name: "OpenCode", mcpServer: "opencode" });
assert.equal(currentHost({ OPENCHAMBER_RUNTIME: "  " }).name, "OpenCode");
assert.equal(mcpToolName("read", plain), "mcp__opencode__read");

// Sessions carry calls under either name after the switch.
assert.equal(openCodeToolName("mcp__openchamber__edit"), "edit");
assert.equal(openCodeToolName("mcp__opencode__edit"), "edit");

// The runtime note names the host this process runs under.
delete process.env.OPENCHAMBER_RUNTIME;
const { buildRuntimeInstructions } = await pluginModule("prompt");
assert.match(buildRuntimeInstructions({}), /running in OpenCode through the Claude Code harness/);
process.env.OPENCHAMBER_RUNTIME = "web";
assert.match(buildRuntimeInstructions({}), /running in OpenChamber through the Claude Code harness/);

console.log("host regression ok");
