/**
 * Regression: the user switches a chat from Claude to another model and
 * back. The resumed Claude transcript never saw the other model's turns, so
 * they must reach Claude before the new prompt, one record without a turn in
 * OpenCode's form for a serialized part of a conversation — only those, not
 * the turns the transcript already holds — and the turn after must find it
 * by name and resume plainly.
 * - Another model's tool step goes in that record with the answer that made
 *   the call; a screenshot as an image block in its place.
 * - Claude's turn broke off after its question's record; another model
 *   answered it: only the answer goes.
 * - Claude's turn after another model's tool step failed and was retried:
 *   the retry (and a new question after a revert) resumes at the missed
 *   record and sends the question alone.
 * - A batch whose first message's record was written before the process died,
 *   answered by another model's tool step: the second message is not lost.
 *
 * On the simulators (test/simulators/): turns Claude answers, turns another
 * model answers (`otherModelAnswer`, a tool step with `toolCalls` and
 * `toolResults`: the prompt hook saw the questions, the plugin never served
 * the answers), then back to Claude; what the plugin gave Claude Code is the
 * query's `sessionId` / `resume` / `resumeSessionAt` and its input (`noTurn`:
 * a record without a turn). A broken-off turn: a model call that fails after
 * the CLI wrote the question (`permission`, not retried; `serverError`,
 * retried by OpenCode). A batch that broke off between its records: the
 * process dies after its records without a turn were confirmed
 * (`killedAfterRecords`), and the user stops the turn while OpenCode waits
 * to retry it (`opencode.state.sleep`). Each case is a chat of its own.
 *
 * Run: bun test/model-switch-regression.ts
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld, pluginModule, type World } from "./simulators/world.ts";

const SERIALIZED_LAST_REPLY =
  "The following is a serialized record of the latest part of this conversation, after your last reply in this session. It is part of this conversation's history; the assistant's replies in it are your own earlier replies.\n\n";

async function main() {
  const world = await createWorld("model-switch");
  const { opencode, claude } = world;
  const names = await pluginModule("names");
  const cases = testCases();
  /** The plugin's journal lines of one kind, with their fields. */
  const journalOf = (kind: string): Array<Record<string, any>> =>
    world
      .journal()
      .filter((line) => line.includes(kind))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
  /** A Claude turn in `chat`: the query it started, the text of its prompt (the record with the turn) and every record it sent. */
  const claudeTurn = async (chat: string, text: string) => {
    await opencode.say(chat, text);
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `${text}: the turn answered (${turn.requests.at(-1)?.status})`);
    const query = claude.queries.at(-1)!;
    return { query, records: query.input, prompt: query.input.filter((m) => !m.noTurn).map((m) => contentText(m.content)).join("\n") };
  };
  try {
    await opencode.startPlugin();

    await cases.run("the other model's turns reach Claude as one record without a turn, the turn after finds it by name", async () => {
      const chat = opencode.newChat();
      const first = await claudeTurn(chat, "CLAUDE-ASK-ONE");
      assert.equal(first.query.params.sessionId, names.transcriptName(chat, names.FIRST_EPOCH, 1), "the first turn names the transcript after the chat");
      assert.equal(first.query.params.resume, undefined);
      const second = await claudeTurn(chat, "CLAUDE-ASK-TWO");
      assert.equal(second.query.params.resume, first.query.name, "the second turn resumes the chat's Claude transcript");
      assert.equal(second.prompt, "CLAUDE-ASK-TWO", "a plain follow-up carries no history");

      // Two turns answered by another model, then back to Claude.
      for (const n of ["ONE", "TWO"]) {
        await opencode.say(chat, `OTHER-ASK-${n}`);
        opencode.otherModelAnswer(chat, `OTHER-ANSWER-${n}`);
      }
      const back = await claudeTurn(chat, "BACK-TO-CLAUDE");
      const NAME = first.query.name;
      assert.equal(back.query.params.resume, NAME, "the Claude session still resumes");
      // The messages the transcript never saw are one record without a turn,
      // in OpenCode's form for a serialized part of a conversation, named
      // after the last of them; the question is the turn.
      assert.deepEqual(back.records.map((r) => r.noTurn), [true, false]);
      assert.equal(
        contentText(back.records[0]!.content),
        SERIALIZED_LAST_REPLY + "<recent-context>\n[User]: OTHER-ASK-ONE\n\n[Assistant]: OTHER-ANSWER-ONE\n\n[User]: OTHER-ASK-TWO\n\n[Assistant]: OTHER-ANSWER-TWO\n</recent-context>",
        "the other model's turns reach Claude in order, the turns the transcript holds are not repeated",
      );
      assert.equal(contentText(back.records[1]!.content), "BACK-TO-CLAUDE");
      const uuids = back.records.map((r) => r.uuid);
      assert.ok(uuids.every(Boolean) && new Set(uuids).size === uuids.length, "every record is named");
      assert.equal(
        claude.records(NAME).filter((r) => r.queueTranscriptOnly && r.uuid !== names.TRANSCRIPT_START_NAME).length,
        1,
        "the missed record has no turn",
      );
      // What the model saw: the session's own turns once, then the missed ones.
      assert.equal(back.query.view.match(/CLAUDE-ASK-ONE/g)?.length, 1, "Claude saw its own first turn once");
      assert.equal(journalOf("resuming the chat's Claude transcript").at(-1)?.missed, 4, "the journal names the missed messages");
      const recordsLine = journalOf("[opencode-claude] turn records").at(-1);
      assert.deepEqual([recordsLine?.records, recordsLine?.withoutTurn, recordsLine?.missed], [2, 1, 4]);

      // The end of the turn after the missed record.
      const answerAfterMissed = claude.leafOf(NAME)?.uuid;
      const usageLines = journalOf("[opencode-claude] turn usage").length;
      const next = await claudeTurn(chat, "NEXT");
      assert.equal(next.query.params.resume, NAME);
      assert.equal(next.query.params.resumeSessionAt, answerAfterMissed, "the next turn resumes after the answer, the missed record found by name");
      assert.equal(journalOf("[opencode-claude] turn usage").length - usageLines, 1, "one usage line per turn, none for an empty result");
      assert.equal(next.prompt, "NEXT", "the turn after carries no history again");
      assert.equal(next.records.length, 1, "the missed records are found by name: nothing goes again");
    });

    await cases.run("another model's tool step goes in the missed record with the answer that made the call", async () => {
      const chat = opencode.newChat();
      await claudeTurn(chat, "T-ONE");
      // The call and its result go with the answer that made the call (a tool message has no id of its own).
      await opencode.say(chat, "OTHER-TOOL-ASK");
      opencode.otherModelAnswer(chat, "", {
        finish: "tool-calls",
        toolCalls: [{ id: "call_o", name: "read", input: { path: "a.txt" } }],
        toolResults: [{ id: "call_o", output: "A-CONTENT" }],
      });
      opencode.otherModelAnswer(chat, "OTHER-TOOL-ANSWER");
      const tool = await claudeTurn(chat, "BACK-AGAIN");
      assert.deepEqual(tool.records.map((r) => r.noTurn), [true, false]);
      const toolMissed = contentText(tool.records[0]!.content);
      assert.ok(
        toolMissed.endsWith('<recent-context>\n[User]: OTHER-TOOL-ASK\n\n[Assistant tool call]: read({"path":"a.txt"})\n[Tool result]: A-CONTENT\n\n[Assistant]: OTHER-TOOL-ANSWER\n</recent-context>'),
        toolMissed,
      );
      assert.equal(contentText(tool.records[1]!.content), "BACK-AGAIN");
    });

    await cases.run("a screenshot another model answered reaches Claude in the missed record as an image block", async () => {
      const chat = opencode.newChat();
      await claudeTurn(chat, "S-ONE");
      // The screenshot the user pasted with no text reaches Claude in the
      // missed record as itself, after its label, between the record's text blocks.
      const shot = testPng("SHOT-B");
      await opencode.say(chat, "", [{ mediaType: "image/png", data: shot }]);
      opencode.otherModelAnswer(chat, "OTHER-SAW-A-DOG");
      const imageTurn = await claudeTurn(chat, "WHAT-COLOUR");
      assert.deepEqual(imageTurn.records.map((r) => r.noTurn), [true, false]);
      const blocks = imageTurn.records[0]!.content as Array<Record<string, any>>;
      assert.ok(Array.isArray(blocks), `the missed record is blocks: ${JSON.stringify(blocks).slice(0, 300)}`);
      assert.deepEqual(
        blocks.map((b) => b.type),
        ["text", "image", "text"],
        `the missed record is text, the screenshot, text: ${JSON.stringify(blocks).slice(0, 300)}`,
      );
      assert.ok(blocks[0]!.text.endsWith("<recent-context>\n[User]: [Attached image/png]"), blocks[0]!.text);
      assert.deepEqual(blocks[1]!.source, { type: "base64", media_type: "image/png", data: shot });
      assert.equal(blocks[2]!.text, "[Assistant]: OTHER-SAW-A-DOG\n</recent-context>");
      assert.equal(contentText(imageTurn.records[1]!.content), "WHAT-COLOUR");
    });

    await cases.run("Claude's turn broke off after its question's record, another model answered it: only the answer goes", () => brokeOffThenOtherModel(world));
    await cases.run("a retry after another model's tool step resumes at the missed record and sends the question alone", () => retryAfterMissedRecord(world));
    await cases.run("a batch broken off between its records, answered by another model's tool step: the second message is not lost", () => batchBrokeOffThenOtherModelStep(world));

    await cases.run("no error in the plugin's journal but the failures the cases made", () => {
      // The two failures the cases made (403, then a 500 OpenCode retried) are the only errors.
      const errors = world.journal().filter((line) => /level=error/.test(line));
      assert.deepEqual(errors.filter((line) => !/permission to use this model|Internal server error/.test(line)), [], "no other error in the plugin's journal");
    });
  } finally {
    await world.dispose();
  }
  cases.done();
}

