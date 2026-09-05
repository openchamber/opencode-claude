/**
 * Detect OpenCode meta-requests (session title, compaction/summary) that must
 * not run as a full Claude Code agent turn.
 */
import { extractTextContent } from "./prompt.js";

export type MetaRequestKind = "title" | "summary" | null;

type MessageLike = {
  role?: string;
  content?: unknown;
};

const OPENCODE_UPDATE_SUMMARY_PATTERN =
  /here is the conversation so far:\s*<conversation>[\s\S]*?<\/conversation>\s*here is the summary of the conversation before the <conversation> above:\s*<prior-summary>[\s\S]*?<\/prior-summary>\s*the <prior-summary> summarizes everything that happened before the <conversation>\. construct a new summary that combines both\.[\s\S]*?output exactly the markdown structure shown inside <template>/;

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
    OPENCODE_UPDATE_SUMMARY_PATTERN.test(user) ||
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
  return "";
}
