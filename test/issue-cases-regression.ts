/**
 * The cases of the issue "Session identity from OpenCode message ids instead
 * of text fingerprints", each written as the behavior it should have. On
 * `main` (the record file `sessions.json` and text fingerprints) they fail:
 * 1a. revert, then the same text again (fingerprints cannot tell the two
 *     "value A" apart); 1b and 1c: two different screenshots with one
 *     fingerprint (an image counts by presence only, its text does not
 *     change);
 * 2a. a fork's first turn (no entry in the record file); 2b: the fork of a
 *     chat about a screenshot loses the screenshot with the text transfer;
 * 3. a revert of a Claude turn that followed another model's turn (the
 *    record file holds boundaries of Claude's turns only);
 * 4. a revert to a message before OpenCode's compaction (the summary drops
 *    the chat's record);
 * 5a. the record file emptied by a crash (one file, rewritten whole, for
 *     every chat; a server killed during the rewrite leaves it empty). 5b,
 *     two servers sharing it: issue-two-servers-regression.ts.
 * Minor remarks after the cases are printed, not counted: a retry of a new
 * chat's first message after the API was overloaded (main leaves a
 * transcript of that one message behind).
 * 3 and 4 main could patch on its own (a boundary before every turn and
 * the missed turns on a rewind; boundaries kept across a summary); with
 * names they need no rule of their own: the point is the last record of
 * the screen's messages, wherever the revert lands.
 *
 * On the simulators (test/simulators/): what the user does in OpenCode, and
 * what Claude then saw (the transcript's chain down to where the turn
 * continued, then the prompt) and whether the turn continued a transcript
 * or started one with the history as text; 5a in other servers on the same
 * machine (`world.secondProcess` with `killAtWrite`, then the next server on
 * the killed one's database). The same file runs on any tree of the plugin:
 * on main the cases fail, on the series they pass.
 *
 * Run: bun test/issue-cases-regression.ts
 *      $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>"; bun test/issue-cases-regression.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

// Real PNGs: OpenCode takes an attachment's type from its bytes.
const IMAGE_A = testPng("screenshot A");
const IMAGE_B = testPng("screenshot B");
const png = (data: string) => [{ mediaType: "image/png", data }];

async function main() {
  const world = await createWorld("issue-cases");
  const { opencode, claude } = world;
  await opencode.startPlugin();

  const lastChat = () => claude.queries.filter((q) => q.kind === "chat").at(-1)!;
  /** A turn of `chat`: its answer, what Claude saw, and whether it continued a transcript. */
  const turn = async (chat: string) => {
    const result = await opencode.turn(chat);
    const query = lastChat();
    return { ok: result.ok, answer: result.answer?.text ?? "", view: query.view, continued: query.at !== null };
  };

  const cases = testCases();
  const check = (name: string, run: () => Promise<void>) => cases.run(name, run);

  /** A minor remark: printed with its outcome on this tree; it does not decide the exit code. */
  const remark = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      console.log(`remark, holds on this tree: ${name}`);
    } catch (err) {
      console.log(`remark, does not hold on this tree: ${name}\n  ${err instanceof Error ? err.message.split("\n").join("\n  ") : err}`);
    }
  };

  try {
    // 1a. Revert, then the same text again. Claude answered "value A"; the user
    // reverts it and asks "value A" again, answered by another provider; then
    // Claude gets the next message. Claude must not see its undone answer,
    // and must see the other provider's answer on the screen.
    await check("1a. revert, then the same text again: Claude does not continue from its undone answer", async () => {
      const chat = opencode.newChat();
      const asked = await opencode.say(chat, "value A");
      const first = await turn(chat);
      assert.ok(first.ok);
      opencode.undoBefore(chat, asked);
      await opencode.say(chat, "value A");
      opencode.otherModelAnswer(chat, "the other provider's answer");
      await opencode.say(chat, "and now?");
      const next = await turn(chat);
      assert.ok(next.ok);
      assert.ok(!next.view.includes(first.answer), `the model saw its undone answer "${first.answer}":\n${next.view}`);
      assert.ok(next.view.includes("the other provider's answer"), `the model did not see the answer on the screen:\n${next.view}`);
    });

    // 1b. A screenshot with no text. Claude answered screenshot A; the user
    // reverts it, pastes screenshot B and sends it to another model; then
    // asks Claude about it. Claude must see B, not the undone A.
    await check("1b. revert, then another screenshot with no text: Claude sees the new screenshot", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "hello");
      await turn(chat);
      const shot = await opencode.say(chat, "", png(IMAGE_A));
      const first = await turn(chat);
      opencode.undoBefore(chat, shot);
      await opencode.say(chat, "", png(IMAGE_B));
      opencode.otherModelAnswer(chat, "the other provider's answer");
      await opencode.say(chat, "what was on it?");
      const next = await turn(chat);
      assert.ok(next.ok);
      assert.ok(!next.view.includes(IMAGE_A) && !next.view.includes(first.answer), `the model saw the undone screenshot A and its answer "${first.answer}":\n${next.view}`);
      assert.ok(next.view.includes("the other provider's answer"), `the model did not see the answer on the screen:\n${next.view}`);
      assert.ok(next.view.includes(IMAGE_B), `the model did not see screenshot B:\n${next.view}`);
    });

    // 1c. The same words with another screenshot: "fix this" and screenshot A
    // to Claude; revert; "fix this" and screenshot B to another model; then
    // Claude. Only the text goes into the fingerprint.
    await check("1c. revert, then the same words with another screenshot: Claude sees the new screenshot", async () => {
      const chat = opencode.newChat();
      const asked = await opencode.say(chat, "fix this", png(IMAGE_A));
      const first = await turn(chat);
      opencode.undoBefore(chat, asked);
      await opencode.say(chat, "fix this", png(IMAGE_B));
      opencode.otherModelAnswer(chat, "the other provider's answer");
      await opencode.say(chat, "and now?");
      const next = await turn(chat);
      assert.ok(next.ok);
      assert.ok(!next.view.includes(IMAGE_A) && !next.view.includes(first.answer), `the model saw the undone screenshot A and its answer "${first.answer}":\n${next.view}`);
      assert.ok(next.view.includes("the other provider's answer"), `the model did not see the answer on the screen:\n${next.view}`);
      assert.ok(next.view.includes(IMAGE_B), `the model did not see screenshot B:\n${next.view}`);
    });

    // 2a. A fork's first turn. OpenCode copies the parent's messages into a new
    // chat; its first turn on Claude must read that history from the parent's
    // transcript (a copy of it), not send it again as text.
    await check("2a. a fork's first turn reads its history from the parent's transcript, not as text", async () => {
      const parent = opencode.newChat();
      await opencode.say(parent, "parent question");
      await turn(parent);
      await opencode.say(parent, "second");
      await turn(parent);
      const fork = await opencode.fork(parent, opencode.through(opencode.lastId(parent)));
      await opencode.say(fork, "in the fork");
      const first = await turn(fork);
      assert.ok(first.ok);
      assert.ok(first.continued, `the fork's first turn started a transcript with the history as text:\n${first.view.slice(0, 400)}`);
    });

    // 2b. A fork of a chat about a screenshot: the fork's Claude must still
    // see the screenshot the parent's Claude answered about.
    await check("2b. a fork of a chat about a screenshot still shows Claude the screenshot", async () => {
      const parent = opencode.newChat();
      await opencode.say(parent, "what is on this screenshot?", png(IMAGE_A));
      await turn(parent);
      const fork = await opencode.fork(parent, opencode.through(opencode.lastId(parent)));
      await opencode.say(fork, "and the colour?");
      const first = await turn(fork);
      assert.ok(first.ok);
      assert.ok(first.view.includes(IMAGE_A), `the fork's Claude did not see the screenshot:\n${first.view.slice(0, 600)}`);
    });

    // 3. A revert of a Claude turn that followed another model's turn. Claude
    // answered "A", another model "B", Claude "C" (B reached it as missed);
    // the user reverts "C" and sends "D". Claude's transcript holds A, its
    // answer and B: the turn continues it, it does not send the history again.
    await check("3. a revert of a Claude turn after another model's turn continues Claude's transcript", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "A");
      await turn(chat);
      await opencode.say(chat, "B");
      opencode.otherModelAnswer(chat, "the other provider's answer");
      const c = await opencode.say(chat, "C");
      await turn(chat);
      opencode.undoBefore(chat, c);
      await opencode.say(chat, "D");
      const d = await turn(chat);
      assert.ok(d.ok);
      assert.ok(d.continued, `the turn after the revert started a transcript with the history as text:\n${d.view.slice(0, 500)}`);
    });

    // 4. A revert to a message before OpenCode's compaction. Claude answered
    // "A" and "B", the chat was compacted, Claude answered "C"; the user
    // reverts "B" (the revert removes the compaction) and sends "B2". The
    // first Claude transcript still holds "A" and its answer.
    await check("4. a revert to before OpenCode's compaction continues the transcript that holds that part", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "A");
      await turn(chat);
      const b = await opencode.say(chat, "B");
      await turn(chat);
      await opencode.compact(chat);
      await opencode.say(chat, "C");
      await turn(chat);
      opencode.undoBefore(chat, b);
      await opencode.say(chat, "B2");
      const b2 = await turn(chat);
      assert.ok(b2.ok);
      assert.ok(b2.continued, `the turn after the revert started a transcript with the history as text:\n${b2.view.slice(0, 500)}`);
    });

    // 5a. The record file emptied by a crash. The OpenCode server was killed
    // while the plugin rewrote sessions.json (main rewrites it whole, on every
    // streamed event of every chat): a kill during the rewrite leaves the file
    // empty (BEHAVIOR.md "A server killed while it rewrites a file"). Other
    // chats keep their Claude transcripts in the next server. A plugin
    // without the file has nothing to empty: its server answers and exits.
    await check("5a. a sessions.json emptied by a crash loses no other chat's transcript", async () => {
      const store = join(process.env.XDG_DATA_HOME!, "opencode-claude", "sessions.json");
      const killed = await world.secondProcess({ label: "killed" });
      let next: Awaited<ReturnType<typeof world.secondProcess>> | undefined;
      try {
        await killed.start();
        for (const [chat, text] of [["crash-a", "chat A"], ["crash-b", "chat B"]] as const) {
          await killed.call("opencode.newChat", chat);
          await killed.call("opencode.say", chat, text);
          assert.ok((await killed.call("opencode.turn", chat)).ok, `${text} answered`);
        }
        await killed.call("opencode.say", "crash-b", "chat B again");
        let database = await killed.call("opencode.database");
        await killed.killAtWrite("sessions.json");
        const ended = await killed.call("opencode.turn", "crash-b").then(
          () => "answered",
          (error: Error) => error.message,
        );
        if (ended === "answered") {
          database = await killed.call("opencode.database");
          await killed.exit();
        } else {
          assert.match(ended, /the second process ended/, "the server died while it rewrote sessions.json");
          assert.equal(existsSync(store) ? readFileSync(store, "utf8") : "", "", "the kill left sessions.json empty");
        }
        // The next server on the killed one's database: chat A's next message.
        next = await world.secondProcess({ label: "next" });
        await next.call("opencode.openDatabase", database);
        await next.start();
        await next.call("opencode.say", "crash-a", "chat A again");
        assert.ok((await next.call("opencode.turn", "crash-a")).ok, "chat A answered");
        const again = await next.call("claude.queries.at", -1);
        assert.ok(again.at !== null, `chat A lost its Claude transcript and sent its history as text:\n${String(again.view).slice(0, 300)}`);
      } finally {
        await killed.kill();
        await next?.kill();
      }
    });

    // Minor remarks: small things seen along the way, not cases of the issue; printed, not counted.
    // A first message whose model call fails after Claude Code's own retries (529): OpenCode sends it again;
    // on main the retry starts another transcript and leaves the one with the failed attempt (it holds that
    // one message), on the series the retry continues the same transcript.
    await remark("a retry of a new chat's first message after 529 continues the same transcript", async () => {
      const chat = opencode.newChat();
      await opencode.say(chat, "first message");
      claude.state.failures = ["overloaded"];
      const before = claude.queries.length;
      const result = await opencode.turn(chat);
      assert.ok(result.ok, "OpenCode's retry answered");
      const names = new Set(claude.queries.slice(before).map((q) => q.name));
      assert.equal(names.size, 1, `the retry went to another transcript: ${[...names].join(", ")}`);
    });
  } finally {
    await world.dispose();
  }

  console.log(`\nplugin tree: ${world.dir}`);
  cases.done();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
