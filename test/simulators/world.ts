/**
 * The simulated world: the OpenCode simulator and the Claude Code simulator
 * with the real plugin between them (its own `setup`, hooks, event loop and
 * proxy over HTTP).
 *
 * The plugin is loaded from a tree of files: this checkout by default, or
 * the one named in OPENCODE_CLAUDE_PLUGIN_DIR (another worktree, or a
 * detached checkout of any commit). So one scenario file runs on
 * main, on a preliminary branch and on every chain step, without a copy:
 *
 *   $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>"; bun test/simulators-regression.ts
 *
 * A scenario reads the plugin only through `world.plugin` (no import of
 * ../src of its own: that would be this checkout's plugin, not the tree
 * under test). `createWorld` must run before anything loads the plugin: it
 * sets the environment those modules read at load (a temp data and config
 * folder, an empty home, and PATH holding only the world's `bin` with the
 * simulated `claude` and node's folder, so no real `claude` is found or
 * updated).
 *
 * A world's folder, `opencode-claude-<label>-*`, goes into the folder
 * OPENCODE_CLAUDE_WORLD_ROOT names (the test system's runs give each tree
 * one), else into `opencode-claude-worlds/by-hand` beside the tests'
 * checkout (`worldRoot`). It stays after the test, for a look: a passed test's world
 * gets a mark `passed` with the time (its process exits with code 0 after
 * `dispose`), a failed one none. The only removal of a world's folder (the
 * user's word, 30.10.2026): each new world removes, in its own root, the folders
 * `opencode-claude-*` whose mark is over two hours old — the links inside
 * first, one by one, then the folder (`removeOldPassedWorlds`). A folder
 * without the mark stays until the user removes it.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

import { cliAnswersPath, createClaudeCodeSimulator, projectFolderName } from "./claude-code.ts";
import { createOpenCodeSimulator } from "./opencode.ts";

/** A hard link of `from` (no copy of node's ~80 MB per world); a symbolic link, then a copy, where that fails. */
function linkOrCopy(from: string, to: string) {
  try {
    linkSync(from, to);
  } catch {
    try {
      symlinkSync(from, to);
    } catch {
      copyFileSync(from, to);
    }
  }
}

/** The tree of the plugin under test. */
export function pluginDir(): string {
  const named = process.env.OPENCODE_CLAUDE_PLUGIN_DIR?.trim();
  return named ? resolve(named) : resolve(import.meta.dir, "..", "..");
}

/** The tree under test as a report names it: its folder and the commit checked out there. */
export function pluginLabel(): string {
  const dir = pluginDir();
  const head = spawnSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout?.trim();
  return head ? `${dir} @ ${head}` : dir;
}

/**
 * A module of the plugin under test, e.g. `pluginModule("proxy")`. `copy`: a
 * fresh instance of the module (imported again under another query), as
 * OpenCode imports a changed plugin afresh on reload.
 */
export function pluginModule<T = any>(name: string, options: { copy?: string } = {}): Promise<T> {
  const path = join(pluginDir(), "src", `${name}.ts`);
  return import(options.copy ? `${path}?${encodeURIComponent(options.copy)}` : path) as Promise<T>;
}

/**
 * Every module of the plugin evaluated afresh, as OpenCode 2.0.32 loads a
 * local plugin (`@opencode/plugin` 2.0.32 `source.bun.js` `prepareSource`,
 * read on 29.10.2026, the cache's behaviour checked in Bun 1.3.13):
 * it walks the entry's imports, drops each local file (not node_modules) from
 * the module registry (`delete require.cache[file]`; Bun exposes ESM there
 * too) and imports the entry again. Each project folder gets such a load (its
 * own plugin sources), and a changed file another one. The modules a copy
 * holds are returned by name (`index`, `models`…); the SDK and other packages
 * stay shared. A plain `pluginModule(name)` afterwards gives the latest
 * copy's, as the registry then holds it. `dir`: another tree (default: the
 * tree under test).
 */
