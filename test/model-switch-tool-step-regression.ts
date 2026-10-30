/**
 * Regression: the user switches a chat from Claude to another model, that
 * model's turns end in its answered tool step, and the user goes on with
 * Claude (#74, 1.6.1). The turns before the step are handed over as
 * `<conversation_history>` text, and the step is relayed as that model's,
 * not as Claude's own (main's form; from chain/turn-by-names the step goes
 * with the missed turns: model-switch-regression.ts, "another model's tool
 * step goes in the missed record").
 *
 * On the simulators (test/simulators/): two turns Claude answers, then turns
 * another model answers (`otherModelAnswer`), the last one with its call and
 * result (`toolCalls`, `toolResults`); what the plugin gave Claude Code is
 * the query's `resume` and its input.
 *
 * Run: bun test/model-switch-tool-step-main-regression.ts
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("model-switch-tool-step");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    const chat = opencode.newChat();
    /** A Claude turn: the query it started and the text of its prompt. */
    const claudeTurn = async (text: string) => {
      await opencode.say(chat, text);
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok, `${text}: the turn answered (${turn.requests.at(-1)?.status})`);
      const query = claude.queries.at(-1)!;
      return { query, prompt: query.input.filter((m) => !m.noTurn).map((m) => contentText(m.content)).join("\n") };
    };

    const first = await claudeTurn("CLAUDE-ASK-ONE");
    await claudeTurn("CLAUDE-ASK-TWO");

    // Another model's turns end in its answered tool step: the turns before the step are handed over, and the
    // step is relayed as that model's, not as Claude's own.
    await opencode.say(chat, "OTHER-ASK-THREE");
    opencode.otherModelAnswer(chat, "OTHER-ANSWER-THREE");
    await opencode.say(chat, "OTHER-ASK-FOUR");
    opencode.otherModelAnswer(chat, "", {
      finish: "tool-calls",
      toolCalls: [{ id: "call_other", name: "read", input: { path: "a.txt" } }],
      toolResults: [{ id: "call_other", output: "OTHER-RESULT" }],
    });
    const switchedStep = await claudeTurn("KEEP-GOING");
    assert.equal(switchedStep.query.params.resume, first.query.name, "the Claude session still resumes");
    const [handover, step] = switchedStep.prompt.split("</conversation_history>");
    assert.ok(step !== undefined, `the other model's turns come as history: ${switchedStep.prompt.slice(0, 300)}`);
    assert.match(handover!, /OTHER-ASK-THREE[\s\S]*OTHER-ANSWER-THREE[\s\S]*OTHER-ASK-FOUR/);
    assert.doesNotMatch(handover!, /CLAUDE-|answer L\d|OTHER-RESULT/, "seen turns and the step itself are not in the handover");
    assert.match(step!, /The model that handled the turns above called the tools below/);
    assert.doesNotMatch(step!, /Your previous step/);
    assert.match(step!, /OTHER-RESULT[\s\S]*KEEP-GOING/);

    const journal = world.journal();
    assert.equal(journal.filter((line) => /injecting turns the resumed Claude session missed/.test(line)).length, 1, "the journal names the injection");
    assert.deepEqual(journal.filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — model switch tool step regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
