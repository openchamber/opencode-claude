/**
 * Resolve the `claude` CLI binary (from OpenChamber harness executable-path).
 *
 * Every probe is an async spawn with a hard timeout: detection runs inside the
 * long-lived host process (plugin load, sign-in polling, every Agent SDK
 * query), and a synchronous spawn there stalls the event loop that also
 * serves the proxy's streams and the host's health checks.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildClaudeCodeChildEnv } from "./auth-env.js";

type ProbeEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type CliProbeResult = {
  /** Exit code; null when the process could not start, timed out, or was signalled. */
  status: number | null;
  stdout: string;
  /** Spawn error or timeout — the probe produced no trustworthy answer. */
  failed: boolean;
};

/** Probes print a version or a small JSON document; anything larger is noise. */
const MAX_PROBE_OUTPUT = 64 * 1024;

/**
 * npm's older Claude Code installs on Windows ship only `cli.js`. A JS entry
 * point is not executable on its own there, and the Agent SDK would pick the
 * host's runtime for it (bun inside OpenCode, rarely on PATH), so it always
 * runs through node, which an npm install implies.
 */
export function isJsEntrypoint(path: string): boolean {
  return /\.[cm]?js$/i.test(path);
}

/** The command and arguments that run the CLI at `binaryPath`. */
export function cliInvocation(binaryPath: string, args: string[]): [string, string[]] {
  return isJsEntrypoint(binaryPath) ? ["node", [binaryPath, ...args]] : [binaryPath, args];
}

/**
 * Run a short-lived CLI probe without blocking the event loop. The child is
 * killed and the probe reported as failed once `timeoutMs` elapses.
 */
export function runCliProbe(
  command: string,
  args: string[],
  options: { env?: ProbeEnv; timeoutMs: number },
): Promise<CliProbeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (status: number | null, failed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, failed });
    };
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish(null, true);
    }, options.timeoutMs);
    // A pending probe must not keep a short-lived host process alive.
    timer.unref?.();

    try {
      const [file, argv] = cliInvocation(command, args);
      child = spawn(file, argv, {
        env: options.env as NodeJS.ProcessEnv | undefined,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(null, true);
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_PROBE_OUTPUT) stdout += chunk;
    });
    child.once("error", () => finish(null, true));
    child.once("close", (code: number | null) => finish(code, false));
  });
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function probeClaude(candidate: string, env: ProbeEnv): Promise<boolean> {
  const result = await runCliProbe(candidate, ["--version"], {
    env: buildClaudeCodeChildEnv(env),
    timeoutMs: 4000,
  });
  if (result.failed) return false;
  return result.status === 0 || Boolean(result.stdout.trim());
}

/** Explicit paths are checked on disk first so absent candidates never spawn. */
async function probeClaudePath(candidate: string, env: ProbeEnv): Promise<boolean> {
  return (await isExecutableFile(candidate)) && (await probeClaude(candidate, env));
}

/**
 * Windows: the Agent SDK spawns the executable without a shell, and Node/Bun
 * refuse to run a `.cmd`/`.bat` that way when an argument holds cmd.exe
 * special characters (the SDK's `--settings` JSON always does), or at all on
 * newer runtimes. A batch shim is unwrapped to the native `claude.exe` (or
 * `cli.js`) npm installs beside it. Checked on disk only: a `.cmd` probe can
 * be rejected outright, and a cold start of the ~250 MB exe can outlast the
 * probe timeout.
 */
export async function resolveWindowsClaudePath(
  candidate: string,
): Promise<string | null> {
  if (!(await isExecutableFile(candidate))) return null;
  if (/\.exe$/i.test(candidate)) return candidate;
  if (!/\.(cmd|bat)$/i.test(candidate)) return null;
  const pkg = join(dirname(candidate), "node_modules", "@anthropic-ai", "claude-code");
  for (const target of [join(pkg, "bin", "claude.exe"), join(pkg, "cli.js")]) {
    if (await isExecutableFile(target)) return target;
  }
  return null;
}

/** On Windows a candidate is usable only as a native target (see above). */
async function usableClaudePath(
  candidate: string,
  env: ProbeEnv,
): Promise<string | null> {
  if (process.platform === "win32") return resolveWindowsClaudePath(candidate);
  return (await probeClaudePath(candidate, env)) ? candidate : null;
}

