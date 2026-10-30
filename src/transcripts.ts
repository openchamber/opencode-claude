/**
 * Which Claude Code transcript a chat continues in.
 *
 * A chat's transcript is named from the chat id, its epoch (names.ts) and a
 * version, 1 first. A new version is written when the chat is reverted (the
 * turn copies the transcript up to the revert into it, so the old version
 * keeps what a fork made before the revert can still copy; a revert to the
 * chat's start copies the record every transcript starts with), and when the
 * transcript cannot be continued at all (the CLI refused it: another process
 * wrote a branch into it; it holds no record to resume at).
 *
 * Two names matter for a turn: the usable transcript, the highest version
 * that holds records and was not marked unusable in this process; and the
 * free name, the version after every one on disk. A file without records
 * (a copy whose process was killed) is not usable, and its name is taken:
 * the CLI writes into no existing file. No record of this is kept anywhere:
 * it is read from the files, with a cache per process of how far the
 * versions go.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "./config-dir.js";
import { transcriptName } from "./names.js";
import { readTranscript, type TranscriptRecord } from "./turn-point.js";

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
  /** Highest version seen on disk per chat and epoch: a lookup goes past a deleted one. */
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

/** A transcript on disk and its records. */
export type TranscriptFile = TranscriptRef & { file: string; records: TranscriptRecord[] };

/** The reference of a transcript file: the same without its records, for what is kept beyond the turn. */
export function refOf(transcript: TranscriptFile): TranscriptRef {
  return { sessionID: transcript.sessionID, epoch: transcript.epoch, version: transcript.version, name: transcript.name, file: transcript.file };
}

/** A chat's transcripts in an epoch: the one a turn continues, and the name a new one gets. */
export type ChatTranscripts = {
  /** The highest version with records, not marked unusable; null when there is none. */
  usable: TranscriptFile | null;
  /**
   * Versions with records, highest first, down to the usable one (none at
   * or below a version the CLI refused, which are not read); with
   * `all`, every one, or down to where `enough` stopped (a fork looks for its
   * history in each, until one holds all of it).
   */
  withRecords: TranscriptFile[];
  /** The version after every one on disk or marked unusable: a new transcript is written under it. */
  free: TranscriptRef;
  /**
   * A transcript of this chat and epoch was marked unusable in this process
   * (the CLI refused to continue or to copy it): a turn with nothing usable
   * then starts over as text rather than copying again.
   */
  refused: boolean;
};

/**
 * Missing version numbers a lookup steps over before it stops: a name the
 * CLI refused before it wrote the file leaves a gap, and the versions after
 * it must still be found, in this process or after a restart.
 */
const MAX_VERSION_GAP = 3;

/**
 * The transcripts of a chat in an epoch, read from disk (see the head of this
 * file). `configDir` is the Claude account of the chat's project
 * (`configDirs`), whose folder holds them.
 */
export async function chatTranscripts(
  sessionID: string,
  epoch: string,
  options: {
    all?: boolean;
    configDir?: string;
    /**
     * With `all`: called with each version as it is read, highest first; true
     * when those read suffice, and the older ones are not read (`usable` is
     * then null if none of them could be continued).
     */
    enough?: (transcript: TranscriptFile) => boolean;
  } = {},
): Promise<ChatTranscripts> {
  const k = key(sessionID, epoch);
  const ref = (version: number): TranscriptRef => ({
    sessionID,
    epoch,
    version,
    name: transcriptName(sessionID, epoch, version),
    file: null,
  });
  const unusableUpTo = runtime.unusable.get(k) ?? 0;
  const known = Math.max(runtime.versions.get(k) ?? 0, unusableUpTo);
  const files: Array<TranscriptRef & { file: string }> = [];
  // The project folders are listed once: every version's name is looked for in them.
  const folders = projectFolders(options.configDir);
  for (let version = 1, gap = 0; ; version++) {
    const file = fileIn(folders, transcriptName(sessionID, epoch, version));
    if (file) {
      files.push({ ...ref(version), file });
      gap = 0;
      continue;
    }
    gap += 1;
    if (version > known && gap > MAX_VERSION_GAP) break;
  }
  const lastFile = files.at(-1)?.version ?? 0;
  remember(runtime.versions, k, Math.max(runtime.versions.get(k) ?? 0, lastFile));
  // A name whose turn wrote nothing (the process never started) is free again;
  // one the CLI refused is not.
  const highest = Math.max(lastFile, unusableUpTo);
  // A turn reads from the highest version down to the usable one; a fork reads all.
  const withRecords: TranscriptFile[] = [];
  let usable: TranscriptFile | null = null;
  for (const file of [...files].reverse()) {
    // A turn has no use for a version the CLI refused or one older: none can
    // be continued, and the turn starts over (refused). Only a fork reads them.
    if (!options.all && file.version <= unusableUpTo) break;
    const records = await readTranscript(file.file);
    if (records.length === 0) continue;
    const transcript = { ...file, records };
    withRecords.push(transcript);
    if (!usable && file.version > unusableUpTo) {
      usable = transcript;
      if (!options.all) break;
    }
    if (options.all && options.enough?.(transcript)) break;
  }
  return { usable, withRecords, free: ref(highest + 1), refused: unusableUpTo > 0 };
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
