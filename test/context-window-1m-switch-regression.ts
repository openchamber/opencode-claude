/**
 * Regression: the 1M switch (CLAUDE_CODE_DISABLE_1M_CONTEXT) turned on after
 * the plugin listed a `[1m]` variant the CLI ran at 1M. With the switch on the
 * CLI runs every model at 200K and refuses every `[1m]` id, so the list holds
 * no `[1m]` variant any more, though the plugin's last answers still have
 * one at 1M. Was a finding (the variant stayed listed from the last answers),
 * fixed 30.10.2026: with the switch on the plugin counts every `[1m]` id as
 * refused without asking. The same case is in context-window-regression.ts;
 * this file checks it through the plugin's own refresh (`refreshModelCatalog`).
 *
 * On the simulators (test/simulators/): the world's Claude Code process
 * answers the model list and the windows as CLI 2.1.312 did (its probed
 * answers, Opus 4.6 at 200K and its `[1m]` variant at 1M), and with the switch
 * in its environment as the probe with the switch on (every model at 200K,
 * the `[1m]` ids refused). A refresh is the plugin's own
 * (`refreshModelCatalog`, as every ten minutes); the list it serves is
 * `getClaudeModels`.
 *
 * Run: bun test/context-window-1m-switch-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  for (const name of ["CLAUDE_CODE_DISABLE_1M_CONTEXT", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "DISABLE_COMPACT"]) delete process.env[name];
  const world = await createWorld("context-window-1m-switch");
  const cases = testCases({ timeoutMs: 180_000 });
  const { getClaudeModels } = await pluginModule("models");
  const { modelRefreshRuntime, refreshModelCatalog } = world.plugin.index;

  /** One refresh as the plugin runs it every ten minutes. */
  const refresh = async () => {
    modelRefreshRuntime.lastModelRefresh = 0;
    await refreshModelCatalog();
  };
  /** The list the plugin serves, without the old ids kept as aliases: "<id> <window>". */
  const current = () =>
    (getClaudeModels() as Array<{ id: string; contextWindow: number }>).map((m) => `${m.id} ${m.contextWindow}`);

  try {
    await cases.run("the 1M switch turned on: a [1m] variant the CLI ran at 1M before is no longer listed (the CLI refuses it now)", async () => {
      await refresh();
      assert.ok(current().includes("claude-opus-4-6[1m] 1000000"), `Opus 4.6 (1M) listed while the switch is off: ${current().join(", ")}`);
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
      try {
        await refresh();
        assert.ok(current().every((line) => line.endsWith(" 200000") && !line.includes("[1m]")), `every model at 200K: ${current().join(", ")}`);
      } finally {
        delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
      }
    });

    await cases.run("the plugin's journal holds no error", async () => {
      assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    });
  } finally {
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
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
