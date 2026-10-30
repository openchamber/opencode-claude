/**
 * Regression: the plugin's setup registers the hooks the names rely on, and
 * they do what the proxy expects (context-list.ts):
 * - `prompt`, for every model: the message's own id goes into its metadata,
 *   so a fork's copy (new id, same metadata) is named after the original;
 * - `context`, Claude only: the event is kept by reference for the request
 *   that follows, taken once, one per request;
 * - `compaction`, Claude only: kept for the whole compaction, until
 *   OpenCode's compaction.ended/failed event.
 *
 * On the simulators (test/simulators/): the plugin's real setup in the
 * OpenCode simulator (the hooks and scopes it registered); messages, forks and
 * turns in OpenCode run the hooks. A turn the user stops after its hooks ran
 * and before its HTTP request leaves the list of a request that never came: the
 * test reads the plugin's store of lists (`pluginModule("context-list")`)
 * after such turns, so no request of the plugin's own takes them first. Another
 * plugin's hook after the plugin's own (`state.foreignHook`) holds the event
 * OpenCode builds the request from. Compactions with a retry (OpenCode's
 * clock `state.sleep` between the two requests), a second chat's compaction
 * meanwhile, and a summary without the template that fails; what Claude was
 * asked is in `claude.queries`; the plugin's journal holds no error.
 *
 * Run: bun test/hooks-regression.ts
 *      $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>"; bun test/hooks-regression.ts
 */
import assert from "node:assert/strict";

import type { ContextEvent } from "./simulators/opencode.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

/** The key of a message's own id in its OpenCode metadata (the plugin's id). */
const ORIGINAL_ID = "openchamber.claude-code";

