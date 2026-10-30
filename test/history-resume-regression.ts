/**
 * A chat's Claude session over its turns, bound by names: the chat's
 * transcript and its records are named after the chat and its messages
 * (names.ts), no store binds them. A chat another model answered first gets
 * its history transferred as text into a new transcript; the next turn
 * resumes it at Claude's last answer (`resumeSessionAt`); a branch another
 * process wrote after that point leaves the chat on its own Claude session; a
 * transcript gone from disk starts a new one with the history transferred
 * again. The form of the transferred history: history-transfer-*.ts. main's
 * store: history-resume-main-regression.ts.
 *
 * On the simulators (BEHAVIOR.md "Writing a test", "Where a resume
 * continues"): a chat that another model answered first (the plugin never
 * served that turn), then Claude's turns; a Claude Code process the plugin
 * did not stop (a zombie, as in branched-session-regression); what a turn
 * resumes read from the query's parameters and the journal.
 *
 * Run: bun test/history-resume-regression.ts (trees: where.md)
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { testCases } from "./simulators/cases.ts";
import { contentText } from "./simulators/claude-code.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("history-resume");
const { opencode, claude } = world;
await opencode.startPlugin();
const cases = testCases();

/** The text the query's prompt carried (records with a turn). */
const promptOf = (query: (typeof claude.queries)[number]) =>
  query.input.filter((m) => !m.noTurn).map((m) => contentText(m.content)).join("\n");
/**
 * The transfers of the chat's history as text: the history rides the turn's record (the journal's "turn records"
 * with history), or, for a turn not sent as records, goes ahead of the prompt.
 */
const injected = (chat: string) =>
  world
    .journal()
    .filter((line) => line.includes(chat) && ((line.includes("turn records") && !line.includes('"historyChars":0')) || line.includes("injecting transferred conversation history"))).length;
const started = (chat: string) =>
  world.journal().filter((line) => line.includes("starting a new Claude transcript; transferring history") && line.includes(`"conversationKey":"${chat}"`));
/** The end of the last turn in `name` (its last chain record, BEHAVIOR.md "Where a resume continues"): where the chat's next turn resumes. */
const lastAnswer = (name: string) => claude.leafOf(name)!.uuid;

// One chat through the cases: each case is the chat's next turn.
const chat = opencode.newChat();
let fresh: (typeof claude.queries)[number] | undefined;
let afterBranch: (typeof claude.queries)[number] | undefined;

await cases.run("no transcript of the chat yet: the history is transferred into a new transcript", async () => {
  await opencode.say(chat, "remember the codename AXIOM-9042");
  opencode.otherModelAnswer(chat, "Codename AXIOM-9042 noted.");
  await opencode.say(chat, "what is the codename?");
  const first = await opencode.turn(chat);
  assert.ok(first.ok, `the first Claude turn: ${first.requests.map((r) => r.status).join(",")}`);
  fresh = claude.queries.at(-1)!;
  assert.equal(fresh.params.resume, undefined, "no resume attempted");
  const promptText = promptOf(fresh);
  assert.match(promptText, /AXIOM-9042/, "the history went with the turn");
  assert.match(promptText, /what is the codename\?$/, "the latest message after the history");
  assert.doesNotMatch(promptText, /You are OpenCode\./, "the system prompt is not history");
  assert.equal(injected(chat), 1, "the journal names the transfer");
  assert.equal(started(chat).length, 1, "the journal names the new transcript");
  // The turn wrote the chat's transcript: the follow-up resumes it.
  assert.ok(claude.records(fresh.name).length > 0, "the new transcript is on disk");
});

