/**
 * Large live tool results are cut to a short head and tail with a note on
 * how much was dropped: inlined in full, they are re-read from the cache on
 * every later call of the chat. With an output store the full text stays in
 * memory for a while and the note says how to read the middle with
 * `output_slice`. Disable with OPENCODE_CLAUDE_TOOL_OUTPUT_CHARS=0.
 */
import { mcpToolName } from "./host.js";
import {
  OUTPUT_SLICE_TOOL,
  OUTPUT_TTL_MINUTES,
  RERUN_HINT,
  type OutputStore,
} from "./output-store.js";

/** Shell dumps in measured sessions clustered around 11–20k chars. */
const DEFAULT_MAX_CHARS = 8_000;
const HEAD_CHARS = 400;
const TAIL_CHARS = 2_000;
/** Below this the note (a few hundred chars) would save next to nothing. */
const MIN_DROPPED_CHARS = 1_000;

function maxCharsFromEnv(): number {
  const raw = process.env.OPENCODE_CLAUDE_TOOL_OUTPUT_CHARS;
  const parsed = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_CHARS;
}

/**
 * `text` as Claude receives it as a tool result: unchanged when it fits,
 * otherwise its head and tail with a note on the dropped middle.
 */
export function cutLargeOutput(
  toolName: string,
  text: string,
  store: OutputStore | null,
  maxChars: number = maxCharsFromEnv(),
): string {
  // A read result is a file already on disk, and cutting it would hide the
  // part Claude asked for; it narrows the read with offset/limit itself.
  if (toolName === "read") return text;
  const dropped = text.length - HEAD_CHARS - TAIL_CHARS;
  if (maxChars <= 0 || text.length <= maxChars || dropped < MIN_DROPPED_CHARS) return text;
  const id = store?.put(text);
  return [
    `[output cut; ${text.length} chars, ${dropped} chars of the middle dropped]`,
    ...(id ? [`output id: ${id}`] : []),
    "head:",
    text.slice(0, HEAD_CHARS),
    "tail:",
    text.slice(-TAIL_CHARS),
    id
      ? `To read the middle, call ${mcpToolName(OUTPUT_SLICE_TOOL)}(id="${id}", offset=${HEAD_CHARS}). It is kept in memory for about ${OUTPUT_TTL_MINUTES} minutes; after that, ${RERUN_HINT}.`
      : `The middle is not kept. To see it, ${RERUN_HINT}.`,
  ].join("\n");
}
