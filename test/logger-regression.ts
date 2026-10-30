/**
 * The plugin's logger: errors always emit, info only with
 * OPENCODE_CLAUDE_DEBUG, and both go to the durable debug.log mirror.
 *
 * A process of its own with the plugin tree's log.ts (bun itself: the world's
 * PATH holds no bun), with a data folder of its own: its error line must not
 * land in the world's journal.
 *
 * Run: bun test/logger-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { testCases } from "./simulators/cases.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("logger");
const cases = testCases();
const dataDir = join(world.tmp, "logger-data");
const logPath = join(dataDir, "opencode-claude", "debug.log");
const run = (script: string, debug: "0" | "1") =>
  spawnSync(process.execPath, ["-e", script], {
    cwd: world.dir,
    encoding: "utf8",
    env: { ...process.env, XDG_DATA_HOME: dataDir, OPENCODE_CLAUDE_DEBUG: debug },
  });

await cases.run("errors always emit, info is debug-gated, both mirrored to debug.log", () => {
  const off = run(`import { log } from "./src/log.ts"; log.info("SILENT_INFO"); log.error("ALWAYS_ERROR");`, "0");
  assert.equal(off.status, 0, off.stderr);
  assert.doesNotMatch(off.stderr, /SILENT_INFO/);
  assert.match(off.stderr, /ALWAYS_ERROR/);

  const on = run(`import { log } from "./src/log.ts"; log.info("DEBUG_INFO", { ok: true });`, "1");
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stderr, /DEBUG_INFO/);
  assert.match(on.stderr, /"ok":true/);
  assert.ok(existsSync(logPath), "expected durable debug.log");
  const fileBody = readFileSync(logPath, "utf8");
  assert.match(fileBody, /ALWAYS_ERROR/);
  assert.match(fileBody, /DEBUG_INFO/);
  assert.doesNotMatch(fileBody, /SILENT_INFO/);
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
