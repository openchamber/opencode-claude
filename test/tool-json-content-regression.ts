/**
 * Regression: OpenCode 2.x sends a tool message's content parts JSON-encoded
 * in a string (`[{"type":"text",...},{"type":"file","uri":"data:...","mime":...}]`).
 * The parts must reach Claude as MCP text / image / resource blocks, not as
 * one text block of JSON with the image's base64 inside it.
 *
 * The author's test (1.6.1) on hand-laid inputs, kept as he wrote it: OpenCode
 * 2.0.32 and 2.2.0 send no such tool message on the plugin's route (their
 * native openai-compatible provider puts a tool result's text parts in the
 * tool message and its files in a user message after it), so no turn of the
 * simulators reaches this form. The plugin's module through the world, so the
 * file runs on any tree that has the author's functions (where.md).
 *
 * Run: bun test/tool-json-content-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld, pluginModule } from "./simulators/world.ts";

const png = "iVBORw0KGgo=";
const pdf = "JVBERi0xLjQK";

async function main() {
  const world = await createWorld("tool-json-content");
  const { decodeToolMessageContent, openaiToolResultToMcpContent } = await pluginModule("prompt");
  const relay = (content: unknown) =>
    openaiToolResultToMcpContent(decodeToolMessageContent(content));

  // The shape observed from OpenCode 2.x's read tool on a JPEG/PNG.
  const image = relay(
    JSON.stringify([
      { type: "text", text: "Image read successfully" },
      { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "shot.png" },
    ]),
  );
  assert(image.length === 2, `image: expected 2 blocks, got ${JSON.stringify(image)}`);
  assert(
    image[0]?.type === "text" && image[0].text === "Image read successfully",
    "image: text part kept as text",
  );
  assert(
    image[1]?.type === "image" && image[1].data === png && image[1].mimeType === "image/png",
    `image: file part became an MCP image block, got ${JSON.stringify(image[1])}`,
  );

  // A PDF becomes an embedded resource, as for every other tool media path.
  const doc = relay(
    JSON.stringify([{ type: "file", uri: `data:application/pdf;base64,${pdf}`, mime: "application/pdf" }]),
  );
  assert(
    doc[0]?.type === "resource" && doc[0].resource.blob === pdf,
    `pdf: expected a resource block, got ${JSON.stringify(doc)}`,
  );

  // Text-only parts are unwrapped to plain text (no JSON envelope for the model).
  const textOnly = relay(JSON.stringify([{ type: "text", text: "line 1\nline 2" }]));
  assert(
    textOnly.length === 1 && textOnly[0]?.type === "text" && textOnly[0].text === "line 1\nline 2",
    `text-only: expected plain text, got ${JSON.stringify(textOnly)}`,
  );

  // A file part whose uri cannot ride inline says so instead of vanishing.
  const local = relay(JSON.stringify([{ type: "file", uri: "file:///c/a.bin", name: "a.bin" }]));
  assert(
    local[0]?.type === "text" && local[0].text.includes("a.bin"),
    `local uri: expected a text note, got ${JSON.stringify(local)}`,
  );

  // Strings that are not that shape stay exactly as they were.
  for (const raw of [
    "plain output",
    "[1, 2, 3]",
    '[{"name":"not a part"}]',
    '[{"type":"text"}]',
    '[{"type":"unknown","text":"x"}]',
    "[not json",
    "[]",
  ]) {
    const out = relay(raw);
    assert(
      out.length === 1 && out[0]?.type === "text" && out[0].text === raw.trim(),
      `untouched: ${raw} -> ${JSON.stringify(out)}`,
    );
  }

  // Non-string content is passed through unchanged.
  const arr = [{ type: "text", text: "x" }];
  assert(decodeToolMessageContent(arr) === arr, "array content passes through");

  // With a cache breakpoint the JSON string arrives inside one text part.
  const wrapped = relay([
    {
      type: "text",
      text: JSON.stringify([
        { type: "text", text: "Image read successfully" },
        { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "shot.png" },
      ]),
      cache_control: { type: "ephemeral" },
    },
  ]);
  assert(
    wrapped.length === 2 && wrapped[1]?.type === "image",
    `wrapped: expected text + image, got ${JSON.stringify(wrapped)}`,
  );
  const plainPart = [{ type: "text", text: "just output" }];
  assert(decodeToolMessageContent(plainPart) === plainPart, "a plain text part stays as is");

  await world.dispose();
  console.log("tool-json-content-regression: ok");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
