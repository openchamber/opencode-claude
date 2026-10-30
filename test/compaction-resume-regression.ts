/**
 * Regression: OpenCode's compaction summary was written by haiku from a
 * text copy of the chat cut to 400k characters, with every tool result cut
 * to 1000. On a long chat it saw a fraction of the conversation. The summary
 * now resumes an in-memory fork of the chat's Claude transcript, cut where
 * the summarized part ends (the compaction hook's list names that point), on
 * the chat's model with the chat turn's system prompt and tools (same prompt
 * cache), and nothing is written to it.
 * - A reminder after a reply that missed the template resumes at the same
 *   point with the summary prompt and the reminder, not the missed reply.
 * - A request OpenCode shrank or flattened after the hook (an overflow, a
 *   413) reads the history as text: the transcript would hold more than the
 *   request.
 * - The CLI refused the summary's point (another process moved the leaf
 *   chain): OpenCode's retry reads the request as text, the chat keeps its
 *   transcript version.
 * - A chat with no transcript gets the history as text, sized to the chat
 *   model, still on the chat's model.
 * - The summarized part ends with a question whose turn failed after its
 *   record was written: the summary resumes at that record, its prompt the
 *   summary prompt alone (or Claude would read the question twice).
 * - After the compaction the chat starts a new transcript: its context now
 *   begins with the checkpoint, a new epoch. The checkpoint is a record of
 *   its own without a turn, named by its text, then the question's record
 *   with the turn; the next turn finds both by name. After an
 *   auto-compaction inside a turn the list is the checkpoint alone (the
 *   question in its recent part), and its record carries the turn.
 * - The history as text is in OpenCode's form for a serialized part of a
 *   conversation ("…serialized record of this conversation from its
 *   start…").
 *
 * - A chat too long for the summary's room: OpenCode 2.2.0 sends the part
 *   before the tail it keeps, and the summary resumes where that part ends.
 *
 * On the simulators (test/simulators/): chats of a few turns, then OpenCode
 * compacts them (`opencode.compact`: OpenCode 2.2.0 gives the compaction hook
 * the whole chat and summarizes all of it when it fits, so the summarized
 * part ends at the chat's last turn, else the part before the kept tail;
 * 2.0.32 — `OPENCODE_CLAUDE_SIMULATOR_OPENCODE=2.0.32` runs the file on it —
 * gives the hook that part alone, ending before the last question; its summary prompt, the reminder when a
 * reply skips the template — `summaryReplies`; a summary refused as too long
 * — `summaryFailures` `promptTooLong` — or too large — `requestTooLarge` —
 * goes again as one text message of the older part, without tools, its
 * exchanges losing detail level by level only as far as needed; 2.0.32 dropped whole exchanges and cut tool outputs).
 * The size of a chat as OpenCode measures it: the usage of its last answer (`claude.state.usage`). The summary's query is the
 * one with `persistSession: false`. A chat whose turns another model answered
 * (`otherModelAnswer`) has no transcript. A summary point the CLI refuses: a
 * process that was not stopped (`failures` "zombie") writes its answer after
 * the turns that followed, so the point is off the file's leaf chain. Where a turn ends in the transcript: the
 * record the next question's record continues (each question's record is named after its OpenCode id, names.ts
 * userRecordName), for the last turn the leaf the CLI's `last-prompt` line names.
 * An auto-compaction: an answer whose usage (`claude.state.usage`) reached
 * the ceiling, so OpenCode compacts before the next request; what the plugin
 * sent is the query's input (`noTurn`: a record without a turn).
 *
 * Run: bun test/compaction-resume-regression.ts
 */
import assert from "node:assert/strict";

import { contentText, type ClaudeQuery } from "./simulators/claude-code.ts";
import { testCases } from "./simulators/cases.ts";
import { SUMMARY_NUDGE, SUMMARY_PROMPT } from "./simulators/opencode.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

