/**
 * The Claude Code simulator as a process: the `claude` the plugin finds on
 * PATH and starts outside a turn. `claude-code.ts` installs it (installCli)
 * the way npm lays the CLI out, and writes its state beside it
 * (`state.json`); every start is logged to `calls.jsonl` there.
 *
 * The same program runs as npm's `cli.js` through node and, compiled by
 * `bun build --compile` (claude-code.ts `compiledCli`), as `claude.exe` of
 * the native layouts.
 *
 * What it answers, as Claude Code 2.1.312 does (a live probe of the CLI
 * outside a turn, the machine's signed-in profile, no model call; the answers
 * it recorded, personal data replaced: claude-cli-answers.json, read at every
 * start from the path the world gives, `OPENCODE_CLAUDE_SIMULATOR_ANSWERS` —
 * so the compiled executable holds none of them):
 * - `--version`: "<version> (Claude Code)";
 * - `auth status [--json]`: the JSON of the state's sign-in (exit 1 when
 *   signed out);
 * - `update` (a native install; state `update`): as 2.1.300 printed it live
 *   and the 2.1.280 binary's strings read;
 * - `--input-format stream-json` (the Agent SDK's control protocol): the
 *   control requests `initialize` (models, account, version), `set_model`
 *   and `get_context_usage` (`detail: "summary"`).
 * The probes the comments below name, all of CLI 2.1.312 outside a turn, no
 * model call to the real API: the live probe (above); the signed-out probe (an
 * empty profile, and the machine's profile with every connection sent to a
 * dead proxy: "offline"); the windows probe (signed out, and a dummy key
 * against a local stub of the API that accepts every check, each with
 * CLAUDE_CODE_DISABLE_1M_CONTEXT off and on).
 * A query's turns: the plugin's real starter and the real SDK start this
 * process for every query, as they start Claude Code. With the world's
 * simulator listening (`OPENCODE_CLAUDE_SIMULATOR_HOST`, claude-code.ts
 * `serve`), the process connects to it and carries the query both ways: its
 * arguments, working folder, environment and `initialize` go there, then
 * every line of its input the SDK writes (user messages, `interrupt`, the
 * SDK's answers to the CLI's own requests); what the simulator answers is
 * written to stdout, and the simulator says how the process ends (an exit
 * code, a signal, a text on stderr). The control requests above stay
 * answered here. Anything else this process is asked — another control
 * request, another command — ends it with an error naming it, so a test that
 * needs it fails instead of passing on an invented answer: add it here from
 * a probe.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

// A helper left holding this process's output after it exits (`update.afterExit`): it writes its
// text, if any, after the wait, then ends — the pipes close only then. Not a start of the CLI: not logged.
if (process.argv[2] === "--simulator-hold-output") {
  await new Promise((resolve) => setTimeout(resolve, Number(process.argv[3])));
  if (process.argv[4]) process.stdout.write(process.argv[4]);
  process.exit(0);
}

// Where this install keeps its state and log: beside the executable when it is the compiled
// `claude.exe` (layouts with a binary), beside the package's `cli.js` when node runs it.
const compiled = !/^(node|bun)(\.exe)?$/i.test(basename(process.execPath));
const here = compiled ? dirname(process.execPath) : dirname(process.argv[1]);
const statePath = join(here, "state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const args = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".claude");
// `runner`: what ran this program — node (a `cli.js` the SDK started with `executable: "node"`) or the executable itself.
const runner = basename(process.execPath).replace(/\.exe$/i, "");
appendFileSync(join(here, "calls.jsonl"), JSON.stringify({ args, configDir, at: Date.now(), runner }) + "\n");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The same program installed as the plugin's installers (claude-code.ts `installers`): `npm`
// (`install -g @anthropic-ai/claude-code`), `curl` (downloads the install script) and `bash` (runs it:
// the official installer puts `claude` in ~/.local/bin). Each answers by `installers.json` beside it:
// "ok", "fail" (exit 1) or "hang"; each start is logged to `installer-calls.jsonl`.
const role = compiled ? basename(process.execPath).replace(/\.exe$/i, "").toLowerCase() : "claude";
if (role !== "claude") {
  const plan = existsSync(join(here, "installers.json")) ? JSON.parse(readFileSync(join(here, "installers.json"), "utf8")) : {};
  appendFileSync(join(here, "installer-calls.jsonl"), JSON.stringify({ command: role, args, at: Date.now() }) + "\n");
  const outcome = plan[role] ?? "ok";
  if (outcome === "hang") await new Promise(() => {});
  if (outcome === "fail") {
    process.stderr.write(`${role}: failed (the simulator's installers.json)\n`);
    process.exit(1);
  }
  const { copyFileSync, mkdirSync, writeFileSync } = await import("node:fs");
  if (role === "curl") {
    const out = args[args.indexOf("-o") + 1];
    if (!out || args.indexOf("-o") < 0) fail(`curl ${args.join(" ")}`);
    writeFileSync(out, "#!/bin/bash\n# the Claude Code simulator's install script\n");
    process.exit(0);
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const target = role === "npm" && process.platform !== "win32" ? join(here, "claude") : join(home, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  if (role === "npm" && !(args[0] === "install" && args.includes("-g"))) fail(`npm ${args.join(" ")}`);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(process.execPath, target);
  process.stdout.write(role === "npm" ? "added 1 package\n" : "Claude Code successfully installed!\n");
  process.exit(0);
}

// The probed answers, from the file the world names: OPENCODE_CLAUDE_SIMULATOR_ANSWERS (world.ts sets it beside
// OPENCODE_CLAUDE_SIMULATOR_HOST; the plugin's starters and the SDK pass the environment on), else `answers-path.txt`
// of this install (claude-code.ts `installCli`) — a test's own start through Bun's spawn with no `env` gets the
// environment the test's process started with, without the world's variables (Bun 1.3.13). Under the test system's
// preload (temp/test-system/cover.ts) the keys read are recorded as those of a JSON import are, by the file's name.
const answersPath = process.env.OPENCODE_CLAUDE_SIMULATOR_ANSWERS || (existsSync(join(here, "answers-path.txt")) ? readFileSync(join(here, "answers-path.txt"), "utf8").trim() : undefined);
if (!answersPath) {
  process.stderr.write("the Claude Code simulator has no answers: no OPENCODE_CLAUDE_SIMULATOR_ANSWERS and no answers-path.txt beside the install (createWorld and installCli give them)\n");
  process.exit(70);
}
const answersRead = JSON.parse(readFileSync(answersPath, "utf8"));
const answers = globalThis.__coveredJson?.("test/simulators/claude-cli-answers.json", answersRead) ?? answersRead;
const version = state.version ?? answers.initialize.claude_code_version;

if (state.delayMs) await wait(state.delayMs);

const fail = (what) => {
  process.stderr.write(`the Claude Code simulator does not know ${what}: add it to test/simulators/claude-cli.mjs from a probe\n`);
  process.exit(70);
};

/**
 * `auth status --json` by sign-in (probe 2026-10-28: claude.ai, signed out, ANTHROPIC_API_KEY,
 * CLAUDE_CODE_USE_BEDROCK; 2.1.312 offline with dummy secrets: a long-lived OAuth token —
 * CLAUDE_CODE_OAUTH_TOKEN, and ANTHROPIC_AUTH_TOKEN answers the same — and settings.json `apiKeyHelper`). The same
 * six `authMethod` words since `auth status` came in 2.1.40 (its cli.js): none, third_party, claude.ai,
 * api_key_helper, oauth_token, api_key.
 */
