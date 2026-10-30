/**
 * Live check of the Claude Code behaviour the plugin stands on, against the
 * installed `claude`. The test suite runs on one Claude Code simulator
 * (test/simulators/claude-code.ts), which keeps today's behaviour: a CLI
 * release that changes it leaves the suite green. This file asks the real CLI
 * instead, one check per property, each failing with what it breaks in the
 * plugin; the simulator is checked against it (test/simulators/BEHAVIOR.md).
 *
 * Run: bun test/cli-contract-live.ts
 * - CLAUDE_CONTRACT_CLI=<path>: the CLI to check (default: the one the plugin finds);
 * - CLAUDE_CONTRACT_KEEP=1: keep the temp folder (profile, transcripts, requests) after a pass.
 *
 * Not part of `bun run test`: it needs an installed CLI. It needs no sign-in
 * and spends no plan limits: the model is a local stub (the CLI gets its
 * address and a dummy key), whose answers are fixed and which keeps the body
 * of every request. So it checks files, events, copies and what reaches the
 * model; not a real cache hit, plan limits or how a model reads the history.
 *
 * Isolation: a profile (CLAUDE_CONFIG_DIR) and working folders of its own in
 * a temp folder; the environment without the user's credentials and provider
 * choice; no user settings, hooks or MCP servers; the SDK is called directly
 * (the plugin's startClaudeQuery would drop the dummy key); every CLI process
 * is killed at the end.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@anthropic-ai/claude-agent-sdk";

import { pluginModule } from "./simulators/world.ts";

// The plugin's modules of the tree under test (OPENCODE_CLAUDE_PLUGIN_DIR, default this checkout).
const { resolveClaudeCodeExecutable } = await pluginModule("executable-path");
const { classifyClaudeFailure, resultErrorText } = await pluginModule("failure");
const { FIRST_EPOCH, TRANSCRIPT_START_NAME, transcriptName, userRecordName } = await pluginModule("names");
const { recordsOneByOne } = await pluginModule("prompt");
const { LOST_SESSION_PATTERN } = await pluginModule("proxy");
const { isTurnResult, killProcessTree } = await pluginModule("query");
const { isPromptRecord, parseTranscript } = await pluginModule("turn-point");

/** One line of a Claude Code transcript, with its position in the file (as turn-point.ts reads it). */
type TranscriptRecord = {
  line: number;
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  attachment?: { type?: string; source_uuid?: string };
  toolUseResult?: unknown;
  isCompactSummary?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  queueTranscriptOnly?: boolean;
  message?: { role?: string; content?: unknown };
};

// --- the place

const root = mkdtempSync(join(tmpdir(), "cli-contract-"));
const profile = join(root, "profile");
const work = join(root, "work");
const otherWork = join(root, "work-other");
for (const dir of [profile, work, otherWork]) mkdirSync(dir, { recursive: true });
const projectsDir = join(profile, "projects");

// --- the model: a local stub of the Messages API

/** What the stub answers to the next model request; plain text when none is queued. */
type Reply =
  | { kind: "text"; text?: string; inputTokens?: number }
  | { kind: "tool"; id: string; name: string; input?: Record<string, unknown> }
  | { kind: "error"; status: number; type: string; message: string };

const replies: Reply[] = [];
/** What the stub counts for `count_tokens`: the size a check makes the CLI believe its context has. */
let countedTokens = 100;
/** Every model request the CLI made, in order. */
const requests: Array<{ body: any; reply: Reply }> = [];

