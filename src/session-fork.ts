/**
 * A fork of a chat starts from a copy of its parent's Claude transcript.
 *
 * OpenCode copies the parent's messages into the fork under new ids, with
 * their metadata: the `prompt` hook put each user message's own id there
 * (index.ts), so the fork's messages name the same records as the parent's
 * (names.ts). The fork's first turn on Claude copies the parent's transcript
 * into the fork's own, cut where the fork's history ends, and runs in the
 * copy (proxy.ts planChatTurn: `resume` + `forkSession: true` + `sessionId` +
 * `resumeSessionAt` keeps the uuids, probes 12 and 39; the SDK's
 * forkSession() gives new ones and is not used). The history is then read
 * from the prompt cache the parent wrote.
 *
 * Nothing happens when the fork is made: the parent's transcript keeps the
 * fork's history whatever the parent does next. Its later turns are written
 * after it; a revert copies the parent into a new version and leaves the old
 * one as it was; a compaction starts a transcript of a new epoch. So the copy
 * waits for the fork's first turn, and needs no event.
 *
 * Where the copy comes from: the fork's messages from `session.context`
 * (with the ids and result statuses of its tool calls); the version of the
 * parent's transcript in the fork's epoch that holds the most of them on its
 * leaf chain; the cut at the record of the last screen message that has an
 * id in the transcript (turn-point.ts planCopy), moved onto the leaf chain
 * when another process wrote after it (planCopyOnLeafChain). A parent without a transcript in that epoch (a fork that never
 * ran on Claude, or a chat another model answered) is passed for its own
 * parent, up to MAX_FORK_DEPTH.
 */
import { log } from "./log.js";
import { checkpointText, epochOfList, type ListMessage } from "./names.js";
import { chatTranscripts, type TranscriptFile } from "./transcripts.js";
import { expectedChain, indexRecords, launchingEntry, planCopyOnLeafChain, type TranscriptRecord } from "./turn-point.js";

/** How far up a chain of forks the parent's transcript is looked for. */
export const MAX_FORK_DEPTH = 10;

/** The two calls the plugin makes on OpenCode for a fork (the plugin context's `session`). */
export type SessionReader = {
  get(input: { sessionID: string }): Promise<unknown>;
  context(input: { sessionID: string }): Promise<unknown>;
};

type ForkRuntime = { readers: SessionReader[] };

const RUNTIME_KEY = Symbol.for("@openchamber/opencode-claude/session-fork/v1");

/** Kept in the process: the proxy of any copy of the module reads through any loaded instance. */
const runtime: ForkRuntime = ((globalThis as Record<symbol, unknown>)[RUNTIME_KEY] ??= {
  readers: [],
}) as ForkRuntime;

/** A plugin instance lends its OpenCode client; the returned function takes it back at unload. */
export function registerSessionReader(reader: SessionReader): () => void {
  runtime.readers.push(reader);
  return () => {
    const at = runtime.readers.indexOf(reader);
    if (at >= 0) runtime.readers.splice(at, 1);
  };
}

/** The OpenCode client of the latest loaded instance, if any is loaded. */
export function sessionReader(): SessionReader | undefined {
  return runtime.readers.at(-1);
}

/**
 * How long a fork's first turn waits for one read from OpenCode (session.get,
 * session.context). OpenCode answers from its own process at once; a read that
 * hangs must not hang the turn: past the limit the read fails, and the turn
 * starts as text, like a chat with nothing to copy (proxy.ts forkCopySource).
 * OPENCODE_CLAUDE_OPENCODE_READ_MS sets another limit.
 */
const DEFAULT_READ_TIMEOUT_MS = 10_000;

function readTimeoutMs(): number {
  const raw = Number(process.env.OPENCODE_CLAUDE_OPENCODE_READ_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_READ_TIMEOUT_MS;
}

/** The reader with every read bounded in time: a read past the limit fails with an error that says so. */
export function boundedReader(reader: SessionReader, ms: number = readTimeoutMs()): SessionReader {
  const bounded = <T>(what: string, read: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`OpenCode did not answer ${what} within ${ms} ms`)), ms);
    });
    return Promise.race([read, late]).finally(() => clearTimeout(timer));
  };
  return {
    get: (input) => bounded("session.get", reader.get(input)),
    context: (input) => bounded("session.context", reader.context(input)),
  };
}

