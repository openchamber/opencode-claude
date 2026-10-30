/**
 * Regression: the plugin refuses chat turns on a Claude Code older than
 * MIN_CLI_VERSION with a message that says what to do (the transcript names
 * need `sessionId`, user message uuids and records without a turn; nothing
 * below 2.1.300 was checked). Titles and summaries are not refused: they
 * resume nothing.
 *
 * On the simulators (test/simulators/): the Claude Code simulator's CLI on
 * PATH answers `claude --version` with the version the test sets
 * (`claude.cli.set({ version })`); the plugin notes it at setup and asks the
 * CLI again from a refused turn. A version change without a reload, and the
 * minute between two questions, go through the plugin's `noteCliVersion`
 * (what setup calls; noting also resets the minute). The user's turns are
 * OpenCode's; what started is in `claude.queries`, the questions to the CLI in
 * `claude.cli.calls()`.
 *
 * Run: bun test/cli-version-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("cli-version");
  const { opencode, claude } = world;
  const proxy = world.plugin.proxy;
  try {
    const { MIN_CLI_VERSION, cliTooOldMessage, cliVersionTooOld } = world.plugin.detect;
    const { userRecordName } = await pluginModule("names");
    assert.equal(MIN_CLI_VERSION, "2.1.300");
    assert.equal(cliVersionTooOld("2.1.299 (Claude Code)"), true);
    assert.equal(cliVersionTooOld("2.0.999"), true);
    assert.equal(cliVersionTooOld("1.9.0"), true);
    assert.equal(cliVersionTooOld("2.1.300"), false);
    assert.equal(cliVersionTooOld("2.1.305 (Claude Code)"), false);
    assert.equal(cliVersionTooOld("3.0.0"), false);
    assert.equal(cliVersionTooOld(null), false, "an unknown version is not refused");
    assert.equal(cliVersionTooOld("garbage"), false);
    assert.match(cliTooOldMessage("2.1.200"), /2\.1\.200 is too old/);
    assert.match(cliTooOldMessage("2.1.200"), /claude update/);

    /** Chat queries Claude Code got (not the plugin's background read of the model list, not titles). */
    const chatQueries = () => claude.queries.filter((query) => query.kind === "chat").length;
    /** How many times the plugin asked the CLI for its version. */
    const versionAsks = () => claude.cli.calls().filter((call) => call.args.includes("--version")).length;
    /** One user message in `chat` and OpenCode's turn: its first request. */
    const sayAndTurn = async (chat: string, text: string) => {
      const id = await opencode.say(chat, text);
      const turn = await opencode.turn(chat);
      return { id, turn, first: turn.requests[0]! };
    };
    /** The refused turn's request: 503, not retried, the message says what to do. */
    const assertRefused = (chat: string, request: { status: number; reply?: { raw?: string; headers: Headers } }, what: string) => {
      assert.equal(request.status, 503, `${what}: refused`);
      assert.equal(request.reply?.headers.get("x-should-retry"), "false", `${what}: not to be retried`);
      assert.match(JSON.parse(request.reply!.raw!).error.message, /2\.1\.200 is too old/, `${what}: the message names the version`);
      assert.equal(opencode.retries.filter((retry) => retry.chat === chat).length, 0, `${what}: OpenCode does not send it again`);
    };

    // The CLI on the machine is 2.1.200: setup notes it, and the journal says so.
    claude.cli.set({ version: "2.1.200" });
    await opencode.startPlugin();
    assert.ok(
      world.journal().some((line) => /level=error/.test(line) && line.includes("Claude Code is too old for this plugin") && line.includes("2.1.200")),
      "the journal names the old CLI",
    );

    // A chat turn is refused; the CLI the refused turn asks again answers with the noted version: nothing changed.
    const startedBefore = chatQueries();
    const oldCli = opencode.newChat();
    const refused = await sayAndTurn(oldCli, "hi");
    assertRefused(oldCli, refused.first, "a turn on 2.1.200");
    assert.equal(chatQueries(), startedBefore, "no turn started");

    // A title is not refused: it resumes nothing.
    const titled = await opencode.title(oldCli);
    assert.equal(titled.requests[0]?.status, 200, "a title on 2.1.200");

    // A CLI new enough: the turn runs.
    claude.cli.set({ version: "2.1.305" });
    proxy.noteCliVersion("2.1.305 (Claude Code)");
    const newCli = opencode.newChat();
    const ok = await sayAndTurn(newCli, "hi");
    assert.equal(ok.first.status, 200, ok.first.reply?.raw);
    assert.ok(ok.turn.ok);
    assert.equal(chatQueries(), startedBefore + 1);

    // Two refused requests of one chat, then the CLI is updated: the refused requests leave no
    // list behind, and the first allowed turn is planned on its own list, not on the oldest one.
    claude.cli.set({ version: "2.1.200" });
    proxy.noteCliVersion("2.1.200 (Claude Code)");
    const updated = opencode.newChat();
    assertRefused(updated, (await sayAndTurn(updated, "Q10")).first, "Q10");
    assertRefused(updated, (await sayAndTurn(updated, "Q20")).first, "Q20");
    claude.cli.set({ version: "2.1.305" });
    proxy.noteCliVersion("2.1.305 (Claude Code)");
    const allowed = await sayAndTurn(updated, "Q30");
    assert.equal(allowed.first.status, 200, allowed.first.reply?.raw);
    assert.equal(chatQueries(), startedBefore + 2);
    const turn = claude.queries.at(-1)!;
    // Planned on the stale list of the first refused request, the turn's record would be named after Q10.
    const prompt = turn.input.filter((message) => !message.noTurn).map((message) => JSON.stringify(message.content)).join("\n");
    assert.ok(prompt.includes("Q30"), `the turn is about the message it was sent for: ${prompt}`);
    assert.equal(turn.trigger, userRecordName(allowed.id, 1), "the record is named after Q30");

    // The user updates the CLI as told: the next refused turn asks the CLI again and goes through,
    // without a reload; the CLI is asked at most once a minute (the first refusal below asks it).
    claude.cli.set({ version: "2.1.200" });
    proxy.noteCliVersion("2.1.200 (Claude Code)");
    const updatedCli = opencode.newChat();
    assertRefused(updatedCli, (await sayAndTurn(updatedCli, "first")).first, "before the update");
    const asked = versionAsks();
    assertRefused(updatedCli, (await sayAndTurn(updatedCli, "again")).first, "within the minute");
    assert.equal(versionAsks(), asked, "within the minute the CLI is not asked again");
    claude.cli.set({ version: "2.1.306" });
    proxy.noteCliVersion("2.1.200 (Claude Code)"); // noting resets the minute (a test seam for the clock)
    const afterUpdate = await sayAndTurn(updatedCli, "after the update");
    assert.equal(afterUpdate.first.status, 200, afterUpdate.first.reply?.raw);
    assert.equal(versionAsks(), asked + 1, "the CLI was asked once more");
    assert.equal(chatQueries(), startedBefore + 3);

    const errors = world.journal().filter((line) => /level=error/.test(line) && !line.includes("Claude Code is too old for this plugin"));
    assert.deepEqual(errors, [], "no other error in the plugin's journal");
    console.log("ok — cli version regression passed");
  } finally {
    proxy.noteCliVersion(null);
    await world.dispose();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
