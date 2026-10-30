/**
 * OpenCode Claude Auth Plugin
 *
 * Enables Claude Code (subscription) inside OpenCode via:
 * 1. Local OpenAI-compatible proxy backed by the Claude Agent SDK
 * 2. Authentication owned entirely by the local Claude Code CLI
 * 3. Native effort variants, session resume, tools, skills, and MCP
 *
 * Register in opencode.json:
 *   { "plugins": ["@openchamber/opencode-claude"] }
 */
// Type-only: the v2 host loads a plain `{ id, setup }` object, so the plugin
// needs none of OpenCode's runtime packages.
import type { Model, Plugin, Provider } from "@opencode/plugin";
import { configDirForDirectory } from "./config-dir.js";
import {
  CONFIG_DIR_HEADER,
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  KIND_HEADER,
  OPENAI_COMPATIBLE_PACKAGE,
  PROVIDER_ID,
} from "./constants.js";
import { detectClaudeCode } from "./detect.js";
import { installClaudeCli } from "./cli-install.js";
import {
  startClaudeCliLogin,
  submitClaudeCliLoginCode,
} from "./cli-login.js";
import { log } from "./log.js";
import {
  encodeClaudeModelSelection,
  resolveClaudeModelSelection,
} from "./model-selection.js";
import {
  buildEffortVariants,
  getClaudeModels,
  modelsAfterIncompleteRefresh,
  modelsFromSdk,
  setDiscoveredModels,
  type ClaudeModel,
} from "./models.js";
import { listClaudeSupportedModels } from "./model-discovery.js";
import { closeSessionBridges } from "./bridge-pool.js";
import {
  getClaudeProxyBaseUrl,
  acquireProxy,
  releaseProxy,
  setModelFallbackHandler,
  startProxy,
} from "./proxy.js";

export function applyClaudeRequestContextHeaders(
  headers: Record<string, string>,
  directory: string,
  sessionID?: string,
  configDir?: string,
): void {
  // Header values must be Latin-1: fetch rejects a raw path like C:\项目.
  headers[DIRECTORY_HEADER] = encodeURIComponent(directory);
  if (sessionID) headers["x-opencode-claude-session"] = sessionID;
  if (configDir) headers[CONFIG_DIR_HEADER] = encodeURIComponent(configDir);
}

type ProviderInfo = Provider.Info;
type ModelInfo = Model.Info;
type IntegrationEditor = Parameters<
  Parameters<Plugin.Context["integration"]["transform"]>[0]
>[0];
type AuthRegistration = Parameters<IntegrationEditor["method"]["update"]>[0];

/** OpenCode keeps this share of the window free before it compacts. */
const COMPACTION_RESERVE_SHARE = 0.15;

/**
 * The `compactAt` option: compact a chat at about this many tokens instead
 * of near a 1M window. OpenCode compacts when the prompt reaches its input
 * limit minus a reserve, so the input limit is set to put that point here.
 * The context window stays the model's own; only smaller models are left
 * alone.
 */
export function compactionInputLimit(model: ClaudeModel, compactAt: unknown): number | undefined {
  if (typeof compactAt !== "number" || !Number.isFinite(compactAt) || compactAt <= 0) return undefined;
  const input = Math.round(compactAt / (1 - COMPACTION_RESERVE_SHARE));
  return input < model.contextWindow ? input : undefined;
}

