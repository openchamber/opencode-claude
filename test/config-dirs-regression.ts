/**
 * Regression: the `configDirs` option runs a project on another Claude
 * account. Claude Code keeps one login per CLAUDE_CONFIG_DIR; a mapped
 * project's turns run with that directory, resume sessions from it, and keep
 * their own plan check and rate limits, while other projects stay on the
 * server's default account.
 *
 * On the simulators (test/simulators/): the plugin started in OpenCode with
 * and without the option for the project's folder (the user maps the
 * project, or not); the profile a turn runs with is the query's
 * `env.CLAUDE_CONFIG_DIR`, the profile a sign-in check ran with is the CLI
 * process's (`claude.cli.calls()`); each profile keeps its own transcripts
 * (`claude.filesIn`) and its own sign-in (`claude.cli.set({ authByConfigDir
 * })`). `configDirForDirectory` is a pure function of config-dir.ts; the
 * rate-limit gate is read and fed through rate-limit.ts. The old test's
 * paths were POSIX ("/src/work"); they are compared resolved here, so the
 * block runs on Windows too.
 *
 * main's resume: the session by its id (no `resumeSessionAt`); from
 * chain/turn-by-names a transcript named after the chat, resumed at the
 * record a turn ended on (config-dirs-regression.ts).
 *
 * Run: bun test/config-dirs-main-regression.ts
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { contentText } from "./simulators/claude-code.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("config-dirs");
  const { opencode, claude } = world;
  const { configDirForDirectory } = await pluginModule("config-dir");
  const { rateLimitGate, recordRateLimitErrorText } = await pluginModule("rate-limit");

  const map = { "/src/work": "/cfg/work", "/src/work/client": "/cfg/client" };
  assert.equal(configDirForDirectory(map, "/src/work"), resolve("/cfg/work"));
  assert.equal(configDirForDirectory(map, "/src/work/app"), resolve("/cfg/work"));
  assert.equal(configDirForDirectory(map, "/src/work/client/app"), resolve("/cfg/client"), "deepest folder wins");
  assert.equal(configDirForDirectory(map, "/src/work-other"), undefined, "a sibling with the same prefix is not inside");
  assert.equal(configDirForDirectory(map, "/src/home"), undefined);
  assert.equal(configDirForDirectory({ "~/work": "~/.claude-work" }, join(homedir(), "work", "app")), join(homedir(), ".claude-work"));
  assert.equal(configDirForDirectory({ "/src/work": 42 }, "/src/work"), undefined);
  assert.equal(configDirForDirectory(undefined, "/src/work"), undefined);

  const defaultConfig = process.env.CLAUDE_CONFIG_DIR!;
  const workConfig = join(world.tmp, "claude-work");
  const clientConfig = join(world.tmp, "claude-client");
  for (const dir of [workConfig, clientConfig]) mkdirSync(dir, { recursive: true });
  /** The plugin as OpenCode loads it for the project (world.tmp), mapped to `configDir` or not. */
  let instance: Awaited<ReturnType<typeof opencode.startPlugin>> | undefined;
  const restart = async (configDir?: string) => {
    if (instance) await opencode.stopPlugin(instance);
    instance = await opencode.startPlugin(configDir ? { configDirs: { [world.tmp]: configDir } } : undefined);
  };
  const turnIn = async (chat: string, text: string) => {
    await opencode.say(chat, text);
    const turn = await opencode.turn(chat);
    const query = claude.queries.at(-1)!;
    return { turn, query, params: query.params as Record<string, any>, prompt: query.input.map((m) => contentText(m.content)).join("\n") };
  };

  try {
    // Mapped project: its account's config dir, for the turn and for the plan check.
    await restart(workConfig);
    const work = opencode.newChat();
    const first = await turnIn(work, "first");
    assert.ok(first.turn.ok, `the mapped turn answered: ${first.turn.requests.at(-1)?.status}`);
    assert.equal(first.params.env.CLAUDE_CONFIG_DIR, workConfig);
    assert.ok(
      claude.cli.calls().some((call) => call.args[0] === "auth" && call.configDir === workConfig),
      `the plan check asked the mapped account's login: ${JSON.stringify(claude.cli.calls().map((c) => [c.args.join(" "), c.configDir]))}`,
    );

    // One account's limit does not block the other.
    recordRateLimitErrorText("You've hit your 5-hour limit · resets 11pm (UTC)", workConfig);
    assert.equal(rateLimitGate(Date.now(), workConfig).blocked, true);
    assert.equal(rateLimitGate(Date.now()).blocked, false);

    // Unmapped: the server's default account, and its turns still run.
    await restart();
    const home = opencode.newChat();
    const homeTurn = await turnIn(home, "hello");
    assert.ok(homeTurn.turn.ok, `the default account is not blocked: ${homeTurn.turn.requests.at(-1)?.status}`);
    assert.equal(homeTurn.params.env.CLAUDE_CONFIG_DIR, defaultConfig);

    // The mapped chat resumes its session from its account's config dir.
    await restart(workConfig);
    const second = await turnIn(work, "second");
    assert.ok(second.turn.ok);
    assert.equal(second.params.env.CLAUDE_CONFIG_DIR, workConfig);
    assert.ok(claude.filesIn(join(workConfig, "projects")).records(first.query.name).length > 0, "Claude Code kept the mapped chat's session under its profile");
    assert.equal(claude.records(first.query.name).length, 0, "and not under the default one");
    assert.equal(second.params.resume, first.query.name, "the mapped chat resumes its session");
    assert.doesNotMatch(second.prompt, /<conversation_history>/);

    // The same chat unmapped: the default account has no such session, so the history goes over as text.
    await restart();
    const third = await turnIn(work, "third");
    assert.ok(third.turn.ok);
    assert.equal(third.params.env.CLAUDE_CONFIG_DIR, defaultConfig);
    assert.equal(third.params.resume, undefined);
    assert.match(third.prompt, /<conversation_history>/);

    // The plan check asks the mapped account's own login: signed in with an API key there.
    claude.cli.set({ authByConfigDir: { [clientConfig]: "apiKey" } });
    await restart(clientConfig);
    const client = opencode.newChat();
    const refused = await turnIn(client, "hi");
    assert.equal(refused.turn.requests[0]?.status, 401, `the API-key account is refused: ${refused.turn.requests[0]?.reply?.raw ?? refused.turn.requests[0]?.status}`);
    await restart();
    const homeAgain = await turnIn(opencode.newChat(), "hi");
    assert.ok(homeAgain.turn.ok, "the default account still answers");
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — config dirs regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
