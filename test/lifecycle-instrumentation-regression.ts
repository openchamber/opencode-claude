import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const dataHome = mkdtempSync(join(homedir(), "opencode-claude-log-data-"));
const configHome = mkdtempSync(join(homedir(), "opencode-claude-log-config-"));
const previousDataHome = process.env.XDG_DATA_HOME;
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const previousRateLimitStore = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
const previousDebug = process.env.OPENCODE_CLAUDE_DEBUG;
process.env.XDG_DATA_HOME = dataHome;
process.env.CLAUDE_CONFIG_DIR = configHome;
process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(dataHome, "rate-limit.json");
process.env.OPENCODE_CLAUDE_DEBUG = "1";

const { setClaudeQueryStarter, startProxy, stopProxy } = await import("../src/proxy.ts");
const { log } = await import("../src/log.ts");
const sessionKey = `lifecycle-log-${randomUUID()}`;

setClaudeQueryStarter(async () => ({
  stream: (async function* () {
    yield { type: "system", subtype: "init", session_id: "lifecycle-log-session" };
    yield {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "instrumented" },
      },
    };
    yield { type: "result", subtype: "success", is_error: false, result: "done" };
  })(),
  interrupt: async () => {},
  close: () => {},
  getPid: () => null,
}));

const port = await startProxy();
try {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-claude-session": sessionKey,
    },
    body: JSON.stringify({
      model: "sonnet",
      stream: false,
      messages: [{ role: "user", content: "instrumentation request" }],
    }),
  });
  assert.equal(response.status, 200);
} finally {
  setClaudeQueryStarter(null);
  await stopProxy();
  const output = readFileSync(log.filePath(), "utf8");
  assert.match(output, /query start/);
  assert.match(output, /query acquired/);
  assert.match(output, /iterator next start/);
  assert.match(output, /iterator next finish/);
  assert.match(output, /first SDK event/);
  assert.match(output, /bridge close/);
  assert.doesNotMatch(output, /instrumentation request/);
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
  if (previousRateLimitStore === undefined) {
    delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
  } else {
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = previousRateLimitStore;
  }
  if (previousDebug === undefined) delete process.env.OPENCODE_CLAUDE_DEBUG;
  else process.env.OPENCODE_CLAUDE_DEBUG = previousDebug;
  rmSync(dataHome, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
}

console.log("lifecycle-instrumentation-regression: ok");
