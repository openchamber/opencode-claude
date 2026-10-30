/**
 * Finding and installing the Claude Code CLI: the install locations a clean
 * server PATH misses, the one-click install (official npm package, the
 * install script as fallback), and the resolution kept per PATH and HOME.
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): the CLI is the Claude
 * Code simulator's process laid out by `claude.installCli`, the installers
 * (npm, curl, bash) are its processes in the world's bin.
 * Independent cases (test/simulators/cases.ts).
 *
 * Run: bun test/cli-setup-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

const world = await createWorld("cli-setup");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();
const { resolveClaudeCli, resetClaudeCliResolutionCache } = await pluginModule("executable-path");

await cases.run("the CLI in ~/.local/bin is found when the server PATH misses it", async () => {
  // The official installer's ~/.local/bin (the simulator's CLI laid out there, `local-bin`: claude.exe on Windows,
  // `claude` elsewhere).
  const { detectClaudeCode } = world.plugin.detect;
  const home = join(world.tmp, "home-with-local-bin");
  const emptyPath = join(world.tmp, "server-path");
  mkdirSync(emptyPath, { recursive: true });
  const installed = claude.installCli(join(home, ".local", "bin"), { layout: "local-bin" });
  installed.set({ version: "2.1.226" });
  const env = { PATH: emptyPath, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming") };
  resetClaudeCliResolutionCache();
  try {
    const found = await resolveClaudeCli(env);
    assert.equal(found, join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude"));
    // The CLI found there runs.
    assert.equal((await detectClaudeCode({ binaryPath: found })).version, "2.1.226");
    assert.ok(installed.calls().some((call) => call.args[0] === "--version"), "the install in ~/.local/bin answered");
    // And PATH itself still wins when the CLI is on it (the world's npm install).
    assert.notEqual(await resolveClaudeCli({ ...env, PATH: process.env.PATH! }), found);
  } finally {
    resetClaudeCliResolutionCache();
  }
});

// The one-click install path: official npm package, script as fallback. npm only off Windows: there npm is a .cmd
// the plugin cannot spawn without a shell, so it goes on to curl and bash, as on a real host.
const { installClaudeCli } = await pluginModule("cli-install");
const bin = join(world.tmp, "bin");
claude.installers.install(bin);
const commands = (from: number) => claude.installers.calls().slice(from).map((call) => call.command);

if (process.platform !== "win32") {
  await cases.run("npm succeeds: no install script runs", async () => {
    const from = claude.installers.calls().length;
    assert.deepEqual(await installClaudeCli(), { ok: true });
    assert.deepEqual(claude.installers.calls().slice(from).map((call) => [call.command, ...call.args]), [["npm", "install", "-g", "@anthropic-ai/claude-code"]]);
    // npm laid its `claude` over the world's: lay the world's CLI out again.
    claude.installCli(bin);
  });
}

await cases.run("npm fails or cannot start: the official install script runs and its failure is reported", async () => {
  claude.installers.set({ npm: "fail", curl: "fail" });
  try {
    const from = claude.installers.calls().length;
    const result = await installClaudeCli();
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /^Install script failed: curl: failed/m);
    assert.match(result.ok ? "" : result.message, /^npm install failed: /m);
    assert.deepEqual(commands(from), process.platform === "win32" ? ["curl"] : ["npm", "curl"]);
  } finally {
    claude.installers.set({ npm: "ok", curl: "ok" });
  }
});

await cases.run("the CLI's resolution is kept per PATH and HOME until the cache is reset", async () => {
  // Re-probing would spawn several child processes on every query. Claude Code installed in a folder of its own, then
  // removed behind the plugin's back.
  const binDir = join(world.tmp, "smoke-cli-cache");
  // HOME and APPDATA: an empty folder, so the well-known install folders cannot mask a negative result.
  const home = join(world.tmp, "smoke-cli-cache-home");
  mkdirSync(home, { recursive: true });
  claude.installCli(binDir);
  const env = { PATH: binDir, HOME: home, APPDATA: home };
  const inBin = (path: string | null) => !!path && path.replaceAll("\\", "/").startsWith(binDir.replaceAll("\\", "/"));
  resetClaudeCliResolutionCache();
  try {
    const first = await resolveClaudeCli(env);
    assert.ok(inBin(first), `the installed CLI resolved: ${first}`);
    rmSync(binDir, { recursive: true, force: true });
    assert.equal(await resolveClaudeCli(env), first, "resolution must be memoized");
    resetClaudeCliResolutionCache();
    assert.equal(await resolveClaudeCli(env), null, "cache reset must re-probe");
  } finally {
    resetClaudeCliResolutionCache();
  }
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
