/**
 * A second OpenCode server on the world's machine (`world.secondProcess`):
 * its own world on the same folders (`createWorld(label, { machine })`), the
 * build of the plugin in OPENCODE_CLAUDE_PLUGIN_DIR, driven over IPC by the
 * test's process. Not run on its own.
 *
 * Its clock runs OPENCODE_CLAUDE_WORLD_CLOCK_SHIFT_MS from the machine's: a
 * process that ran earlier (negative) - `Date.now()` and `new Date()` of
 * everything in it, the plugin's too; timers and `performance.now()` run as
 * they do.
 */
const shift = Number(process.env.OPENCODE_CLAUDE_WORLD_CLOCK_SHIFT_MS ?? 0);
if (shift) {
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + shift);
      else super(...(args as [string | number | Date]));
    }
    static override now() {
      return RealDate.now() + shift;
    }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
}

// The plugin's modules import `node:fs` through second-process-fs.ts: the real module, and a kill or a pause while the
// plugin rewrites a file when the test arms one (`killAtWrite`, `holdAtWrite`).
{
  const { join, resolve, sep } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const src = join(resolve(process.env.OPENCODE_CLAUDE_PLUGIN_DIR!), "src") + sep;
  const fsModule = JSON.stringify(pathToFileURL(join(import.meta.dir, "second-process-fs.ts")).href);
  Bun.plugin({
    name: "world-fs",
    setup(build) {
      build.onLoad({ filter: /[\\/]src[\\/][^\\/]+\.ts$/ }, async ({ path }) => {
        const contents = await Bun.file(path).text();
        if (!path.toLowerCase().startsWith(src.toLowerCase())) return { contents, loader: "ts" };
        return { contents: contents.replace(/(\bfrom\s*|\bimport\s*\(\s*)(["'])(?:node:)?fs\2/g, `$1${fsModule}`), loader: "ts" };
      });
    },
  });
}

const { createWorld, pluginModule } = await import("./world.ts");

const world = await createWorld(process.env.OPENCODE_CLAUDE_WORLD_LABEL || "second", {
  machine: process.env.OPENCODE_CLAUDE_WORLD_MACHINE!,
  env: JSON.parse(process.env.OPENCODE_CLAUDE_WORLD_ENV || "{}"),
});
const instances = new Map<number, Awaited<ReturnType<typeof world.opencode.startPlugin>>>();
let nextInstance = 0;

/** What goes back over IPC: plain data (no functions, no cycles). */
function plain(value: unknown): unknown {
  if (value === undefined) return undefined;
  const seen = new WeakSet<object>();
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === "function" || typeof item === "symbol") return undefined;
      if (typeof item === "bigint") return String(item);
      if (item && typeof item === "object") {
        if (seen.has(item)) return undefined;
        seen.add(item);
      }
      return item;
    }) ?? "null",
  );
}

/** `opencode.say` of the world: the function and the object it belongs to. */
function resolvePath(path: string): { owner: any; value: any } {
  let owner: any = undefined;
  let value: any = world;
  for (const part of path.split(".")) {
    owner = value;
    value = value?.[part];
  }
  return { owner, value };
}

process.on("message", async (message: any) => {
  const reply = (body: Record<string, unknown>) => process.send?.({ id: message.id, ...body });
  try {
    switch (message.op) {
      case "call": {
        const { owner, value } = resolvePath(message.path);
        if (typeof value !== "function") throw new Error(`${message.path} is not a function of the world`);
        return reply({ value: plain(await value.apply(owner, message.args ?? [])) });
      }
      case "set": {
        const { value } = resolvePath(message.path);
        if (!value || typeof value !== "object") throw new Error(`${message.path} is not an object of the world`);
        Object.assign(value, message.fields);
        return reply({ value: null });
      }
      case "start": {
        const instance = await world.opencode.startPlugin(message.options, { directory: message.directory });
        instances.set(++nextInstance, instance);
        return reply({ value: nextInstance });
      }
      case "stop": {
        const instance = instances.get(message.instance);
        if (!instance) throw new Error(`no plugin instance ${message.instance}`);
        instances.delete(message.instance);
        await world.opencode.stopPlugin(instance);
        return reply({ value: null });
      }
      case "module": {
        const module = await pluginModule(message.name);
        if (typeof module[message.fn] !== "function") throw new Error(`${message.name}.${message.fn} is not a function of the plugin`);
        return reply({ value: plain(await module[message.fn](...(message.args ?? []))) });
      }
      case "journal":
        return reply({ value: world.journal() });
      case "killAtWrite":
        (globalThis as { __worldKillAtWrite?: string }).__worldKillAtWrite = message.file;
        return reply({ value: null });
      case "holdAtWrite":
        (globalThis as { __worldHoldAtWrite?: { file: string; flag: string } }).__worldHoldAtWrite = message.file ? { file: message.file, flag: message.flag } : undefined;
        return reply({ value: null });
      case "exit":
        await world.dispose();
        reply({ value: null });
        process.exit(0);
      default:
        throw new Error(`unknown request ${message.op}`);
    }
  } catch (error) {
    reply({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
});

process.send?.({ ready: true });
