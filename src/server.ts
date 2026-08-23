import { Credential, Integration, Model, Plugin } from "@opencode-ai/plugin";
import {
  DIRECTORY_HEADER,
  EFFORT_HEADER,
  EFFORT_LEVELS,
  PROVIDER_ID,
  SESSION_HEADER,
} from "./constants.js";
import { detectClaudeCode } from "./detect.js";
import { buildAuthMethods } from "./index.js";
import {
  encodeClaudeModelSelection,
  resolveClaudeModelSelection,
} from "./model-selection.js";
import { getClaudeModels } from "./models.js";
import {
  getClaudeProxyBaseUrl,
  startProxy,
  stopProxy,
} from "./proxy.js";

const AUTH_METHOD_ID = "claude-cli";
const PROVIDER_PACKAGE = "@opencode-ai/ai/providers/openai-compatible";
const CONNECTION_MARKER = "managed-by-claude-code-cli";
const CONNECTION_TTL_MS = 365 * 24 * 60 * 60 * 1_000;

function connectionMarker() {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make(AUTH_METHOD_ID),
    access: CONNECTION_MARKER,
    refresh: CONNECTION_MARKER,
    expires: Date.now() + CONNECTION_TTL_MS,
  });
}

async function requireLoginSuccess(result: { type: string }) {
  if (result.type !== "success") {
    throw new Error("Claude Code CLI sign-in failed");
  }
  return connectionMarker();
}

async function authorizeWithClaudeCli() {
  const detection = await detectClaudeCode();
  const authorization = await buildAuthMethods(
    detection.status !== "missing-cli",
    process.cwd(),
  )[0]!.authorize();
  if (authorization.method === "code") {
    return {
      url: authorization.url,
      instructions: authorization.instructions,
      mode: "code" as const,
      callback: async (code: string) =>
        requireLoginSuccess(await authorization.callback(code)),
    };
  }
  return {
    url: authorization.url,
    instructions: authorization.instructions,
    mode: "auto" as const,
    callback: authorization.callback().then(requireLoginSuccess),
  };
}

export async function setupV2(ctx: Plugin.Context) {
  await startProxy();

  try {
    await ctx.catalog.transform((catalog) => {
      catalog.provider.update(PROVIDER_ID, (provider) => {
        if (provider.name === PROVIDER_ID) provider.name = "Claude Code";
        provider.package = PROVIDER_PACKAGE;
        provider.settings = {
          ...provider.settings,
          apiKey: CONNECTION_MARKER,
          baseURL: getClaudeProxyBaseUrl(),
        };
      });

      for (const definition of getClaudeModels()) {
        catalog.model.update(PROVIDER_ID, definition.id, (model) => {
          model.modelID = Model.ID.make(definition.id);
          model.name = definition.name;
          model.capabilities = {
            tools: true,
            input: ["text", "image", "pdf"],
            output: ["text"],
          };
          model.variants = EFFORT_LEVELS.map((id) => ({
            id: Model.VariantID.make(id),
          }));
          model.limit = {
            context: definition.contextWindow,
            output: definition.maxTokens,
          };
        });
      }
    });

    await ctx.integration.transform((integration) => {
      integration.update(PROVIDER_ID, (draft) => {
        draft.name = "Claude Code";
      });
      integration.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: AUTH_METHOD_ID,
          type: "oauth",
          label: "Sign in with Claude Code CLI",
        },
        authorize: authorizeWithClaudeCli,
        refresh: async (credential) => {
          if (!(await detectClaudeCode()).loggedIn) {
            throw new Error(
              "Claude Code CLI is not signed in. Run `claude auth login --claudeai`.",
            );
          }
          return { ...credential, expires: Date.now() + CONNECTION_TTL_MS };
        },
        label: () => "Claude Code CLI",
      });
    });

    await ctx.session.hook("http.request", async (event) => {
      if (event.model.providerID !== PROVIDER_ID) return;

      const session = await ctx.session.get({ sessionID: event.sessionID });
      const request = new Request(
        `${getClaudeProxyBaseUrl()}/chat/completions`,
        event.request,
      );
      request.headers.set(
        EFFORT_HEADER,
        encodeClaudeModelSelection(
          resolveClaudeModelSelection(event.model.id, event.model.variant),
        ),
      );
      request.headers.set(SESSION_HEADER, event.sessionID);
      request.headers.set(DIRECTORY_HEADER, session.location.directory);
      event.request = request;
    });
  } catch (error) {
    await stopProxy();
    throw error;
  }

  return stopProxy;
}

export default Plugin.define({
  id: "opencode.provider.claude-code",
  setup: setupV2,
});
