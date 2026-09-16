import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dataHome = mkdtempSync(join(homedir(), "opencode-claude-data-"));
const claudeConfigDir = mkdtempSync(join(homedir(), "opencode-claude-config-"));
const previousDataHome = process.env.XDG_DATA_HOME;
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.XDG_DATA_HOME = dataHome;
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

const { clearForeignSessionId } = await import("../src/session-store.ts");
const {
  getClaudeProxyBaseUrl,
  setClaudeQueryStarter,
  startProxy,
  stopProxy,
} = await import("../src/proxy.ts");

const sessionKey = "persistent-query-regression";
const starts: Array<{ prompt: unknown; mcpServers: unknown }> = [];
const handles: unknown[] = [];
const receivedPrompts: unknown[] = [];

setClaudeQueryStarter(async (params) => {
  starts.push({ prompt: params.prompt, mcpServers: params.mcpServers });
  const input = params.prompt;
  const stream = (async function* (): AsyncGenerator<unknown, void, unknown> {
    if (typeof input === "string") {
      receivedPrompts.push(input);
      yield textEvent(input);
      yield resultEvent();
      return;
    }

    const iterator = input[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      receivedPrompts.push(next.value);
      yield textEvent("reply");
      yield resultEvent();
    }
  })();

  const handle = {
    stream,
    interrupt: async () => {},
    close: () => {},
    getPid: () => null,
  };
  handles.push(handle);
  return handle;
});

await startProxy();
try {
  const post = async (
    messages: Array<Record<string, unknown>>,
    tools?: Array<Record<string, unknown>>,
  ): Promise<Response> =>
    fetch(`${getClaudeProxyBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": sessionKey,
      },
      body: JSON.stringify({ model: "sonnet", stream: false, messages, tools }),
    });

  const tools = [
    {
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ];

  const first = await post([{ role: "user", content: "first" }], tools);
  assert.equal(first.status, 200);
  assert.equal(starts.length, 1);

  const second = await post([
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "second" },
  ], tools);
  assert.equal(second.status, 200);
  assert.equal(starts.length, 1, "later turns must reuse one SDK query");
  assert.ok(starts[0]?.mcpServers, "the first query must receive an MCP server");
  assert.equal(receivedPrompts.length, 2);
  assert.equal(
    (receivedPrompts[1] as { message?: { content?: unknown } }).message?.content,
    "second",
  );

  const summary = [
    "Here is the conversation so far:",
    "<conversation>old work</conversation>",
    "Here is the summary of the conversation before the <conversation> above:",
    "<prior-summary>compacted work</prior-summary>",
    "The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both.",
    "Output exactly the Markdown structure shown inside <template>",
  ].join("\n");
  const summaryResponse = await post([{ role: "user", content: summary }]);
  assert.equal(summaryResponse.status, 200);
  assert.equal(starts.length, 2);
  assert.equal(handles.length, 2);
  assert.notEqual(
    handles[1],
    handles[0],
    "a summary boundary must create a separate SDK Query object",
  );
  assert.equal(
    starts[1]?.mcpServers,
    undefined,
    "summary Query must not receive the normal-turn MCP server",
  );

  const continuation = await post([
    { role: "assistant", content: "compacted work" },
    { role: "user", content: "after compaction" },
  ], tools);
  assert.equal(continuation.status, 200);
  assert.equal(
    starts.length,
    3,
    "a summary boundary must retire the old persistent query",
  );
  assert.equal(handles.length, 3);
  assert.notEqual(
    handles[2],
    handles[0],
    "post-summary turns must not reuse the prior SDK Query object",
  );
  const firstMcpServer = (starts[0]?.mcpServers as { opencode?: unknown })?.opencode;
  const nextMcpServer = (starts[2]?.mcpServers as { opencode?: unknown })?.opencode;
  assert.ok(firstMcpServer, "the first normal Query must receive an MCP instance");
  assert.ok(nextMcpServer, "the post-summary Query must receive an MCP instance");
  assert.notEqual(
    nextMcpServer,
    firstMcpServer,
    "separate Query lifecycles must not reuse the same MCP server instance",
  );
  // The SDK does not expose its private transport; McpServer identity is the
  // public lifecycle boundary we can assert without reaching into internals.
} finally {
  setClaudeQueryStarter(null);
  await stopProxy();
  clearForeignSessionId(sessionKey);
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
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

function resultEvent(): unknown {
  return { type: "result", subtype: "success", is_error: false, result: "ok" };
}
