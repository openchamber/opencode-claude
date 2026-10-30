/**
 * Regression: a chat whose directory changed keeps resuming its Claude
 * transcript instead of falling back to a text transcript.
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
 * got is the query's parameters, the transcript the turn wrote to; where
 * the first turn ended there is the transcript's last chain record right
 * after it (`claude.leafOf`); the second question's record (named after its
 * OpenCode id, names.ts userRecordName) continues it — on
 * chain/record-per-message through the location message's own record
 * without a turn.
 *
 * Run: bun test/cwd-resume-regression.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { contentText } from "./simulators/claude-code.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("cwd-resume");
  const { opencode, claude } = world;
  const names = await pluginModule("names");
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
    // Where the first turn ended: the transcript's last chain record right after it.
    const endOfFirst = claude.leafOf(first.name)!.uuid;

    // The user moves the chat to another folder: OpenCode's instance for that directory serves it now.
    await opencode.startPlugin(undefined, { directory: newCwd });
    opencode.between(chat, "location", newCwd);
    const secondId = await opencode.say(chat, "second");
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `the moved chat answered: ${turn.requests.at(-1)?.status}`);
    const second = claude.queries.at(-1)!;
    const params = second.params as Record<string, unknown>;
    assert.equal(first.name, names.transcriptName(chat, names.FIRST_EPOCH, 1), "the chat's transcript is named after it");
    assert.equal(params.resume, first.name, "the moved chat resumes its transcript, found under the old directory's slug");
    const question = claude.records(first.name).find((r) => r.uuid === names.userRecordName(secondId, 1));
    assert.ok(question, "the second question's record is named after it");
    assert.equal(params.resumeSessionAt, endOfFirst, "resumed at the end of the first turn");
    // The question's record continues the first turn (on chain/record-per-message through the location
    // message's own record without a turn).
    assert.ok(claude.chainTo(first.name, question.uuid!).some((r) => r.uuid === endOfFirst), "the question continues the first turn");
    assert.equal(second.copiedFrom, undefined, "no copy of the session");
    assert.deepEqual(readdirSync(claude.projectDir).filter((f) => f.endsWith(".jsonl")), [`${first.name}.jsonl`], "the turn appended to the original file");
    // The CLI keeps a session in the project folder of the folder it started in; the new folder's has none of it.
    const projects = dirname(claude.projectDir);
    assert.deepEqual(readdirSync(projects).filter((folder) => existsSync(join(projects, folder, `${first.name}.jsonl`))), [basename(claude.projectDir)], "one file, in the old folder's project folder");
    assert.doesNotMatch(second.input.map((m) => contentText(m.content)).join("\n"), /<conversation_history>|serialized record of this conversation/, "no history as text");
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
