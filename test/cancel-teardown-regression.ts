/**
 * Regression: aborting a turn must terminate the Claude query.
 *
 * Two leak paths existed for aborted turns:
 * 1. Abort while the bridge is parked waiting for an OpenCode tool result —
 *    there is no in-flight proxy request, so the SSE cancel() teardown never
 *    runs and the Claude CLI child stayed alive until the next turn for the
 *    same conversation superseded it (Esc-Esc "Claude keeps running").
 *    Fix: OpenCode publishes `session.idle` when a runner finishes OR is
 *    interrupted; the plugin's event hook tears down any bridge still live
 *    for that session.
 * 2. handle.close() could not guarantee teardown: the SDK query handle
 *    exposes no usable child pid (killProcessTree was a no-op) and
 *    iterator.return() is unreliable when the stream is wedged. Fix: every
 *    query gets its own AbortController, aborted from close(), so the SDK
 *    transport runs its own SIGTERM→SIGKILL child cleanup.
 *
 * Covers: abort during active streaming, abort while parked on a tool call,
 * the corresponding query being closed, unrelated queries staying untouched,
 * and normal successful completion still cleaning up exactly once.
 *
 * Run: bun test/cancel-teardown-regression.ts
 */
import assert from "node:assert/strict";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FakeHandle = {
  stream: AsyncIterable<unknown>;
  interrupt: () => Promise<void>;
  close: () => void;
  getPid: () => number | null;
  closeCount: () => number;
};

function makeFakeHandle(
  body: (isDone: () => boolean) => AsyncIterable<unknown>,
): FakeHandle {
  let closes = 0;
  let done = false;
  const handle: FakeHandle = {
    stream: body(() => done),
    interrupt: async () => {},
    close: () => {
      closes += 1;
      done = true;
    },
    getPid: () => null,
    closeCount: () => closes,
  };
  return handle;
}

