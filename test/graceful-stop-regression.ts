/**
 * Regression: a turn is stopped the way Claude Code's own Esc stops it.
 * - stop() interrupts first, reads the stream until the CLI reports the
 *   turn's result, then closes; a CLI that ignores the interrupt is closed
 *   after the grace period.
 * - A new turn for a chat whose earlier turn is still parked waits until
 *   that turn is interrupted and closed before spawning, and the parked tool
 *   call is rejected only after the interrupt.
 * - Two requests for one chat never spawn claude processes concurrently.
 *
 * On the simulators (test/simulators/): the user stops a turn in OpenCode
 * while its tool runs (`stopParked`: `session.execution.interrupted`) or
 * while the answer streams (`stop`), and sends the next message at once.
 * Claude Code answers an interrupt as CLI 2.1.312 does (BEHAVIOR.md "Tool
 * calls and stops"): a parked turn with a rejected result per call and
 * "[Request interrupted by user for tool use]", a streaming one with the
 * shown part and "[Request interrupted by user]", then an error result; a
 * rejection before the interrupt would end the parked turn without them.
 * Each query records when the plugin closed its process (`closedAt`);
 * `ignoreInterrupt` plays a hung CLI.
 *
 * Run: bun test/graceful-stop-regression.ts
 */
// A grace well beyond a turn's settling, under load too: a turn that settled on its result spawns the next one inside
// half of it (with 1 s, a settling under load once took 506 ms).
process.env.OPENCODE_CLAUDE_STOP_GRACE_MS = "3000";
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { createWorld } from "./simulators/world.ts";

const GRACE_MS = 3000;
const MARKER = "[Request interrupted by user for tool use]";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const world = await createWorld("graceful-stop");
  const { opencode, claude } = world;

  /** The user stops a turn parked on its tool call, then sends the next message at once. */
  async function stopParkedThenNext(label: string) {
    const chat = opencode.newChat();
    await opencode.say(chat, `${label}: run it`);
    claude.state.toolSteps = [[{ name: "bash", input: { command: "sleep 100" } }]];
    const from = claude.queries.length;
    const stopped = await opencode.turn(chat, { stopParked: true });
    assert.ok(stopped.stopped, `${label}: the user stopped the turn`);
    assert.equal(stopped.requests[0]!.reply!.finish, "tool_calls");
    const stopAt = performance.now();
    await opencode.say(chat, `${label}: next`);
    const next = await opencode.turn(chat);
    assert.ok(next.ok, `${label}: the next turn answered`);
    const [first, second] = claude.queries.slice(from);
    return { chat, first: first!, second: second!, stopAt };
  }

  try {
    await opencode.startPlugin();

    // A stopped chat's parked turn: interrupted first, its call rejected
    // after; the next turn spawns once it closed, well inside the grace.
    const parked = await (async () => {
      const { first, second, stopAt } = await stopParkedThenNext("parked");
      assert.equal(first.outcome, "stopped", "the CLI took the interrupt while the call was still pending");
      const records = claude.records(first.name);
      const marker = records.find((r) => contentText(r.message?.content) === MARKER);
      assert.ok(records.some((r) => r.toolUseResult === "User rejected tool use"), "the CLI wrote the rejected result");
      assert.ok(marker, "the CLI wrote the interruption");
      assert.equal(second.params.resume, first.name);
      assert.equal(second.at, marker!.uuid, "the next turn spawned after the interruption was written");
      assert.ok(second.startedAt - stopAt < GRACE_MS / 2, `settled on the result, not the grace (${Math.round(second.startedAt - stopAt)} ms)`);
      assert.ok(world.journal().some((line) => line.includes("closed the parked turn of a stopped session")));
      return { first, second };
    })();

    // The user stops a turn while its answer streams and sends a new message
    // at once: the new turn waits for the old one to stop.
    const streaming = await (async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "long task");
      let release!: () => void;
      claude.state.holdMidAnswer = new Promise<void>((resolve) => (release = resolve));
      claude.state.replies = ["r1 starts and never ends"];
      const stop = new AbortController();
      const from = claude.queries.length;
      const running = opencode.turn(chat, { stop: stop.signal });
      // The stop comes once the answer's first piece is on the screen (`holdMidAnswer` stalls it there), not
      // after a fixed pause: a turn that had not started its answer yet keeps the reply for the next one.
      for (let i = 0; i < 1000 && !opencode.shown(chat); i++) await sleep(10);
      assert.ok(opencode.shown(chat), "the answer started streaming before the stop");
      stop.abort();
      const stopAt = performance.now();
      const stopped = await running;
      assert.ok(stopped.stopped, "the user stopped the turn");
      await opencode.say(chat, "something else");
      const next = await opencode.turn(chat);
      assert.ok(next.ok);
      assert.match(next.answer!.text, /answer L/, "the new turn answered");
      release();
      await sleep(20);
      const [r1, r2] = claude.queries.slice(from);
      assert.equal(r1!.outcome, "stopped", "the stopped turn ended there");
      assert.ok(
        claude.records(r1!.name).some((r) => contentText(r.message?.content) === "[Request interrupted by user]"),
        "the CLI took the interrupt and wrote it",
      );
      assert.ok(!claude.records(r1!.name).some((r) => r.type === "assistant" && contentText(r.message?.content) === "r1 starts and never ends"), "no whole answer written");
      assert.ok(r2!.startedAt - stopAt < GRACE_MS / 2, `settled on the result, not the grace (${Math.round(r2!.startedAt - stopAt)} ms)`);
      return { first: r1!, second: r2! };
    })();

    // Spawns of one chat never overlap: each new turn started after the
    // stopped one's process was closed.
    for (const [label, { first, second }] of Object.entries({ parked, streaming })) {
      assert.ok(first.closedAt !== undefined && first.closedAt <= second.startedAt, `${label}: spawned only after the close`);
    }

    // A CLI that ignores the interrupt is closed after the grace; the next turn waits for that.
    {
      claude.state.ignoreInterrupt = true;
      const { first, second, stopAt } = await stopParkedThenNext("deaf");
      claude.state.ignoreInterrupt = false;
      assert.ok(!claude.records(first.name).some((r) => contentText(r.message?.content) === MARKER), "the CLI wrote no interruption");
      const closed = first.closedAt;
      assert.ok(closed !== undefined && closed - stopAt >= GRACE_MS * 0.9, `closed after the grace (${closed === undefined ? "never" : Math.round(closed - stopAt)} ms)`);
      assert.ok(second.startedAt >= closed!, "spawned only after the close");
    }

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — graceful stop regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
