/**
 * Live scenario through a real `opencode serve` and the real Claude Code: the
 * plugin from this checkout, a signed-in CLI, Claude Haiku 5.5. The suite runs
 * on the simulators of both platforms (test/simulators/) and cli-contract-live.ts asks the CLI
 * alone; this file drives the whole chain as a user does in OpenChamber and
 * checks each outcome by the plugin's journal and by Claude's transcripts.
 *
 *   load      chat P reads a text of about 10k tokens, then a question
 *   fork      fork B of the whole chat: its first turn copies P's transcript
 *             and reads the history from the prompt cache
 *   late      P asks about Germany, fork C is made, P reverts that question and
 *             asks about Italy: P's turn copies version 1 into version 2; C's
 *             first turn copies version 1 (Germany is there, Italy is not)
 *   stop      a long answer stopped while it streams, then a question: the next
 *             turn does not resume after an answer the screen lacks
 *
 * Run: bun run build && bun test/opencode-live.ts
 * - OPENCODE_BIN=<path>: the OpenCode to run (default: `opencode` on PATH), 2.0.19 or later;
 * - OPENCODE_LIVE_KEEP=1: keep the temp folder (OpenCode's data, config, journal) after a pass.
 *
 * Not part of `bun run test`: it needs a signed-in Claude Code and spends
 * about ten Haiku turns of the plan, most of them read from the cache.
 *
 * Isolation: OpenCode's data and config, the chats' working folder and the
 * plugin's journal live in a temp folder of the test, removed after a pass
 * (kept after a failure); no OPENCODE* or OPENCHAMBER* variable is inherited,
 * no project config is read, the server has a port and password of its own.
 * Claude's account is the user's (the sign-in is needed), without CLAUDE.md
 * files and auto memory; the transcripts the chats write stay in its projects
 * folder, and the test prints where. The server is reached by plain HTTP.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { pluginModule } from "./simulators/world.ts";

// The plugin's own modules, from the tree under test (OPENCODE_CLAUDE_PLUGIN_DIR, else this checkout).
const { claudeConfigDir } = await pluginModule("config-dir");
const { resolveClaudeCodeExecutable } = await pluginModule("executable-path");
const { FIRST_EPOCH, transcriptName, userRecordName } = await pluginModule("names");

/** The first OpenCode with everything the plugin relies on (README, Requirements). */
const MIN_OPENCODE = [2, 0, 19] as const;
const MODEL = { providerID: "claude-code", id: "claude-haiku-5-5" };
const AGENT = "opencode-live";

// --- checks

let failures = 0;
function check(ok: boolean, what: string, why = ""): boolean {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${!ok && why ? `\n       ${why}` : ""}`);
  return ok;
}
/** A precondition: the rest cannot run without it. */
function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (file: string) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "(no file)");

// --- what runs: this checkout's build, OpenCode, Claude Code

const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");

/** OpenCode loads the plugin from dist/: a build older than src/ would test old code. */
function buildIsFresh(): string | null {
  const dist = join(repo, "dist");
  if (!existsSync(join(dist, "index.js"))) return "dist/ has no build";
  const newest = (dir: string, ext: string): number => {
    let at = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) at = Math.max(at, newest(path, ext));
      else if (entry.name.endsWith(ext)) at = Math.max(at, statSync(path).mtimeMs);
    }
    return at;
  };
  const oldestBuilt = readdirSync(dist)
    .filter((name) => name.endsWith(".js"))
    .reduce((at, name) => Math.min(at, statSync(join(dist, name)).mtimeMs), Infinity);
  return newest(join(repo, "src"), ".ts") > oldestBuilt ? "src/ changed after the last build" : null;
}

const opencodeBin = process.env.OPENCODE_BIN?.trim() || "opencode";

function versionOf(bin: string): { text: string; parts: number[] | null } {
  const run = spawnSync(bin, ["--version"], { encoding: "utf8", windowsHide: true });
  const text = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() || String(run.error ?? "no output");
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return { text, parts: match ? match.slice(1).map(Number) : null };
}

function atLeast(parts: number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    if (parts[i]! !== min[i]!) return parts[i]! > min[i]!;
  }
  return true;
}

// --- the place

const root = mkdtempSync(join(tmpdir(), "opencode-live-"));
const configHome = join(root, "config");
const dataHome = join(root, "data");
const work = join(root, "work");
for (const dir of [join(configHome, "opencode"), dataHome, work]) mkdirSync(dir, { recursive: true });
const journalFile = join(dataHome, "opencode-claude", "debug.log");
const opencodeLogDir = join(dataHome, "opencode", "log");

writeFileSync(
  join(configHome, "opencode", "opencode.jsonc"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugins: [{ package: repo, options: { cliAutoUpdate: false } }],
      // The chats need no tools: a model that reads files mid-answer would make the turns differ run to run.
      agents: {
        [AGENT]: {
          mode: "primary",
          description: "opencode-live test agent without tools",
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        },
      },
    },
    null,
    2,
  ) + "\n",
);

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined || /^(OPENCODE|OPENCHAMBER)/.test(key)) continue;
  env[key] = value;
}
const password = randomBytes(12).toString("hex");
Object.assign(env, {
  XDG_CONFIG_HOME: configHome,
  XDG_DATA_HOME: dataHome,
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_PASSWORD: password,
  OPENCODE_CLAUDE_DEBUG: "1",
  DISABLE_UPDATES: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

// --- the server, by plain HTTP

let port = 0;
let server: ChildProcess | undefined;
let serverOut = "";
const headers = () => ({
  authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  "x-opencode-directory": encodeURIComponent(work),
  "content-type": "application/json",
});

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 400)}`);
  if (!text) return undefined;
  const json = JSON.parse(text);
  return json && typeof json === "object" && "data" in json ? json.data : json;
}

