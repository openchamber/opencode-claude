/**
 * The plugin's loopback proxy and OpenCode's locations: browser pages are
 * kept off it, a chat in another project carries that folder and its session
 * to Claude Code, and one location torn down does not stop the proxy another
 * still uses.
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): `world.fromBrowser` sends
 * what a browser sends (the Fetch standard; BEHAVIOR.md "A page in the
 * user's browser"); OpenCode starts a plugin instance per location.
 * Independent cases (test/simulators/cases.ts).
 *
 * Run: bun test/proxy-locations-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

const world = await createWorld("proxy-locations");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();
const { getProxyPort, getClaudeProxyBaseUrl } = await pluginModule("proxy");

await cases.run("browser pages do not reach the proxy, OpenCode and a local client naming localhost do", async () => {
  // CSRF and DNS rebinding: what a browser sends is refused.
  const base = `http://127.0.0.1:${getProxyPort()}`;
  assert.equal((await fetch(`${base}/v1/models`)).status, 200, "OpenCode's request");
  assert.equal((await fetch(`http://localhost:${getProxyPort()}/v1/models`)).status, 200, "a local client naming localhost");
  const asked = claude.queries.length;
  const completion = JSON.stringify({ model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content: "spend the plan" }] });
  /** Whether the page's request was sent and what the proxy answered. */
  const fromPage = async (input: Parameters<typeof world.fromBrowser>[0]) => {
    const { wrote: _, ...outcome } = await world.fromBrowser(input);
    return outcome;
  };
  // A page of another site: its fetch carries the page's Origin.
  assert.deepEqual(await fromPage({ page: "https://evil.example", path: "/v1/models" }), { sent: true, status: 403 });
  // A form's POST (no preflight, text/plain): sent with the page's Origin, refused.
  assert.deepEqual(await fromPage({ page: "https://evil.example", path: "/v1/chat/completions", method: "POST", contentType: "text/plain", body: completion, mode: "no-cors" }), { sent: true, status: 403 });
  // A JSON POST needs a preflight: refused, so the request itself is never sent.
  assert.deepEqual(await fromPage({ page: "https://evil.example", path: "/v1/chat/completions", method: "POST", contentType: "application/json", body: completion }), { sent: false, preflight: 403 });
  // DNS rebinding: the attacker's name points at 127.0.0.1, the page's calls are same-origin (no Origin on a GET).
  const rebound = "rebind.evil.example";
  const page = `http://${rebound}:${getProxyPort()}`;
  assert.deepEqual(await fromPage({ page, rebound, path: "/v1/models" }), { sent: true, status: 403 });
  assert.deepEqual(await fromPage({ page, rebound, path: "/v1/chat/completions", method: "POST", contentType: "application/json", body: completion }), { sent: true, status: 403 });
  assert.equal(claude.queries.length, asked, "no Claude Code query for a page");
});

await cases.run("a chat in another project: Claude Code works there and the session goes with the request", async () => {
  // OpenCode starts the plugin there, and its requests carry that folder (a name a header cannot hold raw) and the
  // session to Claude Code.
  const directory = join(world.tmp, "проект infra");
  mkdirSync(directory);
  const instance = await opencode.startPlugin(undefined, { directory });
  try {
    const chat = opencode.newChat("ses_infra", directory);
    const from = world.journal().length;
    await opencode.say(chat, "hi");
    assert.ok((await opencode.turn(chat)).ok, "the turn answered");
    assert.equal(claude.queries.at(-1)!.params.cwd, directory, "Claude Code works in the chat's project");
    assert.ok(world.journal().slice(from).some((line) => line.includes(`"conversationKey":"${chat}","sessionHeader":"${chat}"`)), "the session went with the request");
  } finally {
    await opencode.stopPlugin(instance);
  }
});

await cases.run("one location torn down does not stop the proxy another still uses", async () => {
  // OpenCode opens a second location (a plugin instance of its own), then tears it down.
  const { proxyHolderCount } = world.plugin.proxy;
  const holders = proxyHolderCount();
  const first = getProxyPort();
  const directory = join(world.tmp, "location-evicted");
  mkdirSync(directory, { recursive: true });
  const other = await opencode.startPlugin(undefined, { directory });
  assert.equal(proxyHolderCount(), holders + 1);
  assert.equal(getProxyPort(), first, "locations share one proxy");
  assert.equal(other.provider.info.settings.baseURL, getClaudeProxyBaseUrl());
  await opencode.stopPlugin(other);
  assert.equal(proxyHolderCount(), holders);
  assert.equal(getProxyPort(), first, "still listening for the other location");
  const chat = opencode.newChat();
  await opencode.say(chat, "still there?");
  assert.ok((await opencode.turn(chat)).ok, "the location still open answers");
  // "The last location stops it" is not shown here: the world holds the proxy itself (createWorld's acquireProxy),
  // so no location is ever the last holder. Waits for the simulator to let a location be the last one.
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
