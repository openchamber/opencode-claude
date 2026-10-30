/**
 * Regression (#70): with background compaction OpenCode writes the summary
 * while the chat goes on, often with its turn parked on a tool call. The
 * summary stopped that turn and dropped the chat's Claude session, so the
 * chat started one fresh session right away and another when the summary
 * was swapped in, each re-reading the whole context.
 * - The summary leaves the live turn running and the binding in place.
 * - It resumes the session at the end of the turn before the live one (the
 *   live turn ends on an unanswered call no resume can cut at) and reads the
 *   live turn's messages as text.
 * - The chat's own results continue its turn: no new Claude query for it;
 *   the next turn resumes the same session, and the summary swapped in later
 *   moves the chat to one new query, with no second summary.
 *
 * On the simulators (test/simulators/): OpenCode 2.2.0 with
 * `experimental.background_compaction` (`opencode.state.backgroundCompaction`,
 * a ceiling of 100 000 tokens through `compactionBuffer`; BEHAVIOR.md
 * "Compaction"). The tool step's answer reports 90 000 tokens, over 85% of
 * the ceiling: at the start of the step's continuation OpenCode starts a
 * summary in the background, of the messages before that answer (the latest
 * measured one, so the call and its result are not in it), and sends the
 * continuation at the same time. The continuation's model call stalls
 * (`claude.state.stallBeforeStop`) until the summary is written, so the
 * summary meets the chat's turn live whichever request reaches the plugin
 * first. A later answer past the ceiling makes OpenCode swap the written
 * summary in.
 *
 * Run: bun test/compaction-live-turn-regression.ts
 */
import assert from "node:assert/strict";