/**
 * Install locations the managed OpenChamber server commonly misses because its
 * PATH is not a login shell's PATH: the official installer's `~/.local/bin`
 * and the npm global bin.
 */
async function knownClaudeLocations(env: ProbeEnv): Promise<string[]> {
  const home = typeof env.HOME === "string" && env.HOME ? env.HOME : homedir();
  if (process.platform === "win32") {
    // npm's global bin is the prefix root on Windows, not `<prefix>\bin`, and
    // `npm` itself is a .cmd that cannot be spawned without a shell.
    const appData =
      typeof env.APPDATA === "string" && env.APPDATA
        ? env.APPDATA
        : join(home, "AppData", "Roaming");
    return [
      join(home, ".local", "bin", "claude.exe"),
      join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
      join(appData, "npm", "claude.cmd"),
    ];
  }
  const candidates = [join(home, ".local", "bin", "claude")];

  const prefix = await runCliProbe("npm", ["prefix", "-g"], { timeoutMs: 6000 });
  const dir = prefix.failed ? "" : prefix.stdout.trim();
  if (dir) candidates.push(join(dir, "bin", "claude"));
  return candidates;
}

export async function findBinaryOnPath(
  name: string,
  env: ProbeEnv = process.env,
): Promise<string | null> {
  const pathEnv = typeof env.PATH === "string" ? env.PATH : "";
  const parts = pathEnv.split(process.platform === "win32" ? ";" : ":");
  // Windows: no extensionless variant (npm's sh shim cannot be spawned).
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of parts) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir.replace(/[/\\]$/, "")}/${name}${ext}`;
      const usable = await usableClaudePath(candidate, env);
      if (usable) return usable;
    }
  }

  // A bare name on Windows lets the SDK's spawn find claude.cmd on PATH again;
  // with no path the SDK falls back to its own bundled executable.
  if (process.platform === "win32") return null;
  return (await probeClaude(name, env)) ? name : null;
}

/**
 * `claude` as the managed server sees it: PATH first, then the install
 * locations that a clean server environment usually cannot see.
 *
 * Resolution is memoized per PATH+HOME: it runs on every Agent SDK query, and
 * re-probing (`npm prefix -g`, `claude --version`) would spawn several
 * processes per turn. Concurrent callers share one in-flight probe. A miss is
 * cached only briefly, so a machine without the CLI does not re-probe every
 * turn yet still notices a manual install within a minute (the install
 * action clears the cache right away).
 */
const MISS_CACHE_MS = 60_000;
let cachedResolution:
  | { key: string; path: string | null; expiresAt: number }
  | null = null;
let inflight: { key: string; promise: Promise<string | null> } | null = null;

export function resolveClaudeCli(
  env: ProbeEnv = process.env,
): Promise<string | null> {
  const key = `${env.PATH ?? ""}\0${env.HOME ?? ""}`;
  if (
    cachedResolution &&
    cachedResolution.key === key &&
    Date.now() < cachedResolution.expiresAt
  ) {
    return Promise.resolve(cachedResolution.path);
  }
  if (inflight && inflight.key === key) return inflight.promise;
  const promise = probeClaudeCli(env).then(
    (path) => {
      if (inflight?.promise === promise) {
        inflight = null;
        cachedResolution = {
          key,
          path,
          expiresAt: path ? Number.POSITIVE_INFINITY : Date.now() + MISS_CACHE_MS,
        };
      }
      return path;
    },
    (error) => {
      if (inflight?.promise === promise) inflight = null;
      throw error;
    },
  );
  inflight = { key, promise };
  return promise;
}

async function probeClaudeCli(env: ProbeEnv): Promise<string | null> {
  let resolved = await findBinaryOnPath("claude", env);
  if (!resolved) {
    for (const candidate of await knownClaudeLocations(env)) {
      resolved = await usableClaudePath(candidate, env);
      if (resolved) break;
    }
  }
  return resolved;
}

/** Drop the memoized resolution (after an install; also a test hook). */
export function resetClaudeCliResolutionCache(): void {
  cachedResolution = null;
  inflight = null;
}

export function resolveClaudeCodeExecutable(options?: {
  env?: ProbeEnv;
}): Promise<string | null> {
  return resolveClaudeCli(options?.env ?? process.env);
}

export function assertClaudeWorkingDirectory(cwd: unknown): string {
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : process.cwd();
}
