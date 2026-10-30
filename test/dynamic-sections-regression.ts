/**
 * Regression: chat turns ask Claude Code to keep the working directory,
 * memory path and git status out of its system prompt. With them in, no two
 * sessions share the prompt and every new session writes all of it to the
 * cache again; without them a new session reads it from the cache. Utility
 * turns (titles) keep their own one-line prompt, and
 * OPENCODE_CLAUDE_DYNAMIC_SECTIONS=keep restores the old layout.
 *
 * On the simulators (test/simulators/): a chat turn and OpenCode's title of
 * the chat; the system prompt the plugin asked for is in the query's
 * parameters. That the flag reaches Claude Code (the old test stubbed the
 * SDK's `query`): for one request each, the plugin's real query starter and
 * the real SDK start the simulated CLI process, which logs the SDK's
 * `initialize` request (`claude.cli.calls()`) and refuses the turn.
 *
 * Run: bun test/dynamic-sections-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

type PresetPrompt = { type?: string; preset?: string; excludeDynamicSections?: boolean };

async function main() {
  const world = await createWorld("dynamic-sections");
  const { opencode, claude } = world;
  const systemPromptOf = () => claude.queries.at(-1)!.params.systemPrompt;
  try {
    await opencode.startPlugin();
    const chat = opencode.newChat();
    await opencode.say(chat, "hello");
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
    const preset = systemPromptOf() as PresetPrompt;
    assert.equal(preset.type, "preset");
    assert.equal(preset.preset, "claude_code");
    assert.equal(preset.excludeDynamicSections, true, "chat turns drop the dynamic sections");

    const title = await opencode.title(chat);
    assert.ok(title.title, `OpenCode titled the chat: ${title.requests.at(-1)?.status}`);
    assert.equal(claude.queries.at(-1)!.kind, "summary", "a title is a query of its own, not saved");
    assert.equal(typeof systemPromptOf(), "string", "a title keeps its own one-line prompt");

    process.env.OPENCODE_CLAUDE_DYNAMIC_SECTIONS = "keep";
    const kept = opencode.newChat();
    await opencode.say(kept, "hello");
    assert.ok((await opencode.turn(kept)).ok);
    assert.equal((systemPromptOf() as PresetPrompt).type, "preset");
    assert.equal((systemPromptOf() as PresetPrompt).excludeDynamicSections, undefined, "keep restores the old layout");
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    delete process.env.OPENCODE_CLAUDE_DYNAMIC_SECTIONS;

    /** A chat turn through the plugin's real query starter and the real SDK (world.throughRealSdk): the flag in `initialize`. */
    const flagsOfTurn = async () => [(await world.throughRealSdk()).initialize!.excludeDynamicSections];
    const chatFlags = await flagsOfTurn();
    assert.ok(chatFlags.every((flag) => flag === true), `the flag reaches Claude Code: ${JSON.stringify(chatFlags)}`);
    process.env.OPENCODE_CLAUDE_DYNAMIC_SECTIONS = "keep";
    const keptFlags = await flagsOfTurn();
    assert.ok(keptFlags.every((flag) => flag !== true), `keep: no flag reaches Claude Code: ${JSON.stringify(keptFlags)}`);
  } finally {
    delete process.env.OPENCODE_CLAUDE_DYNAMIC_SECTIONS;
    await world.dispose();
  }
  console.log("ok — dynamic sections regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
