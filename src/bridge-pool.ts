/**
 * Parked Claude Agent SDK turns waiting for OpenCode tool results
 * (Cursor bridge-pool pattern).
 */
import { withGracefulStop, type StoppableClaudeQueryHandle } from "./query.js";
import type { McpToolResultContent } from "./prompt.js";
import type { OpenAIUsage } from "./usage.js";

export type ParkedToolCall = {
  id: string;
  name: string;
  arguments: string;
  resolve: (result: McpToolResultContent[]) => void;
  reject: (error: Error) => void;
};

export type ParkedBridge = {
  id: string;
  conversationKey: string;
  /** Request kind of the turn (title, summary, generate), null for chat. */
  metaKind?: string | null;
  handle: StoppableClaudeQueryHandle;
  pendingTools: Map<string, ParkedToolCall>;
  /**
   * Usage already reported to OpenCode per SDK assistant message, so a
   * continuation reports only what a call grew by since the last response.
   */
  reportedUsage: Map<string, OpenAIUsage>;
  /** Keys of mid-turn user messages already attached to a tool result. */
  forwardedSteering: Set<string>;
  createdAt: number;
  /** Continues consuming the SDK stream after tools resolve. */
  continueStream?: (requestSignal?: AbortSignal) => AsyncGenerator<unknown, void, unknown>;
};

/**
 * Turns live in the process, not in a copy of this module. OpenCode reloads
 * a plugin by importing a fresh copy and unloading the old one, and loads
 * one copy per location; a parked turn must survive that and be resumed by
 * whichever copy receives its tool results.
 */
type BridgeRuntime = {
  bridges: Map<string, ParkedBridge>;
  stopping: Map<string, Set<Promise<void>>>;
  /** Plugin instances holding the proxy, across every copy of the module. */
  holders: number;
  /** Stop of every turn scheduled after the last instance released. */
  shutdownTimer?: ReturnType<typeof setTimeout>;
};

const RUNTIME_KEY = Symbol.for("@openchamber/opencode-claude/bridge-runtime/v1");

export const bridgeRuntime: BridgeRuntime = ((globalThis as Record<symbol, unknown>)[
  RUNTIME_KEY
] ??= { bridges: new Map(), stopping: new Map(), holders: 0 }) as BridgeRuntime;

const bridges = bridgeRuntime.bridges;

export function putBridge(bridge: ParkedBridge): void {
  // One active bridge per conversation. Callers stop the previous turn
  // before starting a new one (stopConversationBridges); this only catches
  // a turn that slipped past that, and does not wait for it.
  for (const existing of [...bridges.values()]) {
    if (existing.conversationKey === bridge.conversationKey && existing.id !== bridge.id) {
      void stopBridge(existing.id, "Superseded by a newer turn");
    }
  }
  bridges.set(bridge.id, bridge);
}

export function getBridge(id: string): ParkedBridge | undefined {
  return bridges.get(id);
}

export function findBridgeByConversation(
  conversationKey: string,
): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.conversationKey === conversationKey) return bridge;
  }
  return undefined;
}

export function findBridgeByPendingTool(
  toolCallId: string,
): ParkedBridge | undefined {
  for (const bridge of bridges.values()) {
    if (bridge.pendingTools.has(toolCallId)) return bridge;
  }
  return undefined;
}

function rejectPending(bridge: ParkedBridge, reason: string): void {
  for (const tool of bridge.pendingTools.values()) {
    tool.reject(new Error(reason));
  }
  bridge.pendingTools.clear();
}

/**
 * Close a bridge whose turn is already over (its stream ended or failed):
 * nothing is left to settle, so the process is closed at once.
 */
export function deleteBridge(id: string): void {
  const bridge = bridges.get(id);
  if (!bridge) return;
  bridges.delete(id);
  rejectPending(bridge, "Bridge closed");
  bridge.handle.close();
}

/**
 * Stop a turn that may still be running or parked: interrupt it, give the
 * CLI a moment to record the interruption, then close it. The bridge leaves
 * the pool at once, so no request resumes it meanwhile. Pending tool calls
 * are rejected only after the interrupt: rejecting first would hand the CLI
 * an error result it answers with another model call.
 */
export function stopBridge(id: string, reason = "Bridge closed"): Promise<void> {
  const bridge = bridges.get(id);
  if (!bridge) return Promise.resolve();
  bridges.delete(id);
  const key = bridge.conversationKey;
  const stop = (async () => {
    try {
      await withGracefulStop(bridge.handle).stop();
    } finally {
      rejectPending(bridge, reason);
    }
  })();
  // Out of the pool but not closed yet: a new turn must still wait for it.
  let pending = stopping.get(key);
  if (!pending) stopping.set(key, (pending = new Set()));
  pending.add(stop);
  void stop.finally(() => {
    pending.delete(stop);
    if (pending.size === 0 && stopping.get(key) === pending) stopping.delete(key);
  });
  return stop;
}

/** Stops started for a conversation that have not closed their process yet. */
const stopping = bridgeRuntime.stopping;

/**
 * Stop every turn of a conversation, including stops already running in the
 * background, and wait until their processes close. Returns how many turns
 * were still in the pool.
 */
export async function stopConversationBridges(
  conversationKey: string,
  reason?: string,
): Promise<number> {
  const ids = [...bridges.values()]
    .filter((bridge) => bridge.conversationKey === conversationKey)
    .map((bridge) => bridge.id);
  const started = ids.map((id) => stopBridge(id, reason));
  await Promise.all([...started, ...(stopping.get(conversationKey) ?? [])]);
  return ids.length;
}

/**
 * The OpenCode session stopped (user abort, shutdown, supersede) while its
 * turn was parked on tool calls: nothing will resume it, so stop the turn
 * and its claude process now instead of waiting for the TTL reaper. Returns
 * how many turns are being stopped; the stop itself runs in the background.
 */
export function closeSessionBridges(sessionId: string): number {
  let closed = 0;
  for (const bridge of [...bridges.values()]) {
    if (bridge.conversationKey === sessionId) {
      void stopBridge(bridge.id);
      closed += 1;
    }
  }
  return closed;
}

/** Stop every turn (proxy shutdown); resolves once all processes closed. */
export async function clearAllBridges(): Promise<void> {
  await Promise.all([...bridges.keys()].map((id) => stopBridge(id)));
}
