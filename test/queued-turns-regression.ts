/**
 * Regression: user messages OpenCode queued while no Claude turn ran for them
 * arrive as consecutive user messages after the last assistant message. All
 * of them must reach Claude as the new turn's prompt, each a record of its
 * own (the last one starts the turn) — on a resumed transcript and with
 * history transfer (not duplicated in the transcript) — and the following
 * normal turn must find them all by name and resume after their answer. A
 * system update OpenCode adds after the question goes with the question's
 * record. (Ported from the fork's cf93c7e.)
 *
 * On the simulators (test/simulators/): the user queues messages while a
 * turn runs (`queue`: the prompt hook now, `deliver` after the turn), and
 * OpenCode's next request ends with them; a turn another model answered
 * (`otherModelAnswer`) leaves the chat with no Claude session, so its
 * history is transferred. A queued message may carry attachments, taken as
 * OpenCode takes them when it accepts the message. A system update is
 * OpenCode's `system` message after the question (`between`). What the
 * plugin sent is the query's input (`noTurn`: a record without a turn).
 * Each case is a chat of its own.
 *
 * Run: bun test/queued-turns-regression.ts
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("queued");
  const { opencode, claude } = world;
  const names = await pluginModule("names");
  const cases = testCases();
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
  /** The queued messages delivered after the running turn, then OpenCode's next turn; the query it started. */
  async function deliverAndTurn(chat: string, queued: string[]) {
    for (const id of queued) opencode.deliver(chat, id);
    const from = claude.queries.length;
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
    assert.equal(claude.queries.length - from, 1);
    const query = claude.queries[from]!;
    return { query, prompt: query.input.map((m) => contentText(m.content)).join("\n") };
  }

  try {
    await opencode.startPlugin();

    await cases.run("messages queued during a turn: a record each on the resumed transcript, the next turn resumes after their answer", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "hello");
      let release!: () => void;
      claude.state.hold = new Promise<void>((resolve) => (release = resolve));
      const running = opencode.turn(chat);
      const queued = [await opencode.queue(chat, "QUEUED-ONE"), await opencode.queue(chat, "QUEUED-TWO")];
      release();
      assert.ok((await running).ok);
      assert.ok(!JSON.stringify((await running).requests[0]!.body.messages).includes("QUEUED"), "queued messages wait for their turn");
      const first = claude.queries.at(-1)!;
      assert.equal(first.name, names.transcriptName(chat, names.FIRST_EPOCH, 1), "the chat's transcript is named after it");
      const resumed = await deliverAndTurn(chat, queued);
      assert.equal(resumed.query.params.resume, first.name, "queued turn resumes");
      // Each queued message is a record of its own; the last one starts the turn.
      assert.deepEqual(resumed.query.input.map((m) => [contentText(m.content), m.noTurn]), [["QUEUED-ONE", true], ["QUEUED-TWO", false]]);
      assert.deepEqual(resumed.query.input.map((m) => m.uuid), [names.userRecordName(queued[0]!, 1), names.userRecordName(queued[1]!, 1)], "both records are named after their messages");
      const records = claude.records(first.name).filter((r) => r.type === "user" && contentText(r.message?.content).includes("QUEUED-ONE"));
      assert.equal(records.length, 1, "written once in the transcript");
      // The end of the turn that answered both.
      const queuedAnswer = claude.leafOf(first.name)!.uuid;

      await opencode.say(chat, "NEXT");
      const next = await deliverAndTurn(chat, []);
      assert.equal(next.query.params.resume, first.name, "turn after queued messages resumes");
      assert.equal(next.prompt, "NEXT");
      assert.equal(next.query.input.length, 1, "both queued records are found by name: neither goes again");
      assert.equal(next.query.params.resumeSessionAt, queuedAnswer, "it resumes after the answer to both");
    });

    await cases.run("a system update after the question goes with the question's record", async () => {
      // A system message has no id of its own: a record of its own under the
      // question's name would be dropped by the CLI and the turn would never start.
      const chat = opencode.newChat();
      await opencode.say(chat, "hello");
      assert.ok((await opencode.turn(chat)).ok);
      const ask = await opencode.say(chat, "ASK");
      opencode.between(chat, "system", "RULES CHANGED");
      const { query } = await deliverAndTurn(chat, []);
      assert.equal(query.outcome, "answered", "the turn ran");
      assert.equal(query.input.length, 1);
      assert.equal(query.input[0]!.noTurn, false);
      assert.match(contentText(query.input[0]!.content), /ASK[\s\S]*RULES CHANGED/);
      assert.equal(query.input[0]!.uuid, names.userRecordName(ask, 1));
    });

    await cases.run("history transfer: the queued messages are the request, not history", async () => {
      // No Claude session for the chat yet.
      const chat = opencode.newChat();
      await opencode.say(chat, "EARLIER-ASK");
      const queued = [await opencode.queue(chat, "QUEUED-ONE"), await opencode.queue(chat, "QUEUED-TWO")];
      opencode.otherModelAnswer(chat, "EARLIER-ANSWER");
      const { query, prompt } = await deliverAndTurn(chat, queued);
      assert.equal(query.params.resume, undefined);
      assert.equal(query.params.sessionId, names.transcriptName(chat, names.FIRST_EPOCH, 1), "a new transcript named after the chat");
      // The history rides the first queued message's record, after the record the transcript starts with.
      assert.deepEqual(query.input.map((m) => m.noTurn), [true, true, false]);
      assert.equal(query.input[0]!.uuid, names.TRANSCRIPT_START_NAME);
      const [history, request] = contentText(query.input[1]!.content).split("</recent-context>");
      assert.ok(request !== undefined, `the history is transferred: ${prompt}`);
      assert.match(history!, /^The following is a serialized record of this conversation from its start/);
      assert.match(history!, /EARLIER-ASK[\s\S]*EARLIER-ANSWER/);
      assert.doesNotMatch(history!, /QUEUED/, "queued messages are not history");
      assert.equal(request, "\n\nQUEUED-ONE");
      assert.equal(contentText(query.input[2]!.content), "QUEUED-TWO");
      assert.equal(occurrences(prompt, "QUEUED-ONE"), 1);
      const records = claude.records(query.name).filter((r) => r.type === "user" && contentText(r.message?.content).includes("QUEUED-ONE"));
      assert.equal(records.length, 1, "written once in the transcript");
    });

    await cases.run("queued with an attachment: a record per message, the image in its own message's record", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "u1");
      assert.ok((await opencode.turn(chat)).ok);
      const png = testPng("queued");
      const queued = [
        await opencode.queue(chat, "first ask"),
        await opencode.queue(chat, "second ask", [{ mediaType: "image/png", data: png }]),
        await opencode.queue(chat, "third ask"),
      ];
      const { query } = await deliverAndTurn(chat, queued);
      const blocks = query.input.map((m) => (typeof m.content === "string" ? [m.content] : (m.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? b.type)));
      assert.deepEqual(blocks, [["first ask"], ["second ask", "image"], ["third ask"]], `every message in order, the image in place: ${JSON.stringify(blocks)}`);
      assert.deepEqual(query.input.map((m) => m.noTurn), [true, true, false]);
    });

    await cases.run("no error in the plugin's journal", () => {
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