await cases.run("the chat's transcript exists: resume at Claude's last answer, no transfer", async () => {
  // The turn's main-chain entries are the resume point: the turn resumes at Claude's last answer
  // (`resumeSessionAt`, by name, on every resume).
  assert.ok(fresh, "the first turn ran");
  const firstAnswer = lastAnswer(fresh.name);
  await opencode.say(chat, "spell it backwards");
  assert.ok((await opencode.turn(chat)).ok);
  const resumed = claude.queries.at(-1)!;
  assert.equal(resumed.params.resume, fresh.name);
  assert.doesNotMatch(promptOf(resumed), /AXIOM-9042/, "no history with the resumed turn");
  assert.equal(resumed.params.resumeSessionAt, firstAnswer, "the resume point is Claude's last answer");
  assert.equal(injected(chat), 1, "no second transfer");
  assert.equal(started(chat).length, 1, "no second transcript");
  // Subagent entries (`parent_tool_use_id` set) must not move the point: waiting for the simulator
  // to write subagent events.
});

await cases.run("a branch another process wrote after the point: the chat goes on in its own Claude session", async () => {
  // The turn still resumes the chat's own file and Claude reads the chat's turns, not the orphaned one's answer.
  // The other process is one the plugin did not stop (a zombie): its turn failed, the user stopped the chat while
  // OpenCode waited to retry and let another model answer, the next Claude turn continued the same file, and then
  // the zombie wrote its answer off the failed turn's prompt. Claude Code resumes only along the file's leaf chain
  // (BEHAVIOR.md "Where a resume continues"): the point found by name sits on a side branch then, and the point
  // moves to where the chat's branch leaves it, the turns after going as missed.
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
  const ours = lastAnswer(fresh.name);
  claude.state.zombies.shift()!();
  assert.notEqual(lastAnswer(fresh.name), ours, "the zombie's answer is the file's last record now");
  const transfersBefore = injected(chat);
  await opencode.say(chat, "where were we?");
  const branched = await opencode.turn(chat);
  assert.ok(branched.ok, `the turn after the branch: ${branched.requests.map((r) => r.status).join(",")}`);
  afterBranch = claude.queries.at(-1)!;
  assert.ok(afterBranch.view.includes("and once more") && !afterBranch.view.includes("ZOMBIE-ANSWER"), `Claude sees our branch, not the zombie's: ${afterBranch.view}`);
  // The chat's Claude session goes on (no transfer as text).
  assert.equal(world.journal().filter((line) => line.includes("No message found") && line.includes(chat)).length, 0, "Claude Code did not refuse the resume point");
  assert.equal(injected(chat), transfersBefore, "the history was not transferred as text");
  assert.ok(afterBranch.params.resume, "the turn resumed a Claude session");
  // A point the file no longer holds: names-regression, turn-point-regression.
});

await cases.run("the chat's transcript missing: a new transcript, the history transferred again", async () => {
  // The transcript is gone: Claude Code's cleanup (cleanupPeriodDays) or the user cleared the profile's projects
  // folder.
  assert.ok(afterBranch, "the branch case ran");
  const injectedBefore = injected(chat);
  const startedBefore = started(chat).length;
  rmSync(claude.fileOf(afterBranch.name), { force: true });
  await opencode.say(chat, "still there?");
  const lost = await opencode.turn(chat);
  assert.ok(lost.ok, `the turn after the transcript was lost: ${lost.requests.map((r) => r.status).join(",")}`);
  const transferred = claude.queries.at(-1)!;
  assert.equal(transferred.params.resume, undefined);
  assert.match(promptOf(transferred), /AXIOM-9042/, "the history went with the turn");
  assert.equal(started(chat).length, startedBefore + 1, "the journal names the new transcript");
  assert.equal(injected(chat), injectedBefore + 1);
  assert.ok(claude.records(transferred.name).length > 0, "the chat's new transcript is on disk");
  // The follow-up resumes the new transcript.
  await opencode.say(chat, "and now?");
  assert.ok((await opencode.turn(chat)).ok);
  assert.equal(claude.queries.at(-1)!.params.resume, transferred.name, "the chat continues the new transcript");
  assert.equal(injected(chat), injectedBefore + 1, "no transfer after the new transcript");
  assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
});

claude.state.zombies.length = 0;
await world.dispose();
cases.done();
process.exit(process.exitCode ?? 0);
