/**
 * Regression for #6: a custom OpenCode agent prompt, instructions files, MCP
 * notes and the skills list must reach Claude (appended to the Claude Code
 * preset), while OpenCode's stock base prompt and <env> block stay out.
 *
 * Run: bun test/system-context-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_BLOCK = [
  "You are powered by the model named claude-sonnet. The exact model ID is claude-code/sonnet",
  "Here is some useful information about the environment you are running in:",
  "<env>",
  "  Working directory: /repo",
  "  Platform: linux",
  "</env>",
].join("\n");
const INSTRUCTIONS = "Instructions from: /repo/AGENTS.md\n# Rules\n- Run tests sequentially.";
const SKILLS = "<available_skills>\n  <skill><name>pdf</name></skill>\n</available_skills>";

async function main() {
  const { openCodeSystemContext } = await import("../src/system-context.ts");

  // Stock agent: base prompt + env dropped, user config kept.
  const stock = openCodeSystemContext([
    {
      role: "system",
      content: `You are OpenCode, the best coding agent on the planet.\n\nLong stock guidance...\n${ENV_BLOCK}\n${INSTRUCTIONS}\n\n${SKILLS}`,
    },
    { role: "user", content: "hi" },
  ]);
  assert.ok(!stock.includes("best coding agent"), "stock base prompt skipped");
  assert.ok(!stock.includes("Working directory"), "env block skipped");
  assert.ok(!stock.includes("# Agent role"));
  assert.match(stock, /Run tests sequentially/);
  assert.match(stock, /<name>pdf<\/name>/);

  // Custom agent: its prompt replaces the base prompt and must be forwarded.
  const custom = openCodeSystemContext([
    {
      role: "system",
      content: `You are a harsh reviewer. End every answer with a verdict.\n${ENV_BLOCK}\n${INSTRUCTIONS}`,
    },
  ]);
  assert.match(custom, /# Agent role[\s\S]*harsh reviewer/);
  assert.match(custom, /Run tests sequentially/);
  assert.ok(!custom.includes("Working directory"));

  assert.equal(openCodeSystemContext([{ role: "user", content: "hi" }]), "");

  // Through the proxy: appended to the preset, and switchable off.
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-sysctx-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  const { startProxy, stopProxy, setClaudeQueryStarter } = await import(
    "../src/proxy.ts"
  );
  const port = await startProxy();
  let seen: Record<string, any> | null = null;
  setClaudeQueryStarter(async (params) => {
    seen = params as unknown as Record<string, any>;
    return {
      stream: (async function* () {
        yield { type: "system", subtype: "init", session_id: "sysctx-sess" };
        yield { type: "result", is_error: false, usage: {} };
      })(),
      interrupt: async () => {},
      close: () => {},
      getPid: () => null,
    };
  });
  const send = async (session: string) => {
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
              name: "bash",
              description: "Run a command",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        messages: [
          {
            role: "system",
            content: `You are a harsh reviewer.\n${ENV_BLOCK}\n${INSTRUCTIONS}`,
          },
          { role: "user", content: "review this" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    return seen!.systemPrompt as { preset?: string; append?: string };
  };

  try {
    const on = await send("sysctx-on");
    assert.equal(on.preset, "claude_code");
    assert.match(on.append ?? "", /mcp__opencode__/);
    assert.match(on.append ?? "", /harsh reviewer/);
    assert.match(on.append ?? "", /Run tests sequentially/);

    process.env.OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT = "0";
    const off = await send("sysctx-off");
    assert.ok(!(off.append ?? "").includes("harsh reviewer"));
    assert.match(off.append ?? "", /mcp__opencode__/);
  } finally {
    delete process.env.OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT;
    await stopProxy();
  }
  console.log("ok — system context regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
