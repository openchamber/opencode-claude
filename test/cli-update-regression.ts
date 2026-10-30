/**
 * Regression for the CLI auto-update (src/cli-update.ts):
 * - `claude update` output maps to one outcome each, and exit 0 alone is not
 *   taken for success (the CLI exits 0 when another process holds the lock);
 *   a failure reports the CLI's last line, not its "Current version" preamble,
 *   or the cause above the "claude doctor" hint, and a successful update drops
 *   the memoized CLI path;
 * - every run ends with `claude --version`, and an update or "up to date" the
 *   installed version contradicts is a failure;
 * - the periodic check runs once per interval across plugin instances and
 *   server processes, through the shared record file claimed before the run
 *   (and in memory when the file cannot be written), waits for a missing CLI,
 *   and is off under the documented switches;
 * - the run settles on `close`, so output after `exit` still counts, and on
 *   `exit` alone when a child never closes.
 *
 * On the simulators (test/simulators/): the plugin's module through
 * `pluginModule("cli-update")` in the world's environment (its data folder,
 * home and PATH are set before the module loads, so no real `claude` is found
 * or updated); the plugin itself is not started in this process. The output
 * parser and the switches are pure functions. The periodic check runs the
 * plugin's own `claude update` of a native install in a folder of its own
 * (the only CLI on the PATH of the check's environment; a slow CLI,
 * `delayMs`, for a run that outlasts the interval), counted in the install's
 * `calls()`; with no CLI on its PATH the plugin's install action puts one in
 * place through the simulated installers. Another server process on the
 * machine (`world.secondProcess`, BEHAVIOR.md "The machine"; its plugin
 * started with `cliAutoUpdate: true`, the PATH and interval of the check)
 * claims the record and runs `claude update` itself: killed mid-run
 * (`kill()`) it leaves its claim; with its clock behind (`clockShiftMs`) its
 * claim or record is that old - a claim a minute or twelve minutes old, a
 * record months old, which the test then makes read-only (the machine's
 * state, not a form of the plugin). A second copy of the module is
 * `pluginModule(name, { copy })`, as OpenCode's reload imports it. `claude
 * update` itself runs in the simulated CLI as the plugin finds and starts it:
 * first the world's npm install (its three failures the binary holds; then
 * npm's newer layout, whose update leaves the package's placeholder as
 * bin/claude.exe, run by the periodic check so the record and the history
 * show it), then a native install (`local-bin` in the world's bin); what it
 * does is an outcome of the original (`set({ update: { outcome, to,
 * afterExit, pathWarning } })`: Claude Code 2.1.300 live, the binary's
 * lines, and what users reported in anthropics/claude-code: no output at all
 * #66946, #63339; the PATH warning on every run #104403; the placeholder left
 * by an npm update #96265, #72690; the release channel's 403 #89705; EEXIST
 * on a directory of the install #81004; a socket closed behind a proxy
 * #63126; Bun's runtime in the CLI's place #80933; a Homebrew install
 * #41194; the hang after "Checking for updates" of the docs before 2.1.214),
 * the starts are in the install's `calls()`. The output the plugin does not
 * know is what those reports show: nothing at all (its exit code the test's
 * own: the issues name none), and the PATH warning alone with exit 0. A
 * helper holding the output past the exit (`afterExit`) gives the late
 * output and the exit without `close`. The resets of the memoized CLI path
 * are counted by wrapping the plugin's own reset (`resetResolution`), which
 * still runs. A downgrade has no outcome in the simulator and is checked by
 * the parser alone. Every part reads the plugin's journal.
 *
 * The module exists on feat/cli-auto-update and the chain (where.md). The
 * real CLI is exercised by test/cli-update-live.ts (never in the suite: it
 * reinstalls the machine's CLI).
 *
 * Run: bun test/cli-update-regression.ts
 */
