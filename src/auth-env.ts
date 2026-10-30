/**
 * Subscription-only child env for Claude Code (from OpenChamber harness).
 * Never log env values — this module only returns sanitized copies.
 */

/** Credential overrides removed so Claude Code uses its own login store. */
export const AUTH_OVERRIDE_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/**
 * MCP tool descriptions Claude Code sends to the model, in characters. The
 * CLI cuts them at 2048 (4096 from 2.1.296), and OpenCode and OpenChamber
 * tools run longer, so their closing instructions never reached Claude. A
 * value the user set wins.
 */
export const MCP_DESCRIPTION_LIMIT = 8192;

/**
 * Build a child-process env for Claude Code subscription mode.
 * Starts from process.env (or provided base), preserves PATH, then deletes
 * credential overrides so the CLI exclusively owns authentication.
 */
export function buildClaudeCodeChildEnv(
  baseEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env = { ...baseEnv };
  for (const key of AUTH_OVERRIDE_ENV_KEYS) {
    delete env[key];
  }
  if (!env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH?.trim()) {
    env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH = String(MCP_DESCRIPTION_LIMIT);
  }
  return env;
}
