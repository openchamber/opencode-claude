/**
 * Regression: a fork's first turn on Claude copies its parent's transcript
 * and reads its history from it, instead of sending the history as text.
 * The cases of the fork step (plans: fork architecture, section 8), each
 * checked by what the fork's first query copied, where it cut, what Claude
 * got, and the journal.
 *
 * On the simulators (test/simulators/, through test/fork-world.ts): OpenCode
 * makes the fork (`fork` with `through` / `before`, settled messages under new
 * ids with their metadata); Claude Code copies the parent's file as the CLI
 * does (`resume` + `forkSession: true` + `sessionId`, the same uuids; probes
 * 12, 25, 39 — BEHAVIOR.md "Names and copies"), refuses a copy
 * (`refuseCopy`) or dies as the file appears (`copyKilled`). The plugin's
 * names module through `pluginModule`. The turns of the cases (a question
 * token, a turn that must pass, the fork's first turn): fork-world.ts
 * `forkTurns`.
 *
 * Cases:
 * - through the last answer; before a question; two forks from one point;
 * - a fork of a fork after its turn (its own transcript) and before it (the
 *   grandparent's); a chain of forks beyond the limit;
 * - through a tool step in the middle of a turn: the copy ends at the step's
 *   result, found by the call's id; the result comes from the copy, not rebuilt;
 *   a fork between two calls of one step, which fails by a finding (CLI 2.1.312
 *   hangs each result off its own call), lives in
 *   fork-session-two-calls-regression.ts until the finding is fixed;
 * - before the second of two messages sent during one turn;
 * - through a message sent during the turn: the copy ends at its attachment,
 *   the step's results are not rebuilt on top of it;
 * - while the parent's answer is being written;
 * - the parent compacted after the fork, and before it, on OpenCode 2.2.0
 *   and 2.0.32 (`state.version`: the checkpoint's kept tail in another field);
 * - the parent reverted after the fork: the copy comes from the version
 *   the revert left behind;
 * - the parent never on Claude; the parent deleted;
 * - the parent's transcript never changes.
 *
 * Run: bun test/fork-session-regression.ts
 */
import assert from "node:assert/strict";

import { createForkWorld, forkTurns, tokens, type ClaudeQuery } from "./fork-world.ts";
import { testCases } from "./simulators/cases.ts";
import { pluginModule } from "./simulators/world.ts";