async function main() {
  const world = await createWorld("hooks");
  const { opencode, claude } = world;
  try {
    const instance = await opencode.startPlugin();
    const { PROVIDER_ID } = await pluginModule("constants");
    const { peekCompactionEvent, takeContextEvent } = await pluginModule("context-list");

    // Registered, with the right scope.
    assert.ok(instance.hooks["model.request"], "model.request hook");
    assert.ok(instance.hooks.prompt, "prompt hook");
    assert.ok(instance.hooks.context, "context hook");
    assert.ok(instance.hooks.compaction, "compaction hook");
    assert.equal(instance.scopes.prompt?.providerID, undefined, "prompt runs for every model");
    assert.equal(instance.scopes.context?.providerID, PROVIDER_ID, "context runs for Claude only");
    assert.equal(instance.scopes.compaction?.providerID, PROVIDER_ID, "compaction runs for Claude only");
    assert.equal(PROVIDER_ID, "claude-code", "the provider OpenCode's requests name");

    // Every context and compaction event, as another plugin's hook after the plugin's own sees it;
    // `rewrite`: that plugin changes the event. `kept`: the plugin's compaction list at that moment.
    const hooked: Array<{ event: ContextEvent; kept: boolean }> = [];
    let rewrite: ((event: ContextEvent) => void) | undefined;
    opencode.state.foreignHook = (event) => {
      hooked.push({ event, kept: peekCompactionEvent(event.sessionID) === event });
      rewrite?.(event);
    };
    const lastHooked = () => hooked.at(-1)!.event;

    /** A turn the user stops after its hooks ran, before its HTTP request: the request never reaches the plugin. */
    const stoppedTurn = async (chat: string) => {
      const queries = claude.queries.length;
      const stop = new AbortController();
      stop.abort();
      const turn = await opencode.turn(chat, { stop: stop.signal });
      assert.ok(turn.stopped, "the turn was stopped");
      assert.equal(turn.requests.length, 1);
      assert.equal(turn.requests[0]!.status, 0, "no reply: the request was not sent");
      assert.equal(claude.queries.length, queries, "Claude was not asked");
      return turn;
    };

    // prompt: the message keeps its id in its metadata.
    const chat = opencode.newChat();
    const asked = await opencode.say(chat, "Q-hooks first");
    assert.deepEqual(opencode.session(chat).messages.at(-1)!.metadata, { [ORIGINAL_ID]: asked });
    // Other metadata (the client's own) kept beside it; the message then leaves the chat.
    const own = await opencode.say(chat, "Q-hooks with metadata", undefined, { metadata: { mine: 1 } });
    assert.deepEqual(opencode.session(chat).messages.at(-1)!.metadata, { mine: 1, [ORIGINAL_ID]: own });
    opencode.undoBefore(chat, own);

    // A fork's copy: a new id, the original's id in its metadata, in the list the fork's request is built from.
    const child = await opencode.fork(chat, opencode.through(asked));
    const forked = await stoppedTurn(child);
    const copy = forked.requests[0]!.list.find((message) => message.role === "user")!;
    assert.notEqual(copy.id, asked, "the copy has an id of its own");
    assert.equal(copy.metadata?.[ORIGINAL_ID], asked, "the copy is named after the original");
    const childEvent = lastHooked();

    // context: kept by reference, taken once.
    await stoppedTurn(chat);
    const first = lastHooked();
    assert.equal(first.sessionID, chat);
    assert.equal(takeContextEvent(chat), first, "the same object, not a copy");
    assert.equal(takeContextEvent(chat), undefined, "taken once");
    // The newest pending list is the request's (one OpenCode has no two requests of a chat in
    // flight), an older one was left by a request that never came.
    await stoppedTurn(chat);
    const older = lastHooked();
    await opencode.say(chat, "Q-hooks second");
    await stoppedTurn(chat);
    const newer = lastHooked();
    assert.equal(takeContextEvent(chat), newer, "the newest list");
    assert.equal(takeContextEvent(chat), older, "an older list that fits stays for a request of its own");
    assert.equal(takeContextEvent(chat), undefined, "taken once");
    // Lists are kept by chat.
    assert.equal(takeContextEvent(opencode.newChat()), undefined, "a chat with no request has no list");
    assert.equal(takeContextEvent(child), childEvent, "the fork's list is its own");
    // A hook of another plugin replacing the array is seen through the reference.
    rewrite = (event) => {
      event.messages = [{ id: "msg_99", role: "user", content: [{ type: "text", text: "Q-hooks rewritten by another plugin" }] }];
    };
    let rewritten;
    try {
      rewritten = await stoppedTurn(chat);
    } finally {
      rewrite = undefined;
    }
    const seen = takeContextEvent(chat)!;
    assert.equal(seen.messages[0]!.id, "msg_99");
    assert.equal(seen.messages, rewritten.requests[0]!.list, "the list the request was built from");
    // The next request that reaches the plugin takes the list it was built from and drops a stale one:
    // the proxy reads the lists from chain/turn-by-names on, so that is stopped-request-regression's.

    // The hooks in a turn that reaches Claude: the turn answers, Claude gets the question.
    const answered = opencode.newChat();
    await opencode.say(answered, "Q-hooks answered");
    const turn = await opencode.turn(answered);
    assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
    assert.ok(claude.queries.at(-1)!.view.includes("Q-hooks answered"), "Claude got the question");

    // compaction: kept for the operation, cleared by OpenCode's event.
    const twoTurns = async (target: string, label: string) => {
      for (const n of ["one", "two"]) {
        await opencode.say(target, `Q-${label} ${n}`);
        assert.ok((await opencode.turn(target)).ok, `${label}: turn ${n}`);
      }
    };
    const summarized = opencode.newChat();
    await twoTurns(summarized, "summarized");
    const elsewhere = opencode.newChat();
    await twoTurns(elsewhere, "elsewhere");
    const summaries = () => claude.queries.filter((query) => query.kind === "summary");
    const asks = summaries().length;
    // The first summary request fails and OpenCode sends it again after a wait (one compaction hook,
    // two requests); during the wait another chat compacts to its end.
    claude.state.summaryFailures = ["overloaded"];
    const sleep = opencode.state.sleep;
    let waited = 0;
    let during: { kept: boolean; elsewhere: string; elsewhereCleared: boolean; stillKept: boolean } | undefined;
    opencode.state.sleep = async (ms) => {
      if (waited++ === 0) {
        const event = hooked.findLast((entry) => entry.event.sessionID === summarized)!.event;
        const kept = peekCompactionEvent(summarized) === event;
        const other = await opencode.compact(elsewhere);
        during = { kept, elsewhere: other.status, elsewhereCleared: peekCompactionEvent(elsewhere) === undefined, stillKept: peekCompactionEvent(summarized) === event };
      }
      await sleep(ms);
    };
    let done;
    try {
      done = await opencode.compact(summarized);
    } finally {
      opencode.state.sleep = sleep;
      claude.state.summaryFailures = [];
    }
    assert.equal(done.status, "completed", JSON.stringify(done.error ?? ""));
    assert.equal(done.requests.length, 2, "the failed summary request, then the retry");
    assert.equal(hooked.filter((entry) => entry.event.sessionID === summarized && entry.kept).length, 1, "one compaction hook for both requests");
    assert.ok(during, "OpenCode waited before the retry");
    assert.equal(during.kept, true, "kept across requests");
    assert.equal(during.elsewhere, "completed", "the other chat's compaction");
    assert.equal(during.elsewhereCleared, true, "cleared when the compaction ended (the other chat's)");
    assert.equal(during.stillKept, true, "another chat's end leaves it");
    assert.equal(peekCompactionEvent(summarized), undefined, "cleared when the compaction ended");
    const asked3 = summaries().slice(asks);
    assert.equal(asked3.length, 3, "Claude was asked for three summaries: the failed one, the other chat's, the retry");
    assert.ok(asked3.filter((query) => query.view.includes("Q-summarized one")).length === 2, "the failed summary and its retry read the chat");
    assert.ok(asked3.some((query) => query.view.includes("Q-elsewhere one")), "the other chat's summary read that chat");

    // A summary without the template, twice: the compaction fails, its list goes with it.
    await opencode.say(summarized, "Q-summarized three");
    assert.ok((await opencode.turn(summarized)).ok, "the turn after the compaction");
    claude.state.summaryReplies = ["still no headings", "nor here"];
    const failed = await opencode.compact(summarized);
    claude.state.summaryReplies = [];
    assert.equal(failed.status, "failed");
    assert.match(String(failed.error?.message), /did not match the required template/);
    assert.equal(hooked.at(-1)!.event.sessionID, summarized);
    assert.equal(hooked.at(-1)!.kept, true, "kept by the compaction hook");
    assert.equal(peekCompactionEvent(summarized), undefined, "cleared when the compaction failed");

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    console.log("ok — hooks regression passed");
  } finally {
    opencode.state.foreignHook = undefined;
    await world.dispose();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
