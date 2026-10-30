/**
 * A chat's Claude session over its turns, as main 1.6.0 keeps it: the
 * plugin's store binds the chat to its Claude session and the leaf of its last
 * turn. A chat another model answered first gets its history transferred as
 * text and is bound to the new session; the next turn resumes it; a branch
 * another process wrote after the leaf is resumed through a fork cut at the
 * leaf (the SDK's forkSession); a transcript gone from disk drops the binding
 * and transfers the history again. The series binds by names
 * (chain/turn-by-names): history-resume-regression.ts.
 *
 * On the simulators (BEHAVIOR.md "Writing a test"): a chat that another model
 * answered first (the plugin never served that turn), then Claude's turns; a
 * Claude Code process the plugin did not stop (a zombie, as in
 * branched-session-regression); the binding read from the plugin's store after
 * the turns.
 *
 * Run: bun test/history-resume-main-regression.ts (trees: where.md)
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { testCases } from "./simulators/cases.ts";
import { contentText } from "./simulators/claude-code.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

const world = await createWorld("history-resume-main");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();
const store = await pluginModule("session-store");

/** The text the query's prompt carried (records with a turn). */
const promptOf = (query: (typeof claude.queries)[number]) =>
  query.input.filter((m) => !m.noTurn).map((m) => contentText(m.content)).join("\n");
const injected = (chat: string) =>
  world.journal().filter((line) => line.includes("injecting transferred conversation history") && line.includes(chat)).length;
const forkLines = (chat: string) =>
  world.journal().filter((line) => line.includes("resuming a fork of the Claude session") && line.includes(chat));

// One chat through the cases: each case is the chat's next turn.
const chat = opencode.newChat();
let fresh: (typeof claude.queries)[number] | undefined;
let fork: string | undefined;

await cases.run("no stored binding: the history is transferred and the chat bound to the new session", async () => {
  await opencode.say(chat, "remember the codename AXIOM-9042");
  opencode.otherModelAnswer(chat, "Codename AXIOM-9042 noted.");
  await opencode.say(chat, "what is the codename?");
  const first = await opencode.turn(chat);
  assert.ok(first.ok, `the first Claude turn: ${first.requests.map((r) => r.status).join(",")}`);
  fresh = claude.queries.at(-1)!;
  assert.equal(fresh.params.resume, undefined);
  const promptText = promptOf(fresh);
  assert.match(promptText, /<conversation_history>/);
  assert.match(promptText, /AXIOM-9042/);
  assert.match(promptText, /Latest user message:\nwhat is the codename\?/);
  assert.doesNotMatch(promptText, /You are OpenCode\./, "the system prompt is not history");
  assert.equal(injected(chat), 1, "the journal names the transfer");
  // The turn stored the new Claude session for the follow-up resume.
  assert.equal(store.getForeignSessionId(chat), fresh.name);
});

await cases.run("a stored binding whose transcript exists: resume, no transfer, the leaf is Claude's last answer", async () => {
  assert.ok(fresh, "the first turn ran");
  await opencode.say(chat, "spell it backwards");
  assert.ok((await opencode.turn(chat)).ok);
  const resumed = claude.queries.at(-1)!;
  assert.equal(resumed.params.resume, fresh.name);
  assert.doesNotMatch(promptOf(resumed), /<conversation_history>/);
  assert.equal("resumeSessionAt" in resumed.params, false);
  assert.equal(injected(chat), 1, "no second transfer");
  // The turn's main-chain entries become the resume point; a chain that continues from it resumes as is.
  assert.equal(store.getSessionLeafUuid(chat), claude.records(fresh.name).findLast((r) => r.type === "assistant")!.uuid, "the chat's leaf is Claude's last answer");
  assert.deepEqual(forkLines(chat), [], "a chain that continues from the leaf resumes as is");
  // Subagent entries (`parent_tool_use_id` set) must not move the leaf: waiting for the simulator
  // to write subagent events.
});

