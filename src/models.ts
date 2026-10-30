/**
 * Claude Code model catalog (from OpenChamber harness registry).
 */
import {
  EFFORT_LEVELS,
  isClaudeEffort,
  type ClaudeEffort,
} from "./constants.js";
import { readCachedModels, writeCachedModels } from "./model-cache.js";

export type ClaudeModel = {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  resolvedId?: string;
  /** Effort levels the model accepts; defaults to all when reasoning. */
  efforts?: ClaudeEffort[];
  /** Runs in Claude Code's fast mode; `resolvedId` is the plain model. */
  fast?: boolean;
};

/**
 * Suffix of a fast-mode entry's id. OpenCode has no speed setting, so fast
 * mode is a model of its own in the picker ("Opus 5.5 Fast").
 */
export const FAST_MODEL_SUFFIX = ":fast";

const LIMIT_1M = { context: 1_000_000, output: 128_000 } as const;
const LIMIT_200K = { context: 200_000, output: 64_000 } as const;

function model(
  id: string,
  name: string,
  limit: { context: number; output: number },
  resolvedId?: string,
  efforts: ClaudeEffort[] = [...EFFORT_LEVELS],
): ClaudeModel {
  return {
    id,
    name,
    reasoning: efforts.length > 0,
    contextWindow: limit.context,
    maxTokens: limit.output,
    efforts,
    ...(resolvedId ? { resolvedId } : {}),
  };
}

/**
 * Fallback catalog for before the CLI has reported its own list (first
 * start, CLI missing or signed out). Same concrete ids as discovery.
 * OpenCode only runs listed models, so a session that picked a 1.0 alias
 * (`opus[1m]`, `sonnet`) asks the user to pick a model once.
 */
const FALLBACK_MODELS: ClaudeModel[] = [
  model("claude-opus-5-5", "Opus 5.5", LIMIT_1M),
  model("claude-fable-5-1", "Fable 5.1", LIMIT_1M),
  model("claude-sonnet-5-5", "Sonnet 5.5", LIMIT_1M),
  model("claude-sonnet-5", "Sonnet 5", LIMIT_1M),
  model("claude-haiku-5-5", "Haiku 5.5", LIMIT_1M),
  model("claude-haiku-4-5", "Haiku 4.5", LIMIT_200K, undefined, []),
  model("claude-opus-4-8", "Opus 4.8", LIMIT_1M),
];

/** A row of the Agent SDK's `supportedModels()` answer. */
export type SdkModelRow = {
  value: string;
  displayName?: string;
  resolvedModel?: string;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
};

/** Output limit that goes with a context window. */
function limitFor(context: number): { context: number; output: number } {
  const output = context > LIMIT_200K.context ? LIMIT_1M.output : LIMIT_200K.output;
  return { context, output };
}

/** Concrete model id of a `supportedModels()` row, without `[1m]`. */
function rowBaseId(row: SdkModelRow): string | undefined {
  const value = typeof row?.value === "string" ? row.value.trim() : "";
  // The CLI's "default" row only repeats another model.
  if (!value || value === "default") return undefined;
  return (row.resolvedModel || value).replace(/\[1m\]$/i, "");
}

/** Concrete ids of the listed models, without `[1m]`, each once. */
export function listedModelIds(rows: SdkModelRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const base = rowBaseId(row);
    if (base && !ids.includes(base)) ids.push(base);
  }
  return ids;
}

/**
 * `[1m]` variants worth asking the CLI about: only where the plain id runs
 * below 1M (Opus 4.6). A model that already runs at 1M gains nothing from
 * the suffix, and every question costs a model request.
 */
export function extendedProbeIds(
  rows: SdkModelRow[],
  windows: ReadonlyMap<string, number | null>,
): string[] {
  return listedModelIds(rows)
    .filter((id) => {
      const plain = windows.get(id);
      return typeof plain === "number" && plain < LIMIT_1M.context && !windows.has(`${id}[1m]`);
    })
    .map((id) => `${id}[1m]`);
}

/**
 * Display name from the concrete model id ("claude-opus-5-5[1m]" →
 * "Opus 5.5"). CLI display names depend on the CLI version ("Opus (1M
 * context)" can mean Opus 5 or 5.5), so the id is the source of truth.
 */
