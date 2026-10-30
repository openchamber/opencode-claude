/**
 * Regression: reverting or editing in OpenCode resumes the Claude transcript
 * at the right record instead of continuing a history OpenCode no longer
 * has. The resume point comes from the ids in OpenCode's message list
 * (turn-point.ts): the end of the turn of the last message the transcript
 * holds; what the list has after it goes as a record of its own without a
 * turn (a new transcript: the history as text).
 * - A revert or an edit: the point is the answer before the undone turn,
 *   and the turn copies the transcript up to it into the next version
 *   (`resume` + `forkSession` + `sessionId`); the old version keeps the
 *   undone turn, for a fork made before the revert.
 * - A retry of a failed turn: the same version; the record takes the next
 *   attempt number and the point is before the failed attempt.
 * - Normal flows never misfire: follow-ups, a model switch, Plan mode
 *   reminders, title requests, tool-result continuations, steering, a
 *   rebuilt tool step.
 * - A history whose early message changed: a revert to the chat's start,
 *   copied up to the record the transcript starts with, history as text.
 *
 * On the simulators (test/simulators/): a revert or an edit is the user's
 * (`undoBefore`, then a new message); the turn's point is the query's
 * `resume` / `resumeSessionAt`, its record's name the query's `trigger`. The
 * end of a turn is the transcript's last chain record right after it
 * (`claude.leafOf`). A failed turn is a model call that failed after the CLI
 * wrote the prompt (`serverError`, retried by OpenCode; `permission`, not
 * retried). A rebuilt tool step is a tool that ran longer than the parked
 * turn's TTL (a tool output that is a promise: OpenCode sends the results
 * once it settled). An early message changed: the user edits the chat's
 * first message and another model answers it. A copy is the query's
 * `forkSession` with the new version as `sessionId`; the plan's line in the
 * journal names it (`copiedFrom`, `copyFor`).
 *
 * Run: bun test/revert-edit-regression.ts
 */
import assert from "node:assert/strict";

