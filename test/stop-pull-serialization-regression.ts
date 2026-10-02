/**
 * Regression: stop()'s settle drain and the response consumer share one
 * serialized pull queue on the underlying SDK iterator.
 *
 * Stock 1.3.0 issued a second raw next() from stop()'s drain while the
 * consumer's next() was still pending: six rapid cancel+resume cycles showed
 * 21 overlapping raw pulls (max concurrency 2). The drain must queue behind
 * the consumer, each caller must receive its own distinct event exactly
 * once, a pull queued after the stream ended must resolve done without a raw
 * pull, and a rejected pull must not wedge the queue.
 *
 * Run: bun test/stop-pull-serialization-regression.ts
 */
process.env.OPENCODE_CLAUDE_STOP_GRACE_MS = "300";
import { withGracefulStop } from "../src/query.ts";
import { assert } from "./helpers.ts";

function countingIterator() {
  const state = {
    active: 0,
    maxActive: 0,
    pulls: 0,
    pending: [] as Array<{ resolve: (result: IteratorResult<unknown>) => void }>,
  };
  const inner: AsyncIterableIterator<unknown> = {
    next() {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      state.pulls += 1;
      return new Promise<IteratorResult<unknown>>((resolve) => {
        state.pending.push({ resolve });
      }).then((value) => {
        state.active -= 1;
        return value;
      });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { state, inner };
}

function handleOver(inner: AsyncIterableIterator<unknown>, log: string[]) {
  return withGracefulStop({
    stream: inner,
    interrupt: () => {
      log.push("interrupt");
      return Promise.resolve();
    },
    close: () => log.push("close"),
    getPid: () => null,
  });
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function takePending(state: ReturnType<typeof countingIterator>["state"], what: string) {
  const [pending] = state.pending.splice(0);
  assert.ok(pending, `${what} is waiting on a raw pull`);
  return pending;
}

async function main() {
  // A stop() drain must never overlap the consumer's in-flight raw pull.
  {
    const { state, inner } = countingIterator();
    const handle = handleOver(inner, []);
    const pumping = handle.stream[Symbol.asyncIterator]().next();
    const stopping = handle.stop(300);
    await tick();
    await tick();
    // Only the consumer's pull may be outstanding at this point.
    assert.equal(state.pulls, 1, `drain jumped the queue (pulls=${state.pulls})`);
    takePending(state, "consumer pull").resolve({ done: false, value: { type: "result" } });
    // The drain's queued pull now starts and pends; the grace ends stop().
    await Promise.all([pumping, stopping]);
    assert.equal(
      state.maxActive,
      1,
      `stop() drain overlapped the consumer pull (maxActive=${state.maxActive}, pulls=${state.pulls})`,
    );
  }

  // Each queued caller receives its own distinct event, observed exactly once.
  {
    const { state, inner } = countingIterator();
    const handle = handleOver(inner, []);
    const seen: unknown[] = [];
    handle.onEvent((event) => seen.push(event));
    const first = handle.stream[Symbol.asyncIterator]().next();
    const stopping = handle.stop(3000);
    await tick();
    await tick();
    takePending(state, "consumer pull").resolve({ done: false, value: { type: "text", n: 1 } });
    await tick();
    await tick();
    takePending(state, "drain pull").resolve({ done: false, value: { type: "result", n: 2 } });
    const [firstResult] = await Promise.all([first, stopping]);
    assert.deepEqual(firstResult, { done: false, value: { type: "text", n: 1 } });
    assert.deepEqual(seen, [
      { type: "text", n: 1 },
      { type: "result", n: 2 },
    ]);
    assert.equal(state.pulls, 2, `each caller must pull its own event (pulls=${state.pulls})`);
    assert.equal(state.maxActive, 1);
  }

  // A pull queued after the stream ended resolves done without a raw pull.
  {
    const { state, inner } = countingIterator();
    const handle = handleOver(inner, []);
    const it = handle.stream[Symbol.asyncIterator]();
    const ending = it.next();
    await tick();
    takePending(state, "consumer pull").resolve({ done: true, value: undefined });
    assert.deepEqual(await ending, { done: true, value: undefined });
    assert.deepEqual(await it.next(), { done: true, value: undefined });
    assert.equal(state.pulls, 1, `pull after done issued another raw pull (pulls=${state.pulls})`);
  }

  // A rejected pull fails its caller and ends the stream; a queued pull
  // resolves done without issuing another raw pull.
  {
    let calls = 0;
    const inner: AsyncIterableIterator<unknown> = {
      next() {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("boom"))
          : Promise.resolve({ done: true, value: undefined });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const handle = handleOver(inner, []);
    const it = handle.stream[Symbol.asyncIterator]();
    const failing = it.next();
    const queued = it.next();
    await assert.rejects(failing, /boom/);
    assert.deepEqual(await queued, { done: true, value: undefined });
    assert.equal(calls, 1, `pull after a rejection issued another raw pull (calls=${calls})`);
  }

  console.log("stop-pull-serialization-regression: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
