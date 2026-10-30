/**
 * Regression: a chat whose directory changed keeps resuming its Claude
 * session instead of falling back to a text transcript.
 *
 * The CLI stores a session under ~/.claude/projects/<slug of the cwd>/, but
 * `--resume <id>` finds it from any cwd. Checked live on CLI 2.1.224 and
 * 2.1.284: resuming from another directory loaded the full history and
 * appended to the original file. Transferring history as text there would
 * only lose tool-level context and the prompt cache.
 *
 * The new directory has a non-ASCII name: the header carrying it must
 * survive fetch's Latin-1 check and reach the CLI unchanged.
 *
 * On the simulators (test/simulators/): a chat answered in the project's
 * folder, then moved by the user to another folder (OpenCode's location
 * message); its next turn is served by the plugin instance OpenCode runs for
 * that directory (`startPlugin(options, { directory })`). What Claude Code
 * got is the query's parameters, the transcript the turn wrote to.
 *
 * main's resume: the session by its id, from its last record (no
 * `resumeSessionAt`); from chain/turn-by-names a transcript named after the
 * chat is resumed at the record a turn ended on (cwd-resume-regression.ts).
 *
 * Run: bun test/cwd-resume-main-regression.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { contentText } from "./simulators/claude-code.ts";
import { createWorld } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("cwd-resume");
  const { opencode, claude } = world;
  const oldCwd = world.tmp;
  const newCwd = join(world.tmp, "新目录");
  mkdirSync(newCwd, { recursive: true });
  try {
    await opencode.startPlugin();
    const chat = opencode.newChat();
    await opencode.say(chat, "first");
    assert.ok((await opencode.turn(chat)).ok);
    const first = claude.queries.at(-1)!;
    assert.equal(first.params.cwd, oldCwd);

    // The user moves the chat to another folder: OpenCode's instance for that directory serves it now.
    await opencode.startPlugin(undefined, { directory: newCwd });
    opencode.between(chat, "location", newCwd);
    await opencode.say(chat, "second");
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `the moved chat answered: ${turn.requests.at(-1)?.status}`);
    const second = claude.queries.at(-1)!;
    const params = second.params as Record<string, unknown>;
    assert.equal(params.resume, first.name, "the moved chat resumes its session");
    assert.equal("resumeSessionAt" in params, false);
    assert.equal(second.copiedFrom, undefined, "no copy of the session");
    assert.deepEqual(readdirSync(claude.projectDir).filter((f) => f.endsWith(".jsonl")), [`${first.name}.jsonl`], "the turn appended to the original file");
    // The CLI keeps a session in the project folder of the folder it started in; the new folder's has none of it.
    const projects = dirname(claude.projectDir);
    assert.deepEqual(readdirSync(projects).filter((folder) => existsSync(join(projects, folder, `${first.name}.jsonl`))), [basename(claude.projectDir)], "one file, in the old folder's project folder");
    assert.doesNotMatch(second.input.map((m) => contentText(m.content)).join("\n"), /<conversation_history>/);
    assert.ok(claude.records(first.name).some((r) => r.type === "user" && contentText(r.message?.content).includes("second")));
    assert.equal(params.cwd, newCwd, `the turn runs in the new folder, its name intact: ${String(params.cwd)}`);
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — cwd resume regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
