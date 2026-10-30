/**
 * OpenCode's utility requests (a title, a summary, a generation) on Claude
 * Code: how each request kind is told, what the one-shot query the plugin
 * starts for them carries, and what a chat turn keeps that they drop.
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): OpenCode's own title,
 * compaction and generation requests; what the CLI process got is read from
 * the Claude Code simulator's query (its arguments, environment and
 * `initialize`, read as the CLI reads them), the kind the plugin took from
 * its journal. Independent cases (test/simulators/cases.ts).
 *
 * Run: bun test/utility-turns-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { contentText } from "./simulators/claude-code.ts";
import { TITLE_SYSTEM, titleMessagePrompt } from "./simulators/opencode.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

const world = await createWorld("utility-turns");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();

/** The journal has no error line (the plugin's `level=error`). */
const noJournalErrors = (what: string) =>
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], `${what}: no error in the plugin's journal`);
/** Waits until `ready()` holds (a background step of the plugin), at most `ms`. */
const until = async (ready: () => boolean, what: string, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `${what}: not within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
// The title below runs on the catalog's Haiku 4.5: the catalog comes from the CLI's list after setup.
await until(() => opencode.instances[0]!.provider.models.some((m: any) => /^claude-haiku-4-5/.test(m.id)), "the catalog from the CLI's list");

/** A title of a new chat on the catalog's Haiku 4.5, with OpenCode's title prompt: the request and the query. */
const haikuTitle = async () => {
  const haiku = (opencode.instances[0]!.provider.models as Array<{ id: string }>).find((m) => /^claude-haiku-4-5/.test(m.id))!.id;
  const chat = opencode.newChat();
  await opencode.say(chat, "Explain how binary search trees work");
  opencode.state.modelID = haiku;
  claude.state.summaryReplies = ["Binary search trees"];
  // A token in the server's environment must not reach Claude Code.
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "must-not-leak";
  try {
    const asked = claude.queries.length;
    const titled = await opencode.title(chat);
    return { chat, titled, queries: claude.queries.length - asked, query: claude.queries.at(-1)! };
  } finally {
    if (token === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    opencode.state.modelID = undefined;
  }
};

await cases.run("a title reaches Claude Code isolated from MCP and connectors, without a transcript", async () => {
  const chat = opencode.newChat();
  await opencode.say(chat, "Name this chat");
  const titled = await opencode.title(chat);
  assert.equal(titled.requests[0]?.status, 200);
  // What the CLI process got from the plugin's starter through the SDK: isolated from the user's MCP servers
  // (`--strict-mcp-config`) and claude.ai connectors (`settings.disableClaudeAiConnectors`), no transcript
  // (`--no-session-persistence`), thinking shown as summaries unless it is off.
  const params = claude.queries.at(-1)!.params as Record<string, any>;
  assert.equal(params.strictMcpConfig, true);
  assert.equal(params.settings?.disableClaudeAiConnectors, true);
  assert.equal(params.persistSession, false);
  if (params.thinking?.type !== "disabled") {
    assert.equal(params.settings?.showThinkingSummaries, true);
    const args = params.args as string[];
    assert.ok(args.includes("--thinking-display=summarized") || args.join(" ").includes("--thinking-display summarized"), args.join(" "));
  }
  assert.equal(claude.queries.at(-1)!.kind, "summary", "nothing written: a query without a transcript");
  assert.ok(world.journal().some((line) => /chat completions .*"metaKind":"title"/.test(line)), "the plugin took it as a title");
});

await cases.run("a generation carries OpenCode's system prompt as instructions ahead of its prompt", async () => {
  const chat = opencode.newChat();
  await opencode.say(chat, "a change");
  await opencode.turn(chat);
  const generated = await opencode.generate(chat, "Write a commit message");
  assert.equal(generated.failure, undefined, "the generation answered");
  const [prompt] = claude.queries.at(-1)!.input.map((message) => contentText(message.content));
  // OpenCode's system prompt of the generation (session/generate.ts: the session's, as for a turn).
  const system = String(generated.body.messages[0]!.content);
  assert.match(system, /^You are an AI agent running in OpenCode/);
  assert.ok(prompt!.startsWith(`<instructions>\n${system}\n</instructions>\n\n`), `the instructions ahead: ${prompt!.slice(0, 200)}`);
  assert.match(prompt!, /Write a commit message$/);
});

await cases.run("request kinds: a chat turn, a title, a summary, a generation in a chat and Generate.text", async () => {
  // Generate.text has no session and no hook: no header of the plugin's.
  const { requestKeyNamespace } = await pluginModule("request-kind");
  assert.equal(requestKeyNamespace("title"), "title:");
  assert.equal(requestKeyNamespace(null), "");
  /** The kind the plugin took each request since journal line `from` for. */
  const kindsSince = (from: number) =>
    world
      .journal()
      .slice(from)
      .flatMap((line) => (/\] chat completions /.test(line) ? [JSON.parse(line.slice(line.indexOf("{"))) as { conversationKey: string; metaKind: string | null }] : []));
  const chat = opencode.newChat();
  const from = world.journal().length;
  await opencode.say(chat, "Write a commit message");
  assert.ok((await opencode.turn(chat)).ok, "the turn answered");
  await opencode.title(chat);
  assert.equal((await opencode.compact(chat)).status, "completed");
  await opencode.generate(chat, "Write a commit message");
  await opencode.generateText("Write a commit message");
  const kinds = kindsSince(from);
  assert.deepEqual(kinds.map((k) => k.metaKind), [null, "title", "summary", "generate", "generate"]);
  assert.deepEqual(kinds.slice(0, 4).map((k) => k.conversationKey), [chat, `title:${chat}`, `summary:${chat}`, `generate:${chat}`]);
  assert.match(kinds[4]!.conversationKey, /^generate:req_/, "a generation of no chat is keyed by itself");
});

await cases.run("a chat turn keeps the user's Claude Code memory", async () => {
  // Only utility turns drop it (the title below).
  const chat = opencode.newChat();
  await opencode.say(chat, "question");
  const turn = await opencode.turn(chat);
  assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
  const env = claude.queries.at(-1)!.params.env as Record<string, unknown>;
  assert.equal(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
});

await cases.run("a title on Haiku 4.5 is a constrained tool-free one-shot query with OpenCode's title prompt", async () => {
  // OpenCode titles a chat on the catalog's Haiku 4.5, with its own title prompt.
  const { chat, titled, queries, query } = await haikuTitle();
  assert.equal(titled.requests[0]?.status, 200);
  assert.ok(!titled.requests[0]?.reply?.streamError, "the stream ended with [DONE]");
  assert.equal(titled.title, "Binary search trees");
  assert.equal(queries, 1, "title request reached Agent SDK");
  const titleOptions = query.params as Record<string, any>;
  assert.equal(titleOptions.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(titleOptions.tools, []);
  assert.deepEqual(titleOptions.settingSources, []);
  assert.equal(titleOptions.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.deepEqual(titleOptions.skills, []);
  assert.equal(titleOptions.maxTurns, 1);
  assert.match(String(titleOptions.model), /^claude-haiku-4-5/);
  assert.equal(titleOptions.effort, undefined);
  assert.equal(titleOptions.persistSession, false);
  assert.equal(titleOptions.strictMcpConfig, true);
  assert.equal(titleOptions.settings?.disableClaudeAiConnectors, true);
  assert.deepEqual(titleOptions.thinking, { type: "disabled" });
  assert.equal(titleOptions.resume, undefined);
  // Utility turns get a one-line prompt that names the host
  assert.match(String(titleOptions.systemPrompt), /^You are a text generation helper running in OpenCode through the Claude Code harness\./);
  // The host's title prompt leads; the built-in wording is only a fallback. OpenCode 2.2.0 wraps the first message
  // in its own request text (title.ts); that text goes to Claude as OpenCode sent it.
  const prompt = query.input.map((message) => contentText(message.content)).join("\n");
  assert.equal(prompt, `<instructions>\n${TITLE_SYSTEM}\n</instructions>\n\n${titleMessagePrompt("Explain how binary search trees work")}`);
  assert.doesNotMatch(prompt, /3-7 word/);
  assert.ok(
    world.journal().some((line) => /chat completions /.test(line) && line.includes(`"conversationKey":"title:${chat}"`) && line.includes(`"toolCount":0`)),
    "the journal has the title request, with no tools",
  );
  noJournalErrors("a title");
});

await cases.run("a one-shot query turns the CLI's auto compaction off", async () => {
  // The setting the CLI reads (`settings.autoCompactEnabled`).
  const { titled, query } = await haikuTitle();
  assert.equal(titled.requests[0]?.status, 200);
  assert.equal((query.params as Record<string, any>).settings?.autoCompactEnabled, false, "the CLI's auto compaction is off");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
