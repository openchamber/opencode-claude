/**
 * A turn's Claude Code process is closed when nobody can use it any more: a
 * stopped OpenCode session closes its parked turn at once (the other chats'
 * turns untouched), a turn silent after its start fails truthfully through
 * the stall watchdog, and a client going away mid-answer tears the turn
 * down.
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): Claude Code holds the
 * answer (`hold`: silent after its init; `holdMidAnswer` with
 * `ignoreInterrupt`: a hung CLI after its first delta), the user stops the
 * turn in OpenCode (the request aborted, or session.execution.interrupted for
 * a parked turn), and each query records when the plugin closed its process
 * (`closedAt`). Independent cases (test/simulators/cases.ts).
 *
 * Run: bun test/turn-teardown-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { CONFIRM_MS } from "./simulators/claude-code.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("turn-teardown");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();

/** The journal has no error line (the plugin's `level=error`). */
const noJournalErrors = (what: string) =>
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], `${what}: no error in the plugin's journal`);
/** Waits until `ready()` holds (a background step of the plugin), at most `ms`. */
const until = async (ready: () => boolean, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `${what}: not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const released: Array<() => void> = [];
/** Runs `body` with the turn stall watchdog at `stallMs`. */
const withStall = async (stallMs: string, body: () => Promise<void>) => {
  const prev = process.env.OPENCODE_CLAUDE_TURN_STALL_MS;
  process.env.OPENCODE_CLAUDE_TURN_STALL_MS = stallMs;
  try {
    await body();
  } finally {
    claude.state.ignoreInterrupt = false;
    claude.state.replies = [];
    for (const release of released.splice(0)) release();
    if (prev === undefined) delete process.env.OPENCODE_CLAUDE_TURN_STALL_MS;
    else process.env.OPENCODE_CLAUDE_TURN_STALL_MS = prev;
  }
};

await cases.run("a stopped session closes its parked turn right away, another chat's parked turn untouched", async () => {
  // Two chats, each turn parked on its tool call while OpenCode runs the tool; the user stops one of them
  // (session.execution.interrupted).
  const stopped = opencode.newChat();
  const running = opencode.newChat();
  await opencode.say(stopped, "run ls");
  await opencode.say(running, "run ls");
  // The other chat's tool is still running in OpenCode: its turn stays parked.
  let finishTool!: (output: string) => void;
  const toolDone = new Promise<string>((resolve) => (finishTool = resolve));
  claude.state.toolTurn = true;
  const runningTurn = opencode.turn(running, { toolOutput: () => toolDone });
  try {
    await until(() => opencode.session(running).messages.some((m) => m.toolCalls?.length), "the other chat's turn parked");
    const runningQuery = claude.queries.at(-1)!;
    claude.state.toolTurn = true;
    const stop = await opencode.turn(stopped, { stopParked: true });
    assert.equal(stop.stopped, true);
    const stoppedQuery = claude.queries.at(-1)!;
    assert.notEqual(stoppedQuery, runningQuery);
    // Leaves the pool at once; the process closes after the stop settles.
    await until(() => stoppedQuery.closedAt !== undefined, "the stopped chat's Claude Code process closed", 2_000);
    assert.ok(
      world.journal().some((line) => line.includes("closed the parked turn of a stopped session") && line.includes(stopped)),
      "the journal names the stopped session",
    );
    assert.equal(runningQuery.closedAt, undefined, "the other chat's turn is untouched");
  } finally {
    finishTool("done");
  }
  const finished = await runningTurn;
  claude.state.toolTurn = false;
  assert.ok(finished.ok, `the other chat's turn answered: ${finished.requests.at(-1)?.status}`);
  noJournalErrors("a stopped session");
});

await cases.run("a turn silent after its start fails with a truthful 500 and its process is closed", async () => {
  // Through the pre-content probe: the stall watchdog, not the response held open forever.
  await withStall("2000", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "STALL");
    const journalFrom = world.journal().length;
    const queriesFrom = claude.queries.length;
    claude.state.hold = new Promise<void>((resolve) => released.push(resolve));
    const turn = await opencode.turn(chat);
    const first = turn.requests[0]!;
    assert.equal(first.status, 500, `silent turn must fail with a truthful HTTP error: ${first.reply?.raw}`);
    assert.match(String(JSON.parse(first.reply!.raw!).error?.message ?? ""), /no output/);
    assert.ok(first.doneAt - first.sentAt < 15_000, "stall watchdog took too long to fire");
    assert.notEqual(claude.queries[queriesFrom]!.closedAt, undefined, "stalled turn must close the CLI process");
    assert.ok(turn.ok, "OpenCode sent it again and the next query answered");
    const journal = world.journal().slice(journalFrom);
    assert.ok(journal.some((line) => /turn failed fast/.test(line) && /produced no output/.test(line)), `the journal records the stalled turn: ${journal.join("\n")}`);
  });
});

await cases.run("the client going away mid-answer closes the turn's process", async () => {
  // Instead of leaking a live CLI and bridge nobody can resume. The stall watchdog is moved out of the way and the
  // CLI ignores the interrupt, so only the plugin's close can end it.
  await withStall("60000", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "CANCEL");
    const queriesFrom = claude.queries.length;
    const journalFrom = world.journal().length;
    claude.state.holdMidAnswer = new Promise<void>((resolve) => released.push(resolve));
    claude.state.ignoreInterrupt = true;
    claude.state.replies = ["FIRST_CHUNK and the rest that never comes"];
    const stop = new AbortController();
    const running = opencode.turn(chat, { stop: stop.signal });
    // The CLI starts the turn once it reads its input (`CONFIRM_MS` after the process was handed the query, as measured
    // live) and streams its first delta at once; then the plugin has a moment to pass it on.
    await until(() => claude.queries.length > queriesFrom, "the query started");
    const query = claude.queries[queriesFrom]!;
    const turnStarts = (query.handedAt ?? query.startedAt) + CONFIRM_MS.startingNew;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, turnStarts - performance.now()) + 300));
    stop.abort();
    const stopped = await running;
    assert.ok(stopped.stopped, "the user stopped the turn");
    assert.match(stopped.requests[0]!.reply?.text ?? "", /FIRST_CHUNK/, "the first chunk reached OpenCode");
    const cancelDeadline = Date.now() + 5_000;
    while (query.closedAt === undefined && Date.now() < cancelDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.notEqual(query.closedAt, undefined, "client cancel must close the orphaned CLI process");
    // Either the aborted response's cancel() or OpenCode's stop event (session.execution.interrupted) closes it:
    // OpenCode aborts the request first but both reach the plugin asynchronously, so their order is not fixed
    // (BEHAVIOR.md "Reading the answer; a stop or a broken stream"). What the user sees is the same either way.
    const journal = world.journal().slice(journalFrom);
    assert.deepEqual(journal.filter((line) => /level=error/.test(line)), [], `no error in the plugin's journal: ${journal.join("\n")}`);
  });
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
