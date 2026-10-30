/**
 * Regression: a chat request OpenCode drops before its turn starts (the user
 * stopped it while it waited for the chat's queue or while its turn was
 * planned) starts no Claude process. OpenCode's stop came while there was no
 * turn to stop; a process started afterwards answered the stopped message,
 * wrote it into the transcript and spent the plan's usage (the monkey found
 * it: a stop 20 ms after the request, on a slow process, landed in the
 * planning). The dropped request does not stop the turn that held the queue
 * either. A turn stopped after OpenCode's hooks ran and before its HTTP
 * request leaves its list behind: the next request takes the list it was
 * built from and drops the stale one (context-list.ts).
 *
 * No race in the test: the first turn holds the chat's queue until its start
 * returns, the second request is dropped once it holds its place in the
 * chat's queue (bridge-pool's chat locks), then the first turn is let go.
 *
 * On the simulators (test/simulators/): two turns of one chat in the OpenCode
 * simulator, the second stopped by the user (`turn` with `stop`); the first
 * query's start held by the Claude Code simulator (`claude.state.holdStart`,
 * counted in `claude.heldStarts`); Claude's starts counted in
 * `claude.queries`; the drop read in the plugin's journal. A turn stopped
 * before its request: `turn` with a signal aborted already (the hooks run,
 * no request is sent).
 *
 * Run: bun test/stopped-request-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const world = await createWorld("stopped-request");
  const { opencode, claude } = world;
  const cases = testCases();
  try {
    await opencode.startPlugin();

    await cases.run("a request stopped while it waits for the chat's queue starts no Claude process and stops no other turn", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "first");
      const before = claude.queries.length;
      const starts = () => claude.queries.slice(before).filter((q) => q.kind === "chat").length;

      // The first turn's start holds the chat's queue until the test lets it go.
      let releaseFirst!: () => void;
      const held = claude.heldStarts;
      claude.state.holdStart = new Promise<void>((resolve) => (releaseFirst = resolve));
      claude.state.replies = ["ok"];
      const first = opencode.turn(chat);
      for (let i = 0; claude.heldStarts === held && i < 500; i++) await sleep(10);
      assert.equal(claude.heldStarts, held + 1, "the first turn is starting");
      assert.equal(starts(), 0, "its start is held: no query yet");

      // The second request waits for the queue; the user stops it there, once it holds its place in the chat's
      // queue (bridge-pool's chat locks: a new tail for the chat).
      const { bridgeRuntime } = await pluginModule("bridge-pool");
      const locks: Map<string, Promise<void>> = bridgeRuntime.chatLocks;
      const firstPlace = locks.get(chat);
      assert.ok(firstPlace, "the first turn holds the chat's queue");
      await opencode.say(chat, "second");
      const stop = new AbortController();
      const second = opencode.turn(chat, { stop: stop.signal });
      for (let i = 0; locks.get(chat) === firstPlace && i < 500; i++) await sleep(10);
      assert.notEqual(locks.get(chat), firstPlace, "the second request took its place in the chat's queue");
      stop.abort();
      const dropped = await second;
      assert.ok(dropped.stopped, "the client dropped the second request");

      // The first start is let go once the client dropped the request: OpenCode
      // and the plugin's server share one process, so its `req.signal` is
      // aborted by then (20 runs in a row, 29.10.2026). The hold stands for a
      // slow start: a real one takes 5-18 ms (test/simulators BEHAVIOR.md
      // "A start that takes time").
      releaseFirst();
      const answer = await first;
      const reply = answer.requests.at(-1)!.reply;
      assert.equal(answer.requests.at(-1)!.status, 200, reply?.raw ?? "");
      assert.ok(answer.ok);
      assert.equal(reply!.text, "ok", "the turn that held the queue is not stopped by the dropped request");

      // The dropped request's handler ends without a start.
      const line = "the request was dropped before its turn started";
      for (let i = 0; !world.journal().some((l) => l.includes(line)) && i < 200; i++) await sleep(10);
      assert.equal(starts(), 1, "no Claude process for the dropped request");
      const drops = world.journal().filter((l) => l.includes(line));
      assert.equal(drops.length, 1, "the journal says the dropped request started nothing");
      assert.match(drops[0]!, /"planned":false/, "dropped while waiting, before its turn was planned");
    });

    await cases.run("a turn stopped after its hooks leaves its list: the next request takes its own list and drops the stale one", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "Q-stale asked");
      const queries = claude.queries.length;
      const stop = new AbortController();
      stop.abort();
      const stopped = await opencode.turn(chat, { stop: stop.signal });
      assert.ok(stopped.stopped, "the turn was stopped");
      assert.equal(stopped.requests[0]!.status, 0, "no request was sent");
      assert.equal(claude.queries.length, queries, "Claude was not asked");
      // The user writes on: the next request's list holds the new message, the stale one does not fit it.
      await opencode.say(chat, "Q-stale next");
      const journalBefore = world.journal().length;
      const next = await opencode.turn(chat);
      assert.ok(next.ok, `the request after the stopped one answered: ${next.requests.at(-1)?.status}`);
      assert.ok(claude.queries.at(-1)!.view.includes("Q-stale next"), "planned on its own list");
      const { takeContextEvent } = await pluginModule("context-list");
      assert.equal(takeContextEvent(chat), undefined, "no list left behind");
      const journal = world.journal().slice(journalBefore);
      const dropped = journal.filter((line) => line.includes("dropped the list of a chat request that never arrived") && line.includes(`"sessionID":"${chat}"`));
      assert.equal(dropped.length, 1, journal.join("\n"));
      assert.match(dropped[0]!, /level=info/, "routine: the request's own list was found");
      assert.match(dropped[0]!, /"dropped":1.*"found":true/);
      assert.ok(!journal.some((line) => line.includes("does not match OpenCode's message list")), "the request matched its list");
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