function readBody(request: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function answer(response: ServerResponse, body: any, reply: Reply, n: number): void {
  if (reply.kind === "error") {
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: reply.type, message: reply.message } }));
    return;
  }
  const usage = { input_tokens: reply.kind === "text" ? (reply.inputTokens ?? 100) : 100, output_tokens: 0 };
  const message = { id: `msg_stub_${n}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage };
  const block = reply.kind === "tool"
    ? { type: "tool_use", id: reply.id, name: reply.name, input: {} }
    : { type: "text", text: "" };
  const delta = reply.kind === "tool"
    ? { type: "input_json_delta", partial_json: JSON.stringify(reply.input ?? {}) }
    : { type: "text_delta", text: reply.text ?? `ANSWER_${n}` };
  const stopReason = reply.kind === "tool" ? "tool_use" : "end_turn";
  if (!body.stream) {
    const content = reply.kind === "tool" ? [{ ...block, input: reply.input ?? {} }] : [{ type: "text", text: reply.text ?? `ANSWER_${n}` }];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...message, content, stop_reason: stopReason, usage: { ...usage, output_tokens: 2 } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const event = (type: string, fields: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  event("message_start", { message });
  event("content_block_start", { index: 0, content_block: block });
  event("content_block_delta", { index: 0, delta });
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } });
  event("message_stop", {});
  response.end();
}

const stub = createServer(async (request, response) => {
  const body = await readBody(request);
  if (request.url?.includes("count_tokens")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ input_tokens: countedTokens }));
    return;
  }
  const reply = replies.shift() ?? { kind: "text" };
  requests.push({ body, reply });
  answer(response, body, reply, requests.length);
});
await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
const stubPort = (stub.address() as { port: number }).port;

// --- the CLI

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined || /^(CLAUDE|ANTHROPIC|OPENCODE|OPENCHAMBER)/.test(key)) continue;
  env[key] = value;
}
Object.assign(env, {
  CLAUDE_CONFIG_DIR: profile,
  ANTHROPIC_API_KEY: "local-stub-only",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${stubPort}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  DISABLE_AUTOUPDATER: "1",
});

const cli = process.env.CLAUDE_CONTRACT_CLI?.trim() || (await resolveClaudeCodeExecutable({ env }));
if (!cli) {
  console.error("No Claude Code CLI found: install it, or name it with CLAUDE_CONTRACT_CLI.");
  process.exit(2);
}
const version = spawnSync(cli, ["--version"], { encoding: "utf8", env, windowsHide: true }).stdout.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? "unknown";
const sdkVersion = JSON.parse(readFileSync(join(import.meta.dir, "../node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "utf8")).version;

/** Every CLI process started, killed at the end. */
const children: ChildProcess[] = [];

type UserPrompt = {
  type: "user";
  message: { role: "user"; content: unknown };
  parent_tool_use_id: null;
  uuid?: string;
  shouldQuery?: false;
  priority?: "next";
};

const user = (content: unknown, uuid?: string, extra: Partial<UserPrompt> = {}): UserPrompt => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
  ...(uuid ? { uuid } : {}),
  ...extra,
});

/** One CLI run: its events, results, error, the model requests it made, how its process ended. */
type Run = {
  events: any[];
  results: any[];
  init?: any;
  error?: string;
  requests: Array<{ body: any; reply: Reply }>;
  exitCode: number | null;
  stderr: string;
};

type RunOptions = Record<string, unknown> & {
  /** Called with the CLI process as soon as it starts. */
  onChild?: (child: ChildProcess) => void;
  /** Called with every event of the run, as it is read. */
  onEvent?: (event: any) => void;
  /** Called with the SDK query as soon as it exists (to interrupt it). */
  onQuery?: (query: { interrupt(): Promise<void> }) => void;
  timeoutMs?: number;
};

const baseOptions = {
  cwd: work,
  env,
  pathToClaudeCodeExecutable: cli,
  model: "claude-haiku-4-5",
  systemPrompt: "Answer briefly.",
  settingSources: [],
  tools: [],
  skills: [],
  strictMcpConfig: true,
  settings: { autoCompactEnabled: false, disableClaudeAiConnectors: true },
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  thinking: { type: "disabled" },
  maxTurns: 4,
};

async function* streamOf(prompts: UserPrompt[]): AsyncGenerator<UserPrompt> {
  yield* prompts;
}

/**
 * The prompts as the plugin hands a turn's records to the CLI
 * (src/prompt.ts recordsOneByOne): a record without a turn that follows
 * another goes once the CLI confirmed that one. The CLI takes everything
 * waiting in its queue at once and joins consecutive records without a turn
 * into one, under the last one's uuid (check 5.1).
 */
function oneByOne(prompts: UserPrompt[]): { stream: AsyncGenerator<UserPrompt>; observe: (event: any) => void } {
  return recordsOneByOne(streamOf(prompts)) as {
    stream: AsyncGenerator<UserPrompt>;
    observe: (event: any) => void;
  };
}

async function run(prompt: UserPrompt[] | AsyncIterable<UserPrompt>, options: RunOptions = {}): Promise<Run> {
  const { onChild, onEvent, onQuery, timeoutMs = 90_000, ...rest } = options;
  const from = requests.length;
  let child: ChildProcess | undefined;
  let stderr = "";
  const query = sdk.query({
    prompt: (Array.isArray(prompt) ? streamOf(prompt) : prompt) as any,
    options: {
      ...baseOptions,
      ...rest,
      spawnClaudeCodeProcess(spawnOptions: any) {
        child = spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          signal: spawnOptions.signal,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(child);
        child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        onChild?.(child);
        return child as any;
      },
    } as any,
  });
  onQuery?.(query);
  const events: any[] = [];
  let error: string | undefined;
  const timer = setTimeout(() => query.close(), timeoutMs);
  try {
    for await (const event of query) {
      events.push(event);
      onEvent?.(event);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
    query.close();
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      child!.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
  return {
    events,
    results: events.filter((event) => event.type === "result"),
    init: events.find((event) => event.type === "system" && event.subtype === "init"),
    error,
    requests: requests.slice(from),
    exitCode: child?.exitCode ?? null,
    stderr,
  };
}

// --- transcripts

function fileOf(id: string): string | null {
  if (!existsSync(projectsDir)) return null;
  for (const dir of readdirSync(projectsDir)) {
    const candidate = join(projectsDir, dir, `${id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every file of this session id, in any project folder. */
function filesOf(id: string): string[] {
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir).map((dir) => join(projectsDir, dir, `${id}.jsonl`)).filter((file) => existsSync(file));
}

function textOf(id: string): string {
  const file = fileOf(id);
  return file ? readFileSync(file, "utf8") : "";
}

/** The transcript's records as the plugin reads them. */
function recordsOf(id: string): TranscriptRecord[] {
  return parseTranscript(textOf(id));
}

/** Every JSON line of the file, raw. */
function linesOf(id: string): any[] {
  return textOf(id)
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/** The texts of a request message, its blocks joined (tool results' texts too). */
function messageText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => (typeof block?.text === "string" ? block.text : Array.isArray(block?.content) ? block.content.map((part: any) => part?.text ?? "").join("\n") : typeof block?.content === "string" ? block.content : ""))
    .join("\n");
}

/** Every transcript file of the profile. */
function allFiles(): string[] {
  if (!existsSync(projectsDir)) return [];
  return readdirSync(projectsDir).flatMap((dir) => readdirSync(join(projectsDir, dir)).filter((file) => file.endsWith(".jsonl")).map((file) => join(dir, file)));
}

/** The uuids from a record back to the start of its chain (`parentUuid`, or `logicalParentUuid` across a compaction boundary). */
function chainTo(id: string, uuid: string): string[] {
  const records = recordsOf(id);
  const byUuid = new Map(records.map((r) => [r.uuid!, r]));
  const chain: string[] = [];
  for (let r = byUuid.get(uuid); r && !chain.includes(r.uuid!); r = byUuid.get(r.parentUuid || r.logicalParentUuid || "")) chain.push(r.uuid!);
  return chain;
}

/** The leaf chain: the last record written and its ancestors, where the CLI resumes and copies. */
function leafChain(id: string): string[] {
  const last = recordsOf(id).at(-1)?.uuid;
  return last ? chainTo(id, last) : [];
}

