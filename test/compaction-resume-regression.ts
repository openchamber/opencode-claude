/**
 * Regression: OpenCode's compaction summary was written by haiku from a
 * text copy of the chat cut to 400k characters, with every tool result cut
 * to 1000. On a long chat it saw a fraction of the conversation. The summary
 * now resumes an in-memory fork of the chat's Claude session, cut where the
 * summarized part ends, on the chat's model with the chat turn's system
 * prompt and tools (same prompt cache), and nothing is written to it.
 * - A reminder after a reply that missed the template resumes at the same
 *   point with the summary prompt.
 * - A chat with no resumable session gets the history as text, sized to the
 *   chat model, still on the chat's model.
 * - The summary leaves the chat's binding (1.7.0): the compacted history the
 *   next turn carries matches none of the session's turns, so that turn
 *   starts a new session.
 *
 * On the simulators (test/simulators/): three turns, then OpenCode compacts
 * the chat (`opencode.compact`: OpenCode 2.2.0 summarizes the whole chat when
 * it fits, its summary prompt after it, the reminder when a reply skips the
 * template — `summaryReplies`), so the summarized part ends at the third
 * answer; the summary's query is the one with `persistSession: false`. A chat
 * whose turns another model answered (`otherModelAnswer`) has no Claude
 * session to resume.
 *
 * main's summary: the session by its id, cut at the answer's own record;
 * from chain/turn-by-names the transcript is named after the chat, the cut
 * is the record a question's record continues, and the chat starts a new
 * epoch after the compaction (compaction-resume-regression.ts).
 *
 * Run: bun test/compaction-resume-main-regression.ts
 */
import assert from "node:assert/strict";

import { contentText, type ClaudeQuery } from "./simulators/claude-code.ts";
import { SUMMARY_NUDGE, SUMMARY_PROMPT } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

/** The text of a query's prompt messages, in order. */
const promptOf = (query: ClaudeQuery) => query.input.map((m) => contentText(m.content)).join("\n");

