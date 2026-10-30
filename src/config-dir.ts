/**
 * Claude Code config directory per project, so one OpenCode server can run
 * different projects on different Claude accounts. Claude Code keeps a login
 * per `CLAUDE_CONFIG_DIR`; the plugin's `configDirs` option maps project
 * folders to one:
 *
 *   { "configDirs": { "~/work": "~/.claude-work" } }
 *
 * The deepest matching folder wins. Unmapped projects use the server's own
 * `CLAUDE_CONFIG_DIR`, or ~/.claude.
 */
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** The config directory mapped to this project, or undefined for the default. */
export function configDirForDirectory(
  configDirs: unknown,
  directory: string,
): string | undefined {
  if (!configDirs || typeof configDirs !== "object" || !directory) return undefined;
  const project = resolve(directory);
  let best: { folder: string; configDir: string } | undefined;
  for (const [folder, configDir] of Object.entries(configDirs)) {
    if (typeof configDir !== "string" || !configDir.trim() || !folder.trim()) continue;
    const root = resolve(expandHome(folder.trim()));
    const inside = project === root || project.startsWith(root.endsWith(sep) ? root : root + sep);
    if (inside && (!best || root.length > best.folder.length)) {
      best = { folder: root, configDir: resolve(expandHome(configDir.trim())) };
    }
  }
  return best?.configDir;
}

/** Where Claude Code keeps its sessions and CLAUDE.md for this account. */
export function claudeConfigDir(configDir?: string): string {
  return configDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