/** The failure texts a run hands the plugin: the thrown error, error results, API error answers. */
function failureTexts(result: Run): string[] {
  const texts = [
    result.error,
    ...result.results.filter((r) => r.is_error === true).map((r) => resultErrorText(r)),
    ...result.events.filter((e) => e.type === "assistant" && e.error).map((e) => messageText(e.message)),
  ];
  return texts.filter((text): text is string => typeof text === "string" && text.trim() !== "");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The MCP tool a turn parks on (`mcp__probe__lookup`); `answer` decides when, and whether, it answers. */
const TOOL = "mcp__probe__lookup";
function probeTool(answer: (extra: any) => Promise<string>) {
  const tool = sdk.tool("lookup", "Return a value", {}, async (_args: unknown, extra: unknown) => ({
    content: [{ type: "text" as const, text: await answer(extra) }],
  }));
  return { mcpServers: { probe: sdk.createSdkMcpServer({ name: "probe", tools: [tool] }) }, allowedTools: [TOOL] };
}

/** A turn's input kept open, as the plugin keeps it: the first prompts, then what `push` adds, until `end`. */
function openInput(first: UserPrompt[]) {
  const queue: UserPrompt[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  async function* stream(): AsyncGenerator<UserPrompt> {
    yield* first;
    while (!done) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return {
    stream: stream(),
    push(prompt: UserPrompt) {
      queue.push(prompt);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
  };
}

/** The end of the transcript: its last record, where a plain next turn resumes. */
function endOf(id: string): string {
  const last = recordsOf(id).at(-1)?.uuid;
  if (!last) throw new Error(`the transcript ${id} holds no record`);
  return last;
}

// --- checks

type Outcome = { n: number; title: string; status: "pass" | "fail" | "not reproduced"; detail: string };
const outcomes: Outcome[] = [];

/** A check's verdict on a race it could not bring about: written down, not a breach. */
class NotReproduced extends Error {}

function expect(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(what);
}

/**
 * Run one check. `breaks` says what stops working in the plugin when the
 * property is gone; a failure reads "CLI x.y.z: <what was seen> — <breaks>".
 */
async function check(n: number, title: string, breaks: string, body: () => Promise<string | void>): Promise<void> {
  try {
    const detail = (await body()) ?? "";
    outcomes.push({ n, title, status: "pass", detail });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof NotReproduced) outcomes.push({ n, title, status: "not reproduced", detail: message });
    else outcomes.push({ n, title, status: "fail", detail: `CLI ${version}: ${message} — ${breaks}` });
  } finally {
    // A reply a check queued and no request took must not answer the next check.
    replies.length = 0;
  }
  const last = outcomes.at(-1)!;
  console.log(`${last.status === "pass" ? "ok  " : last.status === "fail" ? "FAIL" : "race"} ${n}. ${title}${last.detail ? `\n       ${last.detail}` : ""}`);
}

const short = (run: Run) =>
  `results ${JSON.stringify(run.results.map((r) => ({ subtype: r.subtype, is_error: r.is_error, num_turns: r.num_turns })))}, exit ${run.exitCode}${run.error ? `, error "${run.error.slice(0, 160)}"` : ""}`;

// --- the session most checks build on

/** A chat's first transcript, named the way the plugin names it (uuid v5). */
const S = transcriptName("ses_contract", FIRST_EPOCH, 1);
const Q1 = userRecordName("msg_contract_q1", 1);
const Q2 = userRecordName("msg_contract_q2", 1);
const Q3 = userRecordName("msg_contract_q3", 1);

console.log(`Claude Code ${version} (${cli}), Agent SDK ${sdkVersion}; model stub on port ${stubPort}; files in ${root}`);

try {
  await check(1, "sessionId names the file of a new session", "a chat's transcript is not found by its name: every turn goes as text", async () => {
    const result = await run([user("Question one", Q1)], { sessionId: S });
    expect(result.init?.session_id === S, `init.session_id is ${result.init?.session_id}, not the sessionId ${S}; ${short(result)}`);
    expect(fileOf(S), `no file ${S}.jsonl after the turn; ${short(result)}`);
  });

  await check(2, "the uuid of a user message becomes its record's uuid", "the plugin cannot find its own records: every turn goes as text, retries are not told apart", async () => {
    const record = recordsOf(S).find((r) => r.uuid === Q1);
    expect(record?.type === "user", `no user record with uuid ${Q1} in ${S}`);
    const second = await run([user("Question two", Q2)], { resume: S, resumeSessionAt: endOf(S) });
    expect(recordsOf(S).some((r) => r.uuid === Q2 && r.parentUuid !== null), `the resumed turn wrote no record ${Q2}; ${short(second)}`);
  });

  await check(3, "a sessionId whose file exists is refused, the file untouched", "a new transcript could be written over an old one: the plugin's free name is no protection", async () => {
    const before = textOf(S);
    const result = await run([user("Question again", userRecordName("msg_contract_again", 1))], { sessionId: S });
    expect(textOf(S) === before, `the file ${S} changed; ${short(result)}`);
    const answered = result.results.some((r) => r.is_error !== true && r.num_turns > 0);
    expect(!answered, `a turn ran on a session id in use; ${short(result)}`);
    return `refused: ${short(result)}${result.stderr ? `; stderr "${result.stderr.trim().slice(0, 120)}"` : ""}`;
  });

  await check(4, "resume from another working folder continues the same file", "a chat whose folder changed loses its transcript: the turn goes as text", async () => {
    const result = await run([user("Question three", Q3)], { resume: S, resumeSessionAt: endOf(S), cwd: otherWork });
    expect(filesOf(S).length === 1, `${filesOf(S).length} files named ${S}; ${short(result)}`);
    expect(recordsOf(S).some((r) => r.uuid === Q3), `the turn from another folder wrote no record ${Q3} into ${fileOf(S)}; ${short(result)}`);
  });

  // Records without a turn: a new transcript starts with the blank record,
  // then two records of what was missed, then the question, in one input,
  // each record after the one before it is written.
  const N = transcriptName("ses_contract_noturn", FIRST_EPOCH, 1);
  const missedA = userRecordName("msg_contract_missed_a", 1);
  const missedB = userRecordName("msg_contract_missed_b", 1);
  const askN = userRecordName("msg_contract_n1", 1);
  const firstInput = oneByOne([
    user(" ", TRANSCRIPT_START_NAME, { shouldQuery: false }),
    user("MISSED_A text", missedA, { shouldQuery: false }),
    user("MISSED_B text", missedB, { shouldQuery: false }),
    user("QUESTION_N text", askN),
  ]);
  const first = await run(firstInput.stream, { sessionId: N, onEvent: firstInput.observe });

  await check(5, "shouldQuery: false writes a record without a model call, answered by an empty result; the turn goes on after it", "missed messages and checkpoints cannot be written ahead of a question under their names, or the proxy ends the turn at their result", async () => {
    for (const uuid of [missedA, missedB]) {
      const line = linesOf(N).find((l) => l.uuid === uuid);
      expect(line?.type === "user" && line.queueTranscriptOnly === true, `the record ${uuid} is ${JSON.stringify(line && { type: line.type, queueTranscriptOnly: line.queueTranscriptOnly })}, not a user record with queueTranscriptOnly`);
    }
    expect(first.requests.length === 1, `${first.requests.length} model requests for three records without a turn and one question`);
    const last = first.results.at(-1);
    expect(last && isTurnResult(last) && last.num_turns > 0 && last.is_error !== true, `the run did not end with the question's turn result; ${short(first)}`);
    const before = first.results.slice(0, -1);
    expect(before.every((r) => r.num_turns === 0 && r.is_error !== true && !isTurnResult(r)), `a result before the turn's is not an empty one (num_turns 0, no error); ${short(first)}`);
    expect(before.length === 3, `${before.length} empty results for three records without a turn written one by one; ${short(first)}`);
    const named = before.map((r) => r.user_message_uuid);
    expect(JSON.stringify(named) === JSON.stringify([TRANSCRIPT_START_NAME, missedA, missedB]), `the empty results name ${JSON.stringify(named)}, not each its record: the plugin cannot tell which record the CLI wrote`);
  });

  await check(5.1, "records without a turn sent at once may be joined under the last one's uuid; the question never", "a record whose name the CLI dropped is not found: the plugin's lookup must go back to the last name it finds", async () => {
    const [a, b, c, q] = ["msg_contract_burst_a", "msg_contract_burst_b", "msg_contract_burst_c", "msg_contract_burst_q"].map((id) => userRecordName(id, 1)) as [string, string, string, string];
    const from = linesOf(N).length;
    const burst = await run(
      [
        user("BURST_A text", a, { shouldQuery: false }),
        user("BURST_B text", b, { shouldQuery: false }),
        user("BURST_C text", c, { shouldQuery: false }),
        user("BURST_Q text", q),
      ],
      { resume: N, resumeSessionAt: endOf(N) },
    );
    const added = linesOf(N).slice(from).filter((l) => l.type === "user");
    const question = added.find((l) => l.uuid === q);
    expect(question && messageText(question.message) === "BURST_Q text", `the question is not a record of its own: ${JSON.stringify(added.map((l) => [l.uuid, messageText(l.message)]))}`);
    expect(added.some((l) => l.uuid === c), "the last record without a turn has no record under its name");
    const text = added.filter((l) => l.uuid !== q).map((l) => messageText(l.message)).join("\n");
    const at = ["BURST_A", "BURST_B", "BURST_C"].map((t) => text.indexOf(t));
    expect(at.every((i, k) => i >= 0 && text.lastIndexOf(["BURST_A", "BURST_B", "BURST_C"][k]!) === i) && at[0]! < at[1]! && at[1]! < at[2]!, `the texts are not each once and in order: ${JSON.stringify(text)}`);
    const names = added.filter((l) => l.uuid !== q).map((l) => [a, b, c].indexOf(l.uuid)).map((k) => "ABC"[k] ?? "?");
    return `sent at once, written as ${names.join(", ")} (${added.length - 1} record(s) for three); ${short(burst)}`;
  });

  await check(6, "records without a turn reach the model with the question, one user message", "what another model answered never reaches Claude, or reaches it out of order", async () => {
    const messages = first.requests[0]?.body.messages ?? [];
    const at = (needle: string) => messages.findIndex((m: any) => messageText(m).includes(needle));
    const where = ["MISSED_A text", "MISSED_B text", "QUESTION_N text"].map(at);
    expect(where.every((i) => i >= 0), `the request lacks a text: positions ${JSON.stringify(where)}`);
    expect(where[0] === where[1] && where[1] === where[2] && messages[where[0]!].role === "user", `the texts are in messages ${JSON.stringify(where)}, not one user message`);
    const text = messageText(messages[where[0]!]);
    expect(text.indexOf("MISSED_A") < text.indexOf("MISSED_B") && text.indexOf("MISSED_B") < text.indexOf("QUESTION_N"), "the texts are out of order");
  });

  await check(7, "a blank record without a turn starts the file and sends the model nothing", "a new transcript cannot start with the record a first message's retry resumes at, or the model sees it", async () => {
    const start = recordsOf(N).find((r) => r.uuid === TRANSCRIPT_START_NAME);
    expect(start?.type === "user" && start.parentUuid === null, `the start record is ${JSON.stringify(start && { type: start.type, parentUuid: start.parentUuid })}`);
    const blocks = (first.requests[0]?.body.messages ?? []).flatMap((m: any) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content));
    const blank = blocks.filter((b: any) => b.type === "text" && (!b.text.trim() || b.text.includes("(no content)")));
    expect(blank.length === 0, `the model got ${blank.length} blank or "(no content)" text block(s)`);
  });

  await check(8, "resume at a record without a turn adds no \"No response requested.\"", "every turn after a record without a turn (a checkpoint, a missed record) shows the model a fake answer", async () => {
    const note = userRecordName("msg_contract_note", 1);
    const alone = await run([user("NOTE text", note, { shouldQuery: false })], { resume: N, resumeSessionAt: endOf(N) });
    expect(alone.requests.length === 0, `a record without a turn alone made ${alone.requests.length} model request(s)`);
    expect(recordsOf(N).at(-1)?.uuid === note, `the record ${note} is not the end of the file; ${short(alone)}`);
    const next = await run([user("QUESTION_N2 text", userRecordName("msg_contract_n2", 1))], { resume: N, resumeSessionAt: note });
    const sent = JSON.stringify(next.requests.map((r) => r.body.messages));
    expect(next.requests.length === 1, `${next.requests.length} model requests; ${short(next)}`);
    expect(!sent.includes("No response requested"), "the model got \"No response requested.\"");
    expect(!linesOf(N).some((l) => l.type === "assistant" && JSON.stringify(l.message?.content ?? "").includes("No response requested")), "the file holds a \"No response requested.\" answer");
  });

  // The point and a retry, on S: Q1, Q2, Q3, each with its answer.
  const endOfQ1 = recordsOf(S).find((r) => r.uuid === Q2)?.parentUuid ?? "";
  const oldEnd = endOf(S);
  const Q4 = userRecordName("msg_contract_q4", 1);

  await check(9, "resumeSessionAt continues at the point; a point off the leaf chain is refused with a text the plugin knows", "a revert never moves to a new transcript when the CLI cannot continue: every retry fails the same way", async () => {
    const branch = await run([user("Question four", Q4)], { resume: S, resumeSessionAt: endOfQ1 });
    expect(chainTo(S, Q4)[1] === endOfQ1, `the record ${Q4} is not a child of the point; ${short(branch)}`);
    expect(!leafChain(S).includes(oldEnd), "the old end is still on the leaf chain");
    const before = textOf(S);
    const off = await run([user("Question five", userRecordName("msg_contract_q5", 1))], { resume: S, resumeSessionAt: oldEnd });
    expect(textOf(S) === before, `the file changed on a refused resume; ${short(off)}`);
    expect(off.requests.length === 0, `a resume off the leaf chain called the model; ${short(off)}`);
    const texts = failureTexts(off);
    expect(texts.some((text) => LOST_SESSION_PATTERN.test(text)), `the refusal reads ${JSON.stringify(texts)} (stderr ${JSON.stringify(off.stderr.trim().slice(0, 160))}): LOST_SESSION_PATTERN (proxy.ts) does not match it`);
    return `refused: ${texts[0]?.slice(0, 120)}`;
  });

  await check(10, "resume of a session with no file is refused with a text the plugin knows", "a chat whose transcript is gone never moves to a new one: every retry fails the same way", async () => {
    const missing = transcriptName("ses_contract_missing", FIRST_EPOCH, 1);
    const result = await run([user("Anyone there?", userRecordName("msg_contract_missing", 1))], { resume: missing });
    expect(!fileOf(missing), "a file was written for a session that had none");
    const texts = failureTexts(result);
    expect(texts.some((text) => LOST_SESSION_PATTERN.test(text)), `the refusal reads ${JSON.stringify(texts)} (stderr ${JSON.stringify(result.stderr.trim().slice(0, 160))}): LOST_SESSION_PATTERN (proxy.ts) does not match it`);
    return `refused: ${texts[0]?.slice(0, 120)}`;
  });

  await check(11, "a record whose uuid the file holds is dropped silently: anywhere in the file on resume, only the copied chain on a copy", "a retry under a taken name never runs (the plugin numbers attempts for that), or a copy drops a record its source holds after the point", async () => {
    for (const [label, uuid] of [["on the leaf chain", Q1], ["on a side branch", Q2]] as const) {
      const count = () => linesOf(S).filter((l) => l.uuid === uuid).length;
      const before = count();
      const result = await run([user(`Again, ${label}`, uuid)], { resume: S, resumeSessionAt: endOf(S) });
      expect(result.requests.length === 0 && !result.results.some((r) => r.num_turns > 0), `a record repeating a uuid ${label} ran a turn; ${short(result)}`);
      expect(count() === before, `a second record with a uuid ${label} was written`);
    }
    const copy = transcriptName("ses_contract_copy_scope", FIRST_EPOCH, 1);
    const result = await run([user("Question three, in a copy", Q3)], { resume: S, resumeSessionAt: endOfQ1, forkSession: true, sessionId: copy });
    expect(recordsOf(copy).some((r) => r.uuid === Q3), `a copy cut before Q3 dropped a record named like Q3, which its source holds after the point; ${short(result)}`);
  });

  await check(12, "a failed model call leaves an answer flagged isApiErrorMessage; a retry under a new uuid at the same point puts it on a side branch", "a failed turn's record is taken for an answer, or its retry continues after the failure", async () => {
    const point = endOf(S);
    const failed = userRecordName("msg_contract_q6", 1);
    // Twice: the CLI repeats a failed 400 on its own first (2.1.311: once with
    // an API key, as here; up to five times when signed in to a plan).
    const failure: Reply = { kind: "error", status: 400, type: "invalid_request_error", message: "stub failure" };
    replies.push(failure, failure);
    const first = await run([user("Question six", failed)], { resume: S, resumeSessionAt: point });
    const records = recordsOf(S);
    const at = records.findIndex((r) => r.uuid === failed);
    expect(at >= 0, `the failed turn wrote no record ${failed}; ${short(first)}`);
    expect(records.slice(at).some((r) => r.type === "assistant" && r.isApiErrorMessage), `no answer flagged isApiErrorMessage after the failed question; ${short(first)}`);
    const retry = userRecordName("msg_contract_q6", 2);
    const second = await run([user("Question six", retry)], { resume: S, resumeSessionAt: point });
    expect(chainTo(S, retry)[1] === point, `the retry is not a child of the point; ${short(second)}`);
    expect(leafChain(S).includes(retry) && !leafChain(S).includes(failed), "the failed attempt is still on the leaf chain");
    expect(second.results.at(-1)?.is_error !== true, `the retry failed; ${short(second)}`);
    return `the failed turn made ${first.requests.length} model request(s) before it gave up`;
  });

  // Copies, of a parent with a tool step: the question, the call, its result, the answer.
  const T = transcriptName("ses_contract_tool", FIRST_EPOCH, 1);
  const askT = userRecordName("msg_contract_t1", 1);
  replies.push({ kind: "tool", id: "toolu_contract_1", name: TOOL });
  const toolTurn = await run([user("Question with a tool", askT)], { sessionId: T, ...probeTool(async () => "TOOL_RESULT") });
  const copyAtEnd = transcriptName("ses_contract_copy_end", FIRST_EPOCH, 1);

  await check(13, "a copy (resume + forkSession + sessionId + resumeSessionAt) keeps the source's uuids down to the point and leaves the source alone; the point may be a tool result", "forks and reverts lose their records' names and the prompt cache: their history goes as text", async () => {
    const toolResult = recordsOf(T).find((r) => r.toolUseResult !== undefined)?.uuid;
    expect(toolResult, `the parent turn wrote no tool result; ${short(toolTurn)}`);
    const source = textOf(T);
    for (const [label, name, point] of [
      ["the end of the turn", copyAtEnd, endOf(T)],
      ["the tool result", transcriptName("ses_contract_copy_result", FIRST_EPOCH, 1), toolResult],
    ] as const) {
      const ask = userRecordName(`msg_contract_copy_${name}`, 1);
      const copy = await run([user(`Question in a copy cut at ${label}`, ask)], { resume: T, resumeSessionAt: point, forkSession: true, sessionId: name });
      expect(copy.init?.session_id === name, `the copy at ${label} runs as ${copy.init?.session_id}; ${short(copy)}`);
      const copied = new Set(recordsOf(name).map((r) => r.uuid));
      const missing = chainTo(T, point).filter((uuid) => !copied.has(uuid));
      expect(missing.length === 0, `the copy at ${label} lacks ${missing.length} uuid(s) of the source's chain`);
      expect(chainTo(name, ask).includes(point), `the copy's question does not follow the point (${label})`);
    }
    expect(textOf(T) === source, "copying changed the source");
  });

  await check(14, "a copy whose point is off the source's leaf chain is refused with a text the plugin knows, no file written", "a fork of a reverted part never falls back to text: every retry fails the same way", async () => {
    const name = transcriptName("ses_contract_copy_off", FIRST_EPOCH, 1);
    const result = await run([user("Copy off the chain", userRecordName("msg_contract_copy_off", 1))], { resume: S, resumeSessionAt: Q2, forkSession: true, sessionId: name });
    expect(recordsOf(name).length === 0, `the copy off the chain wrote records; ${short(result)}`);
    const texts = failureTexts(result);
    expect(texts.some((text) => LOST_SESSION_PATTERN.test(text)), `the refusal reads ${JSON.stringify(texts)} (stderr ${JSON.stringify(result.stderr.trim().slice(0, 160))}): LOST_SESSION_PATTERN (proxy.ts) does not match it`);
    return `refused: ${texts[0]?.slice(0, 120)}; file ${fileOf(name) ? "with no record" : "none"}`;
  });

  await check(15, "a copy under the name of a file that exists is refused, the file untouched", "two copies could write one transcript: the free name gives no protection", async () => {
    const before = textOf(copyAtEnd);
    const result = await run([user("Copy again", userRecordName("msg_contract_copy_again", 1))], { resume: T, resumeSessionAt: endOf(T), forkSession: true, sessionId: copyAtEnd });
    expect(textOf(copyAtEnd) === before, `the existing copy changed; ${short(result)}`);
    expect(!result.results.some((r) => r.num_turns > 0 && r.is_error !== true), `a turn ran into an existing name; ${short(result)}`);
    return `refused: ${short(result)}`;
  });

  await check(16, "a copy killed once its file appears leaves no record, and its name is not written again", "a killed copy's half-written file is taken for a transcript, or its name is reused", async () => {
    const name = transcriptName("ses_contract_copy_killed", FIRST_EPOCH, 1);
    const killed = await run([user("Copy to be killed", userRecordName("msg_contract_copy_killed", 1))], {
      resume: T,
      resumeSessionAt: endOf(T),
      forkSession: true,
      sessionId: name,
      onChild(child) {
        // Killed on the file system's word that the file appeared.
        const watcher = watch(projectsDir, { recursive: true }, (_event, file) => {
          if (!String(file ?? "").endsWith(`${name}.jsonl`)) return;
          watcher.close();
          child.kill("SIGKILL");
        });
        child.once("exit", () => watcher.close());
      },
    });
    if (!fileOf(name)) throw new NotReproduced(`the process ended before its file appeared; ${short(killed)}`);
    const records = recordsOf(name).length;
    if (records > 0) throw new NotReproduced(`the file held ${records} record(s) when the process died: the kill came late`);
    const again = await run([user("Copy after the kill", userRecordName("msg_contract_copy_killed", 2))], { resume: T, resumeSessionAt: endOf(T), forkSession: true, sessionId: name });
    expect(recordsOf(name).length === 0, `a copy wrote into the name of a killed copy; ${short(again)}`);
    return `killed as its file appeared (no record); the next copy: ${short(again)}`;
  });

  await check(17, "two copies under one name at once: the next resume gives the model every message once", "two servers forking one chat at once show Claude its history twice", async () => {
    const name = transcriptName("ses_contract_copy_race", FIRST_EPOCH, 1);
    const marker = userRecordName("msg_contract_race_marker", 1);
    const point = endOf(T);
    const both = await Promise.all([0, 1].map(() => run([user(" ", marker, { shouldQuery: false })], { resume: T, resumeSessionAt: point, forkSession: true, sessionId: name })));
    const outcome = both.map((r) => (r.results.length > 0 && r.exitCode === 0 ? "copied" : "refused")).join(" and ");
    expect(fileOf(name), `no copy was written: ${outcome}`);
    const next = await run([user("RACE_NEXT question", userRecordName("msg_contract_race_next", 1))], { resume: name, resumeSessionAt: marker });
    const text = (next.requests[0]?.body.messages ?? []).map(messageText).join("\n");
    const times = (needle: string) => text.split(needle).length - 1;
    expect(times("Question with a tool") === 1 && times("TOOL_RESULT") === 1, `the model got the parent's question ${times("Question with a tool")} and its tool result ${times("TOOL_RESULT")} time(s); copies: ${outcome}`);
    const written = linesOf(name).filter((l) => l.uuid === askT).length;
    if (outcome !== "copied and copied") throw new NotReproduced(`copies: ${outcome}; the next resume read the copy once`);
    return `copies: ${outcome}, the parent's question written ${written} time(s), read once`;
  });

  // A turn parked on a tool call, two messages sent while it waits.
  const M = transcriptName("ses_contract_steer", FIRST_EPOCH, 1);
  const steerOne = userRecordName("msg_contract_m2", 1);
  const steerTwo = userRecordName("msg_contract_m3", 1);
  const toolExtras: any[] = [];
  const steerInput = openInput([user("Question with messages meanwhile", userRecordName("msg_contract_m1", 1))]);
  replies.push({ kind: "tool", id: "toolu_contract_steer", name: TOOL });
  const steerTurn = await run(steerInput.stream, {
    sessionId: M,
    ...probeTool(async (extra) => {
      toolExtras.push(extra);
      steerInput.push(user("STEER_ONE text", steerOne, { priority: "next" }));
      steerInput.push(user("STEER_TWO text", steerTwo, { priority: "next" }));
      await sleep(500);
      return "STEER_TOOL_RESULT";
    }),
    onEvent(event) {
      if (isTurnResult(event)) steerInput.end();
    },
  });

  await check(18, "a message sent while a turn is parked on a tool is absorbed as an attachment carrying its uuid, each its own", "a message sent mid-turn is not found by its name: the next turn sends it again as missed", async () => {
    const lines = linesOf(M);
    const chain = leafChain(M);
    for (const [label, uuid] of [["first", steerOne], ["second", steerTwo]] as const) {
      const attachment = lines.find((l) => l.type === "attachment" && l.attachment?.source_uuid === uuid);
      expect(attachment, `no attachment carries the ${label} message's uuid; ${short(steerTurn)}`);
      expect(!lines.some((l) => l.type === "user" && l.uuid === uuid), `the ${label} message is a user record of its own`);
      expect(chain.includes(attachment.uuid), `the ${label} message's attachment is off the turn's chain`);
    }
    const sent = JSON.stringify(steerTurn.requests.map((r) => r.body.messages));
    expect(sent.includes("STEER_ONE text") && sent.includes("STEER_TWO text"), "the model never got the messages sent mid-turn");
  });

  await check(19, "the MCP handler gets the call's id in _meta[\"claudecode/toolUseId\"], the id the call and result records carry", "the screen's tool steps cannot be matched to the transcript: a fork cut inside a turn sends the step as text", async () => {
    const id = toolExtras[0]?._meta?.["claudecode/toolUseId"];
    expect(id === "toolu_contract_steer", `the handler got ${JSON.stringify(id)} as the call's id`);
    const lines = linesOf(M);
    expect(lines.some((l) => l.type === "assistant" && Array.isArray(l.message?.content) && l.message.content.some((b: any) => b.type === "tool_use" && b.id === id)), "no call record carries the id");
    const result = lines.find((l) => l.type === "user" && l.toolUseResult !== undefined && Array.isArray(l.message?.content) && l.message.content.some((b: any) => b.type === "tool_result" && b.tool_use_id === id));
    expect(result, "no tool result record (flagged toolUseResult) carries the id");
    const parsed = recordsOf(M).find((r) => r.uuid === result.uuid);
    expect(parsed && !isPromptRecord(parsed), "the plugin reads the tool result record as a question");
  });

  await check(13.1, "a copy can be cut at the attachment of a message absorbed mid-turn", "a fork from inside a turn with a message sent meanwhile goes as text", async () => {
    const attachment = linesOf(M).find((l) => l.type === "attachment" && l.attachment?.source_uuid === steerOne);
    expect(attachment, "no attachment to cut at (check 18)");
    const name = transcriptName("ses_contract_copy_attachment", FIRST_EPOCH, 1);
    const ask = userRecordName("msg_contract_copy_attachment", 1);
    const copy = await run([user("Question in a copy cut at the attachment", ask)], { resume: M, resumeSessionAt: attachment.uuid, forkSession: true, sessionId: name });
    expect(chainTo(name, ask).includes(attachment.uuid), `the copy's question does not follow the attachment; ${short(copy)}`);
    expect(!recordsOf(name).some((r) => r.attachment?.source_uuid === steerTwo), "the copy holds the second message, which came after the point");
  });

  await check(20, "an interrupted parked turn ends with the rejected result and the CLI's own \"[Request interrupted by user for tool use]\" record, which is no question", "a stopped turn's record reads as the user's question: the next turn's point and missed messages go wrong", async () => {
    const P = transcriptName("ses_contract_interrupt", FIRST_EPOCH, 1);
    const input = openInput([user("Question to be stopped", userRecordName("msg_contract_p1", 1))]);
    let query: { interrupt(): Promise<void> } | undefined;
    let called!: () => void;
    const parked = new Promise<void>((resolve) => (called = resolve));
    replies.push({ kind: "tool", id: "toolu_contract_stop", name: TOOL });
    const running = run(input.stream, {
      sessionId: P,
      ...probeTool(async () => {
        called();
        return new Promise<string>(() => {});
      }),
      onQuery: (q) => (query = q),
      onEvent(event) {
        if (event.type === "result") input.end();
      },
    });
    await Promise.race([parked, sleep(30_000)]);
    await query?.interrupt().catch(() => {});
    const stopped = await running;
    const lines = linesOf(P);
    expect(lines.some((l) => l.type === "user" && l.toolUseResult !== undefined), `no rejected tool result; ${short(stopped)}`);
    const stop = lines.find((l) => l.type === "user" && messageText(l.message).trim() === "[Request interrupted by user for tool use]");
    expect(stop, `no "[Request interrupted by user for tool use]" record; ${short(stopped)}`);
    const parsed = recordsOf(P).find((r) => r.uuid === stop.uuid);
    expect(parsed && !isPromptRecord(parsed), "the plugin reads the interruption record as a question");
    expect(stopped.results.at(-1)?.is_error === true || stopped.error, `the turn did not end with an error; ${short(stopped)}`);
    return `the record: isMeta ${stop.isMeta === true}, toolUseResult ${stop.toolUseResult !== undefined}; ${short(stopped)}`;
  });

  // The CLI's own compaction, with the setting on and off: the stub reports a
  // context past the window the CLI compacts at (`autoCompactWindow`), and the
  // second question, asked in the same process as the CLI's own compaction
  // was seen in (probe 14), decides.
  const compacting = async (label: string, autoCompactEnabled: boolean) => {
    const K = transcriptName(`ses_contract_compact_${label}`, FIRST_EPOCH, 1);
    const input = openInput([user("COMPACT_Q1 text", userRecordName(`msg_contract_compact_${label}_1`, 1))]);
    let turns = 0;
    replies.push({ kind: "text", text: "A long answer", inputTokens: 190_000 });
    countedTokens = 190_000;
    const second = await run(input.stream, {
      sessionId: K,
      // The window the CLI compacts at, for both cases: below what the stub reports.
      settings: { autoCompactEnabled, autoCompactWindow: 100_000, disableClaudeAiConnectors: true },
      onEvent(event) {
        if (!isTurnResult(event)) return;
        turns += 1;
        if (turns === 1) input.push(user("COMPACT_Q2 text", userRecordName(`msg_contract_compact_${label}_2`, 1)));
        else input.end();
      },
    }).finally(() => (countedTokens = 100));
    const boundary = linesOf(K).find((l) => l.type === "system" && l.subtype === "compact_boundary");
    return { K, second, boundary };
  };
  const compactOn = await compacting("on", true);
  const compactOff = await compacting("off", false);

  await check(21, "settings.autoCompactEnabled: false keeps the CLI from compacting a session it compacts with true", "Claude Code compacts on its own: a resume before its boundary fails, and OpenCode never sees the summary", async () => {
    expect(compactOn.boundary, `with autoCompactEnabled: true the control session did not compact at 190 000 tokens reported (autoCompactWindow 100 000), so false proves nothing; ${short(compactOn.second)}`);
    expect(!compactOff.boundary, `with autoCompactEnabled: false the session compacted; ${short(compactOff.second)}`);
    return `off: ${short(compactOff.second)}; ${JSON.stringify(failureTexts(compactOff.second).map((text) => text.slice(0, 80)))}`;
  });

  await check(22, "the CLI's compaction: a boundary linked by logicalParentUuid, a summary flagged isCompactSummary; neither reads as a question", "after a compaction of the CLI the plugin loses the chain, or takes the summary for the user's question", async () => {
    const boundary = compactOn.boundary;
    if (!boundary) throw new Error("no compaction to read (check 21)");
    expect(boundary.parentUuid === null && typeof boundary.logicalParentUuid === "string", `the boundary is ${JSON.stringify({ parentUuid: boundary.parentUuid, logicalParentUuid: boundary.logicalParentUuid })}`);
    expect(linesOf(compactOn.K).some((l) => l.uuid === boundary.logicalParentUuid), "logicalParentUuid names no record of the file");
    const records = recordsOf(compactOn.K);
    const summary = records.find((r) => r.isCompactSummary);
    expect(summary && !isPromptRecord(summary), summary ? "the plugin reads the summary as a question" : "no record flagged isCompactSummary");
    const metas = records.filter((r) => r.isMeta);
    expect(metas.every((r) => !isPromptRecord(r)), "the plugin reads an isMeta record as a question");
    expect(leafChain(compactOn.K).includes(userRecordName("msg_contract_compact_on_1", 1)), "the leaf chain does not reach back across the boundary by logicalParentUuid");
    return `${metas.length} isMeta record(s)`;
  });

  await check(23, "a summary on forkSession + persistSession: false writes no file and leaves the chat's alone", "every OpenCode compaction leaves a file in the user's Claude Code history, or changes the chat's transcript", async () => {
    const before = allFiles();
    const chat = textOf(S);
    const summary = await run([user("Summarize the conversation.")], { resume: S, resumeSessionAt: endOf(S), forkSession: true, persistSession: false });
    expect(summary.requests.length === 1 && summary.results.at(-1)?.is_error !== true, `the summary did not run; ${short(summary)}`);
    const after = allFiles();
    expect(after.length === before.length, `transcript files ${before.length} → ${after.length}: ${after.filter((file) => !before.includes(file)).join(", ")}`);
    expect(textOf(S) === chat, "the chat's transcript changed");
  });

  await check(24, "the API's \"prompt is too long\" reaches the plugin as a text it classifies as a context overflow", "an overflow is not handed to OpenCode as one: no compaction, the chat stays stuck", async () => {
    replies.push({ kind: "error", status: 400, type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" });
    const result = await run([user("Too long", userRecordName("msg_contract_long", 1))], { resume: S, resumeSessionAt: endOf(S) });
    const texts = failureTexts(result);
    expect(texts.some((text) => classifyClaudeFailure(text) === "context_overflow"), `the failure reads ${JSON.stringify(texts)}; ${short(result)}`);
    return `reads: ${texts[0]?.slice(0, 120)}`;
  });
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) killProcessTree(child.pid, { force: true });
  }
  stub.closeAllConnections();
  await new Promise((resolve) => stub.close(resolve));
}

// --- the verdict

const failed = outcomes.filter((o) => o.status === "fail");
const races = outcomes.filter((o) => o.status === "not reproduced");
writeFileSync(join(root, "requests.json"), JSON.stringify(requests, null, 1));
console.log(`\nClaude Code ${version}: ${outcomes.length - failed.length - races.length} passed, ${failed.length} failed, ${races.length} not reproduced (races).`);
if (failed.length > 0 || process.env.CLAUDE_CONTRACT_KEEP === "1") {
  console.log(`Files kept: ${root}`);
} else {
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed.length > 0 ? 1 : 0);
