/**
 * Parked Claude Agent SDK turns waiting for OpenCode tool results
 * (Cursor bridge-pool pattern).
 */
import type { ClaudeQueryHandle } from "./query.js";
import type { ClaudePromptInput } from "./prompt-input.js";
import type { ExclusivePumpGate } from "./serialized-iterator.js";
import type { OpenAIUsage } from "./usage.js";
import { log } from "./log.js";

export type ParkedToolCall = {
  id: string;
  name: string;
  arguments: string;
  resolve: (result: string) => void;
  reject: (error: Error) => void;
};

export type ParkedBridge = {
  id: string;
  conversationKey: string;
  handle: ClaudeQueryHandle;
  pendingTools: Map<string, ParkedToolCall>;
  /** SDK assistant messages whose usage was already reported to OpenCode. */
  seenAssistantUsageIds: Set<string>;
  /** Latest assistant usage, retained for replay-only tool continuations. */
  lastAssistantUsage?: OpenAIUsage;
  createdAt: number;
  /** Continues consuming the SDK stream after tools resolve. */
  continueStream?: (
    releasePump?: () => void,
    requestSignal?: AbortSignal,
  ) => AsyncGenerator<unknown, void, unknown>;
  pumpGate: ExclusivePumpGate;
  input?: ClaudePromptInput;
  streamIterator?: AsyncIterator<unknown>;
  persistent?: boolean;
  closed?: boolean;
  modelId?: string;
  cwd?: string;
};

const bridges = new Map<string, ParkedBridge>();

/**
 * Closing the prompt input tears the SDK stream down synchronously, which put
 * multi-second latency directly on the response path: every turn paid to close
 * the previous turn's bridge before it could proceed. Defer it to the next
 * macrotask instead. The stream still closes and the leak this lifecycle work
 * fixes stays fixed — it just no longer happens while a request is waiting.
 */
function closeInputDeferred(bridge: ParkedBridge): void {
  const input = bridge.input;
  if (!input) return;
  setTimeout(() => {
    try {
      input.close();
    } catch {
      // teardown is best-effort
    }
  }, 0);
}


export function putBridge(bridge: ParkedBridge): void {
  // One active bridge per conversation — drop any prior turn for this key.
  for (const [id, existing] of bridges) {
    if (existing.conversationKey === bridge.conversationKey && id !== bridge.id) {
      for (const tool of existing.pendingTools.values()) {
        tool.reject(new Error("Superseded by a newer turn"));
      }
      existing.pendingTools.clear();
      closeInputDeferred(existing);
      existing.closed = true;
      try {
        existing.handle.close();
      } catch {
        // ignore
      }
      bridges.delete(id);
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

export function deleteBridgesByConversation(conversationKey: string): void {
  for (const [id, bridge] of bridges) {
    if (bridge.conversationKey === conversationKey) deleteBridge(id);
  }
}

export function deleteBridge(id: string): void {
  const bridge = bridges.get(id);
  if (!bridge) return;
  bridge.closed = true;
  for (const tool of bridge.pendingTools.values()) {
    tool.reject(new Error("Bridge closed"));
  }
  bridge.pendingTools.clear();
  closeInputDeferred(bridge);
  try {
    bridge.handle.close();
  } catch {
    log.warn("[opencode-claude] bridge handle close failed", { bridgeId: id });
  } finally {
    bridges.delete(id);
    log.info("[opencode-claude] bridge close", {
      bridgeId: id,
      conversationKey: bridge.conversationKey,
      pendingTools: bridge.pendingTools.size,
    });
  }
}

export function clearAllBridges(): void {
  for (const id of [...bridges.keys()]) {
    deleteBridge(id);
  }
}
