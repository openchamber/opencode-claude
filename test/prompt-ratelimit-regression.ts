/**
 * Regressions for prompt conversion and the rate-limit gate:
 * - a limit error after an unrelated `allowed` window event blocks only for
 *   the short fallback, never until that window's (days-away) reset; a recent
 *   `rejected` event does vouch for its reset;
 * - an SDK error flagged `rate_limit` is a limit: 429 + Retry-After, also on
 *   the model call after a tool step;
 * - hours-only ("resets 5pm (UTC)") and midnight reset times parse;
 * - PDFs in tool results are forwarded (URL media leaves a note:
 *   prompt-ratelimit-url-note-regression.ts);
 * - an answered user message never becomes the prompt again, a tool's
 *   media is not a user turn, and the output after it is not dropped.
 *
 * Ported from the fork's 62a8f7c (its transcript-truncation and meta
 * classification cases cover changes not ported here).
 *
 * On the simulators (test/simulators/): the chat parts are a user in
 * OpenCode 2.0.32 (a tool's files stay on its result in the list the hooks
 * get and go as one user message after the tool results in the HTTP body;
 * an attachment as a media part) and Claude Code 2.1.312's 429
 * (`state.failures` `rateLimit`); a model call after a tool step that fails:
 * `state.failingCall`; a process that dies while its tool call runs:
 * `failures` `killedWhileTool`; the window events of the API's rate-limit
 * headers: `state.rateLimitEvents` (the CLI's `rate_limit_event`, on a
 * sign-in by subscription: BEHAVIOR.md "Rate-limit windows"), on an answered turn
 * before the chat's turn that hits the limit. The reset wordings and the
 * limit texts are checked on the plugin's parser
 * (`pluginModule("rate-limit")`). The old case of a `file://` image in a
 * user message is gone: OpenCode 2.0.32 takes the file's bytes, so that form
 * never reaches the plugin. After each limit case the plugin's limit store is
 * emptied: the window has passed. Each chat case is a chat of its own.
 *
 * Run: bun test/prompt-ratelimit-regression.ts
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { contentText } from "./simulators/claude-code.ts";
import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { readWithFiles } from "./simulators/turns.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

const MINUTE = 60_000;

async function main() {
  const world = await createWorld("prompt-rl");
  const { opencode, claude } = world;
  const rateLimit = await pluginModule("rate-limit");
  const cases = testCases();
  /** The limit's window passed: the plugin's limit store starts empty again. */
  const windowPassed = () => rmSync(process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE!, { force: true });
  /** A case that makes a limit: the CLI fails no more and the window passes after it, whatever its outcome. */
  const limitCase = (name: string, body: () => Promise<void>) =>
    cases.run(name, async () => {
      try {
        await body();
      } finally {
        claude.state.failures = [];
        claude.state.failingCall = 1;
        claude.state.rateLimitEvents = [];
        windowPassed();
      }
    });
  try {
    // --- The limit texts and reset wordings Claude Code writes
    await cases.run("a stray 429 is not a limit message, an API 429 and a weekly limit are", () => {
      assert.equal(rateLimit.isClaudeRateLimitText("upstream returned 429"), false);
      assert.equal(rateLimit.isClaudeRateLimitText("wrote 4290 bytes, line 429"), false);
      assert.equal(rateLimit.isClaudeRateLimitText("API Error: 429 Internal hiccup"), true);
      assert.equal(
        rateLimit.isClaudeRateLimitText('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'),
        true,
      );
      assert.equal(rateLimit.isClaudeRateLimitText("You've hit your weekly limit · resets Oct 6, 1pm (UTC)"), true);
    });

    await cases.run("hours-only and midnight resets parse at every 5-minute scan phase", () => {
      const base = Date.UTC(2026, 0, 1, 10, 0);
      const fivePm = rateLimit.parseResetTimeFromText("You've hit your session limit · resets 5pm (UTC)", base);
      assert.ok(fivePm !== undefined, "hours-only reset must parse");
      assert.ok(Math.abs(fivePm! - Date.UTC(2026, 0, 1, 17, 0)) <= 2 * MINUTE);
      const midnight = Date.UTC(2026, 0, 2, 0, 0);
      for (let phase = 0; phase < 5; phase++) {
        const now = Date.UTC(2026, 0, 1, 20, phase);
        for (const text of ["resets 12am (UTC)", "resets 12:00am (UTC)"]) {
          const parsed = rateLimit.parseResetTimeFromText(text, now);
          assert.ok(parsed !== undefined, `${text} missed at phase ${phase}`);
          assert.ok(Math.abs(parsed! - midnight) <= 2 * MINUTE, `${text} phase ${phase}`);
        }
      }
    });

    await cases.run("time-only resets land on the exact wall time, a time already past today is tomorrow", () => {
      for (let phase = 0; phase < 7; phase++) {
        const now = Date.UTC(2026, 8, 26, 12, phase); // 15:0x in Kyiv (UTC+3)
        assert.equal(rateLimit.parseResetTimeFromText("resets 11:59pm (Europe/Kyiv)", now), Date.UTC(2026, 8, 26, 20, 59), `Kyiv phase ${phase}`);
      }
      assert.equal(rateLimit.parseResetTimeFromText("resets 9:30am (UTC)", Date.UTC(2026, 8, 26, 10, 0)), Date.UTC(2026, 8, 27, 9, 30));
    });

    await opencode.startPlugin();

    await cases.run("an image alone after an answered question is the prompt, never the answered question", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "OLD-QUESTION");
      assert.ok((await opencode.turn(chat)).ok);
      await opencode.say(chat, "", [{ mediaType: "image/png", data: testPng("shot", 2, 2) }]);
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok);
      const prompt = claude.queries.at(-1)!.input.map((m) => contentText(m.content)).join("\n");
      assert.match(prompt, /^\[image /, "the image is the prompt");
      assert.doesNotMatch(prompt, /OLD-QUESTION/, "must not fall back to an answered user message");
    });

    // --- Tool results: a tool's media is tool output, not a user turn.
    await cases.run("a PDF in a tool result reaches Claude with the tool's text", async () => {
      const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
      const result = await readWithFiles(world, [{ mime: "application/pdf", data: pdf, name: "report.pdf" }]);
      const document = result.find((b) => b.type === "document");
      assert.ok(document, `the PDF reached Claude: ${JSON.stringify(result).slice(0, 300)}`);
      assert.equal(document.source.media_type, "application/pdf");
      assert.equal(document.source.data, pdf);
      assert.ok(result.some((b) => b.type === "text" && b.text === "Read report.pdf"), "with the tool's text");
    });

    await limitCase("a 429 with no window events blocks for the short fallback, OpenCode waits that long", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "hi");
      claude.state.failures = ["rateLimit"];
      const queries = claude.queries.length;
      const retries = opencode.retries.length;
      const turn = await opencode.turn(chat);
      claude.state.failures = [];
      const first = turn.requests[0]!;
      assert.equal(first.status, 429, first.reply?.raw);
      assert.equal(JSON.parse(first.reply!.raw!).error.code, "claude_session_limit");
      const retryAfter = Number(first.reply!.headers.get("retry-after"));
      assert.ok(retryAfter >= 9 * 60 && retryAfter <= 10 * 60, `the fallback block: ${retryAfter} s`);
      assert.ok(opencode.retries[retries]!.delay >= retryAfter * 1000, "OpenCode waits at least the Retry-After");
      assert.equal(claude.queries.length - queries, 1, "the gate answers OpenCode's retries without a doomed CLI turn");
      assert.ok(world.journal().some((line) => /turn failed fast/.test(line) && /"kind":"rate_limit"/.test(line)));
    });

    await limitCase("a limit on the call after a tool step is a real 429 with Retry-After, recorded for the gate", async () => {
      // As before any content.
      const chat = opencode.newChat();
      await opencode.say(chat, "run it");
      claude.state.toolTurn = true;
      claude.state.failures = ["rateLimit"];
      claude.state.failingCall = 2;
      const queries = claude.queries.length;
      const turn = await opencode.turn(chat);
      claude.state.failures = [];
      const [step, after] = turn.requests;
      assert.equal(step!.reply!.finish, "tool_calls", "the first call ran its tool");
      assert.equal(after!.status, 429, `the continuation is a real HTTP error: ${after!.reply?.raw}`);
      assert.equal(JSON.parse(after!.reply!.raw!).error.code, "claude_session_limit");
      assert.ok(Number(after!.reply!.headers.get("retry-after")) > 0, "with Retry-After");
      assert.equal(turn.failure?.kind, "rate-limit", "OpenCode reads it as a rate limit");
      assert.ok(turn.failure?.retryable, "a retryable one");
      assert.equal(claude.queries.length - queries, 1);
      assert.equal(rateLimit.getRateLimitSnapshot().limited, true, "the plugin recorded the limit for its gate");
    });

    await cases.run("the process died while its tool ran: the step goes with its result and image, the media is not a user turn", async () => {
      // The output after a tool's media (the stand-in for a user message in
      // the old body form) is not dropped: the plugin resumes the transcript
      // (it holds SECOND) and relays the step with its result and image.
      const chat = opencode.newChat();
      await opencode.say(chat, "FIRST");
      assert.ok((await opencode.turn(chat)).ok);
      await opencode.say(chat, "SECOND");
      claude.state.toolTurn = true;
      claude.state.failures = ["killedWhileTool"];
      const look = testPng("look");
      let turn: Awaited<ReturnType<typeof opencode.turn>>;
      try {
        turn = await opencode.turn(chat, { toolOutput: "LOOKING-RESULT", toolFiles: [{ mime: "image/png", data: look }] });
      } finally {
        claude.state.failures = [];
      }
      assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
      assert.doesNotMatch(turn.answer!.text, /\[claude-code error\]/, "the answer is Claude's, not the dead process's error");
      const query = claude.queries.at(-1)!;
      assert.match(query.view, /LOOKING-RESULT/, "the tool's output after its media reaches Claude");
      const prompt = query.input.filter((m) => !m.noTurn).map((m) => contentText(m.content)).join("\n");
      assert.match(prompt, /^<tool_results>[\s\S]*LOOKING-RESULT[\s\S]*<\/tool_results>/, "the prompt relays the tool step");
      assert.ok(prompt.indexOf(look) > prompt.indexOf("LOOKING-RESULT") && prompt.indexOf(look) < prompt.indexOf("</tool_results>"), "the image stays inside the tool's result");
      assert.doesNotMatch(prompt, /The user sent the following after those calls/, "a tool's media is not a user turn");
      assert.equal(query.view.match(/SECOND/g)?.length, 1, "SECOND, the newest real user message, reaches Claude once");
      assert.ok(query.view.indexOf("SECOND") < query.view.indexOf("<tool_results>"), "before the step it asked for");
      assert.doesNotMatch(prompt.replace(/<conversation_history>[\s\S]*<\/conversation_history>/, ""), /FIRST|SECOND/, "never an older one, nor SECOND again");
    });

    /** A turn answered with these window events, then the chat's next turn fails with a 429; that turn's first request. */
    const limitAfterWindow = async (events: Array<Record<string, unknown>>) => {
      const chat = opencode.newChat();
      await opencode.say(chat, "hi");
      claude.state.rateLimitEvents = events;
      assert.ok((await opencode.turn(chat)).ok);
      await opencode.say(chat, "more");
      claude.state.failures = ["rateLimit"];
      const turn = await opencode.turn(chat);
      claude.state.failures = [];
      return turn.requests[0]!;
    };

    await limitCase("a limit after an unrelated allowed window event blocks for the short fallback, not that window's reset", async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const first = await limitAfterWindow([{ status: "allowed", rateLimitType: "seven_day", resetsAt: nowSec + 5 * 24 * 3600, utilization: 0.4, isUsingOverage: false }]);
      assert.equal(rateLimit.getRateLimitSnapshot().rateLimitType, "seven_day", "the window event reached the plugin");
      assert.equal(first.status, 429, first.reply?.raw);
      const retryAfter = Number(first.reply!.headers.get("retry-after"));
      assert.ok(retryAfter <= 10 * 60, `the block must not extend to the seven_day reset: ${retryAfter} s`);
      assert.ok(retryAfter >= 9 * 60);
    });

    await limitCase("a recent rejected window event vouches for its reset", async () => {
      const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
      const first = await limitAfterWindow([{ status: "rejected", rateLimitType: "five_hour", resetsAt, isUsingOverage: false }]);
      assert.equal(first.status, 429, first.reply?.raw);
      const retryAfter = Number(first.reply!.headers.get("retry-after"));
      assert.ok(Math.abs(Date.now() + retryAfter * 1000 - resetsAt * 1000) <= 2 * MINUTE, `blocked until the rejected window's reset: ${retryAfter} s`);
    });

    await cases.run("no error in the plugin's journal", () => {
      assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    });
  } finally {
    await world.dispose();
  }
  cases.done();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
