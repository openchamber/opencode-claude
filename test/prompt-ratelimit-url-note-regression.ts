/**
 * The case of prompt-ratelimit-regression.ts that fails by a finding - an
 * image a tool returns by URL leaves a note naming it among the result's
 * blocks. Main's `attachPromotedToolMedia` loses the note; the code goes with
 * chain/content-from-list, which reads the tool's files from OpenCode's list.
 * When the finding is fixed everywhere, the case goes back to
 * prompt-ratelimit-regression.ts.
 *
 * On the simulators: Claude reads a file of a new chat and OpenCode's tool
 * returns the URL with its text (test/simulators/turns.ts `readWithFiles`);
 * the result's blocks as Claude Code wrote them in the transcript.
 *
 * Run: bun test/prompt-ratelimit-url-note-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { readWithFiles } from "./simulators/turns.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("prompt-rl-url-note");
await world.opencode.startPlugin();
const cases = testCases();

await cases.run("an image a tool returns by URL leaves a note naming it", async () => {
  const result = await readWithFiles(world, [{ mime: "image/png", data: "https://example.com/chart.png" }]);
  assert.ok(
    result.some((b) => b.type === "text" && String(b.text).includes("https://example.com/chart.png")),
    `the URL image left a note: ${JSON.stringify(result)}`,
  );
});

await cases.run("no error in the plugin's journal", () => {
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