import { contentText, type ClaudeQuery } from "./simulators/claude-code.ts";
import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("compaction-live-turn");
  const { opencode, claude } = world;
  try {
    const instance = await opencode.startPlugin();
    const window = (instance.provider.models as any[]).find((m) => m.id === opencode.state.modelID || /sonnet/.test(m.id))!.limit.context as number;
    // A ceiling of 100 000 tokens (2.2.0: the window less the buffer, when the buffer is smaller than the window).
    Object.assign(opencode.state, { compactionBuffer: window - 100_000, backgroundCompaction: true });
    const chats = () => claude.queries.filter((q) => q.kind === "chat");
    const summaries = () => claude.queries.filter((q) => q.kind === "summary");

    const chat = opencode.newChat();
    await opencode.say(chat, "hello");
    const first = await opencode.turn(chat);
    assert.ok(first.ok, "the first turn answered");
    const firstAnswer = claude.answers.get(first.answer!.text.replace(/^answer /, ""))!;
    assert.ok(firstAnswer, "the first answer's record");
    assert.equal(opencode.backgroundSummaries.length, 0, "a small chat: nothing written in the background");

    // The live turn: a tool step measured at 90% of the ceiling.
    await opencode.say(chat, "find the needle");
    claude.state.toolSteps = [[{ name: "bash", input: { command: "rg needle" } }]];
    claude.state.usage = { input_tokens: 90_000 };
    const from = claude.queries.length;
    let atSummary: { outcome: string; closed: boolean; ended: boolean } | undefined;
    /** Settles once OpenCode's background summary of this chat is written; notes the chat's query as it was then. */
    const summaryWritten = async () => {
      const deadline = Date.now() + 10_000;
      while (!opencode.backgroundSummaries.some((s) => s.chat === chat) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      await opencode.backgroundSummaries.find((s) => s.chat === chat)?.summary;
      const query = claude.queries.slice(from).find((q) => q.kind === "chat");
      if (query) atSummary = { outcome: query.outcome, closed: query.closedAt !== undefined, ended: query.endedAt !== undefined };
    };
    const live = await opencode.turn(chat, {
      toolOutput: () => {
        // The continuation's model call waits until the summary is written: the summary meets the turn live.
        claude.state.stallBeforeStop = summaryWritten();
        return "src/needle.ts:1";
      },
    });
    claude.state.usage = {};
    assert.ok(live.ok, `the live turn answered: ${live.requests.map((r) => r.status).join(",")}`);
    assert.equal(live.requests[0]!.reply!.finish, "tool_calls");
    assert.equal(live.compactions.length, 0, "no compaction due while it ran");

    const held = opencode.backgroundSummaries.find((s) => s.chat === chat);
    assert.ok(held, "OpenCode wrote a summary in the background during the tool step");
    const written = await held.summary;
    assert.ok("text" in written, `the summary was written: ${JSON.stringify(written)}`);
    assert.deepEqual(held.requests[0]!.list.map((m) => m.role), ["user", "assistant", "user"], "the messages before the measured answer");

    const fresh = claude.queries.slice(from);
    const turnQueries = fresh.filter((q) => q.kind === "chat");
    const summaryQueries = fresh.filter((q) => q.kind === "summary");
    assert.equal(summaryQueries.length, 1, "one summary query");
    assert.equal(turnQueries.length, 1, "the step and its continuation in one Claude query: no new one for the chat");
    const turnQuery = turnQueries[0]!;
    const summary = summaryQueries[0]!;
    assert.ok(atSummary, "the chat's query was there when the summary was written");
    assert.notEqual(atSummary.outcome, "stopped", "the summary leaves the live turn running");
    assert.equal(atSummary.closed, false, "the chat's process is not closed by the summary");
    assert.equal(turnQuery.outcome, "answered", "the chat's own results continue its turn");

    // The summary resumes the chat's session at the end of the turn before the live one: its chain holds the first
    // answer and nothing of the live turn.
    assert.equal(summary.params.resume, turnQuery.name, "the summary resumes the chat's session");
    assert.ok(summary.at, "at a record of the session");
    const upTo = claude.chainTo(turnQuery.name, summary.at!);
    assert.ok(upTo.some((r) => r.uuid === firstAnswer.uuid), "the turn before the live one is in the resumed part");
    assert.ok(!upTo.some((r) => contentText(r.message?.content).includes("find the needle")), "the live turn is not: it ends on an unanswered call");
    const text = summary.input.map((m) => contentText(m.content)).join("\n");
    assert.match(text, /find the needle/, "the live turn's message is read as text");
    assert.ok(text.includes(contentText(held.requests[0]!.body!.messages.at(-1)!.content)), "OpenCode's summary prompt follows it");
    assert.ok(!text.includes("src/needle.ts:1"), "the step OpenCode left out of the summary does not reach it");
    assert.match(summary.view, /hello/, "Claude read the turn before from its session");

    const journal = world.journal();
    assert.ok(journal.some((line) => /summarizing from the chat's Claude session.*"liveTurn":true/.test(line)), "the journal: the summary from the session, the turn live");
    assert.ok(!journal.some((line) => line.includes("stopped the turn of a chat being compacted")), "the summary stops nothing");

    // The binding stayed: the next turn resumes the same session. Its answer passes the ceiling.
    await opencode.say(chat, "and the haystack?");
    claude.state.usage = { input_tokens: 101_000 };
    const third = await opencode.turn(chat);
    claude.state.usage = {};
    assert.ok(third.ok, `the next turn answered: ${third.requests.at(-1)?.status}`);
    assert.equal(third.compactions.length, 0, "not compacted yet");
    const thirdQuery = chats().at(-1)! as ClaudeQuery;
    assert.equal(thirdQuery.params.resume, turnQuery.name, "the next turn resumes the chat's session");

    // Past the ceiling: OpenCode swaps the summary in, and the compacted chat moves to one new Claude query.
    const summariesBefore = summaries().length;
    const mark = claude.queries.length;
    await opencode.say(chat, "thanks");
    const fourth = await opencode.turn(chat);
    assert.ok(fourth.ok, `the turn after the compaction answered: ${fourth.requests.at(-1)?.status}`);
    assert.equal(fourth.compactions[0]?.status, "completed", "compacted before the request");
    assert.equal(summaries().length, summariesBefore, "no summary written again: the one from the background");
    const after = claude.queries.slice(mark).filter((q) => q.kind === "chat");
    assert.equal(after.length, 1, "one Claude query for the compacted chat");
    assert.notEqual(after[0]!.name, turnQuery.name, "the compacted chat leaves the uncompacted session");

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("compaction-live-turn regression ok");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
