/**
 * Regression: what the transcript lacks reaches Claude as records of their
 * own (src/turn-point.ts, prompt.ts missedMessageContent; from
 * chain/record-per-message on). Messages the transcript does not hold
 * (another model answered, a lost process's turn moved off the leaf chain)
 * go as one record without a turn, named after the last of them, then the
 * turn's record holds the question alone; the next turn finds that record by
 * name and sends nothing again. A missed message's lines follow OpenCode's
 * labels (compaction.ts flattenMessage): tool output whole, a tool error (its
 * `{ error, content }` as JSON, as OpenCode writes it), an image after its
 * label as itself, reasoning and system messages left out. A
 * checkpoint after OpenCode's compaction is a record of its own, a point by
 * itself.
 *
 * Before chain/record-per-message the missed part went as text in the turn's
 * record: turn-point-records-main-regression.
 *
 * On the simulators (test/simulators/): the user's chats in OpenCode;
 * another model's answers (`otherModelAnswer`, with its reasoning, tool calls
 * and results, a file among them), a question with a picture, an instruction
 * update (`between` system), lost processes (`state.failures` "zombie", the
 * late answer released by the test), failed and killed attempts. The point is
 * the query's `resume` / `resumeSessionAt`, the plan's line in the journal
 * names the attempt and the missed messages; what went without a turn is the
 * query's input entries with `noTurn`.
 *
 * Run: bun test/turn-point-records-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("turn-point-records");
  const { opencode, claude } = world;
  const { FIRST_EPOCH, TRANSCRIPT_START_NAME, checkpointRecordName, checkpointText, transcriptName, userRecordName } = await pluginModule("names");
  const cases = testCases();
  const plansOf = (chat: string) =>
    world
      .journal()
      .filter((line) => line.includes("resuming the chat's Claude transcript"))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { conversationKey: string; transcript: string; version: number; point: string; attempt: number; missed: number })
      .filter((plan) => plan.conversationKey === chat);
  const chatQueries = () => claude.queries.filter((q) => q.kind === "chat");
  const textOfInput = (query: (typeof claude.queries)[number]) => JSON.stringify(query.input.filter((i) => !i.noTurn).map((i) => i.content));
  /** The missed messages a query sent: its records without a turn, by name, and their text. */
  const missedOf = (query: (typeof claude.queries)[number]) => {
    const missed = query.input.filter((i) => i.noTurn);
    return { names: missed.map((i) => i.uuid), text: JSON.stringify(missed.map((i) => i.content)), contents: missed.map((i) => i.content) };
  };
  const newChat = () => {
    const id = opencode.newChat();
    const name = transcriptName(id, FIRST_EPOCH, 1);
    const ends = new Map<string, string>();
    const ask = async (text: string, options: Parameters<typeof opencode.turn>[1] = {}) => {
      const message = await opencode.say(id, text);
      const from = claude.queries.length;
      const turn = await opencode.turn(id, options);
      assert.ok(turn.ok, `${text}: ${turn.requests.map((r) => r.status).join(",")}`);
      const query = chatQueries().at(-1)!;
      ends.set(text, claude.leafOf(String(query.params.forkSession || !query.params.resume ? query.params.sessionId : query.params.resume))!.uuid!);
      return { message, turn, query, queries: claude.queries.slice(from) };
    };
    return { id, name, ends, ask };
  };
  const pointOf = (query: (typeof claude.queries)[number]) => [query.params.resume, query.params.resumeSessionAt];
  const lines = (view: string) => view.split("\n");
  const offLeafMoves = (chat: string) =>
    world
      .journal()
      .filter((line) => line.includes("the resume point is off the transcript's leaf chain") && line.includes(`"conversationKey":"${chat}"`))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { offPoint: string; ancestor: string });
  try {
    await opencode.startPlugin();

    await cases.run("every attempt failed after its record, another model answered: the point is the end of the last attempt, the answer a record of its own", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = Array.from({ length: 11 }, () => "serverError" as const);
      const failed = await opencode.say(chat.id, "q2");
      assert.ok(!(await opencode.turn(chat.id)).ok, "OpenCode gave up after its retries");
      const failedEnd = claude.leafOf(chat.name)!;
      assert.ok(failedEnd.isApiErrorMessage, "the last attempt ended with the CLI's error record");
      const other = opencode.otherModelAnswer(chat.id, "another model's answer");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, failedEnd.uuid]);
      assert.ok(claude.chainTo(chat.name, failedEnd.uuid!).some((r) => r.uuid === userRecordName(failed, 11)), "the end of the last attempt");
      assert.equal(plansOf(chat.id).at(-1)!.missed, 1);
      const missed = missedOf(next.query);
      assert.deepEqual(missed.names, [userRecordName(other.id, 1)]);
      assert.ok(missed.text.includes("another model's answer") && !missed.text.includes("q2"), `the other answer goes as missed, the question does not: ${missed.text}`);
      assert.equal(textOfInput(next.query), JSON.stringify(["q3"]), "the turn's record is the question alone");
    });

    await cases.run("every attempt killed after its record, another model answered: the answer a record of its own", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = Array.from({ length: 11 }, () => "killed" as const);
      await opencode.say(chat.id, "q2");
      assert.ok(!(await opencode.turn(chat.id)).ok, "OpenCode gave up after its retries");
      const killedEnd = claude.leafOf(chat.name)!.uuid!;
      const other = opencode.otherModelAnswer(chat.id, "another model's answer");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, killedEnd]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 1);
      const missed = missedOf(next.query);
      assert.deepEqual(missed.names, [userRecordName(other.id, 1)]);
      assert.ok(missed.text.includes("another model's answer") && !missed.text.includes("q2"), `the other answer goes as missed, the question does not: ${missed.text}`);
      assert.equal(textOfInput(next.query), JSON.stringify(["q3"]), "the turn's record is the question alone");
    });

    await cases.run("missed turns: one record without a turn named after the last; the next turn finds it; a revert to before that turn resumes at it", async () => {
      const chat = newChat();
      await chat.ask("q1");
      await opencode.say(chat.id, "q2");
      const other = opencode.otherModelAnswer(chat.id, "another model's answer");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("q1")]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 2);
      const missed = next.query.input.filter((i) => i.noTurn);
      assert.deepEqual(missed.map((i) => i.uuid), [userRecordName(other.id, 1)], "one record without a turn, named after the other model's answer");
      assert.ok(JSON.stringify(missed[0]!.content).includes("[User]: q2") && JSON.stringify(missed[0]!.content).includes("[Assistant]: another model's answer"), `the missed turn goes as text: ${JSON.stringify(missed[0]!.content)}`);
      assert.ok(claude.records(chat.name).some((r) => r.uuid === userRecordName(other.id, 1) && r.queueTranscriptOnly), "the CLI wrote it under its name");
      assert.equal(textOfInput(next.query), JSON.stringify(["q3"]), "the turn's record is the question alone");
      const after = await chat.ask("q4");
      assert.deepEqual(pointOf(after.query), [chat.name, chat.ends.get("q3")]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 0, "nothing missed: the record of the missed turn is in the transcript");
      assert.deepEqual(after.query.input.map((i) => [i.noTurn, i.content]), [[false, "q4"]], "nothing sent again");
      opencode.undoBefore(chat.id, next.message);
      const reverted = await chat.ask("q3 again");
      assert.deepEqual([reverted.query.params.resumeSessionAt, reverted.query.copiedFrom ?? reverted.query.params.resume], [userRecordName(other.id, 1), chat.name], "the point is the missed record itself");
      assert.deepEqual(reverted.query.input.map((i) => [i.noTurn, i.content]), [[false, "q3 again"]], "nothing sent again");
    });

    await cases.run("a message of reminders alone is no turn: every missed message still goes as missed", async () => {
      const chat = newChat();
      await chat.ask("q1");
      opencode.between(chat.id, "synthetic", "<system-reminder>plan</system-reminder>");
      await chat.ask("q2");
      await opencode.say(chat.id, "q3");
      opencode.otherModelAnswer(chat.id, "another model's answer");
      const next = await chat.ask("q4");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("q2")]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 2);
      const missed = missedOf(next.query).text;
      assert.ok(missed.includes("q3") && missed.includes("another model's answer"), `the missed turn goes as missed: ${missed}`);
    });

    await cases.run("a missed message's lines: OpenCode's labels, tool output whole, a tool error, images after their labels, reasoning and system left out", async () => {
      const chat = newChat();
      await chat.ask("q1");
      const long = "x".repeat(3000);
      const shot = testPng("missed-shot").toString("base64");
      const pic = testPng("missed-pic").toString("base64");
      await opencode.say(chat.id, "hi", [{ mediaType: "image/png", data: shot, name: "shot.png" }]);
      const call = (id: string) => ({ id, name: "read", input: { path: id } });
      opencode.otherModelAnswer(chat.id, "ok", {
        reasoning: "hmm",
        toolCalls: [call("c1"), call("c2"), call("c3")],
        toolResults: [
          { id: "c1", output: long },
          { id: "c2", output: "denied", error: true },
          { id: "c3", output: "pic", files: [{ mime: "image/png", data: pic, name: "a.png" }] },
        ],
      });
      opencode.between(chat.id, "system", "rules changed");
      const next = await chat.ask("q2");
      const missed = missedOf(next.query);
      const flat = JSON.stringify(missed.contents);
      assert.ok(flat.includes("[User]: hi") && flat.includes("[Attached image/png: shot.png]"), `the user's text and the picture's label: ${flat.slice(0, 400)}`);
      assert.ok(flat.includes("[Assistant]: ok") && flat.includes('[Assistant tool call]: read({\\"path\\":\\"c1\\"})'), "the answer and its calls");
      assert.ok(flat.includes(`[Tool result]: ${long}`), "tool output whole");
      // OpenCode keeps a failed call's result as `{ error, content }` and writes it as JSON (flattenMessage).
      assert.ok(flat.includes('[Tool error]: {\\"error\\":\\"denied\\",\\"content\\":[]}'), `a tool error, as OpenCode writes it: ${flat.slice(Math.max(0, flat.indexOf("denied") - 100), flat.indexOf("denied") + 50)}`);
      assert.ok(flat.includes("[Tool result]: pic") && flat.includes("[Attached image/png: a.png]"), "a result's file after its label");
      const images = missed.contents.flatMap((content) => (Array.isArray(content) ? content : [])).filter((block: any) => block?.type === "image");
      assert.deepEqual(images.map((block: any) => block.source?.data), [shot, pic], "each image as itself, in order");
      assert.ok(!flat.includes("hmm") && !flat.includes("rules changed"), "reasoning and the system message left out");
      // The instruction update reaches Claude with the turn's record, ahead of the question.
      assert.equal(textOfInput(next.query), JSON.stringify(["<system-update>\nrules changed\n</system-update>\n\nq2"]));
    });

    await cases.run("a lost process finished later: the point moves where the retry's branch leaves the leaf chain, q2 and the retry's answer one missed record", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = ["zombie"];
      // The lost process takes its answer when it starts, the retry after it.
      claude.state.replies = ["LATE-ANSWER", "RETRY-ANSWER"];
      const retried = await chat.ask("q2");
      assert.equal(retried.queries[0]!.outcome, "zombie");
      const retryEnd = chat.ends.get("q2")!;
      claude.state.zombies.shift()!();
      assert.notEqual(claude.leafOf(chat.name)!.uuid, retryEnd, "the late answer is the file's leaf");
      const next = await chat.ask("q3");
      assert.equal(next.queries.length, 1, "no refusal and no retry");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("q1")], "the point is where the retry's branch leaves the leaf chain");
      assert.equal(next.query.params.forkSession, undefined, "the same file, not a copy");
      assert.equal(next.query.outcome, "answered", "the CLI resumed at the point");
      const retryAnswer = opencode.session(chat.id).messages.find((m) => m.type === "assistant" && m.text === "RETRY-ANSWER")!;
      const missed = next.query.input.filter((i) => i.noTurn);
      assert.deepEqual(missed.map((i) => i.uuid), [userRecordName(retryAnswer.id, 1)], "one record without a turn, named after the retry's answer");
      const missedText = JSON.stringify(missed[0]!.content);
      assert.ok(missedText.includes("[User]: q2") && missedText.split("RETRY-ANSWER").length - 1 === 1, `q2 and the retry's answer go in it, once: ${missedText}`);
      assert.equal(textOfInput(next.query), JSON.stringify(["q3"]), "the turn's record is the question alone");
      assert.ok(!next.query.view.includes("LATE-ANSWER"), `Claude does not read the late answer: ${next.query.view}`);
      const plan = plansOf(chat.id).at(-1)!;
      assert.deepEqual([plan.point, plan.version, plan.missed], [chat.ends.get("q1"), 1, 2], "the same file, q2 and its answer missed");
      assert.deepEqual(offLeafMoves(chat.id), [{ conversationKey: chat.id, transcript: chat.name, offPoint: retryEnd, ancestor: chat.ends.get("q1") }], "the journal names the move");
      assert.match(next.turn.requests.at(-1)!.reply?.reasoning ?? "", /\[claude-code\] Another Claude Code process wrote to the chat's session file/, "the turn says why the messages went as missed");
      assert.ok(!world.journal().some((line) => line.includes("Claude session lost") && line.includes(`"conversationKey":"${chat.id}"`)), "the file stays the chat's");
      const after = await chat.ask("q4");
      assert.deepEqual(pointOf(after.query), [chat.name, chat.ends.get("q3")]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 0);
      assert.deepEqual(after.query.input.map((i) => [i.noTurn, i.content]), [[false, "q4"]], "nothing sent again");
    });

    await cases.run("after a late answer the next question failed once: the second attempt resumes at the missed record the first wrote", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = ["zombie"];
      claude.state.replies = ["LATE-ANSWER", "RETRY-ANSWER"];
      await chat.ask("q2");
      claude.state.zombies.shift()!();
      claude.state.failures = ["serverError"];
      const next = await chat.ask("q3");
      const retryAnswer = opencode.session(chat.id).messages.find((m) => m.type === "assistant" && m.text === "RETRY-ANSWER")!;
      const missedRecord = userRecordName(retryAnswer.id, 1);
      assert.deepEqual(
        next.queries.map((q) => [...pointOf(q), q.trigger]),
        [
          [chat.name, chat.ends.get("q1"), userRecordName(next.message, 1)],
          [chat.name, missedRecord, userRecordName(next.message, 2)],
        ],
      );
      assert.deepEqual(next.queries.map((q) => missedOf(q).names), [[missedRecord], []]);
      assert.equal(plansOf(chat.id).at(-1)!.attempt, 2);
    });

    await cases.run("two lost processes, the later finishing late: the point moves to the end of the turn before it, the retry's answer missed", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = ["zombie"];
      claude.state.replies = ["LATE-ONE", "RETRY-ONE"];
      await chat.ask("q2");
      await chat.ask("q3");
      claude.state.failures = ["zombie"];
      claude.state.replies = ["LATE-TWO", "RETRY-TWO"];
      await chat.ask("q4");
      claude.state.zombies.pop()!();
      const next = await chat.ask("q5");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("q3")]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 2, "q4 and its answer");
      assert.ok(!next.query.view.includes("LATE-TWO") && missedOf(next.query).text.includes("RETRY-TWO"), `the retry's answer as missed, not the late one: ${next.query.view}`);
      claude.state.zombies.length = 0;
    });

    await cases.run("a checkpoint is a record of its own: the retry of the first question after a compaction resumes at it", async () => {
      const chat = newChat();
      await chat.ask("q1");
      await chat.ask("q2");
      const compaction = await opencode.compact(chat.id);
      assert.equal(compaction.status, "completed");
      const kept = opencode.session(chat.id).messages.findLast((m) => m.type === "compaction")!;
      const checkpoint = checkpointRecordName(checkpointText(kept.summary!, kept.recent), 1);
      claude.state.failures = ["serverError"];
      const retried = await chat.ask("q3");
      const [failed, again] = retried.queries;
      assert.deepEqual(failed!.input.map((i) => [i.uuid, i.noTurn]), [[TRANSCRIPT_START_NAME, true], [checkpoint, true], [userRecordName(retried.message, 1), false]], "the start, the checkpoint without a turn, the question");
      assert.ok(claude.records(failed!.name).some((r) => r.uuid === checkpoint), "the CLI wrote it under its name");
      assert.deepEqual([again!.params.resume, again!.params.resumeSessionAt, again!.trigger], [failed!.name, checkpoint, userRecordName(retried.message, 2)], "the retry resumes at the checkpoint");
      assert.ok(!lines(again!.view).includes("q1"), "the model reads from the checkpoint on");
    });

    await cases.run("no other error in the plugin's journal", () => {
      const errors = world.journal().filter((line) => /level=error/.test(line));
      assert.deepEqual(errors.filter((line) => !/Internal server error|exited with code (1|143)|No message found/.test(line)), []);
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
