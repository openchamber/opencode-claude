/**
 * Regression: tearing a bridge down must not block the response path.
 *
 * `input.close()` tears the SDK stream down synchronously. Calling it inline
 * put multi-second latency on every turn, because each request paid to close
 * the previous turn's bridge before it could proceed. The close must still
 * happen — the stream leak stays fixed — but off the critical path.
 */
import assert from "node:assert/strict";

const { putBridge, deleteBridge, getBridge } = await import("../src/bridge-pool.ts");

type CloseLog = { inputClosed: boolean; handleClosed: boolean };

function makeBridge(
  id: string,
  conversationKey: string,
  log: CloseLog,
  handleCloseThrows = false,
) {
  return {
    id,
    conversationKey,
    handle: {
      close() {
        log.handleClosed = true;
        if (handleCloseThrows) throw new Error("close failed");
      },
    },
    pendingTools: new Map(),
    seenAssistantUsageIds: new Set<string>(),
    createdAt: Date.now(),
    input: {
      close() {
        log.inputClosed = true;
      },
    },
  } as unknown as Parameters<typeof putBridge>[0];
}

const nextMacrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

// deleteBridge: input.close() is deferred, everything else stays synchronous.
const deleted: CloseLog = { inputClosed: false, handleClosed: false };
putBridge(makeBridge("bridge-delete", "conv-delete", deleted));
deleteBridge("bridge-delete");

assert.equal(deleted.inputClosed, false, "input.close() must not run on the request path");
assert.equal(deleted.handleClosed, true, "handle.close() still runs synchronously");
assert.equal(getBridge("bridge-delete"), undefined, "bridge leaves the pool immediately");

await nextMacrotask();
assert.equal(deleted.inputClosed, true, "input.close() must still run, on the next tick");

// putBridge superseding an earlier turn for the same conversation defers too.
const superseded: CloseLog = { inputClosed: false, handleClosed: false };
putBridge(makeBridge("bridge-old", "conv-supersede", superseded));
putBridge(
  makeBridge("bridge-new", "conv-supersede", { inputClosed: false, handleClosed: false }),
);

assert.equal(superseded.inputClosed, false, "superseded input.close() must not run synchronously");
assert.equal(superseded.handleClosed, true, "superseded handle.close() still runs synchronously");

await nextMacrotask();
assert.equal(superseded.inputClosed, true, "superseded input.close() must still run");

const throwing: CloseLog = { inputClosed: false, handleClosed: false };
putBridge(makeBridge("bridge-throwing", "conv-throwing", throwing, true));
assert.doesNotThrow(
  () => deleteBridge("bridge-throwing"),
  "handle close failure must not abort bridge removal",
);
assert.equal(
  getBridge("bridge-throwing"),
  undefined,
  "bridge must leave the pool even when handle.close() throws",
);

console.log("bridge-teardown-regression: ok");
