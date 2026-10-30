/**
 * Sticky foreign Claude session IDs for Agent SDK resume
 * (OpenChamber harness session-bindings pattern, scoped to this proxy).
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeConfigDir } from "./config-dir.js";

export type ClaudeSessionBinding = {
  conversationKey: string;
  foreignSessionId: string;
  modelId?: string;
  cwd?: string;
  /**
   * Last transcript entry this plugin saw on the conversation's main chain.
   * Another claude process writing to the same session file (a turn
   * orphaned by an OpenCode restart, closed by the TTL reaper an hour later)
   * can append a branch that a plain resume would follow; the resume then
   * goes through a fork cut here (see sessionChainAfterLeaf).
   */
  leafUuid?: string;
  /**
   * Where each OpenCode history this session answered ends in the Claude
   * transcript, oldest first. A revert or edit in OpenCode shortens the
   * history; the matching boundary says where to resume from.
   */
  turns?: TurnBoundary[];
  updatedAt: number;
};

/**
 * One point of a conversation: the OpenCode history held `count` user
 * messages (see userHistoryFingerprints), the last one hashing to `hash`,
 * and the main chain of Claude session `sessionId` ended at `leafUuid`.
 * Boundaries survive forks: an older one still points into the session
 * file it was recorded in. Boundaries stored before sessionId existed
 * belong to the binding's session (see setForeignSessionId).
 */
export type TurnBoundary = {
  count: number;
  hash: string;
  leafUuid?: string;
  sessionId?: string;
};

/** The history part of a boundary, without where it sits in Claude. */
type BoundaryKey = Pick<TurnBoundary, "count" | "hash">;

/** Boundaries kept per binding; older ones can no longer be rewound to. */
const MAX_TURN_BOUNDARIES = 100;

function storePath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "sessions.json");
}

function readStore(): Record<string, ClaudeSessionBinding> {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      ClaudeSessionBinding
    >;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, ClaudeSessionBinding>): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function getForeignSessionId(
  conversationKey: string,
): string | undefined {
  const entry = readStore()[conversationKey];
  return entry?.foreignSessionId;
}

export function getSessionLeafUuid(conversationKey: string): string | undefined {
  return readStore()[conversationKey]?.leafUuid;
}

/**
 * What this process last wrote per conversation. Every streamed event of a
 * turn reports the session id, and most carry no new leaf: comparing with
 * this skips the read-modify-write of sessions.json for them.
 */
const written = new Map<string, Omit<ClaudeSessionBinding, "updatedAt">>();

/**
 * Boundary of a turn that started without a binding (first turn, history
 * transferred after a revert). It joins the binding the turn creates.
 */
const pendingTurns = new Map<string, TurnBoundary[]>();

type StoredBinding = Omit<ClaudeSessionBinding, "updatedAt">;

function sameBinding(a: StoredBinding | undefined, b: StoredBinding): boolean {
  return (
    !!a &&
    a.foreignSessionId === b.foreignSessionId &&
    a.leafUuid === b.leafUuid &&
    a.modelId === b.modelId &&
    a.cwd === b.cwd &&
    JSON.stringify(a.turns ?? []) === JSON.stringify(b.turns ?? [])
  );
}

function sameBoundary(a: BoundaryKey | undefined, b: BoundaryKey): boolean {
  return !!a && a.count === b.count && a.hash === b.hash;
}

function save(
  store: Record<string, ClaudeSessionBinding>,
  binding: StoredBinding,
): void {
  written.set(binding.conversationKey, binding);
  store[binding.conversationKey] = { ...binding, updatedAt: Date.now() };
  writeStore(store);
}

