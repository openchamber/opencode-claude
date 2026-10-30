/**
 * Which Claude Code transcript a chat continues in.
 *
 * A chat's transcript is named from the chat id, its epoch (names.ts) and a
 * version: 1 as a rule, the next number whenever the current transcript can
 * no longer be continued (the resume point is not on the CLI's leaf chain
 * any more, the transcript has no record to resume at, the CLI cannot load
 * the file). The current transcript is the highest version that exists
 * on disk; a version marked unusable in this process is skipped. No record of
 * this is kept anywhere: it is recomputed from the file names, with a cache
 * per process that is checked against the disk on every lookup.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "./config-dir.js";
import { transcriptName } from "./names.js";

/**
 * Locate the Claude Code transcript for a session id. A missing file means
 * resume silently starts (or errors into) a context-free session, so callers
 * must fall back to history injection instead.
 *
 * Every project folder is searched on purpose. The CLI writes a session
 * under ~/.claude/projects/<slug of the realpath cwd>/, but `--resume <id>`
 * finds it from any cwd: checked live on CLI 2.1.224 and 2.1.284, a resume
 * from another directory loaded the full history and appended to the
 * original file. A chat whose directory changed keeps resuming.
 */
export function findClaudeSessionFile(foreignSessionId: string, configDir?: string): string | null {
  const id = foreignSessionId.trim();
  if (!id) return null;
  return fileIn(projectFolders(configDir), id);
}

/** The project folders of a Claude account, listed once for a lookup that tries several names. */
type ProjectFolders = { projectsDir: string; dirs: string[] };

function projectFolders(configDir?: string): ProjectFolders | null {
  const projectsDir = join(claudeConfigDir(configDir), "projects");
  try {
    return { projectsDir, dirs: readdirSync(projectsDir) };
  } catch {
    return null;
  }
}

/** The transcript file of this session id in any of the folders, or null. */
function fileIn(folders: ProjectFolders | null, id: string): string | null {
  if (!folders) return null;
  for (const dir of folders.dirs) {
    const candidate = join(folders.projectsDir, dir, `${id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** A chat's transcript: its name (the CLI session id) and its file, when the CLI wrote it. */
export type TranscriptRef = {
  sessionID: string;
  epoch: string;
  version: number;
  name: string;
  file: string | null;
};

type TranscriptsRuntime = {
  /** Highest version known per chat and epoch. */
  versions: Map<string, number>;
  /** Highest version that can no longer be continued, per chat and epoch. */
  unusable: Map<string, number>;
  /** The transcript the last turn of a chat (by conversation key) used. */
  byChat: Map<string, TranscriptRef>;
};

const RUNTIME_KEY = Symbol.for("@openchamber/opencode-claude/transcripts/v1");

const runtime: TranscriptsRuntime = ((globalThis as Record<symbol, unknown>)[RUNTIME_KEY] ??= {
  versions: new Map(),
  unusable: new Map(),
  byChat: new Map(),
}) as TranscriptsRuntime;

/**
 * Chats (by key) each map keeps: the oldest entries go when it is full. The
 * maps outlive the plugin's reloads (globalThis), so without a bound a
 * long-running server would hold a key for every chat and epoch it ever
 * served. A version lost from `versions` is read from disk again; an
 * `unusable` mark lost is set again when the CLI refuses the file again.
 */
const MAX_CHATS = 500;

const key = (sessionID: string, epoch: string) => `${sessionID}/${epoch}`;

/** Set `value` under `k`, keeping the map within MAX_CHATS (the oldest key goes). */
function remember<T>(map: Map<string, T>, k: string, value: T): void {
  map.delete(k);
  if (map.size >= MAX_CHATS) map.delete(map.keys().next().value!);
  map.set(k, value);
}

/**
 * The transcript a chat continues in this epoch: the highest version on
 * disk above the versions marked unusable. `file` is null when no transcript
 * of that version exists yet: the turn creates it (`sessionId`). `configDir`
 * is the Claude account of the chat's project (`configDirs`).
 */
export function currentTranscript(sessionID: string, epoch: string, configDir?: string): TranscriptRef {
  const k = key(sessionID, epoch);
  let version = Math.max(runtime.versions.get(k) ?? 1, (runtime.unusable.get(k) ?? 0) + 1);
  // The project folders are listed once: every version's name is looked for in them.
  const folders = projectFolders(configDir);
  let file = fileIn(folders, transcriptName(sessionID, epoch, version));
  // Another process, or a fallback of an earlier turn, may have gone further.
  for (;;) {
    const next = fileIn(folders, transcriptName(sessionID, epoch, version + 1));
    if (!next) break;
    version += 1;
    file = next;
  }
  remember(runtime.versions, k, version);
  return { sessionID, epoch, version, name: transcriptName(sessionID, epoch, version), file };
}

/** The transcript after the current one: a name no file has yet, for a turn that starts over. */
export function nextTranscript(current: TranscriptRef): TranscriptRef {
  const version = current.version + 1;
  remember(runtime.versions, key(current.sessionID, current.epoch), version);
  return {
    sessionID: current.sessionID,
    epoch: current.epoch,
    version,
    name: transcriptName(current.sessionID, current.epoch, version),
    file: null,
  };
}

/** Which transcript a chat's turn used, so a failure of that turn can mark it. */
export function rememberChatTranscript(conversationKey: string, transcript: TranscriptRef): void {
  remember(runtime.byChat, conversationKey, transcript);
}

/**
 * The CLI could not continue the chat's transcript (the resume point is off
 * its leaf chain, the file cannot be loaded): the next turn of this epoch
 * starts the next version, with the history as text.
 */
export function markTranscriptUnusable(conversationKey: string): TranscriptRef | undefined {
  const transcript = runtime.byChat.get(conversationKey);
  if (!transcript) return undefined;
  const k = key(transcript.sessionID, transcript.epoch);
  remember(runtime.unusable, k, Math.max(runtime.unusable.get(k) ?? 0, transcript.version));
  return transcript;
}

/** Tests only. */
export function resetTranscripts(): void {
  runtime.versions.clear();
  runtime.unusable.clear();
  runtime.byChat.clear();
}