await cases.run("a branch another process wrote after the leaf: the resume goes through a fork cut at the leaf", async () => {
  // main's fork is the SDK's forkSession on Claude Code's files. The other process is one the plugin did not stop
  // (a zombie): its turn failed, the user stopped the chat while OpenCode waited to retry and let another model
  // answer, the next Claude turn continued the same file, and then the zombie wrote its answer off the failed
  // turn's prompt.
  assert.ok(fresh, "the first turn ran");
  await opencode.say(chat, "and once more");
  claude.state.failures = ["zombie"];
  claude.state.replies = ["ZOMBIE-ANSWER"];
  const stop = new AbortController();
  const sleep = opencode.state.sleep;
  opencode.state.sleep = async () => stop.abort();
  try {
    const orphaned = await opencode.turn(chat, { stop: stop.signal });
    assert.ok(orphaned.stopped, "the user stopped the chat during OpenCode's retry wait");
  } finally {
    opencode.state.sleep = sleep;
    claude.state.failures = [];
    claude.state.replies = [];
  }
  assert.equal(claude.state.zombies.length, 1);
  opencode.otherModelAnswer(chat, "OTHER-MODEL-ANSWER");
  await opencode.say(chat, "where did we stop?");
  assert.ok((await opencode.turn(chat)).ok);
  assert.equal(claude.queries.at(-1)!.params.resume, fresh.name, "the next Claude turn continued the same file");
  const ours = store.getSessionLeafUuid(chat) as string;
  claude.state.zombies.shift()!();
  assert.equal(store.sessionChainAfterLeaf(claude.fileOf(fresh.name), ours), "branched");
  await opencode.say(chat, "where were we?");
  const branched = await opencode.turn(chat);
  assert.ok(branched.ok, `the turn after the branch: ${branched.requests.map((r) => r.status).join(",")}`);
  assert.ok(world.journal().some((line) => line.includes("Claude session branched after this chat's last turn") && line.includes(chat)));
  assert.equal(forkLines(chat).length, 1);
  fork = (JSON.parse(forkLines(chat)[0]!.slice(forkLines(chat)[0]!.indexOf("{"))) as { from: string; fork: string }).fork;
  const viaFork = claude.queries.at(-1)!;
  assert.equal(viaFork.params.resume, fork);
  assert.notEqual(fork, fresh.name);
  assert.ok(viaFork.view.includes("and once more") && !viaFork.view.includes("ZOMBIE-ANSWER"), `Claude sees our branch, not the zombie's: ${viaFork.view}`);
  assert.equal(store.getForeignSessionId(chat), fork);
  assert.equal(store.getSessionLeafUuid(chat), claude.records(fork).findLast((r) => r.type === "assistant")!.uuid);
  // A leaf the file no longer holds falls back to a plain resume, and a fork that fails transfers the history
  // instead of retrying: waiting for the simulator to have a transcript that lost the chat's
  // leaf, and the SDK's forkSession failing.
});

await cases.run("a stored binding with its transcript missing: the binding dropped, the history transferred again", async () => {
  // The transcript is gone: Claude Code's cleanup (cleanupPeriodDays) or the user cleared the profile's projects
  // folder.
  assert.ok(fork, "the fork case ran");
  rmSync(claude.fileOf(fork), { force: true });
  await opencode.say(chat, "still there?");
  const lost = await opencode.turn(chat);
  assert.ok(lost.ok, `the turn after the transcript was lost: ${lost.requests.map((r) => r.status).join(",")}`);
  const transferred = claude.queries.at(-1)!;
  assert.equal(transferred.params.resume, undefined);
  assert.match(promptOf(transferred), /<conversation_history>/);
  assert.match(promptOf(transferred), /AXIOM-9042/);
  assert.ok(world.journal().some((line) => line.includes("stored Claude session file missing; transferring history") && line.includes(chat)));
  assert.equal(injected(chat), 2);
  assert.equal(store.getForeignSessionId(chat), transferred.name, "the chat is bound to the new session");
  assert.notEqual(transferred.name, fork);
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
});

claude.state.zombies.length = 0;
await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