export function setForeignSessionId(
  conversationKey: string,
  foreignSessionId: string,
  meta?: { modelId?: string; cwd?: string; leafUuid?: string },
): void {
  const cached = written.get(conversationKey);
  if (
    cached &&
    !pendingTurns.has(conversationKey) &&
    cached.foreignSessionId === foreignSessionId &&
    cached.modelId === meta?.modelId &&
    cached.cwd === meta?.cwd &&
    (meta?.leafUuid === undefined || meta.leafUuid === cached.leafUuid)
  ) {
    return;
  }
  const store = readStore();
  const previous = store[conversationKey];
  const sameSession = previous?.foreignSessionId === foreignSessionId;
  // A new session id starts a new chain; the old leaf means nothing there.
  const leafUuid = meta?.leafUuid ?? (sameSession ? previous?.leafUuid : undefined);
  // The old boundaries stay, pointing into the session they were recorded
  // in. Ones stored without a session id were recorded against the
  // previous binding's session (a rewind checks the leaf is still there).
  let turns: TurnBoundary[] = (previous?.turns ?? []).map((turn) =>
    turn.sessionId || sameSession || !previous
      ? { ...turn }
      : { ...turn, sessionId: previous.foreignSessionId },
  );
  for (const pending of pendingTurns.get(conversationKey) ?? []) {
    if (!sameBoundary(turns.at(-1), pending)) turns.push({ ...pending });
  }
  pendingTurns.delete(conversationKey);
  if (turns.length > 0 && leafUuid) {
    turns[turns.length - 1] = { ...turns.at(-1)!, leafUuid, sessionId: foreignSessionId };
  }
  turns = turns.slice(-MAX_TURN_BOUNDARIES);
  const next: StoredBinding = {
    conversationKey,
    foreignSessionId,
    modelId: meta?.modelId,
    cwd: meta?.cwd,
    leafUuid,
    ...(turns.length > 0 ? { turns } : {}),
  };
  if (sameBinding(previous, next)) {
    written.set(conversationKey, next);
    return;
  }
  save(store, next);
}

export function getSessionTurns(conversationKey: string): TurnBoundary[] {
  return readStore()[conversationKey]?.turns ?? [];
}

/**
 * A turn starts for an OpenCode history of `boundary.count` user messages.
 * The history the same turn continues (a retry, a rebuilt tool step) keeps
 * its boundary; a new one is appended and follows the leaf from now on.
 * Without a binding yet, the boundary waits for the one the turn creates.
 *
 * `before` is the history before the turn's prompt. When an existing
 * binding has no boundaries yet, it is recorded first at the current leaf,
 * so a retry of this very request can go back to it.
 */
export function recordTurnStart(
  conversationKey: string,
  boundary: BoundaryKey,
  before?: BoundaryKey,
): void {
  const store = readStore();
  const binding = store[conversationKey];
  const turns = [...(binding?.turns ?? [])];
  if (binding && turns.length === 0 && before && before.count > 0 && !sameBoundary(before, boundary)) {
    turns.push(atLeaf(before, binding));
  }
  if (!sameBoundary(turns.at(-1), boundary)) {
    turns.push(atLeaf(boundary, binding));
  }
  if (!binding) {
    pendingTurns.set(conversationKey, turns);
    return;
  }
  pendingTurns.delete(conversationKey);
  if (turns.length === (binding.turns ?? []).length) return;
  const { updatedAt: _updatedAt, ...stored } = binding;
  save(store, { ...stored, turns: turns.slice(-MAX_TURN_BOUNDARIES) });
}

function atLeaf(boundary: BoundaryKey, binding: ClaudeSessionBinding | undefined): TurnBoundary {
  return {
    count: boundary.count,
    hash: boundary.hash,
    leafUuid: binding?.leafUuid,
    ...(binding?.leafUuid ? { sessionId: binding.foreignSessionId } : {}),
  };
}

/**
 * OpenCode's history went back to boundary `index` (revert, edit): resume
 * from its leaf and forget the turns after it.
 */
export function rewindSessionTurns(conversationKey: string, index: number): void {
  const store = readStore();
  const binding = store[conversationKey];
  const target = binding?.turns?.[index];
  if (!binding || !target) return;
  const { updatedAt: _updatedAt, ...stored } = binding;
  save(store, {
    ...stored,
    // A boundary in another session (before a fork) is no leaf of this
    // one; the fork the caller makes from it brings its own.
    leafUuid:
      !target.sessionId || target.sessionId === binding.foreignSessionId
        ? target.leafUuid
        : undefined,
    turns: binding.turns!.slice(0, index + 1),
  });
}

