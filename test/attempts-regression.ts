/**
 * Regression: a message whose every attempt failed is refused, not moved to
 * a new transcript. Each failed attempt that reached the transcript took a
 * name (`u(message/attempt)`, names.ts); OpenCode sends a failed request up
 * to eleven times in one round of retries, and the user may retry the same
 * message after that. With all MAX_ATTEMPTS names taken the proxy answers
 * 400 with `x-should-retry: false`: OpenCode stops and shows the reason.
 * Before, the chat started a new transcript with the history as text,
 * which threw its prompt cache away and still failed the same way. The
 * chat's first message is no exception: its retries resume at the record
 * every transcript starts with (names.ts TRANSCRIPT_START_NAME). Edits of
 * the first message are new messages, not attempts.
 *
 * On the simulators (test/simulators/): the failures are Claude Code's
 * (`claude.state.failures`: an API error after the question's record), the
 * retries OpenCode's own (`turn`: up to ten retries of a failed request); the
 * names and the limit from the tree's `names` module (`pluginModule`); the
 * refusal read in the plugin's journal.
 *
 * Run: bun test/attempts-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("attempts");
  const { opencode, claude } = world;
  const w = {
    state: claude.state,
    queries: claude.queries,
    records: claude.records,
    journal: world.journal,
    newChat: opencode.newChat,
    say: opencode.say,
    turn: opencode.turn,
    session: opencode.session,
    undoBefore: opencode.undoBefore,
    dispose: world.dispose,
  };
  await opencode.startPlugin();
  const { MAX_ATTEMPTS, TRANSCRIPT_START_NAME } = await pluginModule("names");
  assert.equal(MAX_ATTEMPTS, 16);

  const chat = w.newChat();
  await w.say(chat, "q1");
  assert.ok((await w.turn(chat)).ok);
  const transcript = w.queries.at(-1)!.name;
  await w.say(chat, "q2");

  // One round of OpenCode's retries: eleven attempts, each an API error after the question's record.
  w.state.failures = Array.from({ length: 11 }, () => "api" as const);
  const first = await w.turn(chat);
  assert.ok(!first.ok);
  assert.equal(first.requests.length, 11, "OpenCode sent the request eleven times");
  assert.ok(first.requests.every((r) => r.status >= 500), "every attempt failed as a model error");

  // The user retries the same message: five more failures take names 12..16, the next request is refused.
  w.state.failures = Array.from({ length: 5 }, () => "api" as const);
  const journalBefore = w.journal().length;
  const queriesBefore = w.queries.length;
  const second = await w.turn(chat);
  assert.ok(!second.ok);
  assert.equal(second.requests.length, 6, "five attempts, then the refusal ends the retries");
  const refusal = second.requests.at(-1)!;
  assert.equal(refusal.status, 400);
  assert.equal(w.queries.length - queriesBefore, 5, "no Claude query for the refused attempt");
  assert.ok(w.journal().slice(journalBefore).some((line) => line.includes("every attempt of the message is taken; refusing it")));

  // All of it in the one transcript: no new transcript was started.
  const names = new Set(w.queries.filter((q) => q.kind === "chat").map((q) => q.name));
  assert.deepEqual([...names], [transcript], "every attempt ran on the chat's one transcript");
  const q2Records = w.records(transcript).filter((r) => r.type === "user" && r.message?.content?.[0]?.text === "q2" || r.message?.content === "q2");
  assert.equal(q2Records.length, MAX_ATTEMPTS, "one record of q2 per attempt name");

  // A new message goes on as usual, in the same transcript.
  await w.say(chat, "q3");
  const third = await w.turn(chat);
  assert.ok(third.ok);
  assert.equal(w.queries.at(-1)!.name, transcript);

  // The chat's first message: its retries resume at the record the transcript starts with, in
  // the one transcript, and the sixteenth attempt is the last, as for any message.
  const fresh = w.newChat();
  await w.say(fresh, "f1");
  w.state.failures = Array.from({ length: 11 }, () => "api" as const);
  const round = await w.turn(fresh);
  assert.ok(!round.ok);
  assert.equal(round.requests.length, 11);
  const freshTranscript = w.queries.at(-1)!.name;
  w.state.failures = Array.from({ length: 5 }, () => "api" as const);
  const retried = await w.turn(fresh);
  assert.ok(!retried.ok);
  assert.equal(retried.requests.length, 6, "five more attempts, then the refusal");
  assert.equal(retried.requests.at(-1)!.status, 400);
  const freshQueries = w.queries.filter((q) => q.kind === "chat" && q.name === freshTranscript);
  assert.equal(freshQueries.length, MAX_ATTEMPTS, "every attempt ran on the chat's one transcript");
  assert.ok(freshQueries.slice(1).every((q) => q.at === TRANSCRIPT_START_NAME), "every retry resumed at the transcript's start");
  const starts = w.records(freshTranscript).filter((r) => r.uuid === TRANSCRIPT_START_NAME);
  assert.equal(starts.length, 1, "the transcript starts with one record without a turn");
  assert.equal(starts[0]!.parentUuid, null);
  const f1Records = w.records(freshTranscript).filter((r) => r.type === "user" && (r.message?.content === "f1" || r.message?.content?.[0]?.text === "f1"));
  assert.equal(f1Records.length, MAX_ATTEMPTS, "one record of f1 per attempt name");
  // The first query of a new session writes the CLI's attachment records ahead of its question; a retry resumes
  // at the start, ahead of them.
  const recs = w.records(freshTranscript);
  const underStart = (record: { parentUuid?: string | null }): boolean => {
    const parent = recs.find((r) => r.uuid === record.parentUuid);
    if (!parent) return false;
    if (parent.uuid === TRANSCRIPT_START_NAME) return true;
    return parent.type === "attachment" && underStart(parent);
  };
  assert.ok(f1Records.every(underStart), "each attempt hangs under the start");
  // A new message of that chat goes on in the same transcript.
  await w.say(fresh, "f2");
  const after = await w.turn(fresh);
  assert.ok(after.ok);
  assert.equal(w.queries.at(-1)!.name, freshTranscript, "the transcript is continued");

  // Edits of the first message (a revert to the chat's start, a new first message) are new
  // messages, not attempts: after sixteen of them a first message that fails once is retried, not refused.
  const grown = w.newChat();
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await w.say(grown, `g${i}`);
    assert.ok((await w.turn(grown)).ok);
    w.undoBefore(grown, w.session(grown).messages[0]!.id);
  }
  await w.say(grown, "g-last");
  w.state.failures = ["api"];
  const onceFailed = await w.turn(grown);
  assert.ok(onceFailed.ok, `a first message that failed once is retried: ${onceFailed.requests.map((r) => r.status).join(",")}`);
  assert.ok(!onceFailed.requests.some((r) => r.status === 400), "no refusal for versions that were no attempts");

  await w.dispose();
  console.log("ok — attempts regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
