/**
 * Regression: a user message sent while a bridged tool is running (OpenCode
 * puts it after the tool result in the resume request) must reach Claude
 * instead of being dropped. It goes into the turn's open input as a user
 * message (`priority: "next"`), not into the tool result, where Claude read
 * it as an injected instruction. Its record is named after its OpenCode id
 * (names.ts userRecordName), so the next turn finds it in the transcript.
 * A tool's media, which OpenCode's list keeps inside the tool result, is not
 * steering. (Ported from the fork's 4ca2338.)
 *
 * On the simulators (test/simulators/): the user sends a message while
 * OpenCode runs the tool (`turn`'s `steer`: the message after the tool
 * results, once a turn); Claude Code reads the turn's open input as it comes
 * and takes a message of priority "next" into the turn as a `queued_command`
 * attachment (CLI 2.1.312 against a local stub of the API). OpenCode 2.0.32 keeps
 * a tool's files on its result in the list the hooks get and sends them as a
 * text-less user message after the results in the HTTP body (BEHAVIOR.md
 * "The list the hooks get", "The HTTP body"). Two calls of one message to a
 * tool that is not read-only run one after the other (CLI 2.1.312), so their
 * results reach the plugin in two requests. The records a new transcript
 * starts with (`noTurn`, no turn of their own) are not the turn's input.
 * Each case is a chat of its own.
 *
 * Run: bun test/steering-regression.ts
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("steer");
  const { opencode, claude } = world;
  const names = await pluginModule("names");
  const cases = testCases();
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
    // Records without a turn (the start of a new transcript) come before the prompt: not the turn's input.
    return { chat, query, input: turnInput(query), result: results[0]!, forwarded };
  }
  const turnInput = (query: (typeof claude.queries)[number]) => query.input.filter((m) => !m.noTurn);

  try {
    await opencode.startPlugin();

    await cases.run("a message sent while the tool ran joins the running turn under its own name, not the tool result", async () => {
      const steer = "Actually, the secret word is PINEAPPLE.";
      const steered = await run("run it", { steer });
      assert.equal(contentText(steered.result), "exit 0", "the tool result stays the tool's own");
      assert.equal(steered.input.length, 2, "the prompt, then the message sent while the tool ran");
      assert.equal(contentText(steered.input[1]!.content), steer);
      assert.equal(steered.input[1]!.priority, "next", "added after the running tool, within the turn");
      const absorbed = claude.records(steered.query.name).filter((r) => r.attachment?.type === "queued_command");
      assert.deepEqual(absorbed.map((r) => r.attachment.prompt), [steer], "Claude Code took it into the running turn");
      // The message's record is named after its OpenCode id, so the next turn
      // finds it in the transcript (the CLI keeps the uuid as the attachment's source_uuid).
      const steerId = opencode.session(steered.chat).messages.find((m) => m.type === "user" && m.text === steer)!.id;
      assert.equal(steered.input[1]!.uuid, names.userRecordName(steerId, 1), "the record of the message sent while the tool ran is named after it");
      assert.deepEqual(absorbed.map((r) => r.attachment.source_uuid), [steered.input[1]!.uuid]);
      assert.equal(steered.forwarded.length, 1);
    });

    await cases.run("a tool step with no message meanwhile forwards nothing", async () => {
      const plain = await run("plain");
      assert.equal(contentText(plain.result), "exit 0");
      assert.equal(plain.input.length, 1, "nothing but the prompt");
      assert.deepEqual(plain.forwarded, []);
    });

    await cases.run("a tool's media is tool output, not steering", async () => {
      // The tool's file is on its result in the list (a text-less user message
      // after the results in the body): tool output, not the user's.
      const png = testPng("steer-media");
      const media = await run("screenshot", { toolFiles: [{ mime: "image/png", data: png }], steer: "and crop it" });
      assert.deepEqual(media.result.map((b) => b.type), ["text", "image", "text"], "the image rides the tool result");
      assert.equal(media.input.length, 2, "only the user's own message is steering");
      assert.equal(contentText(media.input[1]!.content), "and crop it");
    });

    await cases.run("two calls run one after the other: the message sent meanwhile reaches Claude once, never inside a tool result", async () => {
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
