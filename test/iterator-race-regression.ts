import assert from "node:assert/strict";
import { SerializedAsyncIterator } from "../src/serialized-iterator.ts";

let resolveFirst: ((result: IteratorResult<string>) => void) | undefined;
let nextCalls = 0;
const rawIterator: AsyncIterator<string> = {
  next() {
    nextCalls++;
    if (nextCalls === 1) {
      return new Promise<IteratorResult<string>>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Promise.resolve({ value: "second", done: false });
  },
};

const iterator = new SerializedAsyncIterator(rawIterator);
const first = iterator.next();
const second = iterator.next();

assert.equal(first, second, "an in-flight next() must be shared across continuations");
assert.equal(nextCalls, 1, "a parked continuation must not call next() concurrently");

resolveFirst?.({ value: "first", done: false });
assert.deepEqual(await first, { value: "first", done: false });
const resumed = iterator.next();
assert.equal(
  resumed,
  first,
  "a settled result must remain available until the continuation consumes it",
);
assert.deepEqual(await resumed, { value: "first", done: false });
iterator.release(resumed);
assert.deepEqual(await iterator.next(), { value: "second", done: false });
assert.equal(nextCalls, 2, "the next event may be requested after the first settles");

console.log("iterator-race-regression: ok");
