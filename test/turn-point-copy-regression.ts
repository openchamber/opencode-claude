/**
 * Regression: a turn whose point leaves a real message behind (a revert, an edit of the first message, an
 * absorbed message undone, a revert after a lost process's late answer) copies the transcript up to the point
 * into the next version (resume + forkSession + sessionId; from chain/fork-copy on); the old version keeps the
 * undone turn's records, for a fork made before the revert, and the next turn continues the copy. A retry or a
 * stopped turn does not copy (turn-point-regression).
 *
 * Before chain/fork-copy the CLI branched the same file: turn-point-copy-main-regression.
 *
 * On the simulators (test/simulators/): the user's chats in OpenCode, reverted (`undoBefore`); a message
 * absorbed mid-turn (`steer`); a lost process (`state.failures` "zombie"); another model's answer. The point
 * and the copy are the query's `resume` / `resumeSessionAt`, `forkSession`, `sessionId` and `copiedFrom`, the
 * plan's line in the journal names the copy.
 *
 * Run: bun test/turn-point-copy-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("turn-point-copy");
  const { opencode, claude } = world;
  const { FIRST_EPOCH, TRANSCRIPT_START_NAME, transcriptName, userRecordName } = await pluginModule("names");
  const cases = testCases();
  const plansOf = (chat: string) =>
    world
      .journal()
      .filter((line) => line.includes("resuming the chat's Claude transcript"))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { conversationKey: string; transcript: string; version: number; copiedFrom?: string; copyFor?: string; point: string; attempt: number; missed: number })
      .filter((plan) => plan.conversationKey === chat);
  const takenSteps = (chat: string) =>
    world.journal().filter((line) => line.includes("not rebuilding the tool step: the transcript holds its results") && line.includes(`"conversationKey":"${chat}"`)).length;
  const chatQueries = () => claude.queries.filter((q) => q.kind === "chat");
  const textOfInput = (query: (typeof claude.queries)[number]) => JSON.stringify(query.input.filter((i) => !i.noTurn).map((i) => i.content));
  const writtenBy = (query: (typeof claude.queries)[number]) => String(query.params.forkSession || !query.params.resume ? query.params.sessionId : query.params.resume);
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
      ends.set(text, claude.leafOf(writtenBy(query))!.uuid!);
      return { message, turn, query, queries: claude.queries.slice(from) };
    };
    return { id, name, ends, ask };
  };
  const pointOf = (query: (typeof claude.queries)[number]) => [query.params.resume, query.params.resumeSessionAt];
  const recordAt = (name: string, uuid: string | undefined) => claude.records(name).find((r) => r.uuid === uuid)!;
  const lines = (view: string) => view.split("\n");
  try {
    await opencode.startPlugin();

    await cases.run("a revert copies the transcript up to the point into the next version; the next turn continues the copy", async () => {
      const chat = newChat();
      await chat.ask("q1");
      const undone = await chat.ask("q2");
      opencode.undoBefore(chat.id, undone.message);
      const after = await chat.ask("q3");
      assert.deepEqual(pointOf(after.query), [chat.name, chat.ends.get("q1")]);
      const copy = transcriptName(chat.id, FIRST_EPOCH, 2);
      assert.deepEqual([after.query.params.forkSession, after.query.params.sessionId], [true, copy], "the revert copies into the next version");
      assert.equal(after.query.copiedFrom, chat.name);
      assert.deepEqual([plansOf(chat.id).at(-1)!.version, plansOf(chat.id).at(-1)!.copiedFrom, plansOf(chat.id).at(-1)!.copyFor], [2, chat.name, "revert"], "the plan in the journal names the copy");
      assert.ok(claude.records(chat.name).some((r) => r.uuid === userRecordName(undone.message, 1)), "the undone turn's records stay");
      assert.ok(!claude.records(copy).some((r) => r.uuid === userRecordName(undone.message, 1)), "the copy holds nothing of the undone turn");
      assert.ok(!lines(after.query.view).includes("q2"), `Claude does not see the undone message: ${after.query.view}`);
      const next = await chat.ask("q4");
      assert.deepEqual([...pointOf(next.query), next.query.params.forkSession], [copy, chat.ends.get("q3"), undefined], "the next turn continues the copy");
    });

    await cases.run("an absorbed message undone: the walk stops on the CLI's snapshot after the result, no step rebuilt, a copy as a revert", async () => {
      const chat = newChat();
      claude.state.toolTurn = true;
      await chat.ask("list files", { toolOutput: "a.txt", steer: "and count them" });
      const steer = opencode.session(chat.id).messages.find((m) => m.text === "and count them")!.id;
      const absorbed = claude.records(chat.name).find((r) => r.attachment?.source_uuid === userRecordName(steer, 1))!;
      const snapshot = recordAt(chat.name, absorbed.parentUuid);
      assert.equal(snapshot.attachment?.type, "prompt_snapshot", "the CLI's snapshot lies between the result and the message");
      opencode.undoBefore(chat.id, steer);
      const taken = takenSteps(chat.id);
      const next = await chat.ask("q2");
      assert.deepEqual(pointOf(next.query), [chat.name, snapshot.uuid]);
      assert.deepEqual([next.query.params.forkSession, next.query.params.sessionId], [true, transcriptName(chat.id, FIRST_EPOCH, 2)], "a copy, as a revert");
      assert.equal(takenSteps(chat.id), taken + 1, "the transcript holds the step's results");
      assert.ok(next.query.view.includes("a.txt") && !next.query.view.includes("and count them"), `Claude reads the result, not the undone message: ${next.query.view}`);
    });

    await cases.run("a late answer, then a revert of the turn after the retry: a copy cut where the retry's branch leaves the leaf chain", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = ["zombie"];
      claude.state.replies = ["LATE-ANSWER-2", "RETRY-ANSWER-2"];
      await chat.ask("q2");
      const retryEnd = chat.ends.get("q2")!;
      const undone = await chat.ask("q3");
      claude.state.zombies.shift()!();
      opencode.undoBefore(chat.id, undone.message);
      const next = await chat.ask("q3 edited");
      assert.equal(next.queries.length, 1, "no refusal and no retry");
      const copy = transcriptName(chat.id, FIRST_EPOCH, 2);
      assert.deepEqual(
        [...pointOf(next.query), next.query.params.forkSession, next.query.params.sessionId],
        [chat.name, chat.ends.get("q1"), true, copy],
        "a copy into the next version, cut where the retry's branch leaves the leaf chain",
      );
      assert.equal(next.query.outcome, "answered");
      const retryAnswer = opencode.session(chat.id).messages.find((m) => m.type === "assistant" && m.text === "RETRY-ANSWER-2")!;
      const missed = next.query.input.filter((i) => i.noTurn);
      assert.deepEqual(missed.map((i) => i.uuid), [userRecordName(retryAnswer.id, 1)], "the retry's turn: one record without a turn");
      assert.ok(!next.query.view.includes("LATE-ANSWER-2") && !lines(next.query.view).includes("q3"), `Claude reads neither the late answer nor the undone message: ${next.query.view}`);
      const plan = plansOf(chat.id).at(-1)!;
      assert.deepEqual([plan.version, plan.copiedFrom, plan.copyFor, plan.missed], [2, chat.name, "revert", 2], "the plan names the copy");
      const moved = world
        .journal()
        .filter((line) => line.includes("the resume point is off the transcript's leaf chain") && line.includes(`"conversationKey":"${chat.id}"`))
        .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { offPoint: string; ancestor: string });
      assert.deepEqual(moved, [{ conversationKey: chat.id, transcript: chat.name, offPoint: retryEnd, ancestor: chat.ends.get("q1") }], "the journal names the move in the copied file");
      const after = await chat.ask("q4");
      assert.deepEqual([after.query.params.resume, after.query.params.forkSession, plansOf(chat.id).at(-1)!.missed], [copy, undefined, 0], "the next turn continues the copy");
    });

    await cases.run("a changed history (the first message edited, another model answered it): the transcript's start copied, all of it missed", async () => {
      const chat = newChat();
      const first = await chat.ask("q1");
      await chat.ask("q2");
      opencode.undoBefore(chat.id, first.message);
      await opencode.say(chat.id, "q1 edited");
      const other = opencode.otherModelAnswer(chat.id, "another answer");
      const next = await chat.ask("q2 again");
      assert.deepEqual(pointOf(next.query), [chat.name, TRANSCRIPT_START_NAME]);
      assert.deepEqual([next.query.params.forkSession, next.query.params.sessionId], [true, transcriptName(chat.id, FIRST_EPOCH, 2)], "the edit copies the transcript's start into the next version");
      const missed = next.query.input.filter((i) => i.noTurn);
      assert.deepEqual(missed.map((i) => i.uuid), [userRecordName(other.id, 1)], `the history is one record without a turn: ${JSON.stringify(next.query.input)}`);
      assert.ok(JSON.stringify(missed[0]!.content).includes("[User]: q1 edited") && JSON.stringify(missed[0]!.content).includes("[Assistant]: another answer"), "the history goes as text");
      assert.equal(textOfInput(next.query), JSON.stringify(["q2 again"]));
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
