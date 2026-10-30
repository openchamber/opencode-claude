/**
 * The message list OpenCode hands the plugin on every model request.
 *
 * The `context` hook (chat turns) and the `compaction` hook (summaries) run
 * in the plugin instance of the chat's directory right before the HTTP
 * request reaches the proxy, with every message of the request: its OpenCode
 * id, role, content and metadata. The proxy keys its work on those ids (see
 * turn-point.ts), so the hook's event is kept here, by chat and kind, until
 * the request that belongs to it arrives.
 *
 * The event object itself is kept, not a copy: a hook of another plugin may
 * change `messages` after ours, and the proxy must read what OpenCode will
 * send. A chat turn takes its event once (OpenCode runs the hook again for
 * a retry). A compaction keeps its event for the whole operation: OpenCode
 * runs the hook once and may send the request twice (a reminder after a
 * reply that missed the template, a retry after an overflow), so the event
 * stays until a new compaction hook replaces it or the compaction ends.
 *
 * Kept on globalThis like the bridge runtime (bridge-pool.ts): OpenCode
 * loads one plugin instance per directory and reloads a changed plugin as a
 * fresh module copy; the proxy of any copy must see the hook of any other.
 */
import { log } from "./log.js";
import type { ListMessage } from "./names.js";

export type ContextEvent = {
  sessionID: string;
  messages: ListMessage[];
  system?: unknown;
  tools?: unknown;
  options?: unknown;
};

type ContextRuntime = {
  /** Events of chat requests not yet taken, oldest first: a request per hook. */
  primary: Map<string, ContextEvent[]>;
  compaction: Map<string, ContextEvent>;
};

const RUNTIME_KEY = Symbol.for("@openchamber/opencode-claude/context-list/v1");

const runtime: ContextRuntime = ((globalThis as Record<symbol, unknown>)[RUNTIME_KEY] ??= {
  primary: new Map(),
  compaction: new Map(),
}) as ContextRuntime;

/** Chats whose event is kept; long-idle chats fall off. */
const MAX_EVENTS = 500;

function trim<T>(map: Map<string, T>, sessionID: string): void {
  map.delete(sessionID);
  if (map.size >= MAX_EVENTS) map.delete(map.keys().next().value!);
}

/** Hooks of one chat whose request has not arrived yet; more means requests went missing. */
const MAX_PENDING_PER_CHAT = 4;

/** The `context` hook fired: the next chat request of this chat reads this list. */
export function rememberContextEvent(event: ContextEvent): void {
  const pending = runtime.primary.get(event.sessionID) ?? [];
  trim(runtime.primary, event.sessionID);
  runtime.primary.set(event.sessionID, [...pending, event].slice(-MAX_PENDING_PER_CHAT));
}

/** Whether a hook of this chat left a list no request has taken yet. */
export function hasPendingContextEvents(sessionID: string): boolean {
  return (runtime.primary.get(sessionID)?.length ?? 0) > 0;
}

/**
 * The chat request arrived: its list, taken once: the newest hook not yet
 * taken that `fits` the request. One OpenCode never has two requests of one
 * chat in flight, so the request's own hook is the newest; an older one is
 * a hook whose request never came (the turn was stopped between the hook
 * and the HTTP request, or the request was refused before it read its list)
 * and could still fit the request by its texts (the same question asked
 * again after a revert) while naming other messages. A pending list that
 * does not fit the request is dropped, or the next request would be
 * planned on it; an older one that fits stays for a request of its own
 * (two requests of one chat sent at once, as the chat lock's test does).
 */
export function takeContextEvent(sessionID: string, fits: (event: ContextEvent) => boolean = () => true): ContextEvent | undefined {
  const pending = runtime.primary.get(sessionID);
  if (!pending || pending.length === 0) return undefined;
  let event: ContextEvent | undefined;
  const kept: ContextEvent[] = [];
  let dropped = 0;
  for (let i = pending.length - 1; i >= 0; i--) {
    const candidate = pending[i]!;
    if (!fits(candidate)) {
      dropped++;
      continue;
    }
    if (event) kept.unshift(candidate);
    else event = candidate;
  }
  if (kept.length > 0) runtime.primary.set(sessionID, kept);
  else runtime.primary.delete(sessionID);
  if (dropped > 0) {
    // A stopped turn leaves its list behind: routine when the request's own
    // list is found. Without one the request is not served as planned.
    const line = "[opencode-claude] dropped the list of a chat request that never arrived";
    const fields = { sessionID, dropped, found: Boolean(event) };
    if (event) log.info(line, fields);
    else log.warn(line, fields);
  }
  return event;
}

/** The `compaction` hook fired: the summary requests of this chat read this list. */
export function rememberCompactionEvent(event: ContextEvent): void {
  trim(runtime.compaction, event.sessionID);
  runtime.compaction.set(event.sessionID, event);
}

/** A summary request arrived: the list of the compaction in progress, kept. */
export function peekCompactionEvent(sessionID: string): ContextEvent | undefined {
  return runtime.compaction.get(sessionID);
}

/** The compaction ended or failed (OpenCode's event): its list is no longer needed. */
export function clearCompactionEvent(sessionID: string): void {
  runtime.compaction.delete(sessionID);
}

/** Tests only. */
export function resetContextEvents(): void {
  runtime.primary.clear();
  runtime.compaction.clear();
}
