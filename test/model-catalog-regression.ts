/**
 * The model catalog OpenCode gets from the plugin, built from the CLI's own
 * list: a model with a native 1M window is listed once, by its own id (the
 * `[1m]` id 1.6.0 gave it is gone: a chat on it asks the user to pick the
 * model again, as 1.7.0 says), an optional 1M as the plain model and the
 * `[1m]` variant, Sonnet 4.6 at 200K only. main 1.7.0 takes the windows from
 * its 1M table, PR #59 from the CLI's answers (the `[1m]` variant listed only
 * where the CLI accepted it); for the CLI's answers here both give the same
 * catalog. The effort variants, the model names, and the refusal fallback
 * landing on the catalog's id. The windows themselves:
 * context-window-regression.ts.
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): the catalog is refreshed
 * from the CLI's model list in the background after setup (the rows of its
 * `initialize` answer and its windows, as CLI 2.1.312 gave them); Claude Code
 * refuses on Fable 5.1 and answers on its fallback model (`system` /
 * `model_refusal_fallback`, scope "session"; BEHAVIOR.md "Failures of a model
 * call": bio → claude-opus-5). Independent cases (test/simulators/cases.ts);
 * the catalog's wait and the refused turn: test/simulators/turns.ts. The
 * session following the fallback model after the plugin ran in another
 * folder fails by a finding: model-catalog-fallback-other-folder-regression.ts,
 * until it is fixed.
 *
 * Run: bun test/model-catalog-regression.ts (trees: where.md)
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { catalogFromCli, refusedOnFable } from "./simulators/turns.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

const world = await createWorld("model-catalog");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();
const { resolveClaudeModelId, modelNameFromId } = await pluginModule("models");
const { isClaudeEffort, EFFORT_LEVELS } = await pluginModule("constants");

/** The journal has no error line (the plugin's `level=error`). */
const noJournalErrors = (what: string) =>
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], `${what}: no error in the plugin's journal`);
type CatalogModel = {
  id: string; name: string; status: string; limit: { context: number; input?: number; output?: number };
  variants: Array<{ id: string }>; capabilities: { input: string[] };
};
const instance = await catalogFromCli(world);
const models = instance.provider.models as CatalogModel[];

await cases.run("the catalog is the CLI's own list by the windows it reports, the effort levels it lists, names from the ids", async () => {
  // The rows CLI 2.1.312 answered at setup (`initialize`: the aliases "default", "opus", "fable", "sonnet", "haiku"
  // beside the concrete ids, each with the effort levels it supports) and the window it answered for each id. The
  // plugin reads the list at most every 10 minutes per process, so a list changed later is not read again within
  // this world.
  const listed = models.map((m) => `${m.id} | ${m.name} | ${m.limit.context} | ${m.variants.map((v) => v.id).join(" ")}`);
  const all = "low medium high xhigh max";
  assert.deepEqual(listed, [
    // "default" repeats Opus 5.5 and is left out; an alias row is listed by its model's concrete id and named from it
    // (the CLI said "Default (recommended)" and "Opus 5.5"). A native 1M window: the model's own id.
    `claude-opus-5-5 | Opus 5.5 | 1000000 | ${all}`,
    `claude-opus-5-5:fast | Opus 5.5 Fast | 1000000 | ${all}`,
    `claude-fable-5-1 | Fable 5.1 | 1000000 | ${all}`,
    `claude-sonnet-5-5 | Sonnet 5.5 | 1000000 | ${all}`,
    `claude-haiku-5-5 | Haiku 5.5 | 1000000 | ${all}`,
    // No effort levels: no variants; the CLI's window, 200K.
    "claude-haiku-4-5-20251001 | Haiku 4.5 | 200000 | ",
    `claude-sonnet-5 | Sonnet 5 | 1000000 | ${all}`,
    `claude-opus-5 | Opus 5 | 1000000 | ${all}`,
    `claude-opus-5:fast | Opus 5 Fast | 1000000 | ${all}`,
    `claude-fable-5 | Fable 5 | 1000000 | ${all}`,
    `claude-opus-4-8 | Opus 4.8 | 1000000 | ${all}`,
    `claude-opus-4-8:fast | Opus 4.8 Fast | 1000000 | ${all}`,
    `claude-opus-4-7 | Opus 4.7 | 1000000 | ${all}`,
    // Optional 1M the CLI accepted: the plain model and the 1M variant; only the levels the CLI lists (no xhigh).
    "claude-opus-4-6 | Opus 4.6 | 200000 | low medium high max",
    "claude-opus-4-6[1m] | Opus 4.6 (1M) | 1000000 | low medium high max",
    // Optional 1M the CLI refused (`set_model` error for `claude-sonnet-4-6[1m]`): the plain model only.
    "claude-sonnet-4-6 | Sonnet 4.6 | 200000 | low medium high max",
  ]);
  assert.ok(claude.cli.calls().some((call) => call.args.includes("stream-json")), "the list came from the CLI process");
  const sonnet = models.find((m) => m.id === "claude-sonnet-5")!;
  assert.deepEqual(sonnet.variants.map((v) => v.id), [...EFFORT_LEVELS]);
  // The window the CLI reports for it (CLI 2.1.312: 1M) and its output.
  assert.equal(sonnet.limit.context, 1_000_000);
  assert.equal(sonnet.limit.output, 128_000);
  // Haiku takes no effort, so it gets no effort variants
  assert.deepEqual(models.find((m) => /^claude-haiku-4-5/.test(m.id))!.variants, []);
  // No input limit on 1M models: OpenCode keeps its own 15% free (2.2.0).
  assert.equal(models.find((m) => m.limit.context === 1_000_000)?.limit.input, undefined);
  assert.equal(sonnet.limit.input, undefined);
  assert.deepEqual(sonnet.capabilities.input, ["text", "image", "pdf"]);
  // An unchanged list is not a change: the provider is not reloaded. Waits for the simulator
  // to count OpenCode's provider reloads (it does not yet); the old check read
  // setDiscoveredModels' return value.
  noJournalErrors("the catalog from the CLI");
});

