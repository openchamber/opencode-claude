/**
 * The history transferred as text, as main 1.6.0 builds it: a chat another
 * model answered so far has no Claude session to resume, so its first Claude
 * turn carries the history ahead of the latest message in
 * `<conversation_history>`, tool output cut, an image of the history left as
 * a note, the oldest messages dropped beyond a budget
 * (OPENCODE_CLAUDE_HISTORY_MAX_CHARS). The series sends the history whole
 * (fix/whole-history-transfer: history-transfer-whole-regression.ts) and then
 * as a record of the chat (chain/record-per-message:
 * history-transfer-regression.ts).
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): the chat's earlier turns
 * answered by another model (`otherModelAnswer`), then Claude's turn; the
 * prompt is what the Claude Code simulator's query got.
 * Independent cases (test/simulators/cases.ts).
 *
 * Run: bun test/history-transfer-main-regression.ts (trees: where.md)
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("history-transfer-main");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();

/** The prompt of the latest Claude query: its first input message. */
const lastPrompt = () => claude.queries.at(-1)!.input[0]!.content;

await cases.run("the history before the latest message, the latest message after it, no system prompt", async () => {
  const chat = opencode.newChat();
  await opencode.say(chat, "remember the codename AXIOM-9042");
  opencode.otherModelAnswer(chat, "Got it — codename AXIOM-9042 noted.");
  await opencode.say(chat, "what is the codename?");
  const turn = await opencode.turn(chat);
  assert.ok(turn.ok, "the turn answered");
  const system = String(turn.requests[0]!.body.messages[0]!.content);
  const prompt = String(lastPrompt());
  const [history, latest] = prompt.split("\n</conversation_history>\n\n");
  assert.match(history!, /^<conversation_history>\n/);
  assert.match(history!, /^User:\nremember the codename AXIOM-9042$/m);
  assert.match(history!, /^Assistant:\nGot it — codename AXIOM-9042 noted\.$/m);
  assert.doesNotMatch(history!, /what is the codename/, "the latest message is not history");
  assert.equal(latest, "Latest user message:\nwhat is the codename?");
  assert.ok(system.length > 0 && !prompt.includes(system.split("\n")[0]!) && !/# Your Model|Today's date/.test(prompt), "the system prompt is not transferred");
});

await cases.run("a first message has no history: the prompt is the message alone", async () => {
  const chat = opencode.newChat();
  await opencode.say(chat, "hi");
  await opencode.turn(chat);
  assert.equal(lastPrompt(), "hi");
});

await cases.run("tool calls condensed, a long result cut, images of the history as notes, the latest image kept", async () => {
  // A long result cut, labelled with its tool; an image in the history (the user's, a tool's by URL) leaves a note;
  // a latest message with an image keeps it, the history ahead as text.
  const chat = opencode.newChat();
  await opencode.say(chat, "run tests");
  opencode.otherModelAnswer(chat, "running", {
    toolCalls: [{ id: "call_1", name: "bash", input: { command: "bun test" } }],
    toolResults: [{ id: "call_1", output: "x".repeat(5000) }],
    finish: "tool-calls",
  });
  opencode.otherModelAnswer(chat, "taking a screenshot", {
    toolCalls: [{ id: "call_2", name: "bash", input: { command: "shot" } }],
    toolResults: [{ id: "call_2", output: "saved", files: [{ mime: "image/png", data: "https://example.com/shot.png" }] }],
    finish: "tool-calls",
  });
  opencode.otherModelAnswer(chat, "tests ran");
  await opencode.say(chat, "look", [{ mediaType: "image/png", data: testPng("in history") }]);
  opencode.otherModelAnswer(chat, "seen");
  await opencode.say(chat, "see this", [{ mediaType: "image/png", data: testPng("latest") }]);
  assert.ok((await opencode.turn(chat)).ok, "the turn answered");
  const prompt = lastPrompt() as Array<{ type: string; text?: string; source?: { data?: string } }>;
  assert.deepEqual(prompt.map((block) => block.type), ["text", "text", "image"]);
  const history = prompt[0]!.text!;
  assert.match(history, /^<conversation_history>\n/);
  assert.match(history, /\[called tool: bash\]/);
  assert.match(history, /Tool result \(bash\):/, "the result is labelled with the tool it answers, not the call id");
  assert.match(history, /chars omitted/);
  assert.match(history, /Tool result \(bash\):\nsaved\n\nUser:\n\s*\[attachment\(s\) omitted from transferred history\]/, "a tool's image by URL");
  assert.match(history, /User:\nlook\n\[attachment\(s\) omitted from transferred history\]/, "the user's image");
  assert.equal(prompt[1]!.text, "see this");
  assert.equal(prompt[2]!.source?.data, testPng("latest"));
});

/** A chat with an old long message and a newer answer, Claude's turn under the budget `budget`: its prompt. */
const withBudget = async (budget: string) => {
  process.env.OPENCODE_CLAUDE_HISTORY_MAX_CHARS = budget;
  try {
    const chat = opencode.newChat();
    await opencode.say(chat, "OLD-MESSAGE-MARKER " + "y".repeat(200));
    opencode.otherModelAnswer(chat, "NEW-MESSAGE-MARKER");
    await opencode.say(chat, "next");
    assert.ok((await opencode.turn(chat)).ok, "the turn answered");
    return String(lastPrompt());
  } finally {
    delete process.env.OPENCODE_CLAUDE_HISTORY_MAX_CHARS;
  }
};

await cases.run("the budget keeps the newest messages and drops the oldest first", async () => {
  const tight = await withBudget("100");
  assert.match(tight, /NEW-MESSAGE-MARKER/);
  assert.doesNotMatch(tight, /OLD-MESSAGE-MARKER/);
  assert.match(tight, /earlier message\(s\) omitted/);
});

await cases.run("a budget of 0 sends no history", async () => {
  assert.equal(await withBudget("0"), "next");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
