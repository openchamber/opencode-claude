/**
 * OpenCode Claude Auth Plugin
 *
 * Enables Claude Code (subscription) inside OpenCode via:
 * 1. Local OpenAI-compatible proxy backed by the Claude Agent SDK
 * 2. Authentication owned entirely by the local Claude Code CLI
 * 3. Native effort variants, session resume, tools, skills, and MCP
 *
 * Register in opencode.json:
 *   { "plugin": ["@openchamber/opencode-claude"] }
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  DEFAULT_MODEL_ID,
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  OPENAI_COMPATIBLE_NPM,
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
  buildConfigVariants,
  buildEffortVariants,
  getClaudeModels,
  type ClaudeModel,
} from "./models.js";
import {
  getClaudeProxyBaseUrl,
  getProxyPort,
  startProxy,
} from "./proxy.js";

function zeroCost() {
  return {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  };
}

export function applyClaudeRequestContextHeaders(
  headers: Record<string, string>,
  directory: string,
  sessionID?: string,
): void {
  headers[DIRECTORY_HEADER] = directory;
  if (sessionID) headers["x-opencode-claude-session"] = sessionID;
}

function buildProviderModel(
  model: ClaudeModel,
  id: string,
  baseURL: string,
): Record<string, unknown> {
  const variants = buildEffortVariants(model);
  const hasEffort = Object.values(variants).some(
    (v) => v && typeof v === "object" && "effort" in v,
  );
  return {
    id,
    providerID: PROVIDER_ID,
    api: {
      id,
      url: baseURL,
      npm: OPENAI_COMPATIBLE_NPM,
    },
    name: id === DEFAULT_MODEL_ID && model.id !== DEFAULT_MODEL_ID
      ? `Default (${model.name})`
      : model.name,
    capabilities: {
      temperature: true,
      // Runtime models expose reasoning so streams can carry thinking deltas.
      reasoning: hasEffort,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: true,
    },
    // OpenCode derives capabilities.input from modalities.input — include
    // "pdf" or PDFs are replaced with unsupported-modality errors.
    modalities: {
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    cost: zeroCost(),
    limit: {
      context: model.contextWindow,
      output: model.maxTokens,
    },
    status: "active",
    options: {
      includeUsage: true,
    },
    headers: {},
    release_date: "",
    variants,
  };
}

function buildConfigModelEntry(model: ClaudeModel): Record<string, unknown> {
  const variants = buildConfigVariants(model);
  return {
    name: model.name,
    // Keep config non-reasoning so OpenCode does not prepend generic
    // low/medium/high ahead of our explicit effort map (cursor pattern).
    reasoning: false,
    tool_call: true,
    // OpenCode config merge sets capabilities.input from modalities.input.
    // Missing "image"/"pdf" strips attachments before they reach the proxy.
    attachment: true,
    modalities: {
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    capabilities: {
      tools: true,
      input: ["text", "image", "pdf"],
      output: ["text"],
    },
    limit: {
      context: model.contextWindow,
      output: model.maxTokens,
    },
    options: {
      includeUsage: true,
    },
    variants,
  };
}

function buildClaudeProviderModels(
  models: ClaudeModel[],
): Record<string, unknown> {
  const baseURL = getClaudeProxyBaseUrl();
  const providerModels = Object.fromEntries(
    models.map((model) => [model.id, buildProviderModel(model, model.id, baseURL)]),
  );
  const defaultModel =
    models.find((m) => m.id === DEFAULT_MODEL_ID) || models[0];
  if (defaultModel && !(DEFAULT_MODEL_ID in providerModels)) {
    providerModels[DEFAULT_MODEL_ID] = buildProviderModel(
      defaultModel,
      DEFAULT_MODEL_ID,
      baseURL,
    );
  }
  return providerModels;
}

function ensureClaudeProviderConfig(
  config: Record<string, any>,
  models: ClaudeModel[],
): void {
  if (!config.provider || typeof config.provider !== "object") {
    config.provider = {};
  }
  const existing = config.provider[PROVIDER_ID] ?? {};
  const existingOptions =
    existing.options && typeof existing.options === "object"
      ? existing.options
      : {};
  const existingModels =
    existing.models && typeof existing.models === "object"
      ? existing.models
      : {};

  const port = getProxyPort();
  const baseURL = port ? `http://127.0.0.1:${port}/v1` : undefined;
  const seededModels = Object.fromEntries(
    models.map((model) => [model.id, buildConfigModelEntry(model)]),
  );
  const defaultModel =
    models.find((m) => m.id === DEFAULT_MODEL_ID) || models[0];
  if (defaultModel && !(DEFAULT_MODEL_ID in seededModels)) {
    seededModels[DEFAULT_MODEL_ID] = {
      ...buildConfigModelEntry(defaultModel),
      name: `Default (${defaultModel.name})`,
    };
  }

  config.provider[PROVIDER_ID] = {
    ...existing,
    name:
      typeof existing.name === "string" && existing.name.trim()
        ? existing.name
        : "Claude Code",
    npm: existing.npm ?? OPENAI_COMPATIBLE_NPM,
    options: {
      apiKey: "claude-code-proxy",
      includeUsage: true,
      ...existingOptions,
      // Live listener URL must win over any stale pinned baseURL in user config.
      ...(baseURL ? { baseURL } : {}),
    },
    // Seeded catalog first; user-declared model entries win.
    models: {
      ...seededModels,
      ...existingModels,
    },
  };
}

async function loadClaudeRuntime(
  provider?: { models?: Record<string, unknown> },
): Promise<{ port: number; providerModels: Record<string, unknown> } | undefined> {
  const port = await startProxy();

  const providerModels = buildClaudeProviderModels(getClaudeModels());
  if (provider) provider.models = providerModels;
  return { port, providerModels };
}

/**
 * OpenCode plugin that provides Claude Code authentication and model access.
 *
 * The auth methods are chosen once at load from the CLI's presence: a host
 * with `claude` gets the sign-in relay, a host without it gets the install
 * action. `authorize` re-detects at run time, so the install action still
 * relays the sign-in right after a successful install.
 */
