/**
 * Regression: the session store is written only when a binding changes,
 * and transcript lookups find entries anywhere in a large file, including
 * across the border of two read chunks.
 *
 * On the simulators (test/simulators/): the plugin's own writes of its
 * record of the chats (sessions.json), watched while real turns run. The
 * events of a turn after its answer's record carry the session and no new
 * leaf: the answer's stream stalls before its end (`stallBeforeStop`) until
 * the test has seen the leaf. A new session: the user pruned Claude's
 * projects folder (the transcript is gone); a binding cleared: another model
 * compacted the chat (`compactElsewhere`). The lookups run on a transcript
 * the Claude Code simulator wrote, made large by a tool's long output; a
 * revert to the chat's first turn finds its leaf behind it.
 *
 * Run: bun test/store-writes-main-regression.ts
 */
import assert from "node:assert/strict";
import { existsSync, rmSync, statSync, watch } from "node:fs";
import { join } from "node:path";

import { createWorld, pluginModule } from "./simulators/world.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const world = await createWorld("store-writes");
  const { opencode, claude } = world;
  const folder = join(process.env.XDG_DATA_HOME!, "opencode-claude");
  let writes = 0;
  const watcher = watch(folder, (_event, file) => {
    if (file === "sessions.json") writes++;
  });
  /** The writes of sessions.json so far, once the file system has reported them. */
  const written = async () => {
    await sleep(150);
    return writes;
  };
  try {
    await opencode.startPlugin();
    const store = await pluginModule("session-store");
    const chat = opencode.newChat();

    /**
     * A turn whose answer stalls once its record is written: `atLeaf` runs then (the binding's leaf is the
     * answer's record), the turn ends after it. Returns the answer's record and the writes made after `atLeaf`.
     */
    const stalledTurn = async (text: string, atLeaf: (leaf: string) => Promise<void> | void = () => {}) => {
      await opencode.say(chat, text);
      let release!: () => void;
      claude.state.stallBeforeStop = new Promise<void>((resolve) => (release = resolve));
      const from = claude.queries.length;
      // The records of earlier turns (a resumed session's file holds them).
      const earlier = new Set(claude.queries.flatMap((q) => claude.records(q.name).map((r) => r.uuid)));
      const turn = opencode.turn(chat);
      let answer: string | undefined;
      for (let waited = 0; !answer; waited += 10) {
        assert.ok(waited < 10_000, `${text}: the answer's record within 10 s`);
        await sleep(10);
        const query = claude.queries[from];
        const leaf = store.getSessionLeafUuid(chat) as string | undefined;
        if (query && leaf && !earlier.has(leaf) && claude.records(query.name).some((r) => r.type === "assistant" && r.uuid === leaf)) answer = leaf;
      }
      await atLeaf(answer);
      const before = await written();
      release();
      const ended = await turn;
      assert.ok(ended.ok, `${text}: the turn answered`);
      return { answer, query: claude.queries[from]!, after: (await written()) - before };
    };

    // The first turn binds the chat; the events after its answer's record bring nothing new: no write.
    const first = await stalledTurn("one");
    const session = store.getForeignSessionId(chat) as string;
    assert.equal(session, first.query.name);
    assert.equal(first.after, 0, "the turn's events with no new leaf do not write the store");
    assert.equal(store.getSessionLeafUuid(chat), first.answer);

    // The next turn's records are new leaves: written.
    const beforeSecond = await written();
    const second = await stalledTurn("two");
    assert.equal(second.after, 0);
    assert.ok((await written()) > beforeSecond, "a new leaf is written");
    assert.equal(store.getForeignSessionId(chat), session);
    assert.equal(store.getSessionLeafUuid(chat), second.answer);

    // A new session (the transcript is gone): bound and written, without the old chain's leaf.
    rmSync(claude.fileOf(session));
    assert.equal(store.sessionFileHasEntry(claude.fileOf(session), second.answer), false, "no entry in a missing file");
    const beforeNew = await written();
    const fresh = await stalledTurn("three", (leaf) => {
      assert.notEqual(store.getForeignSessionId(chat), session);
      assert.ok(claude.records(store.getForeignSessionId(chat) as string).some((r) => r.uuid === leaf), "the leaf is the new session's");
    });
    assert.ok(world.journal().some((line) => line.includes("stored Claude session file missing")));
    assert.notEqual(fresh.query.name, session);
    assert.equal(store.getForeignSessionId(chat), fresh.query.name);
    assert.ok((await written()) > beforeNew, "a new session is written");

    // Cleared (another model compacted the chat), then bound again: written.
    opencode.compactElsewhere(chat);
    const beforeCleared = await written();
    const rebound = await stalledTurn("four");
    assert.ok(world.journal().some((line) => line.includes("OpenCode history no longer matches the Claude session") && line.includes('"match":"diverged"')));
    assert.notEqual(rebound.query.name, fresh.query.name);
    assert.equal(store.getForeignSessionId(chat), rebound.query.name);
    assert.equal(store.getSessionLeafUuid(chat), rebound.answer);
    assert.ok((await written()) > beforeCleared, "the binding after a clear is written");
    assert.equal(rebound.after, 0);

    // A large transcript: a tool's long output after the chat's first turn of this session.
    claude.state.toolTurn = true;
    const logAsked = await opencode.say(chat, "read the log");
    const long = Array.from({ length: 6000 }, (_, i) => `line ${i} ${"x".repeat(i % 53)}`).join("\n");
    assert.ok((await opencode.turn(chat, { toolOutput: long })).ok);
    const after = await stalledTurn("five");
    const name = after.query.name;
    assert.equal(name, rebound.query.name, "the same session");
    const file = claude.fileOf(name);
    assert.ok(statSync(file).size > 512 * 1024, `a transcript larger than two of the plugin's chunks: ${statSync(file).size}`);
    const uuids = claude.records(name).flatMap((r) => (r.uuid ? [r.uuid] : []));
    const picked = [...new Set([uuids[0]!, uuids[1]!, uuids[Math.floor(uuids.length / 2)]!, uuids.at(-2)!, uuids.at(-1)!, rebound.answer, after.answer])];
    for (const chunk of [7, 64, 1000, 1 << 20]) {
      for (const uuid of picked) assert.ok(store.sessionFileHasEntry(file, uuid, chunk), `${uuid} with ${chunk}-byte chunks`);
      assert.equal(store.sessionFileHasEntry(file, uuid4Like(), chunk), false, "an entry not in the file");
      assert.equal(store.sessionFileHasEntry(file, rebound.answer.slice(1), chunk), false, "whole uuid only");
      assert.equal(store.sessionFileHasEntry(file, rebound.answer.slice(0, -1), chunk), false, "whole uuid only");
    }

    // The plugin's own lookup: a revert to the session's first turn finds its leaf behind the long output and
    // resumes a fork cut there.
    const firstLeaf = (store.getSessionTurns(chat) as Array<{ leafUuid?: string }>)[0]!.leafUuid;
    assert.equal(firstLeaf, rebound.answer, "the session's first boundary is the first turn's answer");
    opencode.undoBefore(chat, logAsked);
    const forksBefore = world.journal().filter((line) => line.includes("resuming a fork of the Claude session")).length;
    await opencode.say(chat, "four again");
    assert.ok((await opencode.turn(chat)).ok);
    const forks = world.journal().filter((line) => line.includes("resuming a fork of the Claude session")).slice(forksBefore);
    assert.equal(forks.length, 1, "the revert resumed a fork");
    const fork = (JSON.parse(forks[0]!.slice(forks[0]!.indexOf("{"))) as { from: string; fork: string }).fork;
    assert.equal(claude.records(fork).filter((r) => r.forkedFrom).at(-1)!.forkedFrom.messageUuid, rebound.answer, "cut at the first turn's leaf");

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    assert.ok(existsSync(join(folder, "sessions.json")));
  } finally {
    watcher.close();
    await world.dispose();
  }
  console.log("ok — store writes regression passed");
}

/** A uuid no record has. */
function uuid4Like(): string {
  return "00000000-0000-4000-8000-000000000000";
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
