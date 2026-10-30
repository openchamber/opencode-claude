/**
 * What the plugin keeps on disk about the CLI's models, under
 * `$XDG_DATA_HOME/opencode-claude` (default `~/.local/share`):
 * - models.json: the last menu, served at start until the CLI answers;
 * - context-windows.json: the context windows the CLI reported, so each
 *   model costs a model request only when something changed.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ClaudeModel } from "./models.js";

function dataFilePath(name: string): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode-claude", name);
}

function modelCachePath(): string {
  return dataFilePath("models.json");
}

export function readCachedModels(): ClaudeModel[] | null {
  try {
    const parsed = JSON.parse(readFileSync(modelCachePath(), "utf8"));
    return Array.isArray(parsed) && parsed.length ? (parsed as ClaudeModel[]) : null;
  } catch {
    return null;
  }
}

export function writeCachedModels(models: ClaudeModel[]): void {
  try {
    const file = modelCachePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(models, null, 2));
  } catch {
    // The cache only speeds up the next start.
  }
}

/**
 * Context windows the CLI reported, by model id; null means the CLI refused
 * the id (a `[1m]` variant the plan does not include). Asking costs a model
 * request per id (`setModel` checks a new model with a one-token call), so
 * answers are kept while `key` stays the same (CLI version, account, the
 * 1M switch) and the CLI lists no new model, and for a day at most: the day
 * also catches what Anthropic changes on its side without a new CLI, such
 * as 1M access for the account.
 */
export type ContextWindowCache = {
  key: string;
  savedAt: number;
  /** The listed models the windows were taken for. */
  models: string[];
  windows: Record<string, number | null>;
  /**
   * What the CLI answered under an earlier key or an expired day, for the
   * ids `windows` does not hold yet. Not used as a cache, only as the last
   * answer (readLastContextWindows): a pass under a new key that the CLI
   * answers only in part (signed out, offline) keeps the rest that way.
   */
  earlier?: Record<string, number | null>;
};

const CONTEXT_WINDOW_CACHE_TTL_MS = 24 * 60 * 60_000;

/** The stored windows if they were taken under `key` less than a day ago. */
export function readContextWindowCache(
  key: string,
  now = Date.now(),
): ContextWindowCache | null {
  try {
    const parsed = JSON.parse(
      readFileSync(dataFilePath("context-windows.json"), "utf8"),
    ) as Partial<ContextWindowCache>;
    if (parsed.key !== key || typeof parsed.savedAt !== "number") return null;
    // A savedAt in the future means the clock moved back: ask again.
    if (parsed.savedAt > now || now - parsed.savedAt >= CONTEXT_WINDOW_CACHE_TTL_MS) return null;
    if (!parsed.windows || typeof parsed.windows !== "object") return null;
    if (!Array.isArray(parsed.models)) return null;
    return { key, savedAt: parsed.savedAt, models: parsed.models, windows: parsed.windows };
  } catch {
    return null;
  }
}

/**
 * Every window the CLI ever reported and the cache still holds, whatever its
 * key or age: the answer to fall back on when the CLI cannot answer now.
 * Unlike the menu in models.json, it never holds a guess.
 */
export function readLastContextWindows(): Map<string, number | null> {
  try {
    const parsed = JSON.parse(
      readFileSync(dataFilePath("context-windows.json"), "utf8"),
    ) as Partial<ContextWindowCache>;
    const answers = new Map<string, number | null>();
    // The current key's answers come last and win.
    for (const source of [parsed.earlier, parsed.windows]) {
      for (const [id, window] of Object.entries(source ?? {})) {
        if (typeof window === "number" || window === null) answers.set(id, window);
      }
    }
    return answers;
  } catch {
    return new Map();
  }
}

/**
 * The cache, or null when the CLI lists a model it was not taken for. A new
 * model can come with changes to the others (a CLI or catalog update), so
 * everything is asked again rather than the new model alone.
 */
export function cacheForListedModels(
  cache: ContextWindowCache | null,
  listed: string[],
): ContextWindowCache | null {
  if (!cache) return null;
  return listed.every((id) => cache.models.includes(id)) ? cache : null;
}

/**
 * Write the cache. An answer the file holds is never dropped: one the new
 * cache does not repeat moves to `earlier`, so it stays the last answer.
 */
export function writeContextWindowCache(cache: ContextWindowCache): void {
  try {
    const file = dataFilePath("context-windows.json");
    mkdirSync(dirname(file), { recursive: true });
    const earlier: Record<string, number | null> = {};
    for (const [id, window] of readLastContextWindows()) {
      if (!(id in cache.windows)) earlier[id] = window;
    }
    const written: ContextWindowCache = { ...cache, earlier };
    // Whole file or nothing: two OpenCode servers can write it at once.
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(written, null, 2));
    renameSync(temp, file);
  } catch {
    // Without the file the windows are asked again next time.
  }
}
