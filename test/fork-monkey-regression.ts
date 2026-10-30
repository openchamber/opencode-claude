/**
 * The monkey: random sequences of everything a user can do to chats, with
 * one invariant checked at every query of Claude's. The target tests
 * (turn-point, revert-edit, compaction-resume, ...) are the cases someone
 * thought of; this one is for the combinations nobody did. Taken from the
 * fork-chain branch (9627053) and rebuilt for resume by names: forks reach
 * Claude as text in this step, and hold the invariant all the same.
 *
 * Every message carries a token: q7 a question, o3 another model's answer,
 * s5 / sh5 / k5 a synthetic, shell or skill message, t4 a tool's output,
 * `answer L9` Claude's answer; another plugin's hook may add x7 after q7.
 * A Plan mode reminder carries none.
 *
 * The invariant: what Claude got (the transcript's chain up to where the
 * query resumed, then every prompt message) holds the tokens of the list
 * OpenCode's hooks left for that request, in order; after a turn, the
 * chain down to the answer holds the list's tokens and the answer's. For a
 * summary, the summarized part. Whatever the plugin did (resumed at a
 * record, sent missed turns as a record of their own, started a new transcript), Claude sees
 * exactly the conversation of the request.
 *
 * The journal (debug.log), after every action: no error lines; warnings
 * only of known kinds; one plan line per chat query ("resuming the chat's
 * Claude transcript" or "starting a new Claude transcript"), naming the
 * transcript the query ran on. A fork never changes an existing file.
 *
 * Actions: a turn of Claude's, with a tool, with a message sent while the
 * tool runs; another model's turn; a turn that fails on every retry
 * (nothing written, an API error, a killed process), also answered by
 * another model afterwards; a turn that fails and
 * then passes on OpenCode's retry; a killed process that writes its answer
 * later (zombie); a revert to any message, the same text or a new one,
 * then Claude or another model; a compaction by Claude or by another
 * model, then a turn; a fork before any user message or through any
 * answer, also with the plugin asleep, also while the answer is being
 * written, also with the event and the first message at once; two queued
 * messages delivered one by one or together; synthetic, shell, skill
 * messages, reminders and a move to another directory; the plugin
 * restarted; a turn stopped by the user while Claude answers, or while its
 * tool runs (Claude parked on the call); a revert
 * staged and cancelled; a fork whose parent is deleted before its first
 * turn; a chat imported from another. A seed may also run with another
 * plugin's hook that rewrites the list.
 *
 * On the simulators (test/simulators/), through test/fork-world.ts: every
 * action is the OpenCode simulator's (say, turn, fork, undoBefore, queue /
 * deliver, compact…) or a switch of the Claude Code simulator's (failures,
 * zombies, hold, tool steps); what Claude got is the simulator's `view` of
 * each query and its transcript files; the journal is the plugin's.
 *
 * Seeds: MONKEY_SEEDS runs (default 12) of MONKEY_STEPS actions (default
 * 30), seeds 1..N; MONKEY_SEED=n replays one. A failure prints the seed and
 * the actions so far.
 *
 * Run: bun test/fork-monkey-regression.ts
 * (a short run: $env:MONKEY_SEEDS = "5"; bun test/fork-monkey-regression.ts)
 */
import assert from "node:assert/strict";

import {
  contentText,
  createForkWorld,
  withTimeout,
  type ClaudeFailure,
  type ClaudeQuery,
  type ListMessage,
  type Request,
} from "./fork-world.ts";

