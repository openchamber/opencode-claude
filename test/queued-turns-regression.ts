/**
 * Regression: user messages OpenCode queued while no Claude turn ran for them
 * arrive as consecutive user messages after the last assistant message. All
 * of them must reach Claude as the new turn's prompt — on a resumed session
 * and with history transfer (not duplicated in the transcript) — and the
 * following normal turn must still resume. (Ported from the fork's cf93c7e.)
 *
 * On the simulators (test/simulators/): the user queues messages while a
 * turn runs (`queue`: the prompt hook now, `deliver` after the turn), and
 * OpenCode's next request ends with them; a turn another model answered
 * (`otherModelAnswer`) leaves the chat with no Claude session, so its
 * history is transferred. A queued message may carry attachments, taken as
 * OpenCode takes them when it accepts the message. The queued messages go as
 * one prompt, the transferred history as `<conversation_history>` text ahead
 * of "Latest user message:" (main's form; a record per message:
 * queued-turns-regression.ts).
 *
 * Run: bun test/queued-turns-main-regression.ts
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("queued");
  const { opencode, claude } = world;
  const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
  /** The queued messages delivered after the running turn, then OpenCode's next turn; the query it started. */
  async function deliverAndTurn(chat: string, queued: string[]) {
    for (const id of queued) opencode.deliver(chat, id);
    const from = claude.queries.length;
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
    assert.equal(claude.queries.length - from, 1);
    const query = claude.queries[from]!;
    return { query, prompt: query.input.map((m) => contentText(m.content)).join("\n") };
  }

  try {
    await opencode.startPlugin();

    // Resumed session: both messages queued during a turn are the next request.
    {
      const chat = opencode.newChat();
      await opencode.say(chat, "hello");
      let release!: () => void;
      claude.state.hold = new Promise<void>((resolve) => (release = resolve));
      const running = opencode.turn(chat);
      const queued = [await opencode.queue(chat, "QUEUED-ONE"), await opencode.queue(chat, "QUEUED-TWO")];
      release();
      assert.ok((await running).ok);
      assert.ok(!JSON.stringify((await running).requests[0]!.body.messages).includes("QUEUED"), "queued messages wait for their turn");
      const first = claude.queries.at(-1)!;
      const resumed = await deliverAndTurn(chat, queued);
      assert.equal(resumed.query.params.resume, first.name, "queued turn resumes");
      assert.equal(resumed.prompt, "QUEUED-ONE\n\nQUEUED-TWO");
      const records = claude.records(first.name).filter((r) => r.type === "user" && contentText(r.message?.content).includes("QUEUED-ONE"));
      assert.equal(records.length, 1, "written once in the transcript");

      await opencode.say(chat, "NEXT");
      const next = await deliverAndTurn(chat, []);
      assert.equal(next.query.params.resume, first.name, "turn after queued messages resumes");
      assert.equal(next.prompt, "NEXT");
    }

    // History transfer (no Claude session for the chat yet): the queued
    // messages are the request, not history.
    {
      const chat = opencode.newChat();
      await opencode.say(chat, "EARLIER-ASK");
      const queued = [await opencode.queue(chat, "QUEUED-ONE"), await opencode.queue(chat, "QUEUED-TWO")];
      opencode.otherModelAnswer(chat, "EARLIER-ANSWER");
      const { query, prompt } = await deliverAndTurn(chat, queued);
      assert.equal(query.params.resume, undefined);
      const [history, request] = prompt.split("</conversation_history>");
      assert.ok(request !== undefined, `the history is transferred: ${prompt}`);
      assert.match(history!, /EARLIER-ASK[\s\S]*EARLIER-ANSWER/);
      assert.doesNotMatch(history!, /QUEUED/, "queued messages are not history");
      assert.match(request!, /Latest user message:\nQUEUED-ONE\n\nQUEUED-TWO$/);
      assert.equal(occurrences(prompt, "QUEUED-ONE"), 1);
      const records = claude.records(query.name).filter((r) => r.type === "user" && contentText(r.message?.content).includes("QUEUED-ONE"));
      assert.equal(records.length, 1, "written once in the transcript");
    }

    // Queued with an attachment: every message, in order, the image in place.
    {
      const chat = opencode.newChat();
      await opencode.say(chat, "u1");
      assert.ok((await opencode.turn(chat)).ok);
      const png = testPng("queued");
      const queued = [
        await opencode.queue(chat, "first ask"),
        await opencode.queue(chat, "second ask", [{ mediaType: "image/png", data: png }]),
        await opencode.queue(chat, "third ask"),
      ];
      const { query } = await deliverAndTurn(chat, queued);
      const blocks = query.input[0]!.content as Array<{ type: string; text?: string }>;
      assert.ok(Array.isArray(blocks), `a multimodal prompt: ${JSON.stringify(query.input[0]!.content).slice(0, 200)}`);
      assert.deepEqual(blocks.map((b) => b.text ?? b.type), ["first ask", "second ask", "image", "third ask"]);
    }

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — queued turns regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
