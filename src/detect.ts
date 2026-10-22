/**
 * Claude CLI detection + Agent SDK probe (from OpenChamber harness).
 */
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { resolveClaudeCli, runCliProbe } from "./executable-path.js";
import { probeClaudeAgentSdk } from "./query.js";

export type ClaudeDetectStatus =
  | "ready"
  | "needs-login"
  | "missing-cli"
  | "missing-sdk"
  | "error";

export type ClaudeDetectResult = {
  status: ClaudeDetectStatus;
  statusDetail?: string;
  binaryPath?: string | null;
  version?: string | null;
  sdkAvailable: boolean;
  loggedIn: boolean;
};

export function interpretClaudeAuthStatus(payload: unknown): {
  loggedIn: boolean;
  detail: string;
  authMethod?: string;
} {
  if (!payload || typeof payload !== "object") {
    return { loggedIn: false, detail: "invalid-auth-status" };
  }
  const root = payload as Record<string, unknown>;
  const loggedIn = Boolean(root.loggedIn);
  const authMethod =
    typeof root.authMethod === "string" ? root.authMethod : "none";
  const normalized = authMethod.trim().toLowerCase();

  if (!loggedIn) {
    return { loggedIn: false, detail: "auth-status-logged-out", authMethod };
  }

  // Bedrock / Vertex / Foundry bill through the cloud account, not the plan.
  const apiProvider =
    typeof root.apiProvider === "string" ? root.apiProvider.trim() : "";
  if (apiProvider && apiProvider !== "firstParty") {
    return { loggedIn: false, detail: "third-party-provider", authMethod };
  }

  if (
    normalized === "none" ||
    normalized.includes("api") ||
    normalized.includes("console")
  ) {
    return { loggedIn: false, detail: "api-key-only", authMethod };
  }

  const subscription = ["oauth", "claude", "subscription"].some((hint) =>
    normalized.includes(hint),
  );
  return {
    loggedIn: true,
    detail: subscription ? "auth-status-oauth" : "auth-status-logged-in",
    authMethod,
  };
}

/**
 * `claude auth status --json`, spawned asynchronously: it runs before every
 * turn (through checkSubscriptionAuth) inside the OpenCode server, where a
 * synchronous spawn would freeze every stream and health check meanwhile.
 */
export async function probeClaudeAuthStatusCli(options: {
  binaryPath: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): Promise<{ loggedIn: boolean; detail: string; authMethod?: string } | null> {
  const binaryPath = options.binaryPath.trim();
  if (!binaryPath) return null;

  const result = await runCliProbe(binaryPath, ["auth", "status", "--json"], {
    env: buildClaudeCodeChildEnv(options.env || process.env),
    timeoutMs: 6000,
  });
  if (result.failed && !result.stdout.trim()) return null;

  const output = result.stdout.trim();
  if (!output) return { loggedIn: false, detail: "auth-status-empty" };

  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return { loggedIn: false, detail: "auth-status-parse-error" };
    }
    try {
      payload = JSON.parse(output.slice(start, end + 1));
    } catch {
      return { loggedIn: false, detail: "auth-status-parse-error" };
    }
  }

  return interpretClaudeAuthStatus(payload);
}

const SUBSCRIPTION_CHECK_TTL_MS = 60_000;
/** Keyed by config directory: each one holds its own login. */
const subscriptionChecks = new Map<string, { at: number; result: Promise<string | null> }>();

/**
 * The plugin serves Claude plans only: API-key access already has a native
 * OpenCode provider. Returns a user-facing refusal when the CLI is signed in
 * some other way, or null when the turn may run. Unknown probe results fail
 * open so a slow CLI never blocks subscription users; a signed-out CLI fails
 * on its own with an auth error. Cached briefly to keep turns fast.
 */
type AuthStatus = { loggedIn: boolean; detail: string } | null;
type AuthStatusProbe = (configDir?: string) => AuthStatus | Promise<AuthStatus>;

const defaultAuthStatusProbe: AuthStatusProbe = async (configDir) => {
  const binaryPath = await resolveClaudeCli(process.env);
  if (!binaryPath) return null;
  return probeClaudeAuthStatusCli({
    binaryPath,
    env: configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : undefined,
  });
};
let authStatusProbe = defaultAuthStatusProbe;

/** Test seam: replace the CLI probe (null restores the real one). */
export function setAuthStatusProbe(probe: AuthStatusProbe | null): void {
  authStatusProbe = probe ?? defaultAuthStatusProbe;
  subscriptionChecks.clear();
}

export function checkSubscriptionAuth(
  configDir?: string,
  now = Date.now(),
): Promise<string | null> {
  const probe = authStatusProbe;
  const key = configDir ?? "";
  const cached = subscriptionChecks.get(key);
  if (cached && now - cached.at < SUBSCRIPTION_CHECK_TTL_MS) {
    return cached.result;
  }
  const result = Promise.resolve().then(async () => {
    // A failing probe fails open like an unknown result.
    let status: AuthStatus = null;
    try {
      status = await probe(configDir);
    } catch {
      status = null;
    }
    if (status?.detail === "api-key-only") {
      return "Claude Code CLI is signed in with an API key. This provider works only with a Claude plan; use OpenCode's built-in Anthropic provider for API keys, or run `claude auth login --claudeai`.";
    }
    if (status?.detail === "third-party-provider") {
      return "Claude Code CLI is set to use Bedrock, Vertex or another cloud provider. This provider works only with a Claude plan signed in via `claude auth login --claudeai`.";
    }
    return null;
  });
  subscriptionChecks.set(key, { at: now, result });
  return result;
}

export async function detectClaudeCode(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  binaryPath?: string | null;
}): Promise<ClaudeDetectResult> {
  const env = options?.env ?? process.env;
  const binaryPath =
    options?.binaryPath !== undefined
      ? options.binaryPath
      : await resolveClaudeCli(env);

  if (!binaryPath) {
    return {
      status: "missing-cli",
      statusDetail:
        "Claude Code CLI (`claude`) not found — install it via the provider's install action or with `npm install -g @anthropic-ai/claude-code`.",
      binaryPath: null,
      version: null,
      sdkAvailable: false,
      loggedIn: false,
    };
  }

  const versionRun = await runCliProbe(binaryPath, ["--version"], {
    env: buildClaudeCodeChildEnv(env),
    timeoutMs: 4000,
  });
  const versionOutput = versionRun.stdout.trim();
  const version =
    versionOutput.match(/(\d+\.\d+\.\d+)/)?.[1] ?? (versionOutput || null);

  const sdk = await probeClaudeAgentSdk();
  if (!sdk.available) {
    return {
      status: "missing-sdk",
      statusDetail: sdk.error || "Claude Agent SDK unavailable",
      binaryPath,
      version,
      sdkAvailable: false,
      loggedIn: false,
    };
  }

  const authStatus = await probeClaudeAuthStatusCli({ binaryPath, env });
  const loggedIn = Boolean(authStatus?.loggedIn);

  if (!loggedIn) {
    return {
      status: "needs-login",
      statusDetail:
        "Claude Code is installed but not logged in with a subscription. Run `claude auth login`.",
      binaryPath,
      version,
      sdkAvailable: true,
      loggedIn: false,
    };
  }

  return {
    status: "ready",
    statusDetail: authStatus?.detail || "ready",
    binaryPath,
    version,
    sdkAvailable: true,
    loggedIn: true,
  };
}

export { resolveClaudeCodeExecutable } from "./executable-path.js";
