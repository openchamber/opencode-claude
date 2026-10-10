/**
 * Keep the Claude Code CLI current.
 *
 * Claude Code updates itself from its interactive screen: the background
 * updater is a hook of the terminal UI, and a CLI driven through the Agent
 * SDK (`-p --output-format stream-json`) never mounts it. A CLI used only from
 * OpenCode therefore stays on the version it was installed with, and models
 * released since never show up. The plugin runs `claude update` for it: in
 * the background, once per interval per server process, with the outcome
 * recorded next to models.json. Concurrent servers (two OpenCode processes
 * on one machine) are serialized by Claude Code itself: the install runs
 * under its per-version lock, and the loser just reports busy.
 *
 * `claude update` needs no terminal. It prints plain lines and exits 0 even
 * when it did nothing (another process held the version lock, or a package
 * manager owns the install), so the outcome is read from its output.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { runInstaller, type SpawnInstall } from "./cli-install.js";
import {
  cliInvocation,
  resetClaudeCliResolutionCache,
  resolveClaudeCli,
} from "./executable-path.js";
import { log } from "./log.js";

export type ClaudeCliUpdateOutcome =
  | { kind: "updated"; from: string; to: string }
  | { kind: "up-to-date"; version: string | null }
  /** Another Claude process held the update lock; the CLI asks to retry later. */
  | { kind: "busy" }
  /** winget, Homebrew, apt and friends: the CLI leaves updates to them. */
  | { kind: "package-manager" }
  | { kind: "failed"; message: string };

export type ClaudeCliUpdateRecord = {
  /** ISO time of the last attempt. */
  at: string;
  outcome: ClaudeCliUpdateOutcome;
};

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** Claude Code ships several times a week, some days several times. */
const DEFAULT_INTERVAL_MS = 60 * 60_000;
/** Download of the ~240 MB binary, checksum and launcher swap. */
const UPDATE_TIMEOUT_MS = 10 * 60_000;

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
 * also reads them from the `env` block of its settings.json, which the
 * plugin cannot see; `claude update` itself honours DISABLE_UPDATES there.)
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

function writeCliUpdateRecord(record: ClaudeCliUpdateRecord, env: Env): void {
  try {
    const file = cliUpdateRecordPath(env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(record, null, 2));
  } catch (err) {
    log.warn(
      "[opencode-claude] could not record the CLI update outcome",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * `claude update` prints its progress first ("Current version: …",
 * "Checking for updates…") and the verdict last, so an error is on the last
 * non-empty line.
 */
function lastMeaningfulLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.length > 0) return lines[i]!;
  }
  return "";
}

/** The lines `claude update` prints (Claude Code 2.1.280), by outcome. */
export function parseClaudeUpdateOutput(
  output: string,
): ClaudeCliUpdateOutcome | null {
  const updated = /Successfully updated from (\S+) to version (\S+)/.exec(output);
  if (updated) return { kind: "updated", from: updated[1]!, to: updated[2]! };
  const current = /is up to date(?: \(([^)]+)\))?/.exec(output);
  if (current) return { kind: "up-to-date", version: current[1] ?? null };
  if (/Another Claude process/.test(output)) return { kind: "busy" };
  if (/is managed by /.test(output)) return { kind: "package-manager" };
  return null;
}

let updating = false;

export function isClaudeCliUpdateRunning(): boolean {
  return updating;
}

/** Run `claude update` once and report what it did. Never throws. */
export async function updateClaudeCli(options?: {
  env?: Env;
  binaryPath?: string | null;
  spawnInstall?: SpawnInstall;
  timeoutMs?: number;
  /** Test seam; the plugin drops the memoized CLI path after an update. */
  resetResolution?: () => void;
}): Promise<ClaudeCliUpdateOutcome> {
  if (updating) return { kind: "busy" };
  updating = true;
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
    const outcome = parseClaudeUpdateOutput(result.output ?? "");
    if (outcome?.kind === "updated") {
      // The install may change layout (npm's cli.js gives way to
      // bin/claude.exe); the next turn must look for the binary again
      // instead of reusing the memoized path.
      (options?.resetResolution ?? resetClaudeCliResolutionCache)();
    }
    if (outcome) return outcome;
    if (!result.ok && result.output === undefined) {
      // Never ran to the end: a spawn error or the timeout, named in message.
      return { kind: "failed", message: result.message };
    }
    const verdict = lastMeaningfulLine(result.output ?? "");
    if (verdict) return { kind: "failed", message: verdict };
    return {
      kind: "failed",
      message: result.ok
        ? "claude update printed nothing to judge the outcome by."
        : result.message,
    };
  } finally {
    updating = false;
  }
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
 * Start the periodic check for this plugin instance; returns the stop
 * function for the plugin's cleanup. OpenCode runs one plugin instance per
 * location, so every instance keeps its own timer, but the record file is
 * shared: whichever instance finds the interval elapsed runs the update, the
 * others read the fresh record and skip. The first check runs right away, so
 * a server that was idle for days catches up as soon as a plugin loads.
 * Models of a new version reach OpenCode with the next catalog refresh.
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
    if (stopped || updating) return;
    // No CLI yet (the install action may add one later): wait for the
    // next tick without recording anything.
    if (!(await cliPresent())) return;
    if (stopped) return;
    const record = readCliUpdateRecord(env);
    const now = Date.now();
    if (record && now - Date.parse(record.at) < intervalMs) return;
    const outcome = await update();
    writeCliUpdateRecord({ at: new Date(now).toISOString(), outcome }, env);
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