export function modelNameFromId(id: string | undefined): string | undefined {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i.exec(
    id?.trim() ?? "",
  );
  if (!match) return undefined;
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase();
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

/**
 * Map the CLI's own model list (supportedModels) into the catalog. The
 * context window of each id is the one the CLI reported now (`windows`); an
 * id it could not answer this time keeps what it reported before
 * (`lastAnswers`, from the window cache), and an id it never answered gets
 * 1M, the window of every current model; the next answer corrects an older
 * model that runs at 200K (Haiku 4.5, Opus 4.6, Sonnet 4.6). Claude Code
 * selects 1M through a `[1m]` suffix on the model id (the suffix never
 * reaches the API); a model gets a second "(1M)" entry only when its `[1m]`
 * variant runs a larger window than the plain id (Opus 4.6), and a refused
 * variant is not listed.
 */
export function modelsFromSdk(
  rows: SdkModelRow[],
  windows?: ReadonlyMap<string, number | null>,
  lastAnswers?: ReadonlyMap<string, number | null>,
): ClaudeModel[] {
  const answer = (id: string) => {
    const now = windows?.get(id);
    return now === undefined ? lastAnswers?.get(id) : now;
  };
  const out: ClaudeModel[] = [];
  for (const row of rows) {
    // The concrete id, like t3code: a session stays on the model it picked
    // instead of moving when the CLI's `opus` alias points somewhere new.
    const base = rowBaseId(row);
    if (!base) continue;
    const value = row.value.trim();
    const efforts = (row.supportedEffortLevels ?? []).filter(isClaudeEffort);
    const name =
      modelNameFromId(row.resolvedModel) ??
      modelNameFromId(value) ??
      (row.displayName?.trim() || value);
    const answered = answer(base);
    const plain = typeof answered === "number" ? answered : LIMIT_1M.context;
    out.push(model(base, name, limitFor(plain), undefined, efforts));
    // null: the CLI refused the variant for this account. Not answered this
    // time: its last answer keeps the variant, so a session on it keeps its
    // model until the next refresh asks again.
    const extended = answer(`${base}[1m]`);
    if (typeof extended === "number" && extended > plain) {
      out.push(model(`${base}[1m]`, `${name} (1M)`, limitFor(extended), undefined, efforts));
    }
  }
  // An alias row and its concrete row resolve to the same model.
  const seen = new Set<string>();
  const unique = out.filter((m) => !seen.has(m.id) && seen.add(m.id));
  // Fast mode where the CLI says the model supports it, next to its model.
  const fastFamilies = new Set(
    rows
      .filter((row) => row?.supportsFastMode === true)
      .map((row) => (row.resolvedModel || row.value || "").trim().replace(/\[1m\]$/i, ""))
      .filter((id) => id && id !== "default"),
  );
  return unique.flatMap((m) =>
    fastFamilies.has(m.id.replace(/\[1m\]$/i, ""))
      ? [m, { ...m, id: `${m.id}${FAST_MODEL_SUFFIX}`, name: `${m.name} Fast`, resolvedId: m.id, fast: true }]
      : [m],
  );
}

/**
 * The list the CLI reported, one for the whole OpenCode server. OpenCode
 * gives each project folder its own copy of a local plugin's modules (it
 * clears the module cache when a folder loads the plugin), so a list kept
 * in the module was one per folder: a refresh reached only the folder that
 * ran it, and the others kept what they had read at load. On globalThis,
 * like the refresh time (index.ts). The version in the key changes with the
 * shape of ClaudeModel, so a copy of an older build keeps a list of its own.
 */
const CATALOG_KEY = Symbol.for("@openchamber/opencode-claude/model-catalog/v1");

const catalogRuntime = ((globalThis as Record<symbol, unknown>)[CATALOG_KEY] ??= {
  discovered: readCachedModels(),
}) as { discovered: ClaudeModel[] | null };

function buildCatalog(): ClaudeModel[] {
  const discovered = catalogRuntime.discovered;
  return discovered?.length ? discovered : FALLBACK_MODELS;
}

export function getClaudeModels(): ClaudeModel[] {
  return buildCatalog();
}

/** Replace the discovered list and remember it for the next start. */
export function setDiscoveredModels(models: ClaudeModel[]): boolean {
  if (!models.length) return false;
  const changed = JSON.stringify(models) !== JSON.stringify(catalogRuntime.discovered);
  catalogRuntime.discovered = models;
  if (changed) writeCachedModels(models);
  return changed;
}

/**
 * The list after a refresh the CLI did not fully answer (signed out, a
 * network or API failure): what it listed and could not size says nothing
 * about the account, so every model already listed stays as it is, and only
 * a model new to the list is added. A refresh the CLI fully answers replaces
 * the list (setDiscoveredModels).
 */
export function modelsAfterIncompleteRefresh(found: ClaudeModel[]): ClaudeModel[] {
  const current = catalogRuntime.discovered;
  if (!current?.length) return found;
  const ids = new Set(current.map((m) => m.id));
  return [...current, ...found.filter((m) => !ids.has(m.id))];
}

/** Whether the picked catalog entry runs in fast mode. */
export function isFastModelId(modelId: string): boolean {
  return getClaudeModels().find((m) => m.id === modelId)?.fast === true;
}

export function resolveClaudeModelId(modelId: string): string {
  const match = getClaudeModels().find((m) => m.id === modelId);
  if (!match) return modelId;
  return match.resolvedId || match.id;
}

/**
 * Effort levels offered as OpenCode model variants. The variant id is the
 * effort; the model.request hook turns it into the proxy's effort header.
 */
export function buildEffortVariants(model: ClaudeModel): ClaudeEffort[] {
  if (!model.reasoning) return [];
  return model.efforts ? [...model.efforts] : [...EFFORT_LEVELS];
}
