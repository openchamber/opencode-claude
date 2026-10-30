/**
 * The simulators under fork-world.ts against what the real systems were seen
 * doing, for the copy step: a simulator that drifts from the real thing makes
 * every test above it lie.
 *
 * Claude Code (probes 12, 25): a copy (`resume` + `forkSession: true` +
 * `sessionId` + `resumeSessionAt`) holds the source's chain down to the
 * point with the same uuids, then the prompt's records; a record without a
 * turn gets an init and an empty result, and no turn runs; the source does
 * not change; a point off the source's leaf chain is refused with "No
 * message found"; two copies under one name at once write everything
 * twice, one after the other is refused; a copying process killed as soon
 * as the file appeared leaves it with no record, and its name taken.
 *
 * OpenCode (schema/src/session-message.ts): `session.context` gives an
 * answer's tool calls inside its `content` as `type: "tool"` with id and
 * state, its finish and completion time; a compaction with status, summary
 * and recent; `session.get` gives a fork its parent and boundary.
 *
 * On the simulators (test/simulators/): the world of test/fork-world.ts; the
 * copies are queries straight into the Claude Code simulator (`w.claude`,
 * its `chat`), as the plugin's starter would hand them; the chat's turns,
 * its compaction and fork go through the plugin, whose journal is read.
 *
 * Run: bun test/fork-world-regression.ts
 */
import assert from "node:assert/strict";

import { createForkWorld } from "./fork-world.ts";

