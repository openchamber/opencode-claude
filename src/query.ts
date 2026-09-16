/**
 * Thin wrapper around @anthropic-ai/claude-agent-sdk query()/interrupt.
 * Import failure is surfaced as unavailable — detect must not report ready.
 */
import { spawnSync } from "node:child_process";
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { isClaudeEffort, type ClaudeEffort } from "./constants.js";
import {
  assertClaudeWorkingDirectory,
  resolveClaudeCodeExecutable,
} from "./executable-path.js";
import { log } from "./log.js";

type SdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

let sdkModulePromise: Promise<SdkModule> | null = null;
let sdkLoadError: Error | null = null;
let sdkModule: SdkModule | null = null;

const ALLOWED_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
]);

const trimmedString = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function nonEmptyRecord(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value).length > 0 ? (value as Record<string, unknown>) : null;
}

export async function loadClaudeAgentSdk(): Promise<SdkModule> {
  if (sdkModule) return sdkModule;
  if (sdkLoadError) throw sdkLoadError;
  if (!sdkModulePromise) {
    sdkModulePromise = import("@anthropic-ai/claude-agent-sdk")
      .then((mod) => {
        sdkModule = mod;
        return mod;
      })
      .catch((error) => {
        sdkLoadError =
          error instanceof Error
            ? error
            : new Error(
                String(
                  (error as { message?: string })?.message ||
                    error ||
                    "Failed to load Claude Agent SDK",
                ),
              );
        sdkModulePromise = null;
        throw sdkLoadError;
      });
  }
  return sdkModulePromise;
}

export function resetClaudeAgentSdkCache(): void {
  sdkModule = null;
  sdkModulePromise = null;
  sdkLoadError = null;
}

export async function probeClaudeAgentSdk(): Promise<{
  available: boolean;
  error?: string;
}> {
  try {
    await loadClaudeAgentSdk();
    return { available: true };
  } catch (error) {
    return {
      available: false,
      error:
        error instanceof Error ? error.message : "Claude Agent SDK unavailable",
    };
  }
}

export function killProcessTree(
  pid: number | null | undefined,
  options: { signal?: NodeJS.Signals; force?: boolean } = {},
): void {
  if (!Number.isInteger(pid) || !pid || pid <= 0) return;
  const signal = options.signal || "SIGTERM";
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // best-effort
    }
    return;
  }

  const kill = (target: number, killSignal: NodeJS.Signals) => {
    try {
      process.kill(target, killSignal);
    } catch {
      // ignore
    }
  };

  kill(-pid, signal);
  kill(pid, signal);
  if (options.force) {
    kill(-pid, "SIGKILL");
    kill(pid, "SIGKILL");
  }
}

export type ClaudeQueryHandle = {
  stream: AsyncIterable<unknown>;
  interrupt: () => Promise<void>;
  close: () => void;
  getPid: () => number | null | undefined;
};

export type StartClaudeQueryParams = {
  prompt: string | AsyncIterable<unknown>;
  cwd: string;
  model?: string;
  resume?: string;
  permissionMode?: string;
  effort?: ClaudeEffort | string;
  systemPrompt?:
    | string
    | { type: "preset"; preset: "claude_code"; append?: string };
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: object,
  ) => Promise<object | null>;
  env?: Record<string, string | undefined>;
  includePartialMessages?: boolean;
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, object>;
  agent?: string;
  allowedTools?: string[];
  /** Disable Claude built-in tools so OpenCode owns tool execution. */
  tools?: string[] | { type: string; [key: string]: unknown };
  /** Redirect built-in tool names to OpenCode MCP tools. */
  toolAliases?: Record<string, string>;
  disallowedTools?: string[];
  skills?: string[] | "all";
  settingSources?: Array<"user" | "project" | "local">;
  pathToClaudeCodeExecutable?: string;
  /** Required when permissionMode is bypassPermissions. */
  allowDangerouslySkipPermissions?: boolean;
  /** Auto-compact long conversations (Claude Code default). */
  autoCompactEnabled?: boolean;
  /** Stop utility queries such as title generation after one model turn. */
  maxTurns?: number;
  /** Thinking config; defaults to adaptive when effort is set. */
  thinking?:
    | { type: "adaptive" }
    | { type: "enabled"; budgetTokens: number }
    | { type: "disabled" };
  queryImpl?: (mod: SdkModule) => unknown;
};

