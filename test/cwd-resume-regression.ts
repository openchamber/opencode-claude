/**
 * Regression: a chat whose directory changed keeps resuming its Claude
 * session instead of falling back to a text transcript.
 *
 * The CLI stores a session under ~/.claude/projects/<slug of the cwd>/, but
 * `--resume <id>` finds it from any cwd. Checked live on CLI 2.1.224 and
 * 2.1.284: resuming from another directory loaded the full history and
 * appended to the original file. Transferring history as text there would
 * only lose tool-level context and the prompt cache.
 *
 * The new directory has a non-ASCII name: the header carrying it must
 * survive fetch's Latin-1 check and reach the CLI unchanged.
 *
 * Run: bun test/cwd-resume-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const SESSION = "sess-moved";

async function main() {
  const claudeConfig = mkdtempSync(join(tmpdir(), "opencode-claude-cwd-cfg-"));
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  const oldCwd = mkdtempSync(join(tmpdir(), "opencode-claude-cwd-old-"));
  const newCwd = mkdtempSync(join(tmpdir(), "opencode-claude-cwd-新目录-"));
  const oldSlug = oldCwd.replace(/[^a-zA-Z0-9]/g, "-");
  mkdirSync(join(claudeConfig, "projects", oldSlug), { recursive: true });
  writeFileSync(join(claudeConfig, "projects", oldSlug, `${SESSION}.jsonl`), '{"uuid":"leaf-1"}\n');

  const { port, proxy } = await startMockedProxy("cwd-resume");
  const { setForeignSessionId } = await import("../src/session-store.ts");
  const { applyClaudeRequestContextHeaders } = await import("../src/index.ts");
  try {
    setForeignSessionId("moved-chat", SESSION, { cwd: oldCwd, leafUuid: "leaf-1" });
    let seen: Record<string, unknown> = {};
    const forks: string[] = [];
    proxy.setClaudeSessionForker(async (id, at) => {
      forks.push(`${id}@${at}`);
      return "unexpected-fork";
    });
    proxy.setClaudeQueryStarter(async (params) => {
      seen = params as unknown as Record<string, unknown>;
      return mockHandle(
        (async function* () {
          yield textDelta("ok");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      );
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    applyClaudeRequestContextHeaders(headers, newCwd, "moved-chat");
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "sonnet",
        stream: false,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "answer" },
          { role: "user", content: "second" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(seen.cwd, newCwd);
    assert.equal(seen.resume, SESSION);
    assert.equal("resumeSessionAt" in seen, false);
    assert.deepEqual(forks, []);
    assert.doesNotMatch(String(seen.prompt), /<conversation_history>/);
  } finally {
    proxy.setClaudeQueryStarter(null);
    proxy.setClaudeSessionForker(null);
    await proxy.stopProxy();
  }
  console.log("ok — cwd resume regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
