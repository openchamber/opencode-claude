/**
 * Regression: failed turns report what actually went wrong.
 * - A context overflow is a 400 context_length_exceeded that OpenCode
 *   compacts on; an image error is a non-retryable 400; an account decision
 *   (billing) is a 402 OpenCode does not retry.
 * - A lost transcript is noticed and the history goes to a new one; one the
 *   CLI reports lost (gone when the CLI loads it) moves the chat to the
 *   next transcript version.
 * - Two cases fail by a finding and live in files of their own until it is
 *   fixed: an error the SDK reports twice (result event and iterator throw)
 *   shows once — turn-error-noted-twice-regression.ts; a meta request that
 *   hits its one-step limit says so plainly —
 *   turn-errors-title-max-turns-regression.ts.
 * - A CLI that did not start is a retryable 500 and drops the memoized CLI
 *   path, so OpenCode's retry looks for the CLI again.
 *
 * The series' behaviour, from chain/turn-by-names on (transcripts by name,
 * the journal's words for a lost one); main's and the earlier steps' is
 * turn-errors-main-regression.ts.
 *
 * On the simulators (test/simulators/): each failure as Claude Code 2.1.312
 * reports it (`state.failures`, `summaryFailures`; BEHAVIOR.md "Failures of a
 * model call"): a synthetic error record, a `success` result with
 * `is_error`, then the SDK's throw. The lost transcript: its file is gone
 * from Claude's profile. The transcript the CLI reports lost: its file is
 * removed while the CLI starts (`state.holdStart`, the start held before
 * the plugin's starter runs: `claude.heldStarts`), after the plugin read it,
 * and the CLI refuses it ("No conversation found"). The CLI's "[ede_diagnostic]"
 * lines come with the error result of an interrupted turn: the user stops a
 * turn while it streams. The old cases of an overflow reported as
 * `error_during_execution` with only diagnostics are gone: CLI 2.1.312
 * reports it as `success` + `is_error`. The launch failure: the texts the
 * Agent SDK and Bun give are checked by the plugin's own
 * `isClaudeLaunchFailure`; the turn goes through the plugin's real query
 * starter and the real SDK (`turnThroughRealSdk`) after the launcher the
 * plugin memoized is gone, so the SDK itself names the missing executable
 * (the official installer's binary, memoized at setup); OpenCode's retry
 * should find the CLI where it is then. On Windows also npm's older
 * `cli.js`, which the SDK runs through node: node itself reports the missing
 * module.
 *
 * The image error is the API's 400 "image exceeds 5 MB maximum", which CLI
 * 2.1.312 reports as "Image was too large. Try resizing the image or using a
 * different approach." (`terminal_reason: "image_error"`, probe case "400
 * image too large"): a 400 on every tree. The 413 "Request too large (max
 * 32MB)…" is a different failure, the request's size, not an image's:
 * request-too-large-regression.ts.
 *
 * Run: bun test/turn-errors-regression.ts
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { testCases } from "./simulators/cases.ts";
import type { ClaudeFailure } from "./simulators/claude-code.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

/**
 * The history holding `earlier`, then the latest message `latest`: as `<conversation_history>` text with "Latest
 * user message:" (before chain/record-per-message), or in OpenCode's form for a serialized part of a conversation
 * ("…serialized record of this conversation from its start…", `<recent-context>`) with the message after it.
 */
const historyThen = (earlier: string, latest: string) =>
  new RegExp(
    `(<conversation_history>[\\s\\S]*${earlier}[\\s\\S]*Latest user message:\\n${latest}` +
      `|serialized record of this conversation from its start[\\s\\S]*${earlier}[\\s\\S]*</recent-context>\\n+${latest})`,
  );

