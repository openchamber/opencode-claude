/**
 * Where a Claude Code transcript continues for a chat turn.
 *
 * OpenCode's message list (context-list.ts) names the records the transcript
 * should hold (names.ts). The transcript is read, the last of those records
 * is found by name, and the turn resumes at the end of that record's turn
 * with `resumeSessionAt`: what the list holds after it is missed, and goes
 * ahead of the prompt as one record. That one rule covers a plain
 * continuation (the point is the end of the transcript), a revert or an edit
 * (the point is earlier, and the turn copies the transcript up to it into a
 * new version: cutsMessages, proxy.ts planChatTurn), turns another provider answered or that failed before
 * Claude wrote anything (missed), and a retry of the same message (its record is already in
 * the transcript: the point is the end of the turn before it, and the new
 * record gets the next attempt number). Every transcript starts with a
 * blank record without a turn (names.ts TRANSCRIPT_START_NAME): when none
 * of the list's records before the message is in the transcript (the chat's
 * first message, its retry), the point is that record.
 *
 * Records are matched in file order, not along the CLI's current leaf chain:
 * the record wanted can sit on a side branch (a revert, a turn a lost
 * process finished later). The end of a turn follows the record's
 * descendants (`parentUuid`, or `logicalParentUuid` after a CLI compaction
 * boundary) up to the next prompt record, and never through a message
 * absorbed mid-turn that the list does not have (foreignAttachment).
 *
 * A fork's copy of its parent's transcript is cut by the same ids, read down
 * the fork's screen (planCopy): every screen message but an answer in words
 * has an id that finds its record, a tool step by the id of its call, which
 * the CLI gives and the proxy hands to OpenCode (probe 43).
 *
 * The CLI resumes and copies at a record only along the leaf chain (the last
 * chain record written and its ancestors; probes 4, 8, 39). A point or a cut
 * off it (a lost process wrote its answer after the chat's own turns) moves
 * to where its branch leaves the leaf chain (leafChainAncestor): the turn or
 * the copy is planned on the records down to there, and what the list holds
 * after goes as missed, as after a revert.
 */
import { readFile } from "node:fs/promises";
import { startsTurn } from "./prompt.js";
import {
  MAX_ATTEMPTS,
  ORIGINAL_ID_KEY,
  TRANSCRIPT_START_NAME,
  checkpointRecordName,
  isCheckpointMessage,
  stepRecordName,
  textOfMessage,
  userRecordName,
  type ListMessage,
} from "./names.js";

/** One line of a Claude Code transcript, with its position in the file. */
export type TranscriptRecord = {
  line: number;
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  attachment?: { type?: string; source_uuid?: string };
  toolUseResult?: unknown;
  isCompactSummary?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  queueTranscriptOnly?: boolean;
  message?: { role?: string; content?: unknown };
};

/** Read a transcript: every JSON line that has a uuid, in file order. */
export async function readTranscript(file: string): Promise<TranscriptRecord[]> {
  const text = await readFile(file, "utf8");
  return parseTranscript(text);
}

/**
 * The records of a transcript, each with only what the plugin decides by:
 * links, kind, flags, the source of an absorbed message, the text of an
 * answer and of the CLI's record of a stop, the ids of tool calls and
 * results (messageOf). A question's text, an image, a document, the body of
 * a tool result, a thinking block keep their kind only: the
 * plugin never reads them (the CLI reads the file itself), and a transcript
 * with attachments holds megabytes of them per record. A fork's first turn
 * holds every version of its parent's transcript at once (planForkCopy).
 * Claude Code (2.1.300 and later) writes every line whole and a subagent's
 * records to a file of their own (the 2.1.300 probe): each line is JSON of
 * the chat's own.
 */
export function parseTranscript(text: string): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  const lines = text.split("\n");
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line]!;
    if (!raw.trim()) continue;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    if (typeof entry.type !== "string" || typeof entry.uuid !== "string") continue;
    records.push({
      line,
      type: entry.type,
      uuid: entry.uuid,
      parentUuid: typeof entry.parentUuid === "string" ? entry.parentUuid : null,
      logicalParentUuid: typeof entry.logicalParentUuid === "string" ? entry.logicalParentUuid : null,
      attachment: attachmentOf(entry.attachment),
      // Whether the record is a tool result; its payload is not kept.
      toolUseResult: entry.toolUseResult === undefined ? undefined : true,
      isCompactSummary: entry.isCompactSummary === true,
      isMeta: entry.isMeta === true,
      isApiErrorMessage: entry.isApiErrorMessage === true,
      queueTranscriptOnly: entry.queueTranscriptOnly === true,
      message: messageOf(entry.message, entry.type),
    });
  }
  return records;
}

/** An attachment record's kind and the message it absorbed (its prompt and the rest are not kept). */
function attachmentOf(value: unknown): TranscriptRecord["attachment"] {
  if (!value || typeof value !== "object") return undefined;
  const attachment = value as { type?: unknown; source_uuid?: unknown };
  return {
    ...(typeof attachment.type === "string" ? { type: attachment.type } : {}),
    ...(typeof attachment.source_uuid === "string" ? { source_uuid: attachment.source_uuid } : {}),
  };
}

/**
 * A message's role and content, each block reduced to what the plugin reads:
 * a text block its text, a tool call its id, a tool result the id of the
 * call it answers, any other block its kind. A user record's text is read
 * only to tell the CLI's record of a stop (isInterruptRecord): it is kept
 * when it is that text whole, and dropped otherwise (a question with a long
 * pasted log, the history as text, a checkpoint). An answer's text is kept:
 * a stopped answer is compared with the start the screen holds (answerCutShort).
 */
