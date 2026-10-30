/**
 * Regression: the resume point of a chat turn (src/turn-point.ts). OpenCode's
 * message list names the records a transcript should hold; the last record
 * found by name, in file order, gives the point: the end of its turn. One
 * rule for a plain continuation, a retry, a message absorbed mid-turn, a turn
 * a lost process finished later, a stopped turn, a CLI compaction boundary,
 * and an answer the CLI took back. A tool step whose results come
 * with no parked turn is rebuilt only when the transcript does not hold them.
 * A retry or a stopped turn branches the same file, no copy. The records are
 * read from the file with what the plugin decides by, not the payloads.
 *
 * How missed messages and a checkpoint reach Claude (records of their own
 * from chain/record-per-message on) is turn-point-records-regression's; a
 * revert's copy (from chain/fork-copy on) turn-point-copy-regression's.
 *
 * On the simulators (test/simulators/): the user's chats in OpenCode, each
 * case as it comes about; the point the plugin chose is the query's `resume`
 * / `resumeSessionAt` (and the plan's line in the journal, with its attempt and
 * missed messages), the record's name the query's `trigger`, a tool step the
 * transcript holds the journal's "not rebuilding the tool step". The end of a
 * turn is the transcript's last chain record right after it
 * (`claude.leafOf`). The parser (`parseTranscript` of the tree under test) on
 * the file a chat wrote. Claude Code's ways of ending a turn early: a process
 * killed right after a tool's result (`killedAfterResult`) or before it
 * flushed (`killedBeforeFlush`); a stop while the CLI had more of the answer
 * than OpenCode had read (`unreadAtStop` with `holdMidAnswer` or `hold`); an
 * answer the CLI took back (`malformedToolUse`: the record after it hangs off
 * a uuid the file does not hold).
 *
 * Run: bun test/turn-point-regression.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { testCases } from "./simulators/cases.ts";
import { MALFORMED_TOOL_USE_TEXT } from "./simulators/claude-code.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

/** A transcript record as turn-point.ts reads it (TranscriptRecord), the fields these cases read. */
type TranscriptRecord = {
  line: number;
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  message?: { role?: string; content?: any };
  attachment?: { type?: string; source_uuid?: string };
  toolUseResult?: unknown;
  [key: string]: unknown;
};

