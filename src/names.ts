/**
 * Names of Claude Code transcripts and records, computed from OpenCode ids.
 *
 * Nothing is remembered, everything is named: the transcript file of a chat
 * and every user record in it get uuids derived from what OpenCode already
 * knows about the chat (its id, its message ids, its compaction checkpoint),
 * so "which file holds this chat" and "which record is this message" are
 * lookups by name, not entries in a record file. The uuids are version 5
 * (SHA-1 of a name in a fixed namespace), the form Claude Code accepts for
 * `sessionId` and `SDKUserMessage.uuid`.
 *
 * Every name has a kind prefix, so a message id, a checkpoint text and a
 * chat id can never collide with each other.
 */
import { createHash } from "node:crypto";

/** Fixed namespace of this plugin's names (an arbitrary constant uuid). */
const NAMESPACE = "3d1f3a2e-5b7c-4c91-8f2a-0b6e9c4d7a21";

/**
 * How many attempts a record of one message may have. The CLI drops a
 * record whose uuid is already in the transcript, so a retry of the same
 * message (OpenCode repeats the request after a proxy error) needs a new
 * name: the attempt number. Looking for a message in a transcript checks
 * attempts 1..MAX_ATTEMPTS. OpenCode sends a failed request up to eleven
 * times (runner/retry.ts: ten retries over about a minute and a half), so
 * sixteen covers a whole round of its retries; when every name is taken
 * the plugin refuses the message, and OpenCode stops retrying it.
 */
export const MAX_ATTEMPTS = 16;

/**
 * The key of a message's own id in its OpenCode metadata (set by the `prompt`
 * hook, index.ts): the plugin's id, so the key never meets another plugin's.
 */
export const ORIGINAL_ID_KEY = "openchamber.claude-code";

/** Epoch of a chat before its first OpenCode compaction. */
export const FIRST_EPOCH = "E0";

/** How OpenCode starts the text of a compaction checkpoint (to-llm-message.ts). */
export const CHECKPOINT_PREFIX = "<conversation-checkpoint>";

/** How OpenCode ends the text of a compaction checkpoint. */
const CHECKPOINT_END = "</conversation-checkpoint>";

/** Text of a compaction checkpoint as OpenCode sends it to the model. */
export function checkpointText(summary: string, recent: string | undefined): string {
  // Same template as OpenCode's to-llm-message.ts for a completed compaction
  // message; checked byte for byte against a real request of OpenCode 2.0.32.
  return [
    CHECKPOINT_PREFIX,
    "The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.",
    "",
    `<summary>\n${summary}\n</summary>`,
    ...(recent ? ["", `<recent-context>\n${recent}\n</recent-context>`] : []),
    CHECKPOINT_END,
  ].join("\n");
}

/** uuid v5: SHA-1 of the namespace bytes and the name, version and variant bits set. */
export function uuidV5(name: string, namespace: string = NAMESPACE): string {
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (namespaceBytes.length !== 16) throw new Error(`not a uuid namespace: ${namespace}`);
  const hash = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Names computed once per process: a turn's plan names every message of
 * the list for every attempt (MAX_ATTEMPTS names per message, the whole
 * screen on every turn), and the ids do not change between turns, so the
 * SHA-1 of each is taken once. Room for a few thousand messages; the oldest
 * names go first when it is full.
 */
const NAME_CACHE_MAX = 50_000;
const nameCache = new Map<string, string>();

function cachedUuidV5(name: string): string {
  const cached = nameCache.get(name);
  if (cached) return cached;
  const uuid = uuidV5(name);
  if (nameCache.size >= NAME_CACHE_MAX) nameCache.delete(nameCache.keys().next().value!);
  nameCache.set(name, uuid);
  return uuid;
}

/** Record of a user message: the OpenCode message id and the attempt (1, 2, ...). */
export function userRecordName(messageID: string, attempt: number): string {
  return cachedUuidV5(`message:${messageID}/${attempt}`);
}

/**
 * Record of a rebuilt tool step (the parked turn was lost and the tool
 * results went to Claude as text): named by the tool call ids of the step,
 * which OpenCode keeps when it copies the step into a fork, unlike the id
 * of the assistant message itself.
 */
export function stepRecordName(toolCallIDs: readonly string[], attempt: number): string {
  const key = JSON.stringify(["step", [...toolCallIDs].sort()]);
  return cachedUuidV5(`step:${key}/${attempt}`);
}

/** Record of a compaction checkpoint: the whole checkpoint text (summary and recent). */
export function checkpointRecordName(text: string, attempt: number): string {
  return uuidV5(`checkpoint:${text}/${attempt}`);
}

/**
 * Epoch of a chat whose context starts with this checkpoint. Two checkpoints
 * with the same summary but different recent parts are different epochs; a
 * fork's copy of the checkpoint (new id, same text) is the same epoch.
 */
export function epochOfCheckpoint(text: string): string {
  return uuidV5(`epoch:${text}`);
}

/** Transcript file of a chat: its id, its epoch and the file version within the epoch (1, 2, ...). */
export function transcriptName(sessionID: string, epoch: string, version: number): string {
  return uuidV5(`transcript:${sessionID}/${epoch}/${version}`);
}

/**
 * The record every new transcript starts with: blank and without a turn
 * (prompt.ts withTranscriptStart), so the chat's first message has a record
 * before it to resume at, as every later message has. One name for all
 * transcripts: a uuid must be unique only within a file, and a copy of a
 * transcript keeps the record's uuid.
 */
export const TRANSCRIPT_START_NAME = uuidV5("start:transcript");

/** A message of the hook's list: id, role and content parts, as OpenCode's LLM.Message. */
export type ListMessage = {
  id?: string;
  role?: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
};

/** The text of a list message: a string content, or its text parts joined. */
export function textOfMessage(message: ListMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: string; text: string } => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * Whether a list message is the compaction checkpoint OpenCode starts a
 * compacted chat with: the template's frame (checkpointText), the opening tag
 * on its own line and the closing tag at the end. A user message that only
 * starts with the opening tag is a message, not a new epoch.
 */
export function isCheckpointMessage(message: ListMessage): boolean {
  if (message.role !== "user") return false;
  const text = textOfMessage(message);
  return text.startsWith(`${CHECKPOINT_PREFIX}\n`) && text.trimEnd().endsWith(CHECKPOINT_END);
}

/**
 * Epoch of a request's message list: that of the checkpoint it starts with,
 * or the first epoch when the chat was never compacted. OpenCode puts the
 * checkpoint first in the context after a compaction.
 */
export function epochOfList(messages: readonly ListMessage[]): string {
  const first = messages.find((message) => message.role === "user" || message.role === "assistant");
  if (!first || !isCheckpointMessage(first)) return FIRST_EPOCH;
  return epochOfCheckpoint(textOfMessage(first));
}
