/**
 * The case of tool-media-regression.ts that fails by a finding - a summary
 * that reads the chat's history puts a tool's image right after its result,
 * then the answer: not as a message of the user's. Main's history as text
 * drops a tool's files (fixed by fix/whole-history-transfer); read from the
 * body, a step's files go after all its results (reading OpenCode's list is
 * chain/content-from-list's step). When the finding is fixed everywhere, the
 * case goes back to tool-media-regression.ts.
 *
 * On the simulators: no transcript of the chat - another model ran its tool
 * step (`otherModelAnswer` with the image on the result), so the summary
 * carries the history; what Claude got is the summary query's input.
 *
 * Run: bun test/tool-media-summary-image-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("tool-media-summary-image");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();

await cases.run("a summary that reads the chat's history puts the tool's image right after its result", async () => {
  const chat = opencode.newChat();
  await opencode.say(chat, "shoot");
  const png = testPng("summary-media");
  opencode.otherModelAnswer(chat, "", {
    toolCalls: [{ id: "call_1", name: "bash", input: { command: "cat" } }],
    toolResults: [{ id: "call_1", output: "Image read successfully", files: [{ mime: "image/png", data: png }] }],
    finish: "tool-calls",
  });
  opencode.otherModelAnswer(chat, "A1");
  const from = claude.queries.length;
  const compacted = await opencode.compact(chat);
  assert.equal(compacted.requests[0]?.status, 200);
  const summary = claude.queries[from]!;
  assert.equal(summary.kind, "summary");
  const blocks = summary.input[0]!.content as Array<Record<string, any>>;
  const at = blocks.findIndex((b) => b.type === "image");
  assert.ok(at > 0, `the summary has the tool's image: ${JSON.stringify(blocks.map((b) => b.type))}`);
  assert.equal(blocks[at]!.source.data, png);
  assert.match(
    blocks[at - 1]!.text,
    /(Tool result \(bash\):\nImage read successfully\s*|\[Tool result\]: Image read successfully\n\[Attached image\/png[^\]]*\])$/,
    "right after the tool's result",
  );
  assert.match(blocks[at + 1]!.text, /^\s*(Assistant:\nA1|\[Assistant\]: A1)/, "then the answer: no user message of its own");
});

await cases.run("no error in the plugin's journal", () => {
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
