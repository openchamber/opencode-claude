/**
 * Keep the Claude Code CLI current.
 *
 * Claude Code updates itself from its interactive screen: the background
 * updater is a hook of the terminal UI, and a CLI driven through the Agent
 * SDK (`-p --output-format stream-json`) never mounts it. A CLI used only from
 * OpenCode therefore stays on the version it was installed with, and models
 * released since never show up. The plugin runs `claude update` for it: in
 * the background, once per interval across every server process on the
 * machine, with the outcome recorded next to models.json. The record is
 * claimed before `claude update` starts: Claude Code does not serialize
 * concurrent updates (each run downloads into its own staging dir, and every
 * one reports the update), so without the claim each OpenCode server
 * downloads the release once more.
 *
 * `claude update` needs no terminal. It prints plain lines and exits 0 even
 * when it did nothing (another process held the update lock, or a package
 * manager owns the install), so the outcome is read from its output. It also
 * reports success when the new launcher could not be put in place: on
 * Windows when another program holds claude.exe open, on every platform
 * when ~/.local/bin/claude is not the installer's own launcher or its folder
 * is not writable. So every run ends with `claude --version`, and an outcome
 * naming a version must match it.
 *
 * Chat turns are not paused during an update. One that starts while the
 * launcher is being replaced fails to launch the CLI; proxy.ts answers it
 * with a 500 and drops the memoized CLI path, and OpenCode's own retry of
 * 5xx answers finds the new CLI (see failure.ts).
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { runInstaller, type SpawnInstall } from "./cli-install.js";
import {
  cliInvocation,
  resetClaudeCliResolutionCache,
  resolveClaudeCli,
  runCliProbe,
} from "./executable-path.js";
import { log } from "./log.js";

export type ClaudeCliUpdateOutcome = (
  | { kind: "updated"; from: string; to: string }
  | { kind: "up-to-date"; version: string | null }
  /** Another Claude process held the update lock; the CLI asks to retry later. */
  | { kind: "busy" }
  /** winget, Homebrew, apt and friends: the CLI leaves updates to them. */
  | { kind: "package-manager" }
  | { kind: "failed"; message: string }
) & {
  /** What `claude --version` reported after the run; null when it gave nothing. */
  installed?: string | null;
};

export type ClaudeCliUpdateRecord = {
  /** ISO time of the last attempt. */
  at: string;
  /** `running` while `claude update` is under way in process `pid`. */
  outcome: ClaudeCliUpdateOutcome | { kind: "running"; pid: number };
};

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** Claude Code ships several times a week, some days several times. */
const DEFAULT_INTERVAL_MS = 60 * 60_000;
/** Download of the ~240 MB binary, checksum and launcher swap. */
const UPDATE_TIMEOUT_MS = 10 * 60_000;
/**
 * `claude --version` after the run. Longer than the 4 s detection probes: the
 * first start of a freshly installed binary waits for the antivirus scan.
 */
const VERSION_CHECK_TIMEOUT_MS = 60_000;

export function cliUpdateIntervalMs(env: Env = process.env): number {
  const raw = Number(env.OPENCODE_CLAUDE_CLI_UPDATE_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INTERVAL_MS;
}

/**
 * Claude Code's on/off variables: `1`, `true`, `yes`, `on` turn a behaviour
 * on and `0`, `false`, `no`, `off` turn it off, in any casing. Empty means
 * unset; any other text counts as on.
 */
function envBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "") return false;
  return !["0", "false", "no", "off"].includes(normalized);
}

/**
 * Why automatic updates are off, or null when they run. `cliAutoUpdate:
 * false` in the plugin options turns them off; so do Claude Code's own
 * switches when the OpenCode server carries them in its environment:
 * DISABLE_UPDATES and DISABLE_AUTOUPDATER (on/off values), and
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, which the CLI reads by presence
 * (any non-empty value, even `0`) and which stops its own background
 * updates; `claude update` would not check it, so the plugin must. (The CLI
 * also reads them from the `env` block of its settings.json, which this
 * check does not read; `claude update` itself honours DISABLE_UPDATES there.)
 */
export function cliAutoUpdateDisabledReason(
  options: { cliAutoUpdate?: unknown } | undefined,
  env: Env = process.env,
): string | null {
  if (options?.cliAutoUpdate === false) {
    return "cliAutoUpdate is false in the plugin options";
  }
  if (envBoolean(env.DISABLE_UPDATES)) return "DISABLE_UPDATES is set";
  if (envBoolean(env.DISABLE_AUTOUPDATER)) return "DISABLE_AUTOUPDATER is set";
  if ((env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "") !== "") {
    return "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set";
  }
  return null;
}

