/**
 * Regression: the user sees why Claude refused, and CLI warnings worth
 * seeing reach the reasoning stream once.
 * - system/model_refusal_no_fallback shows its api_refusal_explanation as a
 *   note (replacing the generic "declined" note); a turn that then fails
 *   answers 400 "refusal" with that explanation instead of a retryable 500.
 * - High-priority notifications and warning-level informational messages
 *   become notes, once per key; lower levels stay hidden.
 *
 * On the simulators (test/simulators/): a refusal as Claude Code 2.1.312
 * handles it (`state.failures` `refusal`; BEHAVIOR.md "Failures of a model
 * call"): the refused answer, a notice (level "notice"), one more call, then
 * `model_refusal_no_fallback` and a synthetic error. What the API said about
 * the refusal and whether the refused call wrote any text:
 * `state.refusalDetails` (the API's `stop_details`, as the CLI passes them on
 * in `model_refusal_no_fallback`). The CLI's notifications and informational
 * messages in a turn: `state.notices`, by the schemas in the CLI's own code
 * (emitted before the query's first model call; their real moments were not
 * probed).
 *
 * Run: bun test/refusal-notices-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("refusal-notices");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    /** One turn of a new chat; Claude's query fails as `failures` says. */
    const turnOf = async (failures: typeof claude.state.failures = []) => {
      const chat = opencode.newChat();
      await opencode.say(chat, "x");
      claude.state.failures = failures;
      const queries = claude.queries.length;
      const retries = opencode.retries.length;
      const turn = await opencode.turn(chat);
      claude.state.failures = [];
      return { turn, first: turn.requests[0]!, queries: claude.queries.length - queries, retries: opencode.retries.length - retries };
    };

    // The refused answer streamed: the user sees that Claude declined, once; OpenCode sends nothing again.
    {
      const { first, queries, retries } = await turnOf(["refusal"]);
      assert.equal(first.status, 200);
      const reasoning = first.reply!.reasoning;
      assert.equal(reasoning.match(/\[refusal\] Claude declined this request/g)?.length, 1, `the refusal note once: ${JSON.stringify(reasoning)}`);
      assert.doesNotMatch(reasoning, /declined to answer/, "no generic note next to it");
      assert.doesNotMatch(reasoning, /safeguards stopped the response/, "the CLI's notice-level message stays hidden");
      assert.equal(queries, 1);
      assert.equal(retries, 0);
    }

    // The API's reason for the refusal reaches the note.
    claude.state.refusalDetails = { category: "cyber", explanation: "This looks like malware development." };
    {
      const { first } = await turnOf(["refusal"]);
      assert.equal(first.status, 200);
      assert.match(first.reply!.reasoning, /Claude declined this request \(cyber\): This looks like malware development\./);
      assert.doesNotMatch(first.reply!.reasoning, /declined to answer/);
    }

    // The refused calls wrote nothing: a non-retryable 400 with the reason.
    claude.state.refusalDetails = { category: "cyber", explanation: "This looks like malware development.", text: "" };
    {
      const { turn, first, queries, retries } = await turnOf(["refusal"]);
      claude.state.refusalDetails = undefined;
      assert.equal(first.status, 400, `a refusal before any output: ${first.reply?.raw}`);
      const error = JSON.parse(first.reply!.raw!).error;
      assert.equal(error.code, "refusal");
      assert.match(error.message, /This looks like malware development/);
      assert.ok(!turn.ok);
      assert.equal(turn.failure?.kind, "content-policy", "OpenCode reads it as a content-policy block");
      assert.equal(queries, 1);
      assert.equal(retries, 0, "OpenCode does not send it again");
    }

    // CLI notices: once per key, only the levels worth seeing.
    claude.state.notices = [
      { subtype: "notification", key: "ctx", priority: "high", text: "Context is 95% full" },
      { subtype: "notification", key: "ctx", priority: "high", text: "Context is 95% full" },
      { subtype: "notification", key: "auth", priority: "immediate", text: "Sign-in expires soon" },
      { subtype: "notification", key: "tip", priority: "low", text: "Tip: try /agents" },
      { subtype: "notification", key: "update", priority: "medium", text: "Update available" },
      { subtype: "informational", level: "warning", content: "Stop hook prevented continuation", prevent_continuation: true },
      { subtype: "informational", level: "info", content: "Loaded 3 skills" },
      { subtype: "informational", level: "suggestion", content: "Try plan mode" },
    ];
    {
      const { turn, first } = await turnOf();
      assert.ok(turn.ok);
      const reasoning = first.reply!.reasoning;
      assert.equal(reasoning.match(/Context is 95% full/g)?.length, 1, `the high-priority notification once: ${JSON.stringify(reasoning)}`);
      assert.match(reasoning, /Sign-in expires soon/, "an immediate one too");
      assert.match(reasoning, /Stop hook prevented continuation/);
      assert.doesNotMatch(reasoning, /try \/agents|Update available|Loaded 3 skills|Try plan mode/);
    }

    const journal = world.journal();
    assert.ok(journal.some((line) => /turn failed fast/.test(line) && /"kind":"refusal"/.test(line)), "the journal names the refusal");
    assert.deepEqual(journal.filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — refusal and notices regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
