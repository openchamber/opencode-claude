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
import {
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
  modelsFromSdk,
  setDiscoveredModels,
  type ClaudeModel,
  type SdkModelRow,
} from "./models.js";
import { listClaudeSupportedModels } from "./query.js";
import {
  getClaudeProxyBaseUrl,
  retainProxy,
  startProxy,
} from "./proxy.js";

export function applyClaudeRequestContextHeaders(
  headers: Record<string, string>,
  directory: string,
  sessionID?: string,
): void {
  headers[DIRECTORY_HEADER] = directory;
  if (sessionID) headers["x-opencode-claude-session"] = sessionID;
}

type ProviderInfo = Provider.Info;
type ModelInfo = Model.Info;
type IntegrationEditor = Parameters<
  Parameters<Plugin.Context["integration"]["transform"]>[0]
>[0];
type AuthRegistration = Parameters<IntegrationEditor["method"]["update"]>[0];

export function buildProviderModel(model: ClaudeModel, id: string): ModelInfo {
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
    limit: { context: model.contextWindow, output: model.maxTokens },
  } as unknown as ModelInfo;
}

export function buildClaudeProviderModels(models: ClaudeModel[]): ModelInfo[] {
  return models.map((model) => buildProviderModel(model, model.id));
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

async function refreshModelCatalog(reload: () => Promise<void>) {
  try {
    const rows = await listClaudeSupportedModels();
    if (!rows?.length) return;
    if (setDiscoveredModels(modelsFromSdk(rows as SdkModelRow[]))) {
      await reload();
    }
  } catch (err) {
    log.warn(
      "[opencode-claude] could not read the model list from Claude Code",
      err instanceof Error ? err.message : err,
    );
  }
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
    // Bind first (ephemeral port by default) so the provider points at the
    // live listener for this process.
    try {
      await startProxy();
    } catch (err) {
      log.error(
        "[opencode-claude] proxy failed to start",
        err instanceof Error ? err.message : err,
      );
    }
    const cliPresent = await probeCliPresence();
    // Refresh the catalog from the CLI in the background; the cached or
    // fallback list serves until it lands.
    if (cliPresent) {
      void refreshModelCatalog(() => ctx.provider.reload());
    }

    await ctx.provider.transform((providers) => {
      providers.add({
        info: buildProviderInfo(currentProxyBaseUrl()),
        models: buildClaudeProviderModels(getClaudeModels()),
      });
    });

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
        );
      },
      { providerID: PROVIDER_ID },
    );

    await ctx.integration.transform((integrations) => {
      for (const registration of buildAuthMethods(cliPresent, directory)) {
        integrations.method.update(registration);
      }
      integrations.update(PROVIDER_ID, (integration) => {
        integration.name = "Claude Code";
      });
    });

    // The proxy is shared by every location in the process; unloading this
    // one only stops it when no other location still holds it.
    return retainProxy();
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
