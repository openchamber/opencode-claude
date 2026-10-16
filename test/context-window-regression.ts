/**
 * Context windows come from the Claude Code CLI itself: the plugin switches
 * an idle query to each listed model and reads the window the CLI runs it
 * with. Each first switch costs a model request, so the answers are cached
 * and asked again only when something they depend on changes. The SDK is
 * replaced by a fake CLI here; nothing reaches a model.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";

const dataDir = mkdtempSync(join(tmpdir(), "oc-claude-windows-"));
process.env.XDG_DATA_HOME = dataDir;
const configDir = mkdtempSync(join(tmpdir(), "oc-claude-config-"));
process.env.CLAUDE_CONFIG_DIR = configDir;
delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT;
delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
delete process.env.DISABLE_COMPACT;
const windowsFile = join(dataDir, "opencode-claude", "context-windows.json");
const menuFile = join(dataDir, "opencode-claude", "models.json");

// The CLI's list and what CLI 2.1.300 answered on a Max plan, plain ids and
// the [1m] variants worth asking.
const cliRows = [
  { value: "default", displayName: "Default (recommended)", description: "", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high"] as ("low" | "high")[] },
  { value: "opus", displayName: "Opus 5.5", description: "", resolvedModel: "claude-opus-5-5", supportedEffortLevels: ["low", "high"] as ("low" | "high")[] },
  { value: "sonnet", displayName: "Sonnet 5", description: "", resolvedModel: "claude-sonnet-5", supportedEffortLevels: ["low", "high"] as ("low" | "high")[] },
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
const allAsked = [
  "claude-opus-5-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-6",
  "claude-sonnet-4-6", "claude-haiku-4-5-20251001",
  "claude-opus-4-6[1m]", "claude-sonnet-4-6[1m]", "claude-haiku-4-5-20251001[1m]",
];
const menuWith = (windows: Record<string, number | null>) => [
  `claude-opus-5-5 ${windows["claude-opus-5-5"] ?? 200_000}`,
  `claude-sonnet-5 ${windows["claude-sonnet-5"] ?? 200_000}`,
  `claude-opus-4-8 ${windows["claude-opus-4-8"] ?? 200_000}`,
  "claude-opus-4-6 200000",
  ...(windows["claude-opus-4-6[1m]"] ? ["claude-opus-4-6[1m] 1000000"] : []),
  "claude-sonnet-4-6 200000",
  "claude-haiku-4-5-20251001 200000",
];

// A fake CLI behind the SDK's query(): the list, the account, and a window
// for each id it answers; any other id is refused or fails like the CLI.
type FakeCli = {
  rows: typeof cliRows;
  answers: Record<string, number | null>;
  failure?: string;
  listHangs?: boolean;
  initFails?: boolean;
  /** Window questions answered before getContextUsage starts to fail. */
  usageAnswers?: number;
};
let cli: FakeCli = { rows: cliRows, answers: cliWindows };
const seen = {
  switched: [] as string[],
  closed: 0,
  options: undefined as Record<string, any> | undefined,
  /** The end of the idle prompt, which the SDK reads from the start. */
  promptEnd: undefined as Promise<IteratorResult<unknown>> | undefined,
};
mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Record<string, any> }) => {
    seen.options = options;
    seen.promptEnd = prompt[Symbol.asyncIterator]().next();
    let current = "";
    let answered = 0;
    return {
      supportedModels: () => (cli.listHangs ? new Promise(() => {}) : Promise.resolve(cli.rows)),
      initializationResult: async () => {
        if (cli.initFails) throw new Error("initialize failed");
        return {
          claude_code_version: "2.1.300",
          account: { email: "dev@example.com", subscriptionType: "max", apiProvider: "firstParty" },
        };
      },
      setModel: async (id: string) => {
        seen.switched.push(id);
        if (typeof cli.answers[id] !== "number") {
          throw new Error(cli.failure ?? "Sonnet with 1M context is not available for your account.");
        }
        current = id;
      },
      getContextUsage: async () => {
        if (cli.usageAnswers !== undefined && answered >= cli.usageAnswers) {
          throw new Error("get_context_usage failed");
        }
        answered++;
        return { rawMaxTokens: cli.answers[current] };
      },
      close: () => {
        seen.closed++;
      },
    };
  },
}));

