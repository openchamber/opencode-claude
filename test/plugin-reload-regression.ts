/**
 * Regression: OpenCode reloads a plugin by importing a fresh copy of it and
 * unloading the old one (dist rebuilt, config changed, idle location torn
 * down). The old copy's unload stopped every parked turn: the CLI recorded
 * the pending tool calls as rejected by the user, and Claude stopped working
 * while the command was still running. Turns now live in the process, so the
 * reloaded copy resumes a turn parked by the old one; only the last plugin
 * instance of any copy stops them.
 *
 * On the simulators (test/simulators/): OpenCode unloads and loads the
 * plugin (`stopPlugin`, `startPlugin`; each instance holds the proxy through
 * `setup`) while the turn's tool runs (a tool output that is a promise:
 * OpenCode sends the results once it settled). The world holds the proxy as
 * another OpenCode location would; here OpenCode has this one location, so
 * the world lets go of its holder and the counts are relative to the one
 * `setup` takes. A stopped turn is what Claude Code writes when interrupted
 * on a tool call (CLI 2.1.312 against a local stub of the API: the rejected result
 * and its interruption record). The reload loads the same module copy again (a fresh copy per
 * reload is not simulated yet).
 *
 * Run: bun test/plugin-reload-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

const MARKER = "[Request interrupted by user for tool use]";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  process.env.OPENCODE_CLAUDE_RELOAD_GRACE_MS = "300";
  const world = await createWorld("plugin-reload");
  const { opencode, claude } = world;
  const { proxy } = world.plugin;
  try {
    const outside = proxy.proxyHolderCount() as number;
    let instance = await opencode.startPlugin();
    assert.equal(proxy.proxyHolderCount(), outside + 1, "setup holds the proxy");
    // OpenCode has one location with the plugin: its instance is the only holder.
    await proxy.releaseProxy();
    const base = (proxy.proxyHolderCount() as number) - 1;
    const interrupted = (name: string) => claude.records(name).some((r) => JSON.stringify(r.message?.content ?? "").includes(MARKER));

    const chat = opencode.newChat();
    await opencode.say(chat, "run the long command");
    claude.state.toolTurn = true;
    const queries = claude.queries.length;
    const first = await opencode.turn(chat, {
      // Reload, in OpenCode's order, while the command runs: the old instance
      // unloads, then the fresh one loads. The results arrive later than the grace period.
      toolOutput: async () => {
        const name = claude.queries.at(-1)!.name;
        await opencode.stopPlugin(instance);
        assert.equal(proxy.proxyHolderCount(), base, "the unloaded instance let go");
        await sleep(100);
        instance = await opencode.startPlugin();
        assert.equal(proxy.proxyHolderCount(), base + 1);
        await sleep(500);
        assert.equal(claude.queries.at(-1)!.outcome, "parked", "unloading the old instance left the parked turn alone");
        assert.ok(!interrupted(name), "no interruption written");
        return "finished";
      },
    });
    assert.ok(first.ok, `the turn answered: ${first.requests.map((r) => r.status).join(",")}`);
    assert.equal(first.requests.length, 2, "one request with the call, one with its result");
    assert.equal(first.requests[1]!.reply!.finish, "stop");
    assert.equal(claude.queries.length - queries, 1, "resumed, not rebuilt");
    const name = claude.queries.at(-1)!.name;
    assert.ok(claude.records(name).some((r) => JSON.stringify(r.toolUseResult ?? "").includes("finished")), "Claude got the command's result");
    assert.ok(world.journal().some((line) => line.includes("resuming parked bridge")));

    // The last instance going away still stops what is left, after the grace period.
    await opencode.say(chat, "again");
    claude.state.toolTurn = true;
    const late = await opencode.turn(chat, {
      toolOutput: async () => {
        const query = claude.queries.at(-1)!;
        await opencode.stopPlugin(instance);
        assert.equal(proxy.proxyHolderCount(), base);
        await sleep(50);
        assert.ok(!interrupted(query.name) && query.outcome === "parked", "a reload's grace period first");
        await sleep(500);
        assert.equal(query.outcome, "stopped", "the last release stopped the parked turn after the grace period");
        assert.ok(interrupted(query.name), "Claude Code wrote the interruption");
        // OpenCode loads the plugin again before the command ends: the results find no parked turn.
        instance = await opencode.startPlugin();
        return "ls";
      },
    });
    assert.ok(late.ok, `the late turn answered: ${late.requests.map((r) => r.status).join(",")}`);
    assert.ok(world.journal().some((line) => line.includes("tool results arrived with no parked turn")));
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
    delete process.env.OPENCODE_CLAUDE_RELOAD_GRACE_MS;
  }
  console.log("plugin-reload regression ok");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