/**
 * Claude's turn broke off after the CLI wrote its question; another model
 * answered that question; back to Claude. The question's record is in the
 * transcript already: only the answer goes, as a record of its own, never
 * ahead of its question.
 */
async function brokeOffThenOtherModel(world: World) {
  const { opencode, claude } = world;
  const names = await pluginModule("names");
  const chat = opencode.newChat();
  await opencode.say(chat, "B-ONE");
  assert.ok((await opencode.turn(chat)).ok);
  const NAME = claude.queries.at(-1)!.name;

  // The CLI writes the question's record, then the model call fails (not retried).
  claude.state.failures = ["permission"];
  const two = await opencode.say(chat, "B-TWO");
  const failed = await opencode.turn(chat);
  claude.state.failures = [];
  assert.ok(!failed.ok && failed.requests.length === 1, `B-TWO failed, not retried: ${failed.requests.map((r) => r.status)}`);
  assert.ok(claude.records(NAME).some((r) => r.uuid === names.userRecordName(two, 1)), "the broken-off question's record was written");
  const brokenOffEnd = claude.leafOf(NAME)!.uuid!;

  opencode.otherModelAnswer(chat, "OTHER-B-TWO");
  await opencode.say(chat, "B-THREE");
  assert.ok((await opencode.turn(chat)).ok);
  const last = claude.queries.at(-1)!;
  assert.equal(last.params.resumeSessionAt, brokenOffEnd, "resumes at the end of the broken-off question's turn");
  assert.ok(claude.chainTo(NAME, brokenOffEnd).some((r) => r.uuid === names.userRecordName(two, 1)), "the point is on the broken-off question");
  assert.deepEqual(last.input.map((r) => r.noTurn), [true, false]);
  assert.ok(contentText(last.input[0]!.content).endsWith("<recent-context>\n[Assistant]: OTHER-B-TWO\n</recent-context>"), "only the answer goes");
  assert.equal(contentText(last.input[1]!.content), "B-THREE");
}