function messageOf(value: unknown, type: unknown): TranscriptRecord["message"] {
  if (!value || typeof value !== "object") return undefined;
  const message = value as { role?: unknown; content?: unknown };
  const role = typeof message.role === "string" ? { role: message.role } : {};
  const keepText = (text: unknown) => type !== "user" || (typeof text === "string" && INTERRUPT_TEXTS.has(text.trim()));
  if (!Array.isArray(message.content)) {
    return { ...role, content: typeof message.content === "string" && !keepText(message.content) ? "" : message.content };
  }
  const content = message.content.map((block: unknown) => {
    if (!block || typeof block !== "object") return block;
    const b = block as { type?: unknown; text?: unknown; id?: unknown; tool_use_id?: unknown };
    if (b.type === "text") return keepText(b.text) ? { type: "text", text: b.text } : { type: "text" };
    if (b.type === "tool_use") return { type: "tool_use", id: b.id };
    if (b.type === "tool_result") return { type: "tool_result", tool_use_id: b.tool_use_id };
    return { type: b.type };
  });
  return { ...role, content };
}

/**
 * A prompt record: a user record that starts a turn. Tool results, the
 * CLI's own compaction summary and the trace of a slash command are user
 * records too, but they belong to the turn they sit in.
 */
export function isPromptRecord(record: TranscriptRecord): boolean {
  return (
    record.type === "user" &&
    record.toolUseResult === undefined &&
    !record.isCompactSummary &&
    !record.isMeta &&
    !isInterruptRecord(record)
  );
}

/** The texts of the record the CLI writes when a turn is interrupted, whole: a user message that starts with them is a message. */
const INTERRUPT_TEXTS = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);

/**
 * The record the CLI writes when a turn is interrupted ("[Request
 * interrupted by user]", "… for tool use" on a parked turn, probe 41): a
 * user record without isMeta, but the CLI's own, part of the turn it stops.
 * Only the whole text counts: a user who pastes that line into a longer
 * message has written a prompt.
 */
function isInterruptRecord(record: TranscriptRecord): boolean {
  const content = record.message?.content;
  const blocks = Array.isArray(content) ? content : content === undefined ? [] : [{ type: "text", text: content }];
  if (blocks.length !== 1) return false;
  const text = String((blocks[0] as { text?: unknown } | undefined)?.text ?? "");
  return INTERRUPT_TEXTS.has(text.trim());
}

/**
 * What the list says a record is: a user message, a checkpoint, a rebuilt
 * tool step, or an answer the transcript never saw (another model's, sent
 * as a record of its own without a turn).
 */
export type ChainEntry = {
  /** Position in the list. */
  index: number;
  kind: "message" | "checkpoint" | "step" | "reply";
  /** The OpenCode id the names are made of (a message id, or the tool call ids of a step). */
  source: string;
  /** The record's name for each attempt, attempt 1 first; shared between chains, never written to. */
  names: readonly string[];
};

/**
 * Lookups over one array of records, built once per plan and handed down to
 * the functions that walk it: records by uuid (the last one in file order
 * when a uuid repeats, as the maps built in place did), children by parent
 * (`parentUuid`, or `logicalParentUuid` after a CLI compaction boundary),
 * and the names the records carry (ownName). An index belongs to the array
 * it was built from: a cut (chainTo) gets an index of its own.
 */
export type RecordIndex = {
  byUuid: ReadonlyMap<string, TranscriptRecord>;
  children: ReadonlyMap<string, readonly TranscriptRecord[]>;
  names: ReadonlySet<string>;
};

export function indexRecords(records: readonly TranscriptRecord[]): RecordIndex {
  const byUuid = new Map<string, TranscriptRecord>();
  const children = new Map<string, TranscriptRecord[]>();
  const names = new Set<string>();
  for (const record of records) {
    if (record.uuid) byUuid.set(record.uuid, record);
    const parent = record.parentUuid || record.logicalParentUuid;
    if (parent) {
      const list = children.get(parent);
      if (list) list.push(record);
      else children.set(parent, [record]);
    }
    const name = ownName(record);
    if (name) names.add(name);
  }
  return { byUuid, children, names };
}

/**
 * The names of a chain by name: which entry and attempt each is. Built once
 * per chain array and kept with it (chains are never changed once built);
 * `position` is the entry's place in the chain.
 */
export type ChainIndex = ReadonlyMap<string, { entry: ChainEntry; attempt: number; position: number }>;

const chainIndexes = new WeakMap<readonly ChainEntry[], ChainIndex>();

export function chainIndex(chain: readonly ChainEntry[]): ChainIndex {
  const kept = chainIndexes.get(chain);
  if (kept) return kept;
  const byName = new Map<string, { entry: ChainEntry; attempt: number; position: number }>();
  chain.forEach((entry, position) => {
    entry.names.forEach((name, i) => byName.set(name, { entry, attempt: i + 1, position }));
  });
  chainIndexes.set(chain, byName);
  return byName;
}

/** The OpenCode id a list message is named after: the original's id for a fork's copy. */
export function messageIdOf(message: ListMessage): string | undefined {
  const original = message.metadata?.[ORIGINAL_ID_KEY];
  if (typeof original === "string" && original) return original;
  return typeof message.id === "string" && message.id ? message.id : undefined;
}

