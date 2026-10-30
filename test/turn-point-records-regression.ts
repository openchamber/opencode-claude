/**
 * Regression, the earlier form of turn-point-records-regression (chain/turn-by-names and chain/content-from-list):
 * messages the transcript does not hold (another model answered, a lost process's turn moved off the leaf
 * chain) reach Claude as text in the turn's own record, once; the late answer of a lost process stays out.
 * From chain/record-per-message on they go as a record without a turn of their own.
 *
 * On the simulators (test/simulators/): the user's chats in OpenCode; another model's answers
 * (`otherModelAnswer`), lost processes (`state.failures` "zombie", the late answer released by the test),
 * failed and killed attempts. The point is the query's `resume` / `resumeSessionAt`; the plan's line in the
 * journal names the attempt and the missed messages; the turn's record is the query's input.
 *
 * Run: bun test/turn-point-records-main-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("turn-point-records-main");
  const { opencode, claude } = world;
  const { FIRST_EPOCH, transcriptName, userRecordName } = await pluginModule("names");
  const cases = testCases();
  const plansOf = (chat: string) =>
    world
      .journal()
      .filter((line) => line.includes("resuming the chat's Claude transcript"))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { conversationKey: string; transcript: string; version: number; point: string; attempt: number; missed: number })
      .filter((plan) => plan.conversationKey === chat);
  const chatQueries = () => claude.queries.filter((q) => q.kind === "chat");
  const textOfInput = (query: (typeof claude.queries)[number]) => JSON.stringify(query.input.filter((i) => !i.noTurn).map((i) => i.content));
  const newChat = () => {
    const id = opencode.newChat();
    const name = transcriptName(id, FIRST_EPOCH, 1);
    const ends = new Map<string, string>();
    const ask = async (text: string) => {
      const message = await opencode.say(id, text);
      const from = claude.queries.length;
      const turn = await opencode.turn(id);
      assert.ok(turn.ok, `${text}: ${turn.requests.map((r) => r.status).join(",")}`);
      const query = chatQueries().at(-1)!;
      ends.set(text, claude.leafOf(name)!.uuid!);
      return { message, turn, query, queries: claude.queries.slice(from) };
    };
    return { id, name, ends, ask };
  };
  const pointOf = (query: (typeof claude.queries)[number]) => [query.params.resume, query.params.resumeSessionAt];
  try {
    await opencode.startPlugin();

    await cases.run("every attempt failed after its record, another model answered: the point is the end of the last attempt, the answer as text", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = Array.from({ length: 11 }, () => "serverError" as const);
      const failed = await opencode.say(chat.id, "q2");
      assert.ok(!(await opencode.turn(chat.id)).ok, "OpenCode gave up after its retries");
      const failedEnd = claude.leafOf(chat.name)!;
      assert.ok(failedEnd.isApiErrorMessage, "the last attempt ended with the CLI's error record");
      opencode.otherModelAnswer(chat.id, "another model's answer");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, failedEnd.uuid]);
      assert.ok(claude.chainTo(chat.name, failedEnd.uuid!).some((r) => r.uuid === userRecordName(failed, 11)), "the end of the last attempt");
      assert.equal(plansOf(chat.id).at(-1)!.missed, 1);
      const input = textOfInput(next.query);
      assert.ok(input.includes("another model's answer") && !input.includes("q2"), `the other answer goes as text, the question does not: ${input}`);
    });

    await cases.run("every attempt killed after its record, another model answered: the answer as text", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = Array.from({ length: 11 }, () => "killed" as const);
      await opencode.say(chat.id, "q2");
      assert.ok(!(await opencode.turn(chat.id)).ok, "OpenCode gave up after its retries");
      const killedEnd = claude.leafOf(chat.name)!.uuid!;
      opencode.otherModelAnswer(chat.id, "another model's answer");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, killedEnd]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 1);
      const input = textOfInput(next.query);
      assert.ok(input.includes("another model's answer") && !input.includes("q2"), `the other answer goes as text, the question does not: ${input}`);
    });

    await cases.run("missed turns: the point is q1's answer, q2 and after go as text", async () => {
      const chat = newChat();
      await chat.ask("q1");
      await opencode.say(chat.id, "q2");
      opencode.otherModelAnswer(chat.id, "another model's answer");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("q1")]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 2);
      assert.ok(textOfInput(next.query).includes("q2") && textOfInput(next.query).includes("another model's answer"), "the missed turn goes as text");
    });

    await cases.run("a message of reminders alone is no turn: every missed message still goes as text", async () => {
      const chat = newChat();
      await chat.ask("q1");
      opencode.between(chat.id, "synthetic", "<system-reminder>plan</system-reminder>");
      await chat.ask("q2");
      await opencode.say(chat.id, "q3");
      opencode.otherModelAnswer(chat.id, "another model's answer");
      const next = await chat.ask("q4");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("q2")]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 2);
      assert.ok(textOfInput(next.query).includes("q3") && textOfInput(next.query).includes("another model's answer"), `the missed turn goes as text: ${textOfInput(next.query)}`);
    });

    await cases.run("a lost process finished later: the point moves where the retry's branch leaves the leaf chain, the retry's answer once as text", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = ["zombie"];
      claude.state.replies = ["LATE-ANSWER", "RETRY-ANSWER"];
      const retried = await chat.ask("q2");
      assert.equal(retried.queries[0]!.outcome, "zombie");
      const retryEnd = chat.ends.get("q2")!;
      claude.state.zombies.shift()!();
      assert.notEqual(claude.leafOf(chat.name)!.uuid, retryEnd, "the late answer is the file's leaf");
      const next = await chat.ask("q3");
      assert.equal(next.queries.length, 1, "no refusal and no retry");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("q1")], "the point is where the retry's branch leaves the leaf chain");
      assert.equal(next.query.outcome, "answered", "the CLI resumed at the point");
      const input = textOfInput(next.query);
      assert.equal(input.split("RETRY-ANSWER").length - 1, 1, `the retry's answer reaches Claude once, as text: ${input}`);
      assert.ok(input.includes("q2"), "the question it answered goes with it");
      assert.ok(!next.query.view.includes("LATE-ANSWER"), `Claude does not read the late answer: ${next.query.view}`);
      const plan = plansOf(chat.id).at(-1)!;
      assert.deepEqual([plan.point, plan.version, plan.missed], [chat.ends.get("q1"), 1, 2], "the same file, q2 and its answer missed");
      assert.match(next.turn.requests.at(-1)!.reply?.reasoning ?? "", /\[claude-code\] Another Claude Code process wrote to the chat's session file/, "the turn says why the messages went as text");
      const after = await chat.ask("q4");
      assert.deepEqual(pointOf(after.query), [chat.name, chat.ends.get("q3")]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 0);
    });

    await cases.run("after a late answer the next question failed once: both attempts resume at the moved point", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = ["zombie"];
      claude.state.replies = ["LATE-ANSWER", "RETRY-ANSWER"];
      await chat.ask("q2");
      claude.state.zombies.shift()!();
      claude.state.failures = ["serverError"];
      const next = await chat.ask("q3");
      assert.deepEqual(
        next.queries.map((q) => [...pointOf(q), q.trigger]),
        [1, 2].map((attempt) => [chat.name, chat.ends.get("q1"), userRecordName(next.message, attempt)]),
      );
      assert.equal(plansOf(chat.id).at(-1)!.attempt, 2);
    });

    await cases.run("two lost processes, the later finishing late: the point moves to the end of the turn before it, the retry's answer as text", async () => {
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
      assert.ok(!next.query.view.includes("LATE-TWO") && textOfInput(next.query).includes("RETRY-TWO"), `the retry's answer as text, not the late one: ${next.query.view}`);
      claude.state.zombies.length = 0;
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