/** The fork a chat was made by (`session.get`): its parent and boundary; null for a chat that is no fork. */
export async function forkOf(
  reader: SessionReader,
  sessionID: string,
): Promise<{ sessionID: string; boundary?: { type?: string; messageID?: string } } | null> {
  const info = (await reader.get({ sessionID })) as { fork?: { sessionID?: unknown; boundary?: unknown } } | null;
  const parent = info?.fork?.sessionID;
  if (typeof parent !== "string" || !parent) return null;
  return { sessionID: parent, boundary: info!.fork!.boundary as { type?: string; messageID?: string } | undefined };
}

type ContextInfo = Record<string, any>;

/** session.context's messages: an array, or `{ data }` as the HTTP API wraps it. */
function contextInfos(raw: unknown): ContextInfo[] {
  if (Array.isArray(raw)) return raw as ContextInfo[];
  const data = (raw as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as ContextInfo[]) : [];
}

/**
 * A chat's messages from session.context in the form of the hook's list
 * (OpenCode's to-llm-message.ts, the parts the names and the turn rule
 * read: ids, metadata, the checkpoint's text, tool call ids with the status
 * of their results). Whether a turn finished is not read here: the copy is
 * cut at the record of the last screen message that has one (turn-point.ts
 * planCopy), and an answer OpenCode has not completed is not on the screen.
 */
export function contextList(raw: unknown): { list: ListMessage[] } {
  const list: ListMessage[] = [];
  for (const info of contextInfos(raw)) {
    const metadata = info.metadata as Record<string, unknown> | undefined;
    switch (info.type) {
      case "user": {
        const text = typeof info.text === "string" ? info.text : "";
        const skills = (Array.isArray(info.skills) ? info.skills : [])
          .map((skill: { text?: unknown }) => skill?.text)
          .filter((skill: unknown): skill is string => typeof skill === "string");
        const files = Array.isArray(info.files) ? info.files.length : 0;
        if (!text && skills.length === 0 && files === 0) break;
        // Attachments only as their kind: the names and the turn rule read no more.
        const content = [
          ...skills.map((skill: string) => ({ type: "text", text: skill })),
          ...(text ? [{ type: "text", text }] : []),
          ...Array.from({ length: files }, () => ({ type: "media" })),
        ];
        list.push({ id: info.id, role: "user", content, ...(metadata ? { metadata } : {}) });
        break;
      }
      case "synthetic":
      case "skill":
        list.push({ id: info.id, role: "user", content: String(info.text ?? ""), ...(metadata ? { metadata } : {}) });
        break;
      case "shell":
        if (metadata?.background === true) break;
        list.push({ id: info.id, role: "user", content: `shell: ${String(info.command ?? "")}`, ...(metadata ? { metadata } : {}) });
        break;
      case "location-switched":
        list.push({ id: info.id, role: "user", content: "The working directory has been changed.", ...(metadata ? { metadata } : {}) });
        break;
      case "compaction": {
        if (info.status !== "completed") break;
        // The kept tail: OpenCode 2.2.0 reads it anew from `metadata.keepID` into
        // `metadata.recent` (history.ts withRecentText); 2.0.32 stored it in `recent`.
        const recent = typeof metadata?.recent === "string" ? metadata.recent : info.recent;
        list.push({ id: info.id, role: "user", content: checkpointText(String(info.summary ?? ""), recent ? String(recent) : undefined) });
        break;
      }
      case "assistant": {
        const items = Array.isArray(info.content) ? (info.content as ContextInfo[]) : [];
        const parts: unknown[] = [];
        const results: unknown[] = [];
        for (const item of items) {
          if (item.type === "text" && item.text) parts.push({ type: "text", text: item.text });
          // An answer of reasoning alone (its output ran out) is an answer all the same.
          if (item.type === "reasoning" && item.text) parts.push({ type: "reasoning", text: item.text });
          if (item.type !== "tool") continue;
          parts.push({ type: "tool-call", id: item.id, name: item.name, input: item.state?.input });
          const status = item.state?.status;
          if (status === "completed" || status === "error") results.push({ type: "tool-result", id: item.id, name: item.name });
        }
        if (parts.length > 0) list.push({ id: info.id, role: "assistant", content: parts, ...(metadata ? { metadata } : {}) });
        // One `tool` message per result, as the hook's list has them
        // (to-llm-message.ts: Message.tool per result): the list indexes of a
        // fork's screen and of the hook's list must agree (proxy.ts planChatTurn).
        for (const result of results) list.push({ role: "tool", content: [result] });
        break;
      }
    }
  }
  return { list };
}

