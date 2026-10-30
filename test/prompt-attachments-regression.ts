/**
 * An image and a PDF the user sends reach Claude as an image and a document
 * block beside the text of the prompt.
 *
 * On the simulators (BEHAVIOR.md "The HTTP body"): OpenCode sends the files
 * as it lowers media (`image_url` with a data URL, a `file` part for the PDF);
 * the prompt is what the Claude Code simulator's query got.
 *
 * Run: bun test/prompt-attachments-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("prompt-attachments");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();

await cases.run("an image and a PDF the user sends are an image and a document block after the text", async () => {
  const pdfB64 = Buffer.from("%PDF-1.0\n").toString("base64");
  const chat = opencode.newChat();
  await opencode.say(chat, "read this", [
    { mediaType: "image/png", data: testPng("attached") },
    { mediaType: "application/pdf", data: pdfB64, name: "note.pdf" },
  ]);
  const from = claude.queries.length;
  const turn = await opencode.turn(chat);
  assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
  const prompts = claude.queries[from]!.input.filter((message) => !message.noTurn);
  assert.equal(prompts.length, 1, "one prompt");
  const prompt = prompts[0]!.content as Array<{ type: string; text?: string; source?: { type: string; media_type?: string; data?: string } }>;
  assert.ok(Array.isArray(prompt), "the files make the prompt blocks");
  assert.deepEqual(prompt.map((block) => block.type), ["text", "image", "document"]);
  assert.equal(prompt[0]!.text, "read this");
  assert.deepEqual(prompt[1]!.source, { type: "base64", media_type: "image/png", data: testPng("attached") });
  assert.deepEqual(prompt[2]!.source, { type: "base64", media_type: "application/pdf", data: pdfB64 });
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