export type TurnHistoryMatch =
  | { kind: "untracked" }
  | { kind: "latest"; count: number }
  | { kind: "rewind"; index: number; leafUuid?: string; sessionId?: string }
  | { kind: "diverged" };

/**
 * Compare the OpenCode history before a new prompt (as fingerprints) with
 * the boundaries a binding recorded.
 * - latest: the history still holds the newest boundary's user messages
 *   (more may follow: turns another model answered, the prompt of a turn
 *   that failed before Claude ran). Resume as usual; `count` is the
 *   boundary's size, so the caller can hand Claude what came after it.
 * - rewind: the history ends exactly at an earlier boundary, so the turns
 *   after it were reverted or edited away.
 * - diverged: nothing lines up; the session holds a history OpenCode no
 *   longer has.
 * - untracked: a binding from before boundaries were recorded.
 */
export function matchTurnHistory(
  turns: TurnBoundary[],
  prints: string[],
): TurnHistoryMatch {
  const latest = turns.at(-1);
  if (!latest) return { kind: "untracked" };
  const n = prints.length;
  if (n >= latest.count && prints[latest.count - 1] === latest.hash) {
    return { kind: "latest", count: latest.count };
  }
  for (let i = turns.length - 2; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.count === n && prints[n - 1] === turn.hash) {
      return {
        kind: "rewind",
        index: i,
        leafUuid: turn.leafUuid,
        ...(turn.sessionId ? { sessionId: turn.sessionId } : {}),
      };
    }
  }
  return { kind: "diverged" };
}

/**
 * Whether a Claude Code transcript still holds the entry with this uuid.
 * The entry is almost always the resume leaf, near the end of a file that
 * can reach tens of megabytes, so the file is read backwards in chunks and
 * the search stops at the first hit.
 */
