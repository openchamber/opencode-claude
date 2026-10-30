/**
 * The `compactAt` option (1.7.0): OpenCode compacts a chat on a 1M model at
 * about this many tokens instead of near 850K. The plugin gives such a model
 * an input limit that OpenCode's own 15% reserve brings down to the option;
 * the window stays 1M, so a turn that runs over still has Claude's whole
 * window, and a model of a smaller window is left alone. A value that is not
 * a positive number is ignored.
 *
 * On the simulators (test/simulators/): the plugin's options as OpenCode
 * passes them from its config (`startPlugin({ compactAt })`; another project
 * folder for each other value), the catalog OpenCode got
 * (`instance.provider.models`), and a chat on Sonnet 5 whose answer reports a
 * context past the option (`claude.state.usage`): OpenCode 2.2.0 compacts
 * before the next request (BEHAVIOR.md "Compaction": the ceiling is the input
 * limit less 15%).
 *
 * Run: bun test/compact-at-regression.ts
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { testCases } from "./simulators/cases.ts";
import { createWorld } from "./simulators/world.ts";

type Listed = { id: string; limit: { context: number; input?: number } };

const world = await createWorld("compact-at");
const { opencode, claude } = world;
const cases = testCases();
const instance = await opencode.startPlugin({ compactAt: 400_000 });
const sonnetOf = (models: Listed[]) => models.find((m) => m.id === "claude-sonnet-5")!;

await cases.run("compactAt: the 1M models' input limit puts OpenCode's compaction at the option, the window stays 1M", async () => {
  const models = instance.provider.models as Listed[];
  const sonnet = sonnetOf(models);
  assert.equal(sonnet.limit.context, 1_000_000);
  assert.equal(sonnet.limit.input, 470_588);
  assert.equal(Math.round(sonnet.limit.input! * 0.85), 400_000, "OpenCode's 15% reserve brings it to the option");
  const small = models.filter((m) => m.limit.context === 200_000);
  assert.ok(small.length > 0, "a model of a 200K window in the catalog");
  assert.deepEqual(small.filter((m) => m.limit.input !== undefined).map((m) => m.id), [], "smaller models are left alone");
});

await cases.run("compactAt: a chat whose context passed the option is compacted before its next request", async () => {
  opencode.state.modelID = "claude-sonnet-5";
  try {
    const chat = opencode.newChat();
    await opencode.say(chat, "one");
    claude.state.usage = { input_tokens: 420_000 };
    const big = await opencode.turn(chat);
    claude.state.usage = {};
    assert.ok(big.ok, `the turn answered: ${big.requests.at(-1)?.status}`);
    assert.equal(big.compactions?.length ?? 0, 0, "below the option while it ran");
    await opencode.say(chat, "two");
    const next = await opencode.turn(chat);
    assert.ok(next.ok, `the turn after answered: ${next.requests.at(-1)?.status}`);
    assert.equal(next.compactions?.[0]?.status, "completed", "OpenCode compacted at 420K of a 1M window");
  } finally {
    opencode.state.modelID = undefined;
    claude.state.usage = {};
  }
});

await cases.run("compactAt that is not a positive number is ignored", async () => {
  for (const [index, value] of (["400000", 0, -1] as unknown[]).entries()) {
    const directory = join(world.tmp, `compact-at-${index}`);
    mkdirSync(directory, { recursive: true });
    const other = await opencode.startPlugin({ compactAt: value }, { directory });
    assert.equal(sonnetOf(other.provider.models as Listed[]).limit.input, undefined, `compactAt ${JSON.stringify(value)}: no input limit`);
  }
});

await cases.run("no error in the plugin's journal", () => {
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
