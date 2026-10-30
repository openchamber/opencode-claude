/**
 * Signing in to Claude Code: the plan-only gate (an API key or a cloud
 * provider is refused, a plan's sign-in runs), the secrets kept out of the
 * CLI's environment, the UI login relayed to the official CLI flow, and the
 * auth methods OpenCode is offered.
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): `auth status` and
 * `auth login --claudeai` are the Claude Code simulator's CLI process,
 * answering as CLI 2.1.312 does (`claude.cli.set({ auth })`); the plugin
 * keeps a sign-in check for a minute, `setAuthStatusProbe(null)` drops it and
 * the real probe runs the CLI. Independent cases (test/simulators/cases.ts).
 *
 * Run: bun test/sign-in-regression.ts (any tree: $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>")
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

const world = await createWorld("sign-in");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();
const { setAuthStatusProbe, checkSubscriptionAuth } = world.plugin.detect;

/** Signs the CLI in as `auth` (undefined: the world's default, a plan) and drops the plugin's kept check. */
const signedInAs = (auth: Parameters<typeof claude.cli.set>[0]["auth"]) => {
  claude.cli.set({ auth });
  setAuthStatusProbe(null);
};
/** A turn of a new chat that the plugin refuses before Claude Code: its error text. */
const refusedTurn = async () => {
  const chat = opencode.newChat();
  await opencode.say(chat, "hi");
  const asked = claude.queries.length;
  const refused = await opencode.turn(chat);
  assert.equal(refused.ok, false, "the turn is refused");
  assert.equal(claude.queries.length, asked, "no Claude Code query for it");
  return JSON.stringify(refused.requests.at(-1)?.reply?.raw ?? refused.failure ?? "");
};

await cases.run("signed in with a plan: a turn runs", async () => {
  // `auth status` as CLI 2.1.312 answers it: claude.ai, firstParty.
  signedInAs("subscription");
  try {
    assert.equal(await checkSubscriptionAuth(), null);
    const chat = opencode.newChat();
    await opencode.say(chat, "hi");
    assert.ok((await opencode.turn(chat)).ok, "a plan's turn runs");
  } finally {
    signedInAs(undefined);
  }
});

await cases.run("set to Bedrock: a turn is refused without a Claude Code query", async () => {
  // third_party, apiProvider bedrock.
  signedInAs("bedrock");
  try {
    assert.match(await refusedTurn(), /set to use Bedrock, Vertex or another cloud provider/);
  } finally {
    signedInAs(undefined);
  }
});

await cases.run("signed in with an API key: a turn is refused without a Claude Code query", async () => {
  signedInAs("apiKey");
  try {
    assert.match(String(await checkSubscriptionAuth()), /API key/);
    assert.match(await refusedTurn(), /signed in with an API key/);
    assert.ok(claude.cli.calls().some((call) => call.args.join(" ") === "auth status --json"), "the probe ran the CLI");
  } finally {
    signedInAs(undefined);
  }
});

await cases.run("the other words of auth status: a token runs, an apiKeyHelper is refused, signed out is the CLI's to refuse", async () => {
  // The words `auth status` has had since 2.1.40 (CLI 2.1.312 offline with dummy secrets): a
  // long-lived OAuth token (`oauth_token`) is a plan's sign-in and its turn runs; an apiKeyHelper (`api_key_helper`)
  // is an API key and its turn is refused; signed out (`none`) is no refusal of the plugin's — the CLI fails the turn
  // by itself.
  const { probeClaudeAuthStatusCli } = await pluginModule("detect");
  const { resolveClaudeCli } = await pluginModule("executable-path");
  const binaryPath = await resolveClaudeCli(process.env);
  const statusAs = async (auth: "oauthToken" | "apiKeyHelper" | "loggedOut") => {
    signedInAs(auth);
    return probeClaudeAuthStatusCli({ binaryPath });
  };
  try {
    assert.deepEqual(await statusAs("oauthToken"), { loggedIn: true, detail: "auth-status-oauth", authMethod: "oauth_token" });
    assert.equal(await checkSubscriptionAuth(), null, "a token of the plan: no refusal");
    const chat = opencode.newChat();
    await opencode.say(chat, "hi");
    assert.ok((await opencode.turn(chat)).ok, "a token's turn runs");

    assert.deepEqual(await statusAs("apiKeyHelper"), { loggedIn: false, detail: "api-key-only", authMethod: "api_key_helper" });
    assert.match(String(await checkSubscriptionAuth()), /signed in with an API key/);

    assert.deepEqual(await statusAs("loggedOut"), { loggedIn: false, detail: "auth-status-logged-out", authMethod: "none" });
    assert.equal(await checkSubscriptionAuth(), null, "signed out: the CLI refuses by itself");
  } finally {
    signedInAs(undefined);
  }
  assert.equal(await checkSubscriptionAuth(), null);
});