/** mulberry32: a small seeded generator, enough to replay a run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKEN = /\b(?:q|o|s|sh|k|t|x|d)\d+\b|\bL\d+\b/g;
const tokens = (text: string) => text.match(TOKEN) ?? [];
const listTokens = (list: ListMessage[]) => tokens(list.map((m) => contentText(m.content)).join("\n"));

/** Warnings the plugin may write in these scenarios; any other is a new outcome to look at. */
const KNOWN_WARNINGS = [
  "turn failed fast",
  "Claude session lost; the chat moves to a new transcript",
  "stopping an earlier turn still running for this chat",
  "mid-stream turn error",
  "stream iterator failed",
  // A fork through a tool step, then a message: the results with no parked turn.
  "tool results arrived with no parked turn; rebuilding the turn with them",
  // A copy for a fork that failed (counted apart from the made ones).
  "forked chat",
];
const PLAN_LINE = /\[opencode-claude\] (resuming the chat's Claude transcript|starting a new Claude transcript; transferring history) (\{.*\})$/;
const FORK_LINE = /\[opencode-claude\] forked chat (\{.*\})$/;
/** A request the user stopped while its turn was planned: its plan line starts no query. */
const DROPPED_LINE = /\[opencode-claude\] the request was dropped before its turn started; Claude is not started (\{.*\})$/;
const FORK_OUTCOMES = ["forked", "no-session", "nothing-before", "failed"];

async function main() {
  const w = await createForkWorld();
  const { state, queries, answers, chainTo, recordText } = w;
  let plugin = await w.startPlugin();
  let n = 0;
  const token = (kind: string) => `${kind}${++n}`;

  const seeds = process.env.MONKEY_SEED
    ? [Number(process.env.MONKEY_SEED)]
    : Array.from({ length: Number(process.env.MONKEY_SEEDS ?? 12) }, (_, i) => i + 1);
  const steps = Number(process.env.MONKEY_STEPS ?? 30);

  /** What Claude got at each query of these requests, against the request's list. */
  const checkQueries = (requests: Request[], what: string) => {
    for (const request of requests) {
      for (const query of request.queries) {
        if (query.kind !== "chat" || !query.trigger) continue;
        assert.deepEqual(
          tokens(query.view),
          listTokens(request.list),
          `${what}: Claude got what the request held (${query.name}@${query.at}, ${query.outcome}):\n${query.view}\n`,
        );
      }
    }
  };
  /** After a turn: the transcript's chain down to the answer is the last request and the answer. */
  const checkAnswer = (requests: Request[], what: string) => {
    const last = requests.at(-1)!;
    const answer = tokens(last.text ?? "").at(-1);
    assert.ok(answer, `${what}: Claude answered`);
    const where = answers.get(answer!);
    assert.ok(where, `${what}: ${answer} is in a transcript`);
    const chain = chainTo(where!.name, where!.uuid).map(recordText).join("\n");
    assert.deepEqual(tokens(chain), [...listTokens(last.list), answer], `${what}: the transcript down to ${answer} is the conversation`);
  };
  /** The journal of one action: known lines only, one plan line per chat query, on the query's transcript. */
  const checkJournal = (lines: string[], started: ClaudeQuery[], what: string) => {
    for (const line of lines) {
      // A query that could not start (the simulator's spawn failure) is the
      // one error the proxy reports at the error level.
      if (/ level=error /.test(line)) {
        assert.ok(line.includes("chat completions error Claude Code process exited with code 1"), `${what}: error in the journal: ${line}`);
      }
      if (/ level=warn /.test(line)) {
        assert.ok(KNOWN_WARNINGS.some((known) => line.includes(known)), `${what}: unknown warning: ${line}`);
      }
    }
    // A plan line, unless the same chat's request was dropped after it was
    // planned (`planned: true`): that request starts no query.
    const planned: Array<{ chat: string; transcript: string; dropped: boolean }> = [];
    for (const line of lines) {
      const plan = PLAN_LINE.exec(line);
      if (plan) {
        const fields = JSON.parse(plan[2]!) as { conversationKey: string; transcript: string };
        planned.push({ chat: fields.conversationKey, transcript: fields.transcript, dropped: false });
        continue;
      }
      const dropped = DROPPED_LINE.exec(line);
      if (!dropped) continue;
      const fields = JSON.parse(dropped[1]!) as { conversationKey: string; planned: boolean };
      if (!fields.planned) continue;
      const last = planned.findLast((p) => p.chat === fields.conversationKey && !p.dropped);
      assert.ok(last, `${what}: a request dropped after its plan has a plan line`);
      last.dropped = true;
    }
    const plans = planned.filter((p) => !p.dropped).map((p) => p.transcript);
    // A fork's first turn copies its parent's transcript: a "forked chat" line, then its plan line.
    const forks = lines.flatMap((line) => {
      const match = FORK_LINE.exec(line);
      return match ? [JSON.parse(match[1]!) as { id: string; outcome: string; epoch?: string; transcript?: string }] : [];
    });
    for (const fork of forks) assert.ok(FORK_OUTCOMES.includes(fork.outcome), `${what}: known fork outcome: ${JSON.stringify(fork)}`);
    const chatQueries = started.filter((q) => q.kind === "chat").map((q) => q.name);
    assert.deepEqual(plans, chatQueries, `${what}: one plan line per chat query, naming its transcript`);
    // A first turn that failed before it wrote is retried on the same copy name.
    for (const fork of forks.filter((f) => f.outcome === "forked")) {
      const key = `${fork.id}/${fork.epoch}`;
      const made = madeCopies.get(key);
      assert.ok(!made || made === fork.transcript, `${what}: one copy per fork and epoch (${key}: ${made}, then ${fork.transcript})`);
      madeCopies.set(key, fork.transcript!);
    }
  };
  /** The copy made for each fork and epoch: never a second one. */
  const madeCopies = new Map<string, string>();

  for (const seed of seeds) {
    const random = rng(seed);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
    const chance = (p: number) => random() < p;
    const chats: string[] = [];
    const done: string[] = [];
    const note = (text: string) => done.push(text);
    let running = "the first turn";
    const seedStart = n;
    state.foreignHook = chance(0.3);

    const where = () => `seed ${seed}, step ${done.length}`;
    /** A turn of Claude's that must pass; its queries and answer checked. */
    const claudeTurn = async (chat: string, options: Parameters<typeof w.turn>[1] = {}) => {
      const r = await w.turn(chat, options);
      const what = `${where()}: turn of ${chat}`;
      checkQueries(r.requests, what);
      assert.ok(r.ok, `${what}: answered (statuses ${r.requests.map((q) => q.status).join(", ")})`);
      checkAnswer(r.requests, what);
      return r;
    };
    const failures = (count: number, kinds: ClaudeFailure[]) => Array.from({ length: count }, () => pick(kinds));
    /** Every message a fork can be made from: not the queue, not an answer still being written. */
    const forkPoints = (chat: string) => w.session(chat).messages.filter((m) => !m.queued && !m.pending);
    const onScreenUsers = (chat: string) => w.visible(w.session(chat)).filter((m) => m.type === "user");

    try {
      const first = w.newChat();
      chats.push(first);
      await w.say(first, token("q"));
      await claudeTurn(first);
      note(`new chat ${first}, first turn${state.foreignHook ? " (another plugin rewrites the list)" : ""}`);

      for (let step = 0; step < steps; step++) {
        const chat = pick(chats);
        const action = pick([
          "claude", "claude", "claude", "tool", "toolSteer", "other", "failed", "failedThenOther", "flaky", "zombie",
          "revert", "revert", "compact", "compactElsewhere",
          "fork", "fork", "fork", "forkMidAnswer", "forkRace", "queueTwo", "queueBoth", "between", "restart",
          "stop", "stopParked", "revertCancelled", "deleteParent", "import",
        ]);
        running = `${action} on ${chat}`;
        const journalBefore = w.journal().length;
        const queriesBefore = queries.length;
        let label = "";
        switch (action) {
          case "claude": {
            await w.say(chat, token("q"));
            await claudeTurn(chat);
            label = `${chat}: claude turn`;
            break;
          }
          case "tool":
          case "toolSteer": {
            await w.say(chat, token("q"));
            state.toolTurn = true;
            await claudeTurn(chat, { toolOutput: token("t"), ...(action === "toolSteer" ? { steer: token("q") } : {}) });
            label = `${chat}: claude turn with a tool${action === "toolSteer" ? ", a message sent while it ran" : ""}`;
            break;
          }
          case "other": {
            await w.say(chat, token("q"));
            w.otherModelAnswer(chat, token("o"));
            label = `${chat}: other model's turn`;
            break;
          }
          case "failed": {
            await w.say(chat, token("q"));
            state.failures = failures(11, ["spawn", "api", "killed"]);
            const r = await w.turn(chat);
            state.failures = [];
            checkQueries(r.requests, `${where()}: failed turn of ${chat}`);
            assert.ok(!r.ok, `${where()}: the turn of ${chat} fails on every retry`);
            label = `${chat}: failed turn`;
            break;
          }
          case "failedThenOther": {
            // Claude's turn fails on every retry, possibly after its record
            // was written; the user has another model answer the same
            // question, then asks Claude again.
            await w.say(chat, token("q"));
            state.failures = failures(11, ["spawn", "api", "killed"]);
            const r = await w.turn(chat);
            state.failures = [];
            checkQueries(r.requests, `${where()}: failed turn of ${chat}`);
            assert.ok(!r.ok, `${where()}: the turn of ${chat} fails on every retry`);
            w.otherModelAnswer(chat, token("o"));
            await w.say(chat, token("q"));
            await claudeTurn(chat);
            label = `${chat}: failed turn, another model answered it, then a claude turn`;
            break;
          }
          case "flaky": {
            await w.say(chat, token("q"));
            state.failures = failures(1 + Math.floor(random() * 3), ["spawn", "api", "killed"]);
            const kinds = state.failures.join(", ");
            await claudeTurn(chat);
            label = `${chat}: turn failed (${kinds}), then passed on retry`;
            break;
          }
          case "zombie": {
            await w.say(chat, token("q"));
            state.failures = ["zombie"];
            await claudeTurn(chat);
            for (const finish of state.zombies.splice(0)) finish();
            await w.say(chat, token("q"));
            await claudeTurn(chat);
            label = `${chat}: killed turn passed on retry, the killed process answered later, then a turn`;
            break;
          }
          case "revert": {
            const users = onScreenUsers(chat);
            if (users.length < 2) break;
            const to = pick(users.slice(1));
            w.undoBefore(chat, to.id);
            // The same text again half the time: the text of an undone record.
            const same = chance(0.5);
            await w.say(chat, same ? to.text : token("q"));
            if (chance(0.5)) {
              await claudeTurn(chat);
              label = `${chat}: revert to ${to.text}${same ? " (same text)" : ""}, claude turn`;
            } else {
              w.otherModelAnswer(chat, token("o"));
              label = `${chat}: revert to ${to.text}${same ? " (same text)" : ""}, other model's turn`;
            }
            break;
          }
          case "compact":
          case "compactElsewhere": {
            if (w.visible(w.session(chat)).length < 2) break;
            if (action === "compact") {
              const c = await w.compact(chat);
              for (const query of c.queries) {
                assert.deepEqual(tokens(query.view), listTokens(c.list), `${where()}: the summary of ${chat} got the summarized part`);
              }
            } else {
              await w.compactElsewhere(chat);
            }
            await w.say(chat, token("q"));
            await claudeTurn(chat);
            label = `${chat}: compaction${action === "compact" ? "" : " by another model"}, then a turn`;
            break;
          }
          case "fork": {
            const points = forkPoints(chat);
            if (points.length === 0) break;
            // Half the time from the newest message, as users mostly do; else anywhere.
            const point = chance(0.5) ? points.at(-1)! : pick(points);
            const boundary = point.type === "assistant" ? w.through(point.id) : w.before(point.id);
            const files = w.snapshot();
            const asleep = chance(0.25);
            if (asleep) await w.stopPlugin(plugin);
            const child = await w.fork(chat, boundary);
            if (asleep) plugin = await w.startPlugin();
            chats.push(child);
            await w.say(child, token("q"));
            await claudeTurn(child);
            const after = w.snapshot();
            for (const [file, text] of files) assert.equal(after.get(file), text, `${where()}: the fork left ${file} unchanged`);
            label = `${chat}: fork ${boundary.type} ${point.type} "${point.text}"${asleep ? " (plugin asleep)" : ""} → ${child}, first turn`;
            break;
          }
          case "forkMidAnswer": {
            await w.say(chat, token("q"));
            let release!: () => void;
            state.hold = new Promise<void>((resolve) => (release = resolve));
            const running = w.turn(chat);
            await new Promise((resolve) => setTimeout(resolve, 20));
            const child = await w.fork(chat, w.through(w.lastId(chat)));
            release();
            const r = await running;
            checkQueries(r.requests, `${where()}: the held turn of ${chat}`);
            assert.ok(r.ok);
            checkAnswer(r.requests, `${where()}: the held turn of ${chat}`);
            chats.push(child);
            await w.say(child, token("q"));
            await claudeTurn(child);
            label = `${chat}: fork of the whole chat while answering → ${child}, first turn`;
            break;
          }
          case "forkRace": {
            const points = forkPoints(chat);
            if (points.length === 0) break;
            const point = chance(0.5) ? points.at(-1)! : pick(points);
            const boundary = point.type === "assistant" ? w.through(point.id) : w.before(point.id);
            const child = await w.fork(chat, boundary, { silent: true });
            chats.push(child);
            await w.say(child, token("q"));
            await Promise.all([withTimeout(w.emit(w.forkEvent(child)), 5_000, "fork event"), claudeTurn(child)]);
            label = `${chat}: fork ${boundary.type} "${point.text}" → ${child}, event and first turn at once`;
            break;
          }
          case "queueTwo":
          case "queueBoth": {
            const a = await w.queue(chat, token("q"));
            const b = await w.queue(chat, token("q"));
            w.deliver(chat, a);
            if (action === "queueTwo") await claudeTurn(chat);
            w.deliver(chat, b);
            await claudeTurn(chat);
            label = `${chat}: two messages queued, delivered ${action === "queueTwo" ? "one by one" : "together"}`;
            break;
          }
          case "between": {
            const kind = pick(["synthetic", "shell", "skill", "reminder", "location"] as const);
            if (kind === "reminder") w.between(chat, "synthetic", "<system-reminder>\nYou are in Plan mode.\n</system-reminder>");
            else w.between(chat, kind, token(kind === "synthetic" ? "s" : kind === "shell" ? "sh" : kind === "location" ? "d" : "k"));
            await w.say(chat, token("q"));
            await claudeTurn(chat);
            label = `${chat}: a ${kind} message between turns, then a turn`;
            break;
          }
          case "restart": {
            await w.stopPlugin(plugin);
            plugin = await w.startPlugin();
            label = "plugin restarted";
            break;
          }
          case "stop": {
            // The user stops the turn while Claude answers; then asks again.
            await w.say(chat, token("q"));
            let release!: () => void;
            state.hold = new Promise<void>((resolve) => (release = resolve));
            const controller = new AbortController();
            const running = w.turn(chat, { stop: controller.signal });
            await new Promise((resolve) => setTimeout(resolve, 20));
            controller.abort();
            const r = await running;
            release();
            // A CLI process still starting at the stop reaches Claude Code later: wait until no query of the stopped
            // turn is running and none came for a second, so the next turn's requests count only their own queries.
            for (let waited = 0, quiet = 0, seen = queries.length; quiet < 1_000; waited += 10) {
              assert.ok(waited < 15_000, `${where()}: the stopped turn's CLI ended`);
              await new Promise((resolve) => setTimeout(resolve, 10));
              const settled = queries.length === seen && !queries.slice(queriesBefore).some((q) => q.endedAt === undefined);
              quiet = settled ? quiet + 10 : 0;
              seen = queries.length;
            }
            checkQueries(r.requests, `${where()}: the stopped turn of ${chat}`);
            assert.ok(!r.ok, `${where()}: the turn of ${chat} was stopped`);
            await w.say(chat, token("q"));
            await claudeTurn(chat);
            label = `${chat}: turn stopped while answering, then a turn`;
            break;
          }
          case "stopParked": {
            // The user stops the turn while its tool runs (Claude parked on the call); then asks again.
            await w.say(chat, token("q"));
            state.toolTurn = true;
            const r = await w.turn(chat, { stopParked: true });
            checkQueries(r.requests, `${where()}: the stopped turn of ${chat}`);
            assert.ok(!r.ok, `${where()}: the turn of ${chat} was stopped`);
            await w.say(chat, token("q"));
            const journalAt = w.journal().length;
            await claudeTurn(chat);
            // The CLI's "[Request interrupted…]" record is the stopped turn's own, not a reverted message.
            const plan = w.journal().slice(journalAt).map((line) => PLAN_LINE.exec(line)).filter(Boolean).at(-1);
            assert.ok(!plan || JSON.parse(plan[2]!).copyFor !== "revert", `${where()}: no copy for a revert after the stop`);
            label = `${chat}: turn stopped while its tool ran, then a turn`;
            break;
          }
          case "revertCancelled": {
            // A revert staged and cancelled before anything is sent: OpenCode's context does not change.
            await w.say(chat, token("q"));
            await claudeTurn(chat);
            label = `${chat}: revert staged and cancelled, then a turn`;
            break;
          }
          case "deleteParent": {
            const points = forkPoints(chat);
            if (points.length === 0 || chats.length < 2) break;
            const point = pick(points);
            const boundary = point.type === "assistant" ? w.through(point.id) : w.before(point.id);
            const child = await w.fork(chat, boundary);
            await w.remove(chat);
            chats.splice(chats.indexOf(chat), 1);
            chats.push(child);
            await w.say(child, token("q"));
            await claudeTurn(child);
            label = `${chat}: fork ${boundary.type} "${point.text}" → ${child}, ${chat} deleted, first turn`;
            break;
          }
          case "import": {
            const copy = w.importChat(chat);
            chats.push(copy);
            await w.say(copy, token("q"));
            await claudeTurn(copy);
            label = `${chat}: imported as ${copy}, first turn`;
            break;
          }
        }
        if (!label) continue;
        note(label);
        checkJournal(w.journal().slice(journalBefore), queries.slice(queriesBefore), `${where()}: ${label}`);
      }
    } catch (err) {
      console.error(`\nseed ${seed} failed after ${done.length} actions, in "${running}":\n  ${done.join("\n  ")}\n`);
      throw err;
    }
    // The tokens a seed took (q12, L7, ...) count across the run: a failure's
    // tokens find their seed in an earlier run's output, and the actions with
    // them (MONKEY_ACTIONS=1).
    console.log(`seed ${seed}: ${done.length} actions, ${chats.length} chats, tokens ${seedStart + 1}-${n}, ok`);
    if (process.env.MONKEY_ACTIONS) console.log(`  ${done.join("\n  ")}`);
  }
  await w.dispose();
  console.log("ok — fork monkey passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