export function cliUpdateRecordPath(env: Env = process.env): string {
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "cli-update.json");
}

/** History next to the record: one line per update and per failure. */
export function cliUpdateLogPath(env: Env = process.env): string {
  return join(dirname(cliUpdateRecordPath(env)), "cli-update.log");
}

/**
 * The record holds the last attempt only, and the plugin's info log is off
 * unless debugging. Updates and failures are the events a user comes back
 * for, so they are appended here as well; "up to date" every hour is not.
 */
function appendCliUpdateLog(record: ClaudeCliUpdateRecord, env: Env): void {
  const { outcome } = record;
  let line: string;
  if (outcome.kind === "updated") {
    line = `updated ${outcome.from} -> ${outcome.to}`;
  } else if (outcome.kind === "failed") {
    // The version the CLI stayed on, when `claude --version` answered.
    const installed = outcome.installed ? ` (CLI ${outcome.installed})` : "";
    line = `failed${installed}: ${outcome.message}`;
  } else {
    return;
  }
  try {
    const file = cliUpdateLogPath(env);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${record.at} ${line}\n`);
  } catch {
    // the record and the plugin log still have it
  }
}

export function readCliUpdateRecord(
  env: Env = process.env,
): ClaudeCliUpdateRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(cliUpdateRecordPath(env), "utf8"));
    if (parsed && typeof parsed.at === "string" && parsed.outcome) {
      return parsed as ClaudeCliUpdateRecord;
    }
  } catch {
    // no record yet, or unreadable: never checked
  }
  return null;
}

/**
 * Written whole or not at all: another server may read it at any moment,
 * and a torn file would read as "never checked" and start one more update.
 */
function writeCliUpdateRecord(record: ClaudeCliUpdateRecord, env: Env): boolean {
  try {
    const file = cliUpdateRecordPath(env);
    mkdirSync(dirname(file), { recursive: true });
    const partial = `${file}.${process.pid}.tmp`;
    writeFileSync(partial, JSON.stringify(record, null, 2));
    renameSync(partial, file);
    return true;
  } catch (err) {
    log.warn(
      "[opencode-claude] could not record the CLI update outcome",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Advice `claude update` prints after a failure, not the failure itself. */
const ADVICE_LINE = /^(?:Try\b|Possible causes|Please\b|Or\b|[•·*-])/;

/**
 * `claude update` prints its progress first ("Current version: …",
 * "Checking for updates…"), then the failure, then advice. The failure
 * starts with "Error:" or "Failed to" and may go on for a line or two:
 *
 *   Error: Failed to install native update
 *   TelemetrySafeError: The connection dropped while downloading the update …
 *   Try running "claude doctor" for diagnostics
 *
 *   Failed to check for updates
 *   Unable to fetch latest version from npm registry
 *   Possible causes: …, Try: … (npm installs)
 *
 * So the lines from the first "Error:" / "Failed to" up to the first piece
 * of advice are kept, joined into one line. Without such a line, the last
 * line that is not advice is the verdict.
 */
function failureMessage(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  const first = lines.findIndex((line) => /^(?:Error:|Failed to)/.test(line));
  if (first < 0) {
    const verdicts = lines.filter((line) => !ADVICE_LINE.test(line));
    return verdicts[verdicts.length - 1] ?? lines[lines.length - 1]!;
  }
  const kept: string[] = [];
  for (const line of lines.slice(first)) {
    if (kept.length > 0 && ADVICE_LINE.test(line)) break;
    kept.push(line);
  }
  return kept.join(": ");
}

/** The lines `claude update` prints (Claude Code 2.1.280–2.1.302), by outcome. */
export function parseClaudeUpdateOutput(
  output: string,
): ClaudeCliUpdateOutcome | null {
  // A channel or version cap below the installed version downgrades.
  const updated = /Successfully (?:updated|downgraded) from (\S+) to version (\S+)/.exec(output);
  if (updated) return { kind: "updated", from: updated[1]!, to: updated[2]! };
  const current = /is up to date(?: \(([^)]+)\))?/.exec(output);
  if (current) return { kind: "up-to-date", version: current[1] ?? null };
  // Native installs, and npm installs ("Another instance is currently
  // performing an update", exit 1).
  if (/Another Claude process|Another instance is currently performing an update/.test(output)) {
    return { kind: "busy" };
  }
  if (/is managed by /.test(output)) return { kind: "package-manager" };
  return null;
}

/**
 * Kept on globalThis, like the bridge runtime (bridge-pool.ts): OpenCode
 * imports a changed local plugin afresh on reload, and module-level flags
 * would start over in each copy of this module within one server process.
 */
type UpdateRuntime = {
  updating: boolean;
  /**
   * Epoch ms of the last attempt whose record could not be written
   * (read-only data dir, full disk). Without it every plugin instance loaded
   * after such an attempt would find no fresh record and run the update again.
   */
  unrecordedAttemptAt: number;
};

const RUNTIME_KEY = Symbol.for("@openchamber/opencode-claude/cli-update-runtime/v1");

const runtime: UpdateRuntime = ((globalThis as Record<symbol, unknown>)[
  RUNTIME_KEY
] ??= { updating: false, unrecordedAttemptAt: 0 }) as UpdateRuntime;

export function isClaudeCliUpdateRunning(): boolean {
  return runtime.updating;
}

/** Run `claude update` once and report what it did. Never throws. */
export async function updateClaudeCli(options?: {
  env?: Env;
  binaryPath?: string | null;
  spawnInstall?: SpawnInstall;
  timeoutMs?: number;
  /** Test seam; the plugin drops the memoized CLI path after an update. */
  resetResolution?: () => void;
  /** Test seam for the `claude --version` check after the run. */
  probeVersion?: (binaryPath: string, env: Env) => Promise<string | null>;
}): Promise<ClaudeCliUpdateOutcome> {
  if (runtime.updating) return { kind: "busy" };
  runtime.updating = true;
  try {
    const env = buildClaudeCodeChildEnv(options?.env ?? process.env);
    const binaryPath =
      options?.binaryPath !== undefined
        ? options.binaryPath
        : await resolveClaudeCli(env);
    if (!binaryPath) {
      return { kind: "failed", message: "Claude Code CLI (`claude`) not found." };
    }
    const timeoutMs = options?.timeoutMs ?? UPDATE_TIMEOUT_MS;
    // On Windows the resolved path may be npm's `cli.js`, which runs through
    // node (see executable-path.ts); `cliInvocation` picks the right spawn.
    const [command, args] = cliInvocation(binaryPath, ["update"]);
    const result = await runInstaller(
      options?.spawnInstall ?? spawn,
      command,
      args,
      {
        env,
        cwd: homedir(),
        timeoutMs,
        deadline: Date.now() + timeoutMs,
        label: "claude update",
      },
    );
    const outcome = outcomeOfRun(result);
    let checkedPath = binaryPath;
    if (outcome.kind === "updated") {
      // The install may change layout (npm's cli.js gives way to
      // bin/claude.exe); the next turn must look for the binary again
      // instead of reusing the memoized path, and so does the check below.
      (options?.resetResolution ?? resetClaudeCliResolutionCache)();
      if (options?.binaryPath === undefined) {
        const found = await resolveClaudeCli(env);
        if (found) {
          checkedPath = found;
        } else {
          // The fresh binary missed its short detection probe (a slow first
          // start): check the old path below, and drop the miss so the next
          // turn looks again instead of handing the SDK no path for a minute.
          (options?.resetResolution ?? resetClaudeCliResolutionCache)();
        }
      }
    }
    const installed = await (options?.probeVersion ?? probeCliVersion)(
      checkedPath,
      env,
    );
    return withInstalledVersion(outcome, installed);
  } finally {
    runtime.updating = false;
  }
}

function outcomeOfRun(result: Awaited<ReturnType<typeof runInstaller>>): ClaudeCliUpdateOutcome {
  const outcome = parseClaudeUpdateOutput(result.output ?? "");
  if (outcome) return outcome;
  if (!result.ok && result.output === undefined) {
    // Never ran to the end: a spawn error or the timeout, named in message.
    return { kind: "failed", message: result.message };
  }
  const verdict = failureMessage(result.output ?? "");
  if (verdict) return { kind: "failed", message: verdict };
  return {
    kind: "failed",
    message: result.ok
      ? "claude update printed nothing to judge the outcome by."
      : result.message,
  };
}

/** The version `claude --version` prints, or null when it printed none. */
async function probeCliVersion(binaryPath: string, env: Env): Promise<string | null> {
  const run = await runCliProbe(binaryPath, ["--version"], {
    env,
    timeoutMs: VERSION_CHECK_TIMEOUT_MS,
  });
  if (run.failed) return null;
  return /(\d+\.\d+\.\d+)/.exec(run.stdout)?.[1] ?? null;
}

/**
 * An outcome that names the version the CLI should now be on must agree
 * with `claude --version`. `claude update` reports success when it kept the
 * old launcher (see the top of this file); the version check is what tells.
 */
function withInstalledVersion(
  outcome: ClaudeCliUpdateOutcome,
  installed: string | null,
): ClaudeCliUpdateOutcome {
  let expected: string | null = null;
  let claim = "";
  if (outcome.kind === "updated") {
    expected = outcome.to;
    claim = `claude update reported ${outcome.from} -> ${outcome.to}`;
  } else if (outcome.kind === "up-to-date" && outcome.version) {
    expected = outcome.version;
    claim = `claude update reported ${outcome.version} as up to date`;
  }
  if (expected !== null && installed !== expected) {
    return {
      kind: "failed",
      message: `${claim}, but \`claude --version\` reports ${installed ?? "no version"}; the launcher was not replaced (held open by another program, not the installer's own, or not writable)`,
      installed,
    };
  }
  return { ...outcome, installed };
}

