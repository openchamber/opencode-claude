/**
 * The history transferred as text, as fix/whole-history-transfer builds it
 * (and the chain up to chain/content-from-list): a chat another model
 * answered so far has no Claude session to resume, so its first Claude turn
 * carries the history ahead of the latest message in `<conversation_history>`,
 * whole — tool output uncut, nothing dropped for length (OpenCode sized the
 * request), an image of the history as an image block in its place. main's
 * form: history-transfer-main-regression.ts; the series' final one (a record
 * of the chat, chain/record-per-message): history-transfer-regression.ts.
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): the chat's earlier turns
 * answered by another model (`otherModelAnswer`), so the chat has no Claude
 * transcript and Claude's first turn carries the history, built from what
 * OpenCode sent, before the latest message. Independent cases
 * (test/simulators/cases.ts).
 *
 * Run: bun test/history-transfer-whole-regression.ts (trees: where.md)
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("history-transfer-whole");
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
const injected = (chat: string) => world.journal().some((line) => line.includes("injecting transferred conversation history") && line.includes(chat));
const image = (label: string) => ({ mediaType: "image/png", data: testPng(label) });

await cases.run("a history without files is text ending with the answer, the latest message after it, no system prompt", async () => {
  // The earlier messages as User: and Assistant: lines, ending with the answer before the latest user turn, which
  // follows as the latest message; the system prompt never leaks in.
  const { chat, content } = await transferred(async (chat) => {
    await opencode.say(chat, "remember the codename AXIOM-9042");
    opencode.otherModelAnswer(chat, "Got it — codename AXIOM-9042 noted.");
    await opencode.say(chat, "what is the codename?");
  });
  assert.equal(typeof content, "string", "a history without files is text");
  const text = content as string;
  const [history, latest] = text.split("Latest user message:\n");
  assert.match(history!, /<conversation_history>/);
  assert.match(history!, /AXIOM-9042/);
  assert.match(history!, /^User:/m);
  assert.match(history!, /^Assistant:/m);
  assert.match(history!, /Assistant:\nGot it — codename AXIOM-9042 noted\.\n<\/conversation_history>/, "the history ends with the answer");
  assert.doesNotMatch(history!, /what is the codename\?/, "the latest user turn is not history");
  assert.equal(latest, "what is the codename?");
  assert.doesNotMatch(text, /You are OpenCode\./, "the system prompt never leaks into the transfer");
  assert.ok(injected(chat), "the journal names the transfer");
});

await cases.run("tool calls and their results, the output whole, labelled with the tool", async () => {
  // The result is labelled with the tool it answers, not the call id.
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
  assert.match(text, /\[called tool: bash\]/);
  assert.match(text, /Tool result \(bash\):/);
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

await cases.run("an image in the history goes as an image block in its place", async () => {
  const look = image("look");
  const { content } = await transferred(async (chat) => {
    await opencode.say(chat, "look", [look]);
    opencode.otherModelAnswer(chat, "a square");
    await opencode.say(chat, "what was it?");
  });
  assert.ok(Array.isArray(content), "a history with files is blocks");
  assert.deepEqual(content.map((b) => b.type), ["text", "image", "text"]);
  assert.equal(content[1]!.source?.data, look.data);
  assert.doesNotMatch(JSON.stringify(content), /omitted/);
});

await cases.run("a chat without history: the prompt is the message untouched", async () => {
  const { content } = await transferred(async (chat) => {
    await opencode.say(chat, "hi");
  });
  assert.equal(content, "hi");
});

await cases.run("a text history and a latest message with an image: the history's text block first, the attachment kept", async () => {
  const seen = image("see this");
  const { content } = await transferred(async (chat) => {
    await opencode.say(chat, "remember the codename AXIOM-9042");
    opencode.otherModelAnswer(chat, "Got it.");
    await opencode.say(chat, "see this", [seen]);
  });
  assert.ok(Array.isArray(content), "a prompt of blocks");
  assert.equal(content[0]!.type, "text");
  assert.match(content[0]!.text!, /<conversation_history>[\s\S]*AXIOM-9042/);
  assert.equal(content[2]!.type, "image");
  assert.equal(content[2]!.source?.data, seen.data);
});

await cases.run("a history with files and a latest message with one: the history's image in place, the latest one after", async () => {
  // One prompt of blocks, the history's image before "Latest user message:", the latest message's own after it.
  const look = image("AA");
  const next = image("BB");
  const { content } = await transferred(async (chat) => {
    await opencode.say(chat, "look", [look]);
    opencode.otherModelAnswer(chat, "a square");
    await opencode.say(chat, "and this one?", [next]);
  });
  const fw = content as Block[];
  assert.deepEqual(fw.map((b) => b.type), ["text", "image", "text", "image"]);
  assert.match(fw[0]!.text!, /<conversation_history>[\s\S]*User:\nlook/);
  assert.equal(fw[1]!.source!.data, look.data);
  assert.match(fw[2]!.text!, /a square\n<\/conversation_history>\n\nLatest user message:\nand this one\?$/);
  assert.equal(fw[3]!.source!.data, next.data);
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
