/**
 * Regression: where a fork's first turn cuts its parent's transcript, from
 * the fork's messages as session.context gives them (session-fork.ts
 * contextList) and the parent's transcript (turn-point.ts planCopy). The
 * rule: the copy ends at the record of the last screen message that has an
 * id in the transcript; a tool step is found by the id of its call, which
 * the CLI gives and the plugin hands to OpenCode (probe 43); an answer in
 * words is reached from the record before it. Cases, the parent of probe 26
 * (q10 → call 1 → result → q20 absorbed → call 2 → result → q30 absorbed →
 * answer) unless said otherwise:
 * - through a tool step in the middle of a turn, then another model's turn,
 *   then Claude: the copy ends at the step's result, not at the parent's answer;
 * - before the second of two messages sent during one turn: at the second
 *   result;
 * - before the first message sent during the turn: at the first result;
 * - while the second step runs (the fork holds the first message sent during
 *   the turn): at the attachment of that message, the CLI's records after it;
 * - while the first step runs (the fork holds the question alone): at the
 *   question;
 * - through the answer after both messages: at the answer, service records
 *   after it included;
 * - the screen's answer is another model's (Claude's turn failed): at the
 *   failed turn, the other model's answer as text;
 * - a fork made while the parent was answering: at the question, the answer
 *   the screen lacks left out;
 * - the file's first model call asked for a tool (the CLI's full
 *   `prompt_snapshot` behind the result): through the step, then another
 *   model's turn, and before the message sent during the turn — at the
 *   snapshot, the step's result with it, the message not;
 * - a stopped turn: at the rejected result, the record of the stop with it;
 * - the step's results reached Claude as text (a rebuilt step): at the step's record;
 * - the step's results never reached Claude: at the call record;
 * - a call the CLI's MCP server rejected by itself, inside a turn the screen holds whole;
 * - two calls of one answer shown step by step, a fork through the message
 *   sent between them: no call is copied without its result;
 * - a stopped answer: the screen shows the part the CLI wrote, and the CLI's
 *   part is in the copy;
 * - a stopped answer the CLI finished all the same (a CLI that does not stop):
 *   the screen holds its start, the file the whole — at the question, the
 *   start sent as missed;
 * - a reminder spliced between the question and the answer;
 * - a missed record named after another model's turn that ended on a step;
 * - a message sent again after a failure (two attempts): the later attempt
 *   in file order, also when a killed process appended its answer under the
 *   first one later;
 * - an answer of reasoning alone is an answer, a user message of a skill
 *   alone is a message;
 * - nothing of the screen in the parent's transcript.
 *
 * On the simulators (test/simulators/): the parent is a chat in OpenCode
 * (tool steps, a message sent while a tool runs, another model's answers,
 * failures and stops as Claude Code has them), the fork OpenCode's own
 * (`fork` with `through` / `before`), and the copy the CLI's (`resume` +
 * `forkSession: true` + `sessionId`, the parent's uuids; probes 12, 25, 39 —
 * BEHAVIOR.md "Names and copies"). Where the copy was cut: the fork's first
 * query (`copiedFrom`, `at`), the parent's records down to that point
 * (`claude.chainTo`), what Claude saw, and the plugin's journal ("forked chat",
 * "resuming the chat's Claude transcript" with the messages missed).
 * Each scenario is a case of its own. The world, its steps and the parents
 * both fork-list files fork from: test/fork-world.ts `createForkListWorld`.
 * The cases that fail by a finding (the fork path's candidates, a fork
 * through a step of two calls) live in fork-list-path-candidates-regression.ts
 * until the finding is fixed.
 *
 * Run: bun test/fork-list-regression.ts
 */
import assert from "node:assert/strict";

import { callsOf, createForkListWorld, isService, resultsOf, type Msg } from "./fork-world.ts";
import { testCases } from "./simulators/cases.ts";