import { contentText } from "./simulators/claude-code.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("revert-edit");
  const { opencode, claude } = world;
  try {
    await opencode.startPlugin();
    const { FIRST_EPOCH, TRANSCRIPT_START_NAME, stepRecordName, transcriptName, userRecordName } = await pluginModule("names");

    const chat = opencode.newChat();
    const V = (version: number) => transcriptName(chat, FIRST_EPOCH, version);
    const NAME = V(1);
    /** The version the chat's turns continue: a revert moves it on. */
    let current = NAME;
    /**
     * The end of the turn that answered each message (by its text): the leaf, right after the turn, of the
     * transcript the turn wrote. A copy keeps the source's uuids, so an end is the same record in both.
     */
    const ends = new Map<string, string>();
    const chatQueries = () => claude.queries.filter((q) => q.kind === "chat");
    /** The transcript a query wrote: a new one or a copy under `sessionId`, else the one it resumed. */
    const writtenBy = (query: (typeof claude.queries)[number]) => String(query.params.forkSession || !query.params.resume ? query.params.sessionId : query.params.resume);
    /** The user sends `text` and the turn answers: what its last query resumed, at which record, under which name, whether the history went as text. */
    const send = async (text: string, options: Parameters<typeof opencode.turn>[1] = {}) => {
      const id = await opencode.say(chat, text);
      const from = claude.queries.length;
      const turn = await opencode.turn(chat, options);
      assert.ok(turn.ok, `${text}: ${turn.requests.map((r) => r.status).join(",")}`);
      const query = chatQueries().at(-1)!;
      ends.set(text, claude.leafOf(writtenBy(query))!.uuid!);
      return {
        id,
        turn,
        query,
        queries: claude.queries.slice(from),
        r: {
          resume: query.params.resume,
          at: query.params.resumeSessionAt,
          fresh: query.params.sessionId,
          copy: query.params.forkSession === true,
          uuid: query.trigger,
          // Transferred: this query's prompt carries the history as text, or the missed messages as a record of
          // their own without a turn, in OpenCode's form for a serialized part of a conversation.
          transferred:
            JSON.stringify(query.input.map((i) => i.content)).includes("<conversation_history>") ||
            query.input.some((i) => i.noTurn && contentText(i.content).includes("<recent-context>")),
        },
      };
    };
    const lines = (view: string) => view.split("\n");

    // Three turns build the transcript; each resumes at the latest answer.
    const t1 = await send("u1");
    assert.deepEqual([t1.r.fresh, t1.r.resume, t1.r.transferred], [NAME, undefined, false]);
    assert.equal(t1.r.uuid, userRecordName(t1.id, 1));
    const t2 = await send("u2");
    assert.deepEqual([t2.r.resume, t2.r.at, t2.r.transferred], [NAME, ends.get("u1"), false]);
    const t3 = await send("u3");
    assert.deepEqual([t3.r.resume, t3.r.at, t3.r.transferred], [NAME, ends.get("u2"), false]);

    // Revert of the last turn, new prompt: the point is the answer to u2, and
    // the turn copies version 1 up to it into version 2; version 1 keeps the
    // undone turn, the copy holds none of it.
    opencode.undoBefore(chat, t3.id);
    const t3b = await send("u3 edited");
    assert.deepEqual([t3b.r.resume, t3b.r.at, t3b.r.fresh, t3b.r.copy, t3b.r.transferred], [NAME, ends.get("u2"), V(2), true, false]);
    current = V(2);
    assert.ok(claude.records(NAME).some((r) => r.uuid === userRecordName(t3.id, 1)), "version 1 keeps the undone turn");
    assert.ok(!claude.records(current).some((r) => r.uuid === userRecordName(t3.id, 1)), "the copy does not");
    assert.ok(claude.records(current).some((r) => r.uuid === ends.get("u2")), "the copy holds the turns before the revert, under the same uuids");
    assert.ok(!lines(t3b.query.view).includes("u3"), `Claude still sees the undone message: ${t3b.query.view}`);

    // Normal follow-up after the edit resumes the copy at the new answer.
    const t4 = await send("u4");
    assert.deepEqual([t4.r.resume, t4.r.at, t4.r.copy, t4.r.transferred], [V(2), ends.get("u3 edited"), false, false]);

    // Back one turn again: the point is still the answer to "u3 edited", and version 3 is a copy of version 2.
    opencode.undoBefore(chat, t4.id);
    const t4b = await send("u4 edited");
    assert.deepEqual([t4b.r.resume, t4b.r.at, t4b.r.fresh, t4b.r.copy, t4b.r.transferred], [V(2), ends.get("u3 edited"), V(3), true, false]);
    current = V(3);
    assert.ok(!lines(t4b.query.view).includes("u4"), `Claude sees no undone message: ${t4b.query.view}`);

    // A turn that fails after the CLI wrote the prompt's record: OpenCode
    // retries the same message, which gets the next attempt number and
    // resumes before the failed attempt.
    claude.state.failures = ["serverError"];
    const t5 = await send("u5");
    assert.equal(t5.turn.requests.length, 2, "the request failed, OpenCode retried it");
    const [failed, retried] = t5.queries;
    assert.equal(failed!.outcome, "serverError");
    assert.deepEqual([failed!.params.resume, failed!.params.resumeSessionAt, failed!.trigger], [current, ends.get("u4 edited"), userRecordName(t5.id, 1)]);
    assert.deepEqual(
      [retried!.params.resume, retried!.params.resumeSessionAt, retried!.params.forkSession === true, retried!.trigger],
      [current, ends.get("u4 edited"), false, userRecordName(t5.id, 2)],
      "a retry stays in the same version",
    );
    assert.equal(lines(t5.query.view).filter((text) => text === "u5").length, 1, `Claude sees the retried message once: ${t5.query.view}`);

    // A model switch changes nothing.
    const opus = opencode.instances[0]!.provider.models.find((m: any) => /opus/.test(m.id))?.id as string;
    assert.ok(opus, "the catalog has an Opus model");
    opencode.state.modelID = opus;
    const t6 = await send("u6");
    opencode.state.modelID = undefined;
    assert.equal(t6.query.params.model, opus);
    assert.deepEqual([t6.r.resume, t6.r.at, t6.r.transferred], [current, ends.get("u5"), false]);

    // A Plan mode reminder before the prompt, and one after it: reminders are
    // not messages of the chain.
    const reminder = "<system-reminder>\nYou are in Plan mode.\n</system-reminder>";
    opencode.between(chat, "synthetic", reminder);
    const plan = await send("plan it");
    assert.deepEqual([plan.r.resume, plan.r.at, plan.r.transferred], [current, ends.get("u6"), false]);
    await opencode.say(chat, "go");
    opencode.between(chat, "synthetic", reminder);
    const go = await opencode.turn(chat);
    assert.ok(go.ok, "the turn with a reminder after the prompt");
    assert.deepEqual(
      [chatQueries().at(-1)!.params.resume, chatQueries().at(-1)!.params.resumeSessionAt, chatQueries().at(-1)!.params.forkSession === true],
      [current, ends.get("plan it"), false],
    );
    ends.set("go", claude.leafOf(current)!.uuid!);

    // A title request leaves the transcript alone.
    const before = claude.records(current).length;
    const title = await opencode.title(chat);
    assert.ok(title.title, "OpenCode titled the chat");
    assert.equal(claude.records(current).length, before);
    assert.equal(claude.queries.at(-1)!.params.resume, undefined, "a title resumes nothing");

    // Tool-result continuation (the parked turn), with a message sent while
    // the tool ran, then a follow-up that resumes after the turn's last record.
    claude.state.toolTurn = true;
    const tool = await send("list files", { toolOutput: "a.txt", steer: "also count them" });
    assert.equal(tool.turn.requests.length, 2, "one request with the call, one with its result");
    assert.equal(tool.queries.length, 1, "continuation reuses the parked turn");
    assert.deepEqual([tool.r.resume, tool.r.at], [current, ends.get("go")]);
    const thanks = await send("thanks");
    // The CLI took the message sent mid-turn into the turn (an attachment named after it): nothing is missed.
    assert.deepEqual([thanks.r.resume, thanks.r.at, thanks.r.transferred], [current, ends.get("list files"), false]);

    // Tool results with no parked turn (reaped past its TTL while the tool
    // ran): the step is rebuilt as a record of its own, after the turn's last record.
    process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS = "100";
    claude.state.toolTurn = true;
    let reapedAt: string | undefined;
    const late = await send("run it", {
      toolOutput: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        reapedAt = claude.leafOf(current)!.uuid;
        return "late";
      },
    });
    delete process.env.OPENCODE_CLAUDE_PARKED_TURN_TTL_MS;
    assert.ok(world.journal().some((line) => line.includes("reaping parked turn past its TTL")));
    assert.ok(world.journal().some((line) => line.includes("tool results arrived with no parked turn")));
    assert.ok(reapedAt && reapedAt !== ends.get("thanks"), "the reaped turn's records end past the call");
    const call = late.turn.requests[0]!.reply!.toolCalls[0]!.id;
    assert.deepEqual([late.r.resume, late.r.at, late.r.uuid], [current, reapedAt, stepRecordName([call], 1)]);

    // A message whose turn failed after its record was written, then another
    // one: the two stand together as the latest user turn. The transcript
    // holds the first; the prompt is only the second, or Claude reads the
    // first twice.
    claude.state.failures = ["permission"];
    const u7 = await opencode.say(chat, "u7");
    const failedU7 = await opencode.turn(chat);
    assert.ok(!failedU7.ok && failedU7.requests.length === 1, `u7 failed, not retried: ${failedU7.requests.map((r) => r.status).join(",")}`);
    assert.equal(chatQueries().at(-1)!.trigger, userRecordName(u7, 1));
    const failedEnd = claude.leafOf(current)!.uuid!;
    const u8 = await send("u8");
    assert.deepEqual([u8.r.resume, u8.r.at, u8.r.uuid], [current, failedEnd, userRecordName(u8.id, 1)]);
    assert.ok(claude.chainTo(current, failedEnd).some((r) => r.uuid === userRecordName(u7, 1)), "the point is the end of u7's turn");
    const prompt = u8.query.input.filter((i) => !i.noTurn).map((i) => JSON.stringify(i.content));
    assert.equal(prompt.length, 1);
    assert.ok(prompt[0]!.includes("u8") && !prompt[0]!.includes("u7"), `the failed message is in the transcript, not again in the prompt: ${prompt[0]}`);

    // A history whose early message changed: nothing of it is in the
    // transcript before the new prompt, a revert to the chat's start: the
    // turn copies the transcript up to the record it starts with into the
    // next version, history as text.
    opencode.undoBefore(chat, t1.id);
    await opencode.say(chat, "something else entirely");
    opencode.otherModelAnswer(chat, "a1");
    const changed = await send("u2 again");
    assert.deepEqual([changed.r.resume, changed.r.at, changed.r.fresh, changed.r.copy, changed.r.transferred], [current, TRANSCRIPT_START_NAME, V(4), true, true]);
    assert.ok(JSON.stringify(changed.query.input.map((i) => i.content)).includes("something else entirely"), "Claude gets the history OpenCode has");
    assert.ok(!lines(changed.query.view).includes("u1"), `Claude sees none of the old history: ${changed.query.view}`);

    // The journal: each turn's plan, and the one error of the failures the test made.
    const journal = world.journal();
    assert.ok(journal.some((line) => line.includes("resuming the chat's Claude transcript") && line.includes(`"point":"${TRANSCRIPT_START_NAME}"`)), "the plan of the changed history is in the journal");
    const copies = journal
      .filter((line) => line.includes("resuming the chat's Claude transcript") && line.includes('"copyFor"'))
      .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { transcript: string; copiedFrom: string; copyFor: string });
    assert.deepEqual(
      copies.map((c) => [c.copiedFrom, c.transcript, c.copyFor]),
      [[V(1), V(2), "revert"], [V(2), V(3), "revert"], [V(3), V(4), "revert"]],
      "the journal names each copy: from which version, into which, for a revert",
    );
    const errors = journal.filter((line) => /level=error/.test(line));
    assert.deepEqual(errors.filter((line) => !/Internal server error|permission to use this model/.test(line)), [], "no other error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — revert/edit regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
