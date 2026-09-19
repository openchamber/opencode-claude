/**
 * Regression: a turn parked only on StructuredOutput is never resumed by
 * OpenCode (it treats the call as terminal), so the bridge must be reaped
 * instead of leaking its Claude Code process. Turns parked on regular tools
 * must stay parked.
 *
 * Run: bun test/structured-output-reap-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-reap-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  process.env.OPENCODE_CLAUDE_STRUCTURED_OUTPUT_REAP_MS = "200";

  const { startProxy, stopProxy, setClaudeQueryStarter } = await import(
    "../src/proxy.ts"
  );
  const port = await startProxy();

  // Mock SDK turn that calls one bridged tool and then waits for its result,
  // like the real CLI does. Reports whether the proxy closed it.
  async function parkOn(toolName: string, session: string) {
    let closed = false;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    setClaudeQueryStarter(async (params) => {
      const server = (params.mcpServers as Record<string, any>).opencode;
      const handlers =
        server.instance.server?._requestHandlers ??
        server.instance._requestHandlers;
      return {
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: `${session}-sess` };
          handlers
            .get("tools/call")(
              { method: "tools/call", params: { name: toolName, arguments: {} } },
              {},
            )
            .catch(() => {});
          await released;
        })(),
        interrupt: async () => {},
        close: () => {
          closed = true;
          release();
        },
        getPid: () => null,
      };
    });

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": session,
      },
      body: JSON.stringify({
        model: "sonnet",
        stream: false,
        tools: [
          {
            type: "function",
            function: {
              name: toolName,
              description: toolName,
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        messages: [{ role: "user", content: "go" }],
      }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      choices: Array<{ message: { tool_calls?: Array<{ function: { name: string } }> } }>;
    };
    assert.equal(json.choices[0].message.tool_calls?.[0]?.function.name, toolName);
    await sleep(600);
    return { closed: () => closed, release };
  }

  try {
    const structured = await parkOn("StructuredOutput", "reap-structured");
    assert.equal(structured.closed(), true, "StructuredOutput park is reaped");

    const regular = await parkOn("bash", "reap-regular");
    assert.equal(regular.closed(), false, "regular tool park is kept");
    regular.release();
  } finally {
    await stopProxy();
  }
  console.log("ok — StructuredOutput reap regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
