/**
 * Regression: a turn's records go to the CLI one by one (prompt.ts
 * recordsOneByOne). The CLI joins records without a turn that wait in its
 * input together into one, under the last one's uuid (cli-contract-live.ts,
 * check 5.1), so a record without a turn that follows another goes only once
 * the CLI answered the one before with an empty result naming it. Each record
 * then keeps its name, and the next turn finds it. The question after a new
 * transcript's start goes at once (the CLI never joins a question). A CLI
 * that does not confirm in time does not hold the turn: the record goes after
 * the wait and the journal says so. A turn stopped while its tool runs ends
 * its input with the process: the message the user sends right after goes as
 * a turn of its own.
 *
 * On the simulators (test/simulators/): the Claude Code simulator confirms
 * every record without a turn by an empty result and joins the ones waiting
 * in its input together (BEHAVIOR.md "The input of a query", the default
 * `joinWaitingRecords`). The user's chats in OpenCode:
 * - a new chat whose first turn is three messages sent together: the record
 *   the transcript starts with and the first two messages are records
 *   without a turn in a row, each waiting for the one before (the CLI would
 *   join them), the third has the turn; the start record is blank and
 *   reaches the model as nothing;
 * - a chat Claude answered, then a turn another model answered, then two
 *   messages sent together: the missed part, one record without a turn, the
 *   first message another, the second with the turn;
 * - the next turn of that chat resumes after the turn's answer, nothing
 *   missed: every name was kept;
 * - a message the user sends while a tool runs reaches the turn at once (it
 *   is not held for a confirmation);
 * - a slow CLI (`claude.state.confirmMs`, a confirmation 1.5 s after the
 *   record): a new chat's question goes right after the start record; two
 *   records without a turn after another model's answer, the second sent
 *   after the plugin's wait; three such records: the first one's confirmation
 *   comes late, while the third waits for the second, and does not let it go
 *   (CLI 2.1.300 and 2.1.312 confirm a record late only under its own name);
 * - a turn stopped while its tool runs (`stopParked`): the real SDK closes the
 *   stopped query's input; the next message's turn.
 * What the CLI read: `claude.queries[i].input` (uuid, without a turn, when
 * read), what it wrote: `claude.records(name)`; the journal names the records
 * and says when a record was not confirmed in time.
 *
 * Run: bun test/records-one-by-one-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("records-one-by-one");
  const { opencode, claude } = world;
  const { FIRST_EPOCH, TRANSCRIPT_START_NAME, transcriptName, userRecordName } = await pluginModule("names");
  const notConfirmed = () => world.journal().filter((line) => line.includes("did not confirm a record without a turn"));
  /** When the plugin wrote a journal line, on the clock of a query's `input` (performance.now; the journal's is the wall clock). */
  const journalAt = (line: string) => Date.parse(line.slice(0, 24)) - (Date.now() - performance.now());
  /** Half the plugin's wait for a confirmation: a record held by the wait did not go at once. */
  const HELD_MS = 500;
  /** The records of a chat's transcript that the CLI wrote without a turn: uuid and content. */
  const withoutTurn = (name: string) => claude.records(name).filter((r) => r.queueTranscriptOnly).map((r) => [r.uuid, r.message?.content]);
  const cases = testCases();
  try {
    await opencode.startPlugin();

    await cases.run("a new chat, three messages sent together: the start record and the first two go without a turn, one by one", async () => {
      const chat = opencode.newChat();
      const name = transcriptName(chat, FIRST_EPOCH, 1);
      const a = await opencode.say(chat, "first");
      const b = await opencode.say(chat, "second");
      const c = await opencode.say(chat, "third");
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
      const query = claude.queries.at(-1)!;
      assert.deepEqual(
        query.input.map((i) => [i.uuid, i.noTurn]),
        [
          [TRANSCRIPT_START_NAME, true],
          [userRecordName(a, 1), true],
          [userRecordName(b, 1), true],
          [userRecordName(c, 1), false],
        ],
        "the CLI read four records, three without a turn",
      );
      assert.deepEqual(
        withoutTurn(name),
        [
          [TRANSCRIPT_START_NAME, " "],
          [userRecordName(a, 1), "first"],
          [userRecordName(b, 1), "second"],
        ],
        "each record without a turn written on its own, under its own name",
      );
      assert.equal(query.trigger, userRecordName(c, 1), "the turn is named after the last message");
      assert.deepEqual(query.view.split("\n"), ["first", "second", "third"], "the blank start record reaches the model as nothing");
      assert.ok(world.journal().some((line) => line.includes("turn records") && line.includes(`"conversationKey":"${chat}"`) && line.includes('"records":3') && line.includes('"withoutTurn":2')), "the journal names the turn's records");
    });

    await cases.run("a missed turn, then two messages sent together; the next turn finds every record by name", async () => {
      const chat = opencode.newChat();
      const name = transcriptName(chat, FIRST_EPOCH, 1);
      await opencode.say(chat, "q1");
      assert.ok((await opencode.turn(chat)).ok);
      await opencode.say(chat, "q2");
      const other = opencode.otherModelAnswer(chat, "another model's answer");
      const x = await opencode.say(chat, "x");
      const y = await opencode.say(chat, "y");
      assert.ok((await opencode.turn(chat)).ok);
      const query = claude.queries.at(-1)!;
      assert.equal(query.params.resume, name, "the chat's transcript goes on");
      assert.deepEqual(
        query.input.map((i) => [i.uuid, i.noTurn]),
        [
          [userRecordName(other.id, 1), true],
          [userRecordName(x, 1), true],
          [userRecordName(y, 1), false],
        ],
        "the missed part and the first message without a turn, the second with it",
      );
      const written = withoutTurn(name);
      assert.deepEqual(written.map(([uuid]) => uuid), [TRANSCRIPT_START_NAME, userRecordName(other.id, 1), userRecordName(x, 1)], "each written on its own");
      assert.match(JSON.stringify(written[1]![1]), /another model's answer/, "the missed part is its own record");
      assert.equal(written[2]![1], "x", "the first message is its own record");
      const answerOfY = claude.leafOf(name)!.uuid;
      await opencode.say(chat, "z");
      assert.ok((await opencode.turn(chat)).ok);
      const next = claude.queries.at(-1)!;
      assert.deepEqual([next.params.resume, next.params.resumeSessionAt], [name, answerOfY], "the next turn resumes after the turn's answer");
      assert.deepEqual(next.input.map((i) => [i.noTurn, i.content]), [[false, "z"]], "nothing missed, nothing sent again");
    });

    await cases.run("a message sent while a tool runs goes into the turn at once", async () => {
      const chat = opencode.newChat();
      const name = transcriptName(chat, FIRST_EPOCH, 1);
      await opencode.say(chat, "list files");
      claude.state.toolTurn = true;
      const turn = await opencode.turn(chat, { toolOutput: "a.txt", steer: "and count them" });
      assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
      const steer = opencode.session(chat).messages.find((m) => m.text === "and count them")!.id;
      const query = claude.queries.at(-1)!;
      assert.ok(query.input.some((i) => i.uuid === userRecordName(steer, 1) && !i.noTurn && i.priority === "next"), `the CLI read the message mid-turn: ${JSON.stringify(query.input.map((i) => [i.uuid, i.noTurn, i.priority]))}`);
      assert.ok(claude.records(name).some((r) => r.type === "attachment" && r.attachment?.source_uuid === userRecordName(steer, 1)), "the CLI took it into the turn");
    });

    await cases.run("every record without a turn was confirmed in time: none went after the wait", () => {
      assert.deepEqual(notConfirmed(), []);
    });

    await cases.run("a slow CLI: a new chat's question goes right after the start record, without waiting for its confirmation", async () => {
      const chat = opencode.newChat();
      const q = await opencode.say(chat, "Q-slow first");
      const journalBefore = notConfirmed().length;
      claude.state.confirmMs = { starting: 0, running: 1500 };
      try {
        const turn = await opencode.turn(chat);
        assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
      } finally {
        claude.state.confirmMs = undefined;
      }
      const query = claude.queries.at(-1)!;
      assert.deepEqual(query.input.map((i) => [i.uuid, i.noTurn]), [[TRANSCRIPT_START_NAME, true], [userRecordName(q, 1), false]]);
      const [start, question] = query.input;
      assert.equal(start!.confirmedAt === undefined || start!.confirmedAt > question!.readAt, true, "the start was not confirmed when the question went");
      assert.ok(question!.readAt - start!.readAt < 500, `the question went at once: ${Math.round(question!.readAt - start!.readAt)} ms after the start`);
      assert.equal(notConfirmed().length, journalBefore, "nothing waited for a confirmation");
    });

    await cases.run("a slow CLI: a record without a turn not confirmed in time, the next goes after the wait, the turn answers, the journal says so", async () => {
      const chat = opencode.newChat();
      const name = transcriptName(chat, FIRST_EPOCH, 1);
      await opencode.say(chat, "s1");
      assert.ok((await opencode.turn(chat)).ok);
      await opencode.say(chat, "s2");
      const other = opencode.otherModelAnswer(chat, "another model's answer, slow");
      const x = await opencode.say(chat, "sx");
      const y = await opencode.say(chat, "sy");
      const journalBefore = notConfirmed().length;
      claude.state.confirmMs = { starting: 0, running: 1500 };
      try {
        const turn = await opencode.turn(chat);
        assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
      } finally {
        claude.state.confirmMs = undefined;
      }
      const query = claude.queries.at(-1)!;
      assert.deepEqual(
        query.input.map((i) => [i.uuid, i.noTurn]),
        [
          [userRecordName(other.id, 1), true],
          [userRecordName(x, 1), true],
          [userRecordName(y, 1), false],
        ],
        "every record went",
      );
      const [missed, first] = query.input;
      // The wait by the plugin's own line, written when it gave up: under load the CLI reads the missed record late,
      // and the gap between the two reads falls short of the wait.
      const [gaveUp] = notConfirmed().slice(journalBefore);
      const waited = first!.readAt - missed!.readAt;
      assert.ok(gaveUp !== undefined && journalAt(gaveUp) <= first!.readAt + 5, `the next record went after the plugin's wait: ${gaveUp === undefined ? "no line" : `${Math.round(first!.readAt - journalAt(gaveUp))} ms after it gave up`}`);
      assert.ok(waited >= HELD_MS, `and not at once: ${Math.round(waited)} ms`);
      assert.ok(missed!.confirmedAt === undefined || missed!.confirmedAt > first!.readAt, `and before the confirmation: ${missed!.confirmedAt === undefined ? "none" : Math.round(missed!.confirmedAt - first!.readAt)} ms`);
      const lines = notConfirmed().slice(journalBefore);
      assert.ok(lines.length >= 1, "the journal says a record was not confirmed");
      assert.equal(query.trigger, userRecordName(y, 1), "the turn is named after the last message");
      assert.ok(query.view.includes("sx") && query.view.includes("sy") && query.view.includes("another model's answer, slow"), `Claude read every message: ${query.view}`);
      assert.ok(claude.records(name).some((r) => r.uuid === userRecordName(y, 1)), "the turn's record is in the transcript");
    });

    await cases.run("a slow CLI: a late confirmation confirms only its own record, the next still waits for the one before it", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "l1");
      assert.ok((await opencode.turn(chat)).ok);
      await opencode.say(chat, "l2");
      const other = opencode.otherModelAnswer(chat, "another model's answer, late");
      const x = await opencode.say(chat, "lx");
      const y = await opencode.say(chat, "ly");
      const z = await opencode.say(chat, "lz");
      const journalBefore = notConfirmed().length;
      claude.state.confirmMs = { starting: 0, running: 1500 };
      try {
        const turn = await opencode.turn(chat);
        assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
      } finally {
        claude.state.confirmMs = undefined;
      }
      const query = claude.queries.at(-1)!;
      assert.deepEqual(
        query.input.map((i) => [i.uuid, i.noTurn]),
        [
          [userRecordName(other.id, 1), true],
          [userRecordName(x, 1), true],
          [userRecordName(y, 1), true],
          [userRecordName(z, 1), false],
        ],
        "every record went",
      );
      const [missed, first, second] = query.input;
      // Each wait by the plugin's own line, as in the case before.
      const [gaveUpFirst, gaveUpSecond] = notConfirmed().slice(journalBefore);
      assert.ok(gaveUpFirst !== undefined && journalAt(gaveUpFirst) <= first!.readAt + 5, `the first message went after the plugin's wait: ${gaveUpFirst === undefined ? "no line" : `${Math.round(first!.readAt - journalAt(gaveUpFirst))} ms after it gave up`}`);
      assert.ok(first!.readAt - missed!.readAt >= HELD_MS, `and not at once: ${Math.round(first!.readAt - missed!.readAt)} ms`);
      assert.ok(missed!.confirmedAt !== undefined && missed!.confirmedAt > first!.readAt && missed!.confirmedAt < second!.readAt, `the missed part was confirmed late, while the second message waited: ${JSON.stringify([missed!.confirmedAt, first!.readAt, second!.readAt].map((t) => t === undefined ? t : Math.round(t - missed!.readAt)))}`);
      assert.ok(
        gaveUpSecond !== undefined && journalAt(gaveUpSecond) > first!.readAt && journalAt(gaveUpSecond) <= second!.readAt + 5 && second!.readAt - first!.readAt >= HELD_MS,
        `the second message still waited for the first one's own confirmation: ${Math.round(second!.readAt - first!.readAt)} ms`,
      );
      assert.ok(first!.confirmedAt === undefined || first!.confirmedAt > second!.readAt, "and went before it");
      assert.ok(notConfirmed().length - journalBefore >= 2, "the journal says so for both waits");
      assert.equal(query.trigger, userRecordName(z, 1), "the turn is named after the last message");
      assert.ok(["lx", "ly", "lz", "another model's answer, late"].every((text) => query.view.includes(text)), `Claude read every message: ${query.view}`);
    });

    await cases.run("a turn stopped while its tool runs, a message right after: it goes as a turn of its own", async () => {
      const chat = opencode.newChat();
      const name = transcriptName(chat, FIRST_EPOCH, 1);
      await opencode.say(chat, "Q-stop run the tool");
      claude.state.toolTurn = true;
      const stopped = await opencode.turn(chat, { stopParked: true });
      assert.ok(stopped.stopped, "the user stopped the turn while its tool ran");
      const stoppedQuery = claude.queries.at(-1)!;
      const after = await opencode.say(chat, "Q-stop after the stop");
      const next = await opencode.turn(chat);
      assert.ok(next.ok, `the next turn answered: ${next.requests.map((r) => r.status).join(",")}`);
      const query = claude.queries.at(-1)!;
      assert.notEqual(query, stoppedQuery, "a query of its own");
      assert.equal(query.trigger, userRecordName(after, 1), "the message has the turn");
      assert.ok(!stoppedQuery.input.some((i) => i.uuid === userRecordName(after, 1)), "not sent into the stopped turn's input");
      assert.ok(claude.records(name).some((r) => r.uuid === userRecordName(after, 1)), "its record is in the chat's transcript");
      assert.ok(query.view.includes("Q-stop after the stop"), "Claude read it");
    });

    await cases.run("no error in the plugin's journal", () => {
      assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), []);
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