/** Ids of the tool calls an assistant list message made. */
export function toolCallIdsOf(message: ListMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content
    .filter(
      (part): part is { type: "tool-call"; id: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "tool-call" &&
        typeof (part as { id?: unknown }).id === "string",
    )
    .map((part) => part.id);
}

const attempts = (name: (attempt: number) => string): string[] =>
  Array.from({ length: MAX_ATTEMPTS }, (_, i) => name(i + 1));

/**
 * The attempt names of a message or a step, built once per process: every
 * turn names the whole screen again, and an id's names never change. The
 * arrays are shared by the entries of later chains and never written to.
 * A checkpoint's names are not kept: its key would be the checkpoint's text.
 */
const NAMES_CACHE_MAX = 10_000;
const namesCache = new Map<string, readonly string[]>();

function namesOf(key: string, name: (attempt: number) => string): readonly string[] {
  const cached = namesCache.get(key);
  if (cached) return cached;
  const names = attempts(name);
  if (namesCache.size >= NAMES_CACHE_MAX) namesCache.delete(namesCache.keys().next().value!);
  namesCache.set(key, names);
  return names;
}

/**
 * The records the transcript should hold for this list, in list order:
 * one per user message (a fork's copy named after the original), one per
 * checkpoint, one per tool step (only present when the step was rebuilt),
 * one per answer with an id (only present when it went as a missed record).
 */
export function expectedChain(messages: readonly ListMessage[]): ChainEntry[] {
  const chain: ChainEntry[] = [];
  messages.forEach((message, index) => {
    if (message.role === "user") {
      if (isCheckpointMessage(message)) {
        const text = textOfMessage(message);
        chain.push({ index, kind: "checkpoint", source: text, names: attempts((a) => checkpointRecordName(text, a)) });
        return;
      }
      const id = messageIdOf(message);
      if (!id) return;
      chain.push({ index, kind: "message", source: id, names: namesOf(`message:${id}`, (a) => userRecordName(id, a)) });
      return;
    }
    if (message.role === "assistant") {
      const id = messageIdOf(message);
      if (id) chain.push({ index, kind: "reply", source: id, names: namesOf(`message:${id}`, (a) => userRecordName(id, a)) });
      const ids = toolCallIdsOf(message);
      if (ids.length === 0) return;
      // The key in the form the name itself hashes (sorted, JSON): ids joined with commas could collide.
      const key = `step:${JSON.stringify([...ids].sort())}`;
      chain.push({ index, kind: "step", source: ids.join(","), names: namesOf(key, (a) => stepRecordName(ids, a)) });
    }
  });
  return chain;
}

/** The entry of the record a turn is about: the last one that is not an answer. */
function launchingAt(chain: readonly ChainEntry[]): number {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i]!.kind !== "reply") return i;
  }
  return -1;
}

/** The entry a turn's record is named by: the list's last message, checkpoint or step. */
export function launchingEntry(chain: readonly ChainEntry[]): ChainEntry | undefined {
  return chain[launchingAt(chain)];
}

export type FoundRecord = { record: TranscriptRecord; entry: ChainEntry; attempt: number };

/** Our uuid of a record: its own for a user record, the source uuid for an absorbed mid-turn message. */
function ownName(record: TranscriptRecord): string | undefined {
  if (record.type === "user") return record.uuid;
  if (record.type === "attachment") return record.attachment?.source_uuid;
  return undefined;
}

/**
 * The last record in file order that the chain names, among the chain's
 * first `upTo` entries (all of them by default).
 */
export function findLastChainRecord(
  records: readonly TranscriptRecord[],
  chain: readonly ChainEntry[],
  upTo: number = chain.length,
): FoundRecord | null {
  const byName = chainIndex(chain);
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!;
    const name = ownName(record);
    if (!name) continue;
    const hit = byName.get(name);
    if (hit && hit.position < upTo) return { record, entry: hit.entry, attempt: hit.attempt };
  }
  return null;
}

/** The names the transcript holds (see ownName). */
function namesIn(records: readonly TranscriptRecord[]): Set<string> {
  return new Set(records.map(ownName).filter((name): name is string => !!name));
}

/**
 * The next attempt number for an entry: one more than the highest attempt
 * the transcript holds. `present`: the transcript's names, when the caller
 * has them (RecordIndex.names).
 */
export function nextAttempt(
  records: readonly TranscriptRecord[],
  entry: ChainEntry,
  present: ReadonlySet<string> = namesIn(records),
): number {
  let attempt = 0;
  entry.names.forEach((name, i) => {
    if (present.has(name)) attempt = i + 1;
  });
  return attempt + 1;
}

/** Ids of the tool calls an assistant record makes (its `tool_use` blocks). */
function toolUseIdsOfRecord(record: TranscriptRecord): string[] {
  if (record.type !== "assistant" || !Array.isArray(record.message?.content)) return [];
  return record.message.content
    .filter((block): block is { type: "tool_use"; id: string } => (block as { type?: unknown } | null)?.type === "tool_use" && typeof (block as { id?: unknown }).id === "string")
    .map((block) => block.id);
}

/** Ids of the tool calls a user record answers (its `tool_result` blocks). */
function toolResultIdsOfRecord(record: TranscriptRecord): string[] {
  if (record.type !== "user" || !Array.isArray(record.message?.content)) return [];
  return record.message.content
    .filter((block): block is { type: "tool_result"; tool_use_id: string } => (block as { type?: unknown } | null)?.type === "tool_result" && typeof (block as { tool_use_id?: unknown }).tool_use_id === "string")
    .map((block) => block.tool_use_id);
}

/**
 * Whether a record is a message absorbed mid-turn (`attachment` with a
 * `source_uuid`) under a name the list does not have: it belongs to a turn
 * the list does not hold whole, and a walk over a turn's records stops before
 * it. Tool records never stop the walk: a call the list lacks inside a turn
 * whose answer the list has is one the CLI handled by itself (a call its MCP
 * server rejected before the plugin saw it), and the answer is still the
 * list's; a step the list lacks past the fork's boundary is never reached,
 * because the walk only runs when the list shows the answer right after the
 * record it starts from (planCopy).
 */
/** What answers whether a name is one of the chain's: a ChainIndex, or a set of names. */
type ChainNames = { has(name: string): boolean };

function foreignAttachment(record: TranscriptRecord, chainNames: ChainNames): boolean {
  if (record.type !== "attachment") return false;
  const source = record.attachment?.source_uuid;
  return !!source && !chainNames.has(source);
}

/**
 * The last record of the turn that starts at `start`: the deepest descendant
 * before the next prompt record, and never through a message absorbed
 * mid-turn that the list does not name (foreignAttachment). `index`: the
 * records' index when the caller has built it.
 */
