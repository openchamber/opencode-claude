/**
 * Regression (1.6.1): OpenCode's cache warming pings an idle chat with a
 * generate request every few minutes. Through Claude Code the ping warms
 * nothing the chat's turns reuse, and each one re-read the whole history from
 * the plan's limits. It is answered without starting Claude; other generate
 * requests still run.
 *
 * On the simulators (test/simulators/): OpenCode's `warming` setting
 * (`opencode.state.warming`, a short interval here; BEHAVIOR.md "Cache
 * warming"): after a chat's turn OpenCode pings the idle chat with its
 * keep-alive prompt as a generation of the whole chat, streamed as every
 * request of OpenCode's is (`opencode.warming.pings`; one ping now:
 * `opencode.warming.ping`). Another generation is `opencode.generate`. What
 * Claude Code started: `claude.queries`.
 *
 * Run: bun test/cache-warming-regression.ts
 */
import assert from "node:assert/strict";

import { WARMING_DEFAULTS } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("cache-warming");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    opencode.state.warming = { interval: 50, duration: 3_000 };
    const chat = opencode.newChat();
    await opencode.say(chat, "a long chat history");
    assert.ok((await opencode.turn(chat)).ok, "the chat's turn answered");
    const asked = claude.queries.length;

    // OpenCode's own ping, once the chat is idle.
    const deadline = Date.now() + 5_000;
    while (!opencode.warming.pings.some((p) => p.chat === chat) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const ping = opencode.warming.pings.find((p) => p.chat === chat);
    assert.ok(ping, "OpenCode pinged the idle chat");
    assert.equal(ping.failure, undefined, `the ping did not fail: ${JSON.stringify(ping.failure)}`);
    assert.equal(ping.text, "OK", "the ping answered with OpenCode's expected reply");
    opencode.state.warming = undefined;
    opencode.stopBackground();

    // The same request as OpenCode sends it, its reply read whole.
    const direct = await opencode.generate(chat, WARMING_DEFAULTS.prompt);
    assert.equal(direct.reply?.status, 200);
    assert.equal(direct.text, "OK");
    assert.equal(direct.reply?.finish, "stop");
    assert.ok(!direct.reply?.streamError, "the stream ended with [DONE]");
    assert.equal(claude.queries.length, asked, "a warming ping never starts Claude");

    // Another generation still runs on Claude.
    claude.state.summaryReplies = ["generated"];
    const real = await opencode.generate(chat, "Summarize the open questions.");
    assert.equal(real.text, "generated");
    assert.equal(claude.queries.length, asked + 1, "other generate requests still run");

    const journal = world.journal();
    assert.ok(journal.some((line) => line.includes("answered a cache warming ping without Claude")), "the journal names the ping");
    assert.deepEqual(journal.filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    opencode.state.warming = undefined;
    await world.dispose();
  }
  console.log("ok — cache warming regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
