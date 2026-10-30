/**
 * Convert Claude Agent SDK usage into OpenAI-compatible usage objects.
 *
 * A response reports one Anthropic API call's usage (TurnUsageTracker). The
 * `result` event's totals (`modelUsage`, else `usage`) are sums of many calls
 * and only lend a response their cost and per-model breakdown.
 */

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
  /** Estimated USD from the Agent SDK (not a billing statement). */
  cost_usd?: number;
  /** Per-model breakdown when the SDK provides modelUsage. */
  model_usage?: Record<
    string,
    {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
      cost_usd: number;
      context_window?: number;
    }
  >;
};

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function fromAnthropicUsage(usage: Record<string, unknown>): OpenAIUsage {
  const input = asNumber(usage.input_tokens);
  const completion = asNumber(usage.output_tokens);
  const cached = asNumber(usage.cache_read_input_tokens);
  const cacheWrite = asNumber(usage.cache_creation_input_tokens);
  // OpenAI contract: prompt_tokens is the INCLUSIVE prompt total and
  // prompt_tokens_details.cached_tokens is a subset of it. Anthropic reports
  // input_tokens excluding cached tokens, so sum them back in — consumers
  // (OpenCode) derive the non-cached count by subtracting the details.
  const prompt = input + cached + cacheWrite;
  const details: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) details.cached_tokens = cached;
  if (cacheWrite > 0) details.cache_write_tokens = cacheWrite;
  const outputDetails = usage.output_tokens_details as
    | Record<string, unknown>
    | undefined;
  const thinking = asNumber(outputDetails?.thinking_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(details).length ? { prompt_tokens_details: details } : {}),
    ...(thinking > 0
      ? { completion_tokens_details: { reasoning_tokens: thinking } }
      : {}),
  };
}

function fromModelUsage(
  modelUsage: Record<string, unknown>,
): OpenAIUsage | null {
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let cacheWrite = 0;
  let cost = 0;
  const breakdown: NonNullable<OpenAIUsage["model_usage"]> = {};
  let any = false;

  for (const [modelId, raw] of Object.entries(modelUsage)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    any = true;
    const input = asNumber(entry.inputTokens);
    const output = asNumber(entry.outputTokens);
    const cacheRead = asNumber(entry.cacheReadInputTokens);
    const cacheCreate = asNumber(entry.cacheCreationInputTokens);
    const costUSD = asNumber(entry.costUSD);
    prompt += input + cacheRead + cacheCreate;
    completion += output;
    cached += cacheRead;
    cacheWrite += cacheCreate;
    cost += costUSD;
    breakdown[modelId] = {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheCreate,
      cost_usd: costUSD,
      ...(typeof entry.contextWindow === "number"
        ? { context_window: entry.contextWindow }
        : {}),
    };
  }

  if (!any) return null;
  const details: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) details.cached_tokens = cached;
  if (cacheWrite > 0) details.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(details).length ? { prompt_tokens_details: details } : {}),
    ...(cost > 0 ? { cost_usd: cost } : {}),
    ...(Object.keys(breakdown).length ? { model_usage: breakdown } : {}),
  };
}

/**
 * Extract OpenAI-compatible usage from an Agent SDK `result` event.
 */
export function usageFromSdkResult(event: unknown): OpenAIUsage | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "result") return null;

  if (e.modelUsage && typeof e.modelUsage === "object") {
    const fromModels = fromModelUsage(
      e.modelUsage as Record<string, unknown>,
    );
    if (fromModels) {
      if (
        typeof e.total_cost_usd === "number" &&
        Number.isFinite(e.total_cost_usd) &&
        fromModels.cost_usd === undefined
      ) {
        fromModels.cost_usd = e.total_cost_usd;
      }
      return fromModels;
    }
  }

  if (e.usage && typeof e.usage === "object") {
    const usage = fromAnthropicUsage(e.usage as Record<string, unknown>);
    if (
      typeof e.total_cost_usd === "number" &&
      Number.isFinite(e.total_cost_usd)
    ) {
      usage.cost_usd = e.total_cost_usd;
    }
    return usage;
  }

  return null;
}

/**
 * Extract per-API-call usage from an Agent SDK `assistant` event
 * (`message.usage`). Each assistant event carries the usage of exactly one
 * Anthropic API call — including parked (tool-call) turns, where no `result`
 * event exists yet because the query is still alive.
 */
export function usageFromAssistantEvent(event: unknown): OpenAIUsage | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "assistant") return null;
  const message = e.message;
  if (!message || typeof message !== "object") return null;
  const usage = (message as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  return fromAnthropicUsage(usage as Record<string, unknown>);
}

/**
 * Accumulate per-call usage deltas into a per-response total.
 */
export function addOpenAIUsage(
  acc: OpenAIUsage | null,
  delta: OpenAIUsage,
): OpenAIUsage {
  if (!acc) return { ...delta };
  const cached =
    (acc.prompt_tokens_details?.cached_tokens ?? 0) +
    (delta.prompt_tokens_details?.cached_tokens ?? 0);
  const cacheWrite =
    (acc.prompt_tokens_details?.cache_write_tokens ?? 0) +
    (delta.prompt_tokens_details?.cache_write_tokens ?? 0);
  const reasoning =
    (acc.completion_tokens_details?.reasoning_tokens ?? 0) +
    (delta.completion_tokens_details?.reasoning_tokens ?? 0);
  const promptDetails: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) promptDetails.cached_tokens = cached;
  if (cacheWrite > 0) promptDetails.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: acc.prompt_tokens + delta.prompt_tokens,
    completion_tokens: acc.completion_tokens + delta.completion_tokens,
    total_tokens: acc.total_tokens + delta.total_tokens,
    ...(Object.keys(promptDetails).length
      ? { prompt_tokens_details: promptDetails }
      : {}),
    ...(reasoning > 0
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
  };
}

