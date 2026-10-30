/**
 * The world the monkey and the scenario tests run in: `createWorld` of
 * test/simulators/world.ts — the one OpenCode simulator and the one Claude
 * Code simulator with the real plugin between them — in the shape these
 * tests were written for. Nothing here imitates OpenCode or Claude Code: a
 * behaviour a test needs goes into the simulators (BEHAVIOR.md).
 *
 * What this wrapper adds:
 * - a turn's requests laid out with the Claude queries each one started
 *   (`Request`: the list the hooks left, the queries, the status, the
 *   answer's text, reasoning or tool calls) — what the monkey's invariant
 *   compares;
 * - `state`: the switches the scenarios turn, of Claude Code
 *   (`claude.state`) and OpenCode (`opencode.state`), under one name;
 * - `foreignHook`: another plugin's hook that rewrites the list the same
 *   way for every request;
 * - the simulators' handles under the names these tests use;
 * - `forkTurns`: the turns of fork-session's cases (a counter of question
 *   tokens, a turn that must pass, a fork's first turn and what it copied);
 * - `createForkListWorld`: the world of fork-list's cases — where a fork's
 *   first turn cuts its parent's transcript — with the parents of its
 *   scenarios, shared by fork-list-regression.ts and the file of the cases
 *   that fail by a finding (fork-list-path-candidates-regression.ts).
 *
 * The plugin only through the world (no import of `src/`), so a test on
 * this wrapper runs on any tree (OPENCODE_CLAUDE_PLUGIN_DIR).
 * `createForkWorld` must run before anything loads the plugin: it sets the
 * environment the plugin's modules read at load.
 */
import assert from "node:assert/strict";

import { contentText, type ClaudeFailure, type ClaudeQuery, type Rec } from "./simulators/claude-code.ts";
import { BASH_TOOL, checkpointText, SUMMARY_PROMPT, toList, lowerMessages, withTimeout, type ForkBoundary, type ListMessage, type Msg, type OpenCodeVersion, type Session, type ToolCall, type ToolDefinitions } from "./simulators/opencode.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

export { checkpointText, contentText, SUMMARY_PROMPT, withTimeout };
export type { ClaudeFailure, ClaudeQuery, ForkBoundary, ListMessage, Msg, Session, ToolCall };

/** One request of a turn, as it went: the list the hooks left, the queries it started, the response. */
export type Request = { list: ListMessage[]; queries: ClaudeQuery[]; status: number; text?: string; reasoning?: string; toolCalls?: ToolCall[] };

