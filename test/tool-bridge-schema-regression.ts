/**
 * Regression: the OpenCode tool bridge must list every tool, including tools
 * with object-typed parameters (edit, write, todowrite, question...). A
 * z.record() field broke tools/list for ALL tools when the plugin's zod was
 * newer than the zod bundled in the Agent SDK (#12).
 *
 * Run: bun test/tool-bridge-schema-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-bridge-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");

  const { startProxy, stopProxy, setClaudeQueryStarter } = await import(
    "../src/proxy.ts"
  );
  const port = await startProxy();
  try {
    let seen: Record<string, unknown> | null = null;
    setClaudeQueryStarter(async (params) => {
      seen = params as unknown as Record<string, unknown>;
      return {
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "bridge-sess" };
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "OK" },
            },
          };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      };
    });

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": "bridge-schema",
      },
      body: JSON.stringify({
        model: "sonnet",
        stream: false,
        tools: [
          {
            type: "function",
            function: {
              name: "bash",
              description: "Run a command",
              parameters: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
              },
            },
          },
          {
            type: "function",
            function: {
              name: "question",
              description: "Ask the user",
              parameters: {
                type: "object",
                properties: { options: { type: "object" } },
              },
            },
          },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(seen, "query starter params captured");

    const server = (seen!.mcpServers as Record<string, any>)?.opencode;
    const handlers =
      server?.instance?.server?._requestHandlers ??
      server?.instance?._requestHandlers;
    const list = handlers?.get?.("tools/list");
    assert.equal(typeof list, "function", "bridge exposes tools/list");
    const listed = await list({ method: "tools/list", params: {} }, {});
    const names = (listed.tools as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual(names.sort(), ["bash", "question"]);

    const question = listed.tools.find(
      (t: { name: string }) => t.name === "question",
    );
    assert.equal(question.inputSchema.properties.options.type, "object");
  } finally {
    await stopProxy();
  }
  console.log("ok — tool bridge schema regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
