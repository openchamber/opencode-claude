import assert from "node:assert/strict";
import { ExclusivePumpGate } from "../src/serialized-iterator.ts";

const gate = new ExclusivePumpGate();
const releaseFirst = await gate.acquire();

let secondAcquired = false;
const secondLeasePromise = gate.acquire().then((release) => {
  secondAcquired = true;
  return release;
});

await Promise.resolve();
assert.equal(secondAcquired, false, "a second pump must wait for the first lease");

releaseFirst();
const releaseSecond = await secondLeasePromise;
assert.equal(secondAcquired, true, "the second pump must acquire after release");

let thirdAcquired = false;
const thirdLeasePromise = gate.acquire().then((release) => {
  thirdAcquired = true;
  return release;
});
await Promise.resolve();
assert.equal(thirdAcquired, false, "the third pump must wait for the second lease");

releaseSecond();
const releaseThird = await thirdLeasePromise;
assert.equal(thirdAcquired, true, "the third pump must acquire after release");

releaseThird();
releaseThird();
console.log("pump-gate-regression: ok");
