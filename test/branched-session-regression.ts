/**
 * Regression: a chat whose Claude session file holds two branches resumes
 * its own branch through a fork, instead of failing every turn.
 *
 * Seen live (CLI 2.1.285): another claude process on the same session wrote
 * a side branch off a common ancestor, interleaved with our turn, and then
 * the last `last-prompt` entry, which names its leaf. The CLI resumes that
 * chain; resumeSessionAt with our leaf searched only there and failed with
 * "No message found with message.uuid of", so every message errored and
 * OpenCode retried in a loop.
 *
 * On the simulators (test/simulators/): the other process is a Claude Code
 * process the plugin did not stop (`state.failures` "zombie", probes 8 and
 * 10): its turn failed, the user stopped the chat while OpenCode waited to
 * retry and had another model answer, the next Claude turn continued the
 * same file, and then the zombie wrote
 * its answer off the failed turn's prompt with its own `last-prompt`. A plain
 * resume would continue the zombie's chain (BEHAVIOR.md "Where a resume
 * continues"). The decision is read on the file Claude Code wrote, at several
 * chunk sizes, through main's `session-store`.
 *
 * A leaf the file does not hold: a turn whose Claude Code process died right
 * after its tool's result, before the CLI flushed what it wrote (the plugin
 * saw the records, the file never got them; `state.failures`
 * "killedBeforeFlush"). The next message resumes the session as it is.
 *
 * Not kept: the fallback for a CLI that still answers "No message found" on
 * a chat turn. main never resumes a chat at a message (no resumeSessionAt),
 * and no probe saw a plain resume refused that way (an open question for
 * the simulator).
 *
 * Run: bun test/branched-session-main-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("branched");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    const store = await pluginModule("session-store");
    const forks = () => world.journal().filter((line) => line.includes("resuming a fork of the Claude session")).map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { from: string; fork: string });

    const chat = opencode.newChat();
    await opencode.say(chat, "Q-first");
    assert.ok((await opencode.turn(chat)).ok, "the first turn");
    const name = claude.queries.at(-1)!.name;

    // A turn whose Claude Code process fails but is not stopped (a zombie).
    // OpenCode would retry it; the user stops the chat during the wait.
    await opencode.say(chat, "Q-second");
    claude.state.failures = ["zombie"];
    claude.state.replies = ["ZOMBIE-ANSWER"];
    const stop = new AbortController();
    const sleep = opencode.state.sleep;
    opencode.state.sleep = async () => stop.abort();
    const failed = await opencode.turn(chat, { stop: stop.signal });
    opencode.state.sleep = sleep;
    assert.ok(failed.stopped, "the user stopped the chat during OpenCode's retry wait");
    assert.equal(claude.queries.at(-1)!.outcome, "zombie");
    assert.equal(claude.state.zombies.length, 1);
    // The user lets another model answer it; the next Claude turn finds its boundary and continues the same file.
    opencode.otherModelAnswer(chat, "OTHER-MODEL-ANSWER");

    await opencode.say(chat, "Q-third");
    const third = await opencode.turn(chat);
    assert.ok(third.ok, "the third turn");
    assert.equal(claude.queries.at(-1)!.params.resume, name);
    const ours = store.getSessionLeafUuid(chat) as string;
    assert.equal(ours, claude.records(name).findLast((r) => r.type === "assistant")!.uuid, "the chat's leaf is the third answer");

    // Now the zombie writes its answer: a side branch after our leaf, and the file's last `last-prompt` names it.
    claude.state.zombies.shift()!();
    const zombie = claude.leafOf(name)!;
    assert.ok(JSON.stringify(zombie.message?.content).includes("ZOMBIE-ANSWER"), "a plain resume would continue the zombie's chain");
    assert.ok(!claude.chainTo(name, zombie.uuid!).some((r) => r.uuid === ours), "the zombie's chain does not hold our leaf");

    // The decision itself, whatever the chunk size.
    const file = claude.fileOf(name);
    for (const chunk of [16, 64, 256 * 1024]) assert.equal(store.sessionChainAfterLeaf(file, ours, chunk), "branched", `chunk ${chunk}`);

    // The next message resumes our branch through a fork cut at our leaf.
    await opencode.say(chat, "Q-fourth");
    const fourth = await opencode.turn(chat);
    assert.ok(fourth.ok, `the fourth turn: ${fourth.requests.map((r) => r.status).join(",")}`);
    assert.equal(fourth.requests.length, 1, "answered at once, no retry loop");
    assert.ok(world.journal().some((line) => line.includes("Claude session branched after this chat's last turn")));
    assert.equal(forks().length, 1);
    const { from, fork } = forks()[0]!;
    assert.equal(from, name);
    // main's fork is the SDK's forkSession: the copy ends at the copy of our leaf.
    const copied = claude.records(fork).filter((r) => r.forkedFrom);
    assert.deepEqual(copied.at(-1)!.forkedFrom, { sessionId: name, messageUuid: ours });
    const query = claude.queries.at(-1)!;
    assert.equal(query.params.resume, fork);
    assert.equal("resumeSessionAt" in query.params, false);
    assert.ok(!JSON.stringify(query.input.map((i) => i.content)).includes("<conversation_history>"), "resumed, not transferred");
    assert.ok(query.view.includes("Q-third") && !query.view.includes("ZOMBIE-ANSWER"), `Claude sees our branch, not the zombie's: ${query.view}`);
    assert.equal(store.getForeignSessionId(chat), fork);
    assert.equal(store.getSessionLeafUuid(chat), claude.records(fork).findLast((r) => r.type === "assistant")!.uuid);

    // A turn whose Claude Code process died right after its tool's result, before it flushed what it wrote
    // (`killedBeforeFlush`, CLI 2.1.312 killed against a local stub of the API): the plugin saw the
    // turn's records, the file never got them. The leaf the plugin kept is not in the file.
    const lost = opencode.newChat();
    await opencode.say(lost, "Q-lost first");
    assert.ok((await opencode.turn(lost)).ok, "the lost chat's first turn");
    const lostName = claude.queries.at(-1)!.name;
    const lostFile = claude.fileOf(lostName);
    const answered = claude.records(lostName).length;
    await opencode.say(lost, "Q-lost run");
    claude.state.toolTurn = true;
    claude.state.failures = ["killedBeforeFlush"];
    const queriesBefore = claude.queries.length;
    // Where the failure reaches OpenCode as a retryable HTTP error (fix/account-failures-after-tools), the user stops
    // the chat during OpenCode's retry wait, as above: the case is the leaf the dead process left.
    const stopLost = new AbortController();
    opencode.state.sleep = async () => stopLost.abort();
    await opencode.turn(lost, { toolOutput: "OUT-lost", stop: stopLost.signal });
    opencode.state.sleep = sleep;
    claude.state.failures = [];
    assert.deepEqual(claude.queries.slice(queriesBefore).map((q) => q.outcome), ["killed"], "the process died after the result");
    assert.equal(claude.records(lostName).length, answered, "the file as the process found it");
    const leaf = store.getSessionLeafUuid(lost) as string;
    for (const chunk of [16, 64, 256 * 1024]) assert.equal(store.sessionChainAfterLeaf(lostFile, leaf, chunk), "missing", `the plugin's leaf is not in the file (chunk ${chunk})`);
    // The next message resumes the session as it is.
    await opencode.say(lost, "Q-lost next");
    assert.ok((await opencode.turn(lost)).ok, "the next turn");
    assert.ok(world.journal().some((line) => line.includes("last seen entry is not in the Claude session")), "the plugin found its leaf missing");
    assert.equal(claude.queries.at(-1)!.params.resume, lostName, "resumed as it is");
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok - branched session regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
