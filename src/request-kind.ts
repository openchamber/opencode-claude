/**
 * Detect OpenCode meta-requests (session title, compaction/summary) that must
 * not run as a full Claude Code agent turn.
 */
import { extractTextContent } from "./prompt.js";

/**
 * `generate` is a stateless one-shot generation (OpenCode's
 * /api/experimental/generate): no session, no tools, no user context.
 */
export type MetaRequestKind = "title" | "summary" | "generate" | null;

type MessageLike = {
  role?: string;
  content?: unknown;
};

export function metaSystemPrompt(messages: MessageLike[]): string {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => extractTextContent(m.content))
    .join("\n");
}

function userText(messages: MessageLike[]): string {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => extractTextContent(m.content))
    .join("\n");
}

export function isTitleGenerationRequest(messages: MessageLike[]): boolean {
  const system = metaSystemPrompt(messages).toLowerCase();
  return (
    system.includes("title generator") ||
    system.includes("generate a short title") ||
    system.includes("generate a brief title") ||
    system.includes("output only a thread title")
  );
}

export function isSummaryGenerationRequest(messages: MessageLike[]): boolean {
  const system = metaSystemPrompt(messages).toLowerCase();
  if (
    system.includes("anchored context summarization") ||
    system.includes("summarizing, compacting, or merging context") ||
    system.includes("tasked with summarizing conversations") ||
    system.includes("write like a pull request description") ||
    system.includes("summarize what was done in this conversation")
  ) {
    return true;
  }

  const user = userText(messages).toLowerCase();
  return (
    user.includes(
      "this summary will be the only context available when the conversation continues",
    ) ||
    user.includes(
      "create a detailed summary for continuing this coding session",
    ) ||
    user.includes("anchored summary from the conversation history") ||
    user.includes("anchored summary below using the conversation history") ||
    user.includes("<previous-summary>")
  );
}

export function detectMetaRequestKind(
  messages: MessageLike[],
): MetaRequestKind {
  if (isTitleGenerationRequest(messages)) return "title";
  if (isSummaryGenerationRequest(messages)) return "summary";
  return null;
}

/** Namespace so meta requests never collide with live agent session state. */
export function requestKeyNamespace(kind: MetaRequestKind): string {
  if (kind === "title") return "title:";
  if (kind === "summary") return "summary:";
  if (kind === "generate") return "generate:";
  return "";
}

/**
 * OpenCode 2.x reaches some tools (MCP servers, OpenChamber's own tools) only
 * through its `execute` tool, and lists them in a "# Code Mode" section of its
 * system prompt. That prompt is not forwarded, so this one section is: it is
 * the tool catalog, not host identity. Later catalog changes arrive as
 * ordinary messages and pass through already.
 */
export function codeModeCatalog(messages: MessageLike[]): string {
  const system = metaSystemPrompt(messages);
  const heading = /^# Code Mode[\t ]*\r?$/m.exec(system);
  if (!heading) return "";
  const rest = system.slice(heading.index);
  const toolsHeading = /^## Available tools[\t ]*\r?$/m.exec(rest);
  if (!toolsHeading) return "";

  // OpenCode renders namespace/tool listings as one block, separated from
  // subsequent instructions by a blank line. A level-one heading alone is
  // not a boundary: date, environment, and skills need not have headings.
  const afterHeading = toolsHeading.index + toolsHeading[0].length;
  const leadingWhitespace = /^(?:[\t ]*\r?\n)+/.exec(rest.slice(afterHeading));
  const catalogStart = afterHeading + (leadingWhitespace?.[0].length ?? 0);
  const catalog = rest.slice(catalogStart);
  if (!/^- /m.test(catalog.split(/\r?\n/, 1)[0])) return "";
  const boundary = /\r?\n[\t ]*\r?\n|\r?\n#{1,6} /.exec(catalog);
  const end = catalogStart + (boundary ? boundary.index : catalog.length);
  return rest.slice(0, end).trim();
}
