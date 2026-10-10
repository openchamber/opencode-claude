/**
 * Regression for the CLI auto-update (src/cli-update.ts):
 * - `claude update` output maps to one outcome each, and exit 0 alone is not
 *   taken for success (the CLI exits 0 when another process holds the lock);
 * - the periodic check runs once per interval across plugin instances, through
 *   the shared record file, waits for a missing CLI, and is off under the
 *   documented switches.
 *
 * Fake CLI children only (no shell scripts), so the file runs on Windows too.
 *
 * Run: bun test/cli-update-regression.ts
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, sleep } from "./helpers.ts";

async function main() {
  const {
    cliAutoUpdateDisabledReason,
    cliUpdateRecordPath,
    parseClaudeUpdateOutput,
    readCliUpdateRecord,
    startClaudeCliAutoUpdate,
    updateClaudeCli,
  } = await import("../src/cli-update.ts");

  // Output → outcome. Lines as Claude Code 2.1.280 prints them.
  {
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
  }

  // The real command: `<claude> update`, outcome from the output, not the exit code.
  const fakeCli = () => {
    const streams = { stdout: new EventEmitter(), stderr: new EventEmitter() };
    const child = Object.assign(new EventEmitter(), {
      pid: 7,
      stdout: streams.stdout,
      stderr: streams.stderr,
      kill() {
        return true;
      },
    });
    return { child, streams };
  };
  const run = async (lines: string, code: number, binaryPath = "/opt/claude") => {
    const { child, streams } = fakeCli();
    const calls: string[][] = [];
    const pending = updateClaudeCli({
      env: { PATH: "/usr/bin" },
      binaryPath,
      spawnInstall(command, args) {
        calls.push([command, ...args]);
        return child as any;
      },
    });
    await sleep(0);
    streams.stdout.emit("data", lines);
    child.emit("exit", code);
    child.emit("close", code);
    return { outcome: await pending, calls };
  };
  {
    const updated = await run("Successfully updated from 2.1.280 to version 2.1.296\n", 0);
    assert.deepEqual(updated.outcome, { kind: "updated", from: "2.1.280", to: "2.1.296" });
    assert.deepEqual(updated.calls, [["/opt/claude", "update"]]);

    const busy = await run("Another Claude process is currently running. Please try again in a moment.\n", 0);
    assert.deepEqual(busy.outcome, { kind: "busy" });

    const failed = await run("Failed to check for updates\n", 1);
    assert.deepEqual(failed.outcome, { kind: "failed", message: "Failed to check for updates" });

    // Exit 0 with unknown text is not a success either.
    const unknown = await run("something new\n", 0);
    assert.deepEqual(unknown.outcome, { kind: "failed", message: "something new" });

    const missing = await updateClaudeCli({ env: { PATH: "/usr/bin" }, binaryPath: null });
    assert.equal(missing.kind, "failed");

    // Windows npm installs may resolve to `cli.js`, which only node can run.
    const cliJs = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    const viaNode = await run("Claude Code is up to date (2.1.296)\n", 0, cliJs);
    assert.deepEqual(viaNode.outcome, { kind: "up-to-date", version: "2.1.296" });
    assert.deepEqual(viaNode.calls, [["node", cliJs, "update"]]);
  }

  // Switches.
  {
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
  }

  // The periodic check: one run per interval across instances, record shared.
  const data = mkdtempSync(join(tmpdir(), "opencode-claude-update-"));
  try {
    const env = { XDG_DATA_HOME: data, OPENCODE_CLAUDE_CLI_UPDATE_INTERVAL_MS: "200" };
    assert.equal(readCliUpdateRecord(env), null);
    const cliPresent = async () => true;

    let runs = 0;
    const update = async () => {
      runs += 1;
      return { kind: "up-to-date" as const, version: "2.1.296" };
    };

    // No CLI yet (install action may add one later): nothing runs, nothing is
    // recorded, and the timer keeps checking.
    let present = false;
    const stopMissing = startClaudeCliAutoUpdate({ env, update, cliPresent: async () => present });
    await sleep(20);
    assert.equal(runs, 0, "no CLI: no update attempt");
    assert.equal(readCliUpdateRecord(env), null, "no CLI: no record");
    present = true;
    await sleep(300);
    stopMissing();
    assert.ok(runs >= 1, "installed later: the next tick runs the update");
    runs = 0;
    rmSync(cliUpdateRecordPath(env), { force: true });

    const stopA = startClaudeCliAutoUpdate({ env, update, cliPresent });
    await sleep(20);
    assert.equal(runs, 1, "first check runs at once");
    const record = readCliUpdateRecord(env);
    assert.equal(record?.outcome.kind, "up-to-date");
    assert.equal(JSON.parse(readFileSync(cliUpdateRecordPath(env), "utf8")).outcome.version, "2.1.296");

    // A second instance sees the fresh record and does not run again.
    const stopB = startClaudeCliAutoUpdate({ env, update, cliPresent });
    await sleep(20);
    assert.equal(runs, 1, "second instance skips within the interval");
    stopB();

    // After the interval the timer runs the check again.
    await sleep(400);
    assert.ok(runs >= 2 && runs <= 4, `timer re-ran the check (${runs} runs)`);
    stopA();
    const afterStop = runs;
    await sleep(300);
    assert.equal(runs, afterStop, "stopped instance runs no more checks");

    // A successful update is recorded with both versions.
    rmSync(cliUpdateRecordPath(env), { force: true });
    const stopC = startClaudeCliAutoUpdate({
      env,
      cliPresent,
      update: async () => ({ kind: "updated" as const, from: "2.1.280", to: "2.1.296" }),
    });
    await sleep(20);
    stopC();
    assert.deepEqual(readCliUpdateRecord(env)?.outcome, {
      kind: "updated",
      from: "2.1.280",
      to: "2.1.296",
    });

    // Off by option: nothing runs, nothing is recorded.
    rmSync(cliUpdateRecordPath(env), { force: true });
    let offRuns = 0;
    const stopOff = startClaudeCliAutoUpdate({
      env,
      cliPresent,
      options: { cliAutoUpdate: false },
      update: async () => {
        offRuns += 1;
        return { kind: "busy" as const };
      },
    });
    await sleep(20);
    stopOff();
    assert.equal(offRuns, 0);
    assert.equal(readCliUpdateRecord(env), null);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }

  console.log("ok — cli update regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
