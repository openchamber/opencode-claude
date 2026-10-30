/**
 * Turns that a topic's test file and the file of its cases that fail by a
 * finding (expected.md, `<topic>-<finding>-regression.ts`) take the same way,
 * so a case moved between the two keeps its steps. Each one is a user's turn
 * in the OpenCode simulator with Claude Code set up before it, and returns
 * what the test reads; the simulators' switches it set are reset after it.
 *
 *   failingTurn(world, failure, call)   a turn whose model call 1 or 2 (after a tool step) fails
 *   statedKind(world, failure, call)    the kind of that failure the plugin's journal names
 *   answerTurn(world, failure?)         a turn of a new chat that streams its answer (200)
 *   failFastTurn(world, ask, setup)     a turn of a new chat, Claude's next query set up by `setup`
 *   usageTurn(world, usage, setup?)     a turn of a new chat with the usage of its model calls
 *   refusedOnFable(world, modelID)      a turn on Fable 5.1 Claude Code refuses and its fallback model answers
 *   catalogFromCli(world)               the catalog OpenCode got once the plugin read the CLI's model list
 *   anotherFolderOpenedAndClosed(world) the plugin's instance of another project folder started and stopped
 *   chatInFolder(world, directory, between) turns of a chat in a project folder: OpenCode's system prompt and the plugin's append
 *   toolFilesTurn(world, ask, output, files) a tool step of a new chat whose result carries files, the parked turn resumed
 *   readWithFiles(world, files)        Claude reads a file of a new chat, the tool returns these files with its text
 *   updateWhileTool(world, update, steer) OpenCode's system update (and the user's message) while a tool of an answered chat ran
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { contentText, type ApiFailure, type ClaudeFailure } from "./claude-code.ts";
import type { ToolFile } from "./opencode.ts";
import type { World } from "./world.ts";

type TurnOptions = Parameters<World["opencode"]["turn"]>[1];

/** The limit's window passed: the plugin's limit store starts empty again. */
export const windowPassed = () => rmSync(process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE!, { force: true });

/** A failed request's error body. */
export const errorOf = (failed: { reply?: { raw?: string } }) => JSON.parse(failed.reply!.raw!).error as { code?: string; type?: string; message?: string };

/** A turn whose model call `call` (1 the first, 2 the one after the tool step) fails with `failure`. */
export async function failingTurn(world: World, failure: ApiFailure, call: 1 | 2, options: TurnOptions = {}) {
  const { opencode, claude } = world;
  const chat = opencode.newChat();
  await opencode.say(chat, "run it");
  if (call === 2) claude.state.toolTurn = true;
  claude.state.failures = [failure];
  claude.state.failingCall = call;
  const queries = claude.queries.length;
  const retries = opencode.retries.length;
  let turn: Awaited<ReturnType<typeof opencode.turn>>;
  try {
    turn = await opencode.turn(chat, options);
  } finally {
    claude.state.failures = [];
    claude.state.failingCall = 1;
    claude.state.toolTurn = false;
  }
  if (call === 2) assert.equal(turn.requests[0]!.reply!.finish, "tool_calls", `${failure}: the first call ran its tool`);
  const failed = turn.requests[call - 1]!;
  return { chat, turn, failed, queries: claude.queries.slice(queries), retries: opencode.retries.slice(retries) };
}

/** The kind the plugin's journal names for a turn that failed fast; the limit store emptied after it. */
export async function statedKind(world: World, failure: ApiFailure, call: 1 | 2) {
  const lines = world.journal().length;
  await failingTurn(world, failure, call);
  const stated = world.journal().slice(lines).find((line) => /turn failed fast/.test(line));
  windowPassed();
  return { kind: stated?.match(/"kind":"([a-z_]+)"/)?.[1], stated };
}

/** One turn of a new chat whose answer streams (200); Claude's next query fails as `failure` (none: answers). */
export async function answerTurn(world: World, failure?: ClaudeFailure) {
  const { opencode, claude } = world;
  const chat = opencode.newChat();
  await opencode.say(chat, "hi");
  claude.state.failures = failure ? [failure] : [];
  const turn = await opencode.turn(chat);
  claude.state.failures = [];
  const first = turn.requests[0]!;
  assert.equal(first.status, 200, `${failure ?? "an answer"}: ${first.reply?.raw}`);
  return { turn, reply: first.reply! };
}

