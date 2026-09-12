import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type CompletionResponse = {
  choices?: Array<{
    message?: { content?: unknown; tool_calls?: ToolCall[] };
  }>;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function getMcpToolHandler(servers: Record<string, unknown> | undefined): ToolHandler {
  const opencode = asRecord(servers?.opencode, "opencode MCP server");
  const instance = asRecord(opencode.instance, "opencode MCP instance");
  const registeredTools = asRecord(instance._registeredTools, "registered MCP tools");
  const tool = asRecord(registeredTools.get_secret, "get_secret MCP tool");
  const handler = tool.handler;
  if (typeof handler !== "function") {
    throw new Error("get_secret MCP tool has no callable handler");
  }
  return async (args) => handler(args);
}

function textEvent(text: string): unknown {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    },
  };
}

function initEvent(): unknown {
  return { type: "system", subtype: "init", session_id: "park-race-session" };
}

function resultEvent(): unknown {
  return { type: "result", subtype: "success", is_error: false, result: "done" };
}

const dataHome = mkdtempSync(join(homedir(), "opencode-claude-park-race-data-"));
const configHome = mkdtempSync(join(homedir(), "opencode-claude-park-race-config-"));
const rateLimitStore = join(dataHome, "rate-limit.json");
const previousDataHome = process.env.XDG_DATA_HOME;
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const previousRateLimitStore = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
process.env.XDG_DATA_HOME = dataHome;
process.env.CLAUDE_CONFIG_DIR = configHome;
process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = rateLimitStore;

const { setClaudeQueryStarter, startProxy, stopProxy } = await import("../src/proxy.ts");

const sessionKey = `persistent-park-race-${randomUUID()}`;
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

let rawNextCalls = 0;
let activeRawNext = 0;
let maxActiveRawNext = 0;
let resolveParkedNext: ((result: IteratorResult<unknown>) => void) | undefined;

async function trackNext(
  promise: Promise<IteratorResult<unknown>>,
): Promise<IteratorResult<unknown>> {
  activeRawNext++;
  maxActiveRawNext = Math.max(maxActiveRawNext, activeRawNext);
  return promise.finally(() => {
    activeRawNext--;
  });
}

setClaudeQueryStarter(async (params) => {
  const toolHandler = getMcpToolHandler(params.mcpServers);
  const rawIterator: AsyncIterator<unknown> & AsyncIterable<unknown> = {
    next() {
      rawNextCalls++;
      if (rawNextCalls === 1) {
        return trackNext(Promise.resolve({ done: false, value: initEvent() }));
      }
      if (rawNextCalls === 2) {
        const parked = new Promise<IteratorResult<unknown>>((resolve, reject) => {
          resolveParkedNext = resolve;
          void toolHandler({ label: "alpha" }).then(
            () => {
              const resolveNext = resolveParkedNext;
              resolveParkedNext = undefined;
              resolveNext?.({ done: false, value: textEvent("POST_TOOL_OK") });
            },
            reject,
          );
        });
        return trackNext(parked);
      }
      if (rawNextCalls === 3) {
        return trackNext(Promise.resolve({ done: false, value: resultEvent() }));
      }
      return trackNext(Promise.resolve({ done: true, value: undefined as never }));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  return {
    stream: rawIterator,
    interrupt: async () => {},
    close: () => {},
    getPid: () => null,
  };
});

const port = await startProxy();
const post = async (messages: Array<Record<string, unknown>>): Promise<Response> =>
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
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as CompletionResponse;
  const toolCall = firstBody.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("first response did not contain a tool call");
  assert.equal(toolCall.function.name, "get_secret");

  const second = await post([
    { role: "user", content: "Call get_secret for alpha." },
    { role: "assistant", tool_calls: [toolCall] },
    { role: "tool", tool_call_id: toolCall.id, content: "SECRET_TOOL_VALUE" },
  ]);
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as CompletionResponse;
  const content = String(secondBody.choices?.[0]?.message?.content ?? "");
  assert.equal(
    content.match(/POST_TOOL_OK/g)?.length ?? 0,
    1,
    "the pending post-tool event must be delivered exactly once",
  );
  assert.equal(
    maxActiveRawNext,
    1,
    "MCP park/resume must not call the raw iterator concurrently",
  );
  assert.equal(rawNextCalls, 3, "resume must consume the held event before the result");
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
  rmSync(dataHome, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
}

console.log("persistent-park-race-regression: ok");
