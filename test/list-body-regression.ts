/**
 * Regression: a chat request is matched to its context hook's list by the
 * user's own texts (proxy.ts requestFit), and the newest pending list of
 * the chat is the request's (context-list.ts takeContextEvent). The list
 * and the body differ in form where OpenCode lowers the list for an
 * OpenAI-form provider (ai/src/protocols/openai-chat.ts):
 * - a tool's media go into a user message of their own, with no text,
 *   after the tool results: the list has no such message;
 * - a system update, its own `system` entry in the list, is `<system-update>`
 *   text appended to the previous user message;
 * - a user message of attachments alone has no text on either side;
 * - an old image OpenCode took out of the body after the hooks (more than
 *   25 MiB of images, model-request.ts boundImages) is its note in the body,
 *   the image in the list.
 * A list of a request that never arrived (a turn stopped between the hook
 * and the request) can hold the same texts as the next request after a
 * revert while naming other messages: the newest list wins. Another
 * plugin's hook that rewrites a text changes the one event OpenCode builds
 * the body from and the plugin keeps: the list still fits, the turn runs as
 * usual on the text sent.
 *
 * On the simulators (test/simulators/): the chat as OpenCode 2.0.32 runs it —
 * a tool step with an image (`toolFiles`), an instruction update (`between`
 * "system"), an image sent alone while a tool runs (the user's `say` while
 * the tool's output is pending), the user's images and then a tool's
 * screenshots over OpenCode's bound, a turn the user stopped before its
 * request left (the hook ran, the request was aborted), another plugin's
 * hook after ours that rewrites the user's latest text
 * (`opencode.state.foreignHook`). Which list the plugin took is in the name
 * of the record Claude got (`claude.queries[i].trigger`, the steering
 * messages' `input`), and the journal. Each case is a chat of its own.
 * Not on the simulators (how OpenCode 2.0.32 sends them was not found; the
 * checks stay commented out): a body whose texts are not the list's (the
 * plugin's unmatchedList path), and a chat request no hook announced (its
 * NO_CONTEXT_EVENT guard).
 *
 * Run: bun test/list-body-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("list-body");
  const { opencode, claude } = world;
  const { userRecordName } = await pluginModule("names");
  const cases = testCases();
  // The images of the bound case are megabytes each: what Claude saw keeps them as `[image]`.
  claude.state.viewWithoutImageData = true;
  /** One turn that must pass; the last query of the turn. */
  const run = async (chat: string, options: Parameters<typeof opencode.turn>[1] = {}) => {
    const turn = await opencode.turn(chat, options);
    assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => `${r.status} ${r.reply?.text ?? ""}`).join(", ")}`);
    for (const request of turn.requests) assert.doesNotMatch(request.reply?.reasoning ?? "", /did not match this request/, "the list fits the request");
    return { turn, query: claude.queries.at(-1)! };
  };
  const textOfInput = (query: (typeof claude.queries)[number]) => JSON.stringify(query.input.filter((i) => !i.noTurn).map((i) => i.content));
  try {
    await opencode.startPlugin();

    await cases.run("a tool's media lowered into a user message of their own: the next turn is named after its question", async () => {
      // The list has no such message.
      const chat = opencode.newChat();
      await opencode.say(chat, "Q1");
      claude.state.toolTurn = true;
      const step = await run(chat, { toolOutput: "ok", toolFiles: [{ mime: "image/png", data: testPng("TOOL-IMAGE") }] });
      const body = step.turn.requests.at(-1)!.body.messages;
      assert.ok(body.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.every((p: any) => p.type === "image_url")), "OpenCode sent the tool's image as a user message of its own");
      const q2 = await opencode.say(chat, "Q2");
      const { turn, query } = await run(chat);
      assert.ok(turn.requests[0]!.body.messages.filter((m) => m.role === "user").length > turn.requests[0]!.list.filter((m) => m.role === "user").length, "the body has a user message the list does not");
      assert.equal(query.trigger, userRecordName(q2, 1), "the turn is named after Q2");
    });

    await cases.run("a system update appended to the previous user message's text: the turn is named after it", async () => {
      const chat = opencode.newChat();
      const q1 = await opencode.say(chat, "Q1");
      opencode.between(chat, "system", "Use value B");
      const { turn, query } = await run(chat);
      assert.ok(turn.requests[0]!.body.messages.some((m) => m.role === "user" && String(m.content).includes("Q1\n<system-update>\nUse value B\n</system-update>")), "the update is text after Q1");
      assert.equal(query.trigger, userRecordName(q1, 1));
    });

    // A user message of attachments alone, sent while a tool ran, delivered with the results.
    let imageAlone: { names: string[]; image: string } | undefined;
    await cases.run("a text message sent while a tool ran, after an image sent alone, joins the parked turn under its name", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "Q1");
      claude.state.toolTurn = true;
      let m2 = "";
      let m3 = "";
      const { turn, query } = await run(chat, {
        toolOutput: async () => {
          m2 = await opencode.say(chat, "", [{ mediaType: "image/png", data: testPng("USER-IMAGE") }]);
          m3 = await opencode.say(chat, "Q3");
          return "ok";
        },
      });
      const results = turn.requests.at(-1)!;
      assert.ok(results.list.some((m) => m.id === m2 && m.content.every((p) => p.type === "media")), "the image alone is a message of media in the list");
      assert.ok(results.body.messages.some((m) => m.role === "user" && Array.isArray(m.content) && m.content.every((p: any) => p.type === "image_url")), "and a user message of an image in the body");
      const names = query.input.filter((i) => !i.noTurn).map((i) => i.uuid!);
      imageAlone = { names, image: userRecordName(m2, 1) };
      assert.ok(names.includes(userRecordName(m3, 1)), `the parked turn got Q3 under its name: ${JSON.stringify(names)}`);
      assert.ok(claude.records(query.name).some((r) => r.type === "attachment" && r.attachment?.source_uuid === userRecordName(m3, 1)), "Claude took Q3 into the turn");
    });

    await cases.run("the image sent alone while a tool ran reaches the parked turn under its own name", () => {
      assert.ok(imageAlone, "the case before it ran its turn");
      assert.ok(imageAlone.names.includes(imageAlone.image), `the image sent alone while the tool ran reached Claude: ${JSON.stringify(imageAlone.names)}`);
    });

    await cases.run("old images OpenCode took out of the body are its notes there, the list keeps them, the chat stays on its transcript", async () => {
      // As OpenCode sends a user's files: a text part "Attached file: <path>"
      // before each image from disk; a message left with text parts alone is
      // one string in the body, the parts joined with nothing between them
      // (openai-chat lowerUserMessage).
      const removed =
        "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]";
      const image = (label: string, path?: string) => ({ mediaType: "image/png", data: testPng(label), ...(path ? { path } : {}) });
      const chat = opencode.newChat();
      await opencode.say(chat, "what is on it?", [image("shot-1", "C:\\work\\shot-1.png"), image("shot-2", "C:\\work\\shot-2.png")]);
      await run(chat);
      await opencode.say(chat, "", [image("alone")]);
      await run(chat);
      // Then a tool returns screenshots, 30 MiB of them: OpenCode's bound is passed, the oldest images go first.
      await opencode.say(chat, "take screenshots");
      claude.state.toolTurn = true;
      const shot = "A".repeat(6 * 1024 * 1024);
      await run(chat, { toolOutput: "five screenshots", toolFiles: [1, 2, 3, 4, 5].map((n) => ({ mime: "image/png", data: shot, name: `screen-${n}.png` })) });
      for (const [n, latest] of [[3, "Q3"], [4, "Q4"]] as const) {
        const id = await opencode.say(chat, latest);
        const { turn, query } = await run(chat);
        const body = turn.requests[0]!.body.messages.filter((m) => m.role === "user");
        assert.equal(body[0]!.content, `what is on it?Attached file: C:\\work\\shot-1.png${removed}Attached file: C:\\work\\shot-2.png${removed}`, `turn ${n}: the first images are OpenCode's notes`);
        assert.equal(body[1]!.content, removed, `turn ${n}: the image alone is its note`);
        assert.ok(turn.requests[0]!.list[0]!.content.some((p) => p.type === "media"), `turn ${n}: the list still holds the image`);
        assert.equal(query.trigger, userRecordName(id, 1), `turn ${n} is named after its question`);
        assert.notEqual(query.params.persistSession, false, `turn ${n} is written to the chat's transcript`);
        assert.equal(query.params.resume, claude.queries.at(-2)!.name, `turn ${n} resumes the chat's transcript`);
      }
    });

    await cases.run("a stale list with the same texts after a revert: the newest list is the request's, the stale one is dropped", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "Q1");
      await run(chat);
      const m2 = await opencode.say(chat, "Q2");
      // The user stops the turn before its request left: the hook ran, its list stays behind.
      const stop = new AbortController();
      stop.abort();
      const before = claude.queries.length;
      const stopped = await opencode.turn(chat, { stop: stop.signal });
      assert.ok(stopped.stopped && claude.queries.length === before, "the stopped request never reached the plugin");
      // A revert, and the same question again: a new message, the same texts.
      opencode.undoBefore(chat, m2);
      const m4 = await opencode.say(chat, "Q2");
      const { query } = await run(chat);
      assert.equal(query.trigger, userRecordName(m4, 1), "the turn is named by the newest list, not the stale one");
      // The next question: the stale list no longer fits, and is dropped.
      const m5 = await opencode.say(chat, "next");
      const next = await run(chat);
      assert.equal(next.query.trigger, userRecordName(m5, 1));
      assert.ok(world.journal().some((line) => line.includes("dropped the list of a chat request that never arrived") && line.includes(`"sessionID":"${chat}"`) && line.includes('"found":true')), "the stale list was dropped");
    });

    await cases.run("another plugin's hook rewrote the text: the list fits, the turn runs as usual on the text sent", async () => {
      // OpenCode hands every plugin's hook one event and builds the body from
      // it; the plugin keeps that same event.
      const chat = opencode.newChat();
      await opencode.say(chat, "Q1");
      const before = await run(chat);
      const m6 = await opencode.say(chat, "then");
      opencode.state.foreignHook = (event) => {
        event.messages = event.messages.map((m) => (m.id === m6 ? { ...m, content: [{ type: "text", text: "elsewhere" }] } : m));
      };
      const journalBefore = world.journal().length;
      let rewritten: Awaited<ReturnType<typeof run>>;
      try {
        rewritten = await run(chat);
      } finally {
        opencode.state.foreignHook = undefined;
      }
      assert.ok(rewritten.turn.requests[0]!.body.messages.some((m) => m.role === "user" && m.content === "elsewhere"), "the body carries the other plugin's text");
      assert.equal(rewritten.query.trigger, userRecordName(m6, 1), "the turn's record is named after the message");
      assert.equal(rewritten.query.params.resume, before.query.name, "the chat's transcript goes on");
      assert.notEqual(rewritten.query.params.persistSession, false);
      assert.ok(textOfInput(rewritten.query).includes("elsewhere"), "Claude reads the text OpenCode sent");
      assert.equal(rewritten.turn.requests[0]!.reply!.reasoning ?? "", "", "no note above the answer");
      assert.deepEqual(world.journal().slice(journalBefore).filter((line) => /dropped the list|does not match OpenCode's message list/.test(line)), [], "no list dropped, no mismatch");
      // Not on the simulators: how OpenCode 2.0.32 sends a body whose texts are not the list's was not
      // found (another plugin's hook changes the one event both read); the plugin's unmatchedList path
      // has no test here. The check as it would read: a list whose texts differ from the body is not
      // the request's: it is dropped, and the turn runs once outside the chat's transcript (no name,
      // nothing on disk, the history as text), with a note above the answer.
      // const outside = await opencode.turn(chat);
      // const reply = outside.requests.at(-1)!.reply!;
      // assert.match(reply.reasoning ?? "", /\[claude-code warning\] OpenCode's message list did not match this request/, "the note says why");
      // const turn = claude.queries.at(-1)!;
      // assert.equal(turn.trigger, undefined, "no record name: the list's ids are not the request's");
      // assert.equal(turn.params.persistSession, false, "nothing written to disk");
      // assert.equal(turn.params.resume, undefined, "the chat's transcript is not resumed");
      // assert.equal(turn.params.sessionId, undefined, "no transcript is named");
      // assert.match(JSON.stringify(turn.input.map((i) => i.content)), /Q1[\s\S]*Q2[\s\S]*next/, "the history went as text");
      // assert.ok(world.journal().some((line) => /dropped the list of a chat request that never arrived.*"dropped":1/.test(line)), "the unfit list was dropped");
      // assert.ok(world.journal().some((line) => line.includes("the request does not match OpenCode's message list")), "the journal says so too");
      // Not on the simulators: how OpenCode 2.0.32 sends a turn with no `context` hook was not found
      // (the plugin's NO_CONTEXT_EVENT guard has no test here). The check as it would read:
      // no hook ran at all for a request: refused, 400, not retried.
      // opencode.state.skipContextHook = true;
      // const unannounced = await opencode.turn(chat);
      // assert.equal(unannounced.requests[0]!.status, 400);
      // assert.equal(unannounced.requests[0]!.reply!.headers.get("x-should-retry"), "false");
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
