/**
 * Regression: images and PDFs reach Claude from OpenCode's chat.
 * - A tool's files: when a parked turn resumes they reach Claude as MCP
 *   image / resource blocks of that result; they are neither steering nor
 *   the user's prompt. OpenCode's list holds them inside the `tool-result`
 *   part; only the HTTP body moves them into a text-less user message after
 *   the results. (An image a tool returns by URL:
 *   tool-media-url-note-regression.ts.)
 * - A user's attachments (a PNG and a PDF as media, a text file inlined)
 *   become the prompt's image, document and text blocks.
 * (A summary that reads the chat's history puts a tool's image back onto
 * its result: tool-media-summary-image-regression.ts.)
 * (Ported from the fork's 906cb03 + 62a8f7c.)
 *
 * On the simulators (test/simulators/): OpenCode 2.0.32 sends a tool's files
 * as a text-less user message after the tool results (`turn`'s `toolFiles`,
 * BEHAVIOR.md "The HTTP body": an image as `image_url`, a URL as it is, a
 * PDF as `file`); Claude Code keeps the MCP result as blocks, an image with
 * its note of the saved file (BEHAVIOR.md "Tool results"). The user's files
 * from disk as OpenCode takes them (`say` with `path`). OpenCode 1.x's
 * labelled message is not sent by 2.0.32 and is not covered here. Each case
 * is a chat of its own; the tool step is `toolFilesTurn` (simulators/turns.ts).
 *
 * Run: bun test/tool-media-regression.ts
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { testCases } from "./simulators/cases.ts";
import { testPng, type ToolFile } from "./simulators/opencode.ts";
import { toolFilesTurn } from "./simulators/turns.ts";
import { createWorld } from "./simulators/world.ts";

const PDF = Buffer.from("%PDF-1.4\n%simulated\n").toString("base64");

async function main() {
  const world = await createWorld("media");
  const { opencode, claude } = world;
  const cases = testCases();

  const run = (ask: string, output: string, files?: ToolFile[]) => toolFilesTurn(world, ask, output, files);

  try {
    await opencode.startPlugin();

    await cases.run("a tool's PDF reaches Claude as a document block of its result", async () => {
      const pdf = await run("read the pdf", "PDF read", [{ mime: "application/pdf", data: PDF, name: "doc.pdf" }]);
      assert.deepEqual(pdf.map((b) => b.type), ["text", "document"]);
      assert.equal(pdf[0]!.text, "PDF read");
      assert.equal(pdf[1]!.source.data, PDF);
      assert.equal(pdf[1]!.source.media_type, "application/pdf");
    });

    await cases.run("a tool's image reaches Claude as an image block, then Claude Code's note of the saved file", async () => {
      const png = testPng("tool-media");
      const image = await run("take a screenshot", "Image read successfully", [{ mime: "image/png", data: png }]);
      assert.deepEqual(image.map((b) => b.type), ["text", "image", "text"]);
      assert.equal(image[1]!.source.data, png);
      assert.equal(image[1]!.source.media_type, "image/png");
      assert.match(image[2]!.text, /^\[Image: source: /);
    });

    await cases.run("a tool's plain text stays text", async () => {
      const plain = await run("list", "exit 0");
      assert.deepEqual(plain, [{ type: "text", text: "exit 0" }]);
    });

    await cases.run("a text-less image the user sends outside a tool step is the prompt", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "hello");
      assert.ok((await opencode.turn(chat)).ok);
      const own = testPng("user-own");
      await opencode.say(chat, "", [{ mediaType: "image/png", data: own }]);
      const from = claude.queries.length;
      assert.ok((await opencode.turn(chat)).ok);
      assert.ok(claude.queries[from]!.input.some((message) => !message.noTurn && contentText(message.content).includes(`[image ${own}]`)), "the user's image is the prompt");
    });

    await cases.run("a user's attachments from disk become the prompt's image, document and text blocks in order", async () => {
      // Probe 11: OpenCode names each file, then the PNG and the PDF as media
      // and the text file inlined.
      const chat = opencode.newChat();
      const png = testPng("user-attached");
      await opencode.say(chat, "what do they say?", [
        { mediaType: "image/png", data: png, name: "shot.png", path: "C:\\work\\shot.png" },
        { mediaType: "application/pdf", data: PDF, name: "doc.pdf", path: "C:\\work\\doc.pdf" },
        { mediaType: "text/plain", data: Buffer.from("kiwi").toString("base64"), name: "note.txt", path: "C:\\work\\note.txt" },
      ]);
      const from = claude.queries.length;
      assert.ok((await opencode.turn(chat)).ok);
      const [prompt, ...more] = claude.queries[from]!.input.filter((message) => !message.noTurn);
      assert.equal(more.length, 0, "one prompt");
      const blocks = prompt!.content as Array<Record<string, any>>;
      assert.deepEqual(blocks.map((b) => b.type), ["text", "image", "text", "document", "text"]);
      assert.match(blocks[0]!.text, /what do they say\?[\s\S]*Attached file: C:\\work\\shot\.png/);
      assert.equal(blocks[1]!.source.data, png);
      assert.equal(blocks[3]!.source.media_type, "application/pdf");
      assert.equal(blocks[3]!.source.data, PDF);
      assert.match(blocks[4]!.text, /note\.txt[\s\S]*kiwi/);
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