export function endOfTurn(
  records: readonly TranscriptRecord[],
  start: TranscriptRecord,
  chainNames: ChainNames,
  index: RecordIndex = indexRecords(records),
): TranscriptRecord {
  return deepestDescendant(start, (child) => !isPromptRecord(child) && !foreignAttachment(child, chainNames), index);
}

/** The deepest descendant of `start` (by file position) through records `admit` lets pass; `start` itself when none. */
function deepestDescendant(
  start: TranscriptRecord,
  admit: (record: TranscriptRecord) => boolean,
  index: RecordIndex,
): TranscriptRecord {
  const children = index.children;
  let end = start;
  const queue = [start];
  const seen = new Set<string>([start.uuid!]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current.uuid!) ?? []) {
      if (!child.uuid || seen.has(child.uuid)) continue;
      if (!admit(child)) continue;
      seen.add(child.uuid);
      if (child.line > end.line) end = child;
      queue.push(child);
    }
  }
  return end;
}

/**
 * Whether the turn from `start` to `end` holds an answer of the model: an
 * assistant record on the way back from `end` that is not an API error. The
 * CLI writes attachment records after a prompt too, so a turn that was killed
 * before it answered still goes past its prompt record.
 */
export function turnAnswered(
  records: readonly TranscriptRecord[],
  start: TranscriptRecord,
  end: TranscriptRecord,
  index: RecordIndex = indexRecords(records),
): boolean {
  const byUuid = index.byUuid;
  let current: TranscriptRecord | undefined = end;
  const seen = new Set<string>();
  while (current && current !== start && !seen.has(current.uuid!)) {
    seen.add(current.uuid!);
    if (current.type === "assistant" && !current.isApiErrorMessage) return true;
    const parent: string | null | undefined = current.parentUuid || current.logicalParentUuid;
    current = parent ? byUuid.get(parent) : undefined;
  }
  return false;
}

export type ResumePlan =
  /** The transcript holds nothing the list names, and no start record: start a new transcript. */
  | { kind: "none" }
  /** Every attempt's name of the message the turn is about is taken: the turn is refused. */
  | { kind: "exhausted" }
  /** Resume at `point`; list messages after `coveredIndex` are missed (see missedFrom). */
  | {
      kind: "resume";
      point: string;
      coveredIndex: number;
      /** Attempt number for the record of the message the turn is about. */
      attempt: number;
      /**
       * The CLI took the results of the tool step the turn ends at: they are
       * in the transcript, so a list ending with that step's results needs
       * no rebuilt step (see stepDelivered).
       */
      stepDelivered: boolean;
      /**
       * The transcript holds Claude's answer to the covered message (see
       * turnAnswered). When it does not, an answer the list has after that
       * message is another model's, or the part of Claude's that OpenCode
       * kept from a turn that broke off: missed like any later turn.
       */
      answered: boolean;
      /**
       * The end of the turn found by name was off the leaf chain, and the
       * point moved to the leaf chain: `point` is where the plan stood,
       * `ancestor` the record where its branch leaves the leaf chain.
       */
      offLeafChain?: { point: string; ancestor: string };
    };

/** Whether a record is Claude's call of a tool: an assistant record holding a tool_use block. */
function holdsToolUse(record: TranscriptRecord): boolean {
  return (
    record.type === "assistant" &&
    Array.isArray(record.message?.content) &&
    record.message.content.some((block) => (block as { type?: unknown } | null)?.type === "tool_use")
  );
}

/**
 * Whether Claude has the results of the tool step the turn at `point` ends
 * at. It has them when the transcript went on after the result record: the
 * CLI's turn continued (an answer or a next call, a message absorbed
 * mid-turn as an `attachment` with a `source_uuid`), or a later question was
 * asked over it (a fork's copy ends at a result, and the fork's first turn
 * resumed there: the result is history Claude read). The CLI's own service
 * records (a prompt snapshot after a result, probe 42; the record of a stop)
 * are no continuation, and a point on one of them is read at the record they
 * trail. A point on an absorbed message means the results before it were
 * taken. A turn that ends at the call, or at a result with nothing but
 * service records after it (the rejection a stopped turn writes), still
 * waits for them, and the step is rebuilt. For a fork's copy this is read in
 * the parent's whole transcript, not in the copy, which ends at the point by
 * definition.
 */
export function stepDelivered(
  records: readonly TranscriptRecord[],
  point: TranscriptRecord,
  index: RecordIndex = indexRecords(records),
): boolean {
  const byUuid = index.byUuid;
  // A service record trails the record it was written after: read that one.
  let record: TranscriptRecord | undefined = point;
  const climbed = new Set<string>();
  while (record && isServiceRecord(record) && !climbed.has(record.uuid!)) {
    climbed.add(record.uuid!);
    const parent: string | null | undefined = record.parentUuid || record.logicalParentUuid;
    record = parent ? byUuid.get(parent) : undefined;
  }
  if (!record) return false;
  if (record.type === "assistant") return !holdsToolUse(record);
  if (record.type === "attachment") return !!record.attachment?.source_uuid;
  if (record.type !== "user" || record.toolUseResult === undefined) return false;
  // A continuation below the result, through the service records between.
  const children = index.children;
  const queue = [record];
  const seen = new Set<string>([record.uuid!]);
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!.uuid!) ?? []) {
      if (!child.uuid || seen.has(child.uuid)) continue;
      seen.add(child.uuid);
      if (isContinuation(child)) return true;
      if (isServiceRecord(child)) queue.push(child);
    }
  }
  return false;
}

/** A record that continues a turn after a tool result: the CLI's next output, a message it absorbed, or a later question. */
function isContinuation(record: TranscriptRecord): boolean {
  return record.type === "assistant" || (record.type === "attachment" && !!record.attachment?.source_uuid) || isPromptRecord(record);
}