// The CLI installed on this machine stays out of it: a fixed file stands
// for it, and its stamp joins the cache key.
const fakeExecutable = join(configDir, "claude.exe");
writeFileSync(fakeExecutable, "fake CLI");
const executablePath = await import("../src/executable-path.ts");
mock.module("../src/executable-path.ts", () => ({
  ...executablePath,
  resolveClaudeCodeExecutable: async () => fakeExecutable,
}));

const { getClaudeModels, modelsFromSdk, setDiscoveredModels, listedModelIds, extendedProbeIds } =
  await import("../src/models.ts");
const {
  cacheForListedModels,
  readCachedModels,
  readContextWindowCache,
  readLastContextWindows,
  writeContextWindowCache,
} = await import("../src/model-cache.ts");
const {
  askMissingContextWindows,
  cliFileStamp,
  contextWindowKey,
  listClaudeSupportedModels,
  oneMillionContextDisabled,
  settingsWindowVariables,
} = await import("../src/model-discovery.ts");
const { catalogIdForFallback, summaryHistoryMaxChars } = await import("../src/proxy.ts");

async function discover() {
  seen.switched = [];
  const found = await listClaudeSupportedModels();
  assert.ok(found, "the CLI listed its models");
  const menu = modelsFromSdk(found.rows, found.windows, found.lastAnswers);
  return { found, menu: menu.map((m) => `${m.id} ${m.contextWindow}`) };
}

// First start: no menu and no windows on disk yet. The built-in menu serves
// until the CLI answers; the first refresh asks every window and keeps them.
{
  assert.equal(existsSync(menuFile), false);
  const fallback = getClaudeModels();
  assert.equal(fallback.find((m) => m.id === "claude-opus-5-5")?.contextWindow, 1_000_000);
  assert.ok(!fallback.some((m) => m.id.endsWith("[1m]")), "the built-in menu has no [1m] ids");
  assert.equal(readLastContextWindows().size, 0);

  const { found, menu } = await discover();
  assert.deepEqual(seen.switched, allAsked);
  assert.deepEqual(Object.fromEntries(found.windows), cliWindows);
  assert.deepEqual(menu, menuWith(cliWindows));
  const cache = JSON.parse(readFileSync(windowsFile, "utf8"));
  assert.deepEqual(cache.models, listedModelIds(cliRows));
  assert.deepEqual(cache.windows, cliWindows);
  assert.equal(seen.options?.pathToClaudeCodeExecutable, fakeExecutable);
  // The user's settings as in a chat, without their hooks
  assert.deepEqual(seen.options?.settingSources, ["user"]);
  assert.equal(seen.options?.settings?.disableAllHooks, true);
  // The idle query is closed and its prompt ends
  assert.equal(seen.closed, 1);
  assert.deepEqual(await seen.promptEnd, { value: undefined, done: true });
}

// Next refresh: everything comes from the cache, no model request
{
  const { found, menu } = await discover();
  assert.deepEqual(seen.switched, []);
  assert.deepEqual(Object.fromEntries(found.windows), cliWindows);
  assert.deepEqual(menu, menuWith(cliWindows));
}

// A new model in the list drops the whole cache: everything is asked again
{
  const withFable = [...cliRows, { value: "claude-fable-5-1", displayName: "Fable 5.1", description: "", resolvedModel: "claude-fable-5-1" }];
  cli = { rows: withFable, answers: { ...cliWindows, "claude-fable-5-1": 1_000_000 } };
  await discover();
  assert.deepEqual(seen.switched.sort(), [...allAsked, "claude-fable-5-1"].sort());
  cli = { rows: cliRows, answers: cliWindows };
}

