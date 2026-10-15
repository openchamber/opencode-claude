/**
 * In-memory store for tool outputs that were cut before reaching Claude, so
 * the model can read the dropped middle with `output_slice` instead of
 * re-running the command. Nothing touches disk.
 *
 * Memory is bounded: the retained total never exceeds `maxBytes`, a single
 * output above `maxEntryBytes` is not kept, and entries idle longer than
 * `ttlMs` are dropped. Expiry runs lazily on every put/slice, so there are no
 * timers to keep the process alive.
 */
import { createHash } from "node:crypto";
import { mcpToolName } from "./host.js";

export const OUTPUT_SLICE_TOOL = "output_slice";

const DEFAULT_STORE_MB = 16;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
export const OUTPUT_TTL_MINUTES = 30;
/** Largest slice returned per call; bigger reads would re-bloat the context. */
export const MAX_SLICE_CHARS = 8_000;

/** What to do once the full output is gone. */
export const RERUN_HINT = "re-run the command narrowed (grep, head, sed -n)";

type Entry = { text: string; bytes: number; lastUsed: number };

export type OutputStoreOptions = {
  maxBytes: number;
  maxEntryBytes?: number;
  ttlMs?: number;
  now?: () => number;
};

export type SliceResult =
  | { ok: true; text: string; offset: number; end: number; total: number }
  | { ok: false; reason: string };

/** Worst case for a JS string held as UTF-16. */
function sizeOf(text: string): number {
  return text.length * 2;
}

export class OutputStore {
  // Map iteration order is insertion order; touching an entry re-inserts it,
  // so the first key is always the least recently used.
  private readonly entries = new Map<string, Entry>();
  private total = 0;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: OutputStoreOptions) {
    this.maxBytes = options.maxBytes;
    this.maxEntryBytes = Math.min(options.maxEntryBytes ?? MAX_ENTRY_BYTES, options.maxBytes);
    this.ttlMs = options.ttlMs ?? OUTPUT_TTL_MINUTES * 60_000;
    this.now = options.now ?? Date.now;
  }

  get bytes(): number {
    return this.total;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Keep `text` and return its id, or undefined when it is too large to keep. */
  put(text: string): string | undefined {
    this.expire();
    const bytes = sizeOf(text);
    if (bytes > this.maxEntryBytes) return undefined;
    const id = `o${createHash("sha1").update(text).digest("hex").slice(0, 12)}`;
    const existing = this.entries.get(id);
    if (existing) {
      this.touch(id, existing);
      return id;
    }
    while (this.total + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.entries.set(id, { text, bytes, lastUsed: this.now() });
    this.total += bytes;
    return id;
  }

  slice(id: string, offset = 0, limit = MAX_SLICE_CHARS): SliceResult {
    this.expire();
    const entry = this.entries.get(id);
    if (!entry) {
      return {
        ok: false,
        reason: `output ${id} is no longer available (expired or evicted); ${RERUN_HINT}`,
      };
    }
    this.touch(id, entry);
    const total = entry.text.length;
    const start = Math.min(Math.max(0, Math.floor(offset)), total);
    const size = Math.min(Math.max(1, Math.floor(limit)), MAX_SLICE_CHARS);
    const end = Math.min(start + size, total);
    return { ok: true, text: entry.text.slice(start, end), offset: start, end, total };
  }

  private touch(id: string, entry: Entry): void {
    entry.lastUsed = this.now();
    this.entries.delete(id);
    this.entries.set(id, entry);
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.total -= entry.bytes;
  }

  private expire(): void {
    const cutoff = this.now() - this.ttlMs;
    // LRU order means idle entries sit at the front; stop at the first fresh one.
    for (const [id, entry] of this.entries) {
      if (entry.lastUsed > cutoff) break;
      this.remove(id);
    }
  }
}

function storeBytesFromEnv(): number {
  const raw = process.env.OPENCODE_CLAUDE_OUTPUT_STORE_MB;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  const mb = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_STORE_MB;
  return Math.floor(mb * 1024 * 1024);
}

// On globalThis like the bridge pool: a turn that outlives a plugin reload
// keeps its output_slice handler from the old copy of this module, and
// must find the outputs the new copy cut for it.
const STORE_KEY = Symbol.for("@openchamber/opencode-claude/output-store/v1");

/**
 * The process-wide store, sized from OPENCODE_CLAUDE_OUTPUT_STORE_MB; null
 * when that is 0.
 */
export function sharedOutputStore(): OutputStore | null {
  if (storeBytesFromEnv() <= 0) return null;
  return ((globalThis as Record<symbol, unknown>)[STORE_KEY] ??= new OutputStore({
    maxBytes: storeBytesFromEnv(),
  })) as OutputStore;
}

export function formatSlice(id: string, result: SliceResult): string {
  if (!result.ok) return result.reason;
  const more =
    result.end < result.total
      ? `; next: ${mcpToolName(OUTPUT_SLICE_TOOL)}(id="${id}", offset=${result.end})`
      : "; end of output";
  return `[output ${id}: chars ${result.offset}-${result.end} of ${result.total}${more}]\n${result.text}`;
}