/** One turn of a new chat, Claude's next query set up by `setup`: its requests, queries, retries and journal lines. */
export async function failFastTurn(world: World, ask: string, setup: () => void) {
  const { opencode, claude } = world;
  const chat = opencode.newChat();
  await opencode.say(chat, ask);
  const journalFrom = world.journal().length;
  const queriesFrom = claude.queries.length;
  const retriesFrom = opencode.retries.length;
  setup();
  try {
    const turn = await opencode.turn(chat);
    const first = turn.requests[0]!;
    const error = first.reply?.raw ? JSON.parse(first.reply.raw).error : undefined;
    return {
      chat,
      turn,
      first,
      error,
      queries: claude.queries.slice(queriesFrom),
      retries: opencode.retries.slice(retriesFrom),
      journal: world.journal().slice(journalFrom),
    };
  } finally {
    claude.state.failures = [];
    claude.state.replies = [];
  }
}

export type ReplyUsage = {
  prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number }; cost_usd?: number; model_usage?: Record<string, unknown>;
};
/** The usage OpenCode got with a request's reply. */
export const usageOf = (request: { reply?: { usage?: unknown } } | undefined) => request?.reply?.usage as ReplyUsage | undefined;

/** A turn of a new chat with `usage` for its model calls (one for every call, or a list: one entry a call). */
export async function usageTurn(world: World, usage: World["claude"]["state"]["usage"], setup: () => void = () => {}) {
  const { opencode, claude } = world;
  const chat = opencode.newChat();
  await opencode.say(chat, "count the tokens");
  claude.state.usage = usage;
  setup();
  try {
    return await opencode.turn(chat);
  } finally {
    claude.state.usage = {};
    claude.state.thinking = undefined;
    claude.state.failures = [];
    claude.state.toolTurn = false;
  }
}

/** A turn of a new chat on Fable 5.1 (`modelID`: its id in the tree's catalog) that Claude Code refuses (bio) and its fallback model answers. */
export async function refusedOnFable(world: World, modelID: string) {
  const { opencode, claude } = world;
  opencode.state.modelID = modelID;
  try {
    const chat = opencode.newChat();
    await opencode.say(chat, "question");
    claude.state.failures = ["refusal"];
    claude.state.refusalDetails = { category: "bio", fallbackAnswers: true };
    const turn = await opencode.turn(chat);
    return { chat, turn };
  } finally {
    opencode.state.modelID = undefined;
    claude.state.failures = [];
    claude.state.refusalDetails = undefined;
  }
}

/** Waits until `ready()` holds (a background step of the plugin), at most `ms`. */
export async function until(ready: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `${what}: not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The plugin instance OpenCode started first, once its catalog holds the CLI's list (refreshed in the background after setup). */
export async function catalogFromCli(world: World) {
  await until(() => world.opencode.instances[0]!.provider.models.some((m: any) => m.id === "claude-opus-4-7"), "the catalog from the CLI's list");
  return world.opencode.instances[0]!;
}

/** OpenCode opened a chat in another project, then closed it: the plugin's instance of that folder started and stopped. */
export async function anotherFolderOpenedAndClosed(world: World) {
  const directory = join(world.tmp, "another-project");
  mkdirSync(directory, { recursive: true });
  await world.opencode.stopPlugin(await world.opencode.startPlugin(undefined, { directory }));
}

/**
 * A chat in `directory` with the plugin OpenCode started there: a message and its turn, then one more after each of
 * `between`. Each turn's OpenCode system prompt (the body's first message) and the plugin's append to Claude Code's.
 */
export async function chatInFolder(world: World, directory: string, between: Array<() => void> = []) {
  const { opencode, claude } = world;
  const instance = await opencode.startPlugin(undefined, { directory });
  try {
    const chat = opencode.newChat(undefined, directory);
    const seen: Array<{ system: string; append: string }> = [];
    for (const before of [() => {}, ...between]) {
      before();
      await opencode.say(chat, "hi");
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
      seen.push({
        system: String(turn.requests[0]!.body.messages[0]!.content),
        append: String((claude.queries.at(-1)!.params.systemPrompt as { append?: string })?.append ?? ""),
      });
    }
    return seen;
  } finally {
    await opencode.stopPlugin(instance);
  }
}

/**
 * One tool step of a new chat whose bash returns `output` and `files`: the parked turn resumed with the result, the
 * user's question the only prompt, the files in no message of the user's. The blocks of the result Claude got.
 */
export async function toolFilesTurn(world: World, ask: string, output: string, files?: ToolFile[]) {
  const { opencode, claude } = world;
  const chat = opencode.newChat();
  await opencode.say(chat, ask);
  claude.state.toolSteps = [[{ name: "bash", input: { command: "cat" } }]];
  const from = claude.queries.length;
  let turn: Awaited<ReturnType<typeof opencode.turn>>;
  try {
    turn = await opencode.turn(chat, { toolOutput: output, ...(files ? { toolFiles: files } : {}) });
  } finally {
    claude.state.toolSteps = [];
  }
  assert.ok(turn.ok, `${ask}: the turn answered`);
  assert.equal(turn.requests[1]!.counted[1] - turn.requests[1]!.counted[0], 0, `${ask}: the parked turn resumed`);
  const query = claude.queries[from]!;
  // The query's input: the user's question as the one record with a turn
  // (a new transcript may open with a blank record without one, names.ts
  // TRANSCRIPT_START_NAME); the tool's files are in none of them.
  const asked = query.input.filter((message) => !message.noTurn);
  assert.deepEqual(asked.map((message) => contentText(message.content)), [ask], `${ask}: the user's question is the prompt`);
  for (const file of files ?? []) {
    assert.ok(!query.input.some((message) => contentText(message.content).includes(file.data)), `${ask}: the tool's files are not a message of the user's`);
  }
  const journal = world.journal().filter((line) => line.includes(`"conversationKey":"${chat}"`));
  assert.ok(journal.some((line) => line.includes("resuming parked bridge") && line.includes(`"resolved":1`)), `${ask}: the journal names the result going back to the parked turn`);
  assert.ok(!journal.some((line) => line.includes("forwarding mid-turn user messages")), `${ask}: the journal forwards no user message with it`);
  const results = claude.records(query.name).filter((r) => r.toolUseResult);
  assert.equal(results.length, 1);
  return results[0]!.toolUseResult as Array<Record<string, any>>;
}