/** The opening of the history as text, in OpenCode's form for a serialized part of a conversation. */
const HISTORY_AS_TEXT = "serialized record of this conversation from its start";

/** The text of a query's prompt messages, in order. */
const promptOf = (query: ClaudeQuery) => query.input.map((m) => contentText(m.content)).join("\n");

async function main() {
  const world = await createWorld("compaction-resume");
  const { opencode, claude } = world;
  const names = await pluginModule("names");
  const summaries = () => claude.queries.filter((q) => q.kind === "summary");
  const chats = () => claude.queries.filter((q) => q.kind === "chat");
  /** Where the transcript's latest turn ends: the leaf its `last-prompt` line names. */
  const leafOf = (transcript: string) => {
    const leaf = claude.records(transcript).findLast((r) => r.type === "last-prompt")?.leafUuid as string | undefined;
    assert.ok(leaf, `the transcript names its leaf: ${transcript}`);
    return leaf;
  };
  /** OpenCode 2.0.32: the hook and the summary get the part before the kept tail, the last question and after. */
  const legacy = opencode.state.version === "2.0.32";
  /**
   * A chat of three turns Claude answered: the chat, its transcript, where
   * the second turn ends there (the record the third question's record
   * continues), where the third ends, and where the summarized part ends: the
   * third turn's end (2.2.0, the whole chat), the second's (2.0.32).
   * `usage`: of the third answer.
   */
  const threeTurns = async (texts = ["one", "two", "three"], usage: Record<string, number> = {}) => {
    const chat = opencode.newChat();
    const ids: string[] = [];
    for (const [index, text] of texts.entries()) {
      ids.push(await opencode.say(chat, text));
      if (index === 2) claude.state.usage = usage;
      const turn = await opencode.turn(chat);
      claude.state.usage = {};
      assert.ok(turn.ok, `${text.slice(0, 20)}: the turn answered`);
    }
    const transcript = chats().at(-1)!.name;
    const third = claude.records(transcript).find((r) => r.uuid === names.userRecordName(ids[2]!, 1));
    assert.ok(third?.parentUuid, "the third question's record, named after it, continues the second turn");
    const end = leafOf(transcript);
    return { chat, transcript, endOfSecond: third.parentUuid as string, end, summarizedEnd: legacy ? (third.parentUuid as string) : end };
  };
  const fromSession = (lines: string[]) => lines.filter((line) => /summarizing from the chat's Claude session/.test(line)).length;
  const fromText = (lines: string[]) => lines.filter((line) => /summarizing from the history text/.test(line)).length;
  // Each case is independent: what a failed one left set is cleared before the next.
  const independent = testCases();
  const cases = {
    run: (name: string, body: () => Promise<string | void>) =>
      independent.run(name, async () => {
        claude.state.failures = [];
        claude.state.summaryFailures = [];
        claude.state.summaryReplies = [];
        claude.state.toolSteps = [];
        claude.state.usage = {};
        return body();
      }),
    done: () => independent.done(),
  };

  try {
    await opencode.startPlugin();
    await cases.run("the summary resumes an unsaved fork of the chat's transcript where the summarized part ends, on the chat's model, prompt and tools", async () => {
      const { chat, transcript, summarizedEnd } = await threeTurns();
      const chatParams = chats().at(-1)!.params as Record<string, any>;
      const recorded = claude.records(transcript).length;
      const asked = summaries().length;
      const seen = world.journal().length;
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      assert.equal(summaries().length, asked + 1, "one summary query");
      const summary = summaries().at(-1)!;
      const params = summary.params as Record<string, any>;
      assert.equal(params.resume, transcript, "resumes the chat's transcript");
      assert.equal(params.resumeSessionAt, summarizedEnd, `cut where the summarized part ends: the ${legacy ? "second" : "third"} turn's end`);
      assert.equal(params.forkSession, true);
      assert.equal(params.persistSession, false, "nothing written to the transcript");
      assert.equal(params.model, chatParams.model, "the chat's model, not haiku");
      assert.deepEqual(params.systemPrompt, chatParams.systemPrompt, "same system prompt as the chat turn");
      assert.ok(params.mcpServers, "same tools as the chat turn");
      assert.equal(params.permissionMode, "dontAsk", "tool calls are refused");
      // No OpenCode tool allowed ahead (the SDK itself allows "Skill" for the chat's skills; no built-in tool is on).
      assert.deepEqual((params.allowedTools ?? []).filter((tool: string) => tool.startsWith("mcp__")), [], `no tool allowed ahead: ${params.allowedTools}`);
      assert.equal(params.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined, "keeps the chat's memory");
      const text = promptOf(summary);
      assert.ok(text.includes(SUMMARY_PROMPT), "the summary prompt reaches Claude");
      assert.ok(!text.includes(HISTORY_AS_TEXT), "no text copy of the chat");
      assert.match(summary.view, legacy ? /one[\s\S]*answer L\d+[\s\S]*two[\s\S]*answer L\d+/ : /one[\s\S]*answer L\d+[\s\S]*two[\s\S]*answer L\d+[\s\S]*three[\s\S]*answer L\d+/, "Claude read the summarized part from its transcript");
      if (legacy) assert.ok(!summary.view.includes("three"), "the kept tail is not summarized");
      assert.equal(claude.records(transcript).length, recorded, "the summary wrote nothing to the chat's transcript");
      const lines = world.journal().slice(seen);
      assert.deepEqual([fromSession(lines), fromText(lines)], [1, 0], "the journal: the summary from the transcript");
    });

    // After a compaction by the button the chat's context starts with the
    // checkpoint, then the question: a new epoch, a new transcript, the
    // checkpoint a record of its own without a turn, named by its text,
    // then the question's record with the turn. The next turn finds both.
    await cases.run("after a compaction by the button: a new transcript of the new epoch, the checkpoint a record of its own, then the question's", async () => {
      const { chat, transcript } = await threeTurns();
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      const four = await opencode.say(chat, "four");
      const after = await opencode.turn(chat);
      assert.ok(after.ok);
      const next = chats().at(-1)!;
      const checkpoint = names.textOfMessage(after.requests[0]!.list[0]!);
      assert.ok(checkpoint.startsWith("<conversation-checkpoint>"), "OpenCode's context starts with the checkpoint");
      const NEW = names.transcriptName(chat, names.epochOfCheckpoint(checkpoint), 1);
      assert.equal(next.params.sessionId, NEW, "a new transcript of the new epoch");
      assert.equal(next.params.resume, undefined, "the turn after the compaction does not resume the old transcript");
      assert.notEqual(next.name, transcript);
      assert.deepEqual(next.input.map((r) => r.noTurn), [true, true, false]);
      assert.equal(next.input[0]!.uuid, names.TRANSCRIPT_START_NAME, "a new transcript starts with its own record");
      assert.ok(contentText(next.input[1]!.content).startsWith("<conversation-checkpoint>"), "the checkpoint reaches Claude");
      assert.equal(next.input[1]!.uuid, names.checkpointRecordName(checkpoint, 1));
      assert.equal(contentText(next.input[2]!.content), "four");
      assert.equal(next.input[2]!.uuid, names.userRecordName(four, 1));
      await opencode.say(chat, "five");
      assert.ok((await opencode.turn(chat)).ok);
      const fifth = chats().at(-1)!;
      assert.equal(fifth.params.resume, NEW);
      assert.deepEqual(fifth.input.map((r) => contentText(r.content)), ["five"], "the checkpoint and the question are not sent again");
    });

    // An auto-compaction inside a turn (the measured context reached the
    // ceiling): the question is in the checkpoint's recent part, the list is
    // the checkpoint alone, and its record carries the turn.
    await cases.run("an auto-compaction inside a turn: the list is the checkpoint alone, its record carries the turn", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "five and a half");
      // The model's window from the plugin's catalog; the ceiling is 15% below it (2.0.32: 10%).
      const window = (opencode.instances[0]!.provider.models as any[]).find((m) => m.id === opencode.state.modelID || /sonnet/.test(m.id))!.limit.context as number;
      claude.state.usage = { input_tokens: Math.ceil(window * 0.95) };
      const big = await opencode.turn(chat);
      claude.state.usage = {};
      assert.ok(big.ok);
      await opencode.say(chat, "six");
      const asked = summaries().length;
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok, `the turn after the compaction: ${turn.requests.map((r) => r.status)}`);
      assert.equal(turn.compactions?.[0]?.status, "completed", "OpenCode compacted before the request");
      assert.equal(summaries().length, asked + 1, "one summary");
      const list = turn.requests[0]!.list;
      assert.equal(list.length, 1, "the list is the checkpoint alone");
      const checkpoint = names.textOfMessage(list[0]!);
      assert.ok(checkpoint.includes("<recent-context>\n[User]: six\n</recent-context>"), `the question is in the checkpoint's recent part: ${checkpoint}`);
      const query = chats().at(-1)!;
      assert.equal(query.params.sessionId, names.transcriptName(chat, names.epochOfCheckpoint(checkpoint), 1));
      assert.deepEqual(query.input.map((r) => [r.uuid, r.noTurn]), [[names.TRANSCRIPT_START_NAME, true], [names.checkpointRecordName(checkpoint, 1), false]]);
    });

    // No transcript for this chat: the history goes as text, on the chat's model.
    await cases.run("a chat with no transcript: the history as text, on the chat's model, without the chat's memory", async () => {
      const model = chats().at(-1)!.params.model;
      const chat = opencode.newChat();
      for (const n of ["ONE", "TWO", "THREE"]) {
        await opencode.say(chat, `OTHER-ASK-${n}`);
        opencode.otherModelAnswer(chat, `OTHER-ANSWER-${n}`);
      }
      const asked = summaries().length;
      const seen = world.journal().length;
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      const summary = summaries().at(-1)!;
      assert.equal(summaries().length, asked + 1);
      assert.equal(summary.params.resume, undefined, "nothing to resume");
      assert.equal(summary.params.model, model, "the chat's model");
      assert.equal((summary.params as Record<string, any>).env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1", "no memory in a text-copy summary");
      const text = promptOf(summary);
      assert.ok(text.includes(HISTORY_AS_TEXT), "the history as text");
      assert.ok(text.includes("OTHER-ANSWER-TWO"), "the summarized part's answers in it");
      assert.ok(text.includes(SUMMARY_PROMPT));
      const lines = world.journal().slice(seen);
      assert.deepEqual([fromSession(lines), fromText(lines)], [0, 1], "the journal: the other chat's summary from text");
    });

    // Another chat, with a reminder after a reply that missed the template:
    // same point, the summary prompt and the reminder. OpenCode runs no new
    // hook for it.
    await cases.run("a reminder after a reply that missed the template resumes at the same point with the summary prompt and the reminder", async () => {
      const { chat, transcript, summarizedEnd } = await threeTurns();
      const asked = summaries().length;
      const seen = world.journal().length;
      claude.state.summaryReplies = ["not a summary", "## Objective\n- after the reminder"];
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      assert.equal(done.requests.length, 2, "the summary, then the reminder");
      const [first, reminded] = summaries().slice(asked);
      assert.ok(first && reminded, "two summary queries");
      assert.equal(first.params.resumeSessionAt, summarizedEnd);
      const lines = world.journal().slice(seen);
      assert.deepEqual([fromSession(lines), fromText(lines)], [2, 0], "the journal: the summary and its reminder both from the transcript");
      assert.equal(reminded.params.resume, transcript, "the reminder resumes the chat's transcript");
      assert.equal(reminded.params.resumeSessionAt, first.params.resumeSessionAt, "the reminder resumes at the same point");
      const text = promptOf(reminded);
      assert.ok(text.includes(SUMMARY_PROMPT), "the summary prompt, not only the reminder");
      assert.ok(text.includes(SUMMARY_NUDGE), "the reminder: OpenCode retries so that the template is filled in");
      assert.ok(!text.includes("not a summary"), "the missed reply is not repeated");
      assert.ok(!text.includes(HISTORY_AS_TEXT), "no text copy of the chat");
      assert.ok(!contentText(reminded.input[0]?.content).startsWith(SUMMARY_NUDGE), "the prompt starts with the summary prompt, not the reminder");
    });

    // The CLI refuses the summary's resume point ("No message found with
    // message.uuid …"): a process the plugin lost (`failures` "zombie") wrote
    // its answer after the turns that followed, so the summarized part's end
    // is off the file's leaf chain. The request fails, OpenCode retries it,
    // and the retry reads the request as text without moving the chat to
    // another transcript version. The mark lives in the process, not in the
    // module: a copy of the plugin reloaded before OpenCode's retry reads the
    // same set.
    await cases.run("the CLI refuses the summary's point (a lost process wrote after it): OpenCode's retry reads the request as text, the chat keeps its transcript", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "one");
      assert.ok((await opencode.turn(chat)).ok);
      // The process of "two" keeps running after the plugin lost it: the request fails, OpenCode's retry answers.
      claude.state.failures = ["zombie"];
      const twoId = await opencode.say(chat, "two");
      const two = await opencode.turn(chat);
      assert.deepEqual(two.requests.map((r) => r.status), [500, 200], `the lost process's request failed, the retry answered: ${two.requests.map((r) => r.status)}`);
      const threeId = await opencode.say(chat, "three");
      assert.ok((await opencode.turn(chat)).ok);
      const transcript = chats().at(-1)!.name;
      const three = claude.records(transcript).find((r) => r.uuid === names.userRecordName(threeId, 1));
      assert.ok(three?.parentUuid, "the third question's record continues the second turn");
      const end = legacy ? (three.parentUuid as string) : leafOf(transcript);
      // The lost process writes its answer now: the file's leaf chain runs through its own records.
      claude.state.zombies.shift()!();
      assert.ok(claude.records(transcript).some((r) => r.uuid === names.userRecordName(twoId, 1)));
      const asked = summaries().length;
      const retriesBefore = opencode.retries.length;
      const seen = world.journal().length;
      const sleep = opencode.state.sleep;
      let marked = false;
      opencode.state.sleep = async (ms: number) => {
        const marks = (globalThis as Record<symbol, unknown>)[Symbol.for("@openchamber/opencode-claude/summary-as-text/v1")];
        marked ||= marks instanceof Set && marks.has(chat);
        await sleep(ms);
      };
      let done: Awaited<ReturnType<typeof opencode.compact>>;
      try {
        done = await opencode.compact(chat);
      } finally {
        opencode.state.sleep = sleep;
      }
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      const [refused, retried] = summaries().slice(asked);
      assert.equal(refused?.params.resume, transcript, "the summary resumes the chat's transcript");
      assert.equal(refused?.params.resumeSessionAt, end, `at the end of the summarized part: the ${legacy ? "second" : "third"} turn's end`);
      assert.equal(refused?.outcome, "refused: no message", "the summary that lost its point fails");
      assert.ok(opencode.retries.slice(retriesBefore).some((retry) => retry.chat === chat), "OpenCode retried the summary");
      assert.ok(marked, "the refused summary's mark is the process's, seen while OpenCode waits to retry");
      assert.equal(retried?.params.resume, undefined, "the retry reads the request as text");
      assert.ok(promptOf(retried!).includes(HISTORY_AS_TEXT));
      const lines = world.journal().slice(seen);
      assert.ok(lines.some((line) => line.includes("cannot be resumed for the summary; the retry reads the request as text")));
      assert.ok(!lines.some((line) => line.includes("the chat moves to a new transcript")), "the chat's transcript keeps its version");
    });

    // OpenCode shrank the request after the hook (refused as too long: an
    // overflow): the body is the older part as one text message, not the
    // hook's list, so the summary reads the request as text. The CLI's own
    // auto compaction is off (the plugin's starter, fix/cli-autocompact), so
    // the summary is refused as too long rather than compacted by the CLI.
    await cases.run("a summary OpenCode shrank after the hook (refused as too long) reads the request as text", async () => {
      const { chat } = await threeTurns(["one " + "a".repeat(8000), "two " + "b".repeat(8000), "three"]);
      const asked = summaries().length;
      claude.state.summaryFailures = ["promptTooLong"];
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      const [refused, shrunk] = summaries().slice(asked);
      assert.equal(refused?.outcome, "promptTooLong", "the summary refused as too long");
      assert.ok(shrunk, "then the shrunk one");
      assert.equal(shrunk.params.resume, undefined, "a request shrunk after the hook reads as text");
      const text = promptOf(shrunk);
      if (legacy) {
        // OpenCode 2.0.32 dropped the oldest exchange whole; the newest of the part still fits.
        assert.ok(text.includes("[1 older exchange omitted]") && text.includes("[User]: two"), `Claude reads the request OpenCode shrank: ${text.slice(0, 300)}`);
        assert.ok(!text.includes("one a"), "the exchange OpenCode dropped does not reach Claude");
      } else {
        // OpenCode 2.2.0's text form: "[User]: …" per message; here both long exchanges still fit whole.
        assert.ok(text.includes("[User]: one a") && text.includes("[User]: two b"), `Claude reads the request OpenCode shrank: ${text.slice(0, 300)}`);
      }
    });

    // OpenCode flattened the part into one text message without tools (a
    // 413): the same questions, other texts, so the summary reads the request
    // as text and not the transcript.
    await cases.run("a summary OpenCode flattened after a 413 reads the request as text", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "run it");
      claude.state.toolSteps = [[{ name: "bash", input: { command: "ls" } }]];
      assert.ok((await opencode.turn(chat, { toolOutput: "x".repeat(5000) })).ok);
      await opencode.say(chat, "and then?");
      assert.ok((await opencode.turn(chat)).ok);
      const asked = summaries().length;
      claude.state.summaryFailures = ["requestTooLarge"];
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      const [refused, flattened] = summaries().slice(asked);
      assert.equal(refused?.outcome, "requestTooLarge", "the summary refused as too large");
      assert.ok(flattened, "then the flattened one");
      assert.equal(flattened.params.resume, undefined, "a flattened part is not the list's: read as text");
      // OpenCode 2.2.0's text form of the step: the call and its result as lines of the message; 2.0.32 cut the output.
      if (legacy) assert.ok(promptOf(flattened).includes("[truncated]"));
      else assert.match(promptOf(flattened), /\[Assistant tool call\]: bash\(\{"command":"ls"\}\)\n\[Tool result\]: x+/);
    });

    // The summarized part ends with a question whose turn failed after its
    // record was written (OpenCode 2.2.0 summarizes the whole chat, so the
    // compaction right after the failure; 2.0.32 keeps the last question
    // verbatim, so one more turn after it). The summary resumes at the end of
    // that turn; its prompt is the summary prompt alone, or Claude would read
    // the question twice.
    await cases.run("the summarized part ends with a failed question: the summary resumes after its record, the prompt the summary prompt alone", async () => {
      const { chat } = await threeTurns();
      const failedId = await opencode.say(chat, "FAILED-QUESTION");
      claude.state.failures = ["creditBalance"];
      const failed = await opencode.turn(chat);
      assert.equal(failed.ok, false, "the turn of the question failed");
      const failedRecord = names.userRecordName(failedId, 1);
      assert.ok(claude.records(chats().at(-1)!.name).some((r) => r.uuid === failedRecord), "the failed question's record was written");
      let endOfFailed: string;
      if (legacy) {
        const fiveId = await opencode.say(chat, "five");
        assert.ok((await opencode.turn(chat)).ok);
        const five = claude.records(chats().at(-1)!.name).find((r) => r.uuid === names.userRecordName(fiveId, 1));
        assert.ok(five?.parentUuid, "the next question's record continues the failed turn");
        endOfFailed = five.parentUuid as string;
      } else {
        // The CLI wrote the question's record, then its synthetic error record: the failed turn ends there.
        endOfFailed = leafOf(chats().at(-1)!.name);
      }
      const transcript = chats().at(-1)!.name;
      assert.ok(claude.chainTo(transcript, endOfFailed).some((r) => r.uuid === failedRecord), "the failed turn ends after the question's record");
      const asked = summaries().length;
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      assert.equal(summaries().length, asked + 1);
      const summary = summaries().at(-1)!;
      assert.equal(summary.params.resume, transcript, "resumes the chat's transcript");
      assert.equal(summary.params.resumeSessionAt, endOfFailed, "cut after the failed question, at the end of its turn");
      assert.ok(summary.view.includes("FAILED-QUESTION"), "Claude reads the failed question from the transcript");
      const text = promptOf(summary);
      assert.ok(text.includes(SUMMARY_PROMPT));
      assert.ok(!text.includes("FAILED-QUESTION"), "the failed question is in the transcript, not again in the prompt");
    });

    // A chat too long for the summary's room (its last answer measured at 99%
    // of the window): OpenCode 2.2.0 gives the hook the whole chat but sends
    // the part before the tail it keeps; 2.0.32 gave the hook that part alone.
    // Either way the summary resumes the transcript where that part ends, the
    // second turn's end: the third question is kept verbatim.
    await cases.run("a chat too long for the summary's room: the summary resumes where the part before the kept tail ends", async () => {
      const window = (opencode.instances[0]!.provider.models as any[]).find((m) => m.id === opencode.state.modelID || /sonnet/.test(m.id))!.limit.context as number;
      const { chat, transcript, endOfSecond } = await threeTurns(["ROOM-ONE", "ROOM-TWO", "ROOM-THREE"], { input_tokens: Math.ceil(window * 0.99) });
      const asked = summaries().length;
      const seen = world.journal().length;
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      assert.equal(summaries().length, asked + 1, "one summary query");
      assert.ok(!JSON.stringify(done.body).includes("ROOM-THREE"), "OpenCode sent the part before the kept tail");
      if (!legacy) assert.ok(JSON.stringify(done.list).includes("ROOM-THREE"), "the hook saw the whole chat (2.2.0)");
      const summary = summaries().at(-1)!;
      assert.equal(summary.params.resume, transcript, "resumes the chat's transcript");
      assert.equal(summary.params.resumeSessionAt, endOfSecond, "cut where the part before the kept tail ends: the second turn's end");
      assert.match(summary.view, /ROOM-ONE[\s\S]*answer L\d+[\s\S]*ROOM-TWO[\s\S]*answer L\d+/, "Claude read the summarized part from its transcript");
      assert.ok(!summary.view.includes("ROOM-THREE"), "the kept tail is not summarized");
      assert.ok(!promptOf(summary).includes(HISTORY_AS_TEXT), "no text copy of the chat");
      const lines = world.journal().slice(seen);
      assert.deepEqual([fromSession(lines), fromText(lines)], [1, 0], "the journal: the summary from the transcript");
    });

    await cases.run("the plugin's journal holds no error", async () => {
      assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
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