async function main() {
  const world = await createWorld("compaction-resume");
  const { opencode, claude } = world;
  const summaries = () => claude.queries.filter((q) => q.kind === "summary");
  const chats = () => claude.queries.filter((q) => q.kind === "chat");
  /** A chat of three turns Claude answered; returns it with the answers of the second and the third turn. */
  const threeTurns = async () => {
    const chat = opencode.newChat();
    const tokens: string[] = [];
    for (const text of ["one", "two", "three"]) {
      await opencode.say(chat, text);
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok, `${text}: the turn answered`);
      tokens.push(turn.answer!.text.replace(/^answer /, ""));
    }
    return { chat, second: claude.answers.get(tokens[1]!)!, third: claude.answers.get(tokens[2]!)! };
  };

  try {
    await opencode.startPlugin();
    {
      const { chat, second, third } = await threeTurns();
      const chatParams = chats().at(-1)!.params as Record<string, any>;
      const asked = summaries().length;
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      assert.equal(summaries().length, asked + 1, "one summary query");
      const summary = summaries().at(-1)!;
      const params = summary.params as Record<string, any>;
      // OpenCode 2.2.0 summarizes the whole chat: the part ends at the third answer.
      assert.equal(params.resume, third.name, "resumes the chat's Claude session");
      assert.equal(params.resumeSessionAt, third.uuid, "cut where the summarized part ends");
      assert.equal(params.forkSession, true);
      assert.equal(params.persistSession, false, "nothing written to the session");
      assert.equal(params.model, chatParams.model, "the chat's model, not haiku");
      assert.deepEqual(params.systemPrompt, chatParams.systemPrompt, "same system prompt as the chat turn");
      assert.ok(params.mcpServers, "same tools as the chat turn");
      assert.equal(params.permissionMode, "dontAsk", "tool calls are refused");
      // No OpenCode tool allowed ahead (the SDK itself allows "Skill" for the chat's skills; no built-in tool is on).
      assert.deepEqual((params.allowedTools ?? []).filter((tool: string) => tool.startsWith("mcp__")), [], `no tool allowed ahead: ${params.allowedTools}`);
      assert.equal(params.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined, "keeps the chat's memory");
      const text = promptOf(summary);
      assert.ok(text.includes(SUMMARY_PROMPT), "the summary prompt reaches Claude");
      assert.ok(!text.includes("<conversation_history>"), "no text copy of the chat");
      assert.match(summary.view, /one[\s\S]*answer L1[\s\S]*two[\s\S]*answer L2[\s\S]*three[\s\S]*answer L3/, "Claude read the summarized part from its session");
      assert.ok(!claude.records(second.name).some((r) => contentText(r.message?.content).includes(SUMMARY_PROMPT)), "the summary left no record in the chat's transcript");

      // The summary leaves the binding; the compacted history the next turn carries starts a new session.
      await opencode.say(chat, "four");
      const after = await opencode.turn(chat);
      assert.ok(after.ok);
      const next = chats().at(-1)!;
      assert.notEqual(next.params.resume, second.name, "the turn after the compaction does not resume the old session");
      assert.notEqual(next.name, second.name);
    }

    // No Claude session for this chat: the history goes as text, on the chat's model.
    {
      const model = chats().at(-1)!.params.model;
      const chat = opencode.newChat();
      for (const n of ["ONE", "TWO", "THREE"]) {
        await opencode.say(chat, `OTHER-ASK-${n}`);
        opencode.otherModelAnswer(chat, `OTHER-ANSWER-${n}`);
      }
      const asked = summaries().length;
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      const summary = summaries().at(-1)!;
      assert.equal(summaries().length, asked + 1);
      assert.equal(summary.params.resume, undefined, "nothing to resume");
      assert.equal(summary.params.model, model, "the chat's model");
      assert.equal((summary.params as Record<string, any>).env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1", "no memory in a text-copy summary");
      const text = promptOf(summary);
      assert.ok(text.includes("<conversation_history>"), "the history as text");
      assert.ok(text.includes("OTHER-ANSWER-TWO"), "the summarized part's answers in it");
      assert.ok(text.includes(SUMMARY_PROMPT));
    }
    const fromSession = (lines: string[]) => lines.filter((line) => /summarizing from the chat's Claude session/.test(line)).length;
    const fromText = (lines: string[]) => lines.filter((line) => /summarizing from the history text/.test(line)).length;
    assert.equal(fromSession(world.journal()), 1, "the journal: the first summary from the session");
    assert.equal(fromText(world.journal()), 1, "the journal: the other chat's summary from text");

    // Another chat, with a reminder after a reply that missed the template.
    {
      const { chat, third } = await threeTurns();
      const asked = summaries().length;
      const seen = world.journal().length;
      claude.state.summaryReplies = ["not a summary", "## Objective\n- after the reminder"];
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
      assert.equal(done.requests.length, 2, "the summary, then the reminder");
      const [first, reminded] = summaries().slice(asked);
      assert.ok(first && reminded, "two summary queries");
      assert.equal(first.params.resumeSessionAt, third.uuid);
      const lines = world.journal().slice(seen);
      assert.deepEqual([fromSession(lines), fromText(lines)], [2, 0], "the journal: the summary and its reminder both from the session");
      assert.equal(reminded.params.resume, third.name, "the reminder resumes the chat's Claude session");
      assert.equal(reminded.params.resumeSessionAt, first.params.resumeSessionAt, "the reminder resumes at the same point");
      const text = promptOf(reminded);
      assert.ok(text.includes(SUMMARY_PROMPT), "the summary prompt, not only the reminder");
      assert.ok(!text.includes("<conversation_history>"), "no text copy of the chat");
      assert.ok(!contentText(reminded.input[0]?.content).startsWith(SUMMARY_NUDGE), "the prompt starts with the summary prompt, not the reminder");
    }

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — compaction resume regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