export function buildProviderModel(model: ClaudeModel, id: string, compactAt?: unknown): ModelInfo {
  const input = compactionInputLimit(model, compactAt);
  return {
    id,
    modelID: id,
    providerID: PROVIDER_ID,
    name: model.name,
    capabilities: {
      tools: true,
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    // Effort travels in a header set by the model.request hook, so variants
    // carry no settings and OpenCode never sends reasoning_effort itself.
    variants: buildEffortVariants(model).map((effort) => ({ id: effort })),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: {
      context: model.contextWindow,
      // No input limit: OpenCode 2.0.19+ keeps 10% of the window free on
      // its own (compaction.buffer overrides it). A 900k input on top of
      // that compacted 1M chats at 81%, not the intended 90%.
      output: model.maxTokens,
      ...(input ? { input } : {}),
    },
  } as unknown as ModelInfo;
}

export function buildClaudeProviderModels(models: ClaudeModel[], compactAt?: unknown): ModelInfo[] {
  return models.map((model) => buildProviderModel(model, model.id, compactAt));
}

export function buildProviderInfo(baseURL: string): ProviderInfo {
  return {
    id: PROVIDER_ID,
    name: "Claude Code",
    // Availability follows the local CLI login, not an OpenCode credential:
    // the integration below is only the sign-in button.
    activation: "enabled",
    package: OPENAI_COMPATIBLE_PACKAGE,
    settings: {
      baseURL,
      provider: PROVIDER_ID,
      apiKey: "claude-code-proxy",
    },
  } as unknown as ProviderInfo;
}

// OpenCode starts a plugin instance per location and recycles idle ones, so
// setup runs many times a day; the account's model list rarely changes.
const MODEL_REFRESH_INTERVAL_MS = 10 * 60_000;

/**
 * Kept on globalThis, like the model list (models.ts) and the bridge runtime
 * (bridge-pool.ts). OpenCode gives each project folder its own copy of the
 * plugin's modules, and a new copy on each reload of a changed plugin; the
 * list is one for the server, so one refresh serves every folder:
 * - lastModelRefresh: a module-level time would start over in each copy,
 *   and each would ask the CLI again;
 * - providerReloads: each folder's provider reload, so a changed list
 *   reaches every folder, not only the one whose setup ran the refresh.
 * The version in the key changes with this shape.
 */
const MODEL_REFRESH_KEY = Symbol.for("@openchamber/opencode-claude/model-refresh/v2");

type ModelRefreshRuntime = {
  lastModelRefresh: number;
  providerReloads: Set<() => Promise<void>>;
};

export const modelRefreshRuntime: ModelRefreshRuntime = ((globalThis as Record<symbol, unknown>)[
  MODEL_REFRESH_KEY
] ??= { lastModelRefresh: 0, providerReloads: new Set() }) as ModelRefreshRuntime;

/** Reload the provider in every folder, so each one lists the new models. */
async function reloadProviderEverywhere(): Promise<void> {
  await Promise.all(
    [...modelRefreshRuntime.providerReloads].map((reload) =>
      reload().catch((err: unknown) =>
        log.warn(
          "[opencode-claude] could not reload the model list in a project folder",
          err instanceof Error ? err.message : err,
        ),
      ),
    ),
  );
}

export async function refreshModelCatalog(): Promise<void> {
  const now = Date.now();
  if (now - modelRefreshRuntime.lastModelRefresh < MODEL_REFRESH_INTERVAL_MS) return;
  modelRefreshRuntime.lastModelRefresh = now;
  try {
    const found = await listClaudeSupportedModels();
    if (!found?.rows.length) return;
    // A window the CLI could not answer this time keeps its last answer.
    const fromCli = modelsFromSdk(found.rows, found.windows, found.lastAnswers);
    const models = found.complete ? fromCli : modelsAfterIncompleteRefresh(fromCli);
    if (setDiscoveredModels(models)) {
      await reloadProviderEverywhere();
    }
  } catch (err) {
    log.warn(
      "[opencode-claude] could not read the model list from Claude Code",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Close a session's parked turn as soon as OpenCode stops the session. A turn
 * parked on tool calls has no open HTTP request, so an abort never reaches the
 * proxy otherwise and the claude process lingered until the TTL reaper.
 */
function watchSessionInterrupts(ctx: Plugin.Context): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const e = event as { type?: string; data?: { sessionID?: string } };
        if (
          (e.type === "session.execution.interrupted" || e.type === "session.execution.failed") &&
          e.data?.sessionID
        ) {
          const closed = closeSessionBridges(e.data.sessionID);
          if (closed) {
            log.info("[opencode-claude] closed the parked turn of a stopped session", {
              sessionID: e.data.sessionID,
            });
          }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        log.warn(
          "[opencode-claude] session event stream ended",
          err instanceof Error ? err.message : err,
        );
      }
    }
  })();
  return () => controller.abort();
}