/** A record the CLI writes on its own, with no id of the screen: a service attachment, the record of a stop. */
function isServiceRecord(record: TranscriptRecord): boolean {
  if (record.type === "attachment") return !record.attachment?.source_uuid;
  return isInterruptRecord(record);
}

/**
 * Plan a chat turn: the list is the request's messages, the last chain
 * entry is the message the turn is about (its record is written now). When
 * that record already exists (a retry), the point is the end of the turn
 * before it and the record takes the next attempt; with every attempt's
 * name taken, the turn is not planned at all (exhausted). A point off the
 * CLI's leaf chain moves onto it (offLeafChain, see the header). `chain`:
 * the list's expected chain when the caller has built it already.
 */
export function planResume(
  records: readonly TranscriptRecord[],
  messages: readonly ListMessage[],
  chain: readonly ChainEntry[] = expectedChain(messages),
): ResumePlan {
  const at = launchingAt(chain);
  if (at < 0) return { kind: "none" };
  const launching = chain[at]!;
  const index = indexRecords(records);
  const attempt = nextAttempt(records, launching, index.names);
  if (attempt > MAX_ATTEMPTS) return { kind: "exhausted" };
  const plan = pointIn(records, messages, chain, at, attempt, index);
  if (plan.kind !== "resume") return plan;
  // The CLI refuses a point off its leaf chain. The turn is planned again on
  // the records down to where the point's branch leaves it: the point lands
  // on the leaf chain, and the list's messages after go as missed. The
  // attempt stays the one counted on the whole file (the CLI drops a record
  // whose uuid it has). No such record (a chain that does not reach the
  // leaf's): the plan stays, and the CLI's refusal moves the chat on.
  const ancestor = leafChainAncestor(records, plan.point, index);
  if (!ancestor || ancestor.uuid === plan.point) return plan;
  const cut = chainTo(records, ancestor.uuid!, index);
  const moved = pointIn(cut, messages, chain, at, attempt, indexRecords(cut));
  if (moved.kind !== "resume") return plan;
  return { ...moved, offLeafChain: { point: plan.point, ancestor: ancestor.uuid! } };
}

/**
 * The point of a chat turn among `records` (planResume), for an attempt
 * counted already; `at` is the launching entry's place in the chain.
 */
function pointIn(
  records: readonly TranscriptRecord[],
  messages: readonly ListMessage[],
  chain: readonly ChainEntry[],
  at: number,
  attempt: number,
  index: RecordIndex,
): ResumePlan {
  // The point is among the entries before the launching one.
  const found = findLastChainRecord(records, chain, at);
  if (!found) {
    // None of them in the transcript: the turn resumes at the record the
    // transcript starts with (the chat's first message, its retry, a revert
    // to before it), and everything the list holds before the message is missed.
    const start = index.byUuid.get(TRANSCRIPT_START_NAME);
    if (!start) return { kind: "none" };
    return { kind: "resume", point: start.uuid!, coveredIndex: -1, attempt, stepDelivered: false, answered: false };
  }
  const end = endOfTurn(records, found.record, chainIndex(chain), index);
  if (found.entry.kind === "reply") {
    // A record of missed messages, named after the last answer in it: it
    // holds that answer's tool step too (a tool message has no id of its
    // own), results included.
    return {
      kind: "resume",
      point: end.uuid!,
      coveredIndex: replyCoverage(messages, found.entry.index),
      attempt,
      stepDelivered: true,
      answered: false,
    };
  }
  const turnEnd = withinList(records, messages, found, end, index);
  return {
    kind: "resume",
    point: turnEnd.uuid!,
    coveredIndex: found.entry.index,
    attempt,
    stepDelivered: stepDelivered(records, turnEnd, index),
    answered: turnAnswered(records, found.record, turnEnd, index),
  };
}

/**
 * Whether the list holds an answer to the message at `index`: an assistant
 * message after it, before the next message that starts a turn.
 */
function listAnswers(messages: readonly ListMessage[], index: number): boolean {
  for (let i = index + 1; i < messages.length; i++) {
    if (messages[i]!.role === "assistant") return true;
    if (startsTurn(messages[i]!)) return false;
  }
  return false;
}

/**
 * The end of the found record's turn, within what the list holds: when the
 * list has no answer to that message but the transcript has Claude's (the
 * user stopped the turn and OpenCode kept nothing of it, while the CLI
 * wrote it out), the turn ends before that answer, as the list does.
 */
function withinList(
  records: readonly TranscriptRecord[],
  messages: readonly ListMessage[],
  found: FoundRecord,
  end: TranscriptRecord,
  index: RecordIndex = indexRecords(records),
): TranscriptRecord {
  // A record of missed messages holds its answer as text: nothing to cut there.
  if (found.entry.kind === "reply") return end;
  const path = pathBetween(found.record, end, index);
  if (!listAnswers(messages, found.entry.index)) {
    const answer = path.findIndex((record) => record.type === "assistant" && !record.isApiErrorMessage);
    return answer > 0 ? path[answer - 1]! : end;
  }
  return answerCutShort(path, listAnswerText(messages, found.entry.index)) ?? end;
}

/** The records from `start` down to `end` along parents, `start` first (`end` alone when they do not connect). */
function pathBetween(start: TranscriptRecord, end: TranscriptRecord, index: RecordIndex): TranscriptRecord[] {
  const path: TranscriptRecord[] = [];
  const seen = new Set<string>();
  for (let current: TranscriptRecord | undefined = end; current && !seen.has(current.uuid!); ) {
    seen.add(current.uuid!);
    path.unshift(current);
    if (current === start) break;
    const parent: string | null | undefined = current.parentUuid || current.logicalParentUuid;
    current = parent ? index.byUuid.get(parent) : undefined;
  }
  return path;
}

/** The text of the last answer in words the list shows for the turn of the message at `index`, "" when none. */
export function listAnswerText(messages: readonly ListMessage[], index: number): string {
  let text = "";
  for (let i = index + 1; i < messages.length; i++) {
    const message = messages[i]!;
    if (startsTurn(message)) break;
    if (message.role === "assistant" && toolCallIdsOf(message).length === 0) text = textOfMessage(message);
  }
  return text;
}

