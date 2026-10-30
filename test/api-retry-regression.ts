/**
 * Regression: CLI API retries are visible and never mistaken for a dead or
 * a successful turn.
 * - system/api_retry becomes a short reasoning note.
 * - Retries do not commit the response head: a turn whose retries run out
 *   still answers with a real HTTP error.
 * - The stall watchdog allows for the delay a retry announces.
 *
 * On the simulators (test/simulators/): Claude Code retries a failed model
 * call by itself (`api_retry` events) as CLI 2.1.312 does: retries that run
 * out (`state.failures`, BEHAVIOR.md "Failures of a model call"), and a call
 * that answers after a few of them (`state.apiRetries`; `state.waitRetries`:
 * the CLI waits each announced delay for real). OpenCode reads the answer and
 * retries by its own rules.
 *
 * Run: bun test/api-retry-regression.ts
 */
// The stall window outside the case that waits: no case but that one is about the watchdog. Its clock runs from the
// query's start, so a short window also takes in the CLI's start - seconds under load (with 1 s and 2 s, a turn whose
// retries announced no wait was killed before its first event).
const WINDOW_MS = 60_000;
/** The window while the CLI retries: shorter than the last wait announced (8 s), a gap of seconds between events. */
const RETRY_WINDOW_MS = 4_000;
process.env.OPENCODE_CLAUDE_TURN_STALL_MS = String(WINDOW_MS);
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const world = await createWorld("api-retry");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    /** One turn of a new chat, Claude's next query set up by `setup`. */
    const turnOf = async (setup: () => void) => {
      const chat = opencode.newChat();
      await opencode.say(chat, "hi");
      setup();
      const queries = claude.queries.length;
      const retries = opencode.retries.length;
      const turn = await opencode.turn(chat);
      return { turn, first: turn.requests[0]!, queries: claude.queries.length - queries, retries: opencode.retries.length - retries };
    };

    // Retries that run out fail before any content: a real HTTP error, not an empty answer.
    {
      const { turn, first, queries } = await turnOf(() => (claude.state.failures = ["overloaded"]));
      assert.notEqual(first.status, 200, "not a successful answer");
      assert.match(JSON.parse(first.reply!.raw!).error.message, /529/);
      assert.equal(first.counted[1] - first.counted[0], 1, "one Claude Code query for the request");
      assert.ok(turn.ok, "OpenCode sent it again and the next query answered");
      assert.equal(queries, 2);
    }

    // The CLI's retries before an answer: a note each, once the answer arrives.
    {
      const { turn, first, queries, retries } = await turnOf(() => (claude.state.apiRetries = { failure: "overloaded", attempts: 2 }));
      assert.ok(turn.ok);
      assert.equal(first.status, 200);
      const reasoning = first.reply!.reasoning;
      assert.match(reasoning, /\[api\] Anthropic returned 529, retrying[^\n]* \(attempt 1\/10\)/, `the first retry's note: ${JSON.stringify(reasoning)}`);
      assert.match(reasoning, /\(attempt 2\/10\)/);
      assert.match(first.reply!.text, /answer L/);
      assert.equal(queries, 1, "one query: the CLI retried, not OpenCode");
      assert.equal(retries, 0);
    }

    // A connection failure the CLI retries: no status to name.
    {
      const { turn, first } = await turnOf(() => (claude.state.apiRetries = { failure: "connection", attempts: 1 }));
      assert.ok(turn.ok);
      assert.match(first.reply!.reasoning, /\[api\] Connection to Anthropic failed, retrying[^\n]* \(attempt 1\/10\)/);
    }

    // A retry that waits longer than the stall window: the turn is not killed. The window is short from the CLI's
    // first event (the simulator takes `apiRetries` once the CLI process has connected) until the answer shows.
    {
      const chat = opencode.newChat();
      await opencode.say(chat, "hi");
      claude.state.waitRetries = true;
      // Waits of 0.5, 1, 2, 4 and 8 s: the last one twice the window.
      claude.state.apiRetries = { failure: "overloaded", attempts: 5 };
      const queries = claude.queries.length;
      let ended = false;
      const turning = opencode.turn(chat).finally(() => (ended = true));
      while (claude.state.apiRetries && !ended) await sleep(10);
      process.env.OPENCODE_CLAUDE_TURN_STALL_MS = String(RETRY_WINDOW_MS);
      while (!opencode.shown(chat) && !ended) await sleep(10);
      process.env.OPENCODE_CLAUDE_TURN_STALL_MS = String(WINDOW_MS);
      const turn = await turning;
      const first = turn.requests[0]!;
      claude.state.waitRetries = false;
      assert.ok(turn.ok, `the turn answered after the waits: ${first.reply?.raw ?? ""}`);
      assert.equal(first.status, 200);
      assert.match(first.reply!.text, /answer L/);
      assert.doesNotMatch(first.reply!.text, /produced no output/);
      assert.match(first.reply!.reasoning, /\(attempt 5\/10\)/, "the retry that waited past the window was announced");
      assert.ok(first.doneAt - first.sentAt >= 15_000, `the CLI waited its retries (${Math.round(first.doneAt - first.sentAt)} ms)`);
      assert.equal(claude.queries.length - queries, 1);
    }

    const journal = world.journal();
    assert.ok(journal.some((line) => /turn failed fast/.test(line)), "the journal records the failed turn");
    assert.ok(!journal.some((line) => /produced no output/.test(line)), "no turn killed by the watchdog");
    assert.deepEqual(journal.filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — api retry regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
