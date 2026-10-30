/**
 * Issue case 5b, two servers: OpenChamber's OpenCode server and `opencode` in
 * a terminal run on one machine, each with the plugin, each serving its own
 * chats at the same time. Every chat keeps its Claude session: when the
 * servers start again, each chat's next turn continues its transcript.
 *
 * On `main` both processes rewrite the whole sessions.json on every streamed
 * event of every turn, without a lock: a write made from a read taken before
 * the other process's write drops that process's chats, and a read of the
 * file while the other process rewrites it finds it empty; the next server
 * finds no binding for those chats (the history goes as text).
 *
 * On the simulators (test/simulators/): this world is OpenChamber's server,
 * a second process on the same machine the terminal's
 * (`world.secondProcess`, BEHAVIOR.md "A second OpenCode server on the
 * machine"). Both serve chats, one after another; then the two servers' writes
 * meet: the terminal's server stops running in the middle of its rewrite of
 * sessions.json (`holdAtWrite`, "A server paused while it rewrites a file"),
 * as the system stops a process at any moment, and OpenChamber's serves its
 * chats meanwhile; then the terminal's runs on. A plugin that does not write
 * sessions.json is never paused: the terminal's turn ends, then OpenChamber's
 * chats are served. Then both stop, and each server's database opens in a
 * server started afresh (`opencode.database` / `openDatabase`, "OpenCode's
 * database across servers"), which sends every chat its next message; what
 * Claude Code then did (`claude.queries`: the record the turn resumed at) and
 * the journals.
 *
 * Run: bun test/issue-two-servers-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

/** The chats each server serves before the writes meet. */
const CHATS_BEFORE = 3;
/** OpenChamber's chats served while the terminal's server is paused in its rewrite. */
const CHATS_MEANWHILE = 2;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const world = await createWorld("two-servers");
  const { opencode } = world;
  const chamberChats: string[] = [];
  const terminalChats: string[] = [];
  const children: Array<{ kill: () => Promise<void> }> = [];
  try {
    await opencode.startPlugin();
    const terminal = await world.secondProcess({ label: "terminal" });
    children.push(terminal);
    await terminal.start();
    const serveChamber = async (chat: string) => {
      chamberChats.push(chat);
      opencode.newChat(chat);
      await opencode.say(chat, `hello ${chat}`);
      assert.ok((await opencode.turn(chat)).ok, `${chat}: OpenChamber's server answered`);
    };
    const sayTerminal = async (chat: string) => {
      terminalChats.push(chat);
      await terminal.call("opencode.newChat", chat);
      await terminal.call("opencode.say", chat, `hello ${chat}`);
    };

    for (let i = 1; i <= CHATS_BEFORE; i++) {
      await serveChamber(`chamber-${i}`);
      await sayTerminal(`terminal-${i}`);
      assert.ok((await terminal.call("opencode.turn", `terminal-${i}`)).ok, `terminal-${i}: the terminal's server answered`);
    }

    // The writes meet: the terminal's server stops in its rewrite of sessions.json, OpenChamber's serves chats.
    const meeting = `terminal-${CHATS_BEFORE + 1}`;
    await sayTerminal(meeting);
    const hold = await terminal.holdAtWrite("sessions.json");
    let ended = false;
    const terminalTurn = terminal.call("opencode.turn", meeting).finally(() => (ended = true));
    for (let waited = 0; !hold.held() && !ended; waited += 10) {
      assert.ok(waited < 60_000, "the terminal's turn neither ended nor rewrote sessions.json in 60 s");
      await sleep(10);
    }
    const paused = hold.held();
    for (let i = 1; i <= CHATS_MEANWHILE; i++) await serveChamber(`chamber-meanwhile-${i}`);
    await hold.release();
    assert.ok((await terminalTurn).ok, `${meeting}: the terminal's server answered`);
    console.log(`the terminal's server paused in its rewrite of sessions.json: ${paused ? "yes" : "no, it does not write the file"}`);

    // Both servers stop; each one's chats open in a server started afresh, which sends every chat its next message.
    const databases = [opencode.database(), await terminal.call("opencode.database")];
    for (const instance of [...opencode.instances]) await opencode.stopPlugin(instance);
    assert.equal(await terminal.exit(), 0, "the terminal's server exits");
    const lost: string[] = [];
    for (const [i, chats] of [chamberChats, terminalChats].entries()) {
      const next = await world.secondProcess({ label: `restarted-${i + 1}` });
      children.push(next);
      await next.call("opencode.openDatabase", databases[i]);
      await next.start();
      for (const chat of chats) {
        await next.call("opencode.say", chat, `again ${chat}`);
        const turn = await next.call("opencode.turn", chat);
        assert.ok(turn.ok, `${chat}: the next turn answered`);
        const query = await next.call("claude.queries.at", -1);
        if (query.at === null) lost.push(chat);
      }
      const journal = await next.journal();
      assert.deepEqual(journal.filter((line: string) => /level=error/.test(line)), [], "no error in the plugin's journal");
      await next.exit();
    }
    const served = chamberChats.length + terminalChats.length;
    console.log(`chats served: ${served}; continued their transcript after the restart: ${served - lost.length}`);
    assert.deepEqual(lost, [], `chats whose next turn started over with the history as text (${lost.length})`);
    console.log("ok — two servers keep every chat's session");
  } finally {
    for (const child of children) await child.kill();
    await world.dispose();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