export async function createForkWorld() {
  const world = await createWorld("world");
  const { claude, opencode } = world;

  /**
   * Another plugin's hook after ours: it replaces the array, and adds an
   * `x` token after every question token of a user message. The same for
   * every request, as a real hook would be: old messages read the same.
   */
  const foreign = (event: { messages: ListMessage[] }) => {
    event.messages = event.messages.map((m) => {
      if (m.role !== "user") return m;
      if (contentText(m.content).startsWith("<conversation-checkpoint>")) return m;
      return { ...m, content: m.content.map((p) => (p.type === "text" ? { ...p, text: String(p.text).replace(/\bq(\d+)\b/g, "q$1 x$1") } : p)) };
    });
  };

  /** Knobs the scenarios turn: what Claude Code (claude.state) and OpenCode (opencode.state) do next. */
  const state = {
    get failures() { return claude.state.failures; },
    set failures(value: ClaudeFailure[]) { claude.state.failures = value; },
    get zombies() { return claude.state.zombies; },
    set zombies(value: Array<() => void>) { claude.state.zombies = value; },
    get toolTurn() { return claude.state.toolTurn; },
    set toolTurn(value: boolean) { claude.state.toolTurn = value; },
    get toolSteps() { return claude.state.toolSteps; },
    set toolSteps(value: number[]) { claude.state.toolSteps = value; },
    get hold() { return claude.state.hold; },
    set hold(value: Promise<void> | undefined) { claude.state.hold = value; },
    get copyRace() { return claude.state.copyRace; },
    set copyRace(value: boolean) { claude.state.copyRace = value; },
    get refuseCopy() { return claude.state.refuseCopy; },
    set refuseCopy(value: boolean) { claude.state.refuseCopy = value; },
    get hangReads() { return opencode.state.hangReads; },
    set hangReads(value: false | "get" | "context") { opencode.state.hangReads = value; },
    get foreignHook() { return opencode.state.foreignHook !== undefined; },
    set foreignHook(value: boolean) { opencode.state.foreignHook = value ? foreign : undefined; },
    /** The OpenCode version the simulator follows (BEHAVIOR.md "Versions"); a scenario of one version sets it and sets it back. */
    get version() { return opencode.state.version; },
    set version(value: OpenCodeVersion) { opencode.state.version = value; },
  };

  const queriesOf = (counted: [number, number]) => claude.queries.slice(counted[0], counted[1]);
  /** A turn of `chat` as OpenCode runs it (simulators/opencode.ts `turn`), its requests in this world's form. */
  const turn = async (chat: string, options: Parameters<typeof opencode.turn>[1] = {}) => {
    const result = await opencode.turn(chat, options);
    const requests: Request[] = result.requests.map((sent) => ({
      list: sent.list,
      queries: queriesOf(sent.counted),
      status: sent.status,
      ...(sent.reply?.reasoning ? { reasoning: sent.reply.reasoning } : {}),
      ...(sent.reply && sent.reply.toolCalls.length > 0 ? { toolCalls: sent.reply.toolCalls } : {}),
      ...(sent.reply && sent.status === 200 && sent.reply.toolCalls.length === 0 ? { text: sent.reply.text } : {}),
    }));
    return { ...result, requests };
  };
  /** OpenCode compacts `chat` with Claude: the hook's list and the queries it started. */
  const compact = async (chat: string) => {
    const result = await opencode.compact(chat);
    return { list: result.list, queries: queriesOf(result.counted) };
  };

  return {
    tmp: world.tmp, projectDir: world.projectDir, logPath: world.logPath,
    state, queries: claude.queries, answers: claude.answers, records: claude.records, chainTo: claude.chainTo, recordText: claude.recordText, leafOf: claude.leafOf,
    claude: claude.chat, context: opencode.context, get: opencode.get,
    sessions: opencode.sessions, newChat: opencode.newChat, session: opencode.session, add: opencode.add, say: opencode.say,
    otherModelAnswer: opencode.otherModelAnswer, between: opencode.between, visible: opencode.visible, undoBefore: opencode.undoBefore, lastId: opencode.lastId,
    toList: (messages: Msg[]) => toList(messages),
    toBody: (list: ListMessage[]) => lowerMessages([], list, "sonnet"),
    instances: opencode.instances, startPlugin: () => opencode.startPlugin(), stopPlugin: opencode.stopPlugin,
    emit: opencode.emit, fork: opencode.fork, forkEvent: opencode.forkEvent, through: opencode.through, before: opencode.before,
    queue: opencode.queue, deliver: opencode.deliver, turn, compact, compactElsewhere: opencode.compactElsewhere, remove: opencode.remove, importChat: opencode.importChat,
    journal: world.journal, snapshot: claude.snapshot,
    dispose: world.dispose,
  };
}

export type ForkWorld = Awaited<ReturnType<typeof createForkWorld>>;

const TOKEN = /\b(?:q|o|t)\d+\b|\bL\d+\b/g;
/** The tokens of fork-session's texts: questions q1…, answers L1…, other models' o1…, tool results t1…. */
export const tokens = (text: string) => text.match(TOKEN) ?? [];

/**
 * The turns of fork-session's cases: `q()` the next question token (`n` the
 * last one's number), `claude` a turn of Claude's that must pass (its last
 * query), `firstTurn` a fork's first turn — what it copied, where, what Claude
 * got, and the turn's notes.
 */
export function forkTurns(w: ForkWorld) {
  /** The plugin's notes of the last turn (its reasoning lines), "" when none. */
  let lastNotes = "";
  const turns = {
    n: 0,
    q: () => `q${++turns.n}`,
    /** A turn of Claude's that must pass: its last query. */
    claude: async (chat: string, options: Parameters<ForkWorld["turn"]>[1] = {}) => {
      const r = await w.turn(chat, options);
      assert.ok(r.ok, `turn of ${chat}: ${r.requests.map((x) => x.status).join(",")}`);
      lastNotes = r.requests.at(-1)!.reasoning ?? "";
      return r.requests.at(-1)!.queries.at(-1)! as ClaudeQuery;
    },
    /** The fork's first turn: what it copied, where, what Claude got, and the turn's notes. */
    firstTurn: async (child: string) => {
      const before = w.journal().length;
      await w.say(child, turns.q());
      const query = await turns.claude(child);
      const forked = w.journal().slice(before).filter((line) => line.includes("forked chat")).map((line) => JSON.parse(line.slice(line.indexOf("{"))));
      return { query, seen: tokens(query.view), forked, notes: lastNotes };
    },
  };
  return turns;
}