async function main() {
  const world = await createWorld("turn-point");
  const { opencode, claude } = world;
  const { FIRST_EPOCH, TRANSCRIPT_START_NAME, stepRecordName, transcriptName, userRecordName } = await pluginModule("names");
  const { isPromptRecord, parseTranscript } = await pluginModule("turn-point");
  const cases = testCases();
  /** The plugin's plans of a chat's turns, from the journal: the point, the attempt, the messages missed. */
  const plansOf = (chat: string) =>
    world
      .journal()
      .filter((line) => line.includes("resuming the chat's Claude transcript"))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { conversationKey: string; transcript: string; version: number; point: string; attempt: number; missed: number })
      .filter((plan) => plan.conversationKey === chat);
  /** How many turns of a chat found the tool step's results in the transcript and did not rebuild the step. */
  const takenSteps = (chat: string) =>
    world.journal().filter((line) => /not rebuilding the tool step: the transcript holds its results|the transcript holds the tool step's results; not rebuilding it/.test(line) && line.includes(`"conversationKey":"${chat}"`)).length;
  const chatQueries = () => claude.queries.filter((q) => q.kind === "chat");
  const textOfInput = (query: (typeof claude.queries)[number]) => JSON.stringify(query.input.filter((i) => !i.noTurn).map((i) => i.content));
  /** The transcript a query wrote: a new one or a copy under `sessionId`, else the one it resumed. */
  const writtenBy = (query: (typeof claude.queries)[number]) => String(query.params.forkSession || !query.params.resume ? query.params.sessionId : query.params.resume);
  /**
   * A new chat: its first transcript's name, the end of each turn by its message's text (in the
   * transcript the turn wrote), and a turn that must pass.
   */
  const newChat = () => {
    const id = opencode.newChat();
    const name = transcriptName(id, FIRST_EPOCH, 1);
    const ends = new Map<string, string>();
    const ask = async (text: string, options: Parameters<typeof opencode.turn>[1] = {}) => {
      const message = await opencode.say(id, text);
      const from = claude.queries.length;
      const turn = await opencode.turn(id, options);
      assert.ok(turn.ok, `${text}: ${turn.requests.map((r) => r.status).join(",")}`);
      const query = chatQueries().at(-1)!;
      ends.set(text, claude.leafOf(writtenBy(query))!.uuid!);
      return { message, turn, query, queries: claude.queries.slice(from) };
    };
    return { id, name, ends, ask };
  };
  const pointOf = (query: (typeof claude.queries)[number]) => [query.params.resume, query.params.resumeSessionAt];
  const recordAt = (name: string, uuid: string | undefined) => claude.records(name).find((r) => r.uuid === uuid)!;
  const lines = (view: string) => view.split("\n");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    await opencode.startPlugin();

    await cases.run("a plain continuation: nothing named yet, a new transcript; then the end of the transcript", async () => {
      const chat = newChat();
      const first = await chat.ask("q1");
      assert.deepEqual([first.query.params.resume, first.query.params.sessionId, first.query.trigger], [undefined, chat.name, userRecordName(first.message, 1)]);
      const second = await chat.ask("q2");
      assert.deepEqual(pointOf(second.query), [chat.name, chat.ends.get("q1")]);
      assert.deepEqual([plansOf(chat.id).at(-1)!.point, plansOf(chat.id).at(-1)!.attempt, plansOf(chat.id).at(-1)!.missed], [chat.ends.get("q1"), 1, 0]);
    });

    await cases.run("a retry of the same message after a failed turn: the next attempt, before the failed one, the same file", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = ["serverError"];
      const retried = await chat.ask("q2");
      const [failed, again] = retried.queries;
      assert.equal(failed!.outcome, "serverError", "the first attempt failed after the CLI wrote its record");
      assert.deepEqual([...pointOf(failed!), failed!.trigger], [chat.name, chat.ends.get("q1"), userRecordName(retried.message, 1)]);
      assert.deepEqual([...pointOf(again!), again!.trigger], [chat.name, chat.ends.get("q1"), userRecordName(retried.message, 2)]);
      assert.equal(again!.params.forkSession, undefined, "the same file, not a copy");
      assert.equal(plansOf(chat.id).at(-1)!.attempt, 2);
    });

    await cases.run("two failed attempts: the third, at the same point", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = ["serverError", "serverError"];
      const retried = await chat.ask("q2");
      assert.deepEqual(
        retried.queries.map((q) => [...pointOf(q), q.trigger]),
        [1, 2, 3].map((attempt) => [chat.name, chat.ends.get("q1"), userRecordName(retried.message, attempt)]),
      );
      assert.equal(plansOf(chat.id).at(-1)!.attempt, 3);
    });

    await cases.run("the first message's turn failed: its retry resumes at the record the transcript starts with", async () => {
      const chat = newChat();
      claude.state.failures = ["serverError"];
      const first = await chat.ask("q1");
      const [failed, again] = first.queries;
      assert.deepEqual([failed!.params.sessionId, failed!.trigger], [chat.name, userRecordName(first.message, 1)]);
      assert.deepEqual([...pointOf(again!), again!.trigger], [chat.name, TRANSCRIPT_START_NAME, userRecordName(first.message, 2)]);
    });

    await cases.run("killed before the answer, every attempt, then another question: the killed question's records end its turn", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.failures = Array.from({ length: 11 }, () => "killed" as const);
      const killed = await opencode.say(chat.id, "q2");
      const gone = await opencode.turn(chat.id);
      assert.ok(!gone.ok, "OpenCode gave up after its retries");
      assert.deepEqual(claude.state.failures, [], "every attempt was killed");
      const killedEnd = claude.leafOf(chat.name)!.uuid!;
      assert.equal(claude.leafOf(chat.name)!.type, "attachment", "the CLI wrote its attachments after the prompt, then died");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, killedEnd]);
      assert.ok(claude.chainTo(chat.name, killedEnd).some((r) => r.uuid === userRecordName(killed, 11)), "the point is the end of the last killed attempt");
      assert.ok(textOfInput(next.query).includes("q3") && !textOfInput(next.query).includes("q2"), `the prompt is the new question alone: ${textOfInput(next.query)}`);
    });

    await cases.run("plan mode's reminder after the prompt belongs to the turn it follows: nothing missed", async () => {
      const chat = newChat();
      await chat.ask("q1");
      await opencode.say(chat.id, "q2");
      opencode.between(chat.id, "synthetic", "<system-reminder>plan</system-reminder>");
      assert.ok((await opencode.turn(chat.id)).ok);
      const end = claude.leafOf(chat.name)!.uuid;
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, end]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 0, "the reminder after the prompt is not missed");
    });

    await cases.run("a message absorbed mid-turn is found through its attachment; the turn's end is the final answer", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.toolTurn = true;
      await chat.ask("list files", { toolOutput: "a.txt", steer: "and count them" });
      const steer = opencode.session(chat.id).messages.find((m) => m.text === "and count them")!.id;
      assert.ok(claude.records(chat.name).some((r) => r.type === "attachment" && r.attachment?.source_uuid === userRecordName(steer, 1)), "the CLI took the message into the turn");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("list files")]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 0, "the absorbed message is not missed");
    });

    await cases.run("two messages sent while one tool ran: each absorbed under its own name; the second undone, the walk stops at the first", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.toolTurn = true;
      const sent: string[] = [];
      await chat.ask("list files", {
        toolOutput: async () => {
          sent.push(await opencode.say(chat.id, "m1"));
          sent.push(await opencode.say(chat.id, "m2"));
          return "a.txt";
        },
      });
      const absorbed = claude.records(chat.name).filter((r) => r.type === "attachment" && r.attachment?.type === "queued_command");
      assert.deepEqual(absorbed.map((r) => r.attachment.source_uuid), sent.map((id) => userRecordName(id, 1)), "each message under its own name");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("list files")]);
      assert.equal(plansOf(chat.id).at(-1)!.missed, 0, "neither message is missed");
      opencode.undoBefore(chat.id, sent[1]!);
      const taken = takenSteps(chat.id);
      const after = await chat.ask("q4");
      assert.deepEqual(pointOf(after.query), [chat.name, absorbed[0]!.uuid]);
      assert.equal(takenSteps(chat.id), taken + 1, "the transcript holds the step's results");
      assert.ok(lines(after.query.view).includes("m1") && !lines(after.query.view).includes("m2"), `Claude reads the first message, not the undone one: ${after.query.view}`);
    });

    await cases.run("a rebuilt tool step has a record of its own; the next turn resumes after its answer", async () => {
      const chat = newChat();
      await chat.ask("q1");
      process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS = "100";
      claude.state.toolTurn = true;
      let late: Awaited<ReturnType<typeof chat.ask>>;
      try {
        late = await chat.ask("run it", {
          toolOutput: async () => {
            await sleep(500);
            return "late";
          },
        });
      } finally {
        delete process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS;
      }
      const call = late.turn.requests[0]!.reply!.toolCalls[0]!.id;
      assert.equal(late.query.trigger, stepRecordName([call], 1), "the step is rebuilt under its calls' name");
      // The wait ran out: the CLI rejected the call and wrote its interruption; the results were not taken.
      assert.equal(claude.recordText(recordAt(chat.name, late.query.params.resumeSessionAt)), "[Request interrupted by user for tool use]");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("run it")]);
    });

    await cases.run("a rebuilt tool step with a message sent while the tool ran: the record that brings both is named after the message", async () => {
      const chat = newChat();
      await chat.ask("q1");
      process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS = "100";
      claude.state.toolTurn = true;
      let late: Awaited<ReturnType<typeof chat.ask>>;
      try {
        late = await chat.ask("run it", {
          toolOutput: async () => {
            await sleep(500);
            return "late";
          },
          steer: "meanwhile",
        });
      } finally {
        delete process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS;
      }
      const steer = opencode.session(chat.id).messages.find((m) => m.text === "meanwhile")!.id;
      assert.equal(late.query.trigger, userRecordName(steer, 1));
      assert.equal(claude.recordText(recordAt(chat.name, late.query.params.resumeSessionAt)), "[Request interrupted by user for tool use]");
      assert.ok(late.query.view.includes("late") && late.query.view.includes("meanwhile"), `Claude reads the results and the message: ${late.query.view}`);
    });

    await cases.run("the process died while the tool ran: the step is rebuilt under its calls' name, after the call", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.toolTurn = true;
      claude.state.failures = ["killedWhileTool"];
      const taken = takenSteps(chat.id);
      const lost = await chat.ask("run it", { toolOutput: "out" });
      const call = lost.turn.requests[0]!.reply!.toolCalls[0]!.id;
      const [killed, rebuilt] = lost.queries;
      assert.equal(killed!.outcome, "killed");
      assert.equal(rebuilt!.trigger, stepRecordName([call], 1));
      const point = recordAt(chat.name, rebuilt!.params.resumeSessionAt);
      assert.ok(point.type === "assistant" && point.message.content.some((block: any) => block.type === "tool_use"), `the point is Claude's call: ${JSON.stringify(point)}`);
      assert.equal(takenSteps(chat.id), taken, "the results were not in the transcript");
    });

    await cases.run("a process killed right after it wrote a tool's result and its snapshot: service records alone are no continuation, the step is rebuilt", async () => {
      const chat = newChat();
      claude.state.toolTurn = true;
      claude.state.failures = ["killedAfterResult"];
      const taken = takenSteps(chat.id);
      const lost = await chat.ask("run it", { toolOutput: "OUT-after-result" });
      const call = lost.turn.requests[0]!.reply!.toolCalls[0]!.id;
      const [killed, rebuilt] = lost.queries;
      assert.match(killed!.outcome, /killed/);
      // The file holds the result and the CLI's records after it: the snapshot, the tokens left, the next request's lines.
      const result = claude.records(chat.name).find((r) => r.type === "user" && r.message?.content?.[0]?.tool_use_id === call);
      assert.ok(result, "the result is on disk");
      assert.ok(claude.records(chat.name).some((r) => r.attachment?.type === "prompt_snapshot" && r.parentUuid === result!.uuid), "the full snapshot after it");
      assert.equal(rebuilt!.trigger, stepRecordName([call], 1), "the step is rebuilt");
      const point = recordAt(chat.name, rebuilt!.params.resumeSessionAt);
      assert.ok(point && point.type === "attachment", `the point is the last service record after the result: ${JSON.stringify(point)}`);
      assert.equal(takenSteps(chat.id), taken, "the result alone is no continuation");
      assert.ok(rebuilt!.view.includes("OUT-after-result"), `Claude reads the result: ${rebuilt!.view}`);
    });

    await cases.run("a process killed before it flushed a tool step: the file is as it was, the step is rebuilt after the earlier turn", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.toolTurn = true;
      claude.state.failures = ["killedBeforeFlush"];
      const lost = await chat.ask("run it", { toolOutput: "OUT-unflushed" });
      const call = lost.turn.requests[0]!.reply!.toolCalls[0]!.id;
      const [killed, rebuilt] = lost.queries;
      assert.match(killed!.outcome, /killed/);
      assert.ok(!claude.records(chat.name).some((r) => r.uuid === killed!.trigger), "the killed turn's question never reached the file");
      assert.equal(rebuilt!.trigger, stepRecordName([call], 1), "the step is rebuilt");
      assert.ok(rebuilt!.view.includes("run it") && rebuilt!.view.includes("OUT-unflushed"), `Claude reads the question and the result: ${rebuilt!.view}`);
    });

    await cases.run("the model call after the tool's result failed: no step rebuilt, the point is the error record, the absorbed message takes its next attempt", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.toolTurn = true;
      claude.state.failures = ["serverError"];
      claude.state.failingCall = 2;
      const taken = takenSteps(chat.id);
      const failed = await chat.ask("run it", { toolOutput: "out", steer: "meanwhile" });
      const steer = opencode.session(chat.id).messages.find((m) => m.text === "meanwhile")!.id;
      const [first, again] = failed.queries;
      assert.equal(first!.outcome, "serverError");
      assert.ok(recordAt(chat.name, again!.params.resumeSessionAt).isApiErrorMessage, "the point is the CLI's error record");
      assert.equal(again!.trigger, userRecordName(steer, 2));
      assert.equal(takenSteps(chat.id), taken + 1, "the transcript holds the step's results");
    });

    await cases.run("a turn stopped while parked on a tool call: the CLI's interrupt record ends it, no copy", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.toolTurn = true;
      await opencode.say(chat.id, "q2");
      const stopped = await opencode.turn(chat.id, { stopParked: true });
      assert.ok(stopped.stopped, "the user stopped the turn while its tool ran");
      await sleep(200);
      const interrupted = claude.leafOf(chat.name)!;
      assert.equal(claude.recordText(interrupted), "[Request interrupted by user for tool use]");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, interrupted.uuid], "the interrupt record ends the stopped turn");
      assert.equal(next.query.params.forkSession, undefined, "no revert: no copy");
    });

    /** A turn of q2 stopped by the user: `hold` (before OpenCode read any of the answer) or `holdMidAnswer` (after its first piece). */
    const stoppedTurn = async (chat: ReturnType<typeof newChat>, how: "hold" | "holdMidAnswer", unread: number) => {
      await chat.ask("q1");
      claude.state.replies = ["Paris, the capital of France."];
      let release!: () => void;
      claude.state[how] = new Promise<void>((resolve) => (release = resolve));
      claude.state.unreadAtStop = unread;
      await opencode.say(chat.id, "q2");
      const stop = new AbortController();
      const turn = opencode.turn(chat.id, { stop: stop.signal });
      await sleep(300);
      stop.abort();
      const stopped = await turn;
      // The answer comes from the API only after the stop reached the CLI process (through the SDK, a hop that
      // takes a while): OpenCode is done with the request before that.
      await sleep(500);
      release();
      assert.ok(stopped.stopped, "the user stopped the turn");
      await sleep(200);
      const shown = opencode.session(chat.id).messages.at(-1)!;
      const answer = claude.records(chat.name).findLast((r) => r.type === "assistant");
      return { shown: shown.type === "assistant" ? shown.text : undefined, answer };
    };

    await cases.run("a turn stopped before its answer started: the CLI's stop record is the point, the question is not asked twice", async () => {
      const chat = newChat();
      await stoppedTurn(chat, "hold", 0);
      const stoppedEnd = claude.leafOf(chat.name)!;
      assert.equal(claude.recordText(stoppedEnd), "[Request interrupted by user]");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, stoppedEnd.uuid]);
      assert.ok(!textOfInput(next.query).includes("q2"), `the transcript holds q2 already: ${textOfInput(next.query)}`);
    });

    await cases.run("a turn stopped before OpenCode read any of the answer while the CLI had a piece: the point is before the answer", async () => {
      const chat = newChat();
      const { shown, answer } = await stoppedTurn(chat, "hold", 1);
      assert.equal(shown, undefined, "OpenCode kept no answer");
      assert.ok(answer?.isAbortedMidStream && claude.recordText(answer).length > 0, `the CLI wrote what it had: ${JSON.stringify(answer?.message)}`);
      const next = await chat.ask("q3");
      assert.equal(next.query.params.resumeSessionAt, answer!.parentUuid, "the point is the record before the answer");
      assert.ok(!next.query.view.includes("Paris"), `Claude does not read an answer the user never saw: ${next.query.view}`);
    });

    await cases.run("a turn stopped before OpenCode read any of the answer while the CLI had it whole: the point is before the answer", async () => {
      const chat = newChat();
      const { shown, answer } = await stoppedTurn(chat, "hold", 50);
      assert.equal(shown, undefined, "OpenCode kept no answer");
      assert.equal(claude.recordText(answer!), "Paris, the capital of France.", "the CLI wrote the answer whole");
      const next = await chat.ask("q3");
      assert.equal(next.query.params.resumeSessionAt, answer!.parentUuid, "the point is the record before the answer");
      assert.ok(!next.query.view.includes("Paris"), `Claude does not read an answer the user never saw: ${next.query.view}`);
    });

    await cases.run("a stopped answer the screen shows whole as the CLI wrote it: the answer is the point", async () => {
      const chat = newChat();
      const { shown, answer } = await stoppedTurn(chat, "holdMidAnswer", 0);
      assert.ok(shown, "OpenCode kept the part it showed");
      assert.match(shown!, /\s$/, "the part shown ends with the space the stream had reached");
      assert.equal(claude.recordText(answer!), shown, "the CLI wrote the part shown");
      const stoppedEnd = claude.leafOf(chat.name)!.uuid;
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, stoppedEnd], "the answer is part of the turn: the point is the turn's end");
      assert.equal(plansOf(chat.id).at(-1)!.missed, 0, "the kept part is in the transcript");
    });

    await cases.run("a stopped answer the CLI wrote longer than the screen: the point is before the answer, the shown part reaches Claude", async () => {
      const chat = newChat();
      const { shown, answer } = await stoppedTurn(chat, "holdMidAnswer", 1);
      assert.ok(shown && claude.recordText(answer!).startsWith(shown) && claude.recordText(answer!).length > shown.length, `the record holds more than the screen: ${JSON.stringify([shown, claude.recordText(answer!)])}`);
      const next = await chat.ask("q3");
      assert.equal(next.query.params.resumeSessionAt, answer!.parentUuid, "the point is the record before the answer");
      assert.ok(next.query.view.includes(shown!.trim()) && !next.query.view.includes(claude.recordText(answer!)), `Claude reads the screen's part, not the record's: ${next.query.view}`);
    });

    await cases.run("a stopped answer the CLI wrote whole while the screen holds its start: the point is before the answer, the shown part reaches Claude", async () => {
      const chat = newChat();
      const { shown, answer } = await stoppedTurn(chat, "holdMidAnswer", 50);
      assert.equal(claude.recordText(answer!), "Paris, the capital of France.", "the CLI wrote the answer whole");
      assert.ok(shown && shown.length < claude.recordText(answer!).length, `the screen holds its start: ${shown}`);
      const next = await chat.ask("q3");
      assert.equal(next.query.params.resumeSessionAt, answer!.parentUuid, "the point is the record before the answer");
      assert.ok(next.query.view.includes(shown!.trim()) && !next.query.view.includes("capital of France"), `Claude reads the screen's part, not the record's: ${next.query.view}`);
    });

    await cases.run("an answer the CLI took back (a malformed tool use): the next turn answers, Claude reads the question and the answer once", async () => {
      const chat = newChat();
      claude.state.malformedToolUse = true;
      const first = await chat.ask("q1");
      const shown = first.turn.requests.at(-1)!.reply!.text;
      assert.ok(shown.startsWith(MALFORMED_TOOL_USE_TEXT), "OpenCode shows the taken-back text with the answer");
      const records = claude.records(chat.name);
      const uuids = new Set(records.map((r) => r.uuid).filter(Boolean));
      assert.ok(records.some((r) => r.parentUuid && !uuids.has(r.parentUuid)), "a record hangs off a uuid the file does not hold");
      const journalBefore = world.journal().length;
      const next = await chat.ask("q2");
      assert.equal(next.queries.length, 1, "no refusal, no retry");
      assert.equal(next.query.outcome, "answered");
      assert.equal(next.query.params.resume, chat.name, "the chat's transcript goes on");
      assert.ok(lines(next.query.view).includes("q1"), `Claude reads the question: ${next.query.view}`);
      const answerText = shown.slice(MALFORMED_TOOL_USE_TEXT.length);
      assert.equal(next.query.view.split(answerText).length - 1, 1, `and the answer once: ${next.query.view}`);
      assert.deepEqual(world.journal().slice(journalBefore).filter((line) => /level=error/.test(line)), [], "no error");
    });

    await cases.run("a CLI compaction boundary hangs off logicalParentUuid; the summary is part of the turn", async () => {
      const chat = newChat();
      await chat.ask("q1");
      claude.state.compactBeforeAnswer = { summary: "Summary: q1 was asked." };
      await chat.ask("q2");
      assert.ok(claude.records(chat.name).some((r) => r.type === "system" && r.subtype === "compact_boundary"), "the CLI compacted the chat");
      const next = await chat.ask("q3");
      assert.deepEqual(pointOf(next.query), [chat.name, chat.ends.get("q2")]);
      assert.equal(next.query.outcome, "answered", "the CLI resumed across the boundary");
      assert.ok(next.query.view.includes("Summary: q1 was asked.") && !lines(next.query.view).includes("q1"), `the model reads from the summary on: ${next.query.view}`);
    });

    await cases.run("a fork's copy of a message is named after the original", async () => {
      const chat = newChat();
      await chat.ask("q1");
      const unanswered = await opencode.say(chat.id, "q2");
      const fork = await opencode.fork(chat.id, opencode.through(unanswered));
      const from = claude.queries.length;
      assert.ok((await opencode.turn(fork)).ok);
      const query = claude.queries.slice(from).find((q) => q.kind === "chat")!;
      assert.deepEqual([query.params.sessionId, query.trigger], [transcriptName(fork, FIRST_EPOCH, 1), userRecordName(unanswered, 1)]);
    });

    await cases.run("a summary resumes where the summarized part ends", async () => {
      const chat = newChat();
      await chat.ask("q1");
      await chat.ask("q2");
      await chat.ask("q3");
      const compaction = await opencode.compact(chat.id);
      assert.equal(compaction.status, "completed");
      const summary = claude.queries.slice(compaction.counted[0], compaction.counted[1]).find((q) => q.kind === "summary")!;
      assert.ok(summary, "Claude wrote the summary");
      assert.ok(world.journal().some((line) => line.includes("summarizing from the chat's Claude session") && line.includes(`"conversationKey":"${chat.id}"`)));
      // The summarized part: the whole chat on OpenCode 2.2.0 (it fits the summary's room), the part before the
      // kept tail (q3) on 2.0.32.
      const last = opencode.state.version === "2.0.32" ? "q2" : "q3";
      assert.deepEqual(pointOf(summary), [chat.name, chat.ends.get(last)], "the summary resumes where the summarized part ends");
    });

    await cases.run("a summary of a part whose last turn failed and another model answered reads the history as text", async () => {
      const chat = newChat();
      await chat.ask("q1");
      await chat.ask("q2");
      claude.state.failures = Array.from({ length: 11 }, () => "serverError" as const);
      await opencode.say(chat.id, "q3");
      assert.ok(!(await opencode.turn(chat.id)).ok, "OpenCode gave up after its retries");
      opencode.otherModelAnswer(chat.id, "another model's answer");
      await opencode.say(chat.id, "q4");
      opencode.otherModelAnswer(chat.id, "another model's answer to q4");
      const compaction = await opencode.compact(chat.id);
      assert.equal(compaction.status, "completed");
      const summary = claude.queries.slice(compaction.counted[0], compaction.counted[1]).find((q) => q.kind === "summary")!;
      assert.ok(summary, "Claude wrote the summary");
      assert.equal(summary.params.resume, undefined, "the summary does not resume the transcript");
      assert.ok(world.journal().some((line) => line.includes("summarizing from the history text") && line.includes(`"conversationKey":"${chat.id}"`)));
    });

    await cases.run("the records as the plugin reads them from a chat's file: every record with a uuid, in file order, no payload", async () => {
      const big = "A".repeat(100_000);
      const chat = newChat();
      claude.state.thinking = big;
      const look = await opencode.say(chat.id, "look", [{ mediaType: "image/png", data: testPng("LOOK") }]);
      assert.ok((await opencode.turn(chat.id)).ok);
      claude.state.toolTurn = true;
      const read = await chat.ask("read it", { toolOutput: big, steer: "and this" });
      const steer = opencode.session(chat.id).messages.find((m) => m.text === "and this")!.id;
      claude.state.toolTurn = true;
      const again = await opencode.say(chat.id, "again");
      assert.ok((await opencode.turn(chat.id, { stopParked: true })).stopped, "the user stopped the turn while its tool ran");
      await sleep(200);
      // A question that starts with the text of the CLI's record of a stop, a long log pasted after it.
      const pasted = await chat.ask(`[Request interrupted by user]\n${big}`);
      claude.state.thinking = undefined;
      const text = readFileSync(claude.fileOf(chat.name), "utf8");
      const records: TranscriptRecord[] = parseTranscript(text);
      const whole = text.split("\n").flatMap((raw, line) => {
        if (!raw.trim()) return [];
        const entry = JSON.parse(raw);
        return typeof entry.uuid === "string" && typeof entry.type === "string" ? [{ line, ...entry } as TranscriptRecord] : [];
      });
      assert.deepEqual(records.map((r) => [r.line, r.uuid]), whole.map((r) => [r.line, r.uuid]), "every record with a uuid, in file order");
      assert.ok(text.length > 500_000 && !JSON.stringify(records).includes("A".repeat(100)), "no payload is kept");
      const parsed = (uuid: string) => records.find((r) => r.uuid === uuid)!;
      assert.deepEqual(parsed(userRecordName(look, 1)).message, { role: "user", content: [{ type: "text" }, { type: "image" }] });
      assert.equal(parsed(userRecordName(read.message, 1)).message?.content, "", "a question's text is not kept");
      assert.ok(records.some((r) => r.type === "assistant" && JSON.stringify(r.message?.content) === JSON.stringify([{ type: "thinking" }])), "a thinking block keeps its kind");
      const call = whole.find((r) => r.type === "assistant" && r.message?.content?.some((b: any) => b.type === "tool_use"))!;
      const callId = call.message!.content.find((b: any) => b.type === "tool_use").id;
      assert.deepEqual(parsed(call.uuid!).message?.content, [{ type: "tool_use", id: callId }]);
      const result = records.find((r) => r.message?.content?.[0]?.tool_use_id === callId)!;
      assert.deepEqual([result.message?.content, result.toolUseResult], [[{ type: "tool_result", tool_use_id: callId }], true]);
      assert.deepEqual(records.find((r) => r.attachment?.type === "queued_command")!.attachment, { type: "queued_command", source_uuid: userRecordName(steer, 1) });
      const stop = records.find((r) => r.type === "user" && JSON.stringify(r.message?.content).includes("[Request interrupted by user for tool use]"))!;
      assert.deepEqual(stop.message?.content, [{ type: "text", text: "[Request interrupted by user for tool use]" }], "the record of a stop keeps its text");
      const pastedContent = parsed(userRecordName(pasted.message, 1)).message?.content;
      assert.ok(Array.isArray(pastedContent) && pastedContent.every((block: any) => block.type === "text" && !("text" in block)), `the pasted question's text is not kept: ${JSON.stringify(pastedContent)}`);
      // The same decisions as on the whole records: the questions start turns, the CLI's own records do not.
      assert.deepEqual(records.map(isPromptRecord), whole.map(isPromptRecord));
      assert.deepEqual(
        records.filter(isPromptRecord).map((r) => r.uuid),
        [TRANSCRIPT_START_NAME, userRecordName(look, 1), userRecordName(read.message, 1), userRecordName(again, 1), userRecordName(pasted.message, 1)],
      );
    });

    await cases.run("no other error in the plugin's journal", () => {
      const errors = world.journal().filter((line) => /level=error/.test(line));
      assert.deepEqual(errors.filter((line) => !/Internal server error|exited with code (1|143)|No message found|terminated by signal/.test(line)), []);
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
