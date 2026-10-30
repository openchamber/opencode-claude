/**
 * Asks the local Claude Code CLI which models the account can use and the
 * context window it runs each one with. A window question costs a model
 * request, so answers go to the window cache (model-cache.ts) under a key of
 * everything they depend on, and only what the cache lacks is asked.
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { isJsEntrypoint, resolveClaudeCodeExecutable } from "./executable-path.js";
import { log } from "./log.js";
import {
  cacheForListedModels,
  readContextWindowCache,
  readLastContextWindows,
  writeContextWindowCache,
} from "./model-cache.js";
import { extendedProbeIds, listedModelIds, type SdkModelRow } from "./models.js";
import { loadClaudeAgentSdk } from "./query.js";

/** Wait per model id for the CLI's context window; a stuck CLI ends the probe. */
const CONTEXT_PROBE_TIMEOUT_MS = 10_000;

export type ClaudeModelDiscovery = {
  /** The CLI's `supportedModels()` rows. */
  rows: ModelInfo[];
  /**
   * Context window the CLI itself runs each model id with, plain and `[1m]`
   * (`getContextUsage().rawMaxTokens`); null when the CLI refused the id.
   * Ids missing here could not be asked (old CLI, timeout).
   */
  windows: Map<string, number | null>;
  /** What the CLI reported before, for ids it could not answer now. */
  lastAnswers: Map<string, number | null>;
  /**
   * Whether the CLI gave a window for every listed model, now or from the
   * cache. A CLI signed out still lists models, but its own short list, and
   * sizes only the one it starts on; then the list must not replace the
   * plugin's (models.ts modelsAfterIncompleteRefresh).
   */
  complete: boolean;
};

/** The part of the SDK's query the window questions use. */
type WindowQuery = Pick<Query, "initializationResult" | "setModel" | "getContextUsage">;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ value })),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Window of the model the query runs now. `summary` makes the CLI answer
 * locally; the default full form also counts each part of the context
 * through the token-count API, which the window does not need. SDK 0.3.300
 * (the version package.json requires) passes `detail` on; 0.3.224 dropped
 * it. A CLI as old as 2.1.237 ignores `detail` and answers in the full form,
 * still with the right window.
 */
async function currentContextWindow(q: WindowQuery): Promise<number | null> {
  const usage = await q.getContextUsage({ detail: "summary" });
  const tokens = usage?.rawMaxTokens;
  return typeof tokens === "number" && tokens > 0 ? tokens : null;
}

/**
 * Variables that change the window Claude Code runs a model with: the 1M
 * switch, and an assumed window, which applies to a model Claude Code knows
 * only together with DISABLE_COMPACT (docs, model-config "Correct the window
 * for a gateway or custom model ID").
 */
const WINDOW_VARIABLES = [
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "DISABLE_COMPACT",
] as const;

/**
 * WINDOW_VARIABLES as set in the user's Claude Code settings.json `env`.
 * Read on each model-list refresh, like the variables in the environment; a
 * change shows at the next refresh. The CLI also reports its merged settings
 * through `getSettings()` (SDK 0.3.300, not in the SDK's public types), which
 * covers organization-managed settings too; the documented file is used
 * instead.
 */
export function settingsWindowVariables(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const found: Record<string, string> = {};
  try {
    const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as {
      env?: Record<string, unknown>;
    };
    for (const name of WINDOW_VARIABLES) {
      const value = settings?.env?.[name];
      if (value !== undefined && value !== null) found[name] = String(value);
    }
  } catch {
    // No settings.json, or one Claude Code cannot read either.
  }
  return found;
}

/** The values Claude Code reads as "on" for a yes/no variable, any case. */
const SWITCH_ON = ["1", "true", "yes", "on"];

