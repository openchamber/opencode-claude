/**
 * A process that loads the plugin ends as soon as its work is done. At setup
 * the plugin checks whether Claude Code is installed, capped at 3 seconds;
 * the cap's timer used to stay pending after the check had answered, so the
 * process lived on for those 3 seconds (a test, a script; an OpenCode server
 * never notices).
 *
 * The child (CLI_PRESENCE_CHILD=1) builds the simulated world, starts the
 * plugin, waits for the plugin's own work after setup (its background read
 * of the model list: a CLI process the SDK starts and closes, which ends
 * with its input - `claude.cli.controls()`), disposes of it and returns
 * without process.exit; the parent times how long the child takes to exit
 * after it disposed. The read is waited for because a CLI process started
 * after the simulator closed waits on its connection to it (some 7 s on
 * Windows), which is the world's, not a timer of the plugin.
 *
 * Run: bun test/cli-presence-timer-regression.ts
 */
import { spawnSync } from "node:child_process";

if (process.env.CLI_PRESENCE_CHILD === "1") {
  const { createWorld } = await import("./simulators/world.ts");
  const world = await createWorld("cli-presence-timer");
  await world.opencode.startPlugin();
  // The plugin's background read of the model list: every CLI process it started has had its input closed.
  const settled = () => {
    const controls = world.claude.cli.controls();
    const started = new Set(controls.filter((c) => c.subtype === "initialize").map((c) => c.pid));
    const ended = new Set(controls.filter((c) => c.end).map((c) => c.pid));
    return started.size > 0 && [...started].every((pid) => ended.has(pid));
  };
  for (let waited = 0; !settled(); waited += 20) {
    if (waited > 10_000) throw new Error("the plugin's background read of the model list did not end in 10 s");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await world.dispose();
  const disposedAt = performance.now();
  process.on("exit", () => console.log(`exit-after-dispose-ms ${Math.round(performance.now() - disposedAt)}`));
} else {
  const child = spawnSync(process.execPath, [import.meta.path], {
    env: { ...process.env, CLI_PRESENCE_CHILD: "1", OPENCHAMBER_RUNTIME: "" },
    encoding: "utf8",
  });
  const match = /exit-after-dispose-ms (\d+)/.exec(child.stdout ?? "");
  if (child.status !== 0 || !match) {
    console.log(`FAIL: the child did not finish cleanly (status ${child.status})\n${child.stdout}\n${child.stderr}`);
    process.exit(1);
  }
  const ms = Number(match[1]);
  // The cap is 3 seconds; a process with nothing pending exits in a few milliseconds.
  if (ms >= 1000) {
    console.log(`FAIL: the process lived ${ms} ms after the plugin was disposed (a timer of the plugin kept it)`);
    process.exit(1);
  }
  console.log(`ok - the process exits ${ms} ms after the plugin is disposed`);
}
