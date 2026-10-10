/**
 * Claude Code CLI installer bridge.
 *
 * When the CLI is missing, the provider offers an install action. The plugin
 * runs only official installers — npm's `@anthropic-ai/claude-code` package,
 * or Anthropic's own install script as fallback — and reports the outcome.
 * The installer runs with piped stdio so the host process never sees a
 * hijacked terminal; output is captured for error reporting only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { resetClaudeCliResolutionCache } from "./executable-path.js";

export type ClaudeCliInstallResult =
  | { ok: true; output?: string }
  | { ok: false; message: string; output?: string };

export type SpawnInstall = (
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

/** Budget for the whole install (npm, then script download and run). */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFERED_OUTPUT = 16 * 1024;
/** How long after `exit` to wait for `close` before settling on `exit`. */
const EXIT_WITHOUT_CLOSE_MS = 500;

const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** Official npm distribution of the Claude Code CLI. */
const NPM_INSTALL_ARGS = ["install", "-g", "@anthropic-ai/claude-code"];
/** Official self-contained installer, used when npm itself is unavailable. */
const INSTALL_SCRIPT_URL = "https://claude.ai/install.sh";

let installing = false;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function tail(text: string, max = MAX_BUFFERED_OUTPUT): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

export function firstMeaningfulLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/**
 * Install the official Claude Code CLI into the user environment. npm is
 * tried first (deterministic, Node is a given — the plugin runs in it); the
 * official install script is the fallback for hosts without npm. When both
 * fail, both reasons are reported.
 */
export async function installClaudeCli(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cwd?: string;
  spawnInstall?: SpawnInstall;
  timeoutMs?: number;
}): Promise<ClaudeCliInstallResult> {
  if (installing) {
    return {
      ok: false,
      message: "A Claude Code install is already in progress.",
    };
  }
  installing = true;

  const env = buildClaudeCodeChildEnv(options?.env ?? process.env);
  const spawnInstall = options?.spawnInstall ?? spawn;
  const timeoutMs = options?.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const cwd = options?.cwd ?? process.cwd();
  // One deadline for every step: a hung npm must not leave the script
  // fallback a fresh full budget, or the action could run for twice (three
  // times, counting the download) as long as promised.
  const installOptions = { env, cwd, timeoutMs, deadline: Date.now() + timeoutMs };

  try {
    const npm = await runInstaller(
      spawnInstall,
      "npm",
      NPM_INSTALL_ARGS,
      installOptions,
    );
    if (npm.ok) return installed();

    // npm missing or failed — try the official install script.
    const script = await runInstallScript(spawnInstall, installOptions);
    if (script.ok) return installed();
    return {
      ok: false,
      message: `Install script failed: ${script.message}\nnpm install failed: ${npm.message}`,
    };
  } finally {
    installing = false;
  }
}

/** The CLI exists now: drop a cached "not found" so detection sees it. */
function installed(): ClaudeCliInstallResult {
  resetClaudeCliResolutionCache();
  return { ok: true };
}

export type InstallerOptions = {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Total budget, for the timeout message. */
  timeoutMs: number;
  /** Epoch ms by which every step must be done. */
  deadline: number;
  /** What the timeout message calls the run; "Claude Code install" by default. */
  label?: string;
};

/**
 * Download the script to a private temp file and run it only after curl
 * reported a complete download: piping into bash would execute a truncated
 * script and report curl's failure as bash's success.
 */
async function runInstallScript(
  spawnInstall: SpawnInstall,
  options: InstallerOptions,
): Promise<ClaudeCliInstallResult> {
  // mkdtemp failing (full or read-only tmp) is an install failure to report,
  // not an exception that escapes installClaudeCli's result contract.
  let dir: string;
  try {
    dir = await mkdtemp(join(tmpdir(), "opencode-claude-install-"));
  } catch (error) {
    return {
      ok: false,
      message: `Could not create a temp dir for the install script: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const scriptPath = join(dir, "install.sh");
  try {
    const download = await runInstaller(
      spawnInstall,
      "curl",
      ["-fsSL", "-o", scriptPath, INSTALL_SCRIPT_URL],
      options,
    );
    if (!download.ok) return download;
    return await runInstaller(spawnInstall, "bash", [scriptPath], options);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run one CLI step with piped stdio and a deadline. The captured output (ANSI
 * stripped, last 16 KB) comes back with the result: the install path reports
 * its first line on failure, the update path reads the outcome from it.
 */
export function runInstaller(
  spawnInstall: SpawnInstall,
  command: string,
  args: string[],
  options: InstallerOptions,
): Promise<ClaudeCliInstallResult> {
  const timedOut: ClaudeCliInstallResult = {
    ok: false,
    message: `${options.label ?? "Claude Code install"} timed out after ${Math.round(
      options.timeoutMs / 1000,
    )}s.`,
  };
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) return Promise.resolve(timedOut);
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ClaudeCliInstallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawnInstall(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({
        ok: false,
        message:
          error instanceof Error ? error.message : `Failed to run ${command}`,
      });
      return;
    }

    timer = setTimeout(() => {
      child.kill();
      finish(timedOut);
    }, remaining);

    const onData = (chunk: string | Buffer) => {
      output = tail(output + stripAnsi(String(chunk)));
    };
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => {
      finish({ ok: false, message: error.message });
    });
    const settle = (code: number | null) => {
      if (code === 0) {
        finish({ ok: true, output });
        return;
      }
      finish({
        ok: false,
        message:
          firstMeaningfulLine(output) ||
          `${options.label ?? "Claude Code install"} exited with code ${code ?? "unknown"}.`,
        output,
      });
    };
    // `exit` can fire before the pipes are drained; `close` means the output
    // is complete. `exit` stays as the fallback for children that never
    // close (test doubles).
    child.once("close", (code) => settle(code));
    child.once("exit", (code) => {
      const late = setTimeout(() => settle(code), EXIT_WITHOUT_CLOSE_MS);
      late.unref?.();
    });
  });
}

export function isClaudeCliInstallRunning(): boolean {
  return installing;
}