/** A parent's transcript a fork's first turn copies. */
export type CopySource = {
  /** The chat whose transcript it is: the parent, or a chat further up. */
  chat: string;
  transcript: TranscriptFile;
  records: TranscriptRecord[];
  /** Where the copy is cut, and the last list message it holds. */
  point: string;
  coveredIndex: number;
  /** The cut moved onto the leaf chain: where it stood, and where its branch leaves the leaf chain (planCopyOnLeafChain). */
  offLeafChain?: { point: string; ancestor: string };
};

export type CopyPlan =
  | { kind: "copy"; epoch: string; source: CopySource }
  | { kind: "nothing"; epoch: string; outcome: "no-session" | "nothing-before"; why: string };

/**
 * Where a fork's copy comes from: its messages (session.context), its
 * epoch, the nearest chat up its chain of forks that has transcripts in
 * that epoch, and of those the version that holds the most of the fork's
 * history on its leaf chain (the newest on a tie). A revert of the parent
 * after the fork left the fork's history in an older version. The versions
 * are read from the newest down, and no further than the first that holds
 * all the screen a transcript can: a big transcript with many versions is
 * read once, not once per version. `configDir` is
 * the Claude account of the fork's project, which its parents share.
 */
export async function planForkCopy(
  reader: SessionReader,
  sessionID: string,
  parentID: string,
  configDir?: string,
): Promise<CopyPlan> {
  const { list } = contextList(await reader.context({ sessionID }));
  const epoch = epochOfList(list);
  // One chain of the fork's screen for every version of every chat up the forks.
  const chain = expectedChain(list);
  // The most a parent's transcript can hold of the screen: everything before
  // the message this turn is about, the fork's own. A version that holds that
  // much cannot be beaten, and the older ones are not read: a fork made from
  // where its parent is now finds it in the newest.
  const launching = launchingEntry(chain);
  const most = launching ? launching.index - 1 : list.length - 1;
  let chat: string | undefined = parentID;
  for (let depth = 0; chat && depth < MAX_FORK_DEPTH; depth++) {
    let best: CopySource | undefined;
    const from: string = chat;
    // Versions come highest first: the newest wins a tie.
    const take = (transcript: TranscriptFile): boolean => {
      const cut = planCopyOnLeafChain(transcript.records, list, chain, indexRecords(transcript.records));
      if (cut && (!best || cut.coveredIndex > best.coveredIndex)) {
        best = { chat: from, transcript, records: transcript.records, ...cut };
      }
      return !!best && best.coveredIndex >= most;
    };
    const { withRecords } = await chatTranscripts(chat, epoch, { all: true, configDir, enough: take });
    if (withRecords.length > 0) {
      if (!best) {
        return { kind: "nothing", epoch, outcome: "nothing-before", why: "no transcript of the parent holds a record of the fork's screen on its leaf chain" };
      }
      return { kind: "copy", epoch, source: best };
    }
    chat = (await forkOf(reader, chat))?.sessionID;
  }
  return {
    kind: "nothing",
    epoch,
    outcome: "no-session",
    why: chat ? `no transcript within ${MAX_FORK_DEPTH} forks up` : "no chat up the forks has a transcript in this epoch",
  };
}

/** One journal line per fork's first turn: which chat, from what, and how it ended. */
export function logForkedChat(fields: {
  id: string;
  parent: string;
  outcome: "forked" | "no-session" | "nothing-before" | "failed";
  type?: string;
  messageID?: string;
  [key: string]: unknown;
}): void {
  const line = "[opencode-claude] forked chat";
  if (fields.outcome === "failed") log.warn(line, fields);
  else log.info(line, fields);
}
