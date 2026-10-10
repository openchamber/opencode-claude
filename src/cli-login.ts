/**
 * Sign-in bridge to the official Claude Code CLI.
 *
 * The plugin implements no OAuth of its own: `claude auth login --claudeai`
 * runs the entire flow and stores its own credentials. This module only
 * relays the CLI's terminal I/O into the host UI so the user does not have to
 * leave OpenCode/OpenChamber for a separate terminal:
 *
 *   stdout: "Opening browser to sign in…"
 *   stdout: "If the browser didn't open, visit: https://claude.com/…/authorize?…"
 *   stdout: "Paste code here if prompted > "
 *   stderr: "Invalid code. Please make sure the full code was copied."
 *
 * We forward the authorize URL to the host (which opens it) and pipe the code
 * the user pastes back into the CLI's stdin. No token ever passes through the
 * plugin — success is read from the CLI's exit code alone.
 *
 * The CLI rejects a malformed code locally and keeps prompting on the same
 * challenge, but exits when a well-formed code fails the token exchange, so
 * both a live process and a dead one are normal after a failed attempt.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { cliInvocation, resolveClaudeCli } from "./executable-path.js";

export type ClaudeCliLoginStatus =
  | { state: "idle" }
  | { state: "awaiting-code"; url: string }
  | { state: "verifying" }
  | { state: "succeeded" }
  | { state: "failed"; message: string };

export type ClaudeCliLoginStart =
  | { state: "awaiting-code"; url: string }
  | { state: "failed"; message: string };

export type ClaudeCliLoginSubmit =
  | { ok: true }
  | { ok: false; message: string };

type ClaudeCliLoginVerification = { ok: boolean; message: string };

type SpawnLogin = (
  executable: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

/** The CLI prints the URL as soon as it starts; a slow print means it is stuck. */
const URL_TIMEOUT_MS = 30_000;
/** Token exchange the CLI performs after the code is submitted. */
const VERIFY_TIMEOUT_MS = 120_000;
/** An abandoned sign-in must not leave a CLI process waiting on stdin forever. */
const IDLE_TIMEOUT_MS = 15 * 60_000;
/** Keep the tail only — the transcript is used for pattern matching, not display. */
const MAX_BUFFERED_OUTPUT = 64 * 1024;

