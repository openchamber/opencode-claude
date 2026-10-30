/**
 * Regression: OpenChamber attaches session context (its guidance, pinned
 * notes, memory, checkout) through OpenCode's session instructions API.
 * OpenCode renders the values as `<context key="…">` blocks in its system
 * prompt, and the proxy dropped them with the rest of that prompt (Claude
 * Code's preset replaces it). So Claude never read OpenChamber's instruction
 * to link issues and PRs to the session. Later changes arrive as
 * `<system-update>` user text and already reached Claude. A change while a
 * tool ran reaches the running turn after the tool's result, never inside
 * it, and is not passed off as the user's message; a message the user sent
 * then is a message of its own, after the update.
 *
 * On the simulators (test/simulators/): OpenCode's system prompt with the
 * context block a host attached (`opencode.state.contextEntries`) and a later change
 * as OpenCode's system message (`between(chat, "system", …)`, lowered to
 * `<system-update>` text); a change while a tool runs is that message added
 * in the tool's run (`turn`'s `toolOutput`), with or without a message of the
 * user's (`steer`). What Claude Code got is the query's system prompt, its
 * input and the records of the turn (the tool's result, what it took in
 * meanwhile; `updateWhileTool`, simulators/turns.ts). Each case is a chat of
 * its own. (The turn after sends neither again:
 * session-context-sent-again-regression.ts.)
 *
 * Run: bun test/session-context-regression.ts
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { testCases } from "./simulators/cases.ts";
import { updateWhileTool } from "./simulators/turns.ts";
import { createWorld } from "./simulators/world.ts";

const GUIDANCE =
  '<context key="openchamber.guidance">\nLink to this session with the openchamber tool\'s session.link each pull request you open.\n</context>';
const CHANGED =
  'The context under "openchamber.pinned" changed and supersedes the previous value:\n<context key="openchamber.pinned">\nShip on Friday.\n</context>';

async function main() {
  const world = await createWorld("session-context");
  const { opencode, claude } = world;
  const cases = testCases();
  const append = () => String((claude.queries.at(-1)!.params.systemPrompt as { append?: string })?.append ?? "");
  /** A chat with its first turn answered; Claude's system prompt then. */
  const answeredChat = async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "fix the bug");
    const answered = await opencode.turn(chat);
    assert.ok(answered.ok);
    return { chat, answered, first: append() };
  };

  /** The update made while a tool ran, with or without a message the user sent then (simulators/turns.ts). */
  const whileTool = (steer?: string) => updateWhileTool(world, CHANGED, steer);
  /** The one update among the texts, as OpenCode sent it and not as the user's message. */
  const theUpdate = (texts: string[]) => {
    const update = texts.filter((text) => text.includes("Ship on Friday."));
    assert.equal(update.length, 1, `the update reaches Claude once: ${JSON.stringify(texts)}`);
    assert.match(update[0]!, /^<system-update>[\s\S]*<\/system-update>$/, "the update as OpenCode sent it");
    assert.ok(!update[0]!.includes("the user sent"), `the update is not the user's message: ${update[0]}`);
    return update[0]!;
  };

  try {
    await opencode.startPlugin();
    // OpenChamber's guidance, attached through OpenCode's session instructions: a context block of the system prompt.
    opencode.state.contextEntries = { "openchamber.guidance": "Link to this session with the openchamber tool's session.link each pull request you open." };

    await cases.run("context entries reach Claude's system prompt, the rest of OpenCode's prompt stays out", async () => {
      const { answered, first } = await answeredChat();
      assert.ok(String(answered.requests[0]!.body.messages[0]!.content).includes(GUIDANCE), "OpenCode's system prompt holds the block");
      assert.ok(first.includes(GUIDANCE), `context entries reach Claude's system prompt: ${first.slice(-300)}`);
      assert.ok(!/a coding agent harness|# Your Model|Today's date|<env>/.test(first), `the rest of OpenCode's prompt stays out: ${first}`);
    });

    await cases.run("a changed entry reaches the next prompt, the system prompt stays the same", async () => {
      const { chat, first } = await answeredChat();
      // A pinned note changed before the next message: OpenCode sends it as a system update.
      opencode.between(chat, "system", CHANGED);
      await opencode.say(chat, "and now?");
      assert.ok((await opencode.turn(chat)).ok);
      const prompt = claude.queries.at(-1)!.input.map((m) => contentText(m.content)).join("\n");
      assert.ok(prompt.includes("Ship on Friday."), `a changed entry reaches the next prompt: ${prompt}`);
      assert.ok(prompt.includes("and now?"));
      assert.equal(append(), first, "the system prompt stays the same, so the cache holds");
    });

    await cases.run("an update while a tool ran reaches the running turn after the tool's result", async () => {
      const { results, meanwhile } = await whileTool();
      assert.deepEqual(results, ["a.txt"], "the tool result stays the tool's own");
      assert.equal(meanwhile.length, 1, `the update reaches the running turn: ${JSON.stringify(meanwhile)}`);
      assert.equal(theUpdate([...results, ...meanwhile.map((m) => m.text)]), meanwhile[0]!.text);
    });

    await cases.run("an update and a message of the user's while a tool ran: the update, then the user's message alone", async () => {
      const { results, meanwhile } = await whileTool("stop");
      assert.deepEqual(results, ["a.txt"], "the tool result stays the tool's own");
      assert.equal(meanwhile.length, 2, `the update, then the user's message: ${JSON.stringify(meanwhile)}`);
      assert.equal(theUpdate([...results, ...meanwhile.map((m) => m.text)]), meanwhile[0]!.text);
      assert.ok(!meanwhile[0]!.text.includes("stop"), "the update without the user's message");
      assert.equal(meanwhile[1]!.text, "stop", "the user's message alone, without the update");
      assert.equal(meanwhile[1]!.priority, "next");
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
