/**
 * The history transferred as text: a chat another model answered so far has
 * no Claude session to resume, so its first Claude turn carries a record of
 * the chat from its start (`[User]:` and `[Assistant]:` lines, the tool calls
 * as OpenCode labels them, closed by `</recent-context>`) ahead of the latest
 * message — whole: tool output uncut, nothing dropped for length (OpenCode
 * sized the request), an image of the history as an image block in its
 * place. Earlier forms: history-transfer-main-regression.ts (main 1.6.0),
 * history-transfer-whole-regression.ts (fix/whole-history-transfer up to
 * chain/content-from-list).
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): the chat's earlier turns
 * answered by another model (`otherModelAnswer`), so the chat has no Claude
 * transcript and Claude's first turn carries the history, built from
 * OpenCode's list, before the latest message. Independent cases
 * (test/simulators/cases.ts).
 *
 * Run: bun test/history-transfer-regression.ts (trees: where.md)
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("history-transfer");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();

type Block = { type: string; text?: string; source?: { data?: string } };
/** A new chat set up by `history`, then Claude's turn: its one prompt. */
const transferred = async (history: (chat: string) => Promise<void>) => {
  const chat = opencode.newChat();
  await history(chat);
  const from = claude.queries.length;
  const turn = await opencode.turn(chat);
  assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
  assert.equal(claude.queries[from]!.params.resume, undefined, "no transcript to resume");
  const prompts = claude.queries[from]!.input.filter((message) => !message.noTurn);
  assert.equal(prompts.length, 1, "one prompt");
  return { chat, content: prompts[0]!.content as string | Block[] };
};
/** The journal names the transfer, and the history rides the turn's record. */
const injected = (chat: string) =>
  world.journal().some((line) => line.includes("transferring history") && line.includes(chat)) &&
  world.journal().some((line) => line.includes("turn records") && line.includes(chat) && !line.includes('"historyChars":0'));
const image = (label: string) => ({ mediaType: "image/png", data: testPng(label) });

await cases.run("a history without files is a text record ending with the answer, the question after it, no system prompt", async () => {
  // The record of the chat from its start, the earlier messages as [User]: and [Assistant]: lines, ending with the
  // answer before the latest user turn, which follows the record; the system prompt never leaks in.
  const { chat, content } = await transferred(async (chat) => {
    await opencode.say(chat, "remember the codename AXIOM-9042");
    opencode.otherModelAnswer(chat, "Got it — codename AXIOM-9042 noted.");
    await opencode.say(chat, "what is the codename?");
  });
  assert.equal(typeof content, "string", "a history without files is text");
  const text = content as string;
  assert.match(text, /<\/recent-context>\n\nwhat is the codename\?$/, "the record ahead of the question");
  const [history, latest] = text.split("</recent-context>\n\n");
  assert.match(history!, /^The following is a serialized record of this conversation from its start/);
  assert.match(history!, /AXIOM-9042/);
  assert.match(history!, /^\[User\]: remember/m);
  assert.match(history!, /^\[Assistant\]: Got it/m);
  assert.match(history!, /\[Assistant\]: Got it — codename AXIOM-9042 noted\.\n$/, "the history ends with the answer");
  assert.doesNotMatch(history!, /what is the codename\?/, "the latest user turn is not history");
  assert.equal(latest, "what is the codename?");
  assert.doesNotMatch(text, /You are OpenCode\./, "the system prompt never leaks into the transfer");
  assert.ok(injected(chat), "the journal names the transfer");
});

await cases.run("tool calls and their results, the output whole, labelled as OpenCode labels them", async () => {
  // The call with its input, then its result.
  const { content } = await transferred(async (chat) => {
    await opencode.say(chat, "run tests");
    opencode.otherModelAnswer(chat, "running", {
      toolCalls: [{ id: "c1", name: "bash", input: {} }],
      toolResults: [{ id: "c1", output: "x".repeat(5000) }],
      finish: "tool-calls",
    });
    opencode.otherModelAnswer(chat, "tests ran");
    await opencode.say(chat, "and now?");
  });
  const text = String(content);
  assert.match(text, /\[Assistant tool call\]: bash\(\{\}\)/);
  assert.match(text, /\[Tool result\]: x/);
  assert.ok(text.includes("x".repeat(5000)), "the tool output goes whole");
});

await cases.run("nothing is dropped for length", async () => {
  // OpenCode sized the request.
  const { content } = await transferred(async (chat) => {
    await opencode.say(chat, "OLD-MESSAGE-MARKER " + "y".repeat(500_000));
    opencode.otherModelAnswer(chat, "a long one");
    await opencode.say(chat, "NEW-MESSAGE-MARKER");
  });
  assert.match(String(content), /OLD-MESSAGE-MARKER/);
  assert.ok(String(content).includes("y".repeat(500_000)), "the old message whole");
  assert.match(String(content), /NEW-MESSAGE-MARKER/);
});

await cases.run("an image in the history goes as an image block in its place, the question after the record", async () => {
  const look = image("look");
  const { content } = await transferred(async (chat) => {
    await opencode.say(chat, "look", [look]);
    opencode.otherModelAnswer(chat, "a square");
    await opencode.say(chat, "what was it?");
  });
  assert.ok(Array.isArray(content), "a history with files is blocks");
  assert.deepEqual(content.map((b) => b.type), ["text", "image", "text", "text"]);
  assert.equal(content[1]!.source?.data, look.data);
  assert.equal(content[3]!.text, "what was it?", "the question after the record");
  assert.doesNotMatch(JSON.stringify(content), /omitted/);
});

await cases.run("a chat without history: no record, the prompt is the message untouched", async () => {
  const { content } = await transferred(async (chat) => {
    await opencode.say(chat, "hi");
  });
  assert.equal(content, "hi");
});

await cases.run("a text history and a latest message with an image: the record first, the attachment kept", async () => {
  const seen = image("see this");
  const { content } = await transferred(async (chat) => {
    await opencode.say(chat, "remember the codename AXIOM-9042");
    opencode.otherModelAnswer(chat, "Got it.");
    await opencode.say(chat, "see this", [seen]);
  });
  assert.ok(Array.isArray(content), "a prompt of blocks");
  assert.equal(content[0]!.type, "text");
  assert.match(content[0]!.text!, /serialized record of this conversation from its start[\s\S]*AXIOM-9042/);
  assert.equal(content[2]!.type, "image");
  assert.equal(content[2]!.source?.data, seen.data);
});

await cases.run("a history with files and a latest message with one: the history's image in place, the latest one after the record", async () => {
  const look = image("AA");
  const next = image("BB");
  const { content } = await transferred(async (chat) => {
    await opencode.say(chat, "look", [look]);
    opencode.otherModelAnswer(chat, "a square");
    await opencode.say(chat, "and this one?", [next]);
  });
  const fw = content as Block[];
  assert.deepEqual(fw.map((b) => b.type), ["text", "image", "text", "text", "image"]);
  assert.match(fw[0]!.text!, /\[User\]: look/);
  assert.equal(fw[1]!.source!.data, look.data);
  assert.match(fw[2]!.text!, /\[Assistant\]: a square\n<\/recent-context>$/);
  assert.equal(fw[3]!.text, "and this one?");
  assert.equal(fw[4]!.source!.data, next.data);
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