/** Registration-time URL; model.request replaces it with the live one. */
function currentProxyBaseUrl(): string {
  try {
    return getClaudeProxyBaseUrl();
  } catch {
    return "http://127.0.0.1:0/v1";
  }
}

/**
 * OpenCode v2 plugin that provides Claude Code authentication and model access.
 *
 * The auth methods are chosen once at load from the CLI's presence: a host
 * with `claude` gets the sign-in relay, a host without it gets the install
 * action. `authorize` re-detects at run time, so the install action still
 * relays the sign-in right after a successful install.
 */
export const ClaudeCodePlugin: Plugin.Plugin = {
  id: "openchamber.claude-code",
  async setup(ctx) {
    // `{ "package": "...", "options": { "debug": true } }` in opencode.json
    // turns on the durable debug log without touching the server's env.
    if ((ctx.options as { debug?: unknown } | undefined)?.debug === true) {
      process.env.OPENCODE_CLAUDE_DEBUG ??= "1";
    }
    const directory = ctx.location.directory;
    // A project mapped to another Claude account in the `configDirs` option.
    const configDir = configDirForDirectory(
      (ctx.options as { configDirs?: unknown } | undefined)?.configDirs,
      directory,
    );
    // Bind first (ephemeral port by default) so the provider points at the
    // live listener for this process.
    try {
      await acquireProxy();
    } catch (err) {
      log.error(
        "[opencode-claude] proxy failed to start",
        err instanceof Error ? err.message : err,
      );
    }
    // The provider and its hook go in before anything slow: until then the
    // models are missing from OpenCode's catalog, and a session stepping
    // during a plugin reload fails with "Model unavailable".
    await ctx.provider.transform((providers) => {
      providers.add({
        info: buildProviderInfo(currentProxyBaseUrl()),
        models: buildClaudeProviderModels(
          getClaudeModels(),
          (ctx.options as { compactAt?: unknown } | undefined)?.compactAt,
        ),
      });
    });
    // A refresh from any folder reloads this one too (reloadProviderEverywhere).
    const reloadProvider = () => ctx.provider.reload();
    modelRefreshRuntime.providerReloads.add(reloadProvider);

    await ctx.session.hook(
      "model.request",
      async (request) => {
        // Start late if setup could not bind, and always point at the live
        // listener in case it rebound since the provider was registered.
        await startProxy();
        request.baseURL = getClaudeProxyBaseUrl();
        const selected = resolveClaudeModelSelection(
          request.model.id,
          request.model.variant,
        );
        request.headers[EFFORT_HEADER] = encodeClaudeModelSelection(selected);
        request.headers[KIND_HEADER] = request.kind;
        // The proxy runs in the long-lived OpenCode server process, whose cwd
        // is commonly the service account home, not the project attached to
        // this plugin instance. Carry the project directory on every request
        // so Claude Code loads the right project files, settings, and AGENTS.md.
        applyClaudeRequestContextHeaders(
          request.headers,
          directory,
          request.sessionID,
          configDir,
        );
      },
      { providerID: PROVIDER_ID },
    );

    const cliPresent = await probeCliPresence();
    // Refresh the catalog from the CLI in the background; the cached or
    // fallback list serves until it lands.
    if (cliPresent) {
      void refreshModelCatalog();
    }

    await ctx.integration.transform((integrations) => {
      for (const registration of buildAuthMethods(cliPresent, directory)) {
        integrations.method.update(registration);
      }
      integrations.update(PROVIDER_ID, (integration) => {
        integration.name = "Claude Code";
      });
    });

    const stopWatching = watchSessionInterrupts(ctx);
    // Claude Code already moved the session to its fallback model; move the
    // OpenCode session too so the picker and the next turns match it.
    setModelFallbackHandler((sessionID, modelId, variant) => {
      void ctx.session
        .switchModel({
          sessionID,
          model: { id: modelId, providerID: PROVIDER_ID, ...(variant ? { variant } : {}) },
        })
        .catch((err: unknown) =>
          log.warn(
            "[opencode-claude] could not switch the session to the fallback model",
            err instanceof Error ? err.message : err,
          ),
        );
    });

    return async () => {
      modelRefreshRuntime.providerReloads.delete(reloadProvider);
      stopWatching();
      await releaseProxy();
    };
  },
};