export async function pluginCopy(dir = pluginDir()): Promise<Record<string, any>> {
  const root = join(resolve(dir), "src", "index.ts");
  const files: string[] = [];
  const visit = (file: string) => {
    if (files.includes(file) || file.split(sep).includes("node_modules")) return;
    files.push(file);
    delete require.cache[file];
    const imports = new Bun.Transpiler({ loader: "ts", target: "bun" }).scan(readFileSync(file, "utf8")).imports;
    for (const item of imports) {
      if (!item.path.startsWith("./") && !item.path.startsWith("../")) continue;
      try {
        visit(Bun.resolveSync(item.path, dirname(file)));
      } catch {
        // A missing local file: the loader reports it when it imports.
      }
    }
  };
  visit(root);
  await import(root);
  const modules: Record<string, any> = {};
  for (const file of files) modules[basename(file).replace(/\.[cm]?[jt]s$/, "")] = await import(file);
  return modules;
}

/** git, found while the process still has the machine's PATH (a world empties it). */
const git = Bun.which("git") ?? "git";

/**
 * The tree of a released version (a tag such as "v1.3.0", or a commit) for a
 * test that runs it before the tree under test (`world.build(releaseTree(…))`):
 * a detached checkout in temp/trees/<ref> of the tests' own checkout, made on
 * first use (`git worktree add --detach`), node_modules a junction to that
 * checkout's (the SDK every tree runs with).
 */
export function releaseTree(ref: string): string {
  const checkout = resolve(import.meta.dir, "..", "..");
  const dir = join(checkout, "temp", "trees", ref);
  if (!existsSync(join(dir, "src", "index.ts"))) {
    const made = spawnSync(git, ["-C", checkout, "worktree", "add", "--detach", dir, ref], { encoding: "utf8" });
    if (made.status !== 0 && !existsSync(join(dir, "src", "index.ts"))) throw new Error(`git worktree add ${ref}: ${made.stderr}`);
  }
  if (!existsSync(join(dir, "node_modules"))) {
    try {
      symlinkSync(realpathSync(join(checkout, "node_modules")), join(dir, "node_modules"), "junction");
    } catch (error) {
      if (!existsSync(join(dir, "node_modules"))) throw error;
    }
  }
  return dir;
}

/** The setup OpenCode calls on a build of the plugin, whichever way its module exports it. */
function setupOf(index: Record<string, any>): (ctx: any) => Promise<unknown> {
  const plugin = index.ClaudeCodePlugin ?? index.default;
  return (ctx) => plugin.setup(ctx);
}

/** The mark of a world whose test passed: a file of the world's folder holding the time (ISO). */
const PASSED_MARK = "passed";
/** How long a passed world's folder is kept before a later world removes it. */
const KEEP_PASSED_MS = 2 * 60 * 60 * 1000;

/** The same path, as Windows compares paths. */
const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/**
 * Removes every link inside `folder` (a junction, a symbolic link), one by one and without entering it: a link
 * points out of the folder, and removing the folder must never reach what it points to. A link is what lstat calls
 * one, or an entry whose real path is not the one under its parent. True when no link is left.
 */
function removeLinksInside(folder: string): boolean {
  const links: string[] = [];
  const walk = (dir: string, realDir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) links.push(path);
      else if (stat.isDirectory()) {
        const real = realpathSync(path);
        if (!samePath(real, join(realDir, name))) links.push(path);
        else walk(path, real);
      }
    }
  };
  try {
    walk(folder, realpathSync(folder));
  } catch {
    return false;
  }
  for (const link of links) {
    // A junction or a folder's link goes with rmdir (the link only), a file's with unlink.
    try {
      rmdirSync(link);
    } catch {
      try {
        unlinkSync(link);
      } catch {}
    }
    try {
      lstatSync(link);
      return false;
    } catch {
      // Gone.
    }
  }
  return true;
}

/**
 * Removes the folders `opencode-claude-*` right in `root` whose mark `passed` is over two hours old; nothing else —
 * no folder without the mark, nothing outside the root, no folder that is itself a link, and none with a link
 * inside that could not be removed first. Returns how many were removed.
 */