async function main() {
  const w = await createForkWorld();
  await w.startPlugin();

  /** A query of the Claude Code simulator, run to its end: its events. */
  const run = async (params: Record<string, unknown>) => {
    const handle = await w.claude(params as never);
    const events: any[] = [];
    try {
      for await (const event of handle.stream) events.push(event);
    } catch (err) {
      events.push({ thrown: (err as Error).message });
    }
    return events;
  };
  const marker = (uuid: string) => ({
    type: "user",
    uuid,
    shouldQuery: false,
    message: { role: "user", content: "(branch of the chat)" },
    parent_tool_use_id: null,
  });
  async function* stream(...messages: unknown[]) {
    yield* messages;
  }
  const conversation = (name: string) => w.records(name).filter((r) => r.type === "user" || r.type === "assistant");

  // A chat with two turns of Claude's.
  const chat = w.newChat();
  await w.say(chat, "q1");
  assert.ok((await w.turn(chat)).ok);
  await w.say(chat, "q2");
  assert.ok((await w.turn(chat)).ok);
  const source = w.queries.at(-1)!.name;
  const turns = conversation(source);
  const firstAnswer = turns.find((r) => r.type === "assistant")!;
  const sourceText = w.snapshot().get(`${source}.jsonl`);

  // ---- A copy at the first answer, with a marker: the chain, then the marker. ----
  {
    const name = "11111111-1111-4111-8111-111111111111";
    const events = await run({ prompt: stream(marker("22222222-2222-4222-8222-222222222222")), resume: source, forkSession: true, sessionId: name, resumeSessionAt: firstAnswer.uuid });
    assert.equal(w.queries.at(-1)!.outcome, "records", "a copy with a marker runs no turn");
    assert.equal(w.queries.at(-1)!.copiedFrom, source);
    // The marker's command: read, taken, completed by its confirmation (BEHAVIOR.md "The input of a query").
    assert.deepEqual(
      events.map((e) => [e.type, e.num_turns ?? e.state]),
      [["command_lifecycle", "queued"], ["command_lifecycle", "started"], ["system", undefined], ["result", 0], ["command_lifecycle", "completed"]],
      "an init and an empty result for the marker",
    );
    const copied = w.records(name).filter((r) => typeof r.uuid === "string");
    const chain = w.chainTo(source, firstAnswer.uuid);
    assert.deepEqual(copied.slice(0, chain.length).map((r) => r.uuid), chain.map((r) => r.uuid), "the source's chain with its uuids");
    const last = copied.at(-1)!;
    assert.equal(last.uuid, "22222222-2222-4222-8222-222222222222");
    assert.equal(last.queueTranscriptOnly, true);
    assert.equal(last.parentUuid, firstAnswer.uuid, "the marker after the point");
    assert.equal(w.snapshot().get(`${source}.jsonl`), sourceText, "the source unchanged");
  }

  // ---- A copy with a turn: the chain, the question, an answer. ----
  {
    const name = "33333333-3333-4333-8333-333333333333";
    const events = await run({
      prompt: stream({ type: "user", uuid: "44444444-4444-4444-8444-444444444444", message: { role: "user", content: "q3" }, parent_tool_use_id: null }),
      resume: source, forkSession: true, sessionId: name, resumeSessionAt: firstAnswer.uuid,
    });
    assert.equal(w.queries.at(-1)!.outcome, "answered");
    assert.ok(events.some((e) => e.type === "result" && e.num_turns === 1));
    assert.match(w.queries.at(-1)!.view, /q1[\s\S]*answer L1[\s\S]*q3/, "the copy's turn sees the chain, then its question");
    assert.ok(!/q2/.test(w.queries.at(-1)!.view), "nothing after the point");
  }

  // ---- A point off the source's leaf chain: refused, nothing written. ----
  {
    const name = "55555555-5555-4555-8555-555555555555";
    await run({ prompt: stream(marker("66666666-6666-4666-8666-666666666666")), resume: source, forkSession: true, sessionId: name, resumeSessionAt: "77777777-7777-4777-8777-777777777777" });
    assert.equal(w.queries.at(-1)!.outcome, "refused: no message");
    assert.ok(!w.snapshot().has(`${name}.jsonl`));
  }

  // ---- Two copies under one name at once: everything twice, one of each uuid when read. ----
  {
    const name = "88888888-8888-4888-8888-888888888888";
    const params = { resume: source, forkSession: true, sessionId: name, resumeSessionAt: firstAnswer.uuid };
    w.state.copyRace = true;
    await Promise.all([
      run({ ...params, prompt: stream(marker("99999999-9999-4999-8999-999999999999")) }),
      run({ ...params, prompt: stream(marker("99999999-9999-4999-8999-999999999999")) }),
    ]);
    w.state.copyRace = false;
    const written = w.records(name).filter((r) => typeof r.uuid === "string");
    const unique = new Set(written.map((r) => r.uuid));
    assert.equal(written.length, unique.size * 2, "two copies write every record twice");
    // One after the other: the name is in use, the second copy is refused (probe 39, S6).
    const before = w.records(name).length;
    await run({ ...params, prompt: stream(marker("cccccccc-cccc-4ccc-8ccc-cccccccccccc")) });
    assert.equal(w.queries.at(-1)!.outcome, "refused: in use");
    assert.equal(w.records(name).length, before);
  }

  // ---- A copying process killed as soon as the file appeared: no record in it; the name stays taken. ----
  {
    const name = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    w.state.failures = ["copyKilled"];
    const events = await run({ prompt: stream(marker("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")), resume: source, forkSession: true, sessionId: name, resumeSessionAt: firstAnswer.uuid });
    assert.ok(events.some((e) => e.thrown?.includes("143")), "the process exited");
    assert.ok(w.snapshot().has(`${name}.jsonl`), "the file is there");
    assert.equal(w.records(name).filter((r) => typeof r.uuid === "string").length, 0, "with no record (probe 39, S2)");
    await run({ prompt: stream(marker("dddddddd-dddd-4ddd-8ddd-dddddddddddd")), resume: source, forkSession: true, sessionId: name, resumeSessionAt: firstAnswer.uuid });
    assert.equal(w.queries.at(-1)!.outcome, "refused: in use", "no copy into it again (probe 39, S8)");
  }

  // ---- session.context in OpenCode's form; session.get with the fork. ----
  {
    await w.say(chat, "q3");
    w.state.toolTurn = true;
    assert.ok((await w.turn(chat, { toolOutput: "t1" })).ok);
    const shown = (await w.context({ sessionID: chat })) as Array<Record<string, any>>;
    const step = shown.find((m) => m.type === "assistant" && m.finish === "tool-calls")!;
    assert.ok(step, "the tool step is an answer of its own");
    assert.deepEqual(
      step.content.map((c: any) => [c.type, c.state?.status, c.state?.content?.[0]?.text]),
      [["tool", "completed", "t1"]],
      "the call inside the answer's content, with its result",
    );
    assert.ok(step.time.completed !== undefined);
    const users = shown.filter((m) => m.type === "user");
    assert.ok(users.every((m) => typeof m.text === "string" && m.metadata?.["openchamber.claude-code"] === m.id), "user messages with text and the prompt hook's metadata");
    await w.compact(chat);
    const after = (await w.context({ sessionID: chat })) as Array<Record<string, any>>;
    assert.equal(after[0]!.type, "compaction");
    assert.equal(after[0]!.status, "completed");
    assert.match(after[0]!.summary, /the summary/);
    // The kept tail: 2.2.0 reads it from `metadata.keepID` into `metadata.recent`, 2.0.32 kept it in `recent`.
    assert.equal(typeof (w.state.version === "2.0.32" ? after[0]!.recent : after[0]!.metadata?.recent), "string");
    const child = await w.fork(chat, w.through(w.lastId(chat)), { silent: true });
    assert.deepEqual(await w.get({ sessionID: child }), { id: child, fork: { sessionID: chat, boundary: { type: "through", messageID: w.lastId(chat) } } });
  }

  // The plugin's journal: the chat's first turn started its transcript, the
  // later ones resumed it, the summary was read from it, and nothing failed.
  const journal = w.journal();
  assert.equal(journal.filter((line) => line.includes("starting a new Claude transcript") && line.includes(`"conversationKey":"${chat}"`)).length, 1, "one transcript for the chat");
  assert.equal(journal.filter((line) => line.includes("resuming the chat's Claude transcript") && line.includes(`"conversationKey":"${chat}"`)).length, 2, "the later turns resume it");
  assert.ok(journal.some((line) => line.includes("summarizing from the chat's Claude session")), "the summary from the chat's transcript");
  assert.deepEqual(journal.filter((line) => /level=(warn|error)/.test(line)), [], "no warning or error in the plugin's journal");
  await w.dispose();
  console.log("ok — fork world regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