async function main() {
  const w = await createForkWorld();
  await w.startPlugin();
  const cases = testCases();
  const turns = forkTurns(w);
  const { q, claude, firstTurn } = turns;
  const parentFiles = () => w.snapshot();
  /** The copy's chain down to its point, as record kinds (a failed check shows it). */
  const tail = (query: ClaudeQuery) => w.chainTo(query.copiedFrom!, query.at!).slice(-4).map((r) => `${r.type}:${r.attachment?.type ?? r.message?.content?.[0]?.type ?? ""}`).join(" ");
  /**
   * The copy's last record of the conversation: the CLI writes attachments after a tool's result before the next
   * model call (a `total_tokens_reminder`, BEHAVIOR.md "Transcript files"), and a copy cut after them holds the result.
   */
  const lastBeforeAttachments = (query: ClaudeQuery) => w.chainTo(query.copiedFrom!, query.at!).findLast((r) => r.type !== "attachment")!;

  // ---- The parent: three turns on Claude. ----
  const A = w.newChat();
  await w.say(A, q()); // q1
  const a1 = await claude(A); // L1
  await w.say(A, q()); // q2
  await claude(A); // L2
  await w.say(A, q()); // q3
  await claude(A); // L3
  const FA = a1.name;
  const files = parentFiles();
  const userIds = () => w.session(A).messages.filter((m) => m.type === "user").map((m) => m.id);
  const answerIds = () => w.session(A).messages.filter((m) => m.type === "assistant").map((m) => m.id);

  // ---- Through the last answer: the whole parent, from its transcript. ----
  await cases.run("through the last answer: the whole parent from its transcript", async () => {
    const B = await w.fork(A, w.through(answerIds().at(-1)!));
    const { query, seen, forked } = await firstTurn(B);
    assert.equal(query.copiedFrom, FA, "copied from the parent's transcript");
    assert.deepEqual(seen.slice(0, 6), ["q1", "L1", "q2", "L2", "q3", "L3"], "the copy holds the parent's three turns");
    assert.equal(forked.length, 1);
    assert.equal(forked[0].outcome, "forked");
    assert.equal(forked[0].from, FA);
  });

  // ---- Before a question: the copy ends at the turn before it. ----
  await cases.run("before a question: the copy ends at the turn before it", async () => {
    const C = await w.fork(A, w.before(userIds()[2]!)); // before q3
    const { query, seen } = await firstTurn(C);
    assert.equal(query.copiedFrom, FA);
    assert.deepEqual(seen, ["q1", "L1", "q2", "L2", `q${turns.n}`], "q3 and its answer are not in the fork");
  });

  // ---- Two forks from one point: two transcripts, one source. ----
  await cases.run("two forks from one point: two transcripts, one source", async () => {
    const D1 = await w.fork(A, w.before(userIds()[1]!));
    const D2 = await w.fork(A, w.before(userIds()[1]!));
    const one = await firstTurn(D1);
    const two = await firstTurn(D2);
    assert.equal(one.query.copiedFrom, FA);
    assert.equal(two.query.copiedFrom, FA);
    assert.notEqual(one.query.name, two.query.name, "each fork its own transcript");
  });

  // ---- OpenCode does not answer the fork's reads: the first turn goes as text, it does not hang. ----
  await cases.run("OpenCode does not answer the fork's reads: the first turn goes as text", async () => {
    process.env.OPENCODE_CLAUDE_OPENCODE_READ_MS = "200";
    try {
      for (const read of ["get", "context"] as const) {
        const H = await w.fork(A, w.through(answerIds().at(-1)!));
        const before = w.journal().length;
        w.state.hangReads = read;
        const started = Date.now();
        const { query, seen, notes } = await firstTurn(H);
        w.state.hangReads = false;
        assert.match(notes, /\[claude-code warning\] This fork could not copy its parent's Claude session/, `${read}: the turn says so: ${notes}`);
        assert.ok(Date.now() - started < 5_000, `${read}: the turn waited for the limit, not for OpenCode`);
        assert.equal(query.copiedFrom, undefined, `${read}: nothing copied`);
        assert.deepEqual(seen.slice(-2), ["L3", `q${turns.n}`], `${read}: the history went as text, the question last`);
        const journal = w.journal().slice(before).join("\n");
        assert.match(journal, new RegExp(`OpenCode did not answer session\\.${read} within 200 ms`), `${read}: the journal says why`);
      }
    } finally {
      delete process.env.OPENCODE_CLAUDE_OPENCODE_READ_MS;
      w.state.hangReads = false;
    }
  });

  // ---- A fork of a fork after its turn: the copy comes from the fork's transcript. ----
  await cases.run("a fork of a fork after its turn: the copy from the fork's transcript", async () => {
    const E = await w.fork(A, w.through(answerIds().at(-1)!));
    const e = await firstTurn(E);
    const F = await w.fork(E, w.through(w.lastId(E)));
    const f = await firstTurn(F);
    assert.equal(f.query.copiedFrom, e.query.name, "from the fork's own transcript");
    const eAnswer = tokens(w.session(E).messages.at(-1)!.text);
    assert.deepEqual(f.seen.slice(0, -1), [...e.seen, ...eAnswer], "the fork's history with its own turn, then the new question");
  });

  // ---- A fork of a fork that never ran: the grandparent's transcript. ----
  await cases.run("a fork of a fork that never ran: the grandparent's transcript", async () => {
    const G = await w.fork(A, w.through(answerIds().at(-1)!));
    const H = await w.fork(G, w.through(w.lastId(G)));
    const { query, forked } = await firstTurn(H);
    assert.equal(query.copiedFrom, FA, "G has no transcript: A's is copied");
    assert.equal(forked[0].parent, A);
  });

  // ---- A chain of forks longer than the limit: the history as text. ----
  await cases.run("a chain of forks longer than the limit: the history as text", async () => {
    let chat = A;
    for (let i = 0; i < 11; i++) chat = await w.fork(chat, w.through(w.lastId(chat)));
    const { query, forked } = await firstTurn(chat);
    assert.equal(query.copiedFrom, undefined, "no copy beyond ten forks up");
    assert.equal(forked[0].outcome, "no-session");
  });

  // ---- Through a tool step in the middle of a turn: the copy ends at the step's result, found by the call's id. ----
  await cases.run("through a tool step mid-turn: the copy ends at the step's result", async () => {
    const T = w.newChat();
    await w.say(T, q());
    await claude(T);
    const asked = await w.say(T, q());
    w.state.toolTurn = true;
    await claude(T, { toolOutput: "t1" });
    const stepId = w.session(T).messages.find((m) => m.type === "assistant" && m.finish === "tool-calls")!.id;
    const U = await w.fork(T, w.through(stepId));
    const before = w.journal().length;
    const { query, seen } = await firstTurn(U);
    assert.ok(query.copiedFrom, "copied");
    const point = lastBeforeAttachments(query);
    assert.ok(point.toolUseResult !== undefined, `the copy ends at the result record (${tail(query)})`);
    const askedText = w.session(T).messages.find((m) => m.id === asked)!.text;
    assert.ok(seen.includes(askedText) && seen.includes("t1"), "the step's question and result reach Claude from the copy");
    assert.equal(seen.filter((token) => token === "t1").length, 1, "the result once, not rebuilt on top of the copy");
    assert.ok(w.journal().slice(before).some((line) => line.includes("not rebuilding the tool step")), "no step rebuilt: the result is in the copy");
    assert.ok(!seen.includes(tokens(w.session(T).messages.at(-1)!.text).at(-1)!), "the parent's answer after the step is not in the fork");
  });

  // ---- Through a tool step after a skill message (no prompt hook: a new id in the fork): the copy still ends at
  //      the step's result, found by the call's id, and the skill, the question and the result reach Claude from it. ----
  await cases.run("through a tool step after a skill message: the copy ends at the step's result", async () => {
    const K = w.newChat();
    await w.say(K, q());
    await claude(K);
    w.between(K, "skill", "k1");
    const asked = await w.say(K, q());
    w.state.toolTurn = true;
    await claude(K, { toolOutput: "t2" });
    const stepId = w.session(K).messages.find((m) => m.type === "assistant" && m.finish === "tool-calls")!.id;
    const L = await w.fork(K, w.through(stepId));
    const { query, seen } = await firstTurn(L);
    assert.ok(query.copiedFrom, "copied");
    const point = lastBeforeAttachments(query);
    assert.ok(point.toolUseResult !== undefined, `the copy ends at the result record, not before the skill (${tail(query)})`);
    const askedText = w.session(K).messages.find((m) => m.id === asked)!.text;
    // The skill message is not a token of this file's kind: read it in the view itself.
    assert.ok(query.view.split("\n").includes("k1"), `the skill message reaches Claude from the copy:\n${query.view}`);
    for (const token of [askedText, "t2"]) assert.ok(seen.includes(token), `${token} reaches Claude (seen: ${seen.join(" ")})`);
    assert.equal(seen.filter((token) => token === "t2").length, 1, "the result once");
  });

  // ---- Before the second of two messages sent during one turn. ----
  await cases.run("before the second of two messages sent during one turn", async () => {
    const S = w.newChat();
    await w.say(S, q());
    await claude(S);
    await w.say(S, q());
    w.state.toolTurn = true;
    const steer = q();
    await claude(S, { toolOutput: "t2", steer });
    const steerId = w.session(S).messages.find((m) => m.text === steer)!.id;
    const V = await w.fork(S, w.before(steerId));
    const { seen } = await firstTurn(V);
    assert.ok(!seen.includes(steer), "the message the fork does not hold is cut off");
  });

  // ---- Through a message sent during the turn: the copy ends at its attachment; the step's results are not rebuilt. ----
  await cases.run("through a message sent during the turn: the copy ends at its attachment", async () => {
    const S = w.newChat();
    await w.say(S, q());
    await claude(S);
    await w.say(S, q());
    w.state.toolTurn = true;
    const steer = q();
    await claude(S, { toolOutput: "t3", steer });
    const steerId = w.session(S).messages.find((m) => m.text === steer)!.id;
    const V = await w.fork(S, w.through(steerId));
    const before = w.journal().length;
    const { query, seen } = await firstTurn(V);
    assert.ok(query.copiedFrom, "copied");
    const point = w.chainTo(query.copiedFrom!, query.at!).at(-1)!;
    assert.equal(point.type, "attachment", "the copy ends at the absorbed message");
    assert.equal(seen.filter((token) => token === "t3").length, 1, "the result once: the copy holds it, no rebuilt step");
    assert.equal(seen.filter((token) => token === steer).length, 1, "the message once, from the copy");
    assert.ok(w.journal().slice(before).some((line) => line.includes("not rebuilding the tool step")), "no rebuilt step: the results are in the copy");
  });

  // ---- While the parent's answer is being written: the fork holds the question alone, the copy ends at it. ----
  await cases.run("while the parent's answer is being written: the copy ends at the question", async () => {
    const P = w.newChat();
    await w.say(P, q());
    await claude(P);
    const pending = q();
    await w.say(P, pending);
    let release!: () => void;
    w.state.hold = new Promise<void>((resolve) => (release = resolve));
    const running = w.turn(P);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const W = await w.fork(P, w.through(w.lastId(P)));
    release();
    await running;
    const { query, seen } = await firstTurn(W);
    assert.ok(query.copiedFrom);
    assert.equal(seen.filter((token) => token === pending).length, 1, "the unanswered question once, as part of the fork's turn");
    assert.ok(!seen.some((token) => token === tokens(w.session(P).messages.at(-1)!.text).at(-1)), "the parent's later answer is not in the fork");
  });

  // ---- The parent reverted after the fork: the copy comes from the version the revert left. ----
  await cases.run("the parent reverted after the fork: the copy from the version the revert left", async () => {
    const R = w.newChat();
    await w.say(R, q());
    const r1 = await claude(R);
    const kept = q();
    await w.say(R, kept);
    await claude(R);
    const forkPoint = w.lastId(R);
    const X = await w.fork(R, w.through(forkPoint), { silent: true });
    // The parent reverts its last turn and asks something else: a new version.
    const reverted = w.session(R).messages.find((m) => m.text === kept)!.id;
    w.undoBefore(R, reverted);
    await w.say(R, q());
    const after = await claude(R);
    assert.notEqual(after.name, r1.name, "the revert wrote a new version");
    assert.equal(after.copiedFrom, r1.name);
    const { query, seen, forked } = await firstTurn(X);
    assert.equal(query.copiedFrom, r1.name, "the fork copies the version holding its history");
    assert.ok(seen.includes(kept), "the reverted turn is in the fork, from the old version");
    assert.equal(forked[0].outcome, "forked");
  });

  // ---- The parent compacted after the fork: the fork copies the old epoch's transcript. ----
  // A fork after the compaction reads its checkpoint from session.context: OpenCode 2.2.0 gives the kept tail in
  // `metadata.recent` (read from `metadata.keepID`), 2.0.32 in `recent`; the checkpoint's text names the epoch.
  for (const version of ["2.2.0", "2.0.32"] as const) {
    await cases.run(`the parent compacted after the fork: the old epoch's transcript; a fork after it, the new epoch's (OpenCode ${version})`, async () => {
      const was = w.state.version;
      w.state.version = version;
      try {
        const K = w.newChat();
        await w.say(K, q());
        const k1 = await claude(K);
        await w.say(K, q());
        await claude(K);
        const Y = await w.fork(K, w.through(w.lastId(K)), { silent: true });
        await w.compact(K);
        await w.say(K, q());
        const k2 = await claude(K);
        assert.notEqual(k2.name, k1.name, "a new epoch, a new transcript");
        const y = await firstTurn(Y);
        assert.equal(y.query.copiedFrom, k1.name, "the fork's history is in the epoch before the compaction");
        // A fork after the compaction copies the new epoch's transcript: the checkpoint and the turn after it.
        const Z = await w.fork(K, w.through(w.lastId(K)));
        const z = await firstTurn(Z);
        assert.equal(z.query.copiedFrom, k2.name, `the new epoch's transcript: ${JSON.stringify(z.forked)}`);
        assert.equal(z.forked[0]?.outcome, "forked");
        assert.ok(z.query.view.includes("<recent-context>"), "the checkpoint with its kept tail, from the copy");
        assert.equal(z.query.view.split("<conversation-checkpoint>").length - 1, 1, "the checkpoint once: nothing sent again as text");
        assert.doesNotMatch(z.notes, /warning/);
      } finally {
        w.state.version = was;
      }
    });
  }

  // ---- The parent never on Claude: nothing to copy, the history as text. ----
  await cases.run("the parent never on Claude: the history as text", async () => {
    const O = w.newChat();
    await w.say(O, q());
    w.otherModelAnswer(O, "o1");
    const Q = await w.fork(O, w.through(w.lastId(O)));
    const { query, seen, forked, notes } = await firstTurn(Q);
    assert.equal(query.copiedFrom, undefined);
    assert.equal(forked[0].outcome, "no-session");
    assert.ok(seen.includes("o1"), "the other model's answer reaches Claude");
    assert.match(notes, /\[claude-code\] This part of the chat had no Claude session yet/, `nothing to copy is no failure: ${notes}`);
    assert.doesNotMatch(notes, /warning/);
  });

  // ---- The parent deleted before the fork's first turn: its transcript is still there. ----
  await cases.run("the parent deleted before the fork's first turn", async () => {
    const M = w.newChat();
    await w.say(M, q());
    const m1 = await claude(M);
    const N = await w.fork(M, w.through(w.lastId(M)));
    await w.remove(M);
    const { query } = await firstTurn(N);
    assert.equal(query.copiedFrom, m1.name);
  });

  const { transcriptName, FIRST_EPOCH } = await pluginModule("names");

  // ---- The copy's process killed as soon as the file appeared: the retry copies into the next version. ----
  await cases.run("the copy's process killed as the file appeared: the retry copies into the next version", async () => {
    const Kc = await w.fork(A, w.through(answerIds().at(-1)!));
    w.state.failures = ["copyKilled"];
    const { query } = await firstTurn(Kc);
    assert.equal(query.name, transcriptName(Kc, FIRST_EPOCH, 2), "version 1 is an empty file: its name is taken");
    assert.equal(query.copiedFrom, FA, "the retry copies again");
  });

  // ---- The CLI refused the copy: the retry starts over as text, no copy again. ----
  await cases.run("the CLI refused the copy: the retry as text, no copy again", async () => {
    const Rc = await w.fork(A, w.through(answerIds().at(-1)!));
    w.state.refuseCopy = true;
    const { query, seen } = await firstTurn(Rc);
    assert.equal(query.copiedFrom, undefined, "no second copy");
    assert.equal(query.name, transcriptName(Rc, FIRST_EPOCH, 2), "the refused name is not given out again");
    assert.deepEqual(seen.slice(0, 6), ["q1", "L1", "q2", "L2", "q3", "L3"], "the history as text");
  });

  // ---- A version the CLI refused leaves a gap: later versions are still found. ----
  await cases.run("a version the CLI refused leaves a gap: later versions are still found", async () => {
    const Gc = w.newChat();
    await w.say(Gc, q());
    await claude(Gc);
    const second = await w.say(Gc, q());
    await claude(Gc);
    // A revert whose copy the CLI refuses: version 2 is marked, never written; the retry writes version 3 as text.
    w.undoBefore(Gc, second);
    await w.say(Gc, q());
    w.state.refuseCopy = true;
    const retried = await claude(Gc);
    assert.equal(retried.name, transcriptName(Gc, FIRST_EPOCH, 3));
    // The next turn continues version 3.
    await w.say(Gc, q());
    const next = await claude(Gc);
    assert.equal(next.name, transcriptName(Gc, FIRST_EPOCH, 3), "past the gap at version 2");
    assert.equal(next.copiedFrom, undefined);
  });

  // ---- No fork ever changed a transcript it copied from. ----
  await cases.run("no fork changed a transcript it copied from", async () => {
    const now = parentFiles();
    for (const [file, text] of files) assert.equal(now.get(file), text, `${file} unchanged`);
  });

  await w.dispose();
  cases.done();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
