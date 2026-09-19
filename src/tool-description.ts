/**
 * Claude Code truncates MCP tool descriptions at 2048 characters.
 * OpenCode appends the list of subagents to the END of its task tool
 * description, after ~2300 characters of guidance, so Claude never sees
 * which subagent_type values exist. Move the list to the front: the cut
 * then falls on the tail of the generic guidance instead.
 */
export const CLAUDE_TOOL_DESCRIPTION_LIMIT = 2048;

const AGENT_LIST_MARKER =
  "Available agent types and the tools they have access to:";

export function fitToolDescription(description: string): string {
  if (description.length <= CLAUDE_TOOL_DESCRIPTION_LIMIT) return description;
  const at = description.indexOf(AGENT_LIST_MARKER);
  if (at <= 0) return description;
  const agents = description.slice(at).trim();
  const guidance = description.slice(0, at).trim();
  return guidance ? `${agents}\n\n${guidance}` : agents;
}
