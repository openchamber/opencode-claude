/**
 * Regression: a chat turn that runs differently from the usual says so in a
 * line of its reasoning, above the answer (proxy.ts TURN_NOTES), as the
 * CLI's own notices do: `[claude-code warning]` when something did not work
 * and the turn goes without the prompt cache, `[claude-code]` to explain an
 * expected step. The first turn of a new chat and a plain continuation say
 * nothing.
 *
 * On the simulators (test/simulators/): the user's chats in OpenCode; the
 * note is the reasoning of the turn's last reply. Another model's answer is
 * `otherModelAnswer`; a compaction is OpenCode's own, written by Claude.
 * Another process's branch: a process that was not stopped (`state.failures`
 * "zombie") writes its answer after the next turn's records, so the end of
 * the chat's last turn is off the file's leaf chain and the turn continues
 * where the chat's branch leaves it. A transcript the CLI cannot continue:
 * its file is removed while the CLI starts (`state.holdStart`), after the
 * plugin read it, and the CLI refuses it ("No conversation found"); OpenCode
 * retries the turn.
 *
 * Run: bun test/turn-notes-regression.ts
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("turn-notes");
  const { opencode, claude } = world;
  /** The user sends `text`; the turn must pass: the reasoning of its last reply, "" when none. */
  const ask = async (chat: string, text: string) => {
    await opencode.say(chat, text);
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `${text}: ${turn.requests.map((r) => `${r.status} ${r.reply?.text ?? ""}`).join(", ")}`);
    return { reasoning: turn.requests.at(-1)!.reply?.reasoning ?? "", turn };
  };
  try {
    await opencode.startPlugin();

    // A new chat, then a plain continuation: nothing to say.
    const fresh = opencode.newChat();
    // Checked at the end (a finding on chain/turn-by-names, see the header), after every other case.
    const firstTurns = [(await ask(fresh, "one")).reasoning];
    assert.equal((await ask(fresh, "two")).reasoning, "", "a plain continuation");

    // Another model answered a turn: it reaches Claude as text, once, explained.
    await opencode.say(fresh, "three");
    opencode.otherModelAnswer(fresh, "another model");
    const missed = (await ask(fresh, "four")).reasoning;
    assert.match(missed, /^\s*\[claude-code\] 2 messages are missing from Claude's session file \(most likely another model answered them\), so they went to Claude as text, once\./, `missed turns: ${missed}`);
    assert.doesNotMatch(missed, /warning/);
    assert.ok(claude.queries.at(-1)!.view.includes("another model"), "Claude read the other model's answer");

    // A chat whose earlier turns another model answered comes to Claude.
    const late = opencode.newChat();
    await opencode.say(late, "a");
    opencode.otherModelAnswer(late, "x");
    const lateNote = (await ask(late, "b")).reasoning;
    assert.match(lateNote, /\[claude-code\] This part of the chat had no Claude session yet/, `late: ${lateNote}`);

    // The first turn after OpenCode compacted the chat.
    const compacted = opencode.newChat();
    await ask(compacted, "a");
    await ask(compacted, "b");
    const compaction = await opencode.compact(compacted);
    assert.equal(compaction.status, "completed", "OpenCode compacted the chat");
    const compactedNote = (await ask(compacted, "c")).reasoning;
    assert.match(compactedNote, /\[claude-code\] The chat was compacted/, `compacted: ${compactedNote}`);

    // Another process wrote to the chat's transcript after the chat's turns: the turn continues before
    // them, and what the list holds after goes as text, explained.
    const branched = opencode.newChat();
    await ask(branched, "k");
    // A process the plugin lost keeps running: its request fails, OpenCode retries it, and the retry answers.
    claude.state.failures = ["zombie"];
    await opencode.say(branched, "l");
    const l = await opencode.turn(branched);
    assert.ok(l.ok, `l answered on OpenCode's retry: ${l.requests.map((r) => r.status).join(",")}`);
    assert.deepEqual(l.requests.map((r) => r.status), [500, 200], "the lost process's request failed, the retry answered");
    // The lost process writes its answer now, after the records of the turn that answered.
    claude.state.zombies.shift()!();
    const branchedNote = (await ask(branched, "m")).reasoning;
    assert.match(
      branchedNote,
      /^\s*\[claude-code\] Another Claude Code process wrote to the chat's session file after this chat's turns, so this turn continued from before them and 2 messages went to Claude as text, once\./,
      `branched: ${branchedNote}`,
    );
    assert.doesNotMatch(branchedNote, /warning/);

    // The CLI refused to continue the chat's transcript: the turn starts a new one, a warning. The
    // transcript is removed (Claude Code's cleanup, the user) after the plugin read it and before the
    // CLI loads it.
    const lost = opencode.newChat();
    firstTurns.push((await ask(lost, "p")).reasoning);
    await opencode.say(lost, "q");
    let release!: () => void;
    const lostTranscript = claude.queries.at(-1)!.name;
    const held = claude.heldStarts;
    claude.state.holdStart = new Promise<void>((resolve) => (release = resolve));
    const refusedFrom = claude.queries.length;
    const turning = opencode.turn(lost);
    for (let waited = 0; claude.heldStarts === held; waited += 10) {
      if (waited > 5_000) throw new Error("the query did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    rmSync(claude.fileOf(lostTranscript));
    release();
    const retried = await turning;
    assert.ok(retried.ok, `the turn passed on OpenCode's retry: ${retried.requests.map((r) => r.status).join(",")}`);
    const [refused, again] = claude.queries.slice(refusedFrom);
    assert.equal(refused!.outcome, "refused: no conversation", "the CLI could not load the transcript");
    assert.ok(retried.requests[0]!.status !== 200, "the turn on the lost transcript fails");
    assert.equal(again!.params.resume, undefined, "the retry starts a new transcript");
    assert.ok(again!.params.sessionId && again!.params.sessionId !== refused!.name, "under a new name");
    const lostNote = retried.requests.at(-1)!.reply?.reasoning ?? "";
    assert.match(lostNote, /\[claude-code warning\] The chat's Claude session could not be continued/, `lost: ${lostNote}`);

    const journal = world.journal();
    assert.ok(journal.some((line) => line.includes("Claude session lost; the chat moves to a new transcript")), "the journal says the transcript was lost");
    const errors = journal.filter((line) => /level=error/.test(line));
    assert.deepEqual(errors.filter((line) => !/No conversation found|exited with code 143/.test(line)), [], "no other error in the plugin's journal");

    // The first turn of a new chat transfers nothing: OpenCode's system message is no history.
    assert.ok(!JSON.stringify(claude.queries[0]!.input.map((i) => i.content)).includes("<conversation_history>"), "the first turn carried no history");
    assert.deepEqual(firstTurns, ["", ""], "the first turn of a new chat says nothing");
  } finally {
    await world.dispose();
  }
  console.log("ok — turn notes regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