export async function startClaudeQuery(
  params: StartClaudeQueryParams,
): Promise<ClaudeQueryHandle> {
  const sdk = await loadClaudeAgentSdk();
  const queryFn =
    typeof params.queryImpl === "function"
      ? params.queryImpl(sdk)
      : (sdk as { query?: unknown }).query;

  if (typeof queryFn !== "function") {
    const error = new Error("Claude Agent SDK query() is unavailable") as Error & {
      code?: string;
      statusCode?: number;
    };
    error.code = "CLAUDE_SDK_UNAVAILABLE";
    error.statusCode = 503;
    throw error;
  }

  const env = buildClaudeCodeChildEnv(params.env || process.env);
  const cwd = assertClaudeWorkingDirectory(params.cwd);
  const pathToClaudeCodeExecutable =
    trimmedString(params.pathToClaudeCodeExecutable) ||
    resolveClaudeCodeExecutable({ env }) ||
    undefined;

  const options: Record<string, unknown> = {
    cwd,
    env,
    includePartialMessages: params.includePartialMessages !== false,
    settingSources: Array.isArray(params.settingSources)
      ? params.settingSources
      : ["user", "project", "local"],
  };

  if (pathToClaudeCodeExecutable) {
    options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
  }

  const model = trimmedString(params.model);
  if (model) options.model = model;

  const resume = trimmedString(params.resume);
  if (resume) options.resume = resume;

  const permissionMode = trimmedString(params.permissionMode);
  if (ALLOWED_PERMISSION_MODES.has(permissionMode)) {
    options.permissionMode = permissionMode;
  }
  if (
    params.allowDangerouslySkipPermissions === true &&
    permissionMode === "bypassPermissions"
  ) {
    options.allowDangerouslySkipPermissions = true;
  }

  const effort = trimmedString(params.effort);
  if (isClaudeEffort(effort)) options.effort = effort;

  if (params.thinking) {
    options.thinking = params.thinking;
  } else if (isClaudeEffort(effort)) {
    // Effort guides adaptive thinking depth on models that support it.
    options.thinking = { type: "adaptive" };
  }

  if (params.autoCompactEnabled !== false) {
    options.autoCompactEnabled = true;
  }

  if (Number.isInteger(params.maxTurns) && Number(params.maxTurns) > 0) {
    options.maxTurns = params.maxTurns;
  }

  if (typeof params.canUseTool === "function") {
    options.canUseTool = params.canUseTool;
  }

  const customSystemPrompt = trimmedString(params.systemPrompt);
  const presetSystemPrompt =
    typeof params.systemPrompt === "string"
      ? null
      : nonEmptyRecord(params.systemPrompt);
  if (customSystemPrompt) {
    options.systemPrompt = customSystemPrompt;
  } else if (
    presetSystemPrompt?.type === "preset" &&
    presetSystemPrompt.preset === "claude_code"
  ) {
    const systemPrompt: {
      type: "preset";
      preset: "claude_code";
      append?: string;
    } = { type: "preset", preset: "claude_code" };
    const append = trimmedString(presetSystemPrompt.append);
    if (append) systemPrompt.append = append;
    options.systemPrompt = systemPrompt;
  } else {
    options.systemPrompt = { type: "preset", preset: "claude_code" };
  }

  if (nonEmptyRecord(params.mcpServers)) options.mcpServers = params.mcpServers;
  if (nonEmptyRecord(params.agents)) options.agents = params.agents;

  const mainAgent = trimmedString(params.agent);
  if (mainAgent) options.agent = mainAgent;

  if (Array.isArray(params.allowedTools) && params.allowedTools.length > 0) {
    options.allowedTools = params.allowedTools.filter(
      (tool) => typeof tool === "string" && tool.trim(),
    );
  }

  if (Array.isArray(params.disallowedTools) && params.disallowedTools.length > 0) {
    options.disallowedTools = params.disallowedTools.filter(
      (tool) => typeof tool === "string" && tool.trim(),
    );
  }

  if (params.tools !== undefined) {
    options.tools = params.tools;
  }

  if (nonEmptyRecord(params.toolAliases)) {
    options.toolAliases = params.toolAliases;
  }

  if (params.skills === "all" || Array.isArray(params.skills)) {
    options.skills = params.skills;
  } else if (params.skills === undefined) {
    options.skills = "all";
  }

  log.info("[opencode-claude] starting Claude Agent SDK query", {
    model: options.model,
    effort: options.effort,
    resume: Boolean(resume),
    cwd,
  });

  let result: any;
  try {
    result = (queryFn as (input: { prompt: unknown; options: unknown }) => unknown)({
      prompt: params.prompt,
      options,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/spawn.*ENOTDIR/i.test(message)) {
      const wrapped = new Error(
        "Claude Code executable path is not spawnable (ENOTDIR).",
      ) as Error & { code?: string; statusCode?: number; cause?: unknown };
      wrapped.code = "CLAUDE_SPAWN_ENOTDIR";
      wrapped.statusCode = 503;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
  }

  let closed = false;
  const getPid = () =>
    result && typeof result === "object" && "pid" in result
      ? (result.pid as number | null | undefined)
      : null;

  const interrupt = async () => {
    if (result && typeof result.interrupt === "function") {
      try {
        await result.interrupt();
      } catch {
        // fall through to tree-kill
      }
    }
    killProcessTree(getPid(), { signal: "SIGTERM" });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (result && typeof result.close === "function") {
      result.close();
      return;
    }
    killProcessTree(getPid(), { signal: "SIGTERM", force: true });
    if (result && typeof result.return === "function") {
      try {
        Promise.resolve(result.return()).catch(() => {});
      } catch {
        // ignore
      }
    }
  };

  return { stream: result as AsyncIterable<unknown>, interrupt, close, getPid };
}