/**
 * Another model's turn ended on a tool step (the call and its result, no
 * answer after it); Claude's turn wrote the missed record and its question,
 * then failed, and OpenCode retried. The retry resumes at the missed record
 * and sends the question alone, as its next attempt: neither the missed part
 * nor the step's result goes again (the record holds the result: a tool
 * message has no id, the record is named after the call's answer). The same
 * after a revert of that question.
 */
async function retryAfterMissedRecord(world: World) {
  const { opencode, claude } = world;
  const names = await pluginModule("names");
  const chat = opencode.newChat();
  await opencode.say(chat, "R-ONE");
  assert.ok((await opencode.turn(chat)).ok);
  await opencode.say(chat, "R-TWO");
  opencode.otherModelAnswer(chat, "", {
    finish: "tool-calls",
    toolCalls: [{ id: "call_r", name: "read", input: { path: "a.txt" } }],
    toolResults: [{ id: "call_r", output: "A-CONTENT" }],
  });

  // The CLI writes the records, then the model call fails; OpenCode retries.
  claude.state.failures = ["serverError"];
  const three = await opencode.say(chat, "R-THREE");
  const from = claude.queries.length;
  const turn = await opencode.turn(chat);
  claude.state.failures = [];
  assert.deepEqual(turn.requests.map((r) => r.status), [500, 200], "the request failed, OpenCode's retry answered");
  const [failed, retried] = claude.queries.slice(from);
  assert.equal(failed!.outcome, "serverError");
  assert.deepEqual(failed!.input.map((r) => r.noTurn), [true, false]);
  assert.match(contentText(failed!.input[0]!.content), /\[User\]: R-TWO\n\n\[Assistant tool call\]: read\(\{"path":"a.txt"\}\)\n\[Tool result\]: A-CONTENT/);
  const missedRecord = failed!.input[0]!.uuid;
  assert.ok(missedRecord);

  assert.equal(retried!.params.resumeSessionAt, missedRecord, "the retry resumes at the missed record");
  assert.deepEqual(retried!.input.map((r) => contentText(r.content)), ["R-THREE"], "the missed part and the step's result do not go again");
  assert.equal(retried!.input[0]!.uuid, names.userRecordName(three, 2), "the question's next attempt");

  // A revert of R-THREE, a new question: the missed record still covers the step's result.
  opencode.undoBefore(chat, three);
  await opencode.say(chat, "R-FOUR");
  assert.ok((await opencode.turn(chat)).ok);
  const reverted = claude.queries.at(-1)!;
  assert.equal(reverted.params.resumeSessionAt, missedRecord);
  assert.deepEqual(reverted.input.map((r) => contentText(r.content)), ["R-FOUR"]);
}

