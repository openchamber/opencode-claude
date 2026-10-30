/**
 * Regression: a user message sent while a bridged tool is running (OpenCode
 * puts it after the tool result in the resume request) must reach Claude
 * instead of being dropped. It goes into the turn's open input as a user
 * message (`priority: "next"`), not into the tool result, where Claude read
 * it as an injected instruction. OpenCode's promoted-media
 * marker message is not steering. (Ported from the fork's 4ca2338.)
 *
 * On the simulators (test/simulators/): the user sends a message while
 * OpenCode runs the tool (`turn`'s `steer`: the message after the tool
 * results, once a turn); Claude Code reads the turn's open input as it comes
 * and takes a message of priority "next" into the turn as a `queued_command`
 * attachment (CLI 2.1.312 against a local stub of the API). OpenCode 2.0.32 sends
 * a tool's files as a text-less user message after the results (BEHAVIOR.md
 * "The HTTP body"). Two calls of one message to a tool that is not read-only
 * run one after the other (CLI 2.1.312), so their results reach the plugin in
 * two requests. The query's whole input is the turn's: main starts no
 * transcript with records of its own, and its records are not named after
 * OpenCode's messages (both: steering-regression.ts).
 *
 * Run: bun test/steering-main-regression.ts
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("steer");
  const { opencode, claude } = world;
  /** One tool step: the user's ask, bash, the answer; what Claude got. */
  async function run(ask: string, options: { steer?: string; toolFiles?: Array<{ mime: string; data: string }> } = {}) {
    const chat = opencode.newChat();
    await opencode.say(chat, ask);
    claude.state.toolSteps = [[{ name: "bash", input: { command: "sleep 40" } }]];
    const from = claude.queries.length;
    const turn = await opencode.turn(chat, { toolOutput: "exit 0", ...options });
    assert.ok(turn.ok, `${ask}: the turn answered`);
    assert.equal(turn.requests.length, 2);
    assert.equal(turn.requests[1]!.counted[1] - turn.requests[1]!.counted[0], 0, `${ask}: the result resumed the parked turn`);
    assert.equal(claude.queries.length - from, 1);
    const query = claude.queries[from]!;
    const results = claude.records(query.name).filter((r) => r.toolUseResult).map((r) => r.toolUseResult as Array<Record<string, any>>);
    assert.equal(results.length, 1);
    const forwarded = world.journal().filter((line) => line.includes("forwarding mid-turn user messages") && line.includes(`"${chat}"`));
    return { chat, query, result: results[0]!, forwarded };
  }

  try {
    await opencode.startPlugin();

    const steer = "Actually, the secret word is PINEAPPLE.";
    const steered = await run("run it", { steer });
    assert.equal(contentText(steered.result), "exit 0", "the tool result stays the tool's own");
    assert.equal(steered.query.input.length, 2, "the prompt, then the message sent while the tool ran");
    assert.equal(contentText(steered.query.input[1]!.content), steer);
    assert.equal(steered.query.input[1]!.noTurn, false);
    assert.equal(steered.query.input[1]!.priority, "next", "added after the running tool, within the turn");
    const absorbed = claude.records(steered.query.name).filter((r) => r.attachment?.type === "queued_command");
    assert.deepEqual(absorbed.map((r) => r.attachment.prompt), [steer], "Claude Code took it into the running turn");
    assert.equal(steered.forwarded.length, 1);

    const plain = await run("plain");
    assert.equal(contentText(plain.result), "exit 0");
    assert.equal(plain.query.input.length, 1, "nothing but the prompt");
    assert.deepEqual(plain.forwarded, []);

    // The tool's file reaches OpenCode's request as a text-less user message
    // after the results: tool output, not the user's.
    const png = testPng("steer-media");
    const media = await run("screenshot", { toolFiles: [{ mime: "image/png", data: png }], steer: "and crop it" });
    assert.deepEqual(media.result.map((b) => b.type), ["text", "image", "text"], "the image rides the tool result");
    assert.equal(media.query.input.length, 2, "only the user's own message is steering");
    assert.equal(contentText(media.query.input[1]!.content), "and crop it");

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");

    // Two calls of one message, run one after the other: their results come
    // in two requests, and the message sent while the first ran reaches
    // Claude once, never inside a tool result.
    {
      const chat = opencode.newChat();
      await opencode.say(chat, "run both");
      claude.state.toolSteps = [2];
      const from = claude.queries.length;
      const turn = await opencode.turn(chat, { toolOutput: (call) => `r${opencode.session(chat).messages.filter((m) => m.toolCalls).length}-${call.id.slice(-2)}`, steer: "Use MANGO instead." });
      assert.ok(turn.ok);
      assert.equal(turn.requests.length, 3, "one call per response, then the answer");
      assert.equal(claude.queries.length - from, 1, "one Claude Code turn");
      const query = claude.queries[from]!;
      const sent = opencode.session(chat).messages.filter((m) => m.type === "user" && m.text.includes("MANGO"));
      assert.equal(sent.length, 1, "the user sent it once");
      const input = query.input.map((m) => contentText(m.content)).join("\n");
      assert.equal(input.match(/MANGO/g)?.length, 1, "steering forwarded once");
      const results = claude.records(query.name).filter((r) => r.toolUseResult).map((r) => contentText(r.toolUseResult));
      assert.equal(results.length, 2);
      assert.ok(!results.join("\n").includes("MANGO"), "never inside a tool result");
    }

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — steering regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
