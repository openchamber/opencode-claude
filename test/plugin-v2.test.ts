import { afterEach, expect, test } from "bun:test";
import type { Plugin } from "@opencode-ai/plugin";
import { DIRECTORY_HEADER, EFFORT_HEADER, SESSION_HEADER } from "../src/constants.ts";
import { decodeClaudeModelSelection } from "../src/model-selection.ts";
import { getClaudeModels } from "../src/models.ts";
import { getProxyPort, stopProxy } from "../src/proxy.ts";
import serverPlugin, { setupV2 } from "../src/server.ts";

afterEach(stopProxy);

test("V2 registers Claude catalog, CLI login, and request routing", async () => {
  expect(serverPlugin).toMatchObject({
    id: "opencode.provider.claude-code",
    setup: setupV2,
  });
  expect("server" in serverPlugin).toBeFalse();

  const provider: any = {
    id: "claude-code",
    name: "claude-code",
    activation: "auto",
    package: "",
  };
  const models = new Map<string, any>();
  let integration: any;
  let method: any;
  let requestHook: ((event: any) => Promise<void> | void) | undefined;

  const ctx = {
    catalog: {
      async transform(callback: (draft: any) => void) {
        callback({
          provider: {
            update(id: string, update: (draft: any) => void) {
              expect(id).toBe("claude-code");
              update(provider);
            },
          },
          model: {
            update(_providerID: string, id: string, update: (draft: any) => void) {
              const model = {
                id,
                modelID: id,
                providerID: "claude-code",
                name: id,
                capabilities: { tools: true, input: [], output: [] },
                variants: [],
                time: { released: 0 },
                cost: [],
                status: "active",
                enabled: true,
                limit: { context: 0, output: 0 },
              };
              update(model);
              models.set(id, model);
            },
          },
        });
        return { async dispose() {} };
      },
    },
    integration: {
      async transform(callback: (draft: any) => void) {
        callback({
          update(id: string, update: (draft: any) => void) {
            integration = { id, name: id };
            update(integration);
          },
          method: { update(input: any) { method = input; } },
        });
        return { async dispose() {} };
      },
    },
    session: {
      async get() {
        return { location: { directory: "C:\\work\\project" } };
      },
      async hook(name: string, callback: (event: any) => Promise<void> | void) {
        expect(name).toBe("http.request");
        requestHook = callback;
        return { async dispose() {} };
      },
    },
  } as unknown as Plugin.Context;

  const cleanup = await setupV2(ctx);

  expect(getProxyPort()).toBeNumber();
  expect(provider).toMatchObject({
    name: "Claude Code",
    integrationID: "claude-code",
    package: "@opencode-ai/ai/providers/openai-compatible",
    settings: { apiKey: "managed-by-claude-code-cli" },
  });
  expect(models.size).toBe(getClaudeModels().length);
  expect(models.get("sonnet")).toMatchObject({
    capabilities: { tools: true, input: ["text", "image", "pdf"] },
    variants: [
      { id: "low" },
      { id: "medium" },
      { id: "high" },
      { id: "xhigh" },
      { id: "max" },
    ],
  });
  expect(integration).toEqual({ id: "claude-code", name: "Claude Code" });
  expect(method).toMatchObject({
    integrationID: "claude-code",
    method: { id: "claude-cli", type: "oauth" },
  });
  expect(method.authorize).toBeFunction();
  expect(method.refresh).toBeFunction();

  const event = {
    sessionID: "session-123",
    agent: "build",
    model: { providerID: "claude-code", id: "sonnet", variant: "high" },
    request: new Request("https://unused.example/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "sonnet", messages: [] }),
      headers: { "content-type": "application/json" },
    }),
  };
  await requestHook!(event);

  expect(event.request.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/chat\/completions$/);
  expect(event.request.headers.get(SESSION_HEADER)).toBe("session-123");
  expect(event.request.headers.get(DIRECTORY_HEADER)).toBe("C:\\work\\project");
  expect(
    decodeClaudeModelSelection(event.request.headers.get(EFFORT_HEADER)),
  ).toEqual({ modelId: "sonnet", effort: "high" });

  await cleanup?.();
  expect(getProxyPort()).toBeNull();
});
