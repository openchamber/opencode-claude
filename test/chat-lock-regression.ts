/**
 * The operations of one chat run one at a time across copies of the plugin
 * module: OpenCode loads a copy per location and a fresh copy on reload, and
 * two turn starts of one chat (two requests, each served by any copy) must
 * wait for each other. The queue lives in the process (bridgeRuntime), so a
 * second copy of the module queues on the same chat.
 *
 * Also: the runtime an older release left in the process (main 1.6.0, before
 * the queue existed; OpenCode reloads the upgraded plugin in the same server
 * process) gets the queue.
 *
 * On the simulators (test/simulators/): not a chat test. The release 1.6.0
 * (`releaseTree("v1.6.0")`) loads its `bridge-pool` first, which makes the
 * process's runtime as 1.6.0 does; then the module of the tree under test
 * twice (`pluginModule("bridge-pool")` and a fresh instance,
 * `pluginModule("bridge-pool", { copy })`).
 *
 * Run: bun test/chat-lock-regression.ts
 */
import assert from "node:assert/strict";
import { join } from "node:path";

import { testCases } from "./simulators/cases.ts";
import { pluginModule, releaseTree } from "./simulators/world.ts";

async function main() {
  const cases = testCases();

  // The release before the queue: its module makes the process's runtime.
  const older = await import(join(releaseTree("v1.6.0"), "src", "bridge-pool.ts"));
  assert.equal(older.bridgeRuntime.chatLocks, undefined, "1.6.0's runtime has no chat queue");
  const first = await pluginModule("bridge-pool");
  const second = await pluginModule("bridge-pool", { copy: "2" });

  await cases.run("the runtime 1.6.0 left gets the chat queue", () => {
    assert.equal(typeof first.acquireChatLock, "function", "bridge-pool keeps the chat queue");
    assert.notEqual(first.acquireChatLock, second.acquireChatLock, "two copies of the module");
    assert.equal(first.bridgeRuntime, older.bridgeRuntime, "the runtime 1.6.0 made");
    assert.equal(first.bridgeRuntime, second.bridgeRuntime, "one runtime in the process");
    assert.ok(first.bridgeRuntime.chatLocks instanceof Map, "the old runtime got the queue");
  });

  await cases.run("a chat's turn in one copy waits for the turn in the other; another chat does not", async () => {
    // A turn of ses_B holds the chat; a second request's turn, in the other copy, waits.
    const order: string[] = [];
    const releaseCopy = await first.acquireChatLock("ses_B");
    order.push("copy started");
    const firstMessage = second.acquireChatLock("ses_B").then((release: () => void) => {
      order.push("first message started");
      return release;
    });
    // Another chat does not wait.
    const other = await second.acquireChatLock("ses_C");
    order.push("other chat started");
    other();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ["copy started", "other chat started"], "the first message waits for the copy");
    order.push("copy done");
    releaseCopy();
    releaseCopy(); // idempotent
    const releaseMessage = await firstMessage;
    assert.deepEqual(order, ["copy started", "other chat started", "copy done", "first message started"]);
    releaseMessage();
    assert.equal(first.bridgeRuntime.chatLocks.size, 0, "nothing left queued");
  });

  cases.done();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
