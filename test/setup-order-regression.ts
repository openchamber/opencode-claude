/**
 * Regression: OpenCode v2 sets the plugin up again on a reload, and until
 * setup registers the provider its models are missing from the catalog; a
 * session stepping meanwhile failed with "Model unavailable". Setup waited
 * on the CLI probe (`claude --version`, `claude auth status`) first, and
 * every location ran its own.
 * - The provider and the model.request hook are registered while the CLI
 *   probe is still running.
 * - Setups running together share one probe.
 *
 * On the simulators (test/simulators/): two plugin instances set up at once
 * (two locations after a reload) while the CLI process answers slowly
 * (`claude.cli.set({ delayMs })`: every start of it, the old test slowed only
 * `auth status`); the CLI's starts are in `claude.cli.calls()`. An instance
 * serves in OpenCode while its setup still runs: what it registered so far
 * is its provider and hooks, and a turn then goes through them.
 *
 * Run: bun test/setup-order-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

const DELAY_MS = 1_000;

async function main() {
  const world = await createWorld("setup-order");
  const { opencode, claude } = world;
  try {
    claude.cli.set({ delayMs: DELAY_MS });
    let settled = false;
    const setups = Promise.all([opencode.startPlugin(), opencode.startPlugin()]).finally(() => (settled = true));
    // Until the probe has started the CLI (its starts are logged before the delay).
    const started = Date.now();
    while (!settled && !claude.cli.calls().some((call) => call.args[0] === "--version") && Date.now() - started < 10_000) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 0.3));
    // What OpenCode has from the two setups while the probe still runs.
    const during = opencode.instances.map((instance) => ({ models: instance.provider.models.length, hooked: typeof instance.hooks["model.request"] === "function" }));
    const probing = !settled && claude.cli.calls().some((call) => call.args[0] === "--version");
    assert.ok(probing, `the probe is running: settled ${settled}, ${JSON.stringify(claude.cli.calls().map((c) => c.args.join(" ")))}`);
    assert.equal(during.length, 2, `both instances are in OpenCode while the probe runs: ${JSON.stringify(during)}`);
    assert.ok(during.every((d) => d.models > 0), "both providers registered while the probe runs");
    assert.ok(during.every((d) => d.hooked), "both request hooks registered while the probe runs");
    // A session stepping meanwhile is served, not "Model unavailable".
    const chat = opencode.newChat();
    await opencode.say(chat, "hi");
    const turn = opencode.turn(chat);
    await setups;
    const answered = await turn;
    assert.ok(answered.ok, `the turn during the setups answered: ${answered.requests.at(-1)?.status}`);
    // The setups' shared probe and the turn's own plan check: two sign-in checks, one version check.
    assert.equal(claude.cli.calls().filter((call) => call.args[0] === "--version").length, 1, "one shared version check");
    assert.equal(claude.cli.calls().filter((call) => call.args[0] === "auth").length, 2, "one shared probe (and the turn's plan check)");
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("setup-order regression ok");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