export const ClaudeCodePlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  const cliPresent = await probeCliPresence();
  return {
    async config(config) {
      // Bind first (ephemeral port by default), then seed provider baseURL so
      // OpenCode's static config matches the live listener for this process.
      try {
        await startProxy();
      } catch (err) {
        log.error(
          "[opencode-claude] proxy failed to start during config",
          err instanceof Error ? err.message : err,
        );
      }

      ensureClaudeProviderConfig(
        config as Record<string, any>,
        getClaudeModels(),
      );
    },

    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      const messageModel = hookInput.message.model as {
        variant?: unknown;
      };
      const variant =
        typeof messageModel.variant === "string"
          ? messageModel.variant
          : undefined;
      const selected = resolveClaudeModelSelection(hookInput.model.id, variant);
      output.headers[EFFORT_HEADER] = encodeClaudeModelSelection(selected);
      // The proxy runs in the long-lived OpenCode server process, whose cwd is
      // commonly the service account home (for example /home/ubuntu), not the
      // project attached to this plugin instance. Carry the authoritative
      // PluginInput directory on every request so Claude Code loads the right
      // project files, settings, and AGENTS.md.
      applyClaudeRequestContextHeaders(
        output.headers,
        input.directory,
        hookInput.sessionID,
      );
    },

    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== PROVIDER_ID) return;
      delete output.options.reasoningEffort;
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        const runtime = await loadClaudeRuntime(provider);
        return (runtime?.providerModels ?? {}) as Record<string, any>;
      },
    },

    auth: {
      provider: PROVIDER_ID,
      methods: buildAuthMethods(cliPresent, input.directory),
    },
  };
};

/**
 * The method list mirrors what the host actually needs: only the sign-in relay
 * when the CLI is there, only the install action when it is not. Each
 * `authorize` re-detects, so the install action rolls straight into the relay
 * after a successful install without a restart.
 */
