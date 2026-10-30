/**
 * Regression: reverting or editing in OpenCode rewinds the Claude session
 * instead of resuming a history OpenCode no longer has.
 * - History back at an earlier turn → a fork cut at that turn's leaf,
 *   resumed plainly. Boundaries from before a fork are dropped; going back
 *   to one transfers the history.
 * - History that matches no turn → binding dropped, history transferred.
 * - Normal flows never misfire: follow-ups, a retried request, a model
 *   switch, tool-result continuations, steering, a rebuilt tool step, Plan
 *   mode reminders, a tool's image, a turn another model answered, title
 *   requests. The history is counted by the user's own messages.
 *
 * On the simulators (test/simulators/): a revert or an edit is the user's
 * (`undoBefore`, then a new message); main forks through the SDK's own
 * `forkSession` on the files Claude Code wrote, and the copy's records name
 * the record they were cut at (`forkedFrom`). A retried request is OpenCode
 * retrying a failed one: a Claude Code process that did not start
 * (`state.failures` "spawn": nothing written), or a model call that failed
 * after the CLI wrote the prompt (`overloaded`). A transcript gone is the
 * user pruning Claude's projects folder. A history that matches no turn is a
 * chat another model compacted (`compactElsewhere`). A rebuilt tool step is a
 * tool that ran longer than the parked turn's TTL (a tool output that is a
 * promise: OpenCode sends the results once it settled).
 * A tool's image is OpenCode's text-less message after the results
 * (`toolFiles`); another model's turn `otherModelAnswer`. The boundaries are
 * read from main's record of the chat (`session-store`), a rewind from the
 * plugin's journal.
 *
 * Run: bun test/revert-edit-main-regression.ts
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { testPng } from "./simulators/opencode.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("revert-edit");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    const store = await pluginModule("session-store");

    const chat = opencode.newChat();
    const forks = () =>
      world.journal().filter((line) => line.includes("resuming a fork of the Claude session")).map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { from: string; fork: string });
    /** The fork the latest turn made: `<source>@<the record it was cut at>`, from the copy's `forkedFrom`. */
    const forkOf = (fork: string) => {
      const cut = claude.records(fork).filter((r) => r.forkedFrom).at(-1)!.forkedFrom as { sessionId: string; messageUuid: string };
      return `${cut.sessionId}@${cut.messageUuid}`;
    };
    /** The record a fork's copy of `uuid` got. */
    const copyOf = (fork: string, uuid: string) => claude.records(fork).find((r) => r.forkedFrom?.messageUuid === uuid)!.uuid!;
    const where = () => (store.getSessionTurns(chat) as Array<{ sessionId?: string; leafUuid?: string }>).map((t) => `${t.sessionId}:${t.leafUuid}`);
    const leaves = () => (store.getSessionTurns(chat) as Array<{ leafUuid?: string }>).map((t) => t.leafUuid);
    /** How many of the user's messages each boundary's history holds (the plugin's count of the history). */
    const counts = () => (store.getSessionTurns(chat) as Array<{ count: number }>).map((t) => t.count);
    /** The boundaries the plugin went back to, from its journal: the index of each. */
    const wentBack = () =>
      world.journal().filter((line) => line.includes("OpenCode history went back; resuming from an earlier turn")).map((line) => (JSON.parse(line.slice(line.indexOf("{"))) as { turn: number }).turn);
    /** The user sends `text` and the turn answers: what the turn's last query resumed, the fork it made, whether the history went as text. */
    const send = async (text: string, options: Parameters<typeof opencode.turn>[1] = {}) => {
      const id = await opencode.say(chat, text);
      const forksBefore = forks().length;
      const turn = await opencode.turn(chat, options);
      assert.ok(turn.ok, `${text}: ${turn.requests.map((r) => r.status).join(",")}`);
      const query = claude.queries.filter((q) => q.kind === "chat").at(-1)!;
      assert.equal("resumeSessionAt" in query.params, false);
      const made = forks().slice(forksBefore);
      assert.ok(made.length <= 1, `one fork at most: ${JSON.stringify(made)}`);
      return {
        id,
        turn,
        query,
        leaf: store.getSessionLeafUuid(chat) as string,
        // Transferred: this query's prompt carries the history (not a resumed record of an earlier one).
        r: { resume: query.params.resume, fork: made[0] ? forkOf(made[0].fork) : undefined, transferred: JSON.stringify(query.input.map((i) => i.content)).includes("<conversation_history>") },
      };
    };
    const lines = (view: string) => view.split("\n");

    // Three turns build the session; each resumes it as is.
    const t1 = await send("Q-one");
    assert.equal(t1.r.resume, undefined);
    const first = store.getForeignSessionId(chat) as string;
    const t2 = await send("Q-two");
    assert.deepEqual(t2.r, { resume: first, fork: undefined, transferred: false });
    const t3 = await send("Q-three");
    assert.deepEqual(t3.r, { resume: first, fork: undefined, transferred: false });
    assert.deepEqual(leaves(), [t1.leaf, t2.leaf, t3.leaf]);
    // The history is counted by the user's messages alone; the answers between them do not count.
    assert.deepEqual(counts(), [1, 2, 3]);

    // Revert of the last turn, new prompt → a fork cut at the second turn's
    // leaf. The undone turn descends from it, so a plain resume would bring it back.
    opencode.undoBefore(chat, t3.id);
    const t3b = await send("R-three");
    const fork1 = t3b.r.resume as string;
    assert.deepEqual(t3b.r, { resume: fork1, fork: `${first}@${t2.leaf}`, transferred: false });
    assert.deepEqual(wentBack(), [1], "the history ends at the second boundary");
    assert.deepEqual(counts(), [1, 2, 3]);
    assert.ok(!lines(t3b.query.view).includes("Q-three"), `Claude still sees the undone message: ${t3b.query.view}`);
    assert.equal(store.getForeignSessionId(chat), fork1);
    // The current boundary moves to the fork's copy of that leaf; the older
    // one keeps pointing into the first session.
    assert.deepEqual(where(), [`${first}:${t1.leaf}`, `${fork1}:${copyOf(fork1, t2.leaf)}`, `${fork1}:${t3b.leaf}`]);

    // Normal follow-up after the rewind resumes the fork as is.
    const t4 = await send("Q-four");
    assert.deepEqual(t4.r, { resume: fork1, fork: undefined, transferred: false });

    // Back one turn inside the fork → fork of the fork, cut at R-three's leaf.
    opencode.undoBefore(chat, t4.id);
    const t4b = await send("R-four");
    const fork2 = t4b.r.resume as string;
    assert.deepEqual(t4b.r, { resume: fork2, fork: `${fork1}@${t3b.leaf}`, transferred: false });
    assert.deepEqual(where(), [`${first}:${t1.leaf}`, `${fork1}:${copyOf(fork1, t2.leaf)}`, `${fork2}:${copyOf(fork2, t3b.leaf)}`, `${fork2}:${t4b.leaf}`]);

    // Rewind across one fork: the boundary lives in fork-1, the chat in
    // fork-2. The new fork comes from fork-1.
    opencode.undoBefore(chat, t3b.id);
    const t3c = await send("S-three");
    const fork3 = t3c.r.resume as string;
    const fork1L2 = copyOf(fork1, t2.leaf);
    assert.deepEqual(t3c.r, { resume: fork3, fork: `${fork1}@${fork1L2}`, transferred: false });
    assert.deepEqual(where(), [`${first}:${t1.leaf}`, `${fork3}:${copyOf(fork3, fork1L2)}`, `${fork3}:${t3c.leaf}`]);

    // Rewind across two forks (fork-1, fork-3): back to the first session.
    opencode.undoBefore(chat, t2.id);
    const t2d = await send("T-two");
    const fork4 = t2d.r.resume as string;
    assert.deepEqual(t2d.r, { resume: fork4, fork: `${first}@${t1.leaf}`, transferred: false });
    assert.deepEqual(where(), [`${fork4}:${copyOf(fork4, t1.leaf)}`, `${fork4}:${t2d.leaf}`]);
    assert.ok(!["Q-two", "R-three", "S-three", "R-four"].some((text) => lines(t2d.query.view).includes(text)), `Claude sees no undone message: ${t2d.query.view}`);

    // A retry right after a fork whose turn failed before Claude wrote
    // anything resumes that fork as is; nothing to cut. The Claude Code
    // process does not start; OpenCode retries the request.
    const t3d = await send("U-three");
    assert.deepEqual(t3d.r, { resume: fork4, fork: undefined, transferred: false });
    opencode.undoBefore(chat, t3d.id);
    claude.state.failures = ["spawn"];
    const queriesBefore = claude.queries.length;
    const t3e = await send("V-three");
    const fork5 = t3e.r.resume as string;
    assert.equal(t3e.turn.requests.length, 2, "the request failed, OpenCode retried it");
    const [failedQuery, retried] = claude.queries.slice(queriesBefore);
    assert.equal(failedQuery!.outcome, "spawn");
    assert.equal(failedQuery!.params.resume, fork5, "the failed attempt resumed the fork it made");
    assert.equal(retried!.params.resume, fork5, "the retry resumed that fork as is");
    assert.equal(forkOf(fork5), `${fork4}@${t2d.leaf}`);
    assert.equal(forks().filter((f) => f.fork === fork5).length, 1, "one fork for both attempts");

    // A rewind to a boundary whose session file is gone (the user pruned
    // Claude's projects folder) → history as text.
    assert.equal(where()[0], `${fork4}:${copyOf(fork4, t1.leaf)}`);
    rmSync(claude.fileOf(fork4));
    opencode.undoBefore(chat, t2d.id);
    const t2z = await send("Z-two");
    assert.deepEqual(t2z.r, { resume: undefined, fork: undefined, transferred: true });
    const fresh = store.getForeignSessionId(chat) as string;
    assert.equal(fresh, t2z.query.name);

    // A model switch changes nothing.
    const opus = opencode.instances[0]!.provider.models.find((m: any) => /opus/.test(m.id))?.id as string;
    assert.ok(opus, "the catalog has an Opus model");
    opencode.state.modelID = opus;
    const t3m = await send("M-three");
    opencode.state.modelID = undefined;
    assert.equal(t3m.query.params.model, opus);
    assert.deepEqual(t3m.r, { resume: fresh, fork: undefined, transferred: false });

    // OpenCode retries the same request (the first attempt reached Claude,
    // which wrote the prompt, but the model call failed): the retry goes back
    // to where that attempt started.
    claude.state.failures = ["overloaded"];
    const retryFrom = claude.queries.length;
    const t4n = await send("N-four");
    assert.equal(t4n.turn.requests.length, 2, "the request failed, OpenCode retried it");
    assert.equal(claude.queries[retryFrom]!.params.resume, fresh);
    const fork6 = t4n.r.resume as string;
    assert.deepEqual(t4n.r, { resume: fork6, fork: `${fresh}@${t3m.leaf}`, transferred: false });
    assert.equal(lines(t4n.query.view).filter((text) => text === "N-four").length, 1, `Claude sees the retried message once: ${t4n.query.view}`);

    // A Plan mode reminder before the prompt, and one after it.
    const reminder = "<system-reminder>\nYou are in Plan mode.\n</system-reminder>";
    const beforePlan = counts().at(-1)!;
    opencode.between(chat, "synthetic", reminder);
    const plan = await send("P-plan it");
    assert.deepEqual(plan.r, { resume: fork6, fork: undefined, transferred: false });
    await opencode.say(chat, "P-go");
    opencode.between(chat, "synthetic", reminder);
    const go = await opencode.turn(chat);
    assert.ok(go.ok, "the turn with a reminder after the prompt");
    assert.equal(claude.queries.at(-1)!.params.resume, fork6);
    assert.equal(forks().length, 6, "no fork for a reminder");
    assert.deepEqual(counts().slice(-2), [beforePlan + 1, beforePlan + 2], "a reminder is no message of the user's");
    const session = store.getForeignSessionId(chat) as string;

    // A title request leaves the boundaries alone.
    const before = JSON.stringify(store.getSessionTurns(chat));
    const title = await opencode.title(chat);
    assert.ok(title.title, "OpenCode titled the chat");
    assert.equal(JSON.stringify(store.getSessionTurns(chat)), before);

    // Tool-result continuation, steering and a later follow-up.
    claude.state.toolTurn = true;
    const queriesBeforeTool = claude.queries.length;
    const tool = await send("L-list files", { toolOutput: "a.txt", steer: "L-also count them" });
    assert.equal(tool.turn.requests.length, 2, "one request with the call, one with its result");
    assert.equal(claude.queries.length - queriesBeforeTool, 1, "continuation reuses the parked turn");
    assert.deepEqual(tool.r, { resume: session, fork: undefined, transferred: false });
    assert.equal((store.getSessionTurns(chat) as Array<{ leafUuid?: string }>).at(-1)!.leafUuid, claude.records(session).findLast((r) => r.type === "assistant")!.uuid);
    const thanks = await send("L-thanks");
    assert.deepEqual(thanks.r, { resume: session, fork: undefined, transferred: false });

    // A tool's image: OpenCode sends it as a message of its own after the results; it is the tool's, not the user's.
    const beforeImage = counts().at(-1)!;
    claude.state.toolTurn = true;
    const image = await send("I-take a screenshot", { toolOutput: "shot", toolFiles: [{ mime: "image/png", data: testPng("revert-edit") }] });
    assert.deepEqual(image.r, { resume: session, fork: undefined, transferred: false });
    const looked = await send("I-thanks");
    assert.deepEqual(looked.r, { resume: session, fork: undefined, transferred: false });
    assert.deepEqual(counts().slice(-2), [beforeImage + 1, beforeImage + 2], "the tool's image is no message of the user's");

    // A turn another model answered: the history goes on past the latest boundary; the session is resumed as is
    // and gets that turn.
    const beforeOther = counts().at(-1)!;
    const rewinds = wentBack().length;
    await opencode.say(chat, "O-ask another model");
    opencode.otherModelAnswer(chat, "O-the other model's answer");
    const back = await send("O-back to Claude");
    // Resumed, and the missed turn goes with the prompt as history.
    assert.deepEqual(back.r, { resume: session, fork: undefined, transferred: true });
    assert.ok(JSON.stringify(back.query.input.map((i) => i.content)).includes("O-the other model's answer"), "Claude gets the turn it missed");
    assert.equal(counts().at(-1), beforeOther + 2);
    assert.equal(wentBack().length, rewinds, "no rewind for a turn another model answered");

    // A history that matches no turn: another model compacted the chat.
    opencode.compactElsewhere(chat);
    const n1 = await send("N-something else entirely");
    assert.equal(n1.r.resume, undefined);
    // The summary is the user message right before the prompt: it goes with the prompt, nothing else to transfer.
    assert.ok(JSON.stringify(n1.query.input.map((i) => i.content)).includes("another model's summary"), "Claude gets the history OpenCode has");
    assert.ok(world.journal().some((line) => line.includes("OpenCode history no longer matches the Claude session") && line.includes('"match":"diverged"')));
    assert.equal(store.getForeignSessionId(chat), n1.query.name, "the new turn binds again");
    assert.deepEqual(leaves(), [n1.leaf]);
    const rebound = n1.query.name;

    // Tool results with no parked turn (reaped past its TTL while the tool
    // ran): the turn is rebuilt around them, still resumed.
    process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS = "100";
    claude.state.toolTurn = true;
    const late = await send("W-run it", {
      toolOutput: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return "late";
      },
    });
    delete process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS;
    assert.ok(world.journal().some((line) => line.includes("reaping parked turn past its TTL")));
    assert.ok(world.journal().some((line) => line.includes("tool results arrived with no parked turn")));
    assert.deepEqual(late.r, { resume: rebound, fork: undefined, transferred: false });
    // The session saw the turn that made the call start, so nothing was missed: the step is relayed as Claude's own
    // (#74's control, 1.6.1).
    assert.match(JSON.stringify(late.query.input.map((i) => i.content)), /Your previous step called the tools below/);

    // The Claude Code process that did not start (the retry block): the SDK reports its exit in the stream, and
    // the plugin takes it as a turn that failed fast — a warning, no error.
    assert.ok(world.journal().some((line) => line.includes("turn failed fast") && line.includes("Claude Code process exited with code 1")));
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok - revert/edit regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