const INSTALL_METHOD_ID = "claude-cli-install";
const SIGN_IN_METHOD_ID = "claude-cli";

/**
 * OpenCode v2 stores whatever an OAuth method resolves with. The CLI keeps
 * its own login, so this is only a "signed in" marker: no token, nothing
 * Claude could use, and no refresh hook, so OpenCode never renews it.
 */
function cliSignInMarker(methodID: string) {
  return {
    type: "oauth" as const,
    methodID,
    refresh: "claude-cli",
    access: "claude-cli",
    expires: 0,
  } as any;
}

/**
 * The method list mirrors what the host actually needs: only the sign-in relay
 * when the CLI is there, only the install action when it is not. Each
 * `authorize` re-detects, so the install action rolls straight into the relay
 * after a successful install without a restart.
 */
export function buildAuthMethods(
  cliPresent: boolean,
  directory: string,
): AuthRegistration[] {
  if (!cliPresent) {
    const methodID = INSTALL_METHOD_ID;
    return [
      {
        integrationID: PROVIDER_ID,
        method: {
          id: methodID,
          type: "oauth",
          label: "Install Claude Code CLI and sign in",
        },
        /**
         * One-click path for hosts without the CLI: install the official
         * Claude Code CLI, then continue with the same sign-in relay. Users
         * who prefer the terminal get the install and auth commands in the
         * instructions instead.
         */
        async authorize() {
          const detection = await detectClaudeCode();
          if (detection.loggedIn) {
            return alreadySignedInResponse(methodID);
          }
          if (detection.status === "missing-cli") {
            const install = await installClaudeCli();
            if (!install.ok) {
              log.warn("[opencode-claude] Claude CLI install failed", {
                message: install.message,
              });
              return manualInstallResponse(install.message, methodID);
            }
          } else if (detection.status === "missing-sdk") {
            return manualInstallResponse(
              "The Claude Agent SDK is unavailable in this plugin install. Reinstall the plugin, then sign in again.",
              methodID,
            );
          }
          return relayOrFallback(
            await startClaudeCliLogin({ cwd: directory }),
            methodID,
          );
        },
      } as AuthRegistration,
    ];
  }

  const methodID = SIGN_IN_METHOD_ID;
  return [
    {
      integrationID: PROVIDER_ID,
      method: {
        id: methodID,
        type: "oauth",
        label: "Sign in with Claude Code CLI",
      },
      /**
       * The official CLI runs the whole flow; the host only relays it.
       * `claude auth login --claudeai` prints an authorize URL and then
       * waits on stdin for the code the Claude page shows, so the host UI
       * can open that URL and pass the pasted code straight through —
       * no separate terminal, and no OAuth implemented here.
       *
       * The only URL this method ever hands out is the CLI's own sign-in
       * page: any other link would open a tab that cannot finish the
       * sign-in, competing with the page the user actually has to use.
       */
      async authorize() {
        const detection = await detectClaudeCode();
        if (detection.loggedIn) {
          return alreadySignedInResponse(methodID);
        }
        return relayOrFallback(
          await startClaudeCliLogin({ cwd: directory }),
          methodID,
        );
      },
    } as AuthRegistration,
  ];
}

/**
 * CLI presence check for the method list, capped so a slow probe can never
 * block plugin load. Unknown results default to "present": the sign-in relay
 * re-detects and falls back to terminal instructions if the CLI is actually
 * missing.
 */