async function startServer(): Promise<void> {
  server = spawn(opencodeBin, ["serve", "--port", String(port)], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  server.stdout!.on("data", (chunk) => (serverOut += chunk));
  server.stderr!.on("data", (chunk) => (serverOut += chunk));
  for (let i = 0; ; i++) {
    try {
      await api("GET", "/api/info");
      return;
    } catch (error) {
      if (i > 60) throw new Error(`OpenCode did not answer on port ${port}: ${error}\n${serverOut.slice(-1500)}`);
      await sleep(500);
    }
  }
}

/** Stop the server and the Claude Code processes it started. */
function stopServer(): void {
  if (!server?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { windowsHide: true });
  else server.kill("SIGKILL");
}

// --- the server's events: the start of a streamed answer and the stop

type ServerEvent = { type?: string; data?: Record<string, any> };
const events: ServerEvent[] = [];
const eventsController = new AbortController();

async function followEvents(): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/event`, { headers: headers(), signal: eventsController.signal });
  if (!response.ok || !response.body) throw new Error(`GET /api/event: HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          try {
            events.push(JSON.parse(data));
          } catch {
            // not an event
          }
        }
      }
    } catch {
      // the stream ends with the test
    }
  })();
}

async function waitFor<T>(what: string, ms: number, probe: () => T | undefined | false): Promise<T> {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    const value = probe();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

// --- the plugin's journal

let journalAt = 0;
const journalLines = () => (existsSync(journalFile) ? readFileSync(journalFile, "utf8").split("\n").filter(Boolean) : []);
/** The journal lines since the last call. */
function freshJournal(): string[] {
  const lines = journalLines();
  const fresh = lines.slice(journalAt);
  journalAt = lines.length;
  return fresh;
}
function fields(line: string | undefined): Record<string, any> {
  if (!line) return {};
  try {
    return JSON.parse(line.slice(line.indexOf("{")));
  } catch {
    return {};
  }
}
/** Lines that mean a turn did not run in a transcript: the history went as text, or something failed. */
const FALLBACK = /starting a new Claude transcript|Claude session lost|turn failed fast|level=(warn|error)/;

// --- Claude's transcripts

type TranscriptRecord = Record<string, any>;
const claudeProjects = join(claudeConfigDir(), "projects");

function transcriptFile(name: string): string | null {
  if (!existsSync(claudeProjects)) return null;
  for (const dir of readdirSync(claudeProjects)) {
    const file = join(claudeProjects, dir, `${name}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}
function recordsOf(name: string): TranscriptRecord[] {
  const file = transcriptFile(name);
  if (!file) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return {};
    }
  });
}
function textOfRecord(record: TranscriptRecord): string {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block: any) => block?.type === "text" && typeof block.text === "string").map((block: any) => block.text).join("");
}
/** The uuids from the first record down to `uuid` along parents; null when the chain breaks. */
function chainTo(records: TranscriptRecord[], uuid: string): string[] | null {
  const byUuid = new Map(records.filter((r) => typeof r.uuid === "string").map((r) => [r.uuid as string, r]));
  const chain: string[] = [];
  for (let at: string | null | undefined = uuid; at; ) {
    const record = byUuid.get(at);
    if (!record || chain.includes(at)) return null;
    chain.unshift(at);
    at = record.parentUuid;
  }
  return chain;
}

// --- what the user does

const context = async (chat: string): Promise<any[]> => (await api("GET", `/api/session/${chat}/context`)) ?? [];
const create = async (title: string): Promise<string> => (await api("POST", "/api/session", { title, agent: AGENT, model: MODEL })).id;
const fork = async (parent: string): Promise<string> => (await api("POST", `/api/session/${parent}/fork`, {})).id;
const textOfMessage = (message: any): string =>
  (Array.isArray(message?.content) ? message.content : []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("").trim();

async function userMessage(chat: string, start: string): Promise<any> {
  return (await context(chat)).findLast((m) => m.type === "user" && typeof m.text === "string" && m.text.startsWith(start));
}

type Turn = { answer: string; lines: string[]; plan: Record<string, any>; usage: Record<string, any>; forked: Record<string, any> };

/** One turn: the question, OpenCode's wait, the answer on the screen and the plugin's journal of it. */
async function ask(chat: string, text: string): Promise<Turn> {
  freshJournal();
  await api("POST", `/api/session/${chat}/prompt`, { text });
  await api("POST", `/api/experimental/session/${chat}/wait`);
  await sleep(1000);
  const answer = textOfMessage((await context(chat)).findLast((m) => m.type === "assistant"));
  const lines = freshJournal().filter((line) => line.includes(chat));
  const plan = fields(lines.findLast((l) => /resuming the chat's Claude transcript|starting a new Claude transcript/.test(l)));
  const usage = fields(lines.findLast((l) => l.includes("turn usage")));
  const forked = fields(lines.find((l) => l.includes("forked chat")));
  console.log(`  > ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`);
  console.log(`  < ${answer.replace(/\s+/g, " ").slice(0, 160)}`);
  console.log(`    plan ${JSON.stringify(plan)}; cache read ${usage.totalCacheRead ?? "?"}, written ${usage.totalCacheWrite ?? "?"}`);
  return { answer, lines, plan, usage, forked };
}

/** A chat's first turn starts its transcript: that one line is no fallback. */
const FIRST_TURN = /starting a new Claude transcript; transferring history .*"why":"no transcript of this chat in this epoch"/;

function noFallback(turn: Turn, label: string, firstTurn = false): void {
  const bad = turn.lines.filter((l) => FALLBACK.test(l) && !(firstTurn && FIRST_TURN.test(l)));
  check(bad.length === 0, `${label}: the turn ran in a transcript, nothing failed`, bad.map((l) => l.slice(0, 300)).join("\n       "));
}

/**
 * A copy by the CLI (`forkSession` with the parent's uuids): the copy holds
 * the source's chain down to the point, the same records in the same order,
 * then the turn's question; the source did not change.
 */
function checkCopy(label: string, source: string, sourceHash: string, copy: string, point: string, question: string): void {
  check(sha(transcriptFile(source) ?? "") === sourceHash, `${label}: the source transcript ${source} did not change`);
  const sourceRecords = recordsOf(source);
  const copyRecords = recordsOf(copy);
  const sourceChain = chainTo(sourceRecords, point);
  const copyChain = chainTo(copyRecords, point);
  if (!check(Boolean(sourceChain), `${label}: the point ${point} is on a chain of the source`)) return;
  check(
    JSON.stringify(copyChain) === JSON.stringify(sourceChain),
    `${label}: the copy ${copy} holds the source's chain down to the point, same uuids, same order (${sourceChain!.length} records)`,
    copyChain ? `copy chain ${copyChain.length} records, source ${sourceChain!.length}` : "the point is not in the copy",
  );
  const asked = copyRecords.find((r) => r.type === "user" && textOfRecord(r).includes(question));
  check(
    Boolean(asked && chainTo(copyRecords, asked.uuid)?.includes(point)),
    `${label}: the copy's question follows the point`,
  );
}

// --- the text to read: numbered facts, about 10k tokens

function textToRead(): string {
  const places = ["Aldermoor", "Brightwater", "Calder Fen", "Dunmore", "Eastholm", "Fairhaven", "Greywick", "Hollowmere"];
  const things = ["beehives", "windmills", "stone bridges", "orchards", "lighthouses", "wells", "bell towers", "ferries"];
  const months = ["March", "April", "May", "June", "July", "August", "September", "October"];
  const lines = ["A gazetteer of an imaginary county. Read it; questions about it may follow.", ""];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let i = 1; i <= 360; i++) {
    const place = places[next() % places.length]!;
    const thing = things[next() % things.length]!;
    const month = months[next() % months.length]!;
    lines.push(`${i}. The parish of ${place} keeps ${100 + (next() % 900)} ${thing}; its fair is held each ${month}, and its records go back ${10 + (next() % 400)} years.`);
  }
  return lines.join("\n");
}

// --- the scenario

let passed = false;
try {
  console.log("opencode-live: the plugin from", repo);
  const stale = buildIsFresh();
  need(!stale, `${stale}: run \`bun run build\` first (OpenCode loads the plugin from dist/)`);
  const opencode = versionOf(opencodeBin);
  console.log(`  OpenCode: ${opencodeBin} — ${opencode.text}`);
  need(Boolean(opencode.parts), `cannot read the version of ${opencodeBin}; set OPENCODE_BIN to OpenCode 2.0.19 or later`);
  need(atLeast(opencode.parts!, MIN_OPENCODE), `OpenCode ${opencode.parts!.join(".")} is older than ${MIN_OPENCODE.join(".")}, the first the plugin supports`);
  const cli = await resolveClaudeCodeExecutable({ env });
  need(Boolean(cli), "Claude Code is not installed (no `claude` found)");
  const claude = versionOf(cli!);
  console.log(`  Claude Code: ${cli} — ${claude.text}`);
  console.log(`  temp folder: ${root}`);

  port = await freePort();
  await startServer();
  await followEvents();
  // The plugin reads the model list from the CLI after it loads.
  let listed = false;
  for (let i = 0; i < 60 && !listed; i++) {
    const models = await api("GET", "/api/model");
    listed = Array.isArray(models) && models.some((m) => m.providerID === MODEL.providerID && (m.id === MODEL.id || m.modelID === MODEL.id));
    if (!listed) await sleep(1000);
  }
  need(listed, `${MODEL.providerID}/${MODEL.id} is not in OpenCode's model list after 60 s`);
  const ocLog = existsSync(opencodeLogDir)
    ? readdirSync(opencodeLogDir).map((f) => join(opencodeLogDir, f)).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).at(-1)
    : undefined;
  const loading = (ocLog ? readFileSync(ocLog, "utf8") : "").split("\n").filter((l) => /loading plugin/.test(l)).at(-1) ?? "";
  need(loading.includes(repo), `OpenCode did not load the plugin from ${repo} (its last "loading plugin" line: ${loading.slice(0, 300) || "none"})`);
  need(journalLines().some((l) => /auto-update is off/.test(l)), "the plugin's journal has no line of this build (its CLI updater says it is off)");
  console.log("  the plugin of this checkout is loaded");

  // load
  console.log("\nload");
  const P = await create("opencode-live P");
  const load = await ask(P, `${textToRead()}\n\nRead this text. Answer with one word: ready.`);
  noFallback(load, "load", true);
  const P1 = transcriptName(P, FIRST_EPOCH, 1);
  check(load.plan.transcript === P1, `the first turn starts P's transcript under the chat's name (${load.plan.transcript})`);
  const france = await ask(P, "What is the capital of France? One word.");
  noFallback(france, "load");
  need(recordsOf(P1).length > 0, `P's transcript ${P1} is not on disk`);
  check(france.plan.transcript === P1 && !france.plan.copyFor, `the second turn continues P's transcript by name (${france.plan.transcript})`);
  // What the loading turn put in the cache (the system prompt and the text):
  // a copy that reads the history from the cache reads at least this much.
  // Not the second turn's: the CLI rewrites the last user record of a
  // request, so even the parent's own next turn reads up to the mark before it.
  const cachedPrefix = Number(load.usage.totalCacheRead ?? 0) + Number(load.usage.totalCacheWrite ?? 0);
  need(cachedPrefix > 0, "the journal has no usage of P's first turn");
  console.log(`  the loading turn cached ${cachedPrefix} tokens`);

  // fork
  console.log("\nfork of the whole chat");
  const P1Hash = sha(transcriptFile(P1)!);
  const B = await fork(P);
  const forkQuestion = "Which city did I ask about last, and what did you answer? Briefly.";
  const b = await ask(B, forkQuestion);
  noFallback(b, "fork");
  check(b.forked.outcome === "forked" && b.forked.from === P1, `B's first turn planned a copy of P's transcript (${b.forked.outcome}, from ${b.forked.from})`);
  const B1 = transcriptName(B, FIRST_EPOCH, 1);
  check(b.plan.copyFor === "fork" && b.plan.transcript === B1 && b.plan.missed === 0, `B runs in its own transcript ${B1}, nothing missed (missed ${b.plan.missed})`);
  checkCopy("fork", P1, P1Hash, B1, String(b.forked.point), forkQuestion);
  check(
    Number(b.usage.totalCacheRead ?? 0) >= cachedPrefix,
    `B's first turn read the history from the cache: ${b.usage.totalCacheRead} read, ${b.usage.totalCacheWrite} written, P's loading turn cached ${cachedPrefix}`,
    "the copy's request did not start with what P's loading turn cached",
  );
  check(/Paris/i.test(b.answer), "B knows the parent's answer (Paris)");

  // late
  console.log("\na fork made before the parent's revert");
  const germany = await ask(P, "And the capital of Germany? One word.");
  noFallback(germany, "late");
  const C = await fork(P);
  const reverted = await userMessage(P, "And the capital of Germany");
  need(Boolean(reverted), "P's question about Germany is not on the screen");
  await api("POST", `/api/session/${P}/revert/stage`, { messageID: reverted.id });
  const P1HashBeforeRevert = sha(transcriptFile(P1)!);
  const italy = await ask(P, "And the capital of Italy? One word.");
  noFallback(italy, "late");
  const P2 = transcriptName(P, FIRST_EPOCH, 2);
  check(
    italy.plan.copyFor === "revert" && italy.plan.copiedFrom === P1 && italy.plan.transcript === P2 && italy.plan.version === 2,
    `P's turn after the revert copied version 1 into version 2 (${italy.plan.copyFor}, v${italy.plan.version})`,
  );
  checkCopy("revert", P1, P1HashBeforeRevert, P2, String(italy.plan.point), "And the capital of Italy");
  check(recordsOf(P1).some((r) => textOfRecord(r).includes("capital of Germany")), "version 1 keeps the reverted question");
  check(
    !recordsOf(P2).some((r) => textOfRecord(r).includes("capital of Germany")) && recordsOf(P2).some((r) => textOfRecord(r).includes("capital of Italy")),
    "version 2 holds Italy, not Germany",
  );
  const P2Hash = sha(transcriptFile(P2)!);
  const lateQuestion = "Which capitals did I ask about? List them briefly.";
  const c = await ask(C, lateQuestion);
  noFallback(c, "late");
  check(c.forked.outcome === "forked" && c.forked.from === P1, `C's first turn copied version 1, the one the revert left (from ${c.forked.from === P1 ? "version 1" : c.forked.from})`);
  const C1 = transcriptName(C, FIRST_EPOCH, 1);
  checkCopy("late fork", P1, P1HashBeforeRevert, C1, String(c.forked.point), lateQuestion);
  check(sha(transcriptFile(P2)!) === P2Hash, "C's copy left version 2 as it was");
  check(/Berlin|Germany/i.test(c.answer) && !/Rome|Italy/i.test(c.answer), "C knows Germany, not Italy");
  check(Number(c.usage.totalCacheRead ?? 0) >= cachedPrefix, `C's first turn read the history from the cache: ${c.usage.totalCacheRead} read, ${c.usage.totalCacheWrite} written`);

  // stop
  console.log("\na long answer stopped while it streams");
  // An answer long enough to be stopped in the middle: a model that writes it whole within the stop's delay proves nothing.
  const retell = "Copy out entries 1 to 200 of the gazetteer word for word, one per line, with nothing before or after them.";
  freshJournal();
  const eventsFrom = events.length;
  const streamed = () => events.slice(eventsFrom).filter((e) => e.data?.sessionID === P);
  await api("POST", `/api/session/${P}/prompt`, { text: retell });
  await waitFor("the answer to start streaming", 120_000, () => {
    const text = streamed().filter((e) => e.type === "session.text.delta").map((e) => String(e.data?.delta ?? "")).join("");
    return text.length >= 300;
  });
  const endedBefore = streamed().some((e) => e.type === "session.step.ended" || e.type === "session.execution.succeeded");
  check(!endedBefore, "the answer had started and had not ended when the stop was pressed");
  const stopped = await api("POST", `/api/session/${P}/interrupt`);
  check(stopped?.interrupted === true, `OpenCode stopped the running turn (interrupted: ${stopped?.interrupted})`);
  await waitFor("session.execution.interrupted", 30_000, () => streamed().some((e) => e.type === "session.execution.interrupted"));
  await api("POST", `/api/experimental/session/${P}/wait`);
  // A CLI still running would write its answer within seconds (probes 10, 32).
  await sleep(5000);
  const screen = await context(P);
  const retellMessage = screen.findLast((m) => m.type === "user" && typeof m.text === "string" && m.text.startsWith("Copy out entries 1 to 200"));
  need(Boolean(retellMessage), "the stopped turn's question is not on the screen");
  const kept = textOfMessage(screen.slice(screen.indexOf(retellMessage) + 1).find((m) => m.type === "assistant"));
  console.log(`  the screen kept ${kept ? `${kept.length} chars of the stopped answer` : "nothing of the stopped answer"}`);
  const after = await ask(P, "Answer with one word: yes.");
  noFallback(after, "stop");
  const point = String(after.plan.point ?? "");
  const current = String(after.plan.transcript ?? "");
  const records = recordsOf(current);
  const pointRecord = records.find((r) => r.uuid === point);
  if (check(Boolean(pointRecord), `the next turn's point is a record of ${current}`, `point ${point || "(none in the journal)"}`)) {
    const retellRecord = records.find((r) => r.uuid === userRecordName(retellMessage.id, 1));
    const chain = chainTo(records, point) ?? [];
    check(Boolean(retellRecord && chain.includes(retellRecord.uuid)), "the point is at or after the stopped turn's question");
    // Every answer in words the CLI wrote to the stopped question, on any
    // branch, and not in the next turn (whose records descend from it too).
    const nextMessage = await userMessage(P, "Answer with one word: yes.");
    const nextRecord = nextMessage ? userRecordName(nextMessage.id, 1) : undefined;
    const written = records.filter((r) => {
      if (r.type !== "assistant" || r.isApiErrorMessage || !retellRecord || !textOfRecord(r).trim()) return false;
      const ancestors = chainTo(records, r.uuid) ?? [];
      return ancestors.includes(retellRecord.uuid) && !(nextRecord && ancestors.includes(nextRecord));
    });
    check(Boolean(nextRecord && records.some((r) => r.uuid === nextRecord)), "the next turn's question is a record under its name");
    console.log(`  the CLI wrote ${written.length} answer record(s) in words to the stopped question (${written.map((r) => textOfRecord(r).length).join(", ") || "none"} chars); the point is a ${pointRecord!.type} record`);
    // The stop came in the middle when the CLI holds no answer the screen holds whole.
    check(
      !kept || !written.some((r) => textOfRecord(r).trim() === kept.trim()),
      "the stop came in the middle of the answer: the CLI holds no answer equal to the screen's",
      "the answer was complete when the stop arrived; the case of a cut answer was not reached",
    );
    const answered = chain
      .slice(retellRecord ? chain.indexOf(retellRecord.uuid) : 0)
      .map((uuid) => records.find((r) => r.uuid === uuid)!)
      .filter((r) => written.includes(r));
    check(
      answered.length === 0,
      `the next turn does not resume after an answer the screen lacks: no answer of the stopped turn before the point`,
      `before the point: ${answered.map((r) => `${r.uuid} (${textOfRecord(r).length} chars)`).join(", ")}`,
    );
    if (kept) {
      check(Number(after.plan.missed ?? 0) >= 1, `the kept start went to Claude as missed (missed ${after.plan.missed})`);
      const sent = records.filter((r) => r.type === "user" && chainTo(records, r.uuid)?.includes(point) && r.uuid !== point);
      check(sent.some((r) => textOfRecord(r).includes(kept.slice(0, 60))), "the kept start is in a record after the point");
    }
  }

  passed = failures === 0;
  console.log("\ntranscripts (left in Claude's projects folder):");
  for (const name of [P1, P2, B1, C1]) console.log(`  ${transcriptFile(name) ?? `${name} (not found)`}`);
} catch (error) {
  failures++;
  console.log(`\nSTOPPED: ${error instanceof Error ? error.message : error}`);
} finally {
  eventsController.abort();
  stopServer();
  console.log(`\n${failures === 0 && passed ? "all checks passed" : `${failures} check(s) failed`}`);
  if (failures === 0 && passed && process.env.OPENCODE_LIVE_KEEP !== "1") {
    await sleep(500);
    rmSync(root, { recursive: true, force: true });
  } else {
    console.log(`temp folder kept: ${root}`);
    if (failures > 0) console.log(`OpenCode's output (tail):\n${serverOut.slice(-1500)}`);
  }
  process.exit(failures === 0 && passed ? 0 : 1);
}
