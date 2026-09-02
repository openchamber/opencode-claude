/**
 * Claude Code model catalog (from OpenChamber harness registry).
 */
import { EFFORT_LEVELS, type ClaudeEffort } from "./constants.js";

export type ClaudeModel = {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  resolvedId?: string;
};

const LIMIT_1M = { context: 1_000_000, output: 128_000 } as const;
const LIMIT_200K = { context: 200_000, output: 64_000 } as const;

/** OpenCode may inject these before merging plugin variants — disable extras. */
export const GENERATED_VARIANT_KEYS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function model(
  id: string,
  name: string,
  limit: { context: number; output: number },
  resolvedId?: string,
): ClaudeModel {
  return {
    id,
    name,
    reasoning: true,
    contextWindow: limit.context,
    maxTokens: limit.output,
    ...(resolvedId ? { resolvedId } : {}),
  };
}

const ALIAS_MODELS: ClaudeModel[] = [
  model("fable", "Fable 5", LIMIT_1M),
  model("opus", "Opus 5", LIMIT_1M),
  model("sonnet", "Sonnet 5", LIMIT_1M),
  model("haiku", "Haiku 4.5", LIMIT_200K, "claude-haiku-4-5"),
];

const PINNED_MODELS: ClaudeModel[] = [
  model("claude-fable-5-1", "Fable 5.1", LIMIT_1M),
  model("claude-opus-4-8", "Opus 4.8", LIMIT_1M),
  model("claude-sonnet-4-6", "Sonnet 4.6", LIMIT_1M),
  model("claude-haiku-4-5", "Haiku 4.5", LIMIT_200K),
];

function buildCatalog(): ClaudeModel[] {
  const aliasResolved = new Set(
    ALIAS_MODELS.map((m) => m.resolvedId).filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );
  const aliasNames = new Set(ALIAS_MODELS.map((m) => m.name));
  const visiblePins = PINNED_MODELS.filter(
    (m) => !aliasResolved.has(m.id) && !aliasNames.has(m.name),
  );
  return [...ALIAS_MODELS, ...visiblePins];
}

export const CLAUDE_CODE_MODELS: ClaudeModel[] = buildCatalog();

export function getClaudeModels(): ClaudeModel[] {
  return CLAUDE_CODE_MODELS;
}

export function resolveClaudeModelId(modelId: string): string {
  const match = CLAUDE_CODE_MODELS.find((m) => m.id === modelId);
  if (!match) return modelId;
  return match.resolvedId || match.id;
}

/**
 * Runtime variants for the provider.models() hook.
 * Keys are OpenCode UI choices; values carry the effort level for chat.headers.
 */
export function buildEffortVariants(
  model: ClaudeModel,
): Record<string, { effort: ClaudeEffort } | { disabled: true }> {
  if (!model.reasoning) return {};
  const variants: Record<
    string,
    { effort: ClaudeEffort } | { disabled: true }
  > = Object.fromEntries(EFFORT_LEVELS.map((effort) => [effort, { effort }]));
  for (const key of GENERATED_VARIANT_KEYS) {
    if (!(key in variants)) variants[key] = { disabled: true };
  }
  return variants;
}

/**
 * Static config variants. Same effort map; OpenCode merges these into the menu.
 * Mark config model `reasoning: false` so OpenCode does not prepend its own
 * generic low/medium/high ahead of this map.
 */
export function buildConfigVariants(
  model: ClaudeModel,
): Record<string, { effort: ClaudeEffort } | { disabled: true }> {
  return buildEffortVariants(model);
}