function authStatus(auth) {
  const dirs = { projectsDirectory: join(configDir, "projects"), configDirectory: configDir };
  if (auth === "loggedOut") return { loggedIn: false, authMethod: "none", apiProvider: "firstParty", analyticsDisabled: false, ...dirs };
  if (auth === "apiKey") return { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", analyticsDisabled: false, ...dirs, apiKeySource: "ANTHROPIC_API_KEY" };
  if (auth === "oauthToken") return { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty", analyticsDisabled: false, ...dirs };
  if (auth === "apiKeyHelper") return { loggedIn: true, authMethod: "api_key_helper", apiProvider: "firstParty", analyticsDisabled: false, ...dirs, apiKeySource: "apiKeyHelper" };
  if (auth === "bedrock") return { loggedIn: true, authMethod: "third_party", apiProvider: "bedrock", analyticsDisabled: true, ...dirs };
  return {
    loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", analyticsDisabled: false, ...dirs,
    email: "user@example.com", orgId: "00000000-0000-4000-8000-000000000000", orgName: "Example Organization", subscriptionType: "max",
  };
}

if (args[0] === "--version" || args[0] === "-v") {
  // `versionText`: what another program in the CLI's place prints (bunImpostor: Bun's "1.4.0").
  process.stdout.write(state.versionText !== undefined ? `${state.versionText}\n` : `${version} (Claude Code)\n`);
  process.exit(0);
}
// Each Claude profile folder holds its own sign-in.
const signIn = Object.entries(state.authByConfigDir ?? {}).find(([dir]) => resolve(dir).toLowerCase() === resolve(configDir).toLowerCase())?.[1] ?? state.auth ?? "subscription";
if (args[0] === "auth" && args[1] === "status") {
  const status = authStatus(signIn);
  process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  process.exit(status.loggedIn ? 0 : 1);
}
if (args[0] === "auth" && args[1] === "login") {
  // What 2.1.312 prints before it waits for the code (a fresh profile, killed before any code was sent): a new `state` and
  // challenge each start. The code exchange is not modelled: a line on stdin ends the process.
  const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  process.stdout.write("Opening browser to sign in…\n");
  process.stdout.write(`If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins&code_challenge=${random()}&code_challenge_method=S256&state=${random()}\n`);
  process.stdout.write("Paste code here if prompted > ");
  for await (const line of createInterface({ input: process.stdin })) fail(`the sign-in code exchange (got a line: ${line.length} characters)`);
  process.exit(0);
}
if (args[0] === "update") {
  // A native install (`local-bin`), as Claude Code 2.1.300 printed it live (an isolated
  // install: an update to 2.1.301, no network, the connection cut mid-download, the launcher held open) and as the
  // 2.1.280 binary's own strings read (up to date, another process busy, managed by winget or a package
  // manager, the check failed). An npm install runs `npm install -g`
  // instead: not probed.
  const npmInstall = /[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code([\\/]|$)/i.test(here);
  const update = state.update ?? {};
  const outcome = update.outcome ?? "upToDate";
  // An npm install: only the failures whose texts the binary holds (2.1.302 as the author's test read them; the same
  // lines are in 2.1.312, which adds more advice); its success and "up to date" were not seen — not modelled.
  const NPM_OUTCOMES = ["npmOffline", "npmPermissions", "npmBusy", "npmPlaceholderLeft"];
  if (npmInstall && !NPM_OUTCOMES.includes(outcome)) fail(`\`claude update\` of an npm install with the outcome ${JSON.stringify(outcome)} (it runs npm install -g; probe it)`);
  if (!npmInstall && NPM_OUTCOMES.includes(outcome)) fail(`the npm outcome ${JSON.stringify(outcome)} on a native install`);
  const to = update.to ?? version;
  const out = (text) => process.stdout.write(text);
  const err = (text) => process.stderr.write(text);
  const preamble = () => out(`Current version: ${version}\nChecking for updates to latest version...\n`);
  const failed = (cause) => err(`Error: Failed to install native update\nTelemetrySafeError: ${cause}\nTry running "claude doctor" for diagnostics\n`);
  if (update.afterExit) {
    const { spawn } = await import("node:child_process");
    const helperArgs = [...(compiled ? [] : [process.argv[1]]), "--simulator-hold-output", String(update.afterExit.ms), update.afterExit.text ?? ""];
    spawn(process.execPath, helperArgs, { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref();
  }
  let code = 0;
  // Before 2.1.214 `claude update` could hang right after "Checking for updates" (Claude Code docs,
  // troubleshoot-install: a directory where a shell config file is looked for).
  if (outcome === "hang") {
    preamble();
    await new Promise(() => {});
  }
  // Seen as "claude update fails silently" (anthropics/claude-code #66946, #63339, 2.1.153): no output at all; the
  // exit code was not reported, so the test names it (`code`).
  else if (outcome === "silent") {
    if (typeof update.code !== "number") fail("`claude update` outcome silent without its `code` (the issues name none)");
    code = update.code;
  } else if (outcome === "upToDate") {
    preamble();
    out(`Claude Code is up to date (${version})\n`);
  } else if (outcome === "updated" || outcome === "launcherHeld") {
    preamble();
    out(`Updating to ${to}...\n`);
    out(`Successfully updated from ${version} to version ${to}\n`);
    // The new version answers the next `claude --version`, and the next update finds it up to date (live run 2);
    // with the launcher held open the old one stays.
    if (outcome === "updated") writeFileSync(statePath, JSON.stringify({ ...state, version: to, update: { ...update, outcome: "upToDate" } }));
  } else if (outcome === "busy") {
    out("Another Claude process (PID 4242) is currently running. Please try again in a moment.\n");
  } else if (outcome === "winget") {
    out("Claude is managed by winget.\nTo update, run:\n  winget upgrade Anthropic.ClaudeCode\n");
  } else if (outcome === "checkFailed") {
    preamble();
    err("Failed to check for updates\n");
    code = 1;
  } else if (outcome === "noNetwork") {
    preamble();
    failed("Failed to fetch version from https://downloads.claude.ai/claude-code-releases/latest after 3 attempt(s): connect ECONNREFUSED 127.0.0.1:9");
    code = 1;
  } else if (outcome === "cutMidway") {
    preamble();
    out(`Updating to ${to}...\n`);
    failed("The connection dropped while downloading the update (attempt 3/3: aborted). Check your network — proxies sometimes cut off large downloads.");
    code = 1;
  }
  // More reports of users (anthropics/claude-code issues, the output quoted there, the version reported):
  else if (outcome === "fetchRefused") {
    // #89705, 2.1.241: the release channel answered 403.
    preamble();
    err("Error: Failed to install native update\nTelemetrySafeError: Failed to fetch version from https://downloads.claude.ai/claude-code-releases/latest after 3 attempt(s): Request failed with status code 403\n");
    code = 1;
  } else if (outcome === "eexist") {
    // #81004, 2.1.215 on Windows: a read-only directory of the install.
    preamble();
    out(`Updating to ${to}...\n`);
    err(`Error: Failed to install native update\nError: EEXIST: file already exists, mkdir '${join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".local", "share", "claude", "versions")}'\nTry running "claude doctor" for diagnostics\n`);
    code = 1;
  } else if (outcome === "socketClosed") {
    // #63126, 2.1.153 behind a proxy: one line, nothing before it.
    err("Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()\n");
    code = 1;
  } else if (outcome === "bunImpostor") {
    // #80933, 2.1.219: the update said it succeeded and installed the Bun runtime instead; its `--version` is Bun's.
    preamble();
    out(`Updating to ${to}...\n`);
    out(`Successfully updated from ${version} to version ${to}\n`);
    writeFileSync(statePath, JSON.stringify({ ...state, versionText: "1.4.0" }));
  } else if (outcome === "homebrew") {
    // #41194, 2.1.81: a Homebrew install is not updated by the CLI (exit 0, as "managed by" in the binary's strings).
    preamble();
    out(`\nClaude is managed by Homebrew.\nUpdate available: ${version} → ${to}\n\nTo update, run:\n  brew upgrade claude-code\n`);
  } else if (outcome === "npmOffline") {
    preamble();
    out("Failed to check for updates\nUnable to fetch latest version from npm registry\n\nPossible causes:\n  • Network connectivity issues\n  • npm registry is unreachable\n\nTry:\n  • Check your internet connection\n  • Check if you need to login: npm whoami\n");
    code = 1;
  } else if (outcome === "npmPermissions") {
    preamble();
    out("Error: Insufficient permissions to install update.\nTry manually updating with:\n  cd ~/.claude/local && npm update @anthropic-ai/claude-code\nTry running with sudo or fix npm permissions\n");
    code = 1;
  } else if (outcome === "npmBusy") {
    preamble();
    out("Error: Another instance is currently performing an update.\nPlease wait and try again later.\n");
    code = 1;
  } else if (outcome === "npmPlaceholderLeft") {
    // anthropics/claude-code #96265 (Windows, npm, 2.1.276 → 2.1.280) and #72690: npm could not put the native binary in
    // place (in use, or its optional package dropped), the package's ~500-byte placeholder script stays as
    // bin/claude.exe, and `claude update` still says it updated. Here the running binary is renamed aside (Windows
    // allows that) and the placeholder written in its place: the next start meets the real outcome of the system —
    // Windows refuses a text file as a program, elsewhere the script prints its error and exits 1.
    if (!compiled) fail("npmPlaceholderLeft on an install without bin/claude.exe (the npm layout has one)");
    preamble();
    out(`Updating to ${to}...\n`);
    out(`Successfully updated from ${version} to version ${to}\n`);
    const { renameSync } = await import("node:fs");
    renameSync(process.execPath, `${process.execPath}.old.${Date.now()}`);
    writeFileSync(
      process.execPath,
      '#!/bin/sh\necho "Error: claude native binary not installed." >&2\necho "Run the postinstall manually (adjust path for local vs global install):" >&2\necho "  node node_modules/@anthropic-ai/claude-code/install.cjs" >&2\nexit 1\n',
      { mode: 0o755 },
    );
  } else fail(`the update outcome ${JSON.stringify(outcome)}`);
  // anthropics/claude-code #104403 (2.1.308, native install): a warning printed on every run, whatever the outcome.
  if (update.pathWarning) {
    out("Warning: Native installation exists but ~/.local/bin is not in your PATH\nFix: Run: echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.zshrc then open a new terminal or run: source ~/.zshrc\n");
  }
  process.exit(code);
}
if (!args.includes("--input-format") || args[args.indexOf("--input-format") + 1] !== "stream-json") fail(`the command \`claude ${args.join(" ")}\``);

// The Agent SDK's control protocol on stdin/stdout, one JSON object a line.
// Signed out (the signed-out probe, an empty profile; 2.1.310 the same on 26.10): five rows, an
// account with no token, set_model refused but to a listed alias or the model it runs on, the windows probed.
// An API key (the windows probe, a dummy key against a stub that accepts every
// model check): the same five rows, an account naming the key's source, every switch the API accepts.
// A long-lived OAuth token and an apiKeyHelper (a probe of 2.1.312 offline with dummy secrets): their
// own rows and account; what the API answers then is the subscription's and the key's.
const signedOut = signIn === "loggedOut";
const byKey = signIn === "apiKey" || signIn === "apiKeyHelper";
const signInAnswers = { loggedOut: answers.signedOut, apiKey: answers.apiKey, apiKeyHelper: answers.apiKeyHelper, oauthToken: answers.oauthToken }[signIn];
const models = state.models ?? signInAnswers?.models ?? answers.initialize.models;
const account = signInAnswers?.account ?? { ...answers.initialize.account, ...state.account };
// Every control request and the end of the input are logged (`controls()`): what the plugin asked, and that it closed the process.
const control = (entry) => appendFileSync(join(here, "controls.jsonl"), JSON.stringify({ pid: process.pid, at: Date.now(), ...entry }) + "\n");
// `granted1m`: the window of a `[1m]` the probed subscription is refused, once a test lifts the refusal (an account
// with access): as the CLI reported it when the API accepted the check.
const windows = { ...(byKey ? answers.apiKey.windows : answers.windows), ...answers.granted1m.windows, ...state.windows };
// A refusal set to null in the state is lifted: the account may use that model.
const refusals = Object.fromEntries(Object.entries({ ...(byKey ? {} : answers.setModelErrors), ...state.setModelErrors }).filter(([, refusal]) => refusal));

/**
 * CLAUDE_CODE_DISABLE_1M_CONTEXT (a probe of 2.1.312 signed out and with a dummy key; the binary's `gP()`): read from the
 * environment, from the `env` of the profile's settings.json when the user's settings load (`--setting-sources`
 * absent or naming `user`) and from the `env` of the `--settings` JSON; settings win over the environment either
 * way. On: "1", "true", "yes", "on" in any case, spaces around ignored (JSON true and 1 too); anything else is off.
 * Then every model runs at 200K, a `[1m]` of some Opus and Sonnet ids is refused by the CLI itself, and a `[1m]` it
 * accepts keeps its suffix in the model it reports.
 */
function oneMillionDisabled() {
  const values = [process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT];
  const sources = flagValue("--setting-sources");
  if (sources === undefined || sources.split(",").includes("user")) {
    try {
      values.push(JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"))?.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT);
    } catch {
      // No settings.json, or one the CLI cannot read either.
    }
  }
  try {
    values.push(JSON.parse(flagValue("--settings") ?? "{}")?.env?.CLAUDE_CODE_DISABLE_1M_CONTEXT);
  } catch {
    // A settings file path instead of JSON: not read here.
  }
  // Which of settings.json and --settings wins when both name it was not probed: the last one that does.
  const value = values.filter((v) => v !== undefined && v !== null).at(-1);
  return value !== undefined && /^(1|true|yes|on)$/i.test(String(value).trim());
}
function flagValue(name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    if (args[i] === name && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}
const disabled1m = oneMillionDisabled();
let model = models[0]?.resolvedModel ?? models[0]?.value;
/** The window each model was switched to with (`claude-opus-4-6` runs at 200K, `claude-opus-4-6[1m]` at 1M). */
const windowOf = new Map();
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const success = (id, response) => send({ type: "control_response", response: { subtype: "success", request_id: id, response } });

/**
 * The link to the world's simulator, which runs this query (claude-code.ts `serve`): frames of one JSON a line.
 * Out: `start` (arguments, folder, environment, pid), `initialize`, `stdin` (a line of the input it does not answer
 * itself), `end` (the input ended). In: `stdout` (a message to write), `stderr` (a text), `exit` (a code, once the
 * output is written), `kill` (a signal).
 */
let link;
const hostAddress = process.env.OPENCODE_CLAUDE_SIMULATOR_HOST;
if (hostAddress) {
  const { createConnection } = await import("node:net");
  const at = hostAddress.lastIndexOf(":");
  link = createConnection({ host: hostAddress.slice(0, at), port: Number(hostAddress.slice(at + 1)) });
  link.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    link.once("connect", resolve);
    link.once("error", reject);
  });
  let buffer = "";
  link.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const frame = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (frame.stdout !== undefined) send(frame.stdout);
      if (frame.stderr !== undefined) process.stderr.write(frame.stderr);
      if (frame.kill !== undefined) process.kill(process.pid, frame.kill);
      if (frame.exit !== undefined) process.stdout.write("", () => process.stderr.write("", () => process.exit(frame.exit)));
    }
  });
  // The simulator went away (the test ended): nothing will answer this query.
  link.on("close", () => process.exit(1));
  link.write(JSON.stringify({ start: { args, cwd: process.cwd(), env: process.env, pid: process.pid } }) + "\n");
}
const toHost = (frame) => link.write(JSON.stringify(frame) + "\n");

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  // A query's input goes to the simulator that runs it: user messages, the user's stop, the SDK's answers to the
  // CLI's requests (an MCP call of the plugin's tools). `killOnPrompt` still ends the process here, at the prompt.
  if (link && !(message.type === "user" && state.killOnPrompt)) {
    if (message.type === "user" || message.type === "control_response" || (message.type === "control_request" && message.request?.subtype === "interrupt")) {
      if (message.type === "control_request") control({ subtype: "interrupt" });
      toHost({ stdin: message });
      continue;
    }
  }
  // A turn's message: a test that started the CLI through the real SDK only reads what the SDK handed it
  // (the arguments, `initialize`); the process then waits like a model that has not started its answer,
  // and the test stops the turn as the user would — OpenCode does not repeat a stopped request.
  // `killOnPrompt`: the process is killed once it has the prompt (probes 8 and 10) — a title or a summary,
  // which OpenCode cannot stop, ends this way after the start is logged.
  if (message.type === "user" && state.killOnPrompt) process.kill(process.pid, "SIGKILL");
  if (message.type === "user") continue;
  if (message.type !== "control_request") fail(`a ${message.type} message`);
  const id = message.request_id;
  const request = message.request;
  control({ subtype: request.subtype, ...(request.model !== undefined ? { model: request.model } : {}), ...(request.detail !== undefined ? { detail: request.detail } : {}) });
  const refuse = (text, code) => send({ type: "control_response", response: { subtype: "error", request_id: id, error: text, ...(code ? { error_code: code } : {}), model } });
  // An older CLI that lacks a request answers it as 2.1.312 answers any request it does not know (the signed-out probe).
  if ((state.unsupported ?? []).includes(request.subtype)) {
    send({ type: "control_response", response: { subtype: "error", request_id: id, error: answers.unsupported.error.replace("<subtype>", request.subtype) } });
    continue;
  }
  if (request.subtype === "initialize") {
    // What the SDK hands the CLI (system prompt, hooks, MCP servers…): logged for a test of the plugin's SDK options.
    appendFileSync(join(here, "calls.jsonl"), JSON.stringify({ args, configDir, at: Date.now(), runner, initialize: request }) + "\n");
    success(id, { ...answers.initialize, models, account, claude_code_version: version, pid: process.pid });
    if (link) toHost({ initialize: request });
    continue;
  }
  if (request.subtype === "set_model") {
    const asked = String(request.model);
    const refusal = refusals[asked];
    const base = asked.replace(/\[1m\]$/i, "");
    // With an API key the API settles an id the five rows do not name (the windows probe: every probed id passed).
    const row = models.find((m) => m.value === base || m.resolvedModel === base) ?? (byKey && windows[asked] !== undefined ? { value: base } : undefined);
    // With the 1M switch on the CLI refuses some `[1m]` ids itself, before any check of the sign-in
    // (the windows probe: the same signed out and with a key); one it was not probed for is not guessed.
    if (disabled1m && /\[1m\]$/i.test(asked)) {
      const own = answers.disable1m.setModelErrors[asked];
      if (own) {
        refuse(own.error, own.error_code);
        continue;
      }
      if (!answers.disable1m.accepted1m.includes(asked)) fail(`set_model ${asked} with CLAUDE_CODE_DISABLE_1M_CONTEXT on (probe it)`);
    }
    // Signed out a row's alias passes, and so does the model it runs on (its id, also with [1m]); any other id needs
    // the API's check and is refused (the signed-out probe, a second start with the empty profile).
    if (signedOut && !models.some((m) => m.value === asked) && base !== model.replace(/\[1m\]$/i, "")) {
      refuse(answers.signedOut.setModelError.error, answers.signedOut.setModelError.error_code);
      continue;
    }
    if (refusal) {
      refuse(refusal.error, refusal.error_code);
      continue;
    }
    // The network cut (the signed-out probe "offline"): a refusal the CLI knows by itself still comes, any other check fails.
    if (state.offline && !signedOut) {
      refuse(answers.offline.setModelError.error, answers.offline.setModelError.error_code);
      continue;
    }
    if (!row) {
      send({ type: "control_response", response: { subtype: "error", request_id: id, error: `Model '${asked}' not found`, error_code: "not_found", model } });
      continue;
    }
    // The model reported: a `[1m]` of a model that runs at 1M anyway drops the suffix, one of a 200K model keeps it
    // (the live probe: "claude-opus-5-5[1m]" answers "claude-opus-5-5", "claude-opus-4-6[1m]" itself); with the 1M
    // switch on every accepted `[1m]` keeps it (the windows probe).
    const resolved = row.resolvedModel ?? row.value;
    const plainWindow = windows[resolved] ?? windows[row.value];
    const keepsSuffix = /\[1m\]$/i.test(asked) && (disabled1m || !(plainWindow >= 1_000_000));
    model = keepsSuffix ? `${resolved}[1m]` : resolved;
    windowOf.set(model, windows[asked] ?? windows[row.value] ?? windows[resolved]);
    success(id, { model });
    continue;
  }
  if (request.subtype === "interrupt") {
    // The user stopped a turn before its answer started (CLI 2.1.312 against a local stub of the API): the request is
    // confirmed, the interruption record and an `aborted_streaming` result follow, the process exits with code 1.
    success(id, {});
    send({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, parent_tool_use_id: null, session_id: "sim", uuid: crypto.randomUUID() });
    send({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", stop_reason: null, errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"], session_id: "sim", uuid: crypto.randomUUID() });
    process.exit(1);
  }
  // SDK 0.3.224 (main's lock) asks with no `detail`: CLI 2.1.312 then gives the full answer (the signed-out probe), with the
  // same keys; 0.3.300 asks `detail: "summary"`.
  if (request.subtype === "get_context_usage" && (request.detail === "summary" || request.detail === undefined)) {
    const plain = model.replace(/\[1m\]$/i, "");
    if (signedOut && !disabled1m && answers.signedOut.windows[plain] === undefined) fail(`the window of ${model} signed out (probe it)`);
    // The 1M switch: every model at 200K, whatever was asked (the windows probe).
    const window = disabled1m ? answers.disable1m.window : signedOut ? answers.signedOut.windows[plain] : (windowOf.get(model) ?? windows[model]);
    if (window === undefined) fail(`the window of ${model} (probe it)`);
    success(id, { ...(request.detail === "summary" ? answers.contextUsage : answers.contextUsageFull.response), model, maxTokens: window, rawMaxTokens: window });
    continue;
  }
  fail(`the control request ${JSON.stringify(request.subtype)}${request.detail ? ` (${request.detail})` : ""}`);
}
// The input ended: the SDK closed the process (`close()`); a killed process logs nothing here. A query the
// simulator runs ends when the simulator says (a turn still running finishes first).
control({ end: "stdin-closed" });
if (link) toHost({ end: true });
