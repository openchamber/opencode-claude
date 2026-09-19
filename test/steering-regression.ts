/**
 * Regression: a user message sent while a bridged tool is running (OpenCode
 * puts it after the tool result in the resume request) must reach Claude
 * with that tool result instead of being dropped.
 *
 * Run: bun test/steering-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const { collectSteeringText } = await import("../src/steering.ts");
  assert.equal(collectSteeringText([{ role: "user", content: "hi" }]), "");
  assert.equal(
    collectSteeringText([
      { role: "user", content: "old" },
      { role: "tool", content: "r" },
    ]),
    "",
  );
  assert.equal(
    collectSteeringText([
      { role: "user", content: "old" },
      { role: "tool", content: "r" },
      { role: "user", content: [{ type: "text", text: "use port 8080" }] },
      { role: "user", content: "and skip tests" },
    ]),
    "use port 8080\n\nand skip tests",
  );

  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-steer-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");

  const { startProxy, stopProxy, setClaudeQueryStarter } = await import(
    "../src/proxy.ts"
  );
  const port = await startProxy();

  const bashTool = {
    type: "function",
    function: {
      name: "bash",
      description: "Run a command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
    },
  };
  const post = (session: string, messages: unknown[]) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": session,
      },
      body: JSON.stringify({ model: "sonnet", stream: false, tools: [bashTool], messages }),
    });

  // Mock SDK turn: call bash, record the tool result text Claude receives,
  // then finish the turn.
  async function run(session: string, afterResult: unknown[]) {
    let received: string | null = null;
    setClaudeQueryStarter(async (params) => {
      const server = (params.mcpServers as Record<string, any>).opencode;
      const handlers =
        server.instance.server?._requestHandlers ??
        server.instance._requestHandlers;
      return {
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: `${session}-sess` };
          const res = await handlers.get("tools/call")(
            { method: "tools/call", params: { name: "bash", arguments: { command: "sleep 40" } } },
            {},
          );
          received = res.content[0].text;
          // Like the real SDK, the tool result comes back as a user message
          // before the next assistant output (a pending next() consumes it).
          yield { type: "user", message: { role: "user", content: [] } };
          yield {
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "DONE" } },
          };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      };
    });

    const first = await post(session, [{ role: "user", content: "run it" }]);
    const firstJson = (await first.json()) as any;
    const call = firstJson.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, "bash");

    const resume = await post(session, [
      { role: "user", content: "run it" },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, content: "exit 0" },
      ...afterResult,
    ]);
    const resumeJson = (await resume.json()) as any;
    assert.match(String(resumeJson.choices[0].message.content), /DONE/);
    return received as string | null;
  }

  try {
    const steered = await run("steer-yes", [
      { role: "user", content: "Actually, the secret word is PINEAPPLE." },
    ]);
    assert.ok(steered, "tool result delivered");
    assert.ok(steered!.startsWith("exit 0"));
    assert.match(steered!, /<system-reminder>[\s\S]*PINEAPPLE[\s\S]*<\/system-reminder>/);

    const plain = await run("steer-no", []);
    assert.equal(plain, "exit 0");
  } finally {
    await stopProxy();
  }
  console.log("ok — steering regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