// The pass stops halfway (the window question breaks): what was answered is
// kept, and the next refresh asks only the rest, within the same day
{
  rmSync(windowsFile);
  cli = { rows: cliRows, answers: cliWindows, usageAnswers: 2 };
  const { menu } = await discover();
  assert.deepEqual(seen.switched, ["claude-opus-5-5", "claude-sonnet-5", "claude-opus-4-8"]);
  assert.deepEqual(menu, menuWith({ "claude-opus-5-5": 1_000_000, "claude-sonnet-5": 1_000_000 }));
  const partial = JSON.parse(readFileSync(windowsFile, "utf8"));
  assert.deepEqual(partial.windows, { "claude-opus-5-5": 1_000_000, "claude-sonnet-5": 1_000_000 });
  assert.deepEqual(partial.models, listedModelIds(cliRows));
  // An hour earlier, so a rewritten time would show
  partial.savedAt -= 60 * 60_000;
  writeFileSync(windowsFile, JSON.stringify(partial));

  cli = { rows: cliRows, answers: cliWindows };
  const { menu: full } = await discover();
  assert.deepEqual(seen.switched, allAsked.slice(2));
  assert.deepEqual(full, menuWith(cliWindows));
  const filled = JSON.parse(readFileSync(windowsFile, "utf8"));
  assert.equal(filled.savedAt, partial.savedAt, "the day does not start over");
  assert.deepEqual(filled.windows, cliWindows);
}

// A CLI that never lists its models: the refresh gives up after its timeout,
// closes the query and ends the idle prompt
{
  const closed = seen.closed;
  cli = { rows: cliRows, answers: cliWindows, listHangs: true };
  assert.equal(await listClaudeSupportedModels(50), null);
  assert.equal(seen.closed, closed + 1);
  assert.deepEqual(await seen.promptEnd, { value: undefined, done: true });
  cli = { rows: cliRows, answers: cliWindows };
}

// A failure while asking windows keeps the list; the windows fall back to
// the CLI's last answers
{
  cli = { rows: cliRows, answers: cliWindows, initFails: true };
  const { found, menu } = await discover();
  assert.equal(found.rows.length, cliRows.length);
  assert.equal(found.windows.size, 0);
  assert.deepEqual(seen.switched, []);
  assert.deepEqual(menu, menuWith(cliWindows));
  cli = { rows: cliRows, answers: cliWindows };
}

