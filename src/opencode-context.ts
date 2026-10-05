/**
 * Parts of OpenCode's system prompt that are the user's own setup rather
 * than OpenCode's boilerplate: project instruction files and MCP server
 * notes. The rest of that prompt (its stock prompt, model identity, date and
 * environment) is not forwarded; Claude Code brings its own.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { metaSystemPrompt } from "./request-kind.js";

type MessageLike = { role?: string; content?: unknown };

const INSTRUCTIONS_FROM = /^Instructions from: (.+?)[\t ]*\r?$/gm;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Directories Claude Code searches for project instruction files: cwd and its parents. */
function projectDirs(cwd: string): Set<string> {
  const dirs = new Set<string>();
  let dir = realPath(cwd);
  for (;;) {
    dirs.add(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Claude Code (2.1.28x) loads a project's AGENTS.md itself where the project
 * has no CLAUDE.md (its instructionFiles setting, "claude-md-or-agents-md"
 * by default), from the same places it reads CLAUDE.md. Those are its call.
 */
function claudeCodeReadsAgentsMd(path: string, dirs: Set<string>): boolean {
  const real = realPath(path);
  const { base } = parse(real);
  if (base !== "AGENTS.md") return false;
  const dir = dirname(real);
  return dirs.has(dir) || (parse(dir).base === ".claude" && dirs.has(dirname(dir)));
}

/** CLAUDE.md files Claude Code loads itself for this working directory. */
function claudeMdFiles(cwd: string): string[] {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const files = [join(configDir, "CLAUDE.md")];
  let dir = cwd;
  const { root } = parse(cwd);
  for (;;) {
    files.push(join(dir, "CLAUDE.md"), join(dir, "CLAUDE.local.md"), join(dir, ".claude", "CLAUDE.md"));
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files;
}

/** Claude Code follows `@path` imports from a CLAUDE.md up to four hops deep. */
const IMPORT_DEPTH = 4;
/** An `@path` import: at the start of a line or after whitespace, `\ ` keeps a space. */
const IMPORT = /(?<=^|\s)@((?:\\ |\S)+)/g;

/** Text without Markdown code spans and fenced blocks, where imports aren't parsed. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`\n]*`/g, "");
}

/** Files a CLAUDE.md imports: `~/` is the home directory, relative paths are from the file. */
function importsOf(file: string, text: string): string[] {
  const out: string[] = [];
  for (const match of stripCode(text).matchAll(IMPORT)) {
    let target = match[1]!.replace(/\\ /g, " ");
    if (target === "~" || target.startsWith("~/") || target.startsWith("~\\")) {
      target = join(homedir(), target.slice(1));
    }
    out.push(isAbsolute(target) ? target : join(dirname(file), target));
  }
  return out;
}

/**
 * The CLAUDE.md files plus everything their `@path` imports pull in, the way
 * Claude Code expands them (nested, at most IMPORT_DEPTH hops, each file once).
 */
function withImports(files: string[]): string[] {
  const out = [...files];
  const seen = new Set(files.map(realPath));
  const walk = (file: string, depth: number) => {
    if (depth > IMPORT_DEPTH) return;
    const text = readText(file);
    if (!text) return;
    for (const target of importsOf(file, text)) {
      const real = realPath(target);
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(target);
      walk(target, depth + 1);
    }
  };
  for (const file of files) walk(file, 1);
  return out;
}

/**
 * OpenCode's instruction files that Claude Code doesn't load itself (the
 * global ~/.config/opencode/AGENTS.md, configured `instructions`) as
 * "Instructions from: <path>" blocks, the way OpenCode renders them.
 * A file is read from disk and forwarded only when its text is in OpenCode's
 * prompt, so it is exactly what OpenCode loaded. Files Claude Code already
 * reads as CLAUDE.md (the same file through a symlink or an `@path` import,
 * or the same text) are skipped so the rules don't arrive twice.
 */
export function openCodeInstructionFiles(messages: MessageLike[], cwd: string): string {
  const system = metaSystemPrompt(messages);
  const loaded = withImports(claudeMdFiles(cwd));
  const loadedPaths = new Set(loaded.map(realPath));
  const loadedTexts = new Set(
    loaded.map((file) => readText(file)?.trim()).filter((text): text is string => !!text),
  );
  const dirs = projectDirs(cwd);
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const match of system.matchAll(INSTRUCTIONS_FROM)) {
    const path = match[1]!;
    const real = realPath(path);
    if (seen.has(real)) continue;
    seen.add(real);
    const text = readText(path)?.trim();
    if (!text || !system.includes(text.slice(0, 200))) continue;
    if (loadedPaths.has(real) || loadedTexts.has(text)) continue;
    if (claudeCodeReadsAgentsMd(path, dirs)) continue;
    blocks.push(`Instructions from: ${path}\n${text}`);
  }
  return blocks.join("\n\n");
}

/** OpenCode's `<mcp_instructions>` block: what MCP servers say about their tools. */
export function mcpInstructions(messages: MessageLike[]): string {
  const system = metaSystemPrompt(messages);
  const start = system.indexOf("<mcp_instructions>");
  if (start < 0) return "";
  const end = system.indexOf("</mcp_instructions>", start);
  if (end < 0) return "";
  return system.slice(start, end + "</mcp_instructions>".length).trim();
}
