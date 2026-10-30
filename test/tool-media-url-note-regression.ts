/**
 * The case of tool-media-regression.ts that fails by a finding - an image a
 * tool returns by URL reaches Claude as a note naming it (it cannot be
 * relayed inline). Main's `attachPromotedToolMedia` loses it; the code goes
 * with chain/content-from-list, which reads the tool's files from OpenCode's
 * list. When the finding is fixed everywhere, the case goes back to
 * tool-media-regression.ts.
 *
 * On the simulators: one tool step of a new chat whose result carries the URL
 * (test/simulators/turns.ts `toolFilesTurn`), the result's blocks as Claude
 * Code wrote them in the transcript.
 *
 * Run: bun test/tool-media-url-note-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { testCases } from "./simulators/cases.ts";
import { toolFilesTurn } from "./simulators/turns.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("tool-media-url-note");
await world.opencode.startPlugin();
const cases = testCases();

await cases.run("an image a tool returns by URL reaches Claude as a note naming it", async () => {
  const url = await toolFilesTurn(world, "fetch the image", "Image fetched", [{ mime: "image/png", data: "https://example.com/a.png" }]);
  assert.ok(
    contentText(url).includes("[Image attachment could not be relayed inline; source URL: https://example.com/a.png]"),
    `the URL reaches Claude as a note: ${JSON.stringify(url)}`,
  );
});

await cases.run("no error in the plugin's journal", () => {
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
