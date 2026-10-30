/**
 * Regression: failed turns report what actually went wrong.
 * - Error results carry `errors` and `terminal_reason`, not `result`; the
 *   text comes from `errors` without the CLI's "[ede_diagnostic]" entries,
 *   else from the terminal reason.
 * - A context overflow is a 400 context_length_exceeded that OpenCode
 *   compacts on; an image error is a non-retryable 400.
 * - A meta request that hits its one-step limit says so plainly.
 * - Lost-session detection and dedupe with the SDK's iterator error keep
 *   working on the new text.
 *
 * Run: bun test/turn-errors-regression.ts
 */
import {
  classifyClaudeFailure,
  failureStatusFor,
  resultErrorText,
  thrownErrorText,
} from "../src/failure.ts";
import { assert, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

const DIAG = "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use";

/** OpenCode 2.x context overflow check (packages/ai/src/provider-error.ts), abridged. */
function openCodeSeesOverflow(body: any): boolean {
  return (
    body?.error?.code === "context_length_exceeded" ||
    /prompt is too long|exceeds the context window/i.test(String(body?.error?.message))
  );
}

async function main() {
  // Text sources.
  assert.equal(
    resultErrorText({ type: "result", subtype: "error_during_execution", is_error: true, errors: [DIAG], terminal_reason: "prompt_too_long" }),
    "Prompt is too long: the conversation exceeds the context window.",
  );
  assert.equal(
    resultErrorText({ type: "result", subtype: "error_during_execution", is_error: true, errors: [DIAG, "API Error: 500 boom"] }),
    "API Error: 500 boom",
  );
  assert.equal(
    resultErrorText({ type: "result", subtype: "success", is_error: true, result: "Prompt is too long" }),
    "Prompt is too long",
  );
  assert.match(resultErrorText({ type: "result", subtype: "error_max_turns", is_error: true, errors: [] }), /turn limit/);
  assert.equal(resultErrorText({ type: "result", subtype: "error_during_execution", is_error: true, errors: [] }), "Claude turn failed");
  assert.equal(thrownErrorText(new Error(`Claude Code returned an error result: ${DIAG}`)), null);
  assert.equal(
    thrownErrorText(new Error(`Claude Code returned an error result: No conversation found; ${DIAG}`)),
    "Claude Code returned an error result: No conversation found",
  );
  assert.equal(thrownErrorText(new Error("spawn failed")), "spawn failed");
  assert.equal(classifyClaudeFailure("Prompt is too long"), "context_overflow");
  // Anthropic moving third-party usage off the plan is an account decision:
  // 402, which OpenCode doesn't retry, never a retryable 500.
  assert.equal(classifyClaudeFailure("API Error: 400 Third-party apps now draw from extra usage, not plan limits"), "billing");
  assert.equal(failureStatusFor("billing"), 402);
  assert.equal(classifyClaudeFailure('API Error: 400 {"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}'), "context_overflow");
  assert.equal(classifyClaudeFailure("API Error: 400 messages.0.content.1.image.source.base64: image exceeds 5 MB maximum"), "image");
  assert.equal(classifyClaudeFailure("Could not process image"), "image");
  assert.equal(classifyClaudeFailure("API Error: 500 boom"), "unknown");

  const { post, port, proxy } = await startMockedProxy("turn-errors");
  const { setForeignSessionId, getForeignSessionId } = await import("../src/session-store.ts");
  const failWith = (events: unknown[], thrown?: string) =>
    proxy.setClaudeQueryStarter(async () =>
      mockHandle(
        (async function* () {
          yield* events;
          if (thrown) throw new Error(thrown);
        })(),
      ),
    );
  try {
    // Context overflow before any output → 400 OpenCode compacts on, both modes.
    for (const stream of [true, false]) {
      failWith(
        [{ type: "result", subtype: "error_during_execution", is_error: true, errors: [DIAG], terminal_reason: "prompt_too_long" }],
        `Claude Code returned an error result: ${DIAG}`,
      );
      const res = await post(`overflow-${stream}`, { stream, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error.type, "invalid_request_error");
      assert.equal(body.error.code, "context_length_exceeded");
      assert.ok(openCodeSeesOverflow(body));
      assert.doesNotMatch(body.error.message, /ede_diagnostic/);
    }

    // Buffered: overflow after partial text still returns the 400.
    failWith([textDelta("partial"), { type: "result", subtype: "success", is_error: true, result: "Prompt is too long" }]);
    {
      const res = await post("overflow-late", { stream: false, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 400);
      assert.ok(openCodeSeesOverflow(await res.json()));
    }

    // Image errors → non-retryable 400.
    failWith([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [DIAG, "API Error: 400 messages.0.content.1.image.source.base64: image exceeds 5 MB maximum"],
      },
    ]);
    {
      const res = await post("image", { stream: true, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 400);
      const body = (await res.json()) as any;
      assert.equal(body.error.type, "invalid_request_error");
      assert.equal(body.error.code, "claude_image_error");
      assert.match(body.error.message, /image exceeds 5 MB/);
    }

    // A title request that ran out of its single step.
    failWith([{ type: "result", subtype: "error_max_turns", is_error: true, errors: [], terminal_reason: "max_turns" }]);
    {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": "title-chat",
          "x-opencode-claude-kind": "title",
        },
        body: JSON.stringify({ model: "sonnet", stream: false, messages: [{ role: "user", content: "hi" }] }),
      });
      const body = (await res.json()) as any;
      assert.equal(res.status, 500);
      assert.match(body.error.message, /could not write the session title in the single step/);
    }

    // A lost session reported through errors[] still clears the binding.
    setForeignSessionId("lost-chat", "sess-gone");
    failWith(
      [{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: sess-gone"] }],
      "Claude Code returned an error result: No conversation found with session ID: sess-gone",
    );
    {
      const res = await post("lost-chat", { stream: true, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 500);
      assert.equal(getForeignSessionId("lost-chat"), undefined);
    }

    // Mid-stream: the error shows once, without diagnostics.
    failWith(
      [textDelta("partial answer"), { type: "result", subtype: "error_during_execution", is_error: true, errors: [DIAG, "API Error: 500 boom"] }],
      `Claude Code returned an error result: ${DIAG}; API Error: 500 boom`,
    );
    {
      const res = await post("mid-stream", { stream: true, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.doesNotMatch(text, /ede_diagnostic/);
      assert.equal(text.match(/API Error: 500 boom/g)?.length, 1);
    }
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — turn errors regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