const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;
const URL_PATTERN = /https?:\/\/[^\s'"<>]+/g;
const INVALID_CODE_PATTERN = /invalid code/i;

let status: ClaudeCliLoginStatus = { state: "idle" };
let child: ChildProcess | null = null;
let stdout = "";
let stderr = "";
/** The URL the CLI is currently waiting on a code for. */
let authorizeUrl: string | null = null;
let urlWaiters: Array<(url: string | null) => void> = [];
let verificationWaiters: Array<(result: ClaudeCliLoginVerification) => void> = [];
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function isChildAlive(): boolean {
  return Boolean(child && child.exitCode === null && !child.killed);
}

/** Last URL wins, so a reprint by the CLI supersedes what came before it. */
function extractAuthorizeUrl(text: string): string | null {
  const matches = text.match(URL_PATTERN);
  if (!matches) return null;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const candidate = matches[index]!.replace(/[).,;:'"]+$/, "");
    if (/oauth|authorize/i.test(candidate)) return candidate;
  }
  return null;
}

function appendOutput(current: string, chunk: string): string {
  const next = current + chunk.replace(ANSI_PATTERN, "");
  return next.length > MAX_BUFFERED_OUTPUT
    ? next.slice(next.length - MAX_BUFFERED_OUTPUT)
    : next;
}

function resolveUrlWaiters(url: string | null): void {
  const waiters = urlWaiters;
  urlWaiters = [];
  for (const waiter of waiters) waiter(url);
}

function resolveVerificationWaiters(result: ClaudeCliLoginVerification): void {
  const waiters = verificationWaiters;
  verificationWaiters = [];
  for (const waiter of waiters) waiter(result);
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (isChildAlive()) child?.kill();
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

function teardown(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  child = null;
}

export function getClaudeCliLoginStatus(): ClaudeCliLoginStatus {
  return status;
}

/**
 * Launch (or reuse) the official CLI sign-in and return the URL it wants the
 * user to open. A live process is reused so retrying a rejected code keeps the
 * verifier the CLI holds in memory; a dead one is replaced with a fresh flow.
 */
export async function startClaudeCliLogin(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cwd?: string;
  binaryPath?: string | null;
  spawnLogin?: SpawnLogin;
  urlTimeoutMs?: number;
}): Promise<ClaudeCliLoginStart> {
  if (!isChildAlive()) {
    const env = buildClaudeCodeChildEnv(options?.env ?? process.env);
    const binaryPath =
      options?.binaryPath === undefined
        ? await resolveClaudeCli(env)
        : options.binaryPath;
    if (!binaryPath) {
      status = {
        state: "failed",
        message:
          "Claude Code CLI (`claude`) was not found — install it via the provider's install action or with `npm install -g @anthropic-ai/claude-code`.",
      };
      return status;
    }
    // A concurrent start may have launched the CLI while resolution awaited;
    // reuse it rather than spawning a second one that would orphan the first.
    if (!isChildAlive()) {
      const failure = launchLoginChild(binaryPath, env, options);
      if (failure) return failure;
    }
  }

  if (authorizeUrl) {
    status = { state: "awaiting-code", url: authorizeUrl };
    return status;
  }

  const url = await waitForAuthorizeUrl(options?.urlTimeoutMs ?? URL_TIMEOUT_MS);
  if (url) {
    status = { state: "awaiting-code", url };
    return status;
  }

  cancelClaudeCliLogin();
  status = {
    state: "failed",
    message:
      firstMeaningfulLine(stderr) ||
      "Claude Code CLI did not report a sign-in URL.",
  };
  return status;
}

/**
 * Spawn the CLI sign-in and wire its output into the module state. Every
 * handler ignores a child that is no longer the current one: a superseded
 * process (cancelled, or killed by the idle timer) exits after its successor
 * started and must not tear down, fail, or overwrite the successor's flow.
 * Returns the failure status when the spawn itself throws.
 */
function launchLoginChild(
  binaryPath: string,
  env: Record<string, string | undefined>,
  options: { cwd?: string; spawnLogin?: SpawnLogin } | undefined,
): ClaudeCliLoginStart | null {
  stdout = "";
  stderr = "";
  authorizeUrl = null;

  try {
    const spawnLogin = options?.spawnLogin ?? spawn;
    const [command, args] = cliInvocation(binaryPath, ["auth", "login", "--claudeai"]);
    const spawned = spawnLogin(command, args, {
      cwd: options?.cwd ?? process.cwd(),
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = spawned;
    armIdleTimer();

    spawned.stdout?.setEncoding?.("utf8");
    spawned.stderr?.setEncoding?.("utf8");
    spawned.stdout?.on("data", (chunk: string | Buffer) => {
      if (child !== spawned) return;
      stdout = appendOutput(stdout, String(chunk));
      const url = extractAuthorizeUrl(stdout);
      if (url && url !== authorizeUrl) {
        authorizeUrl = url;
        // A submit in flight owns the terminal status until it settles.
        if (status.state !== "verifying") {
          status = { state: "awaiting-code", url };
        }
        resolveUrlWaiters(url);
      }
    });
    spawned.stderr?.on("data", (chunk: string | Buffer) => {
      if (child !== spawned) return;
      stderr = appendOutput(stderr, String(chunk));
      // A malformed code leaves the CLI running and prompting again, so this
      // notice — not an exit — is how that failure is announced.
      if (INVALID_CODE_PATTERN.test(stderr)) {
        resolveVerificationWaiters({
          ok: false,
          message:
            firstMeaningfulLine(stderr) ||
            "Claude Code rejected the sign-in code.",
        });
      }
    });
    // A broken pipe (CLI gone while we write the code) must not take the
    // host process down.
    spawned.stdin?.on("error", () => {});
    spawned.once("error", (error) => {
      if (child !== spawned) return;
      status = { state: "failed", message: error.message };
      teardown();
      resolveUrlWaiters(null);
      resolveVerificationWaiters({ ok: false, message: error.message });
    });
    spawned.once("exit", (code, signal) => {
      if (child !== spawned) return;
      teardown();
      if (code !== 0 && status.state !== "succeeded") {
        status = {
          state: "failed",
          message: describeExit(code, signal),
        };
      }
      resolveUrlWaiters(null);
      resolveVerificationWaiters(
        code === 0
          ? { ok: true, message: "" }
          : {
              ok: false,
              message: firstMeaningfulLine(stderr) || describeExit(code, signal),
            },
      );
    });
  } catch (error) {
    teardown();
    status = {
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
    return status;
  }
  return null;
}

function waitForAuthorizeUrl(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (url: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(url);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    urlWaiters.push(finish);
  });
}

/**
 * Hand the code the user pasted in the host UI to the waiting CLI.
 * Success is the CLI's own exit status — the plugin never sees the credential.
 */
export async function submitClaudeCliLoginCode(
  code: string,
  options?: { verifyTimeoutMs?: number },
): Promise<ClaudeCliLoginSubmit> {
  const trimmed = code.trim();
  if (!trimmed) return { ok: false, message: "No sign-in code was provided." };
  if (!isChildAlive() || !child?.stdin?.writable) {
    return {
      ok: false,
      message:
        "The Claude Code sign-in is no longer running — start the sign-in again.",
    };
  }

  // Only output produced from here on describes this attempt: the CLI rejects
  // a malformed code locally and instantly, so a stale notice from the
  // previous attempt would fail this one before the CLI has even read it.
  stderr = "";
  status = { state: "verifying" };
  armIdleTimer();

  try {
    child.stdin.write(`${trimmed}\n`);
  } catch (error) {
    status = {
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
    return { ok: false, message: status.message };
  }

  const outcome = await waitForVerification(
    options?.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS,
  );

  if (outcome.ok) {
    status = { state: "succeeded" };
    return { ok: true };
  }
  // The rejected code does not burn the challenge: the CLI holds its verifier
  // in memory and prompts again on the same URL, so the sign-in stays usable.
  status = { state: "failed", message: outcome.message };
  return { ok: false, message: outcome.message };
}

/**
 * Resolves on the first of: a clean exit (code accepted), a rejection notice
 * on stderr, or a non-zero exit. The timer stays referenced — an unreferenced
 * one lets an otherwise idle host exit while this promise is still awaited.
 */
function waitForVerification(
  timeoutMs: number,
): Promise<ClaudeCliLoginVerification> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ClaudeCliLoginVerification) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          message: "Timed out waiting for Claude Code to accept the sign-in code.",
        }),
      timeoutMs,
    );

    verificationWaiters.push(finish);
  });
}

function describeExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  return `Claude Code login exited with ${
    signal ? `signal ${signal}` : `code ${code ?? "unknown"}`
  }.`;
}

function firstMeaningfulLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

export function cancelClaudeCliLogin(): void {
  if (isChildAlive()) child?.kill();
  teardown();
  authorizeUrl = null;
  // Nothing is pending anymore, so no state may claim otherwise. Callers that
  // cancel because of a failure overwrite this with the reason.
  if (status.state === "awaiting-code" || status.state === "verifying") {
    status = { state: "idle" };
  }
  resolveUrlWaiters(null);
  resolveVerificationWaiters({
    ok: false,
    message: "The Claude Code sign-in was cancelled.",
  });
}

export function resetClaudeCliLoginForTests(): void {
  cancelClaudeCliLogin();
  stdout = "";
  stderr = "";
  authorizeUrl = null;
  status = { state: "idle" };
}
