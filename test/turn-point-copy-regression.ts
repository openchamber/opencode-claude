/**
 * Regression, the earlier form of turn-point-copy-regression (chain/turn-by-names to chain/record-per-message):
 * a turn whose point leaves a real message behind (a revert, an absorbed message undone, an edit of the first
 * message) resumes the same file at the point: the undone turn's records stay there as a side branch. From
 * chain/fork-copy on such a turn copies the transcript into the next version.
 *
 * On the simulators (test/simulators/): the user's chats in OpenCode, reverted (`undoBefore`); a message
 * absorbed mid-turn (`steer`); another model's answer. The point is the query's `resume` / `resumeSessionAt`,
 * no `forkSession`; what Claude read is the query's `view`.
 *
 * Run: bun test/turn-point-copy-main-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("turn-point-copy-main");
  const { opencode, claude } = world;
  const { FIRST_EPOCH, TRANSCRIPT_START_NAME, transcriptName, userRecordName } = await pluginModule("names");
  const cases = testCases();
  const takenSteps = (chat: string) =>
    world.journal().filter((line) => /not rebuilding the tool step: the transcript holds its results|the transcript holds the tool step's results; not rebuilding it/.test(line) && line.includes(`"conversationKey":"${chat}"`)).length;
  const chatQueries = () => claude.queries.filter((q) => q.kind === "chat");
  const textOfInput = (query: (typeof claude.queries)[number]) => JSON.stringify(query.input.filter((i) => !i.noTurn).map((i) => i.content));
  const newChat = () => {
    const id = opencode.newChat();
    const name = transcriptName(id, FIRST_EPOCH, 1);
    const ends = new Map<string, string>();
    const ask = async (text: string, options: Parameters<typeof opencode.turn>[1] = {}) => {
      const message = await opencode.say(id, text);
      const turn = await opencode.turn(id, options);
      assert.ok(turn.ok, `${text}: ${turn.requests.map((r) => r.status).join(",")}`);
      ends.set(text, claude.leafOf(name)!.uuid!);
      return { message, turn, query: chatQueries().at(-1)! };
    };
    return { id, name, ends, ask };
  };
  const pointOf = (query: (typeof claude.queries)[number]) => [query.params.resume, query.params.resumeSessionAt];
  const recordAt = (name: string, uuid: string | undefined) => claude.records(name).find((r) => r.uuid === uuid)!;
  const lines = (view: string) => view.split("\n");
  try {
    await opencode.startPlugin();

    await cases.run("a revert: the undone turn's records stay as a side branch, the point is before them, the same file", async () => {
      const chat = newChat();
      await chat.ask("q1");
      const undone = await chat.ask("q2");
      opencode.undoBefore(chat.id, undone.message);
      const after = await chat.ask("q3");
      assert.deepEqual(pointOf(after.query), [chat.name, chat.ends.get("q1")]);
      assert.equal(after.query.params.forkSession, undefined, "the same file, not a copy");
      assert.ok(claude.records(chat.name).some((r) => r.uuid === userRecordName(undone.message, 1)), "the undone turn's records stay");
      assert.ok(!lines(after.query.view).includes("q2"), `Claude does not see the undone message: ${after.query.view}`);
      const next = await chat.ask("q4");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("q3")], "the next turn continues the new branch");
    });

    await cases.run("an absorbed message undone: the walk stops on the CLI's snapshot after the result, no step rebuilt, the same file", async () => {
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
      assert.equal(next.query.params.forkSession, undefined, "the same file, not a copy");
      assert.equal(takenSteps(chat.id), taken + 1, "the transcript holds the step's results");
      assert.ok(next.query.view.includes("a.txt") && !next.query.view.includes("and count them"), `Claude reads the result, not the undone message: ${next.query.view}`);
    });

    await cases.run("a changed history (the first message edited, another model answered it): the point is the transcript's start, the history reaches Claude", async () => {
      const chat = newChat();
      const first = await chat.ask("q1");
      await chat.ask("q2");
      opencode.undoBefore(chat.id, first.message);
      await opencode.say(chat.id, "q1 edited");
      opencode.otherModelAnswer(chat.id, "another answer");
      const next = await chat.ask("q2 again");
      assert.deepEqual(pointOf(next.query), [chat.name, TRANSCRIPT_START_NAME]);
      assert.equal(next.query.params.forkSession, undefined, "the same file, not a copy");
      assert.ok(next.query.view.includes("q1 edited") && next.query.view.includes("another answer"), `the history reaches Claude: ${next.query.view}`);
      assert.ok(textOfInput(next.query).includes("q2 again"));
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