function removeOldPassedWorlds(root: string): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith("opencode-claude-")) continue;
    const folder = join(root, name);
    try {
      const stat = lstatSync(folder);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(dirname(folder), root)) continue;
      const passedAt = Date.parse(readFileSync(join(folder, PASSED_MARK), "utf8").trim());
      if (!(Date.now() - passedAt > KEEP_PASSED_MS)) continue;
    } catch {
      continue;
    }
    if (!removeLinksInside(folder)) continue;
    try {
      rmSync(folder, { recursive: true });
      removed += 1;
    } catch {
      // In use (a test still running there) or already gone: left for the next world.
    }
  }
  return removed;
}

/** The world's root (`root`) cleared of old passed worlds, said in one line of the test's output. */
function clearOldWorlds(root: string) {
  const removed = removeOldPassedWorlds(root);
  console.log(`world: ${removed} old passed world(s) removed from ${root}`);
}

/**
 * Where a new world's folder goes: OPENCODE_CLAUDE_WORLD_ROOT, else `opencode-claude-worlds/by-hand` beside the
 * tests' checkout (a test run by hand). Not the system's temp and not inside a checkout: the plugin counts every
 * CLAUDE.md of the folders above a chat's folder up to the drive's root, as Claude Code reads them, and OpenCode every
 * AGENTS.md up to the nearest `.git` — the system's temp lies under the user's profile with its `.claude/CLAUDE.md`,
 * a checkout under the clone's own. Beside the checkout nothing lies above (C:\W and C:\, checked 30.10.2026).
 */
function worldRoot(): string {
  const named = process.env.OPENCODE_CLAUDE_WORLD_ROOT?.trim();
  return named || join(dirname(resolve(import.meta.dir, "..", "..")), "opencode-claude-worlds", "by-hand");
}

/**
 * Environment before any plugin module loads. Returns the temp root.
 * `shared`: the plugin's data folder and Claude's profile of another
 * process too (two OpenCode servers on one machine). `machine`: the root of
 * another world - its data, Claude's profile, `bin` (the CLI on PATH), home
 * and the rate-limit store: a second process on the same machine
 * (`world.secondProcess`).
 */
export function prepareEnvironment(label = "world", shared: { dataDir?: string; configDir?: string; machine?: string } = {}, options: { realClaude?: boolean } = {}): string {
  if (options.realClaude) {
    // The machine's own Claude Code, signed in: its PATH, home and profile stay; only the plugin's data is the world's.
    const root = worldRoot();
    mkdirSync(root, { recursive: true });
    clearOldWorlds(root);
    const tmp = mkdtempSync(join(root, `opencode-claude-${label}-`));
    process.env.XDG_DATA_HOME = shared.dataDir ?? join(tmp, "data");
    mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
    process.env.OPENCHAMBER_RUNTIME = "";
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
    process.env.OPENCODE_CLAUDE_DEBUG = "1";
    return tmp;
  }
  // The simulated CLI runs through node (claude-cli.mjs): node goes on PATH, after the world's bin.
  const node = Bun.which("node");
  if (!node) throw new Error("node is not on PATH: the Claude Code simulator's process runs through it");
  const root = worldRoot();
  mkdirSync(root, { recursive: true });
  if (!shared.machine) clearOldWorlds(root);
  const tmp = shared.machine ?? mkdtempSync(join(root, `opencode-claude-${label}-`));
  process.env.XDG_DATA_HOME = shared.machine ? join(tmp, "data") : (shared.dataDir ?? join(tmp, "data"));
  process.env.CLAUDE_CONFIG_DIR = shared.machine ? join(tmp, "claude") : (shared.configDir ?? join(tmp, "claude"));
  for (const dir of [join(tmp, "bin"), join(tmp, "home"), process.env.XDG_DATA_HOME, join(process.env.CLAUDE_CONFIG_DIR, "projects")]) mkdirSync(dir, { recursive: true });
  // node alone, linked into a folder of its own: node's own folder also holds npm, which a test of
  // the plugin's installer must never reach. One folder for every world: Windows checks a new
  // executable at its first start (about 0.7 s), so the link is made once and kept.
  const nodeDir = join(tmpdir(), "opencode-claude-simulator-node");
  const linked = join(nodeDir, basename(node));
  if (!existsSync(linked) || statSync(linked).size !== statSync(node).size) {
    mkdirSync(nodeDir, { recursive: true });
    // Linked under a name of this process, then renamed: worlds of tests running side by side never see a half-made link.
    const linking = `${linked}.${process.pid}.linking`;
    rmSync(linking, { force: true });
    linkOrCopy(node, linking);
    try {
      renameSync(linking, linked);
    } catch (error) {
      // Another world placed it first, or the old one is in use: a link of the right size is all it takes.
      rmSync(linking, { force: true });
      if (!existsSync(linked) || statSync(linked).size !== statSync(node).size) throw error;
    }
  }
  process.env.PATH = [join(tmp, "bin"), nodeDir].join(delimiter);
  process.env.HOME = join(tmp, "home");
  process.env.USERPROFILE = join(tmp, "home");
  process.env.APPDATA = join(tmp, "home");
  process.env.LOCALAPPDATA = join(tmp, "home");
  // OpenCode's own configuration folder is the empty home's too (its global AGENTS.md: opencode.ts `openCodeConfigDir`).
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
  process.env.OPENCHAMBER_RUNTIME = "";
  process.env.OPENCODE_CLAUDE_STOP_GRACE_MS ??= "50";
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");
  // The journal: with debugging on, the plugin mirrors its info lines into
  // <data>/opencode-claude/debug.log.
  process.env.OPENCODE_CLAUDE_DEBUG = "1";
  return tmp;
}

