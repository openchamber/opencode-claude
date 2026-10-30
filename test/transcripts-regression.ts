/**
 * Regression: a chat's transcripts are found by name in every project folder
 * of the Claude account (src/transcripts.ts). The folders are listed once per
 * lookup and every version's name is looked for in them: versions of one chat
 * written from different directories (the chat moved) are all found, the
 * highest with records is the usable one, and the free name comes after all.
 * A version the CLI refused is not continued, nor any older one: the chat
 * moves to the free name. A Claude profile with no projects folder yet holds
 * no transcript and is no error.
 *
 * On the simulators (test/simulators/): chats in OpenCode; the transcript a
 * turn continues is the query's `resume`, a new one its `sessionId`. A
 * project mapped to a fresh Claude profile (`configDirs`) has no projects
 * folder before its first turn. A new version follows a transcript the CLI
 * could not load (its file deleted under the CLI while the query's start is
 * held, `state.holdStart`). Versions in several project folders: the user
 * moves the chat to another folder (OpenCode's location message, an instance
 * for that directory), a revert there copies the transcript into the new
 * folder's project folder (the CLI files a copy by the working folder of its
 * query), a move back and another revert, another copy in the first folder.
 *
 * Run: bun test/transcripts-regression.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { projectFolderName } from "./simulators/claude-code.ts";
import { testCases } from "./simulators/cases.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("transcripts");
  const { opencode, claude } = world;
  const { FIRST_EPOCH, transcriptName } = await pluginModule("names");
  const cases = testCases();
  const ask = async (chat: string, text: string) => {
    await opencode.say(chat, text);
    const from = claude.queries.length;
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `${text}: ${turn.requests.map((r) => r.status).join(",")}`);
    return claude.queries.slice(from);
  };
  /** A turn whose transcript file is deleted under the CLI as its query starts: OpenCode's retry answers. */
  const askLosing = async (chat: string, text: string) => {
    await opencode.say(chat, text);
    // The chat's last turn was the last query: its transcript is the one the next turn continues.
    const lost = claude.queries.at(-1)!.name;
    let release!: () => void;
    const held = claude.heldStarts;
    claude.state.holdStart = new Promise<void>((resolve) => (release = resolve));
    const from = claude.queries.length;
    const turning = opencode.turn(chat);
    for (let waited = 0; claude.heldStarts === held; waited += 10) {
      if (waited > 5_000) throw new Error("the query did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    rmSync(claude.fileOf(lost));
    release();
    const turn = await turning;
    assert.ok(turn.ok, `${text}: ${turn.requests.map((r) => r.status).join(",")}`);
    return claude.queries.slice(from);
  };
  const projects = dirname(claude.projectDir);
  /** The project folders holding the file of `name`. */
  const foldersOf = (name: string) =>
    [world.tmp, ...extraFolders].map(projectFolderName).filter((folder, i, all) => all.indexOf(folder) === i && existsSync(join(projects, folder, `${name}.jsonl`)));
  const extraFolders: string[] = [];
  const instances: Awaited<ReturnType<typeof opencode.startPlugin>>[] = [];
  try {
    await cases.run("a profile with no projects folder: the first turn starts the transcript there, the next finds it", async () => {
      const fresh = join(world.tmp, "claude-fresh");
      mkdirSync(fresh, { recursive: true });
      const instance = await opencode.startPlugin({ configDirs: { [world.tmp]: fresh } });
      try {
        assert.ok(!existsSync(join(fresh, "projects")), "the profile has no projects folder");
        const chat = opencode.newChat();
        const [first] = await ask(chat, "hello");
        assert.deepEqual([first!.params.resume, first!.params.sessionId], [undefined, transcriptName(chat, FIRST_EPOCH, 1)]);
        assert.ok(
          world.journal().some((line) => line.includes("starting a new Claude transcript") && line.includes(`"conversationKey":"${chat}"`) && line.includes("no transcript of this chat in this epoch")),
          "nothing found, a new transcript",
        );
        const [second] = await ask(chat, "again");
        assert.equal(second!.params.resume, transcriptName(chat, FIRST_EPOCH, 1), "the transcript is found in the new folder");
      } finally {
        await opencode.stopPlugin(instance);
      }
    });

    instances.push(await opencode.startPlugin());

    await cases.run("each transcript the CLI could not load moves the chat to the next version, the chat continues in the highest", async () => {
      const chat = opencode.newChat();
      await ask(chat, "hi");
      const [, toTwo] = await askLosing(chat, "LOST-ONE");
      assert.equal(toTwo!.params.sessionId, transcriptName(chat, FIRST_EPOCH, 2));
      const [, toThree] = await askLosing(chat, "LOST-TWO");
      assert.equal(toThree!.params.sessionId, transcriptName(chat, FIRST_EPOCH, 3));
      const [next] = await ask(chat, "go on");
      assert.equal(next!.params.resume, transcriptName(chat, FIRST_EPOCH, 3), "the chat continues in the highest version");
    });

    await cases.run("versions in several project folders: all found, the chat continues in the highest, the free name comes after all", async () => {
      const here = world.tmp;
      const there = join(world.tmp, "elsewhere");
      mkdirSync(there, { recursive: true });
      extraFolders.push(there);
      const name = (version: number) => transcriptName(chat, FIRST_EPOCH, version);
      const chat = opencode.newChat();
      await ask(chat, "a1");
      assert.deepEqual(foldersOf(name(1)), [projectFolderName(here)], "version 1 in the first folder's project folder");

      // The user moves the chat: the turn continues version 1, in its folder.
      instances.push(await opencode.startPlugin(undefined, { directory: there }));
      opencode.between(chat, "location", there);
      const [moved] = await ask(chat, "b1");
      assert.equal(moved!.params.resume, name(1), "the moved chat continues its transcript");
      assert.equal(moved!.params.cwd, there);
      // The CLI loses version 1 there: version 2 starts, filed by the new folder.
      const [refusedOne, two] = await askLosing(chat, "LOST-THERE");
      assert.equal(refusedOne!.outcome, "refused: no conversation");
      assert.equal(two!.params.sessionId, name(2));
      assert.deepEqual(foldersOf(name(2)), [projectFolderName(there)], "version 2 in the second folder's project folder");

      // Back in the first folder: version 2 is found in the other project folder.
      opencode.between(chat, "location", here);
      const [back] = await ask(chat, "a2");
      assert.equal(back!.params.resume, name(2), "version 2 is continued from the first folder");
      // The CLI loses version 2 here: version 3, filed by the first folder.
      const [, three] = await askLosing(chat, "LOST-HERE");
      assert.equal(three!.params.sessionId, name(3));
      assert.deepEqual(foldersOf(name(3)), [projectFolderName(here)], "version 3 in the first folder's project folder");

      // In the second folder again: the highest version is found across the folders.
      opencode.between(chat, "location", there);
      const [next] = await ask(chat, "b3");
      assert.equal(next!.params.resume, name(3), "the chat continues in the highest version, from the other folder");
      // The CLI refuses version 3: no older version is continued, the chat moves to the free name after all.
      const [refused, fresh] = await askLosing(chat, "LOST-AGAIN");
      assert.equal(refused!.outcome, "refused: no conversation");
      assert.equal(fresh!.params.resume, undefined, "no older version is continued");
      assert.equal(fresh!.params.sessionId, name(4), "the free name comes after every version");
      assert.deepEqual(foldersOf(name(4)), [projectFolderName(there)]);
    });

    await cases.run("a revert after the chat moved: the next turn continues the transcript the revert ran on, in whichever project folder", async () => {
      const here = world.tmp;
      const there = join(world.tmp, "elsewhere");
      const chat = opencode.newChat();
      await ask(chat, "r1");
      opencode.between(chat, "location", there);
      const r2 = await opencode.say(chat, "r2");
      assert.ok((await opencode.turn(chat)).ok);
      opencode.undoBefore(chat, r2);
      const [reverted] = await ask(chat, "r2-again");
      assert.equal(reverted!.params.cwd, there);
      const folders = foldersOf(reverted!.name);
      // A copy is a new session: the CLI files it by its query's working folder; a continued file stays where it is.
      const expected = reverted!.copiedFrom ? projectFolderName(there) : projectFolderName(here);
      assert.deepEqual(folders, [expected], `the transcript the revert ran on${reverted!.copiedFrom ? " (a copy)" : ""}`);
      opencode.between(chat, "location", here);
      const [next] = await ask(chat, "r3");
      assert.equal(next!.params.resume, reverted!.name, "the next turn, from the first folder, continues it");
    });

    await cases.run("a compaction opens the next epoch's transcript; an instruction update ahead, an echoed checkpoint, a user text with the tag open none", async () => {
      const { epochOfCheckpoint, checkpointText } = await pluginModule("names");
      const last = () => claude.queries.filter((query) => query.kind === "chat").at(-1)!;
      const chat = opencode.newChat();
      await ask(chat, "e1");
      assert.equal(last().name, transcriptName(chat, FIRST_EPOCH, 1));
      await ask(chat, "e2");
      const compaction = await opencode.compact(chat);
      assert.equal(compaction.status, "completed", JSON.stringify(compaction.error ?? ""));
      const kept = opencode.session(chat).messages.findLast((m) => m.type === "compaction")!;
      const epoch = epochOfCheckpoint(checkpointText(kept.summary!, kept.recent));
      opencode.between(chat, "system", "rules changed");
      const [after] = await ask(chat, "e3");
      assert.equal(after!.params.sessionId, transcriptName(chat, epoch, 1), "the turn after the compaction starts the next epoch's transcript");
      // The checkpoint's text as another model's answer: the same epoch goes on.
      await opencode.say(chat, "repeat the checkpoint");
      opencode.otherModelAnswer(chat, checkpointText(kept.summary!, kept.recent));
      await ask(chat, "e4");
      assert.equal(last().name, transcriptName(chat, epoch, 1), "the echoed checkpoint opens no epoch");
      const tagged = opencode.newChat();
      await ask(tagged, "<conversation-checkpoint>\nnot closed, so not a checkpoint");
      assert.equal(last().name, transcriptName(tagged, FIRST_EPOCH, 1), "a user text with the tag opens no epoch");
    });

    await cases.run("no other error in the plugin's journal", () => {
      const errors = world.journal().filter((line) => /level=error/.test(line));
      assert.deepEqual(errors.filter((line) => !/No conversation found/.test(line)), []);
    });
  } finally {
    for (const instance of instances) await opencode.stopPlugin(instance).catch(() => {});
    await world.dispose();
  }
  cases.done();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
