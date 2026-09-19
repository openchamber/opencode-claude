import { metaSystemPrompt } from "./request-kind.js";

type MessageLike = { role?: string; content?: unknown };

const ENV_MARKER = "You are powered by the model named";
const STOCK_BASE_PROMPT = /^You are (OpenCode|opencode)\b/;

/** OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT=0 turns forwarding off. */
export function systemContextForwardingEnabled(): boolean {
  const raw = (process.env.OPENCODE_CLAUDE_FORWARD_SYSTEM_CONTEXT ?? "")
    .trim()
    .toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

/**
 * The Claude Code preset replaces OpenCode's system prompt, which also drops
 * the parts that are user configuration rather than OpenCode boilerplate: a
 * custom agent prompt (the agent's persona and rules), `instructions` files
 * and AGENTS.md, MCP server instructions and the available-skills list
 * (#6). Recover those so they can be appended to the preset. OpenCode's
 * stock base prompt and its <env> block are skipped; Claude Code supplies
 * its own equivalents.
 */
export function openCodeSystemContext(messages: MessageLike[]): string {
  const system = metaSystemPrompt(messages).trim();
  if (!system) return "";

  const envAt = system.indexOf(ENV_MARKER);
  let head = envAt >= 0 ? system.slice(0, envAt).trim() : "";
  let rest = envAt >= 0 ? system.slice(envAt) : system;
  if (STOCK_BASE_PROMPT.test(head)) head = "";
  const envEnd = rest.indexOf("</env>");
  if (envAt >= 0 && envEnd >= 0) rest = rest.slice(envEnd + "</env>".length);
  else if (STOCK_BASE_PROMPT.test(rest)) rest = "";
  rest = rest.trim();

  const parts: string[] = [];
  if (head) {
    parts.push(
      `# Agent role (from the OpenCode agent configuration; this defines who you are for this session and takes precedence over the generic role above)\n\n${head}`,
    );
  }
  if (rest) {
    parts.push(
      `# OpenCode context (user instructions, MCP notes, available skills)\n\n${rest}`,
    );
  }
  return parts.join("\n\n");
}