/**
 * Whether CLAUDE_CODE_DISABLE_1M_CONTEXT is on, in settings.json or in the
 * environment: Claude Code reads the `env` of its settings over the process
 * environment, either way (CLI 2.1.312, probed). Then every model runs at
 * 200K and the CLI refuses every `[1m]` variant, so asking them would only
 * spend model requests.
 */
export function oneMillionContextDisabled(env: Record<string, string | undefined>): boolean {
  const value =
    settingsWindowVariables(env).CLAUDE_CODE_DISABLE_1M_CONTEXT ??
    env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
  return value !== undefined && SWITCH_ON.includes(value.trim().toLowerCase());
}

/**
 * Which CLI build runs: its real path, size and modification time. CLIs
 * before 2.1.300 do not report `claude_code_version` at initialize, and an
 * update replaces the file (the native installer and npm both do), so the
 * file tells an update apart without starting `claude --version`.
 */
export function cliFileStamp(executable: string | undefined): string | undefined {
  if (!executable) return undefined;
  try {
    const real = realpathSync(executable);
    const stat = statSync(real);
    return `${real}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * What the CLI's windows depend on besides the model id: the CLI build, the
 * account, and WINDOW_VARIABLES, in the environment and in settings.json.
 */
export async function contextWindowKey(
  q: WindowQuery,
  env: Record<string, string | undefined>,
  executable: string | undefined,
): Promise<string> {
  const init = await withTimeout(q.initializationResult(), CONTEXT_PROBE_TIMEOUT_MS);
  const account = init?.value?.account ?? {};
  const parts = [
    init?.value?.claude_code_version,
    cliFileStamp(executable),
    account.email,
    account.organization,
    account.subscriptionType,
    account.apiProvider,
    WINDOW_VARIABLES.map((name) => env[name]),
    settingsWindowVariables(env),
  ];
  // A digest, so the cache file holds no email address.
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/**
 * How the CLI words a model the account or plan cannot use: "Sonnet with 1M
 * context is not available for your account", "The long context beta is not
 * yet available for this subscription", "Model 'x' isn't available for your
 * account". Any other failure (network, rate limit, a server error) says
 * nothing about access.
 */
const ACCESS_REFUSED =
  /(?:is not|isn't) (?:currently |yet )?available for (?:your account|this subscription)/i;

/**
 * Switch the idle query to `id` and read the window the CLI uses for it.
 * "refused" when the CLI turns the id down for this account, "failed" when
 * the switch fails otherwise, "unreadable" when the switch worked but the
 * window question did not (then it fails for every model), "timeout" when
 * the CLI stops answering.
 */
async function askContextWindow(
  q: WindowQuery,
  id: string,
): Promise<number | "refused" | "failed" | "unreadable" | "timeout"> {
  const answer = await withTimeout(
    (async (): Promise<number | "refused" | "failed" | "unreadable"> => {
      try {
        await q.setModel(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return ACCESS_REFUSED.test(message) ? "refused" : "failed";
      }
      try {
        return (await currentContextWindow(q)) ?? "unreadable";
      } catch {
        return "unreadable";
      }
    })(),
    CONTEXT_PROBE_TIMEOUT_MS,
  );
  return answer ? answer.value : "timeout";
}

/**
 * Fill `windows` with what is missing for the listed models. The CLI answers
 * per account and per CLI version: Opus 4.6 runs at 200K and at 1M only as
 * `[1m]`, a plan without 1M access refuses `[1m]`, and
 * CLAUDE_CODE_DISABLE_1M_CONTEXT turns every model down to 200K. Returns
 * whether anything was added.
 */
export async function askMissingContextWindows(
  q: WindowQuery,
  rows: SdkModelRow[],
  windows: Map<string, number | null>,
  options: { skipExtended?: boolean } = {},
): Promise<boolean> {
  let added = false;
  // Every question costs a model request, so the pass stops as soon as the
  // CLI stops answering or cannot report a window at all.
  for (const id of listedModelIds(rows)) {
    if (windows.has(id)) continue;
    const window = await askContextWindow(q, id);
    if (window === "timeout" || window === "unreadable") return added;
    // A plain id without an answer is asked again next time; meanwhile it
    // keeps the window the CLI reported before (see modelsFromSdk).
    if (typeof window !== "number") continue;
    windows.set(id, window);
    added = true;
  }
  if (options.skipExtended) {
    // With the switch on the CLI refuses every `[1m]` id: a refusal without
    // asking, so a variant listed from an earlier answer is not listed now.
    for (const id of extendedProbeIds(rows, windows)) {
      windows.set(id, null);
      added = true;
    }
    return added;
  }
  for (const id of extendedProbeIds(rows, windows)) {
    const window = await askContextWindow(q, id);
    if (window === "timeout" || window === "unreadable") return added;
    // Only a refusal is kept (as null, so the variant is not listed); a
    // failure is asked again next time.
    if (window === "failed") continue;
    windows.set(id, window === "refused" ? null : window);
    added = true;
  }
  return added;
}

/**
 * Ask the local CLI which models this account can use and the context window
 * of each. Starts a Claude Code process with no prompt and persists no
 * session. The list costs no model request; a window not yet in the cache
 * costs one (see askContextWindow), so only those are asked.
 */
export async function listClaudeSupportedModels(
  timeoutMs = 20_000,
): Promise<ClaudeModelDiscovery | null> {
  const sdk = await loadClaudeAgentSdk();
  let release: () => void = () => {};
  const idle = (async function* () {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  })();
  const env = buildClaudeCodeChildEnv(process.env);
  const pathToClaudeCodeExecutable = await resolveClaudeCodeExecutable({ env });
  const q = sdk.query({
    prompt: idle,
    options: {
      env,
      persistSession: false,
      // The user's settings, as in a chat: CLAUDE_CODE_DISABLE_1M_CONTEXT in
      // settings.json `env` changes the windows. Their hooks stay off.
      settingSources: ["user"],
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true, disableAllHooks: true },
      ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}),
      ...(pathToClaudeCodeExecutable && isJsEntrypoint(pathToClaudeCodeExecutable)
        ? { executable: "node" as const }
        : {}),
    },
  });
  try {
    const listing = await withTimeout(q.supportedModels(), timeoutMs);
    if (!listing) return null;
    const rows = listing.value;
    const windows = new Map<string, number | null>();
    // Read before this pass can rewrite the cache.
    const lastAnswers = readLastContextWindows();
    const listed = listedModelIds(rows);
    // The list stands on its own: a failure while asking windows keeps it
    // and the windows already answered; the rest keep their last answer.
    try {
      const key = await contextWindowKey(q, env, pathToClaudeCodeExecutable ?? undefined);
      const cached = cacheForListedModels(readContextWindowCache(key), listed);
      for (const [id, window] of Object.entries(cached?.windows ?? {})) windows.set(id, window);
      // With a cache, only ids the CLI could not answer last time are asked.
      const asked = await askMissingContextWindows(q, rows, windows, {
        skipExtended: oneMillionContextDisabled(env),
      });
      if (asked) {
        writeContextWindowCache({
          key,
          // The day starts over only when everything was asked.
          savedAt: cached?.savedAt ?? Date.now(),
          models: cached?.models ?? listed,
          windows: Object.fromEntries(windows),
        });
      }
    } catch (err) {
      log.warn(
        "[opencode-claude] could not read context windows from Claude Code",
        err instanceof Error ? err.message : err,
      );
    }
    const unanswered = listed.filter((id) => typeof windows.get(id) !== "number");
    if (unanswered.length) {
      log.warn(
        "[opencode-claude] Claude Code gave no context window for some models; the model list keeps what it had",
        { unanswered },
      );
    }
    return { rows, windows, lastAnswers, complete: unanswered.length === 0 };
  } finally {
    release();
    q.close();
  }
}