async function probeCliPresence(): Promise<boolean> {
  if (cliPresentAt && Date.now() - cliPresentAt < CLI_PRESENT_TTL_MS) return true;
  if (cliProbe) return cliProbe;
  const probe = (async () => {
    try {
      const detection = await Promise.race([
        detectClaudeCode(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      const present = detection ? detection.status !== "missing-cli" : true;
      // A missing CLI is not remembered, so a fresh install shows at once.
      if (detection && present) cliPresentAt = Date.now();
      return present;
    } catch {
      return true;
    }
  })();
  cliProbe = probe;
  void probe.finally(() => {
    if (cliProbe === probe) cliProbe = undefined;
  });
  return cliProbe;
}

/**
 * Every location sets the plugin up, all at once after a reload: they share
 * one probe in flight, and a CLI found present stays so for a while.
 */
const CLI_PRESENT_TTL_MS = 5 * 60_000;
let cliProbe: Promise<boolean> | undefined;
let cliPresentAt = 0;

function alreadySignedInResponse(methodID: string) {
  return {
    url: "",
    instructions:
      "Claude Code CLI is already signed in. Click Complete — or sign in from a terminal instead with `claude auth login --claudeai`.",
    mode: "auto" as const,
    callback: Promise.resolve(cliSignInMarker(methodID)),
  };
}

/**
 * The `code` method response: the host opens the CLI's authorize URL and the
 * user pastes the code from the Claude page back into the host, which writes
 * it to the CLI's stdin. Success is the CLI's own exit status.
 */
function relayOrFallback(
  launch: Awaited<ReturnType<typeof startClaudeCliLogin>>,
  methodID: string,
) {
  if (launch.state === "awaiting-code") {
    return {
      url: launch.url,
      instructions:
        "Sign in on the Claude page that opened and paste the code it shows here — or sign in from a terminal instead with `claude auth login --claudeai` and start this sign-in again. If the page did not open, use the sign-in link above.",
      mode: "code" as const,
      async callback(code: string) {
        const submitted = await submitClaudeCliLoginCode(code);
        if (submitted.ok) return cliSignInMarker(methodID);
        log.warn("[opencode-claude] Claude CLI login code rejected", {
          message: submitted.message,
        });
        // The CLI can store its grant and still exit oddly; trust its own
        // auth status over the exit code before failing.
        const verified = await detectClaudeCode();
        if (verified.loggedIn) return cliSignInMarker(methodID);
        throw new Error(
          submitted.message || "Claude Code CLI did not accept the sign-in code.",
        );
      },
    };
  }

  log.warn("[opencode-claude] Claude CLI login launch failed", {
    message: launch.message,
  });
  return manualInstallResponse(launch.message, methodID);
}

/**
 * No page to open: the user installs and signs in from a terminal (or via the
 * install action), and the callback watches `claude auth status` until the
 * grant lands. The message always names both the install and the auth command.
 */
export function manualInstallResponse(launchMessage: string, methodID: string) {
  return {
    url: "",
    instructions: `${launchMessage}
Install Claude Code, sign in, then click Complete:

  npm install -g @anthropic-ai/claude-code
  claude auth login --claudeai

Or use the “Install Claude Code CLI and sign in” action here instead.`,
    mode: "auto" as const,
    // v2 hands the host a promise, not a function: polling starts now.
    get callback() {
      return waitForCliLogin(methodID);
    },
  };
}

async function waitForCliLogin(methodID: string) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const detection = await detectClaudeCode();
    if (detection.loggedIn) return cliSignInMarker(methodID);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  log.warn("[opencode-claude] Claude CLI login timed out");
  throw new Error("Timed out waiting for `claude auth login` to finish.");
}

export default ClaudeCodePlugin;

export { detectClaudeCode } from "./detect.js";
export { getClaudeModels } from "./models.js";
export { startProxy, stopProxy, getClaudeProxyBaseUrl } from "./proxy.js";