async function main() {
  const { startProxy, stopProxy, setClaudeQueryStarter } = await import(
    "../src/proxy.ts"
  );
  const {
    putBridge,
    findBridgeByConversation,
    clearAllBridges,
  } = await import("../src/bridge-pool.ts");
  const { ClaudeCodePlugin, teardownBridgesForSession } = await import(
    "../src/index.ts"
  );
  const { startClaudeQuery } = await import("../src/query.ts");

  // The plugin's event hook is what OpenCode calls with bus events; build the
  // real plugin so the wiring (event type + sessionID extraction) is covered,
  // not just the teardown helper.
  const hooks = await ClaudeCodePlugin({
    client: {} as never,
    project: {} as never,
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://127.0.0.1:1"),
    $: {} as never,
  });
  const fireIdle = (sessionID: string) =>
    hooks.event!({
      event: { type: "session.idle", properties: { sessionID } },
    } as never);

  // ---- 1. close() aborts the query's own AbortController ----
  {
    let seenOptions: Record<string, unknown> | null = null;
    const handle = await startClaudeQuery({
      prompt: "test",
      cwd: "/tmp",
      model: "sonnet",
      queryImpl: () => (input: { options: Record<string, unknown> }) => {
        seenOptions = input.options;
        return {
          [Symbol.asyncIterator]: async function* () {},
          interrupt: async () => {},
        };
      },
    });
    assert.ok(seenOptions, "query stub captured options");
    const ac = seenOptions!.abortController as AbortController | undefined;
    assert.ok(ac, "SDK query receives an AbortController");
    assert.equal(ac!.signal.aborted, false);
    handle.close();
    assert.equal(
      ac!.signal.aborted,
      true,
      "close() must abort the controller so the SDK kills its child",
    );
    handle.close(); // idempotent
    console.log("ok 1 — close() aborts the query AbortController");
  }

  const port = await startProxy();

  try {
    // ---- 2. Abort during active streaming tears the turn down ----
    {
      let fake: FakeHandle | null = null;
      setClaudeQueryStarter(async () => {
        fake = makeFakeHandle((isDone) =>
          (async function* () {
            yield { type: "system", subtype: "init", session_id: "mock-1" };
            yield {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "STREAMING" },
              },
            };
            while (!isDone()) {
              await sleep(25);
              yield { type: "system", subtype: "keepalive" };
            }
          })(),
        );
        return fake!;
      });

      const client = new AbortController();
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          signal: client.signal,
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "cancel-e2e-stream",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: true,
            messages: [{ role: "user", content: "stream forever" }],
          }),
        },
      );
      assert.equal(res.status, 200);
      const reader = res.body!.getReader();
      const first = await reader.read();
      assert.equal(first.done, false, "stream produced bytes");
      assert.ok(
        findBridgeByConversation("cancel-e2e-stream"),
        "bridge is live while streaming",
      );

      client.abort(); // OpenCode aborts the provider fetch on Esc-Esc
      let torn = false;
      for (let i = 0; i < 60 && !torn; i++) {
        await sleep(50);
        torn =
          findBridgeByConversation("cancel-e2e-stream") === undefined &&
          fake !== null &&
          fake.closeCount() >= 1;
      }
      assert.ok(torn, "mid-stream abort must delete the bridge and close it");
      console.log("ok 2 — abort during active streaming closes the query");
    }

    // ---- 3. Abort while parked on a tool call (no in-flight request) ----
    // ---- 4. Unrelated bridges are untouched ----
    {
      setClaudeQueryStarter(null);
      clearAllBridges();
      const parked = makeFakeHandle(async function* () {});
      let toolRejected: Error | null = null;
      putBridge({
        id: "bridge-parked",
        conversationKey: "ses_parked",
        handle: parked,
        pendingTools: new Map([
          [
            "call_1",
            {
              id: "call_1",
              name: "mcp__opencode__bash",
              arguments: "{}",
              resolve: () => {},
              reject: (err: Error) => {
                toolRejected = err;
              },
            },
          ],
        ]),
        seenAssistantUsageIds: new Set(),
        createdAt: Date.now(),
      });
      const unrelated = makeFakeHandle(async function* () {});
      putBridge({
        id: "bridge-other",
        conversationKey: "ses_other",
        handle: unrelated,
        pendingTools: new Map(),
        seenAssistantUsageIds: new Set(),
        createdAt: Date.now(),
      });
      // A meta bridge for the same session must go too.
      const titleBridge = makeFakeHandle(async function* () {});
      putBridge({
        id: "bridge-title",
        conversationKey: "title:ses_parked",
        handle: titleBridge,
        pendingTools: new Map(),
        seenAssistantUsageIds: new Set(),
        createdAt: Date.now(),
      });

      await fireIdle("ses_parked");

      assert.equal(parked.closeCount(), 1, "parked query must be closed");
      assert.ok(toolRejected, "parked tool call must be rejected");
      assert.match(toolRejected!.message, /Bridge closed/);
      assert.equal(findBridgeByConversation("ses_parked"), undefined);
      assert.equal(titleBridge.closeCount(), 1, "title bridge must be closed");
      assert.equal(findBridgeByConversation("title:ses_parked"), undefined);
      assert.equal(
        unrelated.closeCount(),
        0,
        "unrelated session bridge must not be touched",
      );
      assert.ok(
        findBridgeByConversation("ses_other"),
        "unrelated bridge stays parked",
      );
      // Non-idle and foreign events are ignored.
      await hooks.event!({
        event: { type: "session.updated", properties: { sessionID: "ses_other" } },
      } as never);
      await fireIdle("ses_missing");
      assert.equal(unrelated.closeCount(), 0);
      clearAllBridges();
      console.log("ok 3 — parked bridge torn down on session.idle");
      console.log("ok 4 — unrelated queries untouched");
    }

    // ---- 5. Normal completion still cleans up exactly once ----
    {
      let fake: FakeHandle | null = null;
      setClaudeQueryStarter(async () => {
        fake = makeFakeHandle(() =>
          (async function* () {
            yield { type: "system", subtype: "init", session_id: "mock-2" };
            yield {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "ALL_DONE" },
              },
            };
            yield { type: "result", is_error: false, usage: {} };
          })(),
        );
        return fake!;
      });
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "cancel-e2e-complete",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: false,
            messages: [{ role: "user", content: "say ALL_DONE" }],
          }),
        },
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.ok(JSON.stringify(body).includes("ALL_DONE"));
      // Bridge deleted by the turn's own finally; handle closed (the real
      // handle's close() is idempotent, so count calls loosely).
      let cleaned = false;
      for (let i = 0; i < 40 && !cleaned; i++) {
        await sleep(50);
        cleaned =
          findBridgeByConversation("cancel-e2e-complete") === undefined &&
          fake !== null &&
          fake.closeCount() >= 1;
      }
      assert.ok(cleaned, "normal completion deletes the bridge and closes it");
      const closesAfterTurn = fake!.closeCount();
      // The idle event that follows a normal turn must be a no-op.
      assert.deepEqual(teardownBridgesForSession("cancel-e2e-complete"), []);
      await fireIdle("cancel-e2e-complete");
      assert.equal(
        fake!.closeCount(),
        closesAfterTurn,
        "idle after a clean turn must not tear down anything",
      );
      console.log("ok 5 — normal completion cleans up, idle is a no-op");
    }
  } finally {
    setClaudeQueryStarter(null);
    clearAllBridges();
    await stopProxy();
  }

  console.log("ok — cancel teardown regression tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