async function main() {
  const {
    world, opencode, claude, stepRecordName, userRecordName, contextList,
    turn, ask, steps, message, lastAnswer, transcriptOf, answerRecord, firstTurn, copied, describe, after, fieldsOf,
    rebuiltStepParent, twoCallsParent, reminderParent, otherModelStepParent,
  } = await createForkListWorld("fork-list");
  const scenarios: Array<[string, () => Promise<void>]> = [];
  const scenario = (name: string, run: () => Promise<void>) => scenarios.push([name, run]);

  // ---- The parent of probe 26: q0 → a0, q10 → call 1 → result → q20 absorbed → call 2 → result → q30 absorbed →
  //      answer. On the screen: q0 a0 q10 s1 q20 s2 q30 answer. ----
  const P = opencode.newChat();
  let probe26!: { name: string; q10: string; q20: string; q30: string; s1: Msg; s2: Msg; answer: Msg };
  const parent26 = async () => {
    await ask(P, "q0");
    const q10 = await opencode.say(P, "q10");
    claude.state.toolSteps = [1, 1];
    await turn(P, { toolOutput: "t-probe26", steer: ["q20", "q30"] });
    const [s1, s2] = steps(P);
    assert.ok(s1 && s2, "two steps on the parent's screen");
    probe26 = { name: transcriptOf(P), q10, q20: message(P, "q20").id, q30: message(P, "q30").id, s1: s1!, s2: s2!, answer: lastAnswer(P) };
    assert.deepEqual(opencode.session(P).messages.map((m) => (m.type === "user" ? m.text : m.finish)), ["q0", "stop", "q10", "tool-calls", "q20", "tool-calls", "q30", "stop"], "the screen of probe 26");
    const absorbed = claude.records(probe26.name).filter((r) => r.attachment?.type === "queued_command").map((r) => r.attachment!.prompt);
    assert.deepEqual(absorbed, ["q20", "q30"], "the parent absorbed both messages, one after each step's result");
  };

  scenario("through a tool step, then another model's turn, then Claude: the copy ends at the step's result", async () => {
    const U = await opencode.fork(P, opencode.through(probe26.s1.id));
    await opencode.say(U, "q3");
    opencode.otherModelAnswer(U, "o3");
    const f = await firstTurn(U);
    copied(f, "through s1");
    assert.deepEqual(resultsOf(f.point!), [probe26.s1.toolCalls![0]!.id], `the copy ends at the step's result (${f.point!.type})`);
    assert.ok(!f.chain.some((r) => callsOf(r).includes(probe26.s2.toolCalls![0]!.id)), "the parent's later step is not in the fork");
    assert.ok(!f.view.includes(probe26.answer.text), "nor its answer");
    assert.equal(f.plan.missed, 2, "the other model's turn goes as missed: q3 and o3");
    assert.ok(/q3[\s\S]*o3[\s\S]*next/.test(f.view), `Claude reads q3 and o3 before the new question: ${f.view}`);
  });

  scenario("before the second of two messages sent during one turn (probe 26): the copy ends at the second result", async () => {
    const U = await opencode.fork(P, opencode.before(probe26.q30));
    const f = await firstTurn(U);
    copied(f, "before q30");
    assert.deepEqual(resultsOf(f.point!), [probe26.s2.toolCalls![0]!.id], "the copy ends at the second result");
    assert.ok(!f.chain.some((r) => r.attachment?.prompt === "q30"), "q30's attachment is not in the copy");
    assert.ok(!f.view.split("\n").includes("q30"), `q30 does not reach Claude: ${f.view}`);
    assert.equal(f.plan.missed, 0, "the step's results are covered: nothing before the new question is missed");
    assert.ok(!f.view.includes(probe26.answer.text), "the parent's answer is not in the fork");
  });

  scenario("before the message sent during the turn: the copy ends at the first result, the absorbed message not in it", async () => {
    assert.ok(claude.records(probe26.name).some((r) => r.attachment?.type === "queued_command" && r.attachment?.prompt === "q20"), "the parent absorbed q20");
    const U = await opencode.fork(P, opencode.before(probe26.q20));
    const f = await firstTurn(U);
    copied(f, "before q20");
    assert.deepEqual(resultsOf(f.point!), [probe26.s1.toolCalls![0]!.id], "the copy ends at the first result");
    assert.ok(!f.chain.some((r) => r.attachment?.type === "queued_command"), "q20's attachment is not in the copy");
    assert.ok(!f.view.split("\n").includes("q20"), `q20 does not reach Claude: ${f.view}`);
    assert.equal(f.plan.missed, 0);
  });

  scenario("while the second step runs (the fork holds q20): the copy ends at q20's attachment", async () => {
    const U = await opencode.fork(P, opencode.through(probe26.q20));
    const f = await firstTurn(U);
    copied(f, "through q20");
    const q20 = f.chain.find((r) => r.attachment?.type === "queued_command");
    assert.equal(q20?.attachment?.prompt, "q20", `q20's attachment is in the copy: ${describe(f.chain)}`);
    const rest = after(f.chain, q20!.uuid!);
    assert.ok(rest.every(isService), `the copy ends at the absorbed message, the CLI's records after it: ${describe(rest)}`);
    assert.ok(!f.chain.some((r) => callsOf(r).includes(probe26.s2.toolCalls![0]!.id)), "the second step is not in the fork");
    assert.equal(f.plan.missed, 0);
  });

  scenario("while the first step runs (the fork holds the question alone): the copy ends at the question", async () => {
    const U = await opencode.fork(P, opencode.through(probe26.q10));
    const f = await firstTurn(U);
    copied(f, "through q10");
    const question = userRecordName(probe26.q10, 1);
    assert.ok(f.chain.some((r) => r.uuid === question), "the question's record is in the copy");
    const rest = after(f.chain, question);
    assert.ok(rest.every(isService), `after the question only the CLI's own records: ${rest.map((r) => r.type).join(",")}`);
    assert.equal(f.plan.missed, 0);
  });

  scenario("through the answer after both messages sent during the turn: the whole turn, the CLI's records after the answer included", async () => {
    const U = await opencode.fork(P, opencode.through(probe26.answer.id));
    const f = await firstTurn(U);
    copied(f, "through the answer");
    assert.deepEqual(f.chain.filter((r) => r.attachment?.type === "queued_command").map((r) => r.attachment!.prompt), ["q20", "q30"], "both absorbed messages are in the copy");
    const answer = answerRecord(probe26.name, probe26.answer.text);
    assert.ok(answer, "the parent's answer record");
    const rest = after(f.chain, answer!.uuid!);
    assert.ok(rest.every(isService), `the copy ends at the answer, the CLI's records after it: ${rest.map((r) => r.attachment?.type ?? r.type).join(",")}`);
    assert.equal(f.plan.missed, 0, "the answer is covered: nothing before the new question is missed");
  });

  scenario("the screen's answer is another model's (Claude's turn failed): the copy ends at the failed turn", async () => {
    const C = opencode.newChat();
    await opencode.say(C, "q-france");
    claude.state.failures = ["creditBalance"];
    const failed = await opencode.turn(C);
    assert.ok(!failed.ok, "Claude's turn failed (no retry: a billing error)");
    opencode.otherModelAnswer(C, "o-paris");
    const U = await opencode.fork(C, opencode.through(opencode.lastId(C)));
    const f = await firstTurn(U);
    copied(f, "after a failed turn");
    assert.equal(f.point!.isApiErrorMessage, true, `the copy ends at the failed turn's record (${f.point!.type})`);
    assert.equal(f.plan.missed, 1, "the other model's answer is not covered: it goes as missed");
    assert.ok(f.view.includes("o-paris"), "the other model's answer reaches Claude as text");
  });

  scenario("a fork made while the parent was answering: the copy ends at the question, the later answer left out", async () => {
    const W = opencode.newChat();
    await ask(W, "q-france-2");
    const pending = await opencode.say(W, "q-germany");
    let release!: () => void;
    claude.state.hold = new Promise<void>((resolve) => (release = resolve));
    const running = opencode.turn(W);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The answer is still being written: OpenCode copies the settled messages, through the question.
    const U = await opencode.fork(W, opencode.through(opencode.lastId(W)));
    release();
    assert.ok((await running).ok);
    const later = lastAnswer(W).text;
    const f = await firstTurn(U);
    copied(f, "while answering");
    const question = userRecordName(pending, 1);
    const rest = after(f.chain, question);
    assert.ok(rest.every(isService), `after the question only the CLI's own records: ${rest.map((r) => r.type).join(",")}`);
    assert.ok(!f.view.includes(later), "the parent's later answer is not in the fork");
    assert.equal(f.view.split("\n").filter((line) => line === "q-germany").length, 1, "the unanswered question once");
  });

  scenario("the file's first model call asked for a tool: the CLI's snapshot after the result goes with the step", async () => {
    const F = opencode.newChat();
    await opencode.say(F, "q-f10");
    claude.state.toolSteps = [1];
    await turn(F, { toolOutput: "t-f", steer: "q-f20" });
    const [step] = steps(F);
    const name = transcriptOf(F);
    // The CLI's full prompt_snapshot behind the result of the file's first call (BEHAVIOR.md "Transcript files").
    const records = claude.records(name);
    const result = records.find((r) => resultsOf(r).includes(step!.toolCalls![0]!.id))!;
    const snapshot = records.find((r) => r.parentUuid === result.uuid);
    assert.equal(snapshot?.attachment?.type, "prompt_snapshot", `the CLI wrote its snapshot behind the result: ${describe(claude.chainTo(name, claude.leafOf(name)!.uuid!))}`);
    for (const [label, fork] of [
      ["through the step, then another model's turn", async () => {
        const U = await opencode.fork(F, opencode.through(step!.id));
        await opencode.say(U, "q-f3");
        opencode.otherModelAnswer(U, "o-f3");
        return U;
      }],
      ["before the message sent during the turn", () => opencode.fork(F, opencode.before(message(F, "q-f20").id))],
    ] as const) {
      const f = await firstTurn(await fork());
      copied(f, label);
      assert.equal(f.point!.uuid, snapshot!.uuid, `${label}: the copy ends at the CLI's snapshot after the step's result: ${describe(f.chain)}`);
      assert.ok(!f.chain.some((r) => r.attachment?.type === "queued_command"), `${label}: q-f20's attachment is not in the copy`);
      assert.ok(!f.view.split("\n").includes("q-f20"), `${label}: q-f20 does not reach Claude: ${f.view}`);
      assert.equal(f.plan.missed, label.startsWith("through") ? 2 : 0, `${label}: only another model's turn goes as missed`);
    }
  });

  scenario("a stopped turn: the copy ends at the rejected result and the CLI's record of the stop", async () => {
    const S = opencode.newChat();
    await opencode.say(S, "q-stop-tool");
    claude.state.toolTurn = true;
    const stopped = await opencode.turn(S, { stopParked: true });
    assert.ok(stopped.stopped, "the user stopped the turn while its tool ran");
    const name = transcriptOf(S);
    for (let waited = 0; claude.recordText(claude.leafOf(name)!) !== "[Request interrupted by user for tool use]"; waited += 20) {
      assert.ok(waited < 5_000, "the CLI wrote the end of the stopped turn");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [step] = steps(S);
    const U = await opencode.fork(S, opencode.through(step!.id));
    const f = await firstTurn(U);
    copied(f, "a stopped turn");
    assert.equal(claude.recordText(f.point!), "[Request interrupted by user for tool use]", "the CLI's record of the stop is the point");
    assert.ok(f.chain.some((r) => resultsOf(r).includes(step!.toolCalls![0]!.id)), "the rejected result is in the copy");
    assert.equal(f.plan.missed, 0);
  });

  scenario("the step's results reached Claude as text (a rebuilt step): the step's record is found by name", async () => {
    const { K, step } = await rebuiltStepParent();
    const name = transcriptOf(K);
    const stepRecord = stepRecordName([step!.toolCalls![0]!.id], 1);
    assert.ok(claude.records(name).some((r) => r.uuid === stepRecord), "the parent's file holds the step's record under its name");
    // Through the answer: the answer follows the step's record.
    {
      const U = await opencode.fork(K, opencode.through(lastAnswer(K).id));
      const f = await firstTurn(U);
      copied(f, "rebuilt step, through the answer");
      const answer = answerRecord(name, lastAnswer(K).text)!;
      assert.ok(f.chain.some((r) => r.uuid === stepRecord), "the step's record is in the copy");
      assert.ok(after(f.chain, answer.uuid!).every(isService), "the copy ends at the answer that follows it");
      assert.equal(f.plan.missed, 0);
    }
    // Through the step: the step's record is the point (with the CLI's records after it).
    {
      const U = await opencode.fork(K, opencode.through(step!.id));
      const f = await firstTurn(U);
      copied(f, "rebuilt step, through the step");
      assert.ok(after(f.chain, stepRecord).every(isService), `the copy ends at the step's record: ${f.point!.type}`);
      assert.equal(f.plan.missed, 0);
    }
  });

  scenario("the step's results never reached Claude: the call record is the point", async () => {
    const N = opencode.newChat();
    await ask(N, "q-n0");
    await opencode.say(N, "q-n1");
    claude.state.toolTurn = true;
    // The process dies while its call runs; the user stops the turn as the tool ends: no request carries the results.
    claude.state.failures = ["killedWhileTool"];
    const stop = new AbortController();
    const stopped = await opencode.turn(N, { stop: stop.signal, toolOutput: () => (stop.abort(), "t-never") });
    assert.ok(stopped.stopped, "the turn was stopped after the tool ended");
    const [step] = steps(N);
    assert.equal(step?.toolResults?.[0]?.output, "t-never", "the result is on the screen");
    const U = await opencode.fork(N, opencode.through(step!.id));
    const f = await firstTurn(U);
    copied(f, "results never sent");
    assert.deepEqual(callsOf(f.point!), [step!.toolCalls![0]!.id], `the call record is the point (${f.point!.type})`);
    assert.ok(!f.chain.some((r) => resultsOf(r).length > 0), "the copy holds no result: the step's result on the screen is not covered");
    assert.equal(f.view.split("\n").filter((line) => line === "t-never").length, 1, `the result reaches Claude once, as a rebuilt step after the call: ${f.view}`);
    assert.ok(f.lines.some((l) => l.includes("rebuilding the turn with them") && l.includes(`"conversationKey":"${U}"`)), "the journal says the step was rebuilt");
    assert.ok(f.view.includes(f.question), "the new question reaches Claude");
  });

  scenario("a call the CLI's MCP server rejected by itself does not cut the answer the screen holds", async () => {
    const X = opencode.newChat();
    await opencode.say(X, "q-x");
    claude.state.toolSteps = [[{ name: "bash", input: { command: "ls" } }], [{ name: "no-such-tool", input: {} }]];
    await turn(X, { toolOutput: "t-ok" });
    assert.equal(steps(X).length, 1, "OpenCode saw only the call it runs");
    const name = transcriptOf(X);
    assert.ok(claude.records(name).some((r) => callsOf(r).some((id) => id.endsWith("_1a"))), "the parent's file holds the rejected call");
    const U = await opencode.fork(X, opencode.through(lastAnswer(X).id));
    const f = await firstTurn(U);
    copied(f, "a rejected call");
    assert.ok(after(f.chain, answerRecord(name, lastAnswer(X).text)!.uuid!).every(isService), "the copy ends at the answer");
    assert.equal(f.plan.missed, 0);
  });

  scenario("two calls of one answer shown step by step, a fork through q-y2: no call copied without its result", async () => {
    const label = "through q-y2";
    const { Y } = await twoCallsParent();
    const U = await opencode.fork(Y, opencode.through(message(Y, "q-y2").id));
    const f = await firstTurn(U);
    copied(f, label);
    const results = new Set(f.chain.flatMap(resultsOf));
    assert.ok(f.chain.flatMap(callsOf).every((id) => results.has(id)), `${label}: no call is copied without its result: ${describe(f.chain)}`);
    assert.ok(f.view.includes("t-ab"), `${label}: the first call's result reaches Claude`);
  });

  scenario("a stopped answer: the screen shows the part the CLI wrote", async () => {
    const S = opencode.newChat();
    await ask(S, "q-s1");
    await opencode.say(S, "q-s2");
    claude.state.replies = ["Paris, the capital of France."];
    let release!: () => void;
    claude.state.holdMidAnswer = new Promise<void>((resolve) => (release = resolve));
    const stop = new AbortController();
    const running = opencode.turn(S, { stop: stop.signal });
    // The user stops once the answer's start is on the screen (the CLI process starts first: no fixed wait).
    for (let i = 0; i < 1000 && !opencode.shown(S).startsWith("Paris"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    stop.abort();
    const stopped = await running;
    // The plugin's interrupt reaches the CLI while its answer still waits: the hold is let go once the query ended.
    const query = claude.queries.findLast((q) => q.kind === "chat")!;
    for (let waited = 0; query.endedAt === undefined; waited += 10) {
      assert.ok(waited < 10_000, "the CLI ended the stopped turn");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    claude.state.replies = [];
    assert.ok(stopped.stopped, "the user stopped the turn while the answer streamed");
    const shown = opencode.session(S).messages.at(-1)!;
    assert.ok(shown.type === "assistant" && shown.error === "interrupted" && shown.text, `OpenCode kept the part it showed: ${JSON.stringify(shown)}`);
    const name = transcriptOf(S);
    const part = claude.records(name).findLast((r) => r.type === "assistant" && claude.recordText(r) && "Paris, the capital of France.".startsWith(claude.recordText(r)));
    assert.ok(part, "the CLI wrote the part it streamed");
    const U = await opencode.fork(S, opencode.through(shown.id));
    const f = await firstTurn(U);
    copied(f, "a stopped answer");
    assert.ok(f.chain.some((r) => r.uuid === part!.uuid), `a stopped answer the screen shows whole (${JSON.stringify(shown.text)}): the CLI's part (${JSON.stringify(claude.recordText(part!))}) is in the copy (point ${f.point!.type} "${claude.recordText(f.point!)}", missed ${f.plan.missed})`);
    assert.equal(f.plan.missed, 0, "the shown part is in the copy, not sent again as missed");
  });

  scenario("a stopped answer the CLI finished all the same: the screen holds its start, the file the whole", async () => {
    const H = opencode.newChat();
    await ask(H, "q-h1");
    const asked = await opencode.say(H, "q-h2");
    const whole = "HUNG-START and the rest of the answer the screen never got.";
    claude.state.replies = [whole];
    // A CLI that does not stop on the plugin's interrupt (BEHAVIOR.md "Tool calls and stops", `ignoreInterrupt`).
    claude.state.ignoreInterrupt = true;
    let release!: () => void;
    claude.state.holdMidAnswer = new Promise<void>((resolve) => (release = resolve));
    const stop = new AbortController();
    try {
      const running = opencode.turn(H, { stop: stop.signal });
      for (let i = 0; i < 1000 && !opencode.shown(H).startsWith("HUNG-START"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      stop.abort();
      assert.ok((await running).stopped, "the user stopped the turn while the answer streamed");
      release();
      const query = claude.queries.findLast((q) => q.kind === "chat")!;
      for (let waited = 0; query.endedAt === undefined; waited += 20) {
        assert.ok(waited < 5_000, "the CLI ended its turn");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      claude.state.ignoreInterrupt = false;
      claude.state.replies = [];
    }
    const shown = opencode.session(H).messages.at(-1)!;
    assert.ok(shown.type === "assistant" && shown.error === "interrupted" && shown.text && shown.text !== whole && whole.startsWith(shown.text), `OpenCode kept the start it showed: ${JSON.stringify(shown)}`);
    const name = transcriptOf(H);
    const written = answerRecord(name, whole);
    assert.ok(written, "the CLI's file holds the whole answer");
    const U = await opencode.fork(H, opencode.through(shown.id));
    const f = await firstTurn(U);
    copied(f, "a stopped answer finished by the CLI");
    assert.ok(after(f.chain, userRecordName(asked, 1)).every(isService), `the copy ends at the question: ${describe(f.chain)}`);
    assert.ok(!f.view.includes(whole), `the whole answer the screen never showed does not reach the fork's Claude: ${f.view}`);
    assert.equal(f.plan.missed, 1, "the screen's start goes as missed");
    assert.equal(f.view.split("\n").filter((line) => line.includes(shown.text)).length, 1, `the screen's start reaches Claude once: ${f.view}`);
  });

  scenario("a reminder spliced between the question and the answer: the answer is reached past it", async () => {
    const M = await reminderParent();
    const U = await opencode.fork(M, opencode.through(lastAnswer(M).id));
    const f = await firstTurn(U);
    copied(f, "a reminder");
    const answer = lastAnswer(M).text;
    assert.equal(f.view.split("\n").filter((line) => line.includes(answer)).length, 1, `the answer reaches Claude once: ${f.view}`);
  });

  scenario("a missed record named after another model's turn that ended on a step", async () => {
    const { M, other } = await otherModelStepParent();
    const U = await opencode.fork(M, opencode.through(other.id));
    const f = await firstTurn(U);
    copied(f, "another model's step");
    assert.equal(f.view.split("\n").filter((line) => line.includes("t-other")).length, 1, `the other model's step reaches Claude once: ${f.view}`);
  });

  scenario("two attempts of one message: the later one in file order, its turn", async () => {
    const A = opencode.newChat();
    await ask(A, "q-a1");
    const asked = await opencode.say(A, "q-a2");
    claude.state.failures = ["overloaded"];
    await turn(A);
    assert.ok(opencode.retries.some((r) => r.chat === A), "OpenCode sent the message again");
    const name = transcriptOf(A);
    const U = await opencode.fork(A, opencode.through(lastAnswer(A).id));
    const f = await firstTurn(U);
    copied(f, "two attempts");
    assert.ok(f.chain.some((r) => r.uuid === userRecordName(asked, 2)), "the second attempt's record is in the copy");
    assert.ok(!f.chain.some((r) => r.uuid === userRecordName(asked, 1)), "the first attempt's is not");
    assert.ok(after(f.chain, answerRecord(name, lastAnswer(A).text)!.uuid!).every(isService), "the copy ends at the second attempt's answer");
    assert.equal(f.plan.missed, 0);
  });

  scenario("a killed process answered later under the first attempt, after the retry's records: the retry's turn", async () => {
    const Z = opencode.newChat();
    await ask(Z, "q-z1");
    const z1 = lastAnswer(Z);
    const asked = await opencode.say(Z, "q-z8");
    claude.state.failures = ["zombie"];
    await turn(Z);
    claude.state.zombies.shift()!();
    const name = transcriptOf(Z);
    const retried = answerRecord(name, lastAnswer(Z).text)!;
    const late = claude.leafOf(name)!;
    assert.notEqual(late.uuid, retried.uuid, "the late answer is the file's last record, under the first attempt");
    assert.equal(late.parentUuid !== null && claude.chainTo(name, late.uuid!).some((r) => r.uuid === userRecordName(asked, 1)), true);
    const U = await opencode.fork(Z, opencode.through(lastAnswer(Z).id));
    const f = await firstTurn(U);
    // The retry's answer is off the file's leaf chain, where the CLI does not copy (probe 39): the cut
    // moves to where the retry's branch leaves it, q-z1's answer, and the retry's turn goes as missed.
    assert.ok(!f.view.includes(claude.recordText(late)), `the late answer never reaches the fork's Claude: ${f.view}`);
    assert.equal(f.view.split("\n").filter((line) => line.includes(lastAnswer(Z).text)).length, 1, "the retry's answer reaches it once");
    assert.ok(!f.chain.some((r) => r.uuid === late.uuid), "the copy does not hold the late answer");
    copied(f, `a late answer (${f.forked?.outcome}: ${f.forked?.why ?? ""})`);
    assert.ok(after(f.chain, answerRecord(name, z1.text)!.uuid!).every(isService), `the copy ends at q-z1's answer: ${describe(f.chain)}`);
    assert.equal(f.plan.missed, 2, "q-z8 and the retry's answer go as missed");
    const moved = f.lines.filter((l) => l.includes("the resume point is off the transcript's leaf chain") && l.includes(`"conversationKey":"${U}"`)).map(fieldsOf);
    assert.deepEqual(moved.map((m) => [m.transcript, m.ancestor]), [[name, f.point!.uuid]], "the journal names the move");
  });

  scenario("an answer of reasoning alone is an answer, a message of a skill alone is a message", async () => {
    const Q = opencode.newChat();
    await opencode.say(Q, "q-think");
    claude.state.thinking = "думаю…";
    claude.state.replies = [""];
    try {
      await turn(Q);
    } finally {
      claude.state.thinking = undefined;
      claude.state.replies = [];
    }
    const thought = lastAnswer(Q);
    assert.ok(thought.text === "" && thought.reasoning === "думаю…", `an answer of reasoning alone on the screen: ${JSON.stringify(thought)}`);
    await opencode.say(Q, "", undefined, { skills: [{ name: "review", text: "Skill: review" }] });
    await turn(Q);
    const U = await opencode.fork(Q, opencode.through(lastAnswer(Q).id));
    const { list } = contextList(await opencode.context({ sessionID: U }));
    assert.deepEqual(list.map((m: { role: string }) => m.role), ["user", "assistant", "user", "assistant"], "every message of the fork is in the list, the reasoning answer and the skill message too");
    const f = await firstTurn(U);
    copied(f, "reasoning alone, a skill alone");
    assert.ok(after(f.chain, answerRecord(transcriptOf(Q), lastAnswer(Q).text)!.uuid!).every(isService), `the copy ends at the second answer: ${describe(f.chain)}`);
    assert.equal(f.plan.missed, 0);
  });

  scenario("nothing of the fork's screen in the parent's transcript: no copy, the history as text", async () => {
    const E = opencode.newChat();
    const first = await ask(E, "q-e1");
    // The parent reverts its only Claude turn and another model answers the next question: the transcript holds none of it.
    opencode.undoBefore(E, first);
    await opencode.say(E, "q-e2");
    opencode.otherModelAnswer(E, "o-e2");
    const U = await opencode.fork(E, opencode.through(opencode.lastId(E)));
    const f = await firstTurn(U);
    assert.equal(f.forked?.outcome, "nothing-before", `the journal says nothing could be copied (${JSON.stringify(f.forked)})`);
    assert.equal(f.query.copiedFrom, undefined, "nothing copied");
    assert.ok(/q-e2[\s\S]*o-e2[\s\S]*next/.test(f.view), `the history goes as text: ${f.view}`);
  });

  const cases = testCases();
  try {
    await opencode.startPlugin();
    await cases.run("the parent of probe 26: two steps, a message absorbed after each", parent26);
    for (const [name, run] of scenarios) await cases.run(name, run);
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
