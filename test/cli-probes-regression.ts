/**
 * Regression for the fork's 70bf4ad:
 * - CLI probes (auth status, version, resolution) spawn asynchronously, so a
 *   slow `claude` never freezes the OpenCode server's event loop;
 * - a superseded `claude auth login` child exiting late cannot tear down or
 *   fail the sign-in flow that replaced it.
 *
 * On the simulators (test/simulators/): the `claude` the plugin finds on
 * PATH is the Claude Code simulator's process (claude-cli.mjs, laid out as
 * npm installs it); a slow or hung CLI is `claude.cli.set({ delayMs })`, its
 * starts are `claude.cli.calls()`, a CLI installed later is `installCli` into
 * a folder the plugin searched before (with its own handle). The sign-in is
 * the CLI's `auth login --claudeai` up to its page (a new one each start);
 * no code is ever sent. The world's PATH holds only its bin and node, so
 * the installer first meets a host without npm, curl and bash (spawn fails);
 * then the simulator's installers go into the world's bin
 * (`claude.installers`: curl and bash, and npm except on Windows, where npm
 * is a .cmd the plugin cannot spawn without a shell), one of them hanging or
 * all succeeding. No real installer is ever started. The probes are the
 * plugin's own (detect.ts, executable-path.ts, cli-login.ts, cli-install.ts).
 *
 * Run: bun test/cli-probes-regression.ts
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { createWorld, pluginModule } from "./simulators/world.ts";

/** Where the plugin finds the simulator's CLI in `bin`: npm's cli.js behind claude.cmd on Windows, the script elsewhere. */
const cliIn = (bin: string) => (process.platform === "win32" ? join(bin, "node_modules", "@anthropic-ai", "claude-code", "cli.js") : `${bin}/claude`);