const READ_TOOL: ToolDefinitions = {
  read: { description: "read", input: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
};

const fieldsOf = (line: string) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, any>;
/** The tool call ids a record's blocks name: its calls, or the calls its results answer. */
const toolIdsOf = (record: Rec): string[] =>
  (Array.isArray(record.message?.content) ? record.message.content : []).map((block: any) => block?.id ?? block?.tool_use_id).filter((id: unknown): id is string => typeof id === "string");
export const callsOf = (record: Rec) => (record.type === "assistant" ? toolIdsOf(record) : []);
export const resultsOf = (record: Rec) => (record.type === "user" && record.toolUseResult !== undefined ? toolIdsOf(record) : []);
/** A record the CLI writes for itself (environment, reminders): an attachment that carries no message of the user's. */
export const isService = (record: Rec) => record.type === "attachment" && record.attachment?.type !== "queued_command";

/**
 * The world of fork-list's cases: the simulators with bash and read offered,
 * the steps of a chat, the fork's first turn and where its copy was cut, and
 * the parents of the scenarios both fork-list files fork from. Call
 * `world.opencode.startPlugin()` before the first turn.
 */
export async function createForkListWorld(label: string) {
  const world = await createWorld(label);
  const { opencode, claude } = world;
  const { stepRecordName, userRecordName } = await pluginModule("names");
  const { contextList } = await pluginModule("session-fork");
  opencode.state.tools = { ...BASH_TOOL, ...READ_TOOL };
  let n = 0;
  const fresh = (prefix: string) => `${prefix}${++n}`;

  /** A turn that must pass. */
  const turn = async (chat: string, options: Parameters<typeof opencode.turn>[1] = {}) => {
    const result = await opencode.turn(chat, options);
    assert.ok(result.ok, `turn of ${chat}: ${result.requests.map((r) => r.status).join(",")}`);
    return result;
  };
  const ask = async (chat: string, text: string, options: Parameters<typeof opencode.turn>[1] = {}) => {
    const id = await opencode.say(chat, text);
    await turn(chat, options);
    return id;
  };
  const steps = (chat: string) => opencode.session(chat).messages.filter((m) => m.type === "assistant" && m.finish === "tool-calls");
  const message = (chat: string, text: string) => opencode.session(chat).messages.find((m) => m.text === text)!;
  const lastAnswer = (chat: string) => opencode.session(chat).messages.findLast((m) => m.type === "assistant" && m.finish === "stop")!;
  /** The transcript the latest turn of `chat` ran on, as the plugin's journal names it. */
  const transcriptOf = (chat: string) => {
    const line = world.journal().findLast((l) => /resuming the chat's Claude transcript|starting a new Claude transcript/.test(l) && l.includes(`"conversationKey":"${chat}"`));
    assert.ok(line, `the journal names a transcript of ${chat}`);
    return String(fieldsOf(line!).transcript);
  };
  /** The record of the parent's answer in words with this text. */
  const answerRecord = (name: string, text: string) => claude.records(name).find((r) => r.type === "assistant" && claude.recordText(r) === text);

  /**
   * The fork's first turn on Claude: its first query, the journal's lines of
   * the fork ("forked chat", the plan with the messages missed), and the
   * parent's records the copy holds, down to its point.
   */
  const firstTurn = async (fork: string) => {
    const fromLine = world.journal().length;
    const fromQuery = claude.queries.length;
    const question = fresh("next");
    await opencode.say(fork, question);
    await turn(fork);
    const lines = world.journal().slice(fromLine);
    const forked = lines.filter((l) => l.includes("[opencode-claude] forked chat") && l.includes(`"id":"${fork}"`)).map(fieldsOf);
    const plans = lines.filter((l) => l.includes("resuming the chat's Claude transcript") && l.includes(`"conversationKey":"${fork}"`)).map(fieldsOf);
    const query = claude.queries.slice(fromQuery).find((q) => q.kind === "chat") as ClaudeQuery;
    const chain = query.copiedFrom && query.at ? claude.chainTo(query.copiedFrom, query.at) : [];
    return { query, forked: forked[0], plan: plans[0], chain, point: chain.at(-1), view: query.view, lines, question };
  };
  /** The first turn copied the parent's transcript: the journal's line and the query agree. */
  const copied = (f: Awaited<ReturnType<typeof firstTurn>>, label: string) => {
    assert.equal(f.forked?.outcome, "forked", `${label}: the journal says the fork copied (${JSON.stringify(f.forked)})`);
    assert.ok(f.query.copiedFrom, `${label}: the first query is a copy`);
    assert.equal(f.query.copiedFrom, f.forked.from, `${label}: copied from the transcript the journal names`);
    assert.equal(f.query.at, f.forked.point, `${label}: cut where the journal says`);
    assert.equal(f.plan?.copyFor, "fork", `${label}: the plan runs on the copy`);
    assert.ok(f.point, `${label}: the point is a record of the source`);
  };
  /** A chain in one line, for a failure's message: each record's type and text. */
  const describe = (chain: Rec[]) => chain.map((r) => `${r.attachment?.type ?? r.type}${r.queueTranscriptOnly ? "(no turn)" : ""} ${JSON.stringify(claude.recordText(r).slice(0, 40))}`).join(" → ");
  /** The records of the chain after the one with this uuid. */
  const after = (chain: Rec[], uuid: string) => {
    const at = chain.findIndex((r) => r.uuid === uuid);
    assert.ok(at >= 0, `${uuid} is on the copy's chain: ${describe(chain)}`);
    return chain.slice(at + 1);
  };

  // ---- The parents of the scenarios both files fork from. ----

  /** A step whose results reached Claude as text: the process died while its tool ran, the turn rebuilt the step. */
  const rebuiltStepParent = async () => {
    const K = opencode.newChat();
    await ask(K, "q-k0");
    await opencode.say(K, "q-k1");
    claude.state.toolTurn = true;
    claude.state.failures = ["killedWhileTool"];
    await turn(K, { toolOutput: "t-rebuilt" });
    assert.ok(world.journal().some((l) => l.includes("rebuilding the turn with them") && l.includes(`"conversationKey":"${K}"`)), "the parent's step went as a rebuilt step");
    const [step] = steps(K);
    return { K, step: step! };
  };

  /** Two calls of one answer, a message sent meanwhile (made once per world). */
  let twoCalls: Promise<{ Y: string; asked: string; first: Msg; callB: string }> | undefined;
  const twoCallsParent = () =>
    (twoCalls ??= (async () => {
      const Y = opencode.newChat();
      const asked = await opencode.say(Y, "q-y1");
      claude.state.toolSteps = [2];
      await turn(Y, { toolOutput: "t-ab", steer: "q-y2" });
      const [first, second] = steps(Y);
      assert.ok(first && second && first.toolCalls!.length === 1, "bash runs one call at a time: the calls of one answer are two steps on the screen");
      const callB = second!.toolCalls![0]!.id;
      assert.ok(claude.records(transcriptOf(Y)).some((r) => callsOf(r).includes(callB)), "the parent wrote both calls before their results");
      return { Y, asked, first: first!, callB };
    })());

  /** A reminder (a synthetic message of OpenCode's) spliced between the question and the answer. */
  const reminderParent = async () => {
    const M = opencode.newChat();
    await opencode.say(M, "q-reminded");
    opencode.between(M, "synthetic", "<system-reminder>\nPlan mode is active.\n</system-reminder>");
    await turn(M);
    return M;
  };

  /** Another model's turn that ended on a step, which the next Claude turn sent as a missed record. */
  const otherModelStepParent = async () => {
    const M = opencode.newChat();
    await ask(M, "q-m1");
    await opencode.say(M, "q-m2");
    const other = opencode.otherModelAnswer(M, "", { finish: "tool-calls", toolCalls: [{ id: "call_other", name: "bash", input: { command: "ls" } }], toolResults: [{ id: "call_other", output: "t-other" }] });
    await ask(M, "q-m3");
    const name = transcriptOf(M);
    const missed = claude.records(name).find((r) => r.queueTranscriptOnly && claude.recordText(r).includes("t-other"));
    assert.ok(missed, "the parent's next Claude turn sent the other model's turn as a missed record");
    return { M, other, missed: missed! };
  };

  return {
    world, opencode, claude, stepRecordName, userRecordName, contextList,
    turn, ask, steps, message, lastAnswer, transcriptOf, answerRecord, firstTurn, copied, describe, after, fieldsOf,
    rebuiltStepParent, twoCallsParent, reminderParent, otherModelStepParent,
  };
}
