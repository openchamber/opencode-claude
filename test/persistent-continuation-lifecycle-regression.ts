import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type CompletionResponse = {
  choices?: Array<{
    message?: { tool_calls?: ToolCall[] };
  }>;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function getMcpToolHandler(servers: Record<string, unknown> | undefined): ToolHandler {
  const opencode = asRecord(servers?.opencode, "opencode MCP server");
  const instance = asRecord(opencode.instance, "opencode MCP instance");
  const registeredTools = asRecord(instance._registeredTools, "registered MCP tools");
  const tool = asRecord(registeredTools.get_secret, "get_secret MCP tool");
  const handler = tool.handler;
  if (typeof handler !== "function") throw new Error("get_secret MCP tool is not callable");
  return async (args) => handler(args);
}

const tools = [
  {
    type: "function",
    function: {
      name: "get_secret",
      description: "Return a secret code for a label",
      parameters: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
      },
    },
  },
];

function initEvent(): unknown {
  return { type: "system", subtype: "init", session_id: "lifecycle-session" };
}

function resultEvent(): unknown {
  return { type: "result", subtype: "success", is_error: false, result: "done" };
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]);
}

async function runPersistentContinuationTimeout(): Promise<void> {
  const sessionKey = `persistent-timeout-${randomUUID()}`;
  let closeCalled = false;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let rawNextCalls = 0;

  setClaudeQueryStarter(async (params) => {
    const toolHandler = getMcpToolHandler(params.mcpServers);
    const rawIterator: AsyncIterator<unknown> & AsyncIterable<unknown> = {
      next() {
        rawNextCalls++;
        if (rawNextCalls === 1) {
          return Promise.resolve({ done: false, value: initEvent() });
        }
        if (rawNextCalls === 2) {
          return new Promise<IteratorResult<unknown>>((_, reject) => {
            void toolHandler({ label: "alpha" }).then(
              () => {},
              reject,
            );
          });
        }
        return Promise.resolve({ done: false, value: resultEvent() });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return {
      stream: rawIterator,
      interrupt: async () => {},
      close: () => {
        closeCalled = true;
        resolveClosed?.();
      },
      getPid: () => null,
    };
  });

  const { findBridgeByConversation } = await import("../src/bridge-pool.ts");
  const port = await startProxy();
  const post = (messages: Array<Record<string, unknown>>) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": sessionKey,
      },
      body: JSON.stringify({ model: "sonnet", stream: false, messages, tools }),
    });

  try {
    const first = await post([{ role: "user", content: "Call get_secret for alpha." }]);
    const firstBody = (await first.json()) as CompletionResponse;
    const toolCall = firstBody.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error("first response did not contain a tool call");

    const second = await post([
      { role: "user", content: "Call get_secret for alpha." },
      { role: "assistant", tool_calls: [toolCall] },
      { role: "tool", tool_call_id: toolCall.id, content: "SECRET_TOOL_VALUE" },
    ]);
    assert.equal(second.status, 500);
    assert.match((await second.text()), /no output/i);
    await timeout(closed, 2_500, "persistent continuation did not close its SDK handle");
    assert.equal(closeCalled, true);
    assert.equal(findBridgeByConversation(sessionKey), undefined);
  } finally {
    await stopProxy();
  }
}

async function runPreContentCancellation(): Promise<void> {
  const sessionKey = `persistent-cancel-${randomUUID()}`;
  let resolveFirstNextStarted: (() => void) | undefined;
  const firstNextStarted = new Promise<void>((resolve) => {
    resolveFirstNextStarted = resolve;
  });
  let closeCalled = false;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  setClaudeQueryStarter(async () => {
    const rawIterator: AsyncIterator<unknown> & AsyncIterable<unknown> = {
      next() {
        resolveFirstNextStarted?.();
        return new Promise<IteratorResult<unknown>>(() => {});
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return {
      stream: rawIterator,
      interrupt: async () => {},
      close: () => {
        closeCalled = true;
        resolveClosed?.();
      },
      getPid: () => null,
    };
  });

  const port = await startProxy();
  const abort = new AbortController();
  const request = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-claude-session": sessionKey,
    },
    body: JSON.stringify({
      model: "sonnet",
      stream: true,
      messages: [{ role: "user", content: "wait" }],
    }),
    signal: abort.signal,
  });

  try {
    await firstNextStarted;
    abort.abort();
    await assert.rejects(request);
    await timeout(closed, 500, "pre-content cancellation did not close the SDK handle");
    assert.equal(closeCalled, true);
  } finally {
    await stopProxy();
  }
}

