/**
 * Fast mode (#62): OpenCode has no speed setting, so a model the CLI says
 * supports fast mode gets a second picker entry, "<name> Fast". Picking it
 * runs the turn with the SDK's `fastMode` setting; the plain entry does not.
 * The entries carry the model's own id at 1M: "claude-opus-5-5" and
 * "claude-opus-5-5:fast" (1.7.0; the window from the 1M table on main, from
 * the CLI's answer with PR #59). The id 1.6.0 gave the fast entry,
 * "claude-opus-5-5[1m]:fast", is not listed any more: a chat on it asks the
 * user to pick the model again, as 1.7.0 says.
 *
 * On the simulators (test/simulators/): the model list comes from the CLI
 * process (`claude.cli.set({ models })`, the rows of its `initialize`
 * answer), and each model's window from its `set_model` and
 * `get_context_usage` answers (CLI 2.1.312: 1M for the current models); the
 * plugin reads them in the background at setup and reloads its provider, so
 * the entries are in OpenCode's catalog. A turn on each entry; the model and
 * `fastMode` the plugin asked for are in the query's parameters.
 *
 * Run: bun test/fast-mode-regression.ts
 */
import assert from "node:assert/strict";

import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("fast-mode");
  const { opencode, claude } = world;
  try {
    claude.cli.set({
      models: [
        { value: "default", resolvedModel: "claude-opus-5-5", supportsFastMode: true },
        { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high"], supportsFastMode: true },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
      ],
    });
    const instance = await opencode.startPlugin();
    // The catalog is refreshed from the CLI after setup.
    const deadline = Date.now() + 10_000;
    while (!instance.provider.models.some((m: any) => m.id.endsWith(":fast")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const catalog = instance.provider.models as Array<{ id: string; name: string; status: string; limit: { context: number }; variants: Array<{ id: string }> }>;
    assert.deepEqual(
      catalog.map((m) => [m.id, m.name]),
      [
        ["claude-opus-5-5", "Opus 5.5"],
        ["claude-opus-5-5:fast", "Opus 5.5 Fast"],
        ["claude-sonnet-5-5", "Sonnet 5.5"],
      ],
    );
    const fast = catalog[1]!;
    assert.equal(fast.limit.context, 1_000_000, "the fast entry keeps its model's window");
    assert.deepEqual(fast.variants.map((v) => v.id), ["low", "high"], "keeps the model's effort variants");
    assert.ok(claude.cli.calls().some((call) => call.args.includes("stream-json")), "the list came from the CLI process");
    // The ids 1.6.0 gave Opus 5.5 are not in the catalog, hidden or not: OpenCode asks to pick the model again.
    const ids = catalog.map((m) => m.id);
    assert.ok(!ids.some((id) => id.includes("[1m]")), `no [1m] id in the catalog: ${ids}`);

    const seen: Array<{ model: unknown; fastMode: unknown }> = [];
    for (const model of ["claude-opus-5-5:fast", "claude-opus-5-5"]) {
      opencode.state.modelID = model;
      const chat = opencode.newChat();
      await opencode.say(chat, "hi");
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok, `${model}: the turn answered (${turn.requests.at(-1)?.status})`);
      // What the CLI got: the SDK's opt-in in the settings (`--settings`).
      const params = claude.queries.at(-1)!.params as Record<string, any>;
      seen.push({ model: params.model, fastMode: params.settings?.fastMode === true });
    }
    assert.deepEqual(seen, [
      { model: "claude-opus-5-5", fastMode: true },
      { model: "claude-opus-5-5", fastMode: false },
    ]);
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — fast-mode regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
