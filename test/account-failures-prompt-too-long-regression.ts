/**
 * A prompt too long for the model reaches OpenCode as the overflow it
 * compacts on, also on the continuation after a tool call: Claude Code
 * reports "Prompt is too long" under the general `invalid_request`, so the
 * text decides the kind (context_overflow), and the failed request is a 400
 * `context_length_exceeded` OpenCode does not send again but compacts on.
 *
 * Two changes meet here: a failed model call as a real HTTP error of its kind
 * (fix/account-failures-after-tools, account-failures-regression.ts) and the
 * CLI's own compaction off, so that only OpenCode compacts
 * (fix/cli-autocompact): with the CLI's compaction on the CLI compacts on
 * "Prompt is too long" by itself and answers. This file runs on the trees
 * that have both (where.md).
 *
 * On the simulators (test/simulators/): Claude Code refuses the call as CLI
 * 2.1.312 reports it against a stub that refuses it (`state.failures`
 * `promptTooLong`; BEHAVIOR.md "Failures of a model call"); the call after the
 * first tool step: `state.failingCall` 2. The OpenCode simulator reads the
 * reply, retries and compacts as OpenCode 2.0.32 does (`failureOf`,
 * `opencode.retries`, the turn's compactions). The turns:
 * test/simulators/turns.ts; the kind the plugin read, from its journal.
 *
 * Run: bun test/account-failures-prompt-too-long-regression.ts (trees: where.md)
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { failureOf } from "./simulators/opencode.ts";
import { errorOf, failingTurn, statedKind } from "./simulators/turns.ts";
import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("account-failures-prompt-too-long");
  const { opencode } = world;
  const cases = testCases();

  try {
    await opencode.startPlugin();

    await cases.run("Prompt is too long under invalid_request after the tool step is the 400 OpenCode compacts on", async () => {
      // A general code with a telling text keeps the text's kind.
      const { turn, failed, retries } = await failingTurn(world, "promptTooLong", 2);
      assert.equal(failed.status, 400, failed.reply?.raw);
      assert.equal(errorOf(failed).code, "context_length_exceeded");
      assert.equal(failureOf(failed.reply!)?.kind, "context-overflow");
      assert.deepEqual(retries, [], "an overflow is not sent again");
      assert.equal(turn.compactions?.find((c) => c.status !== "skipped")?.status, "completed", "OpenCode compacted the chat");
    });

    for (const call of [1, 2] as const) {
      await cases.run(`the kind of promptTooLong on model call ${call} is context_overflow (invalid_request under a 400: the text)`, async () => {
        const { kind: stated, stated: line } = await statedKind(world, "promptTooLong", call);
        assert.equal(stated, "context_overflow", `promptTooLong, model call ${call}: ${line}`);
      });
    }

    await cases.run("the overflow is a warning naming its kind; no error in the plugin's journal", () => {
      const failedFast = world.journal().filter((line) => /turn failed fast/.test(line));
      assert.ok(failedFast.some((line) => line.includes(`"kind":"context_overflow"`)), "the journal names the context_overflow failure");
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