/** The text blocks of a record's message, joined. */
function textOfRecord(record: TranscriptRecord): string {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (block as { type?: unknown } | null)?.type === "text" && typeof (block as { text?: unknown }).text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * The record before the turn's answer when the screen holds only the start
 * of it: the user stopped the turn while Claude answered, OpenCode kept what
 * it had read (an answer with an error, still in its lists), and the CLI,
 * which writes an answer whole, had finished it. Claude must not see what
 * the screen does not: the turn ends before the record, and the kept part
 * reaches Claude as missed. `path` is the turn's records, the answer the
 * last one in words; null when the screen's answer is the record's (or
 * another text altogether: another model's, which the caller treats by
 * turnAnswered), or there is no answer record.
 */
export function answerCutShort(path: readonly TranscriptRecord[], screenText: string): TranscriptRecord | null {
  if (!screenText) return null;
  let at = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    const record = path[i]!;
    if (record.type === "assistant" && !record.isApiErrorMessage && textOfRecord(record)) {
      at = i;
      break;
    }
  }
  if (at <= 0) return null;
  // Both sides without the whitespace at their ends: a part shown up to a
  // space ("Paris, the ") is the record's whole text, not the start of it.
  const recorded = textOfRecord(path[at]!).trim();
  const screen = screenText.trim();
  if (recorded.length <= screen.length || !recorded.startsWith(screen)) return null;
  return path[at - 1]!;
}

/**
 * The last list message a record of missed messages named after the answer
 * at `index` holds: that answer and the tool messages after it (its
 * results; a tool message has no id), up to the next message of another kind.
 */
function replyCoverage(messages: readonly ListMessage[], index: number): number {
  let covered = index;
  while (covered + 1 < messages.length && messages[covered + 1]!.role === "tool") covered++;
  return covered;
}

/**
 * Plan a summary: the list is the part OpenCode summarizes, all of it
 * already answered. Usable only when its last named message is in the
 * transcript; the point is the end of that turn.
 */
export function planSummaryResume(
  records: readonly TranscriptRecord[],
  messages: readonly ListMessage[],
  chain: readonly ChainEntry[] = expectedChain(messages),
): { point: string } | null {
  // A step's record exists only when the step was rebuilt, an answer's only
  // when it went as a missed record: the last message or checkpoint is what
  // the transcript must hold; a later step or answer, if found, is better still.
  const required = [...chain].reverse().find((entry) => entry.kind === "message" || entry.kind === "checkpoint");
  if (!required) return null;
  const found = findLastChainRecord(records, chain);
  if (!found || found.entry.index < required.index) return null;
  const index = indexRecords(records);
  const end = withinList(records, messages, found, endOfTurn(records, found.record, chainIndex(chain), index), index);
  // The transcript has no answer to that message (its turn failed), but the
  // part goes on after it (another model answered): the transcript lacks it.
  // A record of missed messages holds its answer's tool results too.
  const covered = found.entry.kind === "reply" ? replyCoverage(messages, found.entry.index) : found.entry.index;
  if (!turnAnswered(records, found.record, end, index) && covered < messages.length - 1) return null;
  return { point: end.uuid! };
}

/** The records a copy of the transcript cut at `point` holds: the chain from the first record down to it. */
export function chainTo(
  records: readonly TranscriptRecord[],
  point: string,
  index: RecordIndex = indexRecords(records),
): TranscriptRecord[] {
  const byUuid = index.byUuid;
  const chain: TranscriptRecord[] = [];
  const seen = new Set<string>();
  let current = byUuid.get(point);
  while (current && !seen.has(current.uuid!)) {
    seen.add(current.uuid!);
    chain.unshift(current);
    const parent = current.parentUuid || current.logicalParentUuid;
    current = parent ? byUuid.get(parent) : undefined;
  }
  return chain;
}

/**
 * The record types on the CLI's chain, as the SDK's transcript loader has
 * them: the last of them in the file is the leaf a resume continues from.
 * Other lines with a uuid (the SDK's `custom-title` after a copy) are not.
 */
const CHAIN_TYPES = new Set(["user", "assistant", "progress", "system", "attachment"]);

/**
 * The deepest record of the chain down to `uuid` that is on the
 * transcript's leaf chain (the last chain record and its ancestors), where
 * the CLI resumes: the record itself when it is on it, else the one where
 * its branch leaves the leaf chain. Undefined when the chains do not meet.
 */
export function leafChainAncestor(
  records: readonly TranscriptRecord[],
  uuid: string,
  index: RecordIndex = indexRecords(records),
): TranscriptRecord | undefined {
  let leaf: TranscriptRecord | undefined;
  for (let i = records.length - 1; i >= 0 && !leaf; i--) {
    if (CHAIN_TYPES.has(records[i]!.type)) leaf = records[i];
  }
  if (!leaf) return undefined;
  const leafChain = new Set(chainTo(records, leaf.uuid!, index));
  const chain = chainTo(records, uuid, index);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (leafChain.has(chain[i]!)) return chain[i];
  }
  return undefined;
}

/**
 * Whether resuming at `point` leaves real messages behind: a prompt record
 * (or a message absorbed mid-turn) after the point that the list does not
 * name, i.e. a message the user reverted or edited. Records the list names
 * after the point are earlier attempts of a message sent again (a retry),
 * not a revert.
 */
export function cutsMessages(
  records: readonly TranscriptRecord[],
  point: string,
  messages: readonly ListMessage[],
  chain: readonly ChainEntry[] = expectedChain(messages),
  index: RecordIndex = indexRecords(records),
): boolean {
  const names = chainIndex(chain);
  const children = index.children;
  const queue = [point];
  const seen = new Set<string>([point]);
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (!child.uuid || seen.has(child.uuid)) continue;
      seen.add(child.uuid);
      const name = ownName(child);
      const message = isPromptRecord(child) || (child.type === "attachment" && !!child.attachment?.source_uuid);
      if (message && name && !names.has(name)) return true;
      queue.push(child.uuid);
    }
  }
  return false;
}