import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const world = await createWorld("cli-update");
  const { claude } = world;
  const cases = testCases();
  try {
    const {
      cliAutoUpdateDisabledReason,
      cliUpdateLogPath,
      cliUpdateRecordPath,
      parseClaudeUpdateOutput,
      readCliUpdateRecord,
      startClaudeCliAutoUpdate,
      updateClaudeCli,
    } = await pluginModule("cli-update");
    const { resolveClaudeCli, resetClaudeCliResolutionCache } = await pluginModule("executable-path");
    /** Journal lines of the plugin that match. */
    const logged = (pattern: RegExp) => world.journal().filter((line) => pattern.test(line));

    await cases.run("claude update's output maps to one outcome each (lines as Claude Code 2.1.280 prints them)", () => {
      assert.deepEqual(
        parseClaudeUpdateOutput("Updating to 2.1.296...\nSuccessfully updated from 2.1.280 to version 2.1.296\n"),
        { kind: "updated", from: "2.1.280", to: "2.1.296" },
      );
      assert.deepEqual(parseClaudeUpdateOutput("Claude Code is up to date (2.1.296)\n"), {
        kind: "up-to-date",
        version: "2.1.296",
      });
      // Homebrew and winget installs print it without a version.
      assert.deepEqual(parseClaudeUpdateOutput("Claude is up to date!\n"), {
        kind: "up-to-date",
        version: null,
      });
      assert.deepEqual(
        parseClaudeUpdateOutput(
          "Another Claude process (PID 4242) is currently running. Please try again in a moment.\n",
        ),
        { kind: "busy" },
      );
      assert.deepEqual(
        parseClaudeUpdateOutput("Claude is managed by winget.\nTo update, run:\n  winget upgrade Anthropic.ClaudeCode\n"),
        { kind: "package-manager" },
      );
      assert.equal(parseClaudeUpdateOutput("Failed to check for updates\n"), null);
      // A channel or version cap below the installed version downgrades.
      assert.deepEqual(parseClaudeUpdateOutput("Successfully downgraded from 2.1.302 to version 2.1.296\n"), {
        kind: "updated",
        from: "2.1.302",
        to: "2.1.296",
      });
    });

    await cases.run("the switches that turn the auto-update off, and Claude Code's off spellings that keep it on", () => {
      assert.equal(cliAutoUpdateDisabledReason(undefined, {}), null);
      assert.equal(cliAutoUpdateDisabledReason({ cliAutoUpdate: true }, {}), null);
      assert.match(cliAutoUpdateDisabledReason({ cliAutoUpdate: false }, {}) ?? "", /cliAutoUpdate/);
      assert.match(cliAutoUpdateDisabledReason(undefined, { DISABLE_UPDATES: "1" }) ?? "", /DISABLE_UPDATES/);
      assert.match(cliAutoUpdateDisabledReason(undefined, { DISABLE_AUTOUPDATER: "true" }) ?? "", /DISABLE_AUTOUPDATER/);
      assert.match(cliAutoUpdateDisabledReason(undefined, { DISABLE_AUTOUPDATER: "ON" }) ?? "", /DISABLE_AUTOUPDATER/);
      // Claude Code's documented "off" spellings keep updates on.
      for (const off of ["0", "false", "no", "off", "Off", ""]) {
        assert.equal(cliAutoUpdateDisabledReason(undefined, { DISABLE_AUTOUPDATER: off, DISABLE_UPDATES: off }), null, `off value ${JSON.stringify(off)}`);
      }
      // Presence-only variable: even "0" means set.
      assert.match(cliAutoUpdateDisabledReason(undefined, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" }) ?? "", /NONESSENTIAL/);
      assert.equal(cliAutoUpdateDisabledReason(undefined, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "" }), null);
    });

    // The periodic check: one run per interval across instances and processes,
    // the record shared. The world's data folder holds the record, as the
    // plugin's own. Every run is the plugin's own `claude update` of the
    // simulated CLI.
    // Longer than a run of the simulated CLI (`update`, then `--version`), so
    // an instance that just ran finds its own record fresh.
    const interval = 1500;
    const nodeDirs = process.env.PATH!.split(delimiter).filter((dir) => dir !== join(world.tmp, "bin"));
    // What should happen is awaited: under load a run takes longer than a
    // fixed pause. What should not happen gets a pause.
    const waitFor = async (done: () => boolean, ms = 10_000) => {
      const deadline = Date.now() + ms;
      while (!done() && Date.now() < deadline) await sleep(20);
    };
    const upToDateLines = () => logged(/Claude Code CLI is up to date/).length;

    await cases.run("no CLI anywhere: nothing runs until the plugin's install action puts one in place, then the next tick updates it", async () => {
      // Its PATH holds only the installers: nothing runs, nothing is recorded, and the timer keeps checking.
      const installersDir = join(world.tmp, "installers");
      claude.installers.install(installersDir);
      const bare = {
        ...process.env,
        PATH: [installersDir, ...nodeDirs].join(delimiter),
        OPENCODE_CLAUDE_CLI_UPDATE_INTERVAL_MS: String(interval),
      };
      assert.equal(readCliUpdateRecord(bare), null);
      const stopMissing = startClaudeCliAutoUpdate({ env: bare });
      try {
        await sleep(300);
        assert.equal(readCliUpdateRecord(bare), null, "no CLI: no record");
        const { installClaudeCli } = await pluginModule("cli-install");
        assert.deepEqual(await installClaudeCli({ env: bare }), { ok: true });
        await waitFor(() => readCliUpdateRecord(bare)?.outcome.kind === "up-to-date");
      } finally {
        stopMissing();
      }
      assert.deepEqual(
        readCliUpdateRecord(bare)?.outcome,
        { kind: "up-to-date", version: "2.1.312", installed: "2.1.312" },
        "installed later: the next tick runs the update of the installed CLI",
      );
      rmSync(cliUpdateRecordPath(bare), { force: true });
    });

    // A native install in a folder of its own, the only CLI on this PATH.
    const periodicDir = join(world.tmp, "periodic");
    const native = claude.installCli(periodicDir, { layout: "local-bin" });
    native.set({ version: "2.1.296" });
    const env = {
      ...process.env,
      PATH: [periodicDir, ...nodeDirs].join(delimiter),
      OPENCODE_CLAUDE_CLI_UPDATE_INTERVAL_MS: String(interval),
    };
    /** The environment of another server process on the machine: the check's PATH and interval. */
    const otherEnv = { PATH: env.PATH, OPENCODE_CLAUDE_CLI_UPDATE_INTERVAL_MS: env.OPENCODE_CLAUDE_CLI_UPDATE_INTERVAL_MS };
    /** How many times the plugin started `claude update` of this install. */
    const updates = () => native.calls().filter((call) => call.args[0] === "update").length;

    await cases.run("the periodic check runs at once, a second instance skips within the interval, the timer runs it again", async () => {
      const stopA = startClaudeCliAutoUpdate({ env });
      try {
        await waitFor(() => readCliUpdateRecord(env)?.outcome.kind === "up-to-date");
        assert.equal(updates(), 1, "first check runs at once");
        const record = readCliUpdateRecord(env);
        assert.deepEqual(record?.outcome, { kind: "up-to-date", version: "2.1.296", installed: "2.1.296" });
        assert.equal(JSON.parse(readFileSync(cliUpdateRecordPath(env), "utf8")).outcome.version, "2.1.296");
        assert.ok(logged(/Claude Code CLI is up to date.*2\.1\.296/).length >= 1, "the journal has the outcome");

        // A second instance sees the fresh record and does not run again.
        const stopB = startClaudeCliAutoUpdate({ env });
        await sleep(300);
        assert.equal(updates(), 1, "second instance skips within the interval");
        assert.equal(readCliUpdateRecord(env)?.at, record?.at, "the record stays the first instance's");
        stopB();

        // After the interval the timer runs the check again.
        await waitFor(() => updates() >= 2, interval + 10_000);
        assert.ok(updates() >= 2, `timer re-ran the check (${updates()} runs)`);
        stopA();
        await waitFor(() => readCliUpdateRecord(env)?.outcome.kind !== "running");
        assert.ok(Date.parse(readCliUpdateRecord(env)!.at) > Date.parse(record!.at), "the re-run wrote its own record");
        const afterStop = updates();
        await sleep(interval + 500);
        assert.equal(updates(), afterStop, "stopped instance runs no more checks");
      } finally {
        stopA();
      }
    });

    await cases.run("a successful update is recorded with both versions; the history keeps updates, not the hourly up to date", async () => {
      rmSync(cliUpdateRecordPath(env), { force: true });
      native.set({ version: "2.1.280", update: { outcome: "updated", to: "2.1.296" } });
      const stopC = startClaudeCliAutoUpdate({ env });
      try {
        await waitFor(() => readCliUpdateRecord(env)?.outcome.kind === "updated");
      } finally {
        stopC();
      }
      assert.deepEqual(readCliUpdateRecord(env)?.outcome, {
        kind: "updated",
        from: "2.1.280",
        to: "2.1.296",
        installed: "2.1.296",
      });
      const history = readFileSync(cliUpdateLogPath(env), "utf8").trim().split("\n");
      assert.equal(history.length, 1, `history has one line: ${history.join(" | ")}`);
      assert.match(history[0]!, /^\d{4}-\d{2}-\d{2}T.*Z updated 2\.1\.280 -> 2\.1\.296$/);
      assert.equal(logged(/Claude Code CLI updated/).length, 1, "the journal has the update");
    });

    await cases.run("a failure names the version the CLI stayed on; the record and the history line are written together", async () => {
      rmSync(cliUpdateRecordPath(env), { force: true });
      native.set({ version: "2.1.280", update: { outcome: "noNetwork" } });
      const stopF = startClaudeCliAutoUpdate({ env });
      try {
        await waitFor(() => readCliUpdateRecord(env)?.outcome.kind === "failed");
      } finally {
        stopF();
      }
      const failedLine = readFileSync(cliUpdateLogPath(env), "utf8").trim().split("\n").at(-1)!;
      assert.match(failedLine, /Z failed \(CLI 2\.1\.280\): Error: Failed to install native update: TelemetrySafeError: Failed to fetch version from .* ECONNREFUSED 127\.0\.0\.1:9$/);
      assert.equal(logged(/Claude Code CLI update failed.*ECONNREFUSED/).length, 1, "the journal warns of the failure");
    });

    await cases.run("the claim is made before the run and holds past the interval: no second claude update beside a running one", async () => {
      // A slow CLI (every start waits) makes the run outlast the interval.
      rmSync(cliUpdateRecordPath(env), { force: true });
      native.set({ version: "2.1.296", update: undefined, delayMs: 2000 });
      const beforeSlow = updates();
      const stopS1 = startClaudeCliAutoUpdate({ env });
      let stopS2 = () => {};
      try {
        await waitFor(() => readCliUpdateRecord(env)?.outcome.kind === "running");
        assert.deepEqual(readCliUpdateRecord(env)?.outcome, { kind: "running", pid: process.pid });
        await waitFor(() => updates() === beforeSlow + 1);
        await sleep(interval + 300);
        assert.deepEqual(readCliUpdateRecord(env)?.outcome, { kind: "running", pid: process.pid }, "the claim holds past the interval");
        stopS2 = startClaudeCliAutoUpdate({ env });
        await sleep(300);
        assert.equal(updates(), beforeSlow + 1, "no second `claude update` beside a running one");
        await waitFor(() => readCliUpdateRecord(env)?.outcome.kind !== "running", 20_000);
        assert.deepEqual(readCliUpdateRecord(env)?.outcome, { kind: "up-to-date", version: "2.1.296", installed: "2.1.296" }, "the outcome replaces the claim");
      } finally {
        stopS1();
        stopS2();
        native.set({ delayMs: undefined });
      }
    });

    await cases.run("another server's run under way holds this process off; killed mid-run, its claim stays", async () => {
      // A server process on the machine whose plugin runs the check (a slow CLI: its run outlasts the interval).
      rmSync(cliUpdateRecordPath(env), { force: true });
      native.set({ version: "2.1.296", update: undefined, delayMs: 3000 });
      try {
        const runs = updates();
        const other = await world.secondProcess({ env: otherEnv });
        await other.start({ cliAutoUpdate: true });
        await waitFor(() => readCliUpdateRecord(env)?.outcome.kind === "running", 15_000);
        assert.deepEqual(readCliUpdateRecord(env)?.outcome, { kind: "running", pid: other.pid }, "the other server's claim");
        await waitFor(() => updates() > runs, 15_000);
        assert.equal(updates(), runs + 1, "the other server started `claude update`");
        const before = updates();
        const stop = startClaudeCliAutoUpdate({ env });
        await sleep(500);
        stop();
        assert.equal(updates(), before, "no second `claude update` beside the other server's");
        // Killed mid-run: its claim stays, written by nobody any more.
        await other.kill();
        await sleep(interval + 500);
        assert.deepEqual(readCliUpdateRecord(env)?.outcome, { kind: "running", pid: other.pid }, "the dead process's claim stays");
      } finally {
        native.set({ delayMs: undefined });
      }
    });

    for (const [minutes, holds] of [[1, true], [12, false]] as const) {
      await cases.run(`the claim of a process killed mid-run ${minutes} minute${minutes > 1 ? "s" : ""} ago ${holds ? "still holds" : "has expired"} (the longest run, not the interval)`, async () => {
        // A server process whose clock says it claimed then, killed mid-run: the claim expires after the longest
        // run (update timeout plus version check), not after the short interval.
        rmSync(cliUpdateRecordPath(env), { force: true });
        native.set({ version: "2.1.296", update: undefined, delayMs: 3000 });
        let killed = false;
        try {
          const earlier = await world.secondProcess({ clockShiftMs: -minutes * 60_000, env: otherEnv });
          await earlier.start({ cliAutoUpdate: true });
          await waitFor(() => readCliUpdateRecord(env)?.outcome.pid === earlier.pid, 15_000);
          assert.equal(readCliUpdateRecord(env)?.outcome.pid, earlier.pid, "the earlier process claimed the run");
          await earlier.kill();
          killed = true;
        } finally {
          native.set({ delayMs: undefined });
        }
        assert.ok(killed);
        const age = Date.now() - Date.parse(readCliUpdateRecord(env)!.at);
        assert.ok(Math.abs(age - minutes * 60_000) < 30_000, `the claim is ${Math.round(age / 1000)} s old`);
        const runs = updates();
        const stopNow = startClaudeCliAutoUpdate({ env });
        try {
          if (holds) await sleep(500);
          else await waitFor(() => readCliUpdateRecord(env)?.outcome.kind === "up-to-date");
        } finally {
          stopNow();
        }
        if (holds) assert.equal(updates(), runs, "a minute-old claim still holds");
        else assert.equal(updates(), runs + 1, "an abandoned claim expires");
      });
    }

    await cases.run("off by option: nothing runs, nothing is recorded, the journal says why", async () => {
      rmSync(cliUpdateRecordPath(env), { force: true });
      const beforeOff = updates();
      const stopOff = startClaudeCliAutoUpdate({ env, options: { cliAutoUpdate: false } });
      await sleep(300);
      stopOff();
      assert.equal(updates(), beforeOff);
      assert.equal(readCliUpdateRecord(env), null);
      assert.ok(logged(/Claude Code CLI auto-update is off:.*cliAutoUpdate is false/).length >= 1, "the journal says why it is off");
    });

    await cases.run("the record cannot be written (the data folder is a file): the attempt still counts within this process", async () => {
      const blocker = join(world.tmp, "not-a-dir");
      writeFileSync(blocker, "x");
      const unwritable = { ...env, XDG_DATA_HOME: join(blocker, "share") };
      const beforeUnrecorded = updates();
      const linesBefore = upToDateLines();
      const warningsBefore = logged(/could not record the CLI update outcome/).length;
      const stopU1 = startClaudeCliAutoUpdate({ env: unwritable });
      let stopU2 = () => {};
      try {
        await waitFor(() => upToDateLines() > linesBefore);
        assert.equal(updates(), beforeUnrecorded + 1, "unwritable record: first instance runs");
        assert.equal(readCliUpdateRecord(unwritable), null, "unwritable record: nothing on disk");
        stopU2 = startClaudeCliAutoUpdate({ env: unwritable });
        await sleep(300);
        assert.equal(updates(), beforeUnrecorded + 1, "unwritable record: second instance skips within the interval");
      } finally {
        stopU1();
        stopU2();
      }
      // One warning per attempt: the outcome is not written after a failed claim.
      const warnings = logged(/could not record the CLI update outcome/).slice(warningsBefore);
      assert.equal(warnings.length, 1, `one record warning: ${warnings.join(" | ")}`);
    });

    // An old record that is still readable but can no longer be replaced
    // (read-only file on Windows, read-only dir elsewhere): the in-memory
    // count holds the next instance off as well. Root ignores the read-only
    // dir, so the case cannot be set up there (CI containers).
    if (process.getuid?.() !== 0) {
      await cases.run("an old record that can no longer be replaced: the in-memory count holds the next instance and a reloaded copy off", async () => {
        // The unrecorded attempt before holds this process off for one interval.
        await sleep(interval);
        const stuckData = join(world.tmp, "stuck");
        const stuck = { ...env, XDG_DATA_HOME: stuckData };
        const stuckFile = cliUpdateRecordPath(stuck);
        // The record a server process wrote long ago (its clock months behind), then the file made read-only.
        const longAgo = await world.secondProcess({ clockShiftMs: -200 * 24 * 60 * 60_000, env: { ...otherEnv, XDG_DATA_HOME: stuckData } });
        await longAgo.start({ cliAutoUpdate: true });
        await waitFor(() => readCliUpdateRecord(stuck)?.outcome.kind === "up-to-date", 15_000);
        await longAgo.exit();
        const old = readCliUpdateRecord(stuck);
        assert.equal(old?.outcome.kind, "up-to-date", "the old server process recorded its run");
        assert.ok(Date.now() - Date.parse(old!.at) > 100 * 24 * 60 * 60_000, `the record is months old: ${old?.at}`);
        const lock = process.platform === "win32" ? stuckFile : dirname(stuckFile);
        chmodSync(lock, process.platform === "win32" ? 0o444 : 0o555);
        try {
          const beforeStuck = updates();
          const stuckLines = upToDateLines();
          const stopK1 = startClaudeCliAutoUpdate({ env: stuck });
          await waitFor(() => upToDateLines() > stuckLines);
          assert.equal(updates(), beforeStuck + 1, "unreplaceable record: the first instance runs");
          const stopK2 = startClaudeCliAutoUpdate({ env: stuck });
          await sleep(300);
          stopK1();
          stopK2();
          assert.equal(updates(), beforeStuck + 1, "unreplaceable record: the second instance skips within the interval");
          assert.equal(readCliUpdateRecord(stuck)?.at, old?.at, "the old record stayed");
          // OpenCode imports a changed local plugin afresh on reload: a second
          // copy of the module still knows about the attempt.
          const reloaded = await pluginModule("cli-update", { copy: "reloaded" });
          assert.notEqual(reloaded.startClaudeCliAutoUpdate, startClaudeCliAutoUpdate, "a separate module copy");
          const stopK3 = reloaded.startClaudeCliAutoUpdate({ env: stuck });
          await sleep(300);
          stopK3();
          assert.equal(updates(), beforeStuck + 1, "a reloaded module copy skips within the interval too");
        } finally {
          chmodSync(lock, process.platform === "win32" ? 0o644 : 0o755);
        }
      });
    }
    rmSync(cliUpdateRecordPath(env), { force: true });

    // `claude update` of an npm install (the world's own CLI, npm's older
    // layout in its bin, found first on PATH): the failures the binary holds.
    // npm prints the cause first and advice after it.
    const npm = claude.cli;
    /** One `claude update` of the npm install: the outcome and the install's starts. */
    const npmRun = async (outcome: "npmOffline" | "npmPermissions" | "npmBusy") => {
      npm.set({ version: "2.1.280", update: { outcome } });
      const before = npm.calls().length;
      const result = await updateClaudeCli();
      const starts = npm.calls().slice(before);
      return { outcome: result, starts, args: starts.map((call) => call.args.join(" ")) };
    };

    await cases.run("claude update of an npm install: offline, no permissions, another update in progress", async () => {
      const launcher = (await resolveClaudeCli(process.env)) as string | null;
      assert.ok(launcher, "the plugin finds the npm install");
      const offline = await npmRun("npmOffline");
      assert.deepEqual(offline.outcome, {
        kind: "failed",
        message: "Failed to check for updates: Unable to fetch latest version from npm registry",
        installed: "2.1.280",
      });
      assert.deepEqual(offline.args, ["update", "--version"], "the update, then `claude --version` on the same CLI");
      if (process.platform === "win32") {
        // Windows npm installs may resolve to `cli.js`, which only node can run.
        assert.match(launcher, /cli\.js$/, "npm's older layout resolves to cli.js");
        assert.equal(offline.starts[0]!.runner, "node", "cli.js runs through node");
      }
      const permissions = await npmRun("npmPermissions");
      assert.deepEqual(permissions.outcome, { kind: "failed", message: "Error: Insufficient permissions to install update.", installed: "2.1.280" });
      // npm's "update in progress" is the same busy as the native lock.
      const busy = await npmRun("npmBusy");
      assert.deepEqual(busy.outcome, { kind: "busy", installed: "2.1.280" });
    });

    await cases.run("npm's newer layout: an update that leaves the package's placeholder is a failure no version answers", async () => {
      // The package's bin/claude.exe: an update that says it succeeded and leaves the package's placeholder in the
      // binary's place (anthropics/claude-code #96265, #72690), so no `claude --version` answers. Run by the
      // periodic check: the record and the history show what the plugin made of it. The plugin looks for the CLI
      // again, as after its own install action.
      const npmBinary = claude.installCli(join(world.tmp, "bin"), { layout: "npm" });
      resetClaudeCliResolutionCache();
      if (process.platform === "win32") {
        assert.match((await resolveClaudeCli(process.env)) ?? "", /claude-code[\\/]bin[\\/]claude\.exe$/, "npm's shim leads to the package's binary");
      }
      npmBinary.set({ version: "2.1.280", update: { outcome: "npmPlaceholderLeft", to: "2.1.296" } });
      // A short interval: the unrecorded attempts above hold this process off for one.
      const shortEnv = { ...process.env, OPENCODE_CLAUDE_CLI_UPDATE_INTERVAL_MS: "1000" };
      const stop = startClaudeCliAutoUpdate({ env: shortEnv });
      try {
        const deadline = Date.now() + 15_000;
        while (readCliUpdateRecord(shortEnv)?.outcome.kind !== "failed" && Date.now() < deadline) await sleep(50);
      } finally {
        stop();
      }
      const placeholder = readCliUpdateRecord(shortEnv)?.outcome;
      assert.equal(placeholder?.kind, "failed", `an update no version answers is a failure: ${JSON.stringify(placeholder)}`);
      assert.equal(placeholder.installed, null, "no version after the update");
      assert.equal(
        placeholder.message,
        "claude update reported 2.1.280 -> 2.1.296, but `claude --version` reports no version; the program in its place does not run or is not Claude Code (an npm update can leave the package's placeholder there)",
        "the cause named is the one that happened",
      );
      const historyLine = readFileSync(cliUpdateLogPath(shortEnv), "utf8").trim().split("\n").at(-1)!;
      assert.match(historyLine, /Z failed: claude update reported 2\.1\.280 -> 2\.1\.296, but `claude --version` reports no version/);
      assert.equal(logged(/Claude Code CLI update failed.*reports no version/).length, 1, "the journal warns of it");
      rmSync(cliUpdateRecordPath(shortEnv), { force: true });
    });

    // The real command: `<claude> update` in a native install, the outcome
    // from its output, not the exit code, then `claude --version`. The native
    // install in the world's bin, where the plugin finds it before npm's shim
    // (Windows tries .exe first; elsewhere it replaces the shim). The plugin
    // looks for the CLI again, as after its own install action.
    const local = claude.installCli(join(world.tmp, "bin"), { layout: "local-bin" });
    resetClaudeCliResolutionCache();
    const launcher = (await resolveClaudeCli(process.env)) as string | null;
    type Update = NonNullable<Parameters<typeof local.set>[0]["update"]>;
    /** One `claude update` from `from`: the outcome, the install's starts (their arguments), the resets of the memoized path. */
    const run = async (update: Update, from = "2.1.280", options: { timeoutMs?: number } = {}) => {
      local.set({ version: from, update });
      const before = local.calls().length;
      let resets = 0;
      const started = Date.now();
      const outcome = await updateClaudeCli({
        ...options,
        // The plugin's own reset still runs; the test counts it.
        resetResolution: () => {
          resets += 1;
          resetClaudeCliResolutionCache();
        },
      });
      const starts = local.calls().slice(before);
      return { outcome, starts, args: starts.map((call) => call.args.join(" ")), resets, ms: Date.now() - started };
    };

    await cases.run("a native install: up to date, updated (the memoized path dropped and found again), busy and winget by their output", async () => {
      assert.ok(launcher && /[\\/]bin[\\/]claude(\.exe)?$/.test(launcher), `the plugin finds the native install: ${launcher}`);
      // As the CLI is: up to date on its own version.
      const current = await run({});
      assert.deepEqual(current.outcome, { kind: "up-to-date", version: "2.1.280", installed: "2.1.280" });
      assert.deepEqual(current.args, ["update", "--version"], "the update, then `claude --version` on the same CLI");
      assert.notEqual(current.starts[0]!.runner, "node", "a native install runs by itself");
      assert.equal(current.resets, 0);

      // An update: the next `claude --version` answers the new version. The binary (and on Windows possibly its
      // layout) changed: the memoized path is dropped and the CLI looked for again.
      const updated = await run({ outcome: "updated", to: "2.1.296" });
      assert.deepEqual(updated.outcome, { kind: "updated", from: "2.1.280", to: "2.1.296", installed: "2.1.296" });
      assert.equal(updated.args[0], "update");
      assert.equal(updated.args.at(-1), "--version");
      assert.equal(updated.resets, 1);
      assert.equal(await resolveClaudeCli(process.env), launcher, "found again where it is");

      // Exit 0 without an update: read from the output.
      const busy = await run({ outcome: "busy" });
      assert.deepEqual(busy.outcome, { kind: "busy", installed: "2.1.280" });
      assert.equal(busy.args.at(-1), "--version", "every run ends with `claude --version`");
      assert.equal(busy.resets, 0);
      const winget = await run({ outcome: "winget" });
      assert.deepEqual(winget.outcome, { kind: "package-manager", installed: "2.1.280" });
    });

    let offlineOutcome: unknown;
    await cases.run("a failure is the last line after the progress lines, or the cause above the claude doctor hint", async () => {
      const checkFailed = await run({ outcome: "checkFailed" });
      assert.deepEqual(checkFailed.outcome, { kind: "failed", message: "Failed to check for updates", installed: "2.1.280" });
      assert.equal(checkFailed.args.at(-1), "--version", "a failure is checked too");
      assert.equal(checkFailed.resets, 0);
      // Claude Code 2.1.300 live: no network, the connection cut mid-download.
      const offline = await run({ outcome: "noNetwork" });
      offlineOutcome = offline.outcome;
      assert.deepEqual(offline.outcome, {
        kind: "failed",
        message:
          "Error: Failed to install native update: TelemetrySafeError: Failed to fetch version from https://downloads.claude.ai/claude-code-releases/latest after 3 attempt(s): connect ECONNREFUSED 127.0.0.1:9",
        installed: "2.1.280",
      });
      const cut = await run({ outcome: "cutMidway", to: "2.1.296" });
      assert.deepEqual(cut.outcome, {
        kind: "failed",
        message:
          "Error: Failed to install native update: TelemetrySafeError: The connection dropped while downloading the update (attempt 3/3: aborted). Check your network — proxies sometimes cut off large downloads.",
        installed: "2.1.280",
      });
    });

    await cases.run("output the plugin has no verdict for: nothing at all, the PATH warning alone; the warning beside a verdict does not hide it", async () => {
      // As users reported it (anthropics/claude-code): nothing at all (#66946, #63339; the exit code is the test's
      // own, the issues name none) — the exit code is all there is to report.
      const silent = await run({ outcome: "silent", code: 3 });
      assert.deepEqual(silent.outcome, { kind: "failed", message: "claude update exited with code 3.", installed: "2.1.280" });
      // A warning on every run that ~/.local/bin is not on PATH (#104403, 2.1.308). Alone, with exit 0, it is not a
      // success...
      const warningOnly = await run({ outcome: "silent", code: 0, pathWarning: true });
      assert.equal(warningOnly.outcome.kind, "failed", `the warning alone is no outcome: ${JSON.stringify(warningOnly.outcome)}`);
      assert.equal(warningOnly.outcome.installed, "2.1.280");
      // ...and beside a verdict it does not hide it.
      const warnedUpdate = await run({ outcome: "updated", to: "2.1.296", pathWarning: true });
      assert.deepEqual(warnedUpdate.outcome, { kind: "updated", from: "2.1.280", to: "2.1.296", installed: "2.1.296" });
      const offline = offlineOutcome ?? (await run({ outcome: "noNetwork" })).outcome;
      const warnedFailure = await run({ outcome: "noNetwork", pathWarning: true });
      assert.deepEqual(warnedFailure.outcome, offline, "the cause, not the warning");
    });

    await cases.run("more failures users reported: the channel's 403, EEXIST, a socket closed, Homebrew, Bun's runtime in the CLI's place", async () => {
      // The release channel answered 403 (#89705, 2.1.241).
      const refused = await run({ outcome: "fetchRefused" });
      assert.deepEqual(refused.outcome, {
        kind: "failed",
        message:
          "Error: Failed to install native update: TelemetrySafeError: Failed to fetch version from https://downloads.claude.ai/claude-code-releases/latest after 3 attempt(s): Request failed with status code 403",
        installed: "2.1.280",
      });
      // A directory of the install that cannot be made (#81004, 2.1.215 on Windows): the cause is the EEXIST line,
      // not the preamble or the hint.
      const eexist = await run({ outcome: "eexist", to: "2.1.296" });
      assert.equal(eexist.outcome.kind, "failed");
      assert.match(eexist.outcome.message, /^Error: Failed to install native update: Error: EEXIST: file already exists, mkdir '[^']*versions'$/);
      assert.equal(eexist.outcome.installed, "2.1.280");
      // The socket closed behind a proxy (#63126, 2.1.153): that one line, nothing before it.
      const socket = await run({ outcome: "socketClosed" });
      assert.deepEqual(socket.outcome, {
        kind: "failed",
        message: "Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
        installed: "2.1.280",
      });
      // A Homebrew install is left to Homebrew (#41194, 2.1.81): no error.
      const homebrew = await run({ outcome: "homebrew", to: "2.1.296" });
      assert.deepEqual(homebrew.outcome, { kind: "package-manager", installed: "2.1.280" });
      // "Successfully updated", and Bun's runtime took the CLI's place (#80933, 2.1.219): its `--version` is not the
      // version reported, so the update does not count.
      try {
        const impostor = await run({ outcome: "bunImpostor", to: "2.1.296" });
        assert.equal(impostor.outcome.kind, "failed", `an update another program answers for is no update: ${JSON.stringify(impostor.outcome)}`);
        assert.equal(impostor.outcome.installed, "1.4.0", "the version the program in the CLI's place gave");
        assert.equal(impostor.outcome.message, "claude update reported 2.1.280 -> 2.1.296, but `claude --version` reports 1.4.0; what runs there is another program or another install");
      } finally {
        local.set({ versionText: undefined });
      }
    });

    await cases.run("Successfully updated while the old launcher stays: the version check makes it a failure", async () => {
      // Held open on Windows; on any platform not the installer's own, or not writable.
      const notReplaced = "; the launcher was not replaced (held open by another program, not the installer's own, or not writable)";
      const kept = await run({ outcome: "launcherHeld", to: "2.1.296" });
      assert.deepEqual(kept.outcome, {
        kind: "failed",
        message: `claude update reported 2.1.280 -> 2.1.296, but \`claude --version\` reports 2.1.280${notReplaced}`,
        installed: "2.1.280",
      });
    });

    await cases.run("a run that hangs after Checking for updates is stopped at its time limit; no CLI is a failure", async () => {
      // The docs, before 2.1.214. The CLI stays where it was.
      const hung = await run({ outcome: "hang" }, "2.1.280", { timeoutMs: 1000 });
      assert.equal(hung.outcome.kind, "failed");
      assert.match(hung.outcome.message, /claude update timed out/);
      assert.equal(hung.outcome.installed, "2.1.280");
      const missing = await updateClaudeCli({ binaryPath: null });
      assert.equal(missing.kind, "failed");
    });

    await cases.run("output after exit still counts (close settles the run); output that never closes settles on exit after a grace period", async () => {
      // A helper holds the output 300 ms past the exit (within the plugin's fallback after `exit`) and writes the
      // cause's second line then.
      const late = await run({ outcome: "checkFailed", afterExit: { ms: 300, text: "Unable to fetch latest version from npm registry\n" } });
      assert.deepEqual(late.outcome, {
        kind: "failed",
        message: "Failed to check for updates: Unable to fetch latest version from npm registry",
        installed: "2.1.280",
      });
      const exitOnly = await run({ afterExit: { ms: 5000 } });
      assert.deepEqual(exitOnly.outcome, { kind: "up-to-date", version: "2.1.280", installed: "2.1.280" });
      assert.ok(exitOnly.ms >= 400 && exitOnly.ms < 4000, `exit-only settles after the grace period (${exitOnly.ms} ms)`);
    });

    await cases.run("the periodic check with the real run: the record holds what claude --version reported", async () => {
      // The interval is short: the unrecorded attempts above hold this process off for one interval.
      local.set({ version: "2.1.296", update: undefined });
      const shortEnv = { ...process.env, OPENCODE_CLAUDE_CLI_UPDATE_INTERVAL_MS: "1000" };
      const before = local.calls().length;
      const stop = startClaudeCliAutoUpdate({ env: shortEnv });
      try {
        const deadline = Date.now() + 15_000;
        while (readCliUpdateRecord(shortEnv)?.outcome.kind !== "up-to-date" && Date.now() < deadline) await sleep(50);
      } finally {
        stop();
      }
      assert.deepEqual(readCliUpdateRecord(shortEnv)?.outcome, { kind: "up-to-date", version: "2.1.296", installed: "2.1.296" });
      assert.ok(local.calls().slice(before).some((call) => call.args[0] === "update"), "the timer ran `claude update`");
      assert.ok(logged(/Claude Code CLI is up to date.*2\.1\.296/).length >= 1, "the journal has the real run's outcome");
    });

    await cases.run("no error in the plugin's journal", () => {
      assert.deepEqual(logged(/level=error/), [], "no error in the plugin's journal");
    });
  } finally {
    await world.dispose();
  }
  cases.done();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
