/**
 * Regression: a request over the API's size limit (the API's 413, almost
 * always the images and documents a transcript gathered) is told by the
 * refused call's HTTP status, `result.api_error_status`, and answered the
 * way OpenCode can recover from it, not as a 500 it cannot:
 * - a chat turn is a 400 context_length_exceeded: OpenCode compacts the
 *   chat, and the next turn starts a transcript without those images;
 * - a summary is a 413 that OpenCode reads as payload-too-large: it resends
 *   the summary as text without media. Not Anthropic's `request_too_large`
 *   code, which OpenCode reads as an overflow and would cut the history.
 *
 * On the simulators (test/simulators/): Claude Code refuses the call as CLI
 * 2.1.312 reports the API's 413 (`state.failures` / `state.summaryFailures`
 * `requestTooLarge`: the synthetic record with the general code
 * `invalid_request`, the error result with `api_error_status: 413`, the
 * SDK's throw; BEHAVIOR.md "Failures of a model call"); the OpenCode
 * simulator classifies the reply and recovers as OpenCode 2.0.32 does
 * (`failureOf`: a compaction after an overflow, the summary as text after a
 * 413); the kind the plugin read, from its journal.
 *
 * Run: bun test/request-too-large-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { failureOf, testPng } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("request-too-large");
  const { opencode, claude } = world;
  const cases = testCases();
  try {
    await opencode.startPlugin();

    await cases.run("a chat turn over the size limit is the overflow OpenCode compacts on; the step sent again answers", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "what is on it?", [{ mediaType: "image/png", data: testPng("SHOT-1"), name: "shot.png" }]);
      assert.ok((await opencode.turn(chat)).ok, "the first turn answers");
      await opencode.say(chat, "and this screenshot?", [{ mediaType: "image/png", data: testPng("SHOT-2"), name: "shot2.png" }]);
      claude.state.failures = ["requestTooLarge"];
      const queries = claude.queries.length;
      const retries = opencode.retries.length;
      const turn = await opencode.turn(chat);
      claude.state.failures = [];
      const first = turn.requests[0]!;
      assert.equal(first.status, 400, first.reply?.raw);
      const error = JSON.parse(first.reply!.raw!).error;
      assert.equal(error.code, "context_length_exceeded");
      assert.equal(error.type, "invalid_request_error");
      assert.match(error.message, /Request too large/, "the CLI's words reach the user");
      assert.equal(failureOf(first.reply!)?.kind, "context-overflow");
      assert.equal(opencode.retries.length, retries, "OpenCode does not send an overflow again");
      assert.equal(turn.compactions?.find((c) => c.status !== "skipped")?.status, "completed", "OpenCode compacted the chat");
      assert.ok(turn.ok, `the step sent again after the compaction answers: ${turn.requests.map((r) => r.status).join(",")}`);
      const after = claude.queries.slice(queries).filter((q) => q.kind === "chat").at(-1)!;
      assert.equal(after.params.resume, undefined, "the turn after the compaction starts a new transcript");
      assert.ok(world.journal().some((line) => /turn failed fast/.test(line) && /"kind":"context_overflow"/.test(line)), "the journal names the overflow");
    });

    await cases.run("a summary over the size limit is a 413 OpenCode resends as text without media", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "look", [{ mediaType: "image/png", data: testPng("SHOT-3"), name: "shot3.png" }]);
      assert.ok((await opencode.turn(chat)).ok);
      await opencode.say(chat, "more");
      assert.ok((await opencode.turn(chat)).ok);
      claude.state.summaryFailures = ["requestTooLarge"];
      const lines = world.journal().length;
      const done = await opencode.compact(chat);
      claude.state.summaryFailures = [];
      const first = done.requests[0]!;
      assert.equal(first.status, 413, first.reply?.raw);
      const raw = first.reply!.raw!;
      assert.equal(JSON.parse(raw).error.type, "invalid_request_error");
      assert.doesNotMatch(raw, /request_too_large/, "no words OpenCode reads as an overflow");
      assert.equal(failureOf(first.reply!)?.kind, "payload-too-large");
      assert.equal(done.requests.length, 2, "the summary, then the summary as text");
      const asText = done.requests[1]!.body!.messages as Array<Record<string, any>>;
      assert.ok(asText.every((m) => typeof m.content === "string" || m.content === null), "the second request has no media parts");
      assert.equal(done.status, "completed");
      // The kind comes from the status, the record's general code says nothing.
      const failed = world.journal().slice(lines).find((line) => /turn failed fast/.test(line));
      assert.equal(failed?.match(/"kind":"([a-z_]+)"/)?.[1], "request_too_large", `the journal names the summary's kind: ${failed}`);
    });

    await cases.run("the two failures are warnings: no error in the plugin's journal", () => {
      assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    });
  } finally {
    await world.dispose();
  }
  cases.done();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
