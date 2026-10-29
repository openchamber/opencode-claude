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
  // "## Code Mode tools (call only inside `execute`)" from OpenCode 2.2.1.
  const toolsHeading = /^## (?:Available tools|Code Mode tools\b[^\r\n]*)[\t ]*\r?$/m.exec(rest);
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

const SKILLS_INTRO = "Skills provide specialized instructions and workflows for specific tasks.";

/**
 * OpenCode lists its skills only in the system prompt, which the plugin
 * otherwise doesn't forward. Without the list Claude has the skill tool but
 * no ids to pass it. Returns the skills block as OpenCode rendered it
 * (skill/instructions.ts): its intro through `</available_skills>`, or
 * through the "no skills" line.
 */
export function skillsCatalog(messages: MessageLike[]): string {
  const system = metaSystemPrompt(messages);
  const start = system.indexOf(SKILLS_INTRO);
  if (start < 0) return "";
  const rest = system.slice(start);
  const listEnd = rest.indexOf("</available_skills>");
  if (listEnd >= 0) return rest.slice(0, listEnd + "</available_skills>".length).trim();
  const none = rest.indexOf("No skills are currently available.");
  if (none >= 0) return rest.slice(0, none + "No skills are currently available.".length).trim();
  return "";
}

/** How OpenCode's own system prompts open (session/runner/prompt, plugin/system-prompt). */
const STOCK_AGENT_PROMPT = /^\s*You are (?:an AI agent running in OpenCode|OpenCode|opencode)\b/;
const MODEL_IDENTITY_HEADING = /^# Your Model[\t ]*\r?$/m;

/**
 * The prompt of a custom OpenCode agent (writer, a reviewer persona, ...).
 * OpenCode puts the agent's own prompt first, in place of its stock one,
 * and its identity plugin follows with "# Your Model". Everything before
 * that heading is the agent's prompt, unless it is one of OpenCode's stock
 * prompts (build, plan), which Claude doesn't need: Claude Code brings its
 * own. Without the heading the layout is unknown, so nothing is returned.
 */
export function customAgentPrompt(messages: MessageLike[]): string {
  const system = metaSystemPrompt(messages);
  const identity = MODEL_IDENTITY_HEADING.exec(system);
  if (!identity) return "";
  const head = system.slice(0, identity.index).trim();
  if (!head || STOCK_AGENT_PROMPT.test(head)) return "";
  return head;
}