async function main() {
  const world = await createWorld("turn-errors");
  const { opencode, claude } = world;
  const cases = testCases();
  try {
    // The official installer's binary in the world's bin, found first on PATH
    // (Windows tries .exe before npm's .cmd; elsewhere it replaces npm's
    // shim): the launcher the plugin memoizes at setup, gone in the launch
    // failure at the end.
    claude.installCli(join(world.tmp, "bin"), { layout: "local-bin" });
    await opencode.startPlugin();
    /** A chat with one answered turn and a second question; Claude's next query fails as `failure`. */
    const failedTurn = async (failure: ClaudeFailure) => {
      const chat = opencode.newChat();
      await opencode.say(chat, "one");
      assert.ok((await opencode.turn(chat)).ok);
      await opencode.say(chat, "two");
      claude.state.failures = [failure];
      const queries = claude.queries.length;
      const retries = opencode.retries.length;
      let turn: Awaited<ReturnType<typeof opencode.turn>>;
      try {
        turn = await opencode.turn(chat);
      } finally {
        claude.state.failures = [];
      }
      const first = turn.requests[0]!;
      const error = first.reply?.raw ? JSON.parse(first.reply.raw).error : undefined;
      return { chat, turn, first, error, queries: claude.queries.length - queries, retries: opencode.retries.length - retries };
    };

    await cases.run("a context overflow before any output is a 400 OpenCode compacts on, then the step answers", async () => {
      const { chat, turn, first, error } = await failedTurn("promptTooLong");
      assert.equal(first.status, 400, first.reply?.raw);
      assert.equal(error.type, "invalid_request_error");
      assert.equal(error.code, "context_length_exceeded");
      assert.equal(turn.compactions?.[0]?.status, "completed", "OpenCode compacted after the overflow");
      assert.ok(turn.ok, "the step sent again after the compaction answers");
      assert.ok(opencode.session(chat).messages.some((m) => m.type === "compaction"));
    });

    await cases.run("Anthropic refusing to bill this usage is a 402 OpenCode does not send again", async () => {
      const { turn, first, error, retries } = await failedTurn("creditBalance");
      assert.equal(first.status, 402, first.reply?.raw);
      assert.equal(error.type, "billing_error");
      assert.ok(!turn.ok);
      assert.equal(retries, 0, "not sent again");
    });

    await cases.run("the chat's transcript is gone: the plugin notices and the history goes to a new transcript", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "LOST-ONE");
      assert.ok((await opencode.turn(chat)).ok);
      const lost = claude.queries.at(-1)!.name;
      rmSync(claude.fileOf(lost));
      await opencode.say(chat, "LOST-TWO");
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok, "the turn answers");
      assert.equal(turn.requests.length, 1, "in one request");
      const query = claude.queries.at(-1)!;
      assert.notEqual(query.params.resume, lost, "the lost session is not resumed");
      assert.match(query.view, historyThen("LOST-ONE", "LOST-TWO"), "the history reaches the new transcript");
      assert.ok(
        world.journal().some((line) => line.includes("starting a new Claude transcript; transferring history") && line.includes(`"conversationKey":"${chat}"`) && line.includes("no transcript of this chat")),
        "the journal names the lost transcript",
      );
    });

    await cases.run("a transcript the CLI reports lost moves the chat to the next transcript version", async () => {
      // The file is gone when the CLI loads it, after the plugin read it: OpenCode's retry transfers the history as text.
      const names = await pluginModule("names");
      const chat = opencode.newChat();
      await opencode.say(chat, "hi");
      assert.ok((await opencode.turn(chat)).ok);
      const transcript = claude.queries.at(-1)!.name;
      await opencode.say(chat, "LOST-POINT");
      let release!: () => void;
      claude.state.holdStart = new Promise<void>((resolve) => (release = resolve));
      const from = claude.queries.length;
      const held = claude.heldStarts;
      const turning = opencode.turn(chat);
      // The plugin read the transcript and is starting the CLI on it: the start is held, no process yet.
      for (let waited = 0; claude.heldStarts === held; waited += 10) {
        if (waited > 5_000) {
          release();
          await turning;
          throw new Error("the query did not start");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      rmSync(claude.fileOf(transcript));
      release();
      const turn = await turning;
      assert.ok(turn.ok, `the retry answered: ${turn.requests.map((r) => r.status).join(",")}`);
      const [refused, retry] = claude.queries.slice(from);
      assert.equal(refused!.outcome, "refused: no conversation", "the CLI could not load the transcript");
      assert.equal(turn.requests[0]!.status, 500);
      assert.equal(retry!.params.resume, undefined);
      assert.equal(retry!.params.sessionId, names.transcriptName(chat, names.FIRST_EPOCH, 2), "the next version");
      assert.match(retry!.view, historyThen("hi", "LOST-POINT"), "the history reaches the next version");
      assert.ok(world.journal().some((line) => line.includes("Claude session lost; the chat moves to a new transcript") && line.includes(`"conversationKey":"${chat}"`)));
    });

    await cases.run("the user stops a turn while it streams: the CLI's diagnostics reach neither OpenCode nor the journal", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "STOP-ME");
      let release!: () => void;
      claude.state.holdMidAnswer = new Promise<void>((resolve) => (release = resolve));
      const stop = new AbortController();
      const stopping = opencode.turn(chat, { stop: stop.signal });
      await new Promise((resolve) => setTimeout(resolve, 300));
      stop.abort();
      const stopped = await stopping;
      assert.ok(stopped.stopped, "the turn was stopped");
      // The plugin stops the process while the answer still streams.
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const interrupted = claude.queries.at(-1)!;
      assert.equal(interrupted.outcome, "stopped");
      assert.ok(
        claude.records(interrupted.name).some((r) => r.type === "user" && /\[Request interrupted by user\]/.test(JSON.stringify(r.message?.content))),
        "Claude Code ended the turn as interrupted (its error result carries the diagnostics)",
      );
      await opencode.say(chat, "AFTER-STOP");
      const next = await opencode.turn(chat);
      assert.ok(next.ok);
      assert.doesNotMatch(JSON.stringify(next.requests.map((r) => r.reply)), /ede_diagnostic/);
      assert.ok(!world.journal().some((line) => /ede_diagnostic/.test(line)), "no diagnostics in the journal");
    });

    await cases.run("an image error is a 400 OpenCode does not send again", async () => {
      const { turn, first, error, queries, retries } = await failedTurn("imageTooLarge");
      assert.ok(!turn.ok);
      assert.equal(retries, 0, "not sent again");
      assert.equal(queries, 1);
      assert.equal(first.status, 400, `an image error is a 400: ${first.reply?.raw}`);
      assert.equal(error.type, "invalid_request_error");
      assert.equal(error.code, "claude_image_error");
    });

    await cases.run("the texts of a failed launch (Agent SDK 0.3.x, Bun) are told from other failures", async () => {
      // The CLI did not start (launcher swapped by `claude update`, layout changed by an install). Wordings of
      // sdk.mjs: a missing executable, a failed spawn.
      const { isClaudeLaunchFailure } = await pluginModule("failure");
      assert.equal(typeof isClaudeLaunchFailure, "function", "failure.ts tells a failed launch from other failures");
      assert.ok(isClaudeLaunchFailure("Claude Code native binary not found at C:\\Users\\me\\.local\\bin\\claude.exe. Please ensure Claude Code is installed via native installer or specify a valid path with options.pathToClaudeCodeExecutable."));
      assert.ok(isClaudeLaunchFailure("Claude Code executable not found at /opt/claude. Is options.pathToClaudeCodeExecutable set?"));
      assert.ok(isClaudeLaunchFailure("Claude Code executable at /opt/claude exists but failed to launch."));
      assert.ok(isClaudeLaunchFailure("Failed to spawn Claude Code process: spawn EBUSY"));
      // Bun throws other spawn errors at query(), naming the system call:
      // Windows (launcher held open by another program), then POSIX.
      assert.ok(isClaudeLaunchFailure("EBUSY: resource busy or locked, uv_spawn"));
      assert.ok(isClaudeLaunchFailure("ETXTBSY: text file busy, posix_spawn"));
      assert.ok(isClaudeLaunchFailure("Claude Code executable path is not spawnable (ENOTDIR)."));
      assert.ok(!isClaudeLaunchFailure("API Error: 500 boom"));
    });

    // A turn through the plugin's real query starter and the real SDK whose
    // memoized launcher is gone (an install moved the CLI): the plugin
    // answers 500, and OpenCode's retry, which looks again, finds the CLI
    // where it is now and starts it (then the user stops it).
    const { resolveClaudeCli } = await pluginModule("executable-path");
    const failedLaunch = async (label: string, back: ReturnType<typeof claude.installCli>) => {
      const launcher = (await resolveClaudeCli(process.env)) as string | null;
      assert.ok(launcher, `${label}: the plugin finds the world's CLI`);
      rmSync(launcher);
      assert.equal(await resolveClaudeCli(process.env), launcher, `${label}: memoized until a launch fails`);
      const chat = opencode.newChat();
      await opencode.say(chat, `launch ${label}`);
      const { turn, starts } = await world.turnThroughRealSdk(chat, { cli: back });
      const first = turn.requests[0]!;
      assert.equal(first.status, 500, `${label}: a server error OpenCode retries: ${first.reply?.raw}`);
      assert.ok(opencode.retries.some((retry) => retry.chat === chat), `${label}: OpenCode sent the turn again`);
      // The retry looked again: it started the CLI found anew, not the memoized path.
      assert.equal(starts.length, 1, `${label}: the retry started the CLI found anew (${turn.requests.length} requests, the last ${turn.requests.at(-1)?.reply?.raw})`);
      assert.ok(turn.stopped, `${label}: the user stopped the retried turn`);
      assert.notEqual(await resolveClaudeCli(process.env), launcher, `${label}: the failed launch dropped the memoized path`);
      return JSON.parse(first.reply!.raw!).error as { type: string; message: string };
    };

    await cases.run("the official installer's binary gone from PATH: a 500 in the SDK's words, and OpenCode's retry finds the CLI again", async () => {
      // The plugin memoized it at setup: the SDK reports it missing. Found again: on Windows npm's shim beside it
      // (cli.js), elsewhere — where npm's shim was replaced — the install in ~/.local/bin.
      const back = process.platform === "win32" ? claude.cli : claude.installCli(join(world.tmp, "home", ".local", "bin"), { layout: "local-bin" });
      const error = await failedLaunch("native binary", back as ReturnType<typeof claude.installCli>);
      assert.equal(error.type, "server_error");
      assert.match(error.message, /Claude Code (native binary|executable) not found at /, "the SDK's own text");
      assert.ok(world.journal().some((line) => /turn failed fast|chat completions error/.test(line) && /not found at/.test(line)), "the journal names the failed launch");
    });

    if (process.platform === "win32") {
      await cases.run("npm's older cli.js gone on Windows: node's missing module, and OpenCode's retry finds the native install", async () => {
        // The plugin hands the SDK cli.js to run through node, and the SDK's spawn of node succeeds; node then exits
        // with code 1, "Cannot find module '…cli.js'". Still a launcher that is gone; the native install in
        // ~/.local/bin is found then.
        await failedLaunch("npm's cli.js", claude.installCli(join(world.tmp, "home", ".local", "bin"), { layout: "local-bin" }));
      });
    }

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
