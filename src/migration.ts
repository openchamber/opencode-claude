/**
 * The first turn of a chat an older release of the plugin served (1.7.0 and
 * earlier): those kept the chat's Claude transcript under a random id and
 * recorded it in `sessions.json`, with the chat's turns as text fingerprints.
 * The transcript is still on disk and holds the whole chat, tool results and
 * attachments included. Its first turn under names copies it into the
 * chat's first name (`resume` + `forkSession` + `sessionId`, the copy a fork
 * makes, proxy.ts planChatTurn) instead of sending the history as text.
 *
 * The record is read once, for that first turn, and only trusted when it
 * still describes the chat: its last turn boundary (how many user messages,
 * the fingerprint of the last one) must match the request, and its leaf
 * must be on the transcript's leaf chain. Anything else, and the turn goes as
 * text, as it would without this file. Neither the record nor the old
 * transcript is changed: the older release still finds both after a downgrade.
 * Later turns find the copy by name; the records copied from the old
 * transcript carry no names, so a revert into that part goes as text.
 *
 * The fingerprints are the older release's (prompt.ts userHistoryFingerprints
 * of 1.6.0, the same in 1.7.0), on the request body, the form it computed them
 * on. 1.7.0 keeps the record through a summary (1.6.0 dropped it), but a
 * compacted chat is not copied either way: its record names the transcript
 * the compacted history moved to, and only a chat's first epoch is copied.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ListMessage } from "./names.js";
import { textOfMessage } from "./names.js";
import { contentHasAttachments, extractTextContent, isSyntheticToolMediaMessage } from "./prompt.js";
import { findClaudeSessionFile } from "./transcripts.js";
import { indexRecords, onLeafChain, readTranscript, stepDelivered, type TranscriptRecord } from "./turn-point.js";

/** A chat's entry in the older release's `sessions.json` (session-store.ts of 1.6.0, unchanged in 1.7.0). */
type LegacyBinding = {
  foreignSessionId?: string;
  leafUuid?: string;
  turns?: Array<{ count: number; hash: string; leafUuid?: string; sessionId?: string }>;
};

function legacyStorePath(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "sessions.json");
}

/** The older release's entry for this chat (keyed by the OpenCode session id), if any. */
function legacyBinding(sessionID: string): LegacyBinding | undefined {
  try {
    const store = JSON.parse(readFileSync(legacyStorePath(), "utf8")) as Record<string, LegacyBinding>;
    const entry = store?.[sessionID];
    return entry && typeof entry === "object" ? entry : undefined;
  } catch {
    return undefined;
  }
}

const SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * The older release's fingerprint of each user message of a request body:
 * user messages only, OpenCode's promoted tool media skipped, reminder
 * blocks dropped, whitespace collapsed, attachments by presence.
 */
export function legacyFingerprints(body: ReadonlyArray<{ role?: string; content?: unknown }>): string[] {
  const prints: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const message = body[i];
    if (message?.role !== "user" || isSyntheticToolMediaMessage(message, body[i - 1])) continue;
    const text = extractTextContent(message.content).replace(SYSTEM_REMINDER_BLOCK, " ").replace(/\s+/g, " ").trim();
    const identity = text || (contentHasAttachments(message.content) ? "\u0000attachments" : "");
    if (!identity) continue;
    prints.push(createHash("sha1").update(identity).digest("hex").slice(0, 16));
  }
  return prints;
}

/**
 * The list index of the `n`-th user message, counted as the fingerprints
 * count them (one with text besides reminders, or with attachments); -1
 * when the list has fewer.
 */
function listIndexOfUser(list: readonly ListMessage[], n: number): number {
  let seen = 0;
  for (let i = 0; i < list.length; i++) {
    const message = list[i]!;
    if (message.role !== "user") continue;
    const text = textOfMessage(message).replace(SYSTEM_REMINDER_BLOCK, " ").trim();
    const media = Array.isArray(message.content) && message.content.some((part) => (part as { type?: unknown } | null)?.type === "media");
    if (!text && !media) continue;
    seen += 1;
    if (seen === n) return i;
  }
  return -1;
}

/** The old transcript a migrated chat's first turn copies, and where. */
export type LegacySource = {
  /** The old transcript's session id (its file name). */
  name: string;
  records: TranscriptRecord[];
  /** The record the copy ends at: the end of the last turn the record file knows. */
  point: string;
  /** The last list message the copy holds: the user message of that turn. */
  coveredIndex: number;
  stepDelivered: boolean;
  answered: boolean;
};

/**
 * The old transcript of a chat an older release served, when its record
 * still describes the chat. Nothing for a chat the older release never
 * served; `failed` (with why) for one it served whose record no longer
 * fits: that turn goes as text and says so.
 */
export async function legacyCopySource(
  sessionID: string,
  body: ReadonlyArray<{ role?: string; content?: unknown }>,
  list: readonly ListMessage[],
  configDir?: string,
): Promise<{ source?: LegacySource; failed?: string }> {
  const binding = legacyBinding(sessionID);
  if (!binding?.foreignSessionId) return {};
  const latest = binding.turns?.at(-1);
  if (!latest || !binding.leafUuid || latest.leafUuid !== binding.leafUuid) {
    return { failed: "the old record has no turn that ends at its leaf" };
  }
  if (latest.sessionId && latest.sessionId !== binding.foreignSessionId) {
    return { failed: "the old record's last turn is in another transcript" };
  }
  const prints = legacyFingerprints(body);
  // The request goes on past the last recorded turn: a retry of that very
  // turn (the old release recorded it, then failed) is no continuation.
  if (prints.length <= latest.count || prints[latest.count - 1] !== latest.hash) {
    return { failed: "the chat's messages no longer match the old record" };
  }
  const coveredIndex = listIndexOfUser(list, latest.count);
  if (coveredIndex < 0) return { failed: "the chat's list holds fewer messages than the old record" };
  const file = findClaudeSessionFile(binding.foreignSessionId, configDir);
  if (!file) return { failed: "the old transcript is gone" };
  const records = await readTranscript(file);
  const index = indexRecords(records);
  const leaf = index.byUuid.get(binding.leafUuid);
  // The CLI copies only from the transcript's leaf chain (probe 39).
  if (!leaf || !onLeafChain(records, binding.leafUuid, index)) {
    return { failed: "the old transcript no longer ends where the record says" };
  }
  return {
    source: {
      name: binding.foreignSessionId,
      records,
      point: binding.leafUuid,
      coveredIndex,
      stepDelivered: stepDelivered(records, leaf, index),
      answered: leaf.type === "assistant" && !leaf.isApiErrorMessage,
    },
  };
}
