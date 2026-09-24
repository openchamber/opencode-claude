/**
 * Regression for issue #4: meta requests (session title, compaction summary)
 * run with thinking force-disabled, so they must not forward the selected
 * effort — the API rejects effort "max" in that mode with
 * "output_config.effort 'max' is not supported when thinking is disabled".
 * Normal turns must keep their selected effort, including "max"
 * (startClaudeQuery pairs effort with adaptive thinking for them).
 *
 * Run: bun test/meta-effort-regression.ts
 */
import assert from "node:assert/strict";

async function main() {
  const { startProxy, stopProxy, setClaudeQueryStarter } = await import(
    "../src/proxy.ts"
  );
  const { encodeClaudeModelSelection, EFFORT_HEADER } = await import(
    "../src/model-selection.ts"
  );

  const port = await startProxy();
  const maxHeader = encodeClaudeModelSelection({
    modelId: "sonnet",
    effort: "max",
  });

  let seenParams: Record<string, unknown> | null = null;
  setClaudeQueryStarter(async (params) => {
    seenParams = params as unknown as Record<string, unknown>;
    return {
      stream: (async function* () {
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "OK" },
          },
        };
        yield { type: "result", is_error: false, usage: {} };
      })(),
      interrupt: async () => {},
      close: () => {},
      getPid: () => null,
    };
  });

  const post = (body: unknown, session: string) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": session,
        [EFFORT_HEADER]: maxHeader,
      },
      body: JSON.stringify(body),
    });

  try {
    // Normal turn: keeps "max"; thinking stays unset so startClaudeQuery
    // applies adaptive thinking.
    seenParams = null;
    const normalRes = await post(
      {
        model: "sonnet",
        stream: false,
        messages: [{ role: "user", content: "Say OK" }],
      },
      "meta-effort-normal",
    );
    assert.equal(normalRes.status, 200);
    await normalRes.text();
    assert.ok(seenParams, "normal request reached the Agent SDK");
    assert.equal(seenParams!.effort, "max", "normal turns keep effort max");
    assert.equal(
      seenParams!.thinking,
      undefined,
      "normal turns must not disable thinking",
    );

    // Title meta request: thinking force-disabled ⇒ effort must be dropped.
    seenParams = null;
    const titleRes = await post(
      {
        model: "sonnet",
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "You are a title generator. Generate a brief title. Output only the title.",
          },
          {
            role: "user",
            content: "Explain how binary search trees work",
          },
        ],
      },
      "meta-effort-title",
    );
    assert.equal(titleRes.status, 200);
    await titleRes.text();
    assert.ok(seenParams, "title request reached the Agent SDK");
    assert.deepEqual(seenParams!.thinking, { type: "disabled" });
    assert.equal(
      seenParams!.effort,
      undefined,
      "title meta request must not send effort while thinking is disabled",
    );

    // Compaction/summary meta request: same gate.
    seenParams = null;
    const summaryRes = await post(
      {
        model: "sonnet",
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "You are tasked with summarizing conversations. Write like a pull request description.",
          },
          {
            role: "user",
            content:
              "Create a detailed summary for continuing this coding session.",
          },
        ],
      },
      "meta-effort-summary",
    );
    assert.equal(summaryRes.status, 200);
    await summaryRes.text();
    assert.ok(seenParams, "summary request reached the Agent SDK");
    assert.deepEqual(seenParams!.thinking, { type: "disabled" });
    assert.equal(
      seenParams!.effort,
      undefined,
      "summary meta request must not send effort while thinking is disabled",
    );

    console.log("ok — meta effort regression tests passed");
  } finally {
    setClaudeQueryStarter(null);
    await stopProxy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