/**
 * Whether a record is on the transcript's leaf chain (leafChainAncestor):
 * the CLI resumes and copies only there (probes P4, 39).
 */
export function onLeafChain(
  records: readonly TranscriptRecord[],
  uuid: string,
  index: RecordIndex = indexRecords(records),
): boolean {
  return leafChainAncestor(records, uuid, index)?.uuid === uuid;
}

/**
 * A fork's copy cut on the leaf chain, where the CLI copies: planCopy's cut,
 * or, when it is off the leaf chain, the cut planned again on the records
 * down to where its branch leaves it (as planResume moves a turn's point);
 * `offLeafChain` then says where the cut stood. Null when there is no cut
 * or the chains do not meet.
 */
export function planCopyOnLeafChain(
  records: readonly TranscriptRecord[],
  messages: readonly ListMessage[],
  chain: readonly ChainEntry[] = expectedChain(messages),
  index: RecordIndex = indexRecords(records),
): { point: string; coveredIndex: number; offLeafChain?: { point: string; ancestor: string } } | null {
  const cut = planCopy(records, messages, chain, index);
  if (!cut) return null;
  const ancestor = leafChainAncestor(records, cut.point, index);
  if (!ancestor) return null;
  if (ancestor.uuid === cut.point) return cut;
  const kept = chainTo(records, ancestor.uuid!, index);
  const moved = planCopy(kept, messages, chain, indexRecords(kept));
  return moved ? { ...moved, offLeafChain: { point: cut.point, ancestor: ancestor.uuid! } } : null;
}

/**
 * Where a fork's copy of its parent's transcript is cut (section 5 of the
 * project): every message of the fork's screen but an answer in words has an
 * id that finds its record in the transcript, and the copy ends at the record
 * of the last screen message that has one. Down the screen from its end:
 * - a user message (a question, a message sent during a turn, a checkpoint):
 *   the record with its name, or the `attachment` the CLI absorbed it into;
 * - a tool step: the record of a rebuilt step by name; else the result
 *   record of its last call by the call's id; else the call record alone
 *   (its results never reached the CLI: they go as a rebuilt step);
 * - an answer in words: no id of its own; a missed record named after it
 *   (another model's answer the transcript holds as text) counts, otherwise
 *   the answer is reached from the record before it (answerRecords);
 * - nothing found: the next message up.
 * When the screen shows an answer right after the found message, the point
 * moves down its records to the answer (answerRecords); otherwise only the
 * CLI's own service records after it are taken, never an answer the screen
 * lacks (a fork made while the parent was answering). Among several records
 * of one message (retries) the last in file order wins, as everywhere in
 * this file: a lost process may append its answer under an earlier attempt
 * after the retry's records, which must not make that attempt the one.
 * A cut off the leaf chain moves onto it in planCopyOnLeafChain.
 * Null when the transcript holds no record of the screen. `chain`: the
 * screen's expected chain when the caller has built it already (a fork
 * reads several versions of its parent's transcript with one chain).
 */
