/**
 * Regression: Claude Code's own auto-compaction is off for every query the
 * plugin starts, because OpenCode compacts the chat. The switch the CLI
 * honours is the `autoCompactEnabled` *setting*; the plugin used to pass a
 * top-level option of that name, which the Agent SDK does not know, so the
 * CLI kept compacting on its own (verified on CLI 2.1.304: the setting turns
 * it off, the option changes nothing). An overflow is still handled: the
 * CLI's "Prompt is too long" becomes a context overflow for OpenCode, which
 * compacts and retries (turn-errors-regression.ts covers that mapping).
 *
 * On the simulators (test/simulators/): a chat turn, OpenCode's title of a
 * chat and its compaction (a summary), each through the plugin's real query
 * starter and the real SDK (`world.throughRealSdk`), start the simulated CLI
 * process, which logs its arguments: the SDK hands the settings over as
 * `--settings <json>` (sdk.mjs 0.3.300, ProcessTransport `initialize`; not in
 * the `initialize` request), and a top-level option it does not know reaches
 * the CLI nowhere. The title and the summary are told apart from a chat turn
 * by their own arguments (`--no-session-persistence`; the summary's
 * `--fork-session`).
 *
 * Run: bun test/cli-autocompact-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { createWorld } from "./simulators/world.ts";

/** The settings JSON the SDK put on the CLI's command line, or undefined. */
function settingsOf(args: string[]): Record<string, unknown> | undefined {
  const at = args.indexOf("--settings");
  if (at >= 0) return JSON.parse(args[at + 1]!);
  const joined = args.find((arg) => arg.startsWith("--settings="));
  return joined ? JSON.parse(joined.slice("--settings=".length)) : undefined;
}

/** No flag of its own for auto-compaction, and nothing of it in initialize. */
function onlyTheSetting(start: { args: string[]; initialize?: Record<string, any> }, what: string) {
  assert.ok(!start.args.some((arg) => /auto-?compact/i.test(arg) && !arg.startsWith("{")), `${what}: no flag of its own on the command line`);
  assert.ok(!JSON.stringify(start.initialize ?? {}).includes("autoCompact"), `${what}: nothing of it in initialize`);
}

async function main() {
  const world = await createWorld("cli-autocompact");
  const { opencode, claude } = world;
  const cases = testCases();
  try {
    await opencode.startPlugin();
    // The plugin's setup reads the account's model list through the SDK (a start with no prompt and no
    // model): waited for, so the starts below are the queries under test.
    const modelList = () => claude.cli.calls().find((call) => call.initialize && !call.args.some((arg) => arg.startsWith("--model")));
    for (let waited = 0; !modelList(); waited += 50) {
      if (waited >= 15_000) throw new Error("the plugin's setup did not read the model list in 15 s");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    await cases.run("a chat turn: the setting off, a saved session", async () => {
      // Effort set, tools bridged, nothing else special.
      const chat = await world.throughRealSdk();
      assert.ok(!chat.args.includes("--no-session-persistence"), `chat turn: a saved session: ${chat.args.join(" ")}`);
      assert.equal(settingsOf(chat.args)?.autoCompactEnabled, false, `chat turn: setting off: ${chat.args.join(" ")}`);
      onlyTheSetting(chat, "chat turn");
    });

    await cases.run("a title: the setting off, not saved, other settings kept", async () => {
      // A one-shot utility turn: isolated MCP, no thinking.
      const title = await world.throughRealSdk(claude.cli, "hello", "title");
      assert.ok(title.args.includes("--no-session-persistence"), `title: not saved: ${title.args.join(" ")}`);
      assert.ok(!title.args.includes("--fork-session"), "title: no fork");
      assert.equal(settingsOf(title.args)?.autoCompactEnabled, false, `title: setting off: ${title.args.join(" ")}`);
      assert.equal(settingsOf(title.args)?.disableClaudeAiConnectors, true, "other settings keep working");
      onlyTheSetting(title, "title");
    });

    await cases.run("a summary: the setting off, an unsaved fork of the chat's session", async () => {
      const summary = await world.throughRealSdk(claude.cli, "hello", "summary");
      assert.ok(summary.args.includes("--no-session-persistence") && summary.args.includes("--fork-session"), `summary: an unsaved fork: ${summary.args.join(" ")}`);
      assert.equal(settingsOf(summary.args)?.autoCompactEnabled, false, `summary: setting off: ${summary.args.join(" ")}`);
      onlyTheSetting(summary, "summary");
    });

    await cases.run("the plugin's journal holds no error", async () => {
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
