/**
 * Context windows come from the Claude Code CLI itself: the plugin switches
 * an idle query to each listed model and reads the window the CLI runs it
 * with. Each first switch costs a model request, so the answers are cached
 * and asked again only when something they depend on changes.
 *
 * On the simulators (test/simulators/): the CLI is the world's Claude Code
 * process (claude-cli.mjs, laid out as npm installs it), started by the
 * plugin through the real SDK; it answers `initialize` with its model rows,
 * `set_model` and `get_context_usage` as CLI 2.1.312 did (a live probe
 * outside a turn, no model call); signed out, offline and as an
 * older CLI that lacks `get_context_usage` as CLI 2.1.312 did then
 * (a probe with an empty profile and a dead proxy); with CLAUDE_CODE_DISABLE_1M_CONTEXT, in the
 * environment or the profile's settings.json, every model at 200K and its
 * own refusals of a `[1m]` (a probe of 2.1.312 signed out and with a dummy key
 * against a local stub of the API); a `[1m]` the account may
 * use when the test lifts the probed refusal (`setModelErrors: { id: null }`).
 * What it answers is `claude.cli.set({ version, auth, account, models,
 * windows, setModelErrors, offline, unsupported, delayMs })`; its starts are
 * `claude.cli.calls()`, the control requests it answered and the end of its
 * input `claude.cli.controls()`. A window changed on the CLI's side also
 * shows whether a refresh asked again: one from the cache keeps the old one.
 * The folders are plugin instances OpenCode started (`startPlugin(options,
 * { directory })`), their catalogs `instance.provider.models`, their provider
 * reloads `instance.reloads`. A refresh is the plugin's own
 * (`refreshModelCatalog`, `listClaudeSupportedModels`); the list it served,
 * the windows file it wrote and the readers of that file are what is checked.
 * What another process left: main 1.6.0's menu and an earlier build's
 * windows file are written by those builds run in a second OpenCode server
 * (`world.secondProcess({ tree: releaseTree(…) })`), a cache of another day by
 * a second server whose clock runs that far off (`clockShiftMs`); a project
 * folder's own copy of the plugin is `world.build(world.dir, { copy: true })`.
 * Each case is independent: a failed one does not stop the others. The 1M
 * switch turned on after the plugin listed a `[1m]` variant fails by a
 * finding: context-window-1m-switch-regression.ts, until it is fixed.
 *
 * Run: bun test/context-window-regression.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import answers from "./simulators/claude-cli-answers.json";
import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule, releaseTree } from "./simulators/world.ts";

// The CLI's list and what CLI 2.1.300 answered on a Max plan, plain ids and
// the [1m] variants worth asking (CLI 2.1.312 answers the same: the
// simulator's probed answers). null: the CLI refused the id for the account.
const cliRows = [
  { value: "default", displayName: "Default (recommended)", description: "", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high"] },
  { value: "opus", displayName: "Opus 5.5", description: "", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high"] },
  { value: "sonnet", displayName: "Sonnet 5", description: "", resolvedModel: "claude-sonnet-5", supportedEffortLevels: ["low", "high"] },
  { value: "claude-opus-4-8", displayName: "Opus 4.8", description: "", resolvedModel: "claude-opus-4-8" },
  { value: "claude-opus-4-6", displayName: "Opus 4.6", description: "", resolvedModel: "claude-opus-4-6" },
  { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6", description: "", resolvedModel: "claude-sonnet-4-6" },
  { value: "haiku", displayName: "Haiku 4.5", description: "", resolvedModel: "claude-haiku-4-5-20251001" },
];
const cliWindows: Record<string, number | null> = {
  "claude-opus-5-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-opus-4-8": 1_000_000,
  "claude-opus-4-6": 200_000, "claude-opus-4-6[1m]": 1_000_000,
  "claude-sonnet-4-6": 200_000, "claude-sonnet-4-6[1m]": null,
  "claude-haiku-4-5-20251001": 200_000, "claude-haiku-4-5-20251001[1m]": null,
};
/** The windows the CLI answers; the refused [1m] ids are refused by the probed CLI itself (`setModelErrors`). */
const cliNumbers = Object.fromEntries(Object.entries(cliWindows).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
const allAsked = [
  "claude-opus-5-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-6",
  "claude-sonnet-4-6", "claude-haiku-4-5-20251001",
  "claude-opus-4-6[1m]", "claude-sonnet-4-6[1m]", "claude-haiku-4-5-20251001[1m]",
];
// The menu for these answers; an id the CLI never answered gets 1M.
const menuWith = (windows: Record<string, number | null>) => {
  const plain = (id: string) => windows[id] ?? 1_000_000;
  return [
    `claude-opus-5-5 ${plain("claude-opus-5-5")}`,
    `claude-sonnet-5 ${plain("claude-sonnet-5")}`,
    `claude-opus-4-8 ${plain("claude-opus-4-8")}`,
    `claude-opus-4-6 ${plain("claude-opus-4-6")}`,
    ...((windows["claude-opus-4-6[1m]"] ?? 0) > plain("claude-opus-4-6") ? ["claude-opus-4-6[1m] 1000000"] : []),
    `claude-sonnet-4-6 ${plain("claude-sonnet-4-6")}`,
    ...((windows["claude-sonnet-4-6[1m]"] ?? 0) > plain("claude-sonnet-4-6") ? ["claude-sonnet-4-6[1m] 1000000"] : []),
    `claude-haiku-4-5-20251001 ${plain("claude-haiku-4-5-20251001")}`,
  ];
};
/**
 * `set_model` failing for another reason than access: the model check could
 * not reach the API (CLI 2.1.312 with the connection cut), for
 * one switch. A CLI offline for a whole pass is `cli.set({ offline: true })`.
 */
const NETWORK_ERROR = answers.offline.setModelError;
/** A window changed on the CLI's side: a refresh that reads it asked the CLI again. */
const MARK = 777_000;
const DAY = 24 * 60 * 60_000;

async function main() {
  for (const name of ["CLAUDE_CODE_DISABLE_1M_CONTEXT", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "DISABLE_COMPACT"]) delete process.env[name];
  const world = await createWorld("context-window");
  const { opencode, claude } = world;
  const cases = testCases({ timeoutMs: 180_000 });
  const dataDir = process.env.XDG_DATA_HOME!;
  const configDir = process.env.CLAUDE_CONFIG_DIR!;
  const windowsFile = join(dataDir, "opencode-claude", "context-windows.json");
  const menuFile = join(dataDir, "opencode-claude", "models.json");
  const profileSettings = join(configDir, "settings.json");

  const { getClaudeModels, modelsFromSdk } = await pluginModule("models");
  const { readCachedModels, readContextWindowCache, readLastContextWindows } = await pluginModule("model-cache");
  const { cliFileStamp, listClaudeSupportedModels, settingsWindowVariables } = await pluginModule("model-discovery");
  const { resolveClaudeCodeExecutable } = await pluginModule("executable-path");
  const { catalogIdForFallback } = world.plugin.proxy;
  const { modelRefreshRuntime, refreshModelCatalog } = world.plugin.index;

  type Control = ReturnType<typeof claude.cli.controls>[number];
  type Listed = { id: string; name: string; contextWindow: number; maxTokens: number };
  /** One refresh of the list and windows from the CLI, as the plugin runs it; the CLI's starts and control requests meanwhile. */
  const discover = async () => {
    const mark = claude.cli.calls().length;
    const controlMark = claude.cli.controls().length;
    const found = await listClaudeSupportedModels();
    assert.ok(found, "the CLI listed its models");
    const models = modelsFromSdk(found.rows, found.windows, found.lastAnswers) as Listed[];
    const menu = models.map((m) => `${m.id} ${m.contextWindow}`);
    return { found, models, menu, starts: claude.cli.calls().slice(mark) as Array<Record<string, any>>, controls: claude.cli.controls().slice(controlMark) };
  };
  /** One refresh as the plugin runs it every ten minutes; the control requests the CLI answered meanwhile. */
  const refresh = async () => {
    modelRefreshRuntime.lastModelRefresh = 0;
    const mark = claude.cli.controls().length;
    await refreshModelCatalog();
    return claude.cli.controls().slice(mark);
  };
  /** The list the plugin serves. */
  const served = () => getClaudeModels() as Listed[];
  const current = () => served().map((m) => `${m.id} ${m.contextWindow}`);
  const windowsOnDisk = () => JSON.parse(readFileSync(windowsFile, "utf8"));
  /** The ids the plugin switched the CLI to, in order (each switch costs the real CLI a model request). */
  const switchedIn = (controls: Control[]) => controls.filter((c) => c.subtype === "set_model").map((c) => String(c.model));
  /** Every CLI process that answered a control request got the end of its input (the SDK's `close()`). */
  const allClosed = async (controls: Control[]) => {
    const pids = new Set(controls.filter((c) => c.subtype).map((c) => c.pid));
    assert.ok(pids.size > 0, "a CLI process answered");
    const ended = () => new Set(claude.cli.controls().filter((c) => c.end === "stdin-closed").map((c) => c.pid));
    for (const deadline = Date.now() + 5_000; [...pids].some((pid) => !ended().has(pid)) && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...pids].filter((pid) => !ended().has(pid)), [], "the plugin closed its idle query");
  };
  const waitFor = async (what: string, ready: () => boolean, ms = 20_000) => {
    for (const deadline = Date.now() + ms; !ready(); ) {
      if (Date.now() > deadline) throw new Error(`no ${what} in ${ms / 1000} s`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  /** A second OpenCode server on this machine (`tree`, `clockShiftMs`) starts the plugin, which refreshes the list, then exits. */
  const otherServerRefreshes = async (options: { tree?: string; clockShiftMs?: number }, written: string) => {
    const other = await world.secondProcess(options);
    try {
      await other.start();
      await waitFor(written, () => existsSync(written));
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await other.exit(), 0, "the other server exits as OpenCode exits");
    } finally {
      await other.kill();
    }
  };
  /** The CLI's real answers, no switch, as a case starts. */
  const reset = () => {
    claude.cli.set({ models: cliRows, windows: cliNumbers, setModelErrors: {}, version: undefined, offline: undefined, unsupported: undefined, auth: undefined, account: undefined, delayMs: 0 });
    delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
    rmSync(profileSettings, { force: true });
  };
  const run = (name: string, body: () => Promise<string | void>) =>
    cases.run(name, async () => {
      reset();
      try {
        return await body();
      } finally {
        reset();
      }
    });

  try {
    await run("first start: the built-in menu serves until the CLI answers; the first refresh asks every window and keeps them", async () => {
      assert.equal(existsSync(menuFile), false);
      const fallback = getClaudeModels() as Array<{ id: string; contextWindow: number }>;
      assert.equal(fallback.find((m) => m.id === "claude-opus-5-5")?.contextWindow, 1_000_000);
      // The ids 1.6.0 gave Opus 5.5 and Fable 5.1 are gone too: a chat on one asks to pick the model again (1.7.0).
      assert.ok(!fallback.some((m) => m.id.endsWith("[1m]")), `the built-in menu has no [1m] ids: ${fallback.map((m) => m.id).join(", ")}`);
      assert.equal(readLastContextWindows().size, 0);

      const { found, menu, starts, controls } = await discover();
      assert.deepEqual(switchedIn(controls), allAsked);
      assert.deepEqual(Object.fromEntries(found.windows), cliWindows);
      assert.deepEqual(menu, menuWith(cliWindows));
      const cache = windowsOnDisk();
      // The listed models, the [1m] variants asked after them only where the plain id runs below 1M
      assert.deepEqual(cache.models, allAsked.slice(0, 6));
      assert.deepEqual(cache.windows, cliWindows);
      // The CLI the plugin resolves (the world's npm install), run through node.
      const start = starts.find((call) => call.args.includes("stream-json"));
      assert.ok(start, `the plugin started the world's CLI: ${JSON.stringify(starts.map((call) => call.args))}`);
      assert.equal(start.runner, "node");
      // The user's settings as in a chat, without their hooks
      assert.ok(start.args.includes("--setting-sources=user"), start.args.join(" "));
      assert.equal(JSON.parse(start.args[start.args.indexOf("--settings") + 1]).disableAllHooks, true);
      // The idle query is closed and its prompt ends
      await allClosed(controls);
    });

    await run("the next refresh takes every window from the cache, a [1m] variant too: no model request", async () => {
      await discover();
      claude.cli.set({ windows: { ...cliNumbers, "claude-opus-5-5": MARK } });
      const { found, menu, controls } = await discover();
      assert.deepEqual(switchedIn(controls), []);
      assert.equal(found.windows.get("claude-opus-5-5"), 1_000_000, "the cached window, the CLI not asked");
      assert.deepEqual(Object.fromEntries(found.windows), cliWindows);
      assert.deepEqual(menu, menuWith(cliWindows));
    });

    await run("a new model in the list drops the whole cache: everything is asked again", async () => {
      await discover();
      const withFable = [...cliRows, { value: "claude-fable-5-1", displayName: "Fable 5.1", description: "", resolvedModel: "claude-fable-5-1" }];
      claude.cli.set({ models: withFable, windows: { ...cliNumbers, "claude-fable-5-1": 1_000_000, "claude-opus-4-8": MARK } });
      const { found, controls } = await discover();
      assert.deepEqual(switchedIn(controls).sort(), [...allAsked, "claude-fable-5-1", "claude-opus-4-8[1m]"].sort());
      assert.equal(found.windows.get("claude-opus-4-8"), MARK, "a model asked again");
      assert.equal(found.windows.get("claude-fable-5-1"), 1_000_000);
      // Back to the CLI's real answers, the changed window forgotten.
      reset();
      rmSync(windowsFile);
      assert.deepEqual(Object.fromEntries((await discover()).found.windows), cliWindows);
    });

    await run("the pass stops at a window question the CLI cannot answer; the next refresh asks only the rest, within the same day", async () => {
      // An earlier pass answered Opus 5.5 and Sonnet 5 only: the model check of
      // every other plain id could not reach the API
      rmSync(windowsFile, { force: true });
      const unreached = ["claude-opus-4-8", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
      claude.cli.set({ setModelErrors: Object.fromEntries(unreached.map((id) => [id, NETWORK_ERROR])) });
      await discover();
      claude.cli.set({ setModelErrors: {} });
      const partial = windowsOnDisk();
      assert.deepEqual(partial.windows, { "claude-opus-5-5": 1_000_000, "claude-sonnet-5": 1_000_000 });
      // A rewritten time would show
      await new Promise((r) => setTimeout(r, 20));
      // An older CLI without `get_context_usage`: it would fail for every model, each switch a request
      claude.cli.set({ unsupported: ["get_context_usage"] });
      const { menu, controls } = await discover();
      assert.deepEqual(switchedIn(controls), ["claude-opus-4-8"], "one switch, then the pass stops");
      assert.deepEqual(menu, menuWith({ "claude-opus-5-5": 1_000_000, "claude-sonnet-5": 1_000_000 }));
      assert.deepEqual(JSON.parse(readFileSync(windowsFile, "utf8")), partial, "what was answered is kept");

      claude.cli.set({ unsupported: undefined });
      const { menu: full, controls: rest } = await discover();
      assert.deepEqual(switchedIn(rest), allAsked.slice(2));
      assert.deepEqual(full, menuWith(cliWindows));
      const filled = JSON.parse(readFileSync(windowsFile, "utf8"));
      assert.equal(filled.savedAt, partial.savedAt, "the day does not start over");
      assert.deepEqual(filled.windows, cliWindows);
    });

    await run("a CLI that never lists its models: the refresh gives up after its timeout and closes the query", async () => {
      claude.cli.set({ delayMs: 30_000 });
      const mark = claude.cli.calls().length;
      assert.equal(await listClaudeSupportedModels(500), null);
      assert.equal(claude.cli.calls().slice(mark).filter((call) => call.args.includes("stream-json")).length, 1, "one CLI started");
    });

    await run("the CLI fails every window question for another reason than access: the list is kept, the windows fall back to its last answers", async () => {
      await discover();
      // A new CLI build, so no cache for it, and no connection
      claude.cli.set({ version: "2.1.400", offline: true });
      const { found, menu } = await discover();
      assert.equal(found.rows.length, cliRows.length);
      assert.equal(found.windows.size, 0);
      assert.equal(found.complete, false);
      assert.deepEqual(menu, menuWith(cliWindows));
      assert.ok(world.journal().some((line) => /level=warn .*gave no context window/.test(line)));
    });

    await run("main 1.6.0's menu serves at the next start, never stands for a window the CLI did not answer; the first answers replace it", async () => {
      rmSync(windowsFile, { force: true });
      rmSync(menuFile, { force: true });
      // The user ran main 1.6.0 before: its start read the CLI's list and wrote its menu.
      await otherServerRefreshes({ tree: releaseTree("v1.6.0") }, menuFile);
      const written = (JSON.parse(readFileSync(menuFile, "utf8")) as Array<{ id: string; contextWindow: number }>).map((m) => `${m.id} ${m.contextWindow}`);
      assert.ok(written.includes("claude-opus-5-5[1m] 1000000"), `1.6.0 names Opus 5.5 by its [1m] id: ${written.join(", ")}`);
      assert.equal(existsSync(windowsFile), false, "1.6.0 keeps no windows");
      // The menu is read once, when the plugin loads: the next OpenCode server shows what the next start serves.
      const next = await world.secondProcess();
      try {
        const servedNext = (await next.module("models", "getClaudeModels")) as Array<{ id: string; contextWindow: number }>;
        assert.deepEqual(servedNext.map((m) => `${m.id} ${m.contextWindow}`), written, "the next start serves 1.6.0's menu");
        assert.equal(await next.exit(), 0);
      } finally {
        await next.kill();
      }

      // A model the CLI never answered for is listed at 1M, the window of every current model
      claude.cli.set({ offline: true });
      const { menu: unanswered, models: never } = await discover();
      assert.deepEqual(unanswered, menuWith({}), "1M, nothing taken from the old menu");
      assert.ok(never.every((m) => m.maxTokens === 128_000), "and the output of a 1M model");
      assert.equal(existsSync(windowsFile), false, "no answer, nothing to keep");

      claude.cli.set({ offline: undefined });
      const before = readFileSync(menuFile, "utf8");
      await refresh();
      assert.notEqual(readFileSync(menuFile, "utf8"), before, "the refresh wrote its menu");
      const ids = readCachedModels()!.map((m: { id: string }) => m.id);
      assert.ok(!ids.includes("claude-opus-5-5[1m]") && !ids.includes("claude-sonnet-4-6[1m]"), `the old ids gone: ${ids.join(", ")}`);
      assert.equal(readCachedModels()!.find((m: { id: string }) => m.id === "claude-opus-5-5")?.contextWindow, 1_000_000);
    });

    await run("a full answer lists the window and output of each model, a [1m] variant only where it does better; a model not sized this time keeps its last answer", async () => {
      await refresh();
      const controls = await refresh();
      assert.deepEqual(switchedIn(controls), [], "from the cache");
      const probed = served();
      assert.deepEqual(
        probed.map((m) => `${m.id} ${m.contextWindow}/${m.maxTokens}`),
        [
          "claude-opus-5-5 1000000/128000",
          "claude-sonnet-5 1000000/128000",
          "claude-opus-4-8 1000000/128000",
          "claude-opus-4-6 200000/64000",
          "claude-opus-4-6[1m] 1000000/128000",
          "claude-sonnet-4-6 200000/64000",
          "claude-haiku-4-5-20251001 200000/64000",
        ],
      );
      assert.equal(probed.find((m) => m.id === "claude-opus-4-6[1m]")!.name, "Opus 4.6 (1M)");
      // A new CLI build (no cache for it) whose model check reaches the API only for Opus 5.5
      const unreached = allAsked.slice(1, 6);
      claude.cli.set({ version: "2.1.401", setModelErrors: Object.fromEntries(unreached.map((id) => [id, NETWORK_ERROR])) });
      const { found, models: partial, controls: asked } = await discover();
      assert.deepEqual(switchedIn(asked), allAsked.slice(0, 6));
      assert.deepEqual([...found.windows.keys()], ["claude-opus-5-5"]);
      assert.equal(partial.find((m) => m.id === "claude-sonnet-5")!.contextWindow, 1_000_000);
      assert.equal(partial.find((m) => m.id === "claude-opus-4-6")!.contextWindow, 200_000);
      assert.ok(partial.some((m) => m.id === "claude-opus-4-6[1m]"), "a [1m] listed before stays");
    });

    await run("each window costs the CLI a model request: only what is missing is asked", async () => {
      // A plain id the CLI could not answer is not stored: asked again next time
      rmSync(windowsFile, { force: true });
      claude.cli.set({ setModelErrors: { "claude-sonnet-5": NETWORK_ERROR } });
      const { found: failed } = await discover();
      assert.equal(failed.windows.has("claude-sonnet-5"), false);
      assert.equal("claude-sonnet-5" in JSON.parse(readFileSync(windowsFile, "utf8")).windows, false);
      claude.cli.set({ setModelErrors: {} });
      const { found: again, controls } = await discover();
      assert.deepEqual(switchedIn(controls), ["claude-sonnet-5"], "only the unanswered id asked again");
      assert.equal(again.windows.get("claude-sonnet-5"), 1_000_000);

      // A [1m] variant that failed for another reason than access is not kept
      // as a refusal: it would hide Opus 4.6 (1M) for a day
      rmSync(windowsFile, { force: true });
      claude.cli.set({ setModelErrors: { "claude-opus-4-6[1m]": NETWORK_ERROR } });
      const { found: flaky } = await discover();
      assert.equal(flaky.windows.has("claude-opus-4-6[1m]"), false);
      assert.equal(flaky.windows.get("claude-sonnet-4-6[1m]"), null, "a refusal is kept");
    });

    await run("a [1m] variant the account may use is listed; once the CLI refuses it, it is not, though it was listed before", async () => {
      // An account with Sonnet 4.6 at 1M: the CLI lets the switch through (granted, CLI 2.1.312 when the API accepts the check).
      rmSync(windowsFile, { force: true });
      claude.cli.set({ setModelErrors: { "claude-sonnet-4-6[1m]": null } });
      await refresh();
      const granted = { ...cliWindows, "claude-sonnet-4-6[1m]": 1_000_000 };
      assert.deepEqual(current(), menuWith(granted), "Sonnet 4.6 (1M) listed");
      // The account loses it; a new CLI build asks again, the answer before stays among the last answers.
      claude.cli.set({ version: "2.1.402", setModelErrors: {} });
      const controls = await refresh();
      assert.ok(switchedIn(controls).includes("claude-sonnet-4-6[1m]"), "asked again");
      assert.equal(readLastContextWindows().get("claude-sonnet-4-6[1m]"), null, "the refusal is the last answer");
      assert.ok(!current().some((m) => m.startsWith("claude-sonnet-4-6[1m] ")), `refused: not listed: ${current().join(", ")}`);
    });

    await run("a model fallback keeps 1M: an explicit [1m] fallback stays, a plain one gets the 1M variant when the original ran at 1M", async () => {
      claude.cli.set({
        models: [
          { value: "claude-fable-5-1", displayName: "Fable 5.1", description: "", resolvedModel: "claude-fable-5-1" },
          cliRows.find((r) => r.value === "claude-opus-4-6")!,
        ],
        windows: { ...cliNumbers, "claude-fable-5-1": 1_000_000 },
      });
      await refresh();
      assert.deepEqual(current(), ["claude-fable-5-1 1000000", "claude-opus-4-6 200000", "claude-opus-4-6[1m] 1000000"]);
      assert.equal(catalogIdForFallback("claude-opus-4-6[1m]", "claude-opus-4-6"), "claude-opus-4-6[1m]", "named by the CLI");
      // Also a native 1M original without the suffix
      assert.equal(catalogIdForFallback("claude-opus-4-6", "claude-fable-5-1"), "claude-opus-4-6[1m]");
      assert.equal(catalogIdForFallback("claude-opus-4-6", "claude-opus-4-6"), "claude-opus-4-6");
    });

    await run("the window cache of another server holds for a day at most: a day old or from a clock that moved back is asked again; a model gone is no reason", async () => {
      // Another server wrote the cache a minute ago: it holds.
      rmSync(windowsFile, { force: true });
      await otherServerRefreshes({ clockShiftMs: -60_000 }, windowsFile);
      assert.ok(Date.now() - windowsOnDisk().savedAt >= 60_000, "saved a minute ago");
      assert.deepEqual(switchedIn((await discover()).controls), [], "a minute old: from the cache");
      // A day ago
      rmSync(windowsFile, { force: true });
      await otherServerRefreshes({ clockShiftMs: -DAY - 60_000 }, windowsFile);
      assert.ok(Date.now() - windowsOnDisk().savedAt > DAY, "saved a day ago");
      assert.deepEqual(switchedIn((await discover()).controls), allAsked, "a day old: asked again");
      // Its clock was ahead, then moved back: a time still to come
      rmSync(windowsFile, { force: true });
      await otherServerRefreshes({ clockShiftMs: 10 * 60_000 }, windowsFile);
      assert.ok(windowsOnDisk().savedAt > Date.now(), "saved in the future");
      assert.deepEqual(switchedIn((await discover()).controls), allAsked, "the clock moved back: asked again");
      // A model gone from the list is no reason to ask again (a new one is: above)
      claude.cli.set({ models: cliRows.filter((r) => r.value !== "claude-sonnet-4-6") });
      assert.deepEqual(switchedIn((await discover()).controls), [], "a model gone is no reason");
    });

    await run("with the 1M switch on, every model runs at 200K and no [1m] variant is asked; the switch reads on as Claude Code does", async () => {
      // A fresh windows file: no [1m] answer from before the switch (the case below).
      rmSync(windowsFile, { force: true });
      const on = async (where: string) => {
        const { menu, controls } = await discover();
        const asked = switchedIn(controls);
        assert.ok(asked.every((id) => !id.endsWith("[1m]")), `${where}: no [1m] asked: ${asked}`);
        assert.ok(menu.every((line) => line.endsWith(" 200000") && !line.includes("[1m]")), `${where}: every model at 200K: ${menu.join(", ")}`);
      };
      const off = async (where: string) => {
        assert.deepEqual((await discover()).menu, menuWith(cliWindows), `${where}: the CLI's windows`);
      };
      for (const value of ["1", "true", "yes", "on", " TRUE "]) {
        process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = value;
        await on(JSON.stringify(value));
      }
      for (const value of ["0", "false", "no", "off", "", "2"]) {
        process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = value;
        await off(JSON.stringify(value));
      }
      delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
      await off("unset");
      rmSync(windowsFile, { force: true });
      writeFileSync(profileSettings, JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: true } }));
      await on("settings.json true");
      // settings.json wins over the environment either way, as the CLI reads them (BEHAVIOR.md, the windows probe)
      rmSync(windowsFile, { force: true });
      writeFileSync(profileSettings, JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" } }));
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
      await off('settings.json "0" over the environment\'s "1"');
      rmSync(windowsFile, { force: true });
      writeFileSync(profileSettings, JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" } }));
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "0";
      await on('settings.json "1" over the environment\'s "0"');
      // The switch turned on after a [1m] variant was listed at 1M: the CLI refuses it now, so it is not listed
      reset();
      rmSync(windowsFile, { force: true });
      assert.ok((await discover()).menu.includes("claude-opus-4-6[1m] 1000000"), "Opus 4.6 (1M) listed while the switch is off");
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
      await on("the switch turned on after a 1M answer");
    });

    await run("window variables in Claude Code's settings.json join the cache key", async () => {
      const keyDir = join(world.tmp, "key-profile");
      mkdirSync(keyDir, { recursive: true });
      assert.deepEqual(settingsWindowVariables({ CLAUDE_CONFIG_DIR: keyDir }), {}, "no settings.json");
      writeFileSync(
        join(keyDir, "settings.json"),
        JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1", CLAUDE_CODE_MAX_CONTEXT_TOKENS: 500000, DISABLE_COMPACT: "1", OTHER: "x" } }),
      );
      assert.deepEqual(settingsWindowVariables({ CLAUDE_CONFIG_DIR: keyDir }), {
        CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: "500000",
        DISABLE_COMPACT: "1",
      });
      writeFileSync(join(keyDir, "settings.json"), "{ not json");
      assert.deepEqual(settingsWindowVariables({ CLAUDE_CONFIG_DIR: keyDir }), {}, "unreadable file");
    });

    await run("each thing the windows depend on changes the key: a refresh asks the CLI again", async () => {
      const asksAgain = async (change: () => void, undo: () => void) => {
        await discover();
        change();
        try {
          return switchedIn((await discover()).controls).length > 0;
        } finally {
          undo();
        }
      };
      assert.equal(await asksAgain(() => {}, () => {}), false, "nothing changed");
      assert.equal(await asksAgain(() => claude.cli.set({ version: "2.1.301" }), () => claude.cli.set({ version: undefined })), true, "CLI version");
      assert.equal(
        await asksAgain(() => claude.cli.set({ account: { subscriptionType: "Claude Pro" } }), () => claude.cli.set({ account: undefined })),
        true,
        "plan",
      );
      assert.equal(
        await asksAgain(() => (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1"), () => delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT),
        true,
        "1M switch in the environment",
      );
      assert.equal(
        await asksAgain(() => writeFileSync(profileSettings, JSON.stringify({ env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: 500000, DISABLE_COMPACT: "1" } })), () => rmSync(profileSettings)),
        true,
        "window variables in settings.json",
      );
      // A CLI update replaces the executable; CLIs before 2.1.300 do not report
      // their version, so the file stands for the build in the cache key
      const executable = await resolveClaudeCodeExecutable({ env: process.env });
      assert.ok(executable, "the plugin resolves the world's CLI");
      assert.equal(await asksAgain(() => utimesSync(executable, new Date(2026, 9, 11), new Date(2026, 9, 11)), () => {}), true, "the CLI's file");
    });

    await run("the CLI file's stamp changes with the file", async () => {
      const exeDir = join(world.tmp, "exe");
      mkdirSync(exeDir, { recursive: true });
      const exe = join(exeDir, "claude.exe");
      writeFileSync(exe, "build 1");
      utimesSync(exe, new Date(2026, 9, 11), new Date(2026, 9, 11));
      const before = cliFileStamp(exe);
      assert.ok(before);
      assert.equal(cliFileStamp(exe), before, "same file, same stamp");
      writeFileSync(exe, "build 2, longer");
      assert.notEqual(cliFileStamp(exe), before, "an update changes the stamp");
      assert.equal(cliFileStamp(join(exe, "..", "missing.exe")), undefined);
      assert.equal(cliFileStamp(undefined), undefined, "the SDK's own CLI");
    });

    await run("an answer the cache file holds is never dropped: a write under a new key moves what it does not repeat to earlier", async () => {
      // Signed in: every answer under one key
      rmSync(windowsFile, { force: true });
      await discover();
      const signedIn = windowsOnDisk().key;
      // Signed out (a new key): the CLI sizes only the model it starts on
      claude.cli.set({ auth: "loggedOut", models: undefined });
      await discover();
      const file = windowsOnDisk();
      assert.notEqual(file.key, signedIn);
      assert.deepEqual(file.windows, { "claude-opus-5-5": 1_000_000 });
      assert.equal("claude-opus-5-5" in file.earlier, false, "an id the new cache repeats is not doubled");
      assert.equal(file.earlier["claude-sonnet-4-6[1m]"], null, "a refusal is an answer too");
      assert.deepEqual(Object.fromEntries(readLastContextWindows()), cliWindows);
      assert.equal(readContextWindowCache(signedIn), null, "the earlier answers are no cache");
      // A newer answer for the same id wins over the earlier one: signed in
      // again on a new CLI build that runs Sonnet 5 at 200K
      claude.cli.set({ auth: undefined, models: cliRows, version: "2.1.403", windows: { ...cliNumbers, "claude-sonnet-5": 200_000 } });
      await discover();
      assert.equal(readLastContextWindows().get("claude-sonnet-5"), 200_000);
      assert.equal(readLastContextWindows().get("claude-opus-5-5"), 1_000_000);
    });

    await run("after a refresh the CLI did not fully answer, every listed model stays as it is and only a model new to the list is added", async () => {
      rmSync(windowsFile, { force: true });
      await refresh();
      const full = current();
      assert.deepEqual(full, menuWith(cliWindows));
      // A short list with a new model whose check could not reach the API
      claude.cli.set({
        models: [cliRows[0]!, { value: "claude-fable-9", displayName: "Fable 9", description: "", resolvedModel: "claude-fable-9" }],
        setModelErrors: { "claude-fable-9": NETWORK_ERROR },
      });
      await refresh();
      assert.deepEqual(current(), [...full, "claude-fable-9 1000000"]);
    });

    // The incident of 26.10.2026: the CLI's login expired while OpenCode ran.
    // A CLI signed out lists its own four models and sizes only the one it
    // starts on; every other window question fails (measured on CLI 2.1.310
    // with an empty CLAUDE_CONFIG_DIR). Neither such a refresh nor a second one
    // may change the list; the next signed-in refresh reaches every folder.
    await run("the login expires while OpenCode runs: the list holds through two refreshes; the next signed-in one reaches every folder", async () => {
      const noWindowLines = () => world.journal().filter((line) => line.includes("gave no context window"));
      const row = (value: string, resolvedModel: string) => ({ value, displayName: value, description: "", resolvedModel });
      // Opus 5.5 with fast mode, as CLI 2.1.312 lists it signed in and signed out
      const signedInRows = [
        ...cliRows.map((r) => (r.resolvedModel === "claude-opus-5-5" ? { ...r, supportsFastMode: true } : r)),
        row("claude-fable-5-1", "claude-fable-5-1"),
        row("claude-sonnet-5-5", "claude-sonnet-5-5"),
        row("claude-haiku-5-5", "claude-haiku-5-5"),
      ];
      const signedInWindows = { ...cliNumbers, "claude-fable-5-1": 1_000_000, "claude-sonnet-5-5": 1_000_000, "claude-haiku-5-5": 1_000_000 };
      const listedIn = (instance: { provider: { models: Array<{ id: string; limit: { context: number } }> } }) =>
        instance.provider.models.map((m) => `${m.id} ${m.limit.context}`);

      rmSync(windowsFile, { force: true });
      rmSync(menuFile, { force: true });
      // Signed in: the full list, Fable at 1M
      claude.cli.set({ models: signedInRows, windows: signedInWindows, setModelErrors: {} });
      await refresh();
      const good = current();
      assert.ok(good.includes("claude-fable-5-1 1000000"));
      assert.ok(good.includes("claude-opus-5-5:fast 1000000"));
      assert.equal(good.length, signedInRows.length + 1, "the default row folded into Opus 5.5, Opus 4.6 (1M) and Opus 5.5 Fast added");
      const goodMenu = readFileSync(menuFile, "utf8");

      // Two project folders load the plugin now; the setups do not start a
      // refresh of their own within the ten minutes
      modelRefreshRuntime.lastModelRefresh = Date.now();
      const folder = async (name: string) => {
        const directory = join(world.tmp, name);
        mkdirSync(directory, { recursive: true });
        return opencode.startPlugin(undefined, { directory });
      };
      const a = await folder("project-a");
      const b = await folder("project-b");
      try {
        assert.ok(listedIn(a).includes("claude-fable-5-1 1000000"));
        assert.deepEqual(listedIn(b), listedIn(a));
        assert.equal(modelRefreshRuntime.providerReloads.size, 2);
        const reloadsBefore = [a.reloads.count, b.reloads.count];

        // The login expires: the refresh asks the CLI, which lists its own five
        // rows and answers for Opus only
        const before = noWindowLines().length;
        claude.cli.set({ auth: "loggedOut", models: undefined });
        const signedOut = await refresh();
        assert.deepEqual(switchedIn(signedOut), ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"]);
        assert.deepEqual(current(), good);
        assert.equal(readFileSync(menuFile, "utf8"), goodMenu, "models.json untouched");
        assert.deepEqual([a.reloads.count, b.reloads.count], reloadsBefore, "nothing changed, nothing reloaded");
        assert.equal(readLastContextWindows().get("claude-fable-5-1"), 1_000_000, "Fable's answer kept");
        const noWindow = noWindowLines().slice(before);
        assert.equal(noWindow.length, 1);
        // The switch to the model it runs on, by its full id, passes; the full id
        // of any other model is refused (CLI 2.1.310 and 2.1.312 signed out)
        assert.match(noWindow[0]!, /level=warn .*"unanswered":\["claude-fable-5-1","claude-sonnet-5-5","claude-haiku-5-5"\]/);

        // Still signed out ten minutes later: the second refresh finds the first
        // one's cache and still no answer for the rest; the list holds
        const second = await refresh();
        assert.deepEqual(switchedIn(second), ["claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"], "Opus from the cache");
        assert.deepEqual(current(), good);
        assert.deepEqual(listedIn(a), listedIn(b));
        assert.ok(listedIn(a).includes("claude-fable-5-1 1000000"));
        assert.equal(noWindowLines().length, before + 2);
        assert.deepEqual([a.reloads.count, b.reloads.count], reloadsBefore);

        // Signed in again with a change on the CLI's side (Sonnet 4.6 dropped):
        // one refresh, run from any folder, reaches both
        const warnings = noWindowLines().length;
        claude.cli.set({ auth: undefined, models: signedInRows.filter((r) => r.value !== "claude-sonnet-4-6") });
        await refresh();
        assert.ok(!listedIn(a).some((m) => m.startsWith("claude-sonnet-4-6 ")), "folder A has the new list");
        assert.deepEqual(listedIn(b), listedIn(a), "folder B too");
        assert.ok(listedIn(b).includes("claude-fable-5-1 1000000"));
        assert.deepEqual([a.reloads.count, b.reloads.count], reloadsBefore.map((n) => n + 1), "each folder reloaded once");
        assert.equal(noWindowLines().length, warnings, "a full answer logs no warning");

        // A folder closed by OpenCode is not reloaded any more; a reload that
        // fails (a location OpenCode disposes meanwhile) is logged and does not
        // stop the others
        await opencode.stopPlugin(a);
        assert.equal(modelRefreshRuntime.providerReloads.size, 1);
        b.reloads.fails = "location disposed";
        const c = await folder("project-c");
        const reloadsOfA = a.reloads.count;
        const reloadsOfC = c.reloads.count;
        claude.cli.set({ models: signedInRows });
        await refresh();
        assert.equal(a.reloads.count, reloadsOfA, "A was closed");
        assert.ok(!listedIn(a).some((m) => m.startsWith("claude-sonnet-4-6 ")), "A's catalog stays as it was");
        assert.equal(c.reloads.count, reloadsOfC + 1, "C reloaded although B failed");
        assert.ok(listedIn(c).some((m) => m.startsWith("claude-sonnet-4-6 ")));
        assert.ok(world.journal().some((line) => /level=warn .*could not reload the model list in a project folder location disposed/.test(line)));
        b.reloads.fails = undefined;
        await opencode.stopPlugin(c);
      } finally {
        for (const instance of [a, b]) if (opencode.instances.includes(instance)) await opencode.stopPlugin(instance);
      }
      assert.equal(modelRefreshRuntime.providerReloads.size, 0);
    });

    // OpenCode loads a local plugin afresh for each project folder and after a
    // change (it clears the module registry): each such load is its own copy
    // of every module.
    await run("the model list is one for every copy of the plugin: a refresh in one copy is the list every copy serves", async () => {
      await refresh();
      assert.deepEqual(current(), menuWith(cliWindows));
      const copy = await world.build(world.dir, { copy: true });
      const copyModels = await copy.module("models");
      assert.notEqual(copyModels.getClaudeModels, getClaudeModels, "a separate module copy");
      assert.deepEqual(copyModels.getClaudeModels(), getClaudeModels());
      // The CLI lists two models; the copy refreshes
      claude.cli.set({ models: cliRows.slice(1, 3) });
      copy.index.modelRefreshRuntime.lastModelRefresh = 0;
      await copy.index.refreshModelCatalog();
      assert.deepEqual(served().map((m) => m.id), ["claude-opus-5-5", "claude-sonnet-5"], "the first copy serves the list the other set");
      // The full list again, from the first copy
      claude.cli.set({ models: cliRows });
      await refresh();
      assert.deepEqual((copyModels.getClaudeModels() as Listed[]).map((m) => `${m.id} ${m.contextWindow}`), menuWith(cliWindows), "and the other way round");
    });

    await run("a reloaded copy sees the time of the last catalog read: no second measuring pass within the ten minutes", async () => {
      const reloaded = await world.build(world.dir, { copy: true });
      assert.notEqual(world.plugin.index.ClaudeCodePlugin, reloaded.index.ClaudeCodePlugin, "a separate module copy");
      modelRefreshRuntime.lastModelRefresh = Date.now();
      assert.equal(reloaded.index.modelRefreshRuntime.lastModelRefresh, modelRefreshRuntime.lastModelRefresh, "the reloaded copy sees the same time");
      const mark = claude.cli.controls().length;
      await reloaded.index.refreshModelCatalog();
      assert.deepEqual(switchedIn(claude.cli.controls().slice(mark)), [], "no pass of its own");
    });

    await run("the plugin's journal holds no error", async () => {
      assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    });
  } finally {
    reset();
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