await cases.run("the [1m] ids 1.6.0 gave native 1M models are not in the catalog", async () => {
  // 1.6.0 listed Opus 5.5, Fable 5.1, Opus 5 and Fable 5 as `[1m]`. OpenCode runs only listed models, so a chat on
  // such an id asks the user to pick the model again (1.7.0's changelog).
  const ids = models.map((m) => m.id);
  for (const old of ["claude-opus-5-5[1m]", "claude-opus-5-5[1m]:fast", "claude-fable-5-1[1m]", "claude-opus-5[1m]", "claude-fable-5[1m]"]) {
    assert.ok(!ids.includes(old), `${old} is not listed: ${ids.join(", ")}`);
  }
  assert.equal(ids.filter((id) => id === "claude-opus-4-6[1m]").length, 1, "Opus 4.6 lists its [1m] variant once");
});

await cases.run("old aliases are not listed but still reach the CLI", async () => {
  assert.ok(!models.some((m) => ["default", "opus", "fable", "sonnet", "haiku"].includes(m.id)), "old aliases are not listed");
  assert.equal(resolveClaudeModelId("sonnet"), "sonnet");
  assert.equal(resolveClaudeModelId("opus[1m]"), "opus[1m]");
  assert.equal(resolveClaudeModelId("fable"), "fable", "old aliases still reach the CLI");
});

await cases.run("names come from the concrete model id, the effort levels and the model selection", async () => {
  // Not the CLI's version-dependent label.
  assert.equal(modelNameFromId("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelNameFromId("claude-opus-5[1m]"), "Opus 5");
  assert.equal(modelNameFromId("claude-haiku-4-5-20251001"), "Haiku 4.5");
  assert.equal(modelNameFromId("opus"), undefined);
  for (const level of EFFORT_LEVELS) assert.equal(isClaudeEffort(level), true);
  assert.equal(isClaudeEffort("nope"), false);
  const { encodeClaudeModelSelection, decodeClaudeModelSelection, resolveClaudeModelSelection } = await pluginModule("model-selection");
  assert.deepEqual(decodeClaudeModelSelection(encodeClaudeModelSelection(resolveClaudeModelSelection("sonnet", "high"))), { modelId: "sonnet", effort: "high" });
});

await cases.run("a refusal on Fable 5.1: the fallback model answers and the reasoning says so", async () => {
  const { catalogIdForFallback } = world.plugin.proxy;
  // The catalog from the CLI's list holds Fable 5.1 and Opus 5, both at 1M by their own ids; a fallback never lands
  // on an alias.
  assert.equal(catalogIdForFallback("claude-opus-5", "claude-fable-5-1[1m]"), "claude-opus-5");
  assert.equal(catalogIdForFallback("claude-opus-5", "claude-fable-5-1"), "claude-opus-5");
  assert.equal(catalogIdForFallback("claude-fable-5-1[1m]", "claude-opus-4-6[1m]"), "claude-fable-5-1", "a fallback never lands on an alias");
  const { turn } = await refusedOnFable(world, "claude-fable-5-1");
  assert.equal(claude.queries.at(-1)!.outcome, "answered", "the fallback model answered");
  assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
  const reply = turn.requests.at(-1)!.reply!;
  assert.match(reply.reasoning, /Fable 5\.1 declined this request \(bio\); Opus 5 answered/);
  assert.ok(reply.text.length > 0, "the fallback's answer");
  noJournalErrors("refusal fallback");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
