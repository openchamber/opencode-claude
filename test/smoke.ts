/**
 * Smoke test for opencode-claude — no live Claude CLI required: the plugin
 * builds, loads and answers one turn.
 *
 * On the simulators (test/simulators/, BEHAVIOR.md "Writing a test"): the
 * OpenCode simulator starts the real plugin, the Claude Code simulator answers
 * behind its proxy. The plugin's other checks live in the topic tests
 * (`*-regression.ts`); this one only says the plugin is there at all.
 *
 * The build writes the dist/ of the tree under test.
 *
 * Run: bun test/smoke.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("smoke");
  const { opencode, claude } = world;
  await opencode.startPlugin();
  const { PROVIDER_ID } = await pluginModule("constants");
  const { getProxyPort, getClaudeProxyBaseUrl, PROXY_IDLE_TIMEOUT_SECONDS } = await pluginModule("proxy");

  // The plugin's export, and the provider OpenCode got from its setup.
  const { ClaudeCodePlugin } = world.plugin.index;
  assert.equal(ClaudeCodePlugin.id, "openchamber.claude-code");
  assert.equal(typeof ClaudeCodePlugin.setup, "function");
  assert.equal(PROVIDER_ID, "claude-code");
  const info: any = opencode.instances[0]!.provider.info;
  assert.equal(info.activation, "enabled");
  assert.equal(info.package, "@opencode/ai/providers/openai-compatible");
  assert.equal(info.settings.baseURL, getClaudeProxyBaseUrl(), "the live proxy");

  // One turn: OpenCode's request reaches Claude Code and its answer comes back.
  {
    const chat = opencode.newChat();
    await opencode.say(chat, "hi");
    const asked = claude.queries.length;
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
    assert.equal(claude.queries.length - asked, 1, "one Claude Code query");
    assert.ok((turn.answer?.text ?? "").length > 0, "an answer");
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  }

  // The proxy OpenCode's request went to: health and the model list.
  const port = getProxyPort()!;
  assert.ok(port > 0);
  assert.ok(getClaudeProxyBaseUrl().includes(String(port)));
  // Bun's default 10s idleTimeout RSTs the socket while we probe the Claude
  // turn (no HTTP bytes until first content). 0 disables, matching OpenCode.
  assert.equal(PROXY_IDLE_TIMEOUT_SECONDS, 0);
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { ok: boolean }).ok, true);
  const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(modelsRes.status, 200);
  const modelsJson = (await modelsRes.json()) as { data: unknown[] };
  assert.ok(Array.isArray(modelsJson.data) && modelsJson.data.length > 0);

  // TypeScript build of the plugin under test (bun itself: the world's PATH holds no bun)
  {
    const build = spawnSync(process.execPath, ["run", "build"], { cwd: world.dir, encoding: "utf8" });
    if (build.status !== 0) {
      console.error(build.stdout);
      console.error(build.stderr);
      throw new Error("build failed");
    }
  }

  await world.dispose();
  console.log("ok — opencode-claude smoke tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
