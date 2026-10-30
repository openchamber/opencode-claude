/**
 * Regression: the first turn of a chat an older release of the plugin
 * served (sessions.json, a transcript under a random id) copies the
 * transcript that release kept, when its record still describes the chat
 * (src/migration.ts); the old record and the old transcript stay as they
 * were. A record that no longer fits sends the history as text with a
 * warning; a chat the older release never served is an ordinary text start;
 * a revert into the part the older release served goes as text (the copied
 * records carry no names).
 *
 * On the simulators (test/simulators/): the user runs the released 1.6.0
 * itself (`world.build(releaseTree("v1.6.0"))`, BEHAVIOR.md "An older release
 * before the tree under test"), then the released 1.7.0 (the same record and
 * fingerprints; tool results of OpenCode 2.x decoded): their turns through
 * OpenCode, their own record (sessions.json with its boundaries and
 * fingerprints), the transcripts the CLI named for them. A chat 1.6.0 began
 * and 1.7.0 went on with; a chat 1.7.0 alone served, with a tool step. A
 * record that no longer fits: after 1.6.0's turn the user undid the message
 * and another model answered a new one (1.6.0 records only Claude's turns).
 * Then the user upgrades: OpenCode stops 1.7.0 and loads the tree under test
 * on the same folders, and the chats go on; what Claude saw from `queries`,
 * the notes from the answer's reasoning, the plugin's journal.
 *
 * Run: bun test/migration-regression.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { testCases } from "./simulators/cases.ts";
import { createWorld, releaseTree } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("migration");
  const { opencode, claude } = world;
  const cases = testCases();
  const storeFile = join(process.env.XDG_DATA_HOME!, "opencode-claude", "sessions.json");

  /** A turn that must pass: the query it ended with, its answer as OpenCode shows it, and the plugin's notes. */
  const claudeTurn = async (chat: string, question: string) => {
    const id = await opencode.say(chat, question);
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `turn of ${chat}: ${turn.requests.map((x) => x.status).join(",")}`);
    const reply = turn.requests.at(-1)!.reply!;
    return { id, query: claude.queries.at(-1)!, answer: reply.text, notes: reply.reasoning ?? "" };
  };

  try {
    // The user runs 1.6.0.
    const released = await world.build(releaseTree("v1.6.0"));
    const old = await opencode.startPlugin(undefined, { setup: released.setup });

    // A chat 1.6.0 served whose record will still fit.
    const fits = opencode.newChat();
    const one = await claudeTurn(fits, "old question one");
    const two = await claudeTurn(fits, "old question two");
    const fitsName = one.query.name;
    assert.equal(two.query.params.resume, fitsName, "1.6.0 resumed its transcript");

    // A chat 1.6.0 served whose messages change afterwards: the user undoes the question and another model answers.
    const changed = opencode.newChat();
    const asked = await claudeTurn(changed, "question A");
    opencode.undoBefore(changed, asked.id);
    await opencode.say(changed, "question B");
    opencode.otherModelAnswer(changed, "answered by another model");

    // The user moves to 1.7.0: OpenCode stops 1.6.0 and loads 1.7.0 on the same folders.
    await opencode.stopPlugin(old);
    const released17 = await world.build(releaseTree("v1.7.0"));
    const old17 = await opencode.startPlugin(undefined, { setup: released17.setup });
    // The chat 1.6.0 began goes on under 1.7.0, in the same transcript.
    const three = await claudeTurn(fits, "old question three");
    assert.equal(three.query.params.resume, fitsName, "1.7.0 resumed 1.6.0's transcript");
    // A chat 1.7.0 alone served, its second turn a tool step.
    const only17 = opencode.newChat();
    const first17 = await claudeTurn(only17, "question of 1.7.0");
    claude.state.toolSteps = [[{ name: "bash", input: { command: "ls" } }]];
    await opencode.say(only17, "run it on 1.7.0");
    const step17 = await opencode.turn(only17, { toolOutput: "TOOL-OUTPUT-OF-1.7.0" });
    assert.ok(step17.ok, `the tool step's turn: ${step17.requests.map((x) => x.status).join(",")}`);
    const only17Name = first17.query.name;
    assert.equal(claude.queries.at(-1)!.params.resume, only17Name, "1.7.0 resumed its transcript");

    // The user upgrades: OpenCode stops 1.7.0 and loads the tree under test on the same folders.
    await opencode.stopPlugin(old17);
    const record = JSON.parse(readFileSync(storeFile, "utf8")) as Record<string, { foreignSessionId?: string; turns?: unknown[] }>;
    assert.equal(record[fits]?.foreignSessionId, fitsName, "the record names the chat's transcript");
    assert.equal(record[fits]?.turns?.length, 3, "the record holds 1.6.0's two turns and 1.7.0's");
    assert.equal(record[only17]?.foreignSessionId, only17Name, "1.7.0's record names its chat's transcript");
    await opencode.startPlugin();

    await cases.run("a chat whose record fits (1.6.0, then 1.7.0): the first turn copies the old transcript", async () => {
      const file = claude.fileOf(fitsName);
      const before = readFileSync(file, "utf8");
      const storeBefore = readFileSync(storeFile, "utf8");
      const seen = world.journal().length;
      const first = await claudeTurn(fits, "new question");
      assert.equal(first.query.copiedFrom, fitsName, "the old transcript is copied");
      assert.ok(first.query.view.includes(two.answer) && first.query.view.includes(three.answer), "Claude reads the old history, 1.6.0's and 1.7.0's turns, from the copy");
      assert.equal(first.query.view.split("old question one").length - 1, 1, "once: nothing is sent again as text");
      assert.equal(first.query.view.split(one.answer).length - 1, 1, "once: nothing is sent again as text");
      assert.ok(first.query.view.trimEnd().endsWith("new question"), "the question last");
      assert.match(first.notes, /\[claude-code\] This chat continues from the Claude session an earlier version/, first.notes);
      assert.equal(readFileSync(file, "utf8"), before, "the old transcript is not changed");
      assert.equal(readFileSync(storeFile, "utf8"), storeBefore, "the old record is not changed");
      assert.ok(
        world.journal().slice(seen).some((line) => line.includes("continuing a chat an older plugin version served from the transcript it kept") && line.includes(fitsName)),
        "the journal names the old transcript the chat continues from",
      );
      // The next turn finds the copy by name and continues it.
      const next = await claudeTurn(fits, "and then?");
      assert.equal(next.query.copiedFrom, undefined, "a plain continuation");
      assert.equal(next.query.name, first.query.name, "in the copy");
      assert.equal(next.notes, "", "nothing to say");
    });

    await cases.run("a chat 1.7.0 served, with a tool step: the first turn copies the old transcript", async () => {
      const storeBefore = readFileSync(storeFile, "utf8");
      const first = await claudeTurn(only17, "new question after 1.7.0");
      assert.equal(first.query.copiedFrom, only17Name, "the old transcript is copied");
      assert.ok(first.query.view.includes(first17.answer) && first.query.view.includes("TOOL-OUTPUT-OF-1.7.0"), "Claude reads 1.7.0's turns, the tool's result included, from the copy");
      assert.equal(first.query.view.split("TOOL-OUTPUT-OF-1.7.0").length - 1, 1, "once: nothing is sent again as text");
      assert.ok(first.query.view.trimEnd().endsWith("new question after 1.7.0"), "the question last");
      assert.match(first.notes, /\[claude-code\] This chat continues from the Claude session an earlier version/, first.notes);
      assert.equal(readFileSync(storeFile, "utf8"), storeBefore, "the old record is not changed");
    });

    await cases.run("a revert into the part the older release served: the history as text", async () => {
      // The records copied from the old transcript carry no names (src/migration.ts): no point there to resume at.
      opencode.undoBefore(fits, two.id);
      const edited = await claudeTurn(fits, "old question two, edited");
      assert.equal(edited.query.params.resume, undefined, `nothing resumed: ${JSON.stringify(edited.query.params)}`);
      assert.ok(edited.query.view.includes("old question one") && edited.query.view.includes(one.answer), "the history before the revert as text");
      assert.ok(!edited.query.view.includes("old question two\n") && !edited.query.view.includes(two.answer) && !edited.query.view.includes(three.answer), "nothing undone");
    });

    await cases.run("a chat whose record no longer fits: the history as text, with a warning", async () => {
      const seen = world.journal().length;
      const first = await claudeTurn(changed, "new question");
      assert.equal(first.query.copiedFrom, undefined, "nothing copied");
      assert.match(first.notes, /\[claude-code warning\] The Claude session an earlier version of the plugin kept for this chat no longer matches it/, first.notes);
      assert.ok(first.query.view.includes("answered by another model"), "the history went as text");
      assert.ok(!first.query.view.includes(asked.answer), "the undone answer is not in it");
      assert.notEqual(first.query.name, asked.query.name, "a new transcript, not the old one continued");
      assert.ok(
        world.journal().slice(seen).some((line) => line.includes("the old transcript of this chat does not match it")),
        "the journal says why the history went as text",
      );
    });

    await cases.run("a chat the older release never served: an ordinary text start", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "asked elsewhere");
      opencode.otherModelAnswer(chat, "answered elsewhere");
      const first = await claudeTurn(chat, "now Claude");
      assert.equal(first.query.copiedFrom, undefined);
      assert.match(first.notes, /\[claude-code\] This part of the chat had no Claude session yet/, first.notes);
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