/**
 * `realClaude`: the machine's own signed-in Claude Code instead of the
 * Claude Code simulator (live tests: they spend the subscription); the
 * OpenCode simulator and the plugin as always.
 */
export async function createWorld(label = "world", shared: { dataDir?: string; configDir?: string; machine?: string; env?: Record<string, string | undefined> } = {}, options: { realClaude?: boolean } = {}) {
  // Before the environment: PATH is empty afterwards, git with it.
  const tree = pluginLabel();
  const tmp = prepareEnvironment(label, shared, options);
  // Variables over the world's, before any plugin module reads them (a second process's own).
  for (const [name, value] of Object.entries(shared.env ?? {})) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  // The project folder of the world's working folder (OpenCode's directory, `tmp`): where the CLI keeps its new sessions.
  const projectDir = join(options.realClaude ? tmp : process.env.CLAUDE_CONFIG_DIR!, "projects", projectFolderName(tmp));
  const logPath = join(process.env.XDG_DATA_HOME!, "opencode-claude", "debug.log");

  const claude = createClaudeCodeSimulator(projectDir);
  // The CLI the plugin finds on PATH and starts, for every query and outside a turn (sign-in, version, model
  // list); a query's process connects to the simulator, which runs the query (claude-code.ts `serve`).
  const host = options.realClaude ? undefined : await claude.serve();
  if (host) {
    // On a machine another world laid out, its CLI is the one on PATH (its state and log shared).
    claude.installCli(join(tmp, "bin"), { existing: !!shared.machine });
    process.env.OPENCODE_CLAUDE_SIMULATOR_HOST = host.address;
    // The probed answers the CLI process reads at every start (claude-cli.mjs): not built into its executable.
    process.env.OPENCODE_CLAUDE_SIMULATOR_ANSWERS = cliAnswersPath();
  }
  const detect = await pluginModule("detect");
  const index = await pluginModule("index");
  const proxy = await pluginModule("proxy");
  const opencode = createOpenCodeSimulator({
    directory: tmp,
    setup: (ctx) => index.ClaudeCodePlugin.setup(ctx),
    // A request's queries: the ones Claude got while it ran.
    count: () => claude.queries.length,
  });
  // The proxy stays up across plugin restarts, as it does in OpenCode's
  // server process between reloads.
  await proxy.acquireProxy();

  /** The journal (debug.log) as lines. */
  const journal = (): string[] => (existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean) : []);

  /**
   * The plugin's real query starter, guarded: a query whose CLI the plugin
   * cannot find inside the world is refused before the SDK runs — the SDK
   * would start its own bundled executable then, a real Claude Code. The
   * guard resolves the CLI as the starter does (the same memo); a stale path
   * the plugin still holds passes, and the SDK reports it as missing.
   */
  const guardedStarter = (modules: () => Promise<{ query: any; executablePath: any }>) => async (params: Record<string, any>) => {
    const { query, executablePath } = await modules();
    const cli = String(params.pathToClaudeCodeExecutable ?? "").trim() || (await executablePath.resolveClaudeCodeExecutable({ env: process.env }));
    if (!cli || !resolve(cli).toLowerCase().startsWith(resolve(tmp).toLowerCase())) {
      throw new Error(`the world refused a query through the real SDK: no simulated CLI found (${cli ?? "none"}); the SDK would start its bundled Claude Code`);
    }
    return query.startClaudeQuery(params);
  };
  const realStarter = guardedStarter(async () => ({ query: await pluginModule("query"), executablePath: await pluginModule("executable-path") }));
  // Every query goes through the plugin's real starter and the real SDK (held by `claude.state.holdStart`).
  if (host) proxy.setClaudeQueryStarter(claude.starter(realStarter));

  /**
   * Another build of the plugin in this world, on the same folders: an older
   * release the user ran before upgrading (a detached tree of its commit,
   * `git worktree add --detach temp\trees\<name> <commit>` with node_modules a
   * junction to the main clone's), started by OpenCode with
   * `opencode.startPlugin(options, { setup: build.setup })` and stopped as
   * any instance; then the tree under test on what it left. Its queries go
   * through its own real starter behind the same guard. `copy`: the build
   * loaded afresh (`pluginCopy`), as OpenCode loads a local plugin again.
   */
  const builds: Array<{ proxy: any }> = [];
  const build = async (dir: string, options: { copy?: boolean } = {}) => {
    const at = resolve(dir);
    const modules = options.copy ? await pluginCopy(at) : undefined;
    const module = async (name: string): Promise<any> => modules?.[name] ?? import(join(at, "src", `${name}.ts`));
    const index = await module("index");
    const buildProxy = await module("proxy");
    if (host) {
      const starter = guardedStarter(async () => ({ query: await module("query"), executablePath: await module("executable-path") }));
      buildProxy.setClaudeQueryStarter(claude.starter(starter));
    }
    builds.push({ proxy: buildProxy });
    return { dir: at, index, proxy: buildProxy, module, setup: setupOf(index) };
  };

  /**
   * A second process on this machine: another OpenCode server with the
   * plugin (test/simulators/second-process.ts), on the same data folder,
   * Claude profile, PATH (the same CLI install), home and project folder; its
   * own OpenCode simulator, Claude Code simulator and plugin modules.
   * - `tree`: the build it loads (default: the tree under test);
   * - `clockShiftMs`: its clock runs that far from this one (negative: behind
   *   - a process that ran earlier: what it writes carries its time);
   * - `env`: variables over the machine's (an interval, a PATH order).
   * Driven by `call(path, ...args)` (a function of its world: "opencode.say",
   * "opencode.turn", "claude.cli.set"), `set(path, fields)` (fields of an
   * object there: "claude.state"), `start(options)` / `stop(id)` (a plugin
   * instance), `module(name, fn, ...args)` (a function of its plugin build),
   * `journal()`. `exit()` ends it as OpenCode exits; `kill()` ends it at once
   * (TerminateProcess on Windows, SIGKILL elsewhere): nothing it held is
   * written any more, the processes it started (a CLI, `claude update`) run
   * on, as when a server is killed.
   */
  const children: Array<{ kill: () => Promise<void> }> = [];
  const secondProcess = async (options: { tree?: string; clockShiftMs?: number; env?: Record<string, string | undefined>; label?: string } = {}) => {
    let next = 0;
    const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => (ready = resolve));
    let exitCode: number | null = null;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "second-process.ts")], {
      env: {
        ...process.env,
        OPENCODE_CLAUDE_PLUGIN_DIR: resolve(options.tree ?? pluginDir()),
        OPENCODE_CLAUDE_WORLD_MACHINE: tmp,
        OPENCODE_CLAUDE_WORLD_LABEL: options.label ?? `${label}-second`,
        OPENCODE_CLAUDE_WORLD_CLOCK_SHIFT_MS: String(options.clockShiftMs ?? 0),
        OPENCODE_CLAUDE_WORLD_ENV: JSON.stringify(options.env ?? {}),
        OPENCODE_CLAUDE_WORLD_ID_BASE: String(0x10000000 * (children.length + 1)),
      },
      stdout: "inherit",
      stderr: "inherit",
      ipc(message: any) {
        if (message?.ready) return ready();
        const waiter = waiting.get(message?.id);
        waiting.delete(message?.id);
        if (message?.error !== undefined) waiter?.reject(new Error(`second process: ${message.error}`));
        else waiter?.resolve(message?.value);
      },
      onExit(_proc, code) {
        exitCode = code ?? -1;
        for (const waiter of waiting.values()) waiter.reject(new Error(`the second process ended (code ${exitCode})`));
        waiting.clear();
        ready();
      },
    });
    await started;
    if (exitCode !== null) throw new Error(`the second process ended before it was ready (code ${exitCode})`);
    const ask = (request: Record<string, unknown>): Promise<any> =>
      new Promise((resolve, reject) => {
        if (exitCode !== null) return reject(new Error(`the second process has ended (code ${exitCode})`));
        const id = ++next;
        waiting.set(id, { resolve, reject });
        child.send({ id, ...request });
      });
    const kill = async () => {
      if (exitCode === null) child.kill("SIGKILL");
      await child.exited;
    };
    children.push({ kill });
    return {
      pid: child.pid,
      call: (path: string, ...args: unknown[]) => ask({ op: "call", path, args }),
      set: (path: string, fields: Record<string, unknown>) => ask({ op: "set", path, fields }),
      start: (pluginOptions?: Record<string, unknown>, where: { directory?: string } = {}) => ask({ op: "start", options: pluginOptions, directory: where.directory }) as Promise<number>,
      stop: (instance: number) => ask({ op: "stop", instance }),
      module: (name: string, fn: string, ...args: unknown[]) => ask({ op: "module", name, fn, args }),
      journal: () => ask({ op: "journal" }) as Promise<string[]>,
      /**
       * The process is killed the next time the plugin rewrites the file named (its base name, e.g.
       * "sessions.json"): `writeFileSync` truncates it and the process dies, a rename onto it does not happen -
       * what a kill leaves (second-process-fs.ts). A request then pending fails with the process's end.
       */
      killAtWrite: (file: string) => ask({ op: "killAtWrite", file }),
      /**
       * The process pauses the next time the plugin rewrites the file named (its base name): `writeFileSync`
       * truncates it and the whole process stops there - as a server the system stops running at that moment -,
       * the file empty, until `release()`; a rename onto it waits before it happens (second-process-fs.ts). `held()`:
       * the pause has begun. A request pending meanwhile answers after the release.
       */
      holdAtWrite: async (file: string) => {
        const flag = join(tmp, `hold-${child.pid}-${++next}`);
        await ask({ op: "holdAtWrite", file, flag });
        return {
          held: () => existsSync(`${flag}.held`),
          release: async () => {
            writeFileSync(`${flag}.go`, "");
            await ask({ op: "holdAtWrite", file: null });
          },
        };
      },
      exit: async () => {
        if (exitCode === null) await ask({ op: "exit" }).catch(() => {});
        return child.exited;
      },
      kill,
      get exitCode() {
        return exitCode;
      },
    };
  };
  type CliHandle = { calls: typeof claude.cli.calls; set: typeof claude.cli.set };
  // The starts of queries with a model: a chat turn, a title, a summary — not the plugin's background read of the
  // model list after setup (an idle query with no `--model`), which may start at any moment.
  const startsOf = (cli: CliHandle) => cli.calls().filter((call) => call.initialize && call.args.some((arg) => arg.startsWith("--model")));
  /** Waits until `cli` logs a start after the first `before`; false when `gaveUp()` said to stop waiting first. */
  const waitForStart = async (cli: CliHandle, before: number, gaveUp: () => boolean = () => false) => {
    for (let waited = 0; startsOf(cli).length === before; waited += 50) {
      if (gaveUp()) return false;
      if (waited >= 15_000) throw new Error("the SDK did not start the CLI in 15 s");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };

  /**
   * What the plugin hands the SDK: one query of a new chat saying `text`,
   * into the CLI process `cli` (default: the world's). Returns its first
   * start: the arguments, `runner`, `initialize`.
   * - `chat` (the default): a turn the user stops while the answer is held
   *   (OpenCode does not repeat a stopped request): one start.
   * - `title`, `summary`: OpenCode's title of a chat, its compaction — after
   *   one answered turn; OpenCode cannot stop those, so the process is killed
   *   once it has the prompt (`killOnPrompt`, probes 8 and 10): the title
   *   stays, the compaction fails (OpenCode may retry it).
   */
  const throughRealSdk = async (cli: CliHandle = claude.cli, text = "hello", kind: "chat" | "title" | "summary" = "chat") => {
    const before = startsOf(cli).length;
    const chat = opencode.newChat();
    await opencode.say(chat, text);
    if (kind === "chat") {
      let release = () => {};
      claude.state.hold = new Promise<void>((resolve) => (release = resolve));
      try {
        const stop = new AbortController();
        const turn = opencode.turn(chat, { stop: stop.signal });
        await waitForStart(cli, before);
        stop.abort();
        const stopped = await turn;
        if (!stopped.stopped) throw new Error("the turn through the real SDK was not stopped");
        if (opencode.retries.some((retry) => retry.chat === chat)) throw new Error("OpenCode repeated the stopped request");
      } finally {
        release();
        claude.state.hold = undefined;
      }
      const starts = startsOf(cli).slice(before);
      if (starts.length !== 1) throw new Error(`the SDK started the CLI ${starts.length} times for one turn`);
      return starts[0]!;
    }
    const answered = await opencode.turn(chat);
    if (!answered.ok) throw new Error("the chat's turn on the simulator did not answer");
    cli.set({ killOnPrompt: true });
    try {
      if (kind === "title") await opencode.title(chat);
      else await opencode.compact(chat);
    } finally {
      cli.set({ killOnPrompt: undefined });
    }
    const starts = startsOf(cli).slice(before + 1);
    if (starts.length === 0) throw new Error(`the SDK did not start the CLI for the ${kind}`);
    return starts[0]!;
  };

  /**
   * A turn of `chat` whose first attempt need not start the CLI (a launcher
   * the test removed: the SDK reports it missing, the plugin answers).
   * `beforeRetry` runs before OpenCode's first retry (the test puts a CLI
   * back); the attempt that starts the CLI is then stopped by the user, as in
   * `throughRealSdk`. Every attempt goes through the guard: none runs without
   * a simulated CLI. Returns the turn and the starts it made.
   */
  const turnThroughRealSdk = async (chat: string, options: { cli?: CliHandle; beforeRetry?: () => void | Promise<void> } = {}) => {
    const cli = options.cli ?? claude.cli;
    const before = startsOf(cli).length;
    const sleep = opencode.state.sleep;
    let retried = false;
    opencode.state.sleep = async (ms: number) => {
      if (!retried) {
        retried = true;
        await options.beforeRetry?.();
      }
      await sleep(ms);
    };
    let release = () => {};
    claude.state.hold = new Promise<void>((resolve) => (release = resolve));
    try {
      const stop = new AbortController();
      let ended = false;
      const turn = opencode.turn(chat, { stop: stop.signal }).finally(() => (ended = true));
      if (await waitForStart(cli, before, () => ended)) stop.abort();
      return { turn: await turn, starts: startsOf(cli).slice(before) };
    } finally {
      release();
      claude.state.hold = undefined;
      opencode.state.sleep = sleep;
    }
  };

  /**
   * What a page open in the user's browser sends to the plugin's proxy, by the Fetch standard
   * (fetch.spec.whatwg.org, "append a request `Origin` header", "CORS-preflight fetch"): the page `page` (an origin)
   * calls `path` of the proxy by `fetch()` (`mode` "cors", the default, or "no-cors" as a form or an image does).
   * `rebound`: the attacker's host name, which DNS rebinding pointed at 127.0.0.1 — the browser connects to the
   * proxy and names that host in `Host`, and the call is same-origin for the page at that name. The request goes over
   * a plain socket exactly as the browser writes it: `Host`, `Origin` on every cross-origin `cors` request and on any
   * other but GET and HEAD, a preflight `OPTIONS` first for a cross-origin request that is not CORS-safelisted (a
   * method other than GET, HEAD, POST, or a `Content-Type` other than text/plain, a form's), and the request itself
   * only when the preflight allowed it; a `no-cors` request that is not safelisted is never sent. Returns whether the
   * request was sent, the statuses the proxy answered, and what was written (`wrote`: each request's head).
   */
  const fromBrowser = async (input: { page: string; path: string; method?: "GET" | "POST" | "PUT"; contentType?: string; body?: string; mode?: "cors" | "no-cors"; rebound?: string }) => {
    const port = proxy.getProxyPort() as number;
    const method = input.method ?? "GET";
    const host = `${input.rebound ?? "127.0.0.1"}:${port}`;
    const sameOrigin = input.page === `http://${host}`;
    const safelisted = ["GET", "HEAD", "POST"].includes(method) && (input.contentType === undefined || ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"].includes(input.contentType.split(";")[0]!.trim().toLowerCase()));
    const mode = input.mode ?? "cors";
    const wrote: string[] = [];
    if (!sameOrigin && mode === "no-cors" && !safelisted) return { sent: false as const, wrote };
    const send = (lines: string[], body = "") =>
      new Promise<{ status: number; headers: Record<string, string> }>((resolveSend, reject) => {
        const socket = netConnect({ host: "127.0.0.1", port }, () => {
          const head = [lines[0]!, `Host: ${host}`, ...lines.slice(1), "Connection: close", ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []), "", ""].join("\r\n");
          wrote.push(head);
          socket.write(head + body);
        });
        let received = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => (received += chunk));
        socket.on("error", reject);
        socket.on("close", () => {
          const [statusLine, ...headerLines] = received.split("\r\n\r\n")[0]!.split("\r\n");
          const headers = Object.fromEntries(headerLines.map((line) => [line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
          resolveSend({ status: Number(statusLine?.split(" ")[1] ?? 0), headers });
        });
      });
    const origin = [`Origin: ${input.page}`];
    let preflight: number | undefined;
    if (!sameOrigin && mode === "cors" && !safelisted) {
      const asked = await send([`OPTIONS ${input.path} HTTP/1.1`, ...origin, `Access-Control-Request-Method: ${method}`, ...(input.contentType ? ["Access-Control-Request-Headers: content-type"] : [])]);
      preflight = asked.status;
      const allowedOrigin = asked.headers["access-control-allow-origin"];
      const ok = asked.status >= 200 && asked.status < 300 && (allowedOrigin === "*" || allowedOrigin === input.page);
      if (!ok) return { sent: false as const, preflight, wrote };
    }
    const withOrigin = (!sameOrigin && mode === "cors") || !["GET", "HEAD"].includes(method);
    const answer = await send([`${method} ${input.path} HTTP/1.1`, ...(withOrigin ? origin : []), ...(input.contentType ? [`Content-Type: ${input.contentType}`] : [])], input.body ?? "");
    return { sent: true as const, status: answer.status, ...(preflight === undefined ? {} : { preflight }), wrote };
  };

  const dispose = async () => {
    opencode.stopBackground();
    for (const child of children) await child.kill();
    for (const instance of [...opencode.instances]) await opencode.stopPlugin(instance);
    if (host) proxy.setClaudeQueryStarter(null);
    for (const other of builds) {
      if (host) other.proxy.setClaudeQueryStarter(null);
      await other.proxy.stopProxy?.();
    }
    await proxy.releaseProxy();
    await proxy.stopProxy();
    await host?.close();
    // The folder this world made gets the mark `passed` once the test's process exits with code 0 (a second process
    // on another world's machine leaves that world's folder to it).
    if (!shared.machine) {
      process.once("exit", (code) => {
        if (code !== 0) return;
        try {
          writeFileSync(join(tmp, PASSED_MARK), `${new Date().toISOString()}\n`);
        } catch {
          // The folder is gone: nothing to keep.
        }
      });
    }
  };

  return { tmp, projectDir, logPath, dir: pluginDir(), label: tree, plugin: { index, proxy, detect }, claude, opencode, journal, throughRealSdk, turnThroughRealSdk, build, secondProcess, fromBrowser, dispose };
}

export type World = Awaited<ReturnType<typeof createWorld>>;
