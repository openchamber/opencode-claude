/**
 * Regression for #40: on Windows the resolver must never hand the Agent SDK a
 * `.cmd`/`.bat` shim (or a bare `claude` its spawn would resolve to one) —
 * Node/Bun refuse to spawn a batch file with the SDK's `--settings` JSON.
 * npm's shim is unwrapped to the native `claude.exe` / `cli.js` beside it.
 *
 * Runs on any OS: `process.platform` is pinned to win32 for this process.
 *
 * On the simulators (test/simulators/): the CLI is the Claude Code
 * simulator's process, laid out by `installCli(dir, { layout })` as each
 * install puts it: npm's older `cli.js` behind `claude.cmd` (the world's own,
 * on PATH), npm's `bin/claude.exe` of 2.1.312, the official installer's
 * `claude.exe` alone (~/.local/bin), npm's shims with no package. The
 * binaries are the simulator compiled, so the plugin finds them and runs
 * them; each install has its own handle (`set`, `calls`). The old test's
 * "native exe beside a shim in one folder" is no install any source shows:
 * the official installer's folder (local-bin) on PATH stands for it.
 *
 * Which executable the plugin's query start hands the SDK (`executable:
 * "node"` for cli.js, none for an exe; the old test stubbed the SDK's
 * `query`): a chat turn through the plugin's real query starter and the real
 * SDK starts the simulated CLI, which logs what ran it (`runner`) and refuses
 * the turn.
 *
 * Run: bun test/windows-cli-regression.ts
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { CliLayout } from "./simulators/claude-code.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  Object.defineProperty(process, "platform", { value: "win32" });
  const world = await createWorld("windows-cli");
  const { claude } = world;
  const { detectClaudeCode } = world.plugin.detect;
  const { resetClaudeCliResolutionCache, resolveClaudeCli, resolveWindowsClaudePath, cliInvocation } = await pluginModule("executable-path");
  const empty = join(world.tmp, "empty");
  mkdirSync(empty);
  const pkg = (dir: string) => join(dir, "node_modules", "@anthropic-ai", "claude-code");
  const resolve = (env: Record<string, string>) => {
    resetClaudeCliResolutionCache();
    return resolveClaudeCli({ HOME: empty, APPDATA: empty, ...env });
  };
  /** Claude Code installed into `dir` in this layout: its own handle. */
  const install = (dir: string, layout: CliLayout) => {
    mkdirSync(dir, { recursive: true });
    return claude.installCli(dir, { layout });
  };
  /** The plugin's detection runs what it resolved: the version that install answers. */
  const detects = async (path: string, cli: { set: (state: { version: string }) => void }, version: string) => {
    cli.set({ version });
    const detected = await detectClaudeCode({ binaryPath: path });
    assert.equal(detected.version, version, `${path} ran`);
    assert.equal(detected.status, "ready");
  };
  try {
    // The world's npm install on PATH (no native binary): the shim resolves to cli.js beside it.
    const bin = join(world.tmp, "bin");
    const cliJs = join(pkg(bin), "cli.js");
    assert.equal(await resolve({ PATH: bin }), cliJs);
    // cli.js is not executable on its own: probes, login and the SDK run it
    // through node (the SDK would pick bun inside OpenCode).
    assert.deepEqual(cliInvocation(cliJs, ["--version"]), ["node", [cliJs, "--version"]]);
    await detects(cliJs, claude.cli, "2.1.300");

    // npm global bin on PATH: the shim resolves to the native exe beside it.
    const npm = join(world.tmp, "npm");
    const npmCli = install(npm, "npm");
    const exe = join(pkg(npm), "bin", "claude.exe");
    assert.equal(await resolve({ PATH: npm }), exe);
    assert.deepEqual(cliInvocation(exe, ["--version"]), [exe, ["--version"]]);
    await detects(exe, npmCli, "2.1.301");
    assert.deepEqual(npmCli.calls().map((call) => call.args.join(" ")), ["--version", "auth status --json"], "the exe itself ran, not the shim");

    // Older installs without the native binary fall back to cli.js.
    const legacy = join(world.tmp, "legacy");
    install(legacy, "npm-legacy");
    assert.equal(await resolve({ PATH: legacy }), join(pkg(legacy), "cli.js"));

    // A native exe on PATH (the official installer's folder) is taken as it is.
    const native = join(world.tmp, "native");
    const nativeCli = install(native, "local-bin");
    assert.equal(await resolve({ PATH: native }), `${native}/claude.exe`);
    await detects(`${native}/claude.exe`, nativeCli, "2.1.302");

    // A shim with no target, npm's sh shim and the bare name are all unusable:
    // no path at all lets the SDK use its bundled executable instead.
    const orphan = join(world.tmp, "orphan");
    install(orphan, "orphan");
    assert.equal(await resolve({ PATH: orphan }), null);
    assert.equal(await resolveWindowsClaudePath(join(orphan, "claude")), null);

    // Off PATH: found in npm's Windows global bin under %APPDATA%.
    const appData = join(world.tmp, "AppData", "Roaming");
    install(join(appData, "npm"), "npm");
    assert.equal(await resolve({ PATH: empty, APPDATA: appData }), join(pkg(join(appData, "npm")), "bin", "claude.exe"));

    // …and in the official installer's ~/.local/bin.
    const home = join(world.tmp, "home-installer");
    install(join(home, ".local", "bin"), "local-bin");
    assert.equal(await resolve({ PATH: empty, HOME: home }), join(home, ".local", "bin", "claude.exe"));
    resetClaudeCliResolutionCache();

    // What the plugin's query start hands the SDK: cli.js with `executable: "node"`, an exe as it is.
    // A chat turn through the plugin's real query starter and the real SDK (world.throughRealSdk): the CLI
    // logs what ran it.
    await world.opencode.startPlugin();
    const runnersOfTurn = async (cli: { calls: typeof claude.cli.calls }) => [(await world.throughRealSdk(cli)).runner];
    assert.deepEqual(await runnersOfTurn(claude.cli), ["node"], "the world's cli.js runs through node");
    // A host whose PATH has npm's native binary first.
    const worldPath = process.env.PATH!;
    process.env.PATH = [npm, ...worldPath.split(delimiter).slice(1)].join(delimiter);
    try {
      resetClaudeCliResolutionCache();
      assert.deepEqual(await runnersOfTurn(npmCli), ["claude"], "the exe runs as it is");
    } finally {
      process.env.PATH = worldPath;
      resetClaudeCliResolutionCache();
    }
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — windows cli regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
