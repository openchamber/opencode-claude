/**
 * Regression: the `configDirs` option runs a project on another Claude
 * account. Claude Code keeps one login per CLAUDE_CONFIG_DIR; a mapped
 * project's turns run with that directory, resume sessions from it, and keep
 * their own plan check and rate limits, while other projects stay on the
 * server's default account.
 *
 * Run: bun test/config-dirs-regression.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const SESSION = "sess-work";

async function main() {
  const { configDirForDirectory } = await import("../src/config-dir.ts");
  const map = { "/src/work": "/cfg/work", "/src/work/client": "/cfg/client" };
  assert.equal(configDirForDirectory(map, "/src/work"), "/cfg/work");
  assert.equal(configDirForDirectory(map, "/src/work/app"), "/cfg/work");
  assert.equal(configDirForDirectory(map, "/src/work/client/app"), "/cfg/client", "deepest folder wins");
  assert.equal(configDirForDirectory(map, "/src/work-other"), undefined, "a sibling with the same prefix is not inside");
  assert.equal(configDirForDirectory(map, "/src/home"), undefined);
  assert.equal(configDirForDirectory({ "~/work": "~/.claude-work" }, join(homedir(), "work", "app")), join(homedir(), ".claude-work"));
  assert.equal(configDirForDirectory({ "/src/work": 42 }, "/src/work"), undefined);
  assert.equal(configDirForDirectory(undefined, "/src/work"), undefined);

  const defaultConfig = mkdtempSync(join(tmpdir(), "opencode-claude-cfg-default-"));
  const workConfig = mkdtempSync(join(tmpdir(), "opencode-claude-cfg-work-"));
  const cwd = mkdtempSync(join(tmpdir(), "opencode-claude-cfg-project-"));
  process.env.CLAUDE_CONFIG_DIR = defaultConfig;
  // The session exists only under the work account's config directory.
  mkdirSync(join(workConfig, "projects", "p"), { recursive: true });
  writeFileSync(join(workConfig, "projects", "p", `${SESSION}.jsonl`), '{"uuid":"leaf-1"}\n');

  const { port, proxy } = await startMockedProxy("config-dirs");
  const { setForeignSessionId } = await import("../src/session-store.ts");
  const { applyClaudeRequestContextHeaders } = await import("../src/index.ts");
  const { setAuthStatusProbe } = await import("../src/detect.ts");
  const { rateLimitGate, recordRateLimitErrorText } = await import("../src/rate-limit.ts");

  const send = (session: string, configDir?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    applyClaudeRequestContextHeaders(headers, cwd, session, configDir);
    return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
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
  };

  try {
    let seen: Record<string, any> = {};
    proxy.setClaudeQueryStarter(async (params) => {
      seen = params as unknown as Record<string, any>;
      return mockHandle(
        (async function* () {
          yield textDelta("ok");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      );
    });

    // Mapped project: its account's config dir, and its session resumes.
    setForeignSessionId("work-chat", SESSION, { cwd, leafUuid: "leaf-1" });
    let res = await send("work-chat", workConfig);
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(seen.env.CLAUDE_CONFIG_DIR, workConfig);
    assert.equal(seen.resume, SESSION);
    assert.doesNotMatch(String(seen.prompt), /<conversation_history>/);

    // Unmapped project: the server's default account, which has no such
    // session, so the history goes over as text.
    setForeignSessionId("home-chat", SESSION, { cwd, leafUuid: "leaf-1" });
    res = await send("home-chat");
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(seen.env.CLAUDE_CONFIG_DIR, defaultConfig);
    assert.equal(seen.resume, undefined);

    // One account's limit does not block the other.
    recordRateLimitErrorText("You've hit your session limit · resets 11pm (UTC)", workConfig);
    assert.equal(rateLimitGate(Date.now(), workConfig).blocked, true);
    assert.equal(rateLimitGate(Date.now()).blocked, false);

    // The plan check asks the mapped account's own login.
    const probed: Array<string | undefined> = [];
    setAuthStatusProbe((configDir) => {
      probed.push(configDir);
      return configDir === workConfig
        ? { loggedIn: true, detail: "api-key-only" }
        : { loggedIn: true, detail: "auth-status-oauth" };
    });
    res = await send("work-auth", workConfig);
    assert.equal(res.status, 401);
    await res.text();
    res = await send("home-auth");
    assert.equal(res.status, 200);
    await res.text();
    assert.deepEqual(probed, [workConfig, undefined]);
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — config dirs regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