/**
 * A batch of two messages: the CLI wrote the first one's record without a
 * turn and died before the second; another model answered the batch with a
 * tool step, and its results come to Claude with no parked turn. The step
 * is not Claude's to rebuild: it belongs to a turn the transcript never
 * saw, so the second message, the call and its result go as missed, and
 * the second message is not lost.
 */
async function batchBrokeOffThenOtherModelStep(world: World) {
  const { opencode, claude } = world;
  const names = await pluginModule("names");
  const chat = opencode.newChat();
  await opencode.say(chat, "C-ONE");
  assert.ok((await opencode.turn(chat)).ok);
  const NAME = claude.queries.at(-1)!.name;
  // A batch of two messages: two user messages before the next request.
  const batch = [await opencode.say(chat, "FIRST"), await opencode.say(chat, "SECRET_CODE=42")];
  // The CLI confirms FIRST's record without a turn, then dies before SECRET_CODE=42's record.
  // OpenCode would retry the request (and Claude would then answer the batch): the user stops the turn while
  // OpenCode waits to retry, then switches to another model.
  claude.state.failures = ["killedAfterRecords"];
  const from = claude.queries.length;
  const stop = new AbortController();
  const sleep = opencode.state.sleep;
  opencode.state.sleep = async (ms: number) => {
    stop.abort();
    await sleep(ms);
  };
  let died: Awaited<ReturnType<typeof opencode.turn>>;
  try {
    died = await opencode.turn(chat, { stop: stop.signal });
  } finally {
    opencode.state.sleep = sleep;
    claude.state.failures = [];
  }
  assert.ok(!died.ok && died.stopped, `the turn died, the user stopped OpenCode's retry: ${died.requests.map((r) => r.status)}`);
  const killed = claude.queries.slice(from);
  assert.deepEqual(killed.map((q) => [q.outcome, q.trigger]), [["killed", undefined]], "one query, killed before the record with the turn");
  assert.deepEqual(killed[0]!.input.map((r) => [r.uuid, r.noTurn]), [[names.userRecordName(batch[0]!, 1), true], [names.userRecordName(batch[1]!, 1), false]]);
  assert.ok(claude.records(NAME).some((r) => r.uuid === names.userRecordName(batch[0]!, 1)), "the first message's record was written");
  assert.ok(!claude.records(NAME).some((r) => r.uuid === names.userRecordName(batch[1]!, 1)), "the second one's was not");
  // Another model answers the batch with a tool step; its results come to Claude.
  opencode.otherModelAnswer(chat, "", {
    finish: "tool-calls",
    toolCalls: [{ id: "call_c", name: "read", input: { path: "a.txt" } }],
    toolResults: [{ id: "call_c", output: "A-CONTENT" }],
  });
  const step = await opencode.turn(chat);
  assert.ok(step.ok, `the step's results answered: ${step.requests.map((r) => r.status)}`);
  const last = claude.queries.at(-1)!;
  assert.equal(last.params.resumeSessionAt, names.userRecordName(batch[0]!, 1), "resumes at the first message's record");
  const sent = last.input.map((r) => contentText(r.content)).join("\n");
  assert.match(sent, /SECRET_CODE=42/, `the second message of the batch reaches Claude:\n${sent}`);
  assert.match(sent, /A-CONTENT/, "the other model's step reaches Claude with the missed part");
  assert.ok(
    !last.input.some((r) => !r.noTurn && contentText(r.content).trim() === "SECRET_CODE=42"),
    "the second message is not sent as a question of its own: the step's turn is another model's",
  );
  return JSON.stringify(last.input.map((r) => ({ noTurn: r.noTurn, text: contentText(r.content) })));
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