function logOutcome(outcome: ClaudeCliUpdateOutcome): void {
  switch (outcome.kind) {
    case "updated":
      log.info("[opencode-claude] Claude Code CLI updated", outcome);
      return;
    case "up-to-date":
      log.info("[opencode-claude] Claude Code CLI is up to date", outcome);
      return;
    case "busy":
      log.info(
        "[opencode-claude] Claude Code CLI update skipped: another Claude process holds the update lock",
      );
      return;
    case "package-manager":
      log.info(
        "[opencode-claude] Claude Code CLI is installed by a package manager; update it there",
      );
      return;
    case "failed":
      log.warn("[opencode-claude] Claude Code CLI update failed", outcome.message);
      return;
  }
}

/**
 * Whether the record still holds off the next attempt. A finished attempt
 * holds for the interval. A `running` claim holds at least as long as a run
 * may take, so a short interval cannot start a second run beside a slow one;
 * the claim of a process that died mid-run expires the same way.
 */
function recordHoldsOff(record: ClaudeCliUpdateRecord, now: number, intervalMs: number): boolean {
  let holdMs = intervalMs;
  if (record.outcome.kind === "running") {
    holdMs = Math.max(intervalMs, UPDATE_TIMEOUT_MS + VERSION_CHECK_TIMEOUT_MS);
  }
  // An unreadable `at` (a hand-edited file) compares as NaN and falls
  // through to one extra run, the safe side; not guarded further.
  return now - Date.parse(record.at) < holdMs;
}