async function main() {
  const world = await createWorld("cli-probes");
  const { claude } = world;
  const { probeClaudeAuthStatusCli, detectClaudeCode } = world.plugin.detect;
  const { resetClaudeCliResolutionCache, resolveClaudeCli, runCliProbe } = await pluginModule("executable-path");
  const bin = join(world.tmp, "bin");
  try {
    resetClaudeCliResolutionCache();
    const cli = await resolveClaudeCli(process.env);
    assert.equal(cli, cliIn(bin), "the plugin finds the CLI on PATH");

    // The event loop keeps ticking while the slow CLI answers (a sync spawn
    // would allow at most one tick).
    claude.cli.set({ delayMs: 400, version: "2.1.300" });
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 20);
    const status = await probeClaudeAuthStatusCli({ binaryPath: cli });
    clearInterval(ticker);
    assert.equal(status?.loggedIn, true);
    assert.ok(ticks >= 8, `event loop blocked during the probe (${ticks} ticks)`);

    const detected = await detectClaudeCode();
    assert.equal(detected.version, "2.1.300");
    assert.equal(detected.status, "ready");
    assert.deepEqual(claude.cli.calls().slice(-2).map((call) => call.args.join(" ")), ["--version", "auth status --json"], "detection ran the CLI it found");

    // A hung CLI is killed at the timeout instead of hanging the caller.
    claude.cli.set({ delayMs: 30_000 });
    const started = Date.now();
    const timedOut = await runCliProbe(cli, ["--version"], { timeoutMs: 300 });
    assert.equal(timedOut.failed, true);
    assert.ok(Date.now() - started < 5_000);
    claude.cli.set({ delayMs: 0 });

    // Concurrent callers share one probe (on Windows the shim is unwrapped on disk: no start at all).
    resetClaudeCliResolutionCache();
    const before = claude.cli.calls().length;
    const both = await Promise.all([resolveClaudeCli(process.env), resolveClaudeCli(process.env)]);
    assert.deepEqual(both, [cli, cli]);
    assert.ok(claude.cli.calls().length - before <= 1, "one shared probe");

    // A miss is remembered briefly.
    const empty = join(world.tmp, "empty");
    mkdirSync(empty);
    const missEnv = { PATH: empty, HOME: empty, APPDATA: empty };
    resetClaudeCliResolutionCache();
    assert.equal(await resolveClaudeCli(missEnv), null);
    // Installed behind our back: the cached miss still answers for a while…
    const later = claude.installCli(empty);
    assert.equal(await resolveClaudeCli(missEnv), null, "miss is cached");
    // …while the install action's reset makes it visible at once.
    resetClaudeCliResolutionCache();
    assert.equal(await resolveClaudeCli(missEnv), cliIn(empty));
    later.set({ version: "2.1.301" });
    assert.equal((await detectClaudeCode({ binaryPath: cliIn(empty) })).version, "2.1.301", "the new install runs");
    assert.equal(later.calls().length, 2, "the new install's own starts: version and sign-in");
    resetClaudeCliResolutionCache();

    // Superseded login child: its late exit must not fail the current flow.
    {
      const { startClaudeCliLogin, cancelClaudeCliLogin, getClaudeCliLoginStatus, resetClaudeCliLoginForTests } = await pluginModule("cli-login");
      const first = await startClaudeCliLogin({ urlTimeoutMs: 5_000 });
      assert.equal(first.state, "awaiting-code", `the CLI's sign-in printed its page: ${JSON.stringify(first)}`);
      cancelClaudeCliLogin();
      const second = await startClaudeCliLogin({ urlTimeoutMs: 5_000 });
      assert.equal(second.state, "awaiting-code");
      assert.notEqual(second.url, first.url, "a new sign-in, a new page");
      // The killed first child exits only now.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(claude.cli.calls().filter((call) => call.args.join(" ") === "auth login --claudeai").length, 2);
      assert.deepEqual(getClaudeCliLoginStatus(), { state: "awaiting-code", url: second.url });
      cancelClaudeCliLogin();
      resetClaudeCliLoginForTests();
    }

    // Installer on a host without npm, curl and bash: every attempt is a result, not a throw.
    {
      // Never the machine's installers: the world's PATH holds only its bin and node. (Bun.which without a
      // PATH reads the one the process started with; the installer spawns with process.env, the world's.)
      for (const command of ["npm", "curl", "bash"]) assert.equal(Bun.which(command, { PATH: process.env.PATH! }), null, `${command} is not reachable from the world`);
      const { installClaudeCli } = await pluginModule("cli-install");
      const missing = await installClaudeCli();
      assert.equal(missing.ok, false);
      const message = missing.ok ? "" : missing.message;
      assert.match(message, /^Install script failed: .*curl/m, `both installers named: ${message}`);
      assert.match(message, /^npm install failed: .*npm/m);

      // A temp-dir failure for the script is reported too.
      const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
      process.env.TMPDIR = process.env.TEMP = process.env.TMP = join(world.tmp, "definitely-missing-dir", "nested");
      try {
        const noTmp = await installClaudeCli();
        assert.equal(noTmp.ok, false);
        assert.match(noTmp.ok ? "" : noTmp.message, /temp dir/);
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      // The installers on the world's PATH. On Windows npm is a .cmd the plugin cannot spawn without
      // a shell, so the install goes through curl and bash there; elsewhere npm comes first.
      const windows = process.platform === "win32";
      const { installers } = claude;
      installers.install(bin);
      const commands = () => installers.calls().map((call) => call.command);

      // One total budget: the step that hangs uses it up, the next one gets no fresh budget. The budget lets the
      // simulator's installer (a compiled executable) start and note its call on a busy machine too; a fresh
      // budget for the fallback would take twice as long.
      installers.set(windows ? { curl: "hang" } : { npm: "hang" });
      const budget = 2_000;
      const startedInstall = Date.now();
      const slow = await installClaudeCli({ timeoutMs: budget });
      assert.equal(slow.ok, false);
      assert.match(slow.ok ? "" : slow.message, /timed out/);
      assert.deepEqual(commands(), windows ? ["curl"] : ["npm"], "no fresh budget for the fallback");
      assert.ok(Date.now() - startedInstall < budget + 1_500);

      // An install that succeeds: the CLI is found at once, without waiting for the cached miss.
      installers.set({ npm: "ok", curl: "ok", bash: "ok" });
      const before = installers.calls().length;
      assert.deepEqual(await installClaudeCli(), { ok: true });
      assert.deepEqual(installers.calls().slice(before).map((call) => call.command), windows ? ["curl", "bash"] : ["npm"]);
      if (windows) {
        // The official script put claude.exe in ~/.local/bin, where the plugin looks off PATH.
        const nothing = join(world.tmp, "nothing");
        mkdirSync(nothing);
        const offPath = { PATH: nothing, HOME: process.env.HOME!, APPDATA: process.env.APPDATA! };
        const installed = await resolveClaudeCli(offPath);
        assert.equal(installed, join(process.env.HOME!, ".local", "bin", "claude.exe"));
        assert.equal((await detectClaudeCode({ binaryPath: installed })).status, "ready", "the installed CLI runs");
      } else {
        assert.ok(await resolveClaudeCli(process.env), "the installed CLI is found");
      }
      resetClaudeCliResolutionCache();
    }

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — cli probes regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
