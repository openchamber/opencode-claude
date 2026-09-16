import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

type CompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

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
  return { type: "system", subtype: "init", session_id: "pump-session" };
}

function resultEvent(): unknown {
  return { type: "result", subtype: "success", is_error: false, result: "done" };
}

const dataHome = mkdtempSync(join(homedir(), "opencode-claude-pump-data-"));
const configHome = mkdtempSync(join(homedir(), "opencode-claude-pump-config-"));
const previousDataHome = process.env.XDG_DATA_HOME;
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const previousRateLimitStore = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
process.env.XDG_DATA_HOME = dataHome;
process.env.CLAUDE_CONFIG_DIR = configHome;
process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(dataHome, "rate-limit.json");

const { setClaudeQueryStarter, startProxy, stopProxy } = await import("../src/proxy.ts");
const { findBridgeByConversation } = await import("../src/bridge-pool.ts");

const sessionKey = `persistent-pump-${randomUUID()}`;
let rawNextCalls = 0;
let resolveFirstEvent: ((result: IteratorResult<unknown>) => void) | undefined;
let resolveFirstNextStarted: (() => void) | undefined;
const firstNextStarted = new Promise<void>((resolve) => {
  resolveFirstNextStarted = resolve;
});

setClaudeQueryStarter(async () => {
  const rawIterator: AsyncIterator<unknown> & AsyncIterable<unknown> = {
    next() {
      rawNextCalls++;
      if (rawNextCalls === 1) {
        return Promise.resolve({ done: false, value: initEvent() });
      }
      if (rawNextCalls === 2) {
        resolveFirstNextStarted?.();
        return new Promise<IteratorResult<unknown>>((resolve) => {
          resolveFirstEvent = resolve;
        });
      }
      if (rawNextCalls === 3) {
        return Promise.resolve({ done: false, value: resultEvent() });
      }
      if (rawNextCalls === 4) {
        return Promise.resolve({ done: false, value: textEvent("SECOND_ONLY") });
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
    close: () => {},
    getPid: () => null,
  };
});

const port = await startProxy();
const post = async (content: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-opencode-claude-session": sessionKey,
    },
    body: JSON.stringify({
      model: "sonnet",
      stream: false,
      messages: [{ role: "user", content }],
    }),
  });

try {
  const firstPromise = post("first request");
  await firstNextStarted;
  const bridge = findBridgeByConversation(sessionKey);
  if (!bridge?.continueStream) {
    throw new Error("persistent bridge was not created");
  }
  const secondPump = bridge.continueStream();
  const secondEventPromise = secondPump.next();
  resolveFirstEvent?.({ done: false, value: textEvent("FIRST_ONLY") });

  const first = await firstPromise;
  assert.equal(first.status, 200);

  const firstBody = (await first.json()) as CompletionResponse;
  const firstContent = String(firstBody.choices?.[0]?.message?.content ?? "");
  assert.match(firstContent, /FIRST_ONLY/);
  const secondEvent = await secondEventPromise;
  assert.equal(secondEvent.done, false);
  assert.doesNotMatch(
    JSON.stringify(secondEvent.value),
    /FIRST_ONLY/,
    "a second persistent pump must not receive the first pump's event",
  );
  assert.match(JSON.stringify(secondEvent.value), /SECOND_ONLY/);
  assert.equal(rawNextCalls, 4, "the second pump must begin after the first completes");
  const secondResult = await secondPump.next();
  assert.equal(secondResult.done, false);
  assert.match(JSON.stringify(secondResult.value), /result/);
  assert.equal(rawNextCalls, 5);
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

console.log("persistent-pump-concurrency-regression: ok");
