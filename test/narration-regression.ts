/**
 * Regression: what Opus 5.5 says before a tool call must reach OpenCode as
 * answer text, not reasoning, and real thinking stays reasoning.
 * - A thinking block is held until its signature: real thinking goes out as
 *   reasoning (live once it streams a second delta); a redacted one shows
 *   nothing.
 * - Words before a tool call come in the same response as the call, as text.
 *
 * On the simulators (test/simulators/): Opus 5.5 as a live turn with tools
 * showed it (a live probe with a subscription, BEHAVIOR.md "The
 * stream of a model call, usage"): `state.thinking` a thinking block with the
 * probed signature (tag "thinking"; "" for a redacted block: an empty delta,
 * then the signature), `state.toolPreamble` a text block before the step's
 * calls. The old test's thinking block tagged "narration" was not what Opus
 * 5.5 sent, and the simulator does not produce one: the plugin's branch for
 * it (proxy.ts `isNarrationSignature`) has no test here.
 *
 * Run: bun test/narration-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("narration");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    /** One turn of a new chat: what its first response gave OpenCode. */
    const firstResponse = async (setup: () => void) => {
      const chat = opencode.newChat();
      await opencode.say(chat, "hi");
      setup();
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
      const reply = turn.requests[0]!.reply!;
      return { content: reply.text, reasoning: reply.reasoning, finish: reply.finish };
    };

    // Real thinking stays reasoning: a short block (held until its end), a longer one (live after its second delta).
    claude.state.replies = ["done"];
    assert.deepEqual(await firstResponse(() => (claude.state.thinking = "plan")), { content: "done", reasoning: "plan", finish: "stop" }, "short thinking");
    claude.state.replies = ["done"];
    assert.deepEqual(await firstResponse(() => (claude.state.thinking = "plan the next steps first")), { content: "done", reasoning: "plan the next steps first", finish: "stop" }, "longer thinking");
    // Redacted thinking, as Opus 5.5 sent it: nothing to show.
    claude.state.replies = ["done"];
    assert.deepEqual(await firstResponse(() => (claude.state.thinking = "")), { content: "done", reasoning: "", finish: "stop" }, "redacted thinking");
    claude.state.thinking = undefined;

    // What Opus says before its call: answer text in the response with the call.
    const preamble = await firstResponse(() => {
      claude.state.toolPreamble = "Checking the logs next.";
      claude.state.toolTurn = true;
    });
    assert.deepEqual(preamble, { content: "Checking the logs next.", reasoning: "", finish: "tool_calls" }, "the words before the call");

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — narration regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
