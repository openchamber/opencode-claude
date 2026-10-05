/**
 * Convert Claude Agent SDK result usage into OpenAI-compatible usage objects.
 *
 * Prefer `modelUsage` for totals (includes compact / auxiliary pipeline calls).
 * Fall back to per-turn `usage` (main agent loop only).
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

/** Field-wise `a - b`, clamped at zero; null when nothing grew. */
function usageGrowth(a: OpenAIUsage, b: OpenAIUsage | null): OpenAIUsage | null {
  if (!b) return { ...a };
  const diff = (x?: number, y?: number) => Math.max(0, (x ?? 0) - (y ?? 0));
  const prompt = diff(a.prompt_tokens, b.prompt_tokens);
  const completion = diff(a.completion_tokens, b.completion_tokens);
  const cached = diff(
    a.prompt_tokens_details?.cached_tokens,
    b.prompt_tokens_details?.cached_tokens,
  );
  const cacheWrite = diff(
    a.prompt_tokens_details?.cache_write_tokens,
    b.prompt_tokens_details?.cache_write_tokens,
  );
  const reasoning = diff(
    a.completion_tokens_details?.reasoning_tokens,
    b.completion_tokens_details?.reasoning_tokens,
  );
  if (prompt + completion + cached + cacheWrite + reasoning === 0) return null;
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
 * Per-HTTP-response usage, one entry per Anthropic API call. The SDK reports
 * a call's usage several times: the assistant events carry the message_start
 * snapshot (output_tokens ≈ 1-4) and only message_delta has the final
 * output. Keeping the max per message id makes the final numbers win.
 *
 * `reported` spans continuations of one bridge and holds what each call has
 * already been reported as. A park can hand off before a call's
 * message_delta arrives; the resumed response then sees that delta and
 * reports only the growth over the earlier snapshot, so nothing is counted
 * twice and the final output tokens are not lost.
 *
 * Output tokens add up over the calls of a response. Prompt tokens don't:
 * OpenCode reads them as the size of the context, and compacts when they
 * reach the model's input limit, so they are the last call's prompt (the
 * context as it stands), not the sum of every call's prompt.
 */
export class TurnUsageTracker {
  private readonly byId = new Map<
    string,
    { baseline: OpenAIUsage | null; max: OpenAIUsage }
  >();
  private anonymous: OpenAIUsage | null = null;

  constructor(private readonly reported: Map<string, OpenAIUsage>) {}

  add(usage: OpenAIUsage, messageId: string | null): void {
    if (!messageId) {
      this.anonymous = addOpenAIUsage(this.anonymous, usage);
      return;
    }
    let entry = this.byId.get(messageId);
    if (!entry) {
      const baseline = this.reported.get(messageId) ?? null;
      entry = { baseline, max: baseline ?? usage };
      this.byId.set(messageId, entry);
    }
    entry.max = maxUsage(entry.max, usage);
    this.reported.set(messageId, entry.max);
  }

  total(): OpenAIUsage | null {
    let sum = this.anonymous ? { ...this.anonymous } : null;
    let last: OpenAIUsage | null = null;
    for (const { baseline, max } of this.byId.values()) {
      last = max;
      const growth = usageGrowth(max, baseline);
      if (growth) sum = addOpenAIUsage(sum, growth);
    }
    if (!sum || !last) return sum;
    return withPromptOf(sum, last);
  }
}

/** `usage` with the prompt side (context size) taken from `call`. */
function withPromptOf(usage: OpenAIUsage, call: OpenAIUsage): OpenAIUsage {
  const { prompt_tokens_details: _dropped, ...rest } = usage;
  return {
    ...rest,
    prompt_tokens: call.prompt_tokens,
    total_tokens: call.prompt_tokens + usage.completion_tokens,
    ...(call.prompt_tokens_details
      ? { prompt_tokens_details: { ...call.prompt_tokens_details } }
      : {}),
  };
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
 * Combine the per-response accumulated usage (one entry per Anthropic API
 * call seen during this HTTP response) with the SDK `result` snapshot.
 *
 * The accumulated value is the correct per-response accounting; the result
 * snapshot is cumulative for the whole Claude query (all prior turns of a
 * resumed/continued session included) and would double-count. It is only a
 * fallback for turns where no assistant events were observed, plus a donor
 * for cost/model breakdown metadata.
 */
export function resolveTurnUsage(
  accumulated: OpenAIUsage | null,
  result: OpenAIUsage | null,
): OpenAIUsage | null {
  if (!accumulated) return result;
  if (!result) return accumulated;
  return {
    ...accumulated,
    ...(accumulated.cost_usd === undefined && result.cost_usd !== undefined
      ? { cost_usd: result.cost_usd }
      : {}),
    ...(accumulated.model_usage === undefined && result.model_usage !== undefined
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
