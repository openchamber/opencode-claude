/**
 * Regression: Opus 5.5 sends its update before a tool call as a thinking
 * block whose signature is tagged "narration". It must reach OpenCode as
 * answer text, not reasoning.
 * - Block 0 is real thinking and streams live as reasoning, whatever its tag.
 * - A later thinking block is held until its signature: narration becomes
 *   text, anything else stays reasoning.
 *
 * Run: bun test/narration-regression.ts
 */
import { assert, mockHandle, startMockedProxy } from "./helpers.ts";

const block = (index: number, event: Record<string, unknown>) => ({ type: "stream_event", event: { index, ...event } });
const thinkingBlock = (index: number, thinking: string, tag: string) => [
  block(index, { type: "content_block_start", content_block: { type: "thinking", thinking: "", signature: "" } }),
  block(index, { type: "content_block_delta", delta: { type: "thinking_delta", thinking } }),
  block(index, { type: "content_block_delta", delta: { type: "signature_delta", signature: Buffer.from(`\x08\x04B\t${tag}`).toString("base64") } }),
  block(index, { type: "content_block_stop" }),
];

function parseSse(sse: string): { content: string; reasoning: string } {
  let content = "";
  let reasoning = "";
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: {")) continue;
    const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
    content += delta?.content ?? "";
    reasoning += delta?.reasoning_content ?? "";
  }
  return { content, reasoning };
}

async function main() {
  const { post, proxy } = await startMockedProxy("narration");
  try {
    for (const stream of [true, false]) {
      proxy.setClaudeQueryStarter(async () =>
        mockHandle(
          (async function* () {
            yield* thinkingBlock(0, "plan", "narration");
            yield* thinkingBlock(1, "Checking the logs next.", "narration");
            yield* thinkingBlock(2, " later", "thinking");
            yield { type: "result", is_error: false, usage: {} };
          })(),
        ),
      );
      const res = await post(`narration-${stream}`, { stream, messages: [{ role: "user", content: "hi" }] });
      assert.equal(res.status, 200);
      let out: { content: string; reasoning: string };
      if (stream) out = parseSse(await res.text());
      else {
        const message = ((await res.json()) as any).choices[0].message;
        out = { content: message.content, reasoning: message.reasoning_content };
      }
      assert.deepEqual(out, { content: "Checking the logs next.", reasoning: "plan later" });
    }
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — narration regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