async function runResumedContinuationCancellation(): Promise<void> {
  const sessionKey = `persistent-resumed-cancel-${randomUUID()}`;
  let closeCalled = false;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let rawNextCalls = 0;

  setClaudeQueryStarter(async (params) => {
    const toolHandler = getMcpToolHandler(params.mcpServers);
    const rawIterator: AsyncIterator<unknown> & AsyncIterable<unknown> = {
      next() {
        rawNextCalls++;
        if (rawNextCalls === 1) {
          return Promise.resolve({ done: false, value: initEvent() });
        }
        if (rawNextCalls === 2) {
          return new Promise<IteratorResult<unknown>>((_, reject) => {
            void toolHandler({ label: "alpha" }).then(
              () => {},
              reject,
            );
          });
        }
        return new Promise<IteratorResult<unknown>>(() => {});
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return {
      stream: rawIterator,
      interrupt: async () => {},
      close: () => {
        closeCalled = true;
        resolveClosed?.();
      },
      getPid: () => null,
    };
  });

  const { findBridgeByConversation } = await import("../src/bridge-pool.ts");
  const port = await startProxy();
  const post = (messages: Array<Record<string, unknown>>, signal?: AbortSignal) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": sessionKey,
      },
      body: JSON.stringify({ model: "sonnet", stream: false, messages, tools }),
      signal,
    });

  try {
    const first = await post([{ role: "user", content: "Call get_secret for alpha." }]);
    const firstBody = (await first.json()) as CompletionResponse;
    const toolCall = firstBody.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error("first response did not contain a tool call");

    const abort = new AbortController();
    const resumed = post(
      [
        { role: "user", content: "Call get_secret for alpha." },
        { role: "assistant", tool_calls: [toolCall] },
        { role: "tool", tool_call_id: toolCall.id, content: "SECRET_TOOL_VALUE" },
      ],
      abort.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    await assert.rejects(resumed);
    await timeout(closed, 500, "resumed continuation did not close its SDK handle");
    assert.equal(closeCalled, true);
    assert.equal(findBridgeByConversation(sessionKey), undefined);
  } finally {
    await stopProxy();
  }
}

const dataHome = mkdtempSync(join(homedir(), "opencode-claude-lifecycle-data-"));
const configHome = mkdtempSync(join(homedir(), "opencode-claude-lifecycle-config-"));
const previousDataHome = process.env.XDG_DATA_HOME;
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const previousRateLimitStore = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
const previousStallEnv = process.env.OPENCODE_CLAUDE_TURN_STALL_MS;
process.env.XDG_DATA_HOME = dataHome;
process.env.CLAUDE_CONFIG_DIR = configHome;
process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(dataHome, "rate-limit.json");
process.env.OPENCODE_CLAUDE_TURN_STALL_MS = "1000";

const { setClaudeQueryStarter, startProxy, stopProxy } = await import("../src/proxy.ts");

try {
  await runPersistentContinuationTimeout();
  await runResumedContinuationCancellation();
  await runPreContentCancellation();
} finally {
  setClaudeQueryStarter(null);
  await stopProxy();
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  if (previousRateLimitStore === undefined) {
    delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
  } else {
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = previousRateLimitStore;
  }
  if (previousStallEnv === undefined) delete process.env.OPENCODE_CLAUDE_TURN_STALL_MS;
  else process.env.OPENCODE_CLAUDE_TURN_STALL_MS = previousStallEnv;
  rmSync(dataHome, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
}

console.log("persistent-continuation-lifecycle-regression: ok");
