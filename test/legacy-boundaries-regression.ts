/**
 * Regression: turn boundaries stored before they carried a session id.
 *
 * Such a boundary was recorded against the binding's session. A rewind to
 * it forks that session when its file still holds the leaf; after a fork
 * the old boundaries are stamped with the session they came from. A legacy
 * boundary whose leaf is not in the binding's session (an older build
 * carried one across a session change) can't be forked: history as text.
 *
 * On the simulators (test/simulators/): the chats run in OpenCode with
 * Claude Code writing the transcripts, first under the released 1.3.0
 * itself (`world.build(releaseTree("v1.3.0"))`: its own record, its
 * `TurnBoundary = { count, hash, leafUuid }` with no `sessionId`, its own
 * fingerprints); then the user upgrades (OpenCode unloads it and loads the
 * tree under test on the same folders). Chat b's first boundary carried
 * over from another transcript is the one edit made by hand, kept as the
 * author's own case of this test ("X1 was carried over from the session
 * before legacy-b"): it checks the author's code only. No single user action
 * of 1.3.0 or 1.3.1 leaves such a boundary (every turn that replaces a
 * binding clears it first); one chat open in two OpenCode servers at once
 * comes nearest, and even then the leaf stays in the binding's own
 * transcript. The reverts after the upgrade are the
 * user's (`undoBefore`, then a new message); the tree forks through the
 * SDK's `forkSession` on the simulator's files.
 *
 * Run: bun test/legacy-boundaries-main-regression.ts
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createWorld, pluginModule, releaseTree } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("legacy-boundaries");
  const { opencode, claude } = world;
  try {
    // The user runs 1.3.0.
    const released = await world.build(releaseTree("v1.3.0"));
    let instance = await opencode.startPlugin(undefined, { setup: released.setup });
    let store = await released.module("session-store");
    const forks = () => world.journal().filter((line) => line.includes("resuming a fork of the Claude session")).map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { from: string; fork: string });
    /** The user sends a message and Claude answers: its id, the chat's leaf after it, the query. */
    const send = async (chat: string, text: string) => {
      const id = await opencode.say(chat, text);
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok, `${text}: ${turn.requests.map((r) => r.status).join(",")}`);
      const query = claude.queries.at(-1)!;
      // Transferred: this query's prompt carries the history (not a resumed record of an earlier one).
      return { id, leaf: store.getSessionLeafUuid(chat) as string, query, transferred: JSON.stringify(query.input.map((i) => i.content)).includes("<conversation_history>") };
    };
    const where = (chat: string) => (store.getSessionTurns(chat) as Array<{ sessionId?: string; leafUuid?: string }>).map((t) => `${t.sessionId}:${t.leafUuid}`);
    /** The record a fork's copy of `uuid` got (the SDK's forkSession: fresh uuids, `forkedFrom`). */
    const copyOf = (fork: string, from: string, uuid: string) => claude.records(fork).find((r) => r.forkedFrom?.sessionId === from && r.forkedFrom?.messageUuid === uuid)?.uuid;

    const a = opencode.newChat();
    const a1 = await send(a, "u1");
    const a2 = await send(a, "u2");
    const a3 = await send(a, "u3");
    const legacyA = a1.query.name;
    assert.ok([a2, a3].every((t) => t.query.params.resume === legacyA), "one transcript for chat a");

    const b = opencode.newChat();
    await send(b, "u1");
    const b2 = await send(b, "u2");
    await send(b, "u3");
    const legacyB = b2.query.params.resume as string;
    // The session chat b had before: another transcript, whose leaf the old build carried over.
    const before = opencode.newChat();
    const carried = (await send(before, "u1 in the session before")).leaf;

    // The user upgrades: OpenCode unloads 1.3.0, the record is as 1.3.0 left it, the tree under test loads.
    await opencode.stopPlugin(instance);
    const storeFile = join(process.env.XDG_DATA_HOME!, "opencode-claude", "sessions.json");
    const record = JSON.parse(readFileSync(storeFile, "utf8")) as Record<string, { turns: Array<Record<string, unknown>> } & Record<string, unknown>>;
    assert.equal(record[a]!.turns.length, 3);
    assert.equal(record[b]!.turns.length, 3);
    assert.ok([...record[a]!.turns, ...record[b]!.turns].every((turn) => !("sessionId" in turn) && typeof turn.leafUuid === "string"), "1.3.0's boundaries: a leaf, no session id");
    // The one edit by hand (above): chat b's first boundary carried over from the session before.
    record[b]!.turns[0]!.leafUuid = carried;
    writeFileSync(storeFile, JSON.stringify(record, null, 2) + "\n");
    instance = await opencode.startPlugin();
    store = await pluginModule("session-store");

    // Legacy boundary in the binding's own session: fork from it.
    opencode.undoBefore(a, a3.id);
    const n3 = await send(a, "u3 edited");
    assert.equal(forks().length, 1);
    const fork1 = forks()[0]!.fork;
    assert.equal(forks()[0]!.from, legacyA);
    const copyA2 = copyOf(fork1, legacyA, a2.leaf);
    assert.ok(copyA2, "the fork is cut at the second turn's leaf");
    assert.deepEqual({ resume: n3.query.params.resume, transferred: n3.transferred }, { resume: fork1, transferred: false });
    // The fork stamped the older legacy boundary with where it came from.
    assert.deepEqual(where(a), [`${legacyA}:${a1.leaf}`, `${fork1}:${copyA2}`, `${fork1}:${n3.leaf}`]);
    // And a rewind across that fork still forks from legacy-a.
    opencode.undoBefore(a, a2.id);
    const n2 = await send(a, "u2 edited");
    assert.equal(forks().length, 2);
    const fork2 = forks()[1]!.fork;
    assert.equal(forks()[1]!.from, legacyA);
    assert.ok(copyOf(fork2, legacyA, a1.leaf), "the fork is cut at the first turn's leaf");
    assert.deepEqual({ resume: n2.query.params.resume, transferred: n2.transferred }, { resume: fork2, transferred: false });
    assert.ok(!n2.query.view.includes("u3") && !n2.query.view.includes("u2\n"), `Claude sees no undone message: ${n2.query.view}`);

    // Legacy boundary whose leaf isn't in the binding's session: text.
    opencode.undoBefore(b, b2.id);
    const m2 = await send(b, "u2 edited");
    assert.deepEqual({ resume: m2.query.params.resume, transferred: m2.transferred }, { resume: undefined, transferred: true });
    assert.equal(forks().length, 2);
    assert.notEqual(m2.query.name, legacyB);
    assert.equal(store.getForeignSessionId(b), m2.query.name);
    assert.ok(world.journal().some((line) => line.includes("OpenCode history no longer matches the Claude session; transferring history")));
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok - legacy boundaries regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
