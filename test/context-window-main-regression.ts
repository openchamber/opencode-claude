/**
 * A summary that cannot resume the chat's Claude session reads the history as
 * text, cut to about three characters a token of the chat model's window;
 * the window is the one the CLI reported for the model, so a model that runs
 * at 1M without `[1m]` in its id (Opus 5.5) gets the 1M budget, and one at
 * 200K (Opus 4.6) the 200K budget. This is the behaviour of
 * fix/context-window-on-1.6 alone: main sizes by the suffix only, and from
 * fix/whole-history-transfer on the history goes whole.
 *
 * On the simulators (test/simulators/): the CLI lists Opus 5.5 at 1M and
 * Opus 4.6 at 200K (`claude.cli.set({ models, windows })`), the plugin
 * refreshes its list; a chat whose earlier answer came from another provider
 * (`otherModelAnswer`, about 700,000 characters) has no Claude session, and
 * OpenCode compacts it (`compact`) on each model; what the summary's query
 * got is `claude.queries` (`promptChars`).
 *
 * Run: bun test/context-window-main-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { createWorld } from "./simulators/world.ts";

const rows = [
  { value: "opus", displayName: "Opus 5.5", description: "", resolvedModel: "claude-opus-5-5" },
  { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "", resolvedModel: "claude-opus-4-6" },
];
/** Longer than the 200K budget (600,000 characters), shorter than the 1M one (3,000,000). */
const LONG = 700_000;

async function main() {
  const world = await createWorld("context-window-main");
  const { opencode, claude } = world;
  const cases = testCases();
  try {
    claude.cli.set({ models: rows, windows: { "claude-opus-5-5": 1_000_000, "claude-opus-4-6": 200_000 } });
    await opencode.startPlugin();
    world.plugin.index.modelRefreshRuntime.lastModelRefresh = 0;
    await world.plugin.index.refreshModelCatalog();

    /** A chat another provider answered at length, compacted on `model`; the characters the summary's query got. */
    const summaryOn = async (model: string) => {
      opencode.state.modelID = model;
      const chat = opencode.newChat();
      await opencode.say(chat, "a long question");
      opencode.otherModelAnswer(chat, `${"long answer ".repeat(LONG / 12)}the end`);
      await opencode.say(chat, "and now?");
      const before = claude.queries.length;
      await opencode.compact(chat);
      const summary = claude.queries.slice(before).find((q) => q.kind === "summary") ?? claude.queries.slice(before).at(-1);
      assert.ok(summary, "the summary reached Claude Code");
      assert.equal(summary.at, null, "no session to resume: the history as text");
      return summary.promptChars;
    };

    await cases.run("a model at 1M without [1m] in its id: the summary reads the whole history", async () => {
      const chars = await summaryOn("claude-opus-5-5");
      assert.ok(chars > LONG, `the whole answer (${LONG} characters), got ${chars}`);
      return `${chars} characters`;
    });

    await cases.run("a model at 200K: the history is cut to its budget", async () => {
      const chars = await summaryOn("claude-opus-4-6");
      assert.ok(chars < 610_000, `about 600,000 characters, got ${chars}`);
      return `${chars} characters`;
    });

    await cases.run("the plugin's journal holds no error", async () => {
      assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    });
  } finally {
    opencode.state.modelID = undefined;
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