export function planCopy(
  records: readonly TranscriptRecord[],
  messages: readonly ListMessage[],
  chain: readonly ChainEntry[] = expectedChain(messages),
  index: RecordIndex = indexRecords(records),
): { point: string; coveredIndex: number } | null {
  const names = chainIndex(chain);
  // The last record in file order under each name, tool result id and tool use id.
  const byName = new Map<string, TranscriptRecord>();
  const byToolResult = new Map<string, TranscriptRecord>();
  const byToolUse = new Map<string, TranscriptRecord>();
  const last = (map: Map<string, TranscriptRecord>, key: string | undefined, record: TranscriptRecord) => {
    if (!key) return;
    const kept = map.get(key);
    if (!kept || record.line > kept.line) map.set(key, record);
  };
  for (const record of records) {
    last(byName, ownName(record), record);
    for (const id of toolResultIdsOfRecord(record)) last(byToolResult, id, record);
    for (const id of toolUseIdsOfRecord(record)) last(byToolUse, id, record);
  }
  /** The record for these keys: the last in file order. */
  const pick = (map: Map<string, TranscriptRecord>, keys: readonly string[]): TranscriptRecord | undefined => {
    let found: TranscriptRecord | undefined;
    for (const key of keys) {
      const record = map.get(key);
      if (record && (!found || record.line > found.line)) found = record;
    }
    return found;
  };
  /** The chain's entries by list index, built once: the walk down the screen asks for each message. */
  const entriesByIndex = new Map<number, ChainEntry[]>();
  for (const entry of chain) {
    const list = entriesByIndex.get(entry.index);
    if (list) list.push(entry);
    else entriesByIndex.set(entry.index, [entry]);
  }
  const entriesAt = (i: number) => entriesByIndex.get(i) ?? [];
  /**
   * Whether the screen's turn that message `i` is in ends with an answer in
   * words: past tool steps and their results (a step not found by id:
   * another model's) and past user messages that start no turn (a reminder
   * OpenCode spliced in, as listAnswers and missedFrom skip them).
   */
  const answerAfter = (i: number): number => {
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j]!;
      if (next.role === "tool") continue;
      if (next.role === "user") {
        if (startsTurn(next)) return -1;
        continue;
      }
      if (next.role === "assistant" && toolCallIdsOf(next).length === 0) return j;
    }
    return -1;
  };
  /**
   * The copy's point for a found record, or undefined when the copy would
   * end with a call whose result is not in it (Claude writes every call of
   * one answer before the first result, and OpenCode shows them step by
   * step: a fork between two such steps holds the first call's result and
   * not the second's). The CLI cannot resume at a call left unanswered that
   * way; the walk goes on to the message before.
   */
  /** The calls a rebuilt step's record answers (as text), by the record's name. */
  const stepCalls = new Map<string, string[]>();
  for (const entry of chain) {
    if (entry.kind !== "step") continue;
    for (const name of entry.names) stepCalls.set(name, entry.source.split(","));
  }
  /**
   * The cut for a found record: with the screen's answer after it
   * (`answer`, a list index) the copy runs down to that answer and covers
   * it; else it covers the found message (or its tool results) only.
   * `coveredIndex` is the last list message the copy holds: everything
   * after it is missed (proxy.ts planChatTurn), a step of the same turn too.
   */
  const cut = (found: TranscriptRecord, answer: number, coveredIndex: number) => {
    let point = answerRecords(records, found, names, answer >= 0, index);
    // The screen holds the start of the answer only (a stopped turn, answerCutShort): the copy ends before the
    // answer record, the screen's part goes as missed with the rest.
    const short = answer >= 0 ? answerCutShort(pathBetween(found, point, index), textOfMessage(messages[answer]!)) : null;
    if (short) {
      point = short;
      answer = -1;
    }
    if (dangling(chainTo(records, point.uuid!, index), point, stepCalls)) return undefined;
    // The screen's answer is covered only when the copy holds Claude's answer
    // (turnAnswered): another model's answer to a turn that failed is not in
    // the transcript and goes as text.
    const covered = answer >= 0 && turnAnswered(records, found, point, index) ? answer : coveredIndex;
    return { point: point.uuid!, coveredIndex: covered };
  };
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "tool") continue;
    if (message.role === "assistant") {
      const calls = toolCallIdsOf(message);
      const reply = entriesAt(i).find((entry) => entry.kind === "reply");
      if (calls.length > 0) {
        // A step: its rebuilt record by name; else its last result by the
        // call's id (the id the CLI gave and the proxy handed to OpenCode,
        // probe 43); else the call record alone, or the missed record named
        // after it (another model's turn that ended on a step).
        const step = entriesAt(i).find((entry) => entry.kind === "step");
        const found = (step && pick(byName, step.names)) ?? pick(byToolResult, calls) ?? pick(byToolUse, calls);
        if (found) {
          // The step's results are covered when the copy holds them: a
          // result record, or a rebuilt step's record. A copy that ends at
          // the call alone leaves the results on the screen to go as missed.
          let covered = i;
          const holdsResults = (step !== undefined && step.names.includes(found.uuid!)) || toolResultIdsOfRecord(found).length > 0;
          if (holdsResults) while (messages[covered + 1]?.role === "tool") covered++;
          const result = cut(found, answerAfter(i), covered);
          if (result) return result;
          continue;
        }
      }
      const missed = reply && pick(byName, reply.names);
      if (missed) {
        const result = cut(missed, -1, replyCoverage(messages, i));
        if (result) return result;
      }
      continue;
    }
    if (message.role === "user") {
      const entry = entriesAt(i).find((e) => e.kind === "message" || e.kind === "checkpoint");
      const found = entry && pick(byName, entry.names);
      if (found) {
        const result = cut(found, answerAfter(i), i);
        if (result) return result;
      }
    }
  }
  return null;
}

/**
 * The records of the screen's answer after `found`, when the screen shows
 * one: the deepest descendant up to the next prompt record (endOfTurn).
 * Without an answer on the screen, only the CLI's service records right
 * after `found` are taken: not an answer or a step the screen lacks.
 */
function answerRecords(
  records: readonly TranscriptRecord[],
  found: TranscriptRecord,
  chainNames: ChainNames,
  withAnswer: boolean,
  index: RecordIndex = indexRecords(records),
): TranscriptRecord {
  if (withAnswer) return endOfTurn(records, found, chainNames, index);
  return deepestDescendant(found, (record) => isServiceRecord(record), index);
}

/**
 * Whether the chain holds a tool call without its result, other than at
 * `point` itself (a point on a call means its results go as a rebuilt step).
 * A rebuilt step's record (`stepCalls`, by its name) answers its calls as text.
 */
function dangling(chain: readonly TranscriptRecord[], point: TranscriptRecord, stepCalls: ReadonlyMap<string, string[]>): boolean {
  const answered = new Set(chain.flatMap((record) => [...toolResultIdsOfRecord(record), ...(stepCalls.get(record.uuid!) ?? [])]));
  return chain.some((record) => record !== point && toolUseIdsOfRecord(record).some((id) => !answered.has(id)));
}

/**
 * Where the messages of a history the transcript never saw start: after the
 * turn of the message at `coveredIndex` (its answers and tool steps are in
 * the transcript), at the next message that starts a turn; when the
 * transcript has no answer to that message, right after it. `history.length`
 * when nothing follows.
 */
export function missedFrom(history: readonly ListMessage[], coveredIndex: number, answered: boolean): number {
  if (!answered) return Math.min(coveredIndex + 1, history.length);
  for (let i = coveredIndex + 1; i < history.length; i++) {
    if (startsTurn(history[i]!)) return i;
  }
  return history.length;
}

/**
 * The name of each list message's record for this transcript, by list
 * index: the first attempt the transcript does not hold (the CLI drops a
 * record whose uuid it has). An answer is named by its own id, not as a
 * step. No name when every attempt is taken. `chain`: the list's expected
 * chain when the caller has built it already.
 */
export function recordNames(
  records: readonly TranscriptRecord[],
  messages: readonly ListMessage[],
  chain: readonly ChainEntry[] = expectedChain(messages),
): Map<number, string> {
  const names = new Map<number, string>();
  const present = namesIn(records);
  for (const entry of chain) {
    if (entry.kind === "step") continue;
    const attempt = nextAttempt(records, entry, present);
    if (attempt <= MAX_ATTEMPTS) names.set(entry.index, entry.names[attempt - 1]!);
  }
  return names;
}