/** Stream-event usage (message_start / message_delta) as OpenAI usage. */
export function usageFromAnthropic(usage: unknown): OpenAIUsage | null {
  if (!usage || typeof usage !== "object") return null;
  return fromAnthropicUsage(usage as Record<string, unknown>);
}

function maxUsage(a: OpenAIUsage, b: OpenAIUsage): OpenAIUsage {
  const pick = (x?: number, y?: number) => Math.max(x ?? 0, y ?? 0);
  const cached = pick(
    a.prompt_tokens_details?.cached_tokens,
    b.prompt_tokens_details?.cached_tokens,
  );
  const cacheWrite = pick(
    a.prompt_tokens_details?.cache_write_tokens,
    b.prompt_tokens_details?.cache_write_tokens,
  );
  const reasoning = pick(
    a.completion_tokens_details?.reasoning_tokens,
    b.completion_tokens_details?.reasoning_tokens,
  );
  const prompt = pick(a.prompt_tokens, b.prompt_tokens);
  const completion = pick(a.completion_tokens, b.completion_tokens);
  const promptDetails: NonNullable<OpenAIUsage["prompt_tokens_details"]> = {};
  if (cached > 0) promptDetails.cached_tokens = cached;
  if (cacheWrite > 0) promptDetails.cache_write_tokens = cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(promptDetails).length
      ? { prompt_tokens_details: promptDetails }
      : {}),
    ...(reasoning > 0
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
  };
}

/**
 * The usage a response reports: one Anthropic API call's, the last one the
 * response started after Claude Code last compacted the conversation. Every
 * call sends the whole conversation, so its prompt is the context as it
 * stands and its prompt plus output the context after it. OpenCode reads the
 * usage exactly so and compacts when it reaches the model's input limit.
 * Adding calls up would count the earlier calls' answers twice: they are
 * already inside the last call's prompt.
 *
 * The SDK reports a call's usage several times: the assistant events carry
 * the message_start snapshot (output_tokens ≈ 1-4) and only message_delta
 * has the final output. Keeping the max per message id makes the final
 * numbers win.
 *
 * A call belongs to the response that saw it first; `seenCalls` spans the
 * continuations of one bridge. A later response does not report it again: not
 * a parallel tool call of the same message, not a message_delta that came
 * after a park handed off, not usage without a message id. A response that
 * saw no call of its own reports no usage, and OpenCode keeps the size it
 * measured last.
 */
export class TurnUsageTracker {
  private readonly calls = new Map<string, OpenAIUsage>();

  constructor(private readonly seenCalls: Set<string>) {}

  add(usage: OpenAIUsage, messageId: string | null): void {
    if (!messageId) return;
    const seen = this.calls.get(messageId);
    if (!seen && this.seenCalls.has(messageId)) return;
    this.seenCalls.add(messageId);
    this.calls.set(messageId, seen ? maxUsage(seen, usage) : usage);
  }

  /** Claude Code compacted the conversation: the calls before no longer describe it. */
  compacted(): void {
    this.calls.clear();
  }

  total(): OpenAIUsage | null {
    let last: OpenAIUsage | null = null;
    for (const usage of this.calls.values()) last = usage;
    return last ? { ...last } : null;
  }
}

/** Count a replayed SDK assistant message only once across tool continuations. */
export function addUniqueAssistantUsage(
  acc: OpenAIUsage | null,
  delta: OpenAIUsage,
  messageId: string | null,
  seen: Set<string>,
): OpenAIUsage | null {
  if (messageId) {
    if (seen.has(messageId)) return acc;
    seen.add(messageId);
  }
  return addOpenAIUsage(acc, delta);
}

/**
 * A response's usage: its call's (TurnUsageTracker), with the cost and
 * per-model breakdown of the SDK `result` when one came.
 *
 * The result's tokens are never the response's: `usage` sums every call of
 * the turn and `modelUsage` every call of the session, a resumed one starting
 * from the totals its transcript saved. Reported as the context size, a turn
 * that failed before its first call made OpenCode see a 1M chat at 64M and
 * compact before every message. A response without a call reports nothing.
 */
export function resolveTurnUsage(
  call: OpenAIUsage | null,
  result: OpenAIUsage | null,
): OpenAIUsage | null {
  if (!call) return null;
  if (!result) return call;
  return {
    ...call,
    ...(call.cost_usd === undefined && result.cost_usd !== undefined
      ? { cost_usd: result.cost_usd }
      : {}),
    ...(call.model_usage === undefined && result.model_usage !== undefined
      ? { model_usage: result.model_usage }
      : {}),
  };
}

export function formatCompactNote(meta: unknown): string {
  if (!meta || typeof meta !== "object") {
    return "[compact] Conversation compacted.\n";
  }
  const m = meta as Record<string, unknown>;
  const trigger = typeof m.trigger === "string" ? m.trigger : "auto";
  const pre = asNumber(m.pre_tokens);
  const post =
    typeof m.post_tokens === "number" && Number.isFinite(m.post_tokens)
      ? m.post_tokens
      : null;
  const duration =
    typeof m.duration_ms === "number" && Number.isFinite(m.duration_ms)
      ? m.duration_ms
      : null;
  const parts = [`[compact] Conversation compacted (${trigger})`];
  if (pre > 0) {
    parts.push(
      post !== null
        ? `tokens ${pre} → ${post}`
        : `pre_tokens ${pre}`,
    );
  }
  if (duration !== null) parts.push(`${duration}ms`);
  return `${parts.join("; ")}.\n`;
}