/**
 * Start the periodic check for this plugin instance; returns the stop
 * function for the plugin's cleanup. OpenCode runs one plugin instance per
 * location, and a machine may run several OpenCode servers, so every
 * instance keeps its own timer, but the record file is shared: the instance
 * that finds the interval elapsed claims the record (`running`) before it
 * starts `claude update`, and the others read the claim and skip. Two
 * instances can still both start only if they read the record within the
 * same few milliseconds. The first check runs right away, so a server that
 * was idle for days catches up as soon as a plugin loads. Models of a new
 * version reach OpenCode the next time the catalog is read: at plugin load,
 * at most once every ten minutes (refreshModelCatalog in index.ts).
 */
export function startClaudeCliAutoUpdate(params: {
  options?: { cliAutoUpdate?: unknown };
  env?: Env;
  /** Test seam for the update itself. */
  update?: () => Promise<ClaudeCliUpdateOutcome>;
  /** Test seam for the CLI check. */
  cliPresent?: () => Promise<boolean>;
}): () => void {
  const env = params.env ?? process.env;
  const reason = cliAutoUpdateDisabledReason(params.options, env);
  if (reason) {
    log.info("[opencode-claude] Claude Code CLI auto-update is off:", reason);
    return () => {};
  }
  const intervalMs = cliUpdateIntervalMs(env);
  const update = params.update ?? (() => updateClaudeCli({ env }));
  const cliPresent =
    params.cliPresent ?? (async () => Boolean(await resolveClaudeCli(env)));
  let stopped = false;

  const tick = async () => {
    if (stopped || runtime.updating) return;
    // No CLI yet (the install action may add one later): wait for the
    // next tick without recording anything.
    if (!(await cliPresent())) return;
    // Instances of one process share the CLI probe above and resume
    // together; the one that already started the update must not be
    // counted as "another Claude process" by the others.
    if (stopped || runtime.updating) return;
    const record = readCliUpdateRecord(env);
    const now = Date.now();
    if (record && recordHoldsOff(record, now, intervalMs)) return;
    // Also over an old record that could not be replaced by the last claim.
    if (now - runtime.unrecordedAttemptAt < intervalMs) return;
    const at = new Date(now).toISOString();
    const claimed = writeCliUpdateRecord(
      { at, outcome: { kind: "running", pid: process.pid } },
      env,
    );
    // The record cannot be written (read-only data dir, full disk): the
    // attempt still counts within this process, and the outcome is not
    // written either, to warn about the record once.
    if (!claimed) runtime.unrecordedAttemptAt = now;
    const outcome = await update();
    const attempt = { at, outcome };
    if (claimed) writeCliUpdateRecord(attempt, env);
    appendCliUpdateLog(attempt, env);
    logOutcome(outcome);
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