export function buildAuthMethods(cliPresent: boolean, directory: string) {
  if (!cliPresent) {
    return [
      {
        type: "oauth" as const,
        label: "Install Claude Code CLI and sign in",
        /**
         * One-click path for hosts without the CLI: install the official
         * Claude Code CLI, then continue with the same sign-in relay. Users
         * who prefer the terminal get the install and auth commands in the
         * instructions instead.
         */
        async authorize() {
          const detection = await detectClaudeCode();
          if (detection.loggedIn) {
            return alreadySignedInResponse();
          }
          if (detection.status === "missing-cli") {
            const install = await installClaudeCli();
            if (!install.ok) {
              log.warn("[opencode-claude] Claude CLI install failed", {
                message: install.message,
              });
              return manualInstallResponse(install.message);
            }
          } else if (detection.status === "missing-sdk") {
            return manualInstallResponse(
              "The Claude Agent SDK is unavailable in this plugin install. Reinstall the plugin, then sign in again.",
            );
          }
          return relayOrFallback(
            await startClaudeCliLogin({ cwd: directory }),
          );
        },
      },
    ];
  }

  return [
    {
      type: "oauth" as const,
      label: "Sign in with Claude Code CLI",
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
          return alreadySignedInResponse();
        }
        return relayOrFallback(await startClaudeCliLogin({ cwd: directory }));
      },
    },
  ];
}

/**
 * CLI presence check for the method list, capped so a slow probe can never
 * block plugin load. Unknown results default to "present": the sign-in relay
 * re-detects and falls back to terminal instructions if the CLI is actually
 * missing.
 */
async function probeCliPresence(): Promise<boolean> {
  try {
    const detection = await Promise.race([
      detectClaudeCode(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    return detection ? detection.status !== "missing-cli" : true;
  } catch {
    return true;
  }
}

function alreadySignedInResponse() {
  return {
    url: "",
    instructions:
      "Claude Code CLI is already signed in. Click Complete — or sign in from a terminal instead with `claude auth login --claudeai`.",
    method: "auto" as const,
    async callback() {
      // OpenCode's callback runtime stores credentials only when success
      // includes key or refresh. Claude CLI needs neither.
      return { type: "success" as const } as any;
    },
  };
}

/**
 * The `code` method response: the host opens the CLI's authorize URL and the
 * user pastes the code from the Claude page back into the host, which writes
 * it to the CLI's stdin. Success is the CLI's own exit status.
 */
function relayOrFallback(
  launch: Awaited<ReturnType<typeof startClaudeCliLogin>>,
) {
  if (launch.state === "awaiting-code") {
    return {
      url: launch.url,
      instructions:
        "Sign in on the Claude page that opened and paste the code it shows here — or sign in from a terminal instead with `claude auth login --claudeai` and start this sign-in again. If the page did not open, use the sign-in link above.",
      method: "code" as const,
      async callback(code: string) {
        const submitted = await submitClaudeCliLoginCode(code);
        if (submitted.ok) return { type: "success" as const } as any;
        log.warn("[opencode-claude] Claude CLI login code rejected", {
          message: submitted.message,
        });
        // The CLI can store its grant and still exit oddly; trust its own
        // auth status over the exit code before failing.
        const verified = await detectClaudeCode();
        if (verified.loggedIn) {
          return { type: "success" as const } as any;
        }
        return { type: "failed" as const };
      },
    };
  }

  log.warn("[opencode-claude] Claude CLI login launch failed", {
    message: launch.message,
  });
  return manualInstallResponse(launch.message);
}

/**
 * No page to open: the user installs and signs in from a terminal (or via the
 * install action), and the callback watches `claude auth status` until the
 * grant lands. The message always names both the install and the auth command.
 */
export function manualInstallResponse(launchMessage: string) {
  return {
    url: "",
    instructions: `${launchMessage}
Install Claude Code, sign in, then click Complete:

  npm install -g @anthropic-ai/claude-code
  claude auth login --claudeai

Or use the “Install Claude Code CLI and sign in” action here instead.`,
    method: "auto" as const,
    async callback() {
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const detection = await detectClaudeCode();
        if (detection.loggedIn) {
          return { type: "success" as const } as any;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      log.warn("[opencode-claude] Claude CLI login timed out");
      return { type: "failed" as const };
    },
  };
}

export default ClaudeCodePlugin;

export { detectClaudeCode } from "./detect.js";
export { getClaudeModels, CLAUDE_CODE_MODELS } from "./models.js";
export { startProxy, stopProxy, getClaudeProxyBaseUrl } from "./proxy.js";
