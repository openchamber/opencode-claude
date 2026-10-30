/**
 * OpenCode meta-requests (session title, compaction/summary, generation) that
 * must not run as a full Claude Code agent turn, and what the plugin reads
 * from OpenCode's system prompt. The kind comes from the plugin's
 * `model.request` hook (proxy.ts resolveMetaKind), never from the text.
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

/**
 * OpenCode's system prompt: the request's first message. OpenCode 2.0.19 and
 * later join the system parts into that one message (@opencode/ai
 * protocols/openai-chat.ts lowerMessages) and send a system update
 * mid-conversation as user text.
 */
export function metaSystemPrompt(messages: MessageLike[]): string {
  const first = messages[0];
  return first?.role === "system" ? extractTextContent(first.content) : "";
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
  const heading = /^# Code Mode[\t ]*$/m.exec(system);
  if (!heading) return "";
  const rest = system.slice(heading.index);
  // "## Code Mode tools (call only inside `execute`)" from OpenCode 2.2.1.
  const toolsHeading = /^## (?:Available tools|Code Mode tools\b[^\r\n]*)[\t ]*$/m.exec(rest);
  if (!toolsHeading) return "";

  // OpenCode renders namespace/tool listings as one block, separated from
  // subsequent instructions by a blank line. A level-one heading alone is
  // not a boundary: date, environment, and skills need not have headings.
  // The date and the environment always follow the catalog (OpenCode 2.0.19
  // and later, session/context.ts), so a boundary is always there.
  const afterHeading = toolsHeading.index + toolsHeading[0].length;
  const leadingWhitespace = /^(?:[\t ]*\n)+/.exec(rest.slice(afterHeading));
  const catalogStart = afterHeading + (leadingWhitespace?.[0].length ?? 0);
  const catalog = rest.slice(catalogStart);
  if (!/^- /m.test(catalog.split("\n", 1)[0])) return "";
  const boundary = /\n[\t ]*\n|\n#{1,6} /.exec(catalog)!;
  return rest.slice(0, catalogStart + boundary.index).trim();
}

const SKILLS_INTRO = "Skills provide specialized instructions and workflows for specific tasks.";

/**
 * OpenCode lists its skills only in the system prompt, which the plugin
 * otherwise doesn't forward. Without the list Claude has the skill tool but
 * no ids to pass it. Returns the skills block as OpenCode rendered it
 * (skill/instructions.ts): its intro through `</available_skills>`. With no
 * skill OpenCode 2.0.19 and later leave the block out (its section reads as
 * removed), never render the "no skills" line in the system prompt.
 */
export function skillsCatalog(messages: MessageLike[]): string {
  const system = metaSystemPrompt(messages);
  const start = system.indexOf(SKILLS_INTRO);
  if (start < 0) return "";
  const rest = system.slice(start);
  const listEnd = rest.indexOf("</available_skills>");
  if (listEnd >= 0) return rest.slice(0, listEnd + "</available_skills>".length).trim();
  return "";
}

/**
 * How OpenCode's own system prompt opens for a Claude model (session/runner/
 * prompt, 2.0.19 and later). Its other stock prompts ("You are OpenCode",
 * "You are opencode", plugin/optimize.ts) go only to models whose id names
 * kimi, trinity or muse, never to the plugin's.
 */
const STOCK_AGENT_PROMPT = /^\s*You are an AI agent running in OpenCode\b/;
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