/** Claude reads a file of a new chat; OpenCode's tool returns `files` with its text. The blocks of the one result Claude got. */
export async function readWithFiles(world: World, files: ToolFile[]) {
  const { opencode, claude } = world;
  const chat = opencode.newChat();
  await opencode.say(chat, "REAL-ASK read the report");
  claude.state.toolTurn = true;
  let turn: Awaited<ReturnType<typeof opencode.turn>>;
  try {
    turn = await opencode.turn(chat, { toolOutput: "Read report.pdf", toolFiles: files });
  } finally {
    claude.state.toolTurn = false;
  }
  assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
  assert.equal(turn.requests.length, 2);
  assert.equal(turn.requests[1]!.counted[1] - turn.requests[1]!.counted[0], 0, "the result with its media continues the turn: no new query");
  const query = claude.queries.at(-1)!;
  const results = claude.records(query.name).filter((r) => r.toolUseResult).map((r) => r.toolUseResult as Array<Record<string, any>>);
  assert.equal(results.length, 1, "one tool result");
  return results[0]!;
}

/**
 * A new chat with its first turn answered, then a turn whose tool run brings OpenCode's system message `update`,
 * with the user's message `steer` sent meanwhile if given: the tool's results, and what came while it ran as Claude
 * Code took it into the turn (the turn's input after the prompt).
 */
export async function updateWhileTool(world: World, update: string, steer?: string) {
  const { opencode, claude } = world;
  const chat = opencode.newChat();
  await opencode.say(chat, "fix the bug");
  assert.ok((await opencode.turn(chat)).ok);
  await opencode.say(chat, "list the files");
  claude.state.toolSteps = [[{ name: "bash", input: { command: "ls" } }]];
  const from = claude.queries.length;
  let turn: Awaited<ReturnType<typeof opencode.turn>>;
  try {
    turn = await opencode.turn(chat, {
      toolOutput: () => {
        opencode.between(chat, "system", update);
        return "a.txt";
      },
      ...(steer ? { steer } : {}),
    });
  } finally {
    claude.state.toolSteps = [];
  }
  assert.ok(turn.ok);
  assert.equal(claude.queries.length - from, 1, "the parked turn resumed with the results: one Claude Code turn");
  const query = claude.queries[from]!;
  const results = claude.records(query.name).filter((r) => r.toolUseResult).map((r) => contentText(r.toolUseResult));
  // The records a new transcript starts with have no turn of their own; then the prompt.
  const meanwhile = query.input.filter((m) => !m.noTurn).slice(1).map((m) => ({ text: contentText(m.content), priority: m.priority }));
  const records = claude.records(query.name);
  const sincePrompt = records.slice(records.findIndex((r) => r.uuid === query.trigger));
  const absorbed = sincePrompt.flatMap((r) => (r.attachment?.type === "queued_command" ? [String(r.attachment.prompt)] : []));
  assert.deepEqual(absorbed, meanwhile.map((m) => m.text), "Claude took in what the plugin sent meanwhile");
  return { chat, results, meanwhile };
}
