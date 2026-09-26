/**
 * Regression: OpenCode 2 imports the plugin once per location. All copies
 * share one proxy listener, and unloading one location does not stop the
 * proxy while another location still holds it.
 *
 * Run: bun test/shared-proxy-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function listening(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "opencode-claude-shared-proxy-"));
  // A query suffix gives each "location" its own copy of the module, the way
  // OpenCode loads the plugin once per location.
  const a = await import("../src/proxy.ts?location=a");
  const b = await import("../src/proxy.ts?location=b");
  assert.notEqual(a, b, "separate module copies");

  const port = await a.startProxy();
  assert.equal(await b.startProxy(), port, "second location reuses the listener");
  assert.equal(b.getClaudeProxyBaseUrl(), `http://127.0.0.1:${port}/v1`);

  const releaseA = a.retainProxy();
  const releaseB = b.retainProxy();
  await releaseA();
  await releaseA();
  assert.ok(await listening(port), "still serving after one location unloads");
  assert.equal(b.getProxyPort(), port);

  await releaseB();
  assert.equal(await listening(port), false, "stopped after the last location unloads");
  assert.equal(a.getProxyPort(), null);

  console.log("ok — shared proxy regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