export function sessionFileHasEntry(
  file: string,
  uuid: string,
  chunkBytes = 256 * 1024,
): boolean {
  const needle = Buffer.from(`"uuid":"${uuid}"`, "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    let end = fstatSync(fd).size;
    // Leading bytes of what was read so far (the part after this chunk in
    // the file), so a match split across a chunk border is still found.
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const window = Buffer.concat([chunk, carry]);
      if (window.includes(needle)) return true;
      carry = window.subarray(0, Math.min(window.length, needle.length - 1));
      end = start;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export type LeafChainState = "clean" | "branched" | "missing";

/**
 * Whether everything written after `leafUuid` in a Claude Code transcript
 * continues from it. A plain resume follows the file's latest chain; when
 * another claude process appended a side branch after our leaf, that chain
 * may not be ours, and the CLI's resumeSessionAt only searches the chain it
 * picked. So:
 * - clean: every message after the leaf descends from it; a plain resume
 *   sees our history.
 * - branched: some message after the leaf hangs off another parent, or the
 *   CLI's last-prompt pointer after it names an entry outside our chain;
 *   resume must go through a fork cut at the leaf.
 * - missing: the leaf isn't in the file (or the file can't be read).
 *
 * Only the tail after the leaf is parsed; the file is read backwards in
 * chunks until the leaf's line is reached.
 */
export function sessionChainAfterLeaf(
  file: string,
  leafUuid: string,
  chunkBytes = 256 * 1024,
): LeafChainState {
  const needle = Buffer.from(`"uuid":"${leafUuid}"`, "utf8");
  let fd: number | undefined;
  let tail: Buffer | undefined;
  try {
    fd = openSync(file, "r");
    let end = fstatSync(fd).size;
    let window = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      window = Buffer.concat([chunk, window]);
      end = start;
      const at = window.lastIndexOf(needle);
      if (at < 0) continue;
      const lineStart = window.lastIndexOf(0x0a, at);
      // The leaf's line starts in a chunk not read yet.
      if (lineStart < 0 && start > 0) continue;
      const lineEnd = window.indexOf(0x0a, at);
      tail = lineEnd < 0 ? Buffer.alloc(0) : window.subarray(lineEnd + 1);
      break;
    }
  } catch {
    return "missing";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (!tail) return "missing";
  const chain = new Set([leafUuid]);
  // The chain the CLI resumes is the one its latest last-prompt entry
  // points at. Another process finishing a turn on a side branch writes one
  // even when its messages landed before our leaf in the file.
  let lastPromptLeaf: string | undefined;
  for (const line of tail.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "last-prompt" && typeof entry.leafUuid === "string") {
      lastPromptLeaf = entry.leafUuid;
      continue;
    }
    const uuid = typeof entry.uuid === "string" ? entry.uuid : undefined;
    if (!uuid || entry.isSidechain === true) continue;
    const parent =
      typeof entry.parentUuid === "string"
        ? entry.parentUuid
        : typeof entry.logicalParentUuid === "string"
          ? entry.logicalParentUuid
          : undefined;
    if (parent && chain.has(parent)) {
      chain.add(uuid);
      continue;
    }
    if (isChainMessage(entry)) return "branched";
  }
  return lastPromptLeaf && !chain.has(lastPromptLeaf) ? "branched" : "clean";
}

/**
 * The uuid of the last conversation entry (user, assistant, compact
 * boundary) in a transcript: for a fresh fork, the copy of the entry it was
 * cut at. Read backwards in chunks; undefined when there is none.
 */
export function lastChainEntryUuid(
  file: string,
  chunkBytes = 256 * 1024,
): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    let end = fstatSync(fd).size;
    // Bytes after the last newline seen so far: a line not yet complete.
    let rest = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      end = start;
      const window = Buffer.concat([chunk, rest]);
      const lines = window.toString("utf8").split("\n");
      // The first piece may be cut; keep it for the next chunk.
      const head = start > 0 ? lines.shift() ?? "" : "";
      for (let i = lines.length - 1; i >= 0; i--) {
        const uuid = chainEntryUuid(lines[i]!);
        if (uuid) return uuid;
      }
      rest = Buffer.from(head, "utf8");
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A conversation entry: a message or a compaction boundary. */
function isChainMessage(entry: Record<string, unknown>): boolean {
  return (
    entry.type === "user" ||
    entry.type === "assistant" ||
    (entry.type === "system" && entry.subtype === "compact_boundary")
  );
}

function chainEntryUuid(line: string): string | undefined {
  if (!line.trim()) return undefined;
  try {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (typeof entry.uuid !== "string" || entry.isSidechain === true) return undefined;
    return isChainMessage(entry) ? entry.uuid : undefined;
  } catch {
    return undefined;
  }
}

export function clearForeignSessionId(conversationKey: string): void {
  written.delete(conversationKey);
  const store = readStore();
  if (!(conversationKey in store)) return;
  delete store[conversationKey];
  writeStore(store);
}

/**
 * Stable key from OpenAI messages so follow-ups resume the same Claude session.
 * Hashes the first user message only — including the message count made the key
 * change on every turn, which defeated resume entirely when the session header
 * is absent.
 */
export function conversationKeyFromMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  const firstUser = messages.find((m) => m.role === "user");
  const seed =
    typeof firstUser?.content === "string"
      ? firstUser.content.slice(0, 200)
      : JSON.stringify(firstUser?.content ?? "").slice(0, 200);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `conv_${hash.toString(16)}`;
}

/**
 * Locate the Claude Code transcript for a foreign session id. A missing file
 * means resume silently starts (or errors into) a context-free session, so
 * callers must fall back to history injection instead.
 *
 * Every project folder is searched on purpose. The CLI writes a session
 * under ~/.claude/projects/<slug of the realpath cwd>/, but `--resume <id>`
 * finds it from any cwd: checked live on CLI 2.1.224 and 2.1.284, a resume
 * from another directory loaded the full history and appended to the
 * original file. A chat whose directory changed keeps resuming.
 */
export function findClaudeSessionFile(
  foreignSessionId: string,
  configDir?: string,
): string | null {
  const id = foreignSessionId.trim();
  if (!id) return null;
  const projectsDir = join(claudeConfigDir(configDir), "projects");
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = join(projectsDir, dir, `${id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
