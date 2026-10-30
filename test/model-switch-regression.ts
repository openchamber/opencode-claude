/**
 * Regression: the user switches a chat from Claude to another model and
 * back. The resumed Claude session never saw the other model's turns, so
 * they must reach Claude with the new prompt — only those, not the turns
 * the session already holds — and the turn after must resume plainly.
 *
 * On the simulators (test/simulators/): two turns Claude answers, two turns
 * another model answers (`otherModelAnswer`: the prompt hook saw the
 * questions, the plugin never served the answers), then back to Claude; what
 * the plugin gave Claude Code is the query's `resume` and its input. The
 * missed turns go as `<conversation_history>` text in the prompt, ahead of
 * "Latest user message:" (main's form; one record without a turn in
 * OpenCode's serialized form: model-switch-regression.ts). Another model's
 * turns that end in its tool step (#74): model-switch-tool-step-main-regression.ts.
 *
 * Run: bun test/model-switch-main-regression.ts
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("model-switch");
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
    const second = await claudeTurn("CLAUDE-ASK-TWO");
    assert.equal(second.query.params.resume, first.query.name, "the second turn resumes the chat's Claude session");
    assert.equal(second.prompt, "CLAUDE-ASK-TWO", "a plain follow-up carries no history");

    // Two turns answered by another model, then back to Claude.
    for (const n of ["ONE", "TWO"]) {
      await opencode.say(chat, `OTHER-ASK-${n}`);
      opencode.otherModelAnswer(chat, `OTHER-ANSWER-${n}`);
    }
    const back = await claudeTurn("BACK-TO-CLAUDE");
    assert.equal(back.query.params.resume, first.query.name, "the Claude session still resumes");
    const [missed, request] = back.prompt.split("</conversation_history>");
    assert.ok(request !== undefined, `the other model's turns come as history: ${back.prompt.slice(0, 300)}`);
    assert.match(missed!, /after your last turn/);
    assert.match(
      missed!,
      /OTHER-ASK-ONE[\s\S]*OTHER-ANSWER-ONE[\s\S]*OTHER-ASK-TWO[\s\S]*OTHER-ANSWER-TWO/,
      "the other model's turns reach Claude in order",
    );
    assert.doesNotMatch(missed!, /CLAUDE-|answer L\d/, "turns the session holds are not repeated");
    assert.match(request!, /Latest user message:\nBACK-TO-CLAUDE$/);
    // What the model saw: the session's own turns once, then the missed ones.
    assert.equal(back.query.view.match(/CLAUDE-ASK-ONE/g)?.length, 1, "Claude saw its own first turn once");

    const next = await claudeTurn("NEXT");
    assert.equal(next.query.params.resume, first.query.name);
    assert.equal(next.prompt, "NEXT", "the turn after carries no history again");

    const journal = world.journal();
    assert.equal(journal.filter((line) => /injecting turns the resumed Claude session missed/.test(line)).length, 1, "the journal names the injection");
    assert.deepEqual(journal.filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — model switch regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
