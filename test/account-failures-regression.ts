/**
 * A failed model call reaches OpenCode as a real HTTP error of the kind the
 * SDK states, also on the continuation after a tool call:
 * - the SDK names the kind in the synthetic assistant record's `error` and
 *   the refused call's HTTP status in the error result's `api_error_status`;
 *   Claude Code words one kind differently from case to case, so the code
 *   decides, the text only when the code is general;
 * - seen live: the subscription payment was past due, the call after a tool
 *   result was refused with `oauth_org_not_allowed`, and the continuation
 *   answered 200 with the refusal as the answer's text; a refused account on
 *   a turn's first response was a 500, which OpenCode retries ten times.
 *
 * On the simulators (test/simulators/): Claude Code refuses the call as CLI
 * 2.1.312 reports it against a stub that refuses it (`state.failures` with
 * an ApiFailure: `oauthOrg`, `permission`, `authentication`,
 * `creditBalance`, `billing`, `imageTooLarge`,
 * `serverError`, `overloaded`, `rateLimit`, `maxTokens`, and the codes of
 * their own: `verificationRequired`, `cloudCredentials` (Bedrock without AWS
 * credentials: the query's environment names the provider, so the plugin's
 * process has CLAUDE_CODE_USE_BEDROCK for the turn), `accountOnHold`,
 * `modelNotFound`; BEHAVIOR.md "Failures of a model call"); the call after
 * the first tool step: `state.failingCall` 2; Claude still thinking after
 * the tool results: `state.hold`. The OpenCode simulator reads the reply and
 * retries as OpenCode 2.0.32 does (`failureOf`, `opencode.retries`); its
 * requests always stream. The kind the plugin read, from its journal; the
 * plain texts through the plugin's own classifier (`pluginModule("failure")`).
 * After a limit the plugin's limit store is emptied: the window has passed.
 * The turns: test/simulators/turns.ts. A prompt too long ("Prompt is too
 * long", the overflow OpenCode compacts on) is
 * account-failures-prompt-too-long-regression.ts: it needs the CLI's own
 * compaction off too (fix/cli-autocompact), which this PR's tree lacks.
 *
 * Run: bun test/account-failures-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { failureOf } from "./simulators/opencode.ts";
import { errorOf, failingTurn, statedKind, windowPassed } from "./simulators/turns.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

async function main() {
  const world = await createWorld("account-failures");
  const { opencode, claude } = world;
  const cases = testCases();

  try {
    await opencode.startPlugin();

    // --- A refused account: a real error of its kind, on the turn's first
    // response and on the continuation after a tool call; OpenCode does not
    // send it again.
    for (const [failure, status, code, said] of [
      ["oauthOrg", 403, "claude_account", /organization has disabled Claude subscription access/],
      ["permission", 401, "claude_auth", /does not have permission to use this model/],
      ["creditBalance", 402, "claude_extra_usage", /Credit balance is too low/],
      // A 402 the CLI marks `unknown`: billing by its status and its text.
      ["billing", 402, "claude_extra_usage", /payment is past due/],
    ] as const) {
      for (const call of [1, 2] as const) {
        await cases.run(`${failure} on model call ${call}: a ${status} ${code} OpenCode does not send again`, async () => {
          const { turn, failed, queries, retries } = await failingTurn(world, failure, call);
          const where = `${failure}, model call ${call}`;
          assert.equal(failed.status, status, `${where}: a real error, not a 200 answer: ${failed.reply?.raw}`);
          const error = errorOf(failed);
          assert.equal(error.code, code, where);
          assert.match(error.message ?? "", said, `${where}: the CLI's words reach the user`);
          assert.equal(failureOf(failed.reply!)?.retryable, false, `${where}: a failure OpenCode does not retry`);
          assert.ok(!turn.ok);
          assert.equal(turn.requests.length, call, `${where}: no request after the failed one`);
          assert.deepEqual(retries, [], `${where}: OpenCode does not send it again`);
          assert.equal(queries.length, 1, `${where}: one Claude Code query`);
        });
      }
    }

    await cases.run("a server failure on the continuation is retried, and the retry gets the tool's result in a new process", async () => {
      // The retry (the same tool result again, the turn's process gone) runs the turn on in a new process.
      const { turn, failed, queries, retries } = await failingTurn(world, "serverError", 2, { toolOutput: "TOOL-DONE" });
      assert.notEqual(failed.status, 200, `a real error, not a 200 answer: ${failed.reply?.raw}`);
      assert.equal(failureOf(failed.reply!)?.retryable, true, `OpenCode retries it: ${failed.reply?.raw}`);
      assert.equal(retries.length, 1, "OpenCode sent it again once");
      assert.ok(turn.ok, `the retry answered: ${turn.requests.map((r) => r.status).join(",")}`);
      assert.equal(queries.length, 2, "the retry ran the turn on in a new process");
      assert.match(queries[1]!.view, /TOOL-DONE/, "Claude got the tool's result in the new process");
    });

    await cases.run("stopped while the continuation holds its head: the turn is interrupted and its process closed", async () => {
      // Claude still thinking, no content yet: OpenCode's stop reaches the turn through the session event, not
      // through the HTTP stream, so the turn is interrupted, its process closed, and the held response ends.
      const chat = opencode.newChat();
      await opencode.say(chat, "run it");
      claude.state.toolTurn = true;
      claude.state.hold = new Promise<void>(() => {});
      const stop = new AbortController();
      const queries = claude.queries.length;
      const retries = opencode.retries.length;
      try {
        const turn = await opencode.turn(chat, {
          stop: stop.signal,
          toolOutput: () => {
            // The user stops the turn once the tool's result went to Claude.
            setTimeout(() => stop.abort(), 200);
            return "done";
          },
        });
        assert.ok(turn.stopped, "the turn was stopped");
        assert.equal(turn.requests.length, 2, "the request with the calls, the held continuation");
        const [query] = claude.queries.slice(queries);
        assert.equal(claude.queries.length - queries, 1);
        // The stop returns at once; the plugin interrupts and closes the process right after.
        for (let waited = 0; (query!.closedAt === undefined || query!.endedAt === undefined) && waited < 3_000; waited += 20) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(query!.closedAt !== undefined, "its process was closed");
        assert.ok(query!.endedAt !== undefined, "its stream ended");
        assert.ok(
          claude.records(query!.name).some((r) => r.type === "user" && JSON.stringify(r.message?.content ?? "").includes("[Request interrupted by user]")),
          "the turn was interrupted",
        );
        assert.equal(opencode.retries.length, retries, "OpenCode does not repeat a stopped request");
      } finally {
        claude.state.toolTurn = false;
        claude.state.hold = undefined;
      }
    });

    await cases.run("a plan limit on the continuation: 429 with the countdown, OpenCode's retries meet the gate", async () => {
      // The continuation was this request's attempt, so OpenCode's retries of it meet the gate without starting
      // Claude Code again.
      try {
        const { failed, turn, queries, retries } = await failingTurn(world, "rateLimit", 2);
        assert.equal(failed.status, 429, failed.reply?.raw);
        assert.equal(errorOf(failed).code, "claude_session_limit");
        assert.ok(failed.reply!.headers.get("retry-after"), "the countdown reaches OpenCode");
        assert.ok(retries.length >= 1, "OpenCode retries a rate limit");
        assert.ok(turn.requests.slice(1).every((r) => r.status === 429), `every retry meets the gate: ${turn.requests.map((r) => r.status).join(",")}`);
        assert.equal(queries.length, 1, "the gate answers OpenCode's retries without a Claude Code process");
      } finally {
        windowPassed();
      }
    });

    // --- What the SDK states decides the kind, on the turn's first response
    // and on the continuation: the synthetic record's code when it names
    // one, else the error result's HTTP status (401, 402; a 403 names none),
    // else the text. The kind as the plugin's journal names it.
    for (const [failure, kind, why] of [
      ["authentication", "auth", "authentication_failed, 401"],
      ["permission", "auth", "authentication_failed under a 403: the code, not the status"],
      ["oauthOrg", "account", "oauth_org_not_allowed under a 403"],
      ["verificationRequired", "account", "verification_required under a 403"],
      ["accountOnHold", "account", "account_on_hold, no status"],
      ["creditBalance", "billing", "billing_error under a 400"],
      ["billing", "billing", "unknown under a 402: the status"],
      ["rateLimit", "rate_limit", "rate_limit, 429"],
      ["imageTooLarge", "image", "invalid_request under a 400: the text"],
      ["serverError", "unknown", "server_error under a 500: the text"],
      ["overloaded", "unknown", "server_error under a 529: the text"],
      ["modelNotFound", "unknown", "model_not_found under a 404: the text, which names no kind"],
    ] as const) {
      for (const call of [1, 2] as const) {
        await cases.run(`the kind of ${failure} on model call ${call} is ${kind} (${why})`, async () => {
          const { kind: stated, stated: line } = await statedKind(world, failure, call);
          assert.equal(stated, kind, `${failure}, model call ${call}: ${line}`);
        });
      }
    }
    // Bedrock without AWS credentials: the query's environment names the provider (the plugin passes
    // CLAUDE_CODE_USE_BEDROCK on to the CLI), no request reaches the API, no status.
    for (const call of [1, 2] as const) {
      await cases.run(`the kind of cloudCredentials on model call ${call} is auth (cloud_credential_error, no status)`, async () => {
        const before = process.env.CLAUDE_CODE_USE_BEDROCK;
        process.env.CLAUDE_CODE_USE_BEDROCK = "1";
        try {
          const { kind: stated, stated: line } = await statedKind(world, "cloudCredentials", call);
          assert.equal(stated, "auth", `cloudCredentials, model call ${call}: ${line}`);
        } finally {
          if (before === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
          else process.env.CLAUDE_CODE_USE_BEDROCK = before;
        }
      });
    }

    await cases.run("max_output_tokens after the cut answer streamed: the text decides", async () => {
      const lines = world.journal().length;
      const { failed } = await failingTurn(world, "maxTokens", 1);
      assert.equal(failed.status, 200, "the cut answer streamed");
      const midStream = world.journal().slice(lines).find((line) => /mid-stream turn error/.test(line));
      assert.equal(midStream?.match(/"kind":"([a-z_]+)"/)?.[1], "unknown", `max_output_tokens: ${midStream}`);
    });

    await cases.run("the wordings of the texts: the one seen live under oauth_org_not_allowed names no kind, a 402's names billing", async () => {
      const { classifyClaudeFailure, failureStatusFor } = await pluginModule("failure");
      // The wording seen live under `oauth_org_not_allowed` names no kind: the code decides.
      assert.equal(
        classifyClaudeFailure(
          "Claude Code can't use your Claude subscription, usually because a payment is past due · Pay or renew at https://claude.ai/settings/billing (if you just paid, try again shortly), or use an Anthropic API key instead",
        ),
        "unknown",
      );
      assert.equal(classifyClaudeFailure("API Error: 402 Payment required: your subscription payment is past due."), "billing");
      assert.equal(failureStatusFor("account"), 403);
    });

    await cases.run("the failures are warnings naming their kind; no error in the plugin's journal", () => {
      const failedFast = world.journal().filter((line) => /turn failed fast/.test(line));
      for (const kind of ["account", "auth", "billing", "rate_limit"]) {
        assert.ok(failedFast.some((line) => line.includes(`"kind":"${kind}"`)), `the journal names the ${kind} failure`);
      }
      assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    });
  } finally {
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