await cases.run("the CLI's environment loses the API key and the tokens", async () => {
  const { buildClaudeCodeChildEnv } = await pluginModule("auth-env");
  const cleaned = buildClaudeCodeChildEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-secret",
    ANTHROPIC_AUTH_TOKEN: "tok",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    KEEP: "1",
  });
  assert.equal(cleaned.ANTHROPIC_API_KEY, undefined);
  assert.equal(cleaned.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(cleaned.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(cleaned.KEEP, "1");
  assert.equal(cleaned.PATH, "/usr/bin");
});

// The UI login relays the official CLI flow: its authorize URL comes back to the host, and the code the user pastes
// goes into the CLI's stdin. The CLI is the simulator's process: `auth login --claudeai` prints its page (a new one
// each start) and waits for the code, as CLI 2.1.312 does.
const login = await pluginModule("cli-login");
const loginStarts = () => claude.cli.calls().filter((call) => call.args.join(" ") === "auth login --claudeai").length;

await cases.run("the login's URL is relayed out and a retry reuses the live sign-in", async () => {
  const before = loginStarts();
  try {
    const started = await login.startClaudeCliLogin({ urlTimeoutMs: 5_000 });
    assert.equal(started.state, "awaiting-code", JSON.stringify(started));
    assert.match(started.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&/);
    assert.equal(loginStarts() - before, 1, "the CLI's own sign-in ran");
    // Retrying reuses the live sign-in and its still-valid URL — respawning would abandon the verifier the CLI holds
    // in memory.
    const resumed = await login.startClaudeCliLogin({ urlTimeoutMs: 5_000 });
    assert.deepEqual(resumed, { state: "awaiting-code", url: started.url });
    assert.equal(loginStarts() - before, 1, "a live sign-in is reused, not respawned");
    assert.deepEqual(login.getClaudeCliLoginStatus(), { state: "awaiting-code", url: started.url });
    // The code relayed in and the CLI's verdict — an accepted code (exit 0 is the success), a rejected one (the CLI's
    // notice on stderr; the same page kept for the next code; a stale notice not failing the next one) — and
    // CLAUDE_CODE_OAUTH_TOKEN kept out of the CLI's env: wait for the simulator to model the sign-in's code. The old
    // check wrote into a fake child's stdin and emitted its output and exit by hand.
  } finally {
    login.cancelClaudeCliLogin();
    login.resetClaudeCliLoginForTests();
  }
});

await cases.run("no CLI found: the login falls back to terminal instructions", async () => {
  const { resetClaudeCliResolutionCache } = await pluginModule("executable-path");
  const empty = join(world.tmp, "host-without-cli");
  mkdirSync(empty, { recursive: true });
  const before = loginStarts();
  try {
    const missing = await login.startClaudeCliLogin({
      env: { PATH: empty, HOME: empty, USERPROFILE: empty, APPDATA: empty, LOCALAPPDATA: empty },
    });
    assert.equal(loginStarts(), before, "nothing started");
    assert.equal(missing.state, "failed");
    assert.match(missing.state === "failed" ? missing.message : "", /npm install -g @anthropic-ai\/claude-code/);
  } finally {
    resetClaudeCliResolutionCache();
    login.resetClaudeCliLoginForTests();
  }
});

await cases.run("a code submitted with no sign-in running is refused", async () => {
  // Not written blind into nothing.
  const orphan = await login.submitClaudeCliLoginCode("code-without-session");
  assert.equal(orphan.ok, false);
});

await cases.run("the auth methods mirror the CLI's presence and always carry the terminal alternative", async () => {
  // Install only when missing, relay only when present. The method bodies are not invoked here — on a CI host
  // without the CLI the install method would run a real `npm install -g` — so the terminal fallback is exercised
  // through its pure builder instead.
  const { buildAuthMethods, manualInstallResponse } = await pluginModule("index");
  const withoutCli: any[] = buildAuthMethods(false, "/tmp");
  assert.equal(withoutCli.length, 1);
  assert.equal(withoutCli[0].integrationID, "claude-code");
  assert.equal(withoutCli[0].method.label, "Install Claude Code CLI and sign in");
  const withCli: any[] = buildAuthMethods(true, "/tmp");
  assert.equal(withCli.length, 1);
  assert.equal(withCli[0].method.label, "Sign in with Claude Code CLI");
  // The fallback instructions always name both the install and the auth command, whatever the launch failure
  // message was.
  const fallback = manualInstallResponse("boom", "claude-cli");
  assert.match(fallback.instructions, /npm install -g @anthropic-ai\/claude-code/);
  assert.match(fallback.instructions, /claude auth login --claudeai/);
  assert.equal(fallback.mode, "auto");
});

await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