// A menu from an older plugin (the family table: Sonnet 5 at 200K plus a
// "(1M)" entry, Opus 5.5 only as [1m]) serves at start, but never stands for
// a window the CLI did not answer; the first answers replace it
{
  rmSync(windowsFile);
  mkdirSync(join(dataDir, "opencode-claude"), { recursive: true });
  writeFileSync(menuFile, JSON.stringify([
    { id: "claude-opus-5-5[1m]", name: "Opus 5.5", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 },
    { id: "claude-sonnet-5", name: "Sonnet 5", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
    { id: "claude-sonnet-5[1m]", name: "Sonnet 5 (1M)", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000 },
  ]));
  // The menu is read once, when the plugin loads: a fresh process shows
  // what the next start serves
  const modelsModule = new URL("../src/models.ts", import.meta.url).href;
  const nextStart = Bun.spawnSync([
    process.execPath,
    "-e",
    `const { getClaudeModels } = await import(${JSON.stringify(modelsModule)});
     console.log(JSON.stringify(getClaudeModels().map((m) => m.id)));`,
  ], { env: { ...process.env } });
  assert.equal(nextStart.exitCode, 0, nextStart.stderr.toString());
  assert.deepEqual(
    JSON.parse(nextStart.stdout.toString()),
    ["claude-opus-5-5[1m]", "claude-sonnet-5", "claude-sonnet-5[1m]"],
  );

  cli = { rows: cliRows, answers: {}, failure: "Unable to validate model: fetch failed" };
  const { menu: unanswered } = await discover();
  assert.deepEqual(unanswered, menuWith({}), "200K, nothing taken from the old menu");
  assert.equal(existsSync(windowsFile), false, "no answer, nothing to keep");

  cli = { rows: cliRows, answers: cliWindows };
  const { found } = await discover();
  assert.equal(setDiscoveredModels(modelsFromSdk(found.rows, found.windows, found.lastAnswers)), true);
  const ids = readCachedModels()!.map((m) => m.id);
  assert.ok(!ids.includes("claude-opus-5-5[1m]") && !ids.includes("claude-sonnet-5[1m]"));
  assert.equal(readCachedModels()!.find((m) => m.id === "claude-sonnet-5")?.contextWindow, 1_000_000);
}

// [1m] is asked only where the plain id runs below 1M, and only once
{
  assert.deepEqual(listedModelIds(cliRows), allAsked.slice(0, 6));
  const plainOnly = new Map(Object.entries(cliWindows).filter(([id]) => !id.endsWith("[1m]")));
  assert.deepEqual(extendedProbeIds(cliRows, plainOnly), allAsked.slice(6));
  const windows = new Map(Object.entries(cliWindows));
  assert.deepEqual(extendedProbeIds(cliRows, windows), []);
  const probed = modelsFromSdk(cliRows, windows);
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
  // CLAUDE_CODE_DISABLE_1M_CONTEXT=1: every id answers 200K
  const disabled = new Map([...windows].map(([id, w]) => [id, w === null ? null : 200_000]));
  assert.ok(modelsFromSdk(cliRows, disabled).every((m) => m.contextWindow === 200_000 && !m.id.endsWith("[1m]")));
  // A model the CLI could not size this time keeps its last answer
  const partial = modelsFromSdk(cliRows, new Map([["claude-opus-5-5", 1_000_000]]), windows);
  assert.equal(partial.find((m) => m.id === "claude-sonnet-5")!.contextWindow, 1_000_000);
  assert.equal(partial.find((m) => m.id === "claude-opus-4-6")!.contextWindow, 200_000);
  assert.ok(partial.some((m) => m.id === "claude-opus-4-6[1m]"), "a [1m] listed before stays");
  // A model the CLI never answered for is listed at 200K: early compaction
  // at worst, never an overflow
  const never = modelsFromSdk(cliRows, new Map());
  assert.ok(never.every((m) => m.contextWindow === 200_000 && !m.id.endsWith("[1m]")));
}

// Each window costs the CLI a model request, so only what is missing is asked
{
  const asked: string[] = [];
  const fakeCli = (answers: Record<string, number | null>, failure?: string) => {
    let current = "";
    return {
      setModel: async (id: string) => {
        asked.push(id);
        if (typeof answers[id] !== "number") {
          throw new Error(failure ?? "Sonnet with 1M context is not available for your account.");
        }
        current = id;
      },
      getContextUsage: async () => ({ rawMaxTokens: answers[current] }),
    };
  };
  const windows = new Map<string, number | null>();
  assert.equal(await askMissingContextWindows(fakeCli(cliWindows) as any, cliRows, windows), true);
  assert.deepEqual(asked, allAsked);
  assert.deepEqual(Object.fromEntries(windows), cliWindows);
  // Everything known: no model request at all
  asked.length = 0;
  assert.equal(await askMissingContextWindows(fakeCli(cliWindows) as any, cliRows, windows), false);
  assert.deepEqual(asked, []);
  // Only the ids missing from the map are asked (dropping the whole cache
  // for a new model is cacheForListedModels' call, tested below)
  const withFable = [...cliRows, { value: "claude-fable-5-1", displayName: "Fable 5.1", description: "", resolvedModel: "claude-fable-5-1" }];
  await askMissingContextWindows(
    fakeCli({ ...cliWindows, "claude-fable-5-1": 1_000_000 }) as any,
    withFable,
    windows,
  );
  assert.deepEqual(asked, ["claude-fable-5-1"]);
  // A plain id the CLI could not answer is not stored: asked again next time
  asked.length = 0;
  const failed = new Map<string, number | null>();
  await askMissingContextWindows(fakeCli({}) as any, cliRows.slice(0, 2), failed);
  assert.equal(failed.size, 0);
  assert.deepEqual(asked, ["claude-opus-5-5"]);
  // A [1m] variant that failed for another reason than access is not kept
  // as a refusal: it would hide Opus 4.6 (1M) for a day
  const plainOnly = Object.fromEntries(Object.entries(cliWindows).filter(([id]) => !id.endsWith("[1m]")));
  const flaky = new Map<string, number | null>(Object.entries(plainOnly));
  await askMissingContextWindows(
    fakeCli(plainOnly, "Unable to validate model: fetch failed") as any,
    cliRows,
    flaky,
  );
  assert.equal(flaky.has("claude-opus-4-6[1m]"), false);
  // The window question itself failing keeps what was already answered and
  // stops the pass: it would fail for every model, each switch a request
  const switched: string[] = [];
  const brokenUsage = {
    setModel: async (id: string) => {
      switched.push(id);
    },
    getContextUsage: async () => {
      throw new Error("get_context_usage is not supported in this context");
    },
  };
  const kept = new Map<string, number | null>([["claude-opus-5-5", 1_000_000]]);
  assert.equal(await askMissingContextWindows(brokenUsage as any, cliRows, kept), false);
  assert.deepEqual([...kept], [["claude-opus-5-5", 1_000_000]]);
  assert.deepEqual(switched, ["claude-sonnet-5"], "one switch, then the pass stops");
}

// A [1m] variant the CLI could not answer this time keeps its last answer;
// one it refused is not listed, even if it was listed before
{
  const lastAnswers = new Map(Object.entries({
    ...cliWindows,
    "claude-sonnet-4-6[1m]": 1_000_000,
  }));
  const unanswered = new Map<string, number | null>([
    ["claude-opus-4-6", 200_000],
    ["claude-sonnet-4-6", 200_000],
    ["claude-sonnet-4-6[1m]", null],
  ]);
  const ids = modelsFromSdk(cliRows, unanswered, lastAnswers).map((m) => m.id);
  assert.ok(ids.includes("claude-opus-4-6[1m]"), "not answered: last answer");
  assert.ok(!ids.includes("claude-sonnet-4-6[1m]"), "refused: not listed");
}

// Compaction sizes the transferred history to the model's window, also for
// a native 1M model without `[1m]` in its id
{
  setDiscoveredModels(modelsFromSdk(cliRows, new Map(Object.entries(cliWindows))));
  assert.equal(summaryHistoryMaxChars("claude-opus-5-5"), 3_000_000);
  assert.equal(summaryHistoryMaxChars("claude-opus-4-6"), 600_000);
  assert.equal(summaryHistoryMaxChars("claude-opus-4-6[1m]"), 3_000_000);
  assert.equal(summaryHistoryMaxChars("claude-unknown-9[1m]"), 3_000_000, "unlisted: by suffix");
  assert.equal(summaryHistoryMaxChars("claude-unknown-9"), 600_000);
}

// A model fallback keeps 1M: an explicit [1m] fallback stays; a plain one
// gets the 1M variant when the original ran at 1M, also a native 1M
// original without the suffix
{
  setDiscoveredModels(modelsFromSdk(
    [
      { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1" },
      { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6" },
    ],
    new Map<string, number | null>([
      ["claude-fable-5-1", 1_000_000],
      ["claude-opus-4-6", 200_000],
      ["claude-opus-4-6[1m]", 1_000_000],
    ]),
  ));
  assert.equal(catalogIdForFallback("claude-opus-4-6[1m]", "claude-opus-4-6"), "claude-opus-4-6[1m]", "named by the CLI");
  assert.equal(catalogIdForFallback("claude-opus-4-6", "claude-fable-5-1"), "claude-opus-4-6[1m]");
  assert.equal(catalogIdForFallback("claude-opus-4-6", "claude-opus-4-6"), "claude-opus-4-6");
}

// The window cache holds while the CLI, the account and the 1M switch stay
// the same, for a day at most
{
  const now = Date.now();
  const models = listedModelIds(cliRows);
  writeContextWindowCache({ key: "k1", savedAt: now, models, windows: cliWindows });
  const cache = readContextWindowCache("k1", now + 60_000);
  assert.deepEqual(cache?.windows, cliWindows);
  assert.equal(readContextWindowCache("k2", now), null, "another CLI, account or 1M switch");
  assert.equal(readContextWindowCache("k1", now + 24 * 60 * 60_000), null, "a day old");
  assert.equal(readContextWindowCache("k1", now - 1), null, "the clock moved back");
  // A model the cache was not taken for drops the whole cache
  assert.equal(cacheForListedModels(cache, models), cache);
  assert.equal(cacheForListedModels(cache, models.slice(1)), cache, "a model gone is no reason");
  assert.equal(cacheForListedModels(cache, [...models, "claude-fable-5-1"]), null);
  // The last answers stay readable whatever the key or age: they are what
  // the CLI said, unlike the menu in models.json, which may hold a guess
  assert.deepEqual(Object.fromEntries(readLastContextWindows()), cliWindows);
}

// With the 1M switch on, no [1m] variant can do better: none is asked. The
// switch reads "on" the way Claude Code does.
{
  const none = { CLAUDE_CONFIG_DIR: join(configDir, "none") };
  for (const value of ["1", "true", "yes", "on", " TRUE "]) {
    assert.equal(oneMillionContextDisabled({ ...none, CLAUDE_CODE_DISABLE_1M_CONTEXT: value }), true, value);
  }
  for (const value of ["0", "false", "no", "off", "", "2"]) {
    assert.equal(oneMillionContextDisabled({ ...none, CLAUDE_CODE_DISABLE_1M_CONTEXT: value }), false, value);
  }
  assert.equal(oneMillionContextDisabled(none), false);
  const switchDir = mkdtempSync(join(tmpdir(), "oc-claude-switch-"));
  writeFileSync(join(switchDir, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: true } }));
  assert.equal(oneMillionContextDisabled({ CLAUDE_CONFIG_DIR: switchDir }), true, "settings.json");
  rmSync(switchDir, { recursive: true, force: true });
  const asked: string[] = [];
  const all200k = {
    setModel: async (id: string) => {
      asked.push(id);
    },
    getContextUsage: async () => ({ rawMaxTokens: 200_000 }),
  };
  await askMissingContextWindows(all200k as any, cliRows, new Map(), { skipExtended: true });
  assert.ok(asked.length > 0 && asked.every((id) => !id.endsWith("[1m]")));
}

// Window variables in Claude Code's settings.json join the cache key
{
  const keyDir = mkdtempSync(join(tmpdir(), "oc-claude-key-"));
  assert.deepEqual(settingsWindowVariables({ CLAUDE_CONFIG_DIR: keyDir }), {}, "no settings.json");
  writeFileSync(
    join(keyDir, "settings.json"),
    JSON.stringify({
      env: {
        CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: 500000,
        DISABLE_COMPACT: "1",
        OTHER: "x",
      },
    }),
  );
  assert.deepEqual(settingsWindowVariables({ CLAUDE_CONFIG_DIR: keyDir }), {
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: "500000",
    DISABLE_COMPACT: "1",
  });
  // Each thing the windows depend on changes the key
  const fakeInit = (version: string, subscriptionType: string) => ({
    initializationResult: async () => ({
      claude_code_version: version,
      account: { email: "dev@example.com", organization: "org", subscriptionType, apiProvider: "firstParty" },
    }),
  });
  const keyOf = (q: object, env: Record<string, string>) => contextWindowKey(q as any, env, undefined);
  const plainEnv = { CLAUDE_CONFIG_DIR: join(keyDir, "none") };
  const base = await keyOf(fakeInit("2.1.300", "max"), plainEnv);
  assert.equal(await keyOf(fakeInit("2.1.300", "max"), plainEnv), base, "nothing changed");
  assert.notEqual(await keyOf(fakeInit("2.1.301", "max"), plainEnv), base, "CLI version");
  assert.notEqual(await keyOf(fakeInit("2.1.300", "pro"), plainEnv), base, "plan");
  assert.notEqual(
    await keyOf(fakeInit("2.1.300", "max"), { ...plainEnv, CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }),
    base,
    "1M switch in the environment",
  );
  assert.notEqual(
    await keyOf(fakeInit("2.1.300", "max"), { CLAUDE_CONFIG_DIR: keyDir }),
    base,
    "window variables in settings.json",
  );
  writeFileSync(join(keyDir, "settings.json"), "{ not json");
  assert.deepEqual(settingsWindowVariables({ CLAUDE_CONFIG_DIR: keyDir }), {}, "unreadable file");
  rmSync(keyDir, { recursive: true, force: true });
}

// A CLI update replaces the executable; CLIs before 2.1.300 do not report
// their version, so the file stands for the build in the cache key
{
  const exeDir = mkdtempSync(join(tmpdir(), "oc-claude-exe-"));
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
  rmSync(exeDir, { recursive: true, force: true });
}

// OpenCode imports a changed local plugin afresh on reload. The time of the
// last catalog read is shared by every copy of the module, so a reload does
// not start a second measuring pass within the ten minutes.
{
  const first = await import("../src/index.ts");
  const reloaded = await import("../src/index.ts?reloaded");
  assert.notEqual(first.ClaudeCodePlugin, reloaded.ClaudeCodePlugin, "a separate module copy");
  first.modelRefreshRuntime.lastModelRefresh = 1234;
  assert.equal(reloaded.modelRefreshRuntime.lastModelRefresh, 1234, "the reloaded copy sees the same time");
}

rmSync(dataDir, { recursive: true, force: true });
rmSync(configDir, { recursive: true, force: true });
console.log("context window regression ok");
