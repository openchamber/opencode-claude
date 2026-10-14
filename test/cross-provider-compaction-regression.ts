/**
 * A chat compacted by another provider's model never reaches the summary
 * route, so the turn parked on the old history must be stopped by the next
 * request instead of re-emitting its calls.
 *
 * Run: bun test/cross-provider-compaction-regression.ts
 */
import { assert, bashTool, callTool, interruptibleTurn, startMockedProxy, textDelta } from "./helpers.ts";

async function main() {
  const keepAlive = setInterval(() => {}, 1000);
  const { post, proxy } = await startMockedProxy("cross-provider-compaction");
  const log: string[] = [];
  let spawns = 0;
  try {
    proxy.setClaudeQueryStarter(async (params) => {
      const turn = ++spawns;
      if (turn > 1) {
        assert.equal(params.resume, undefined, "compacted history must not resume the old Claude session");
      }
      return interruptibleTurn(log, `turn-${turn}`, async function* () {
        yield { type: "system", subtype: "init", session_id: `claude-${turn}` };
        await callTool(params, "bash", { command: turn === 1 ? "old-work" : "new-work" });
        yield textDelta("continued from current history");
        yield { type: "result", is_error: false, usage: { input_tokens: 1000, output_tokens: 10 } };
      });
    });
    const first = await post("cross-provider", {
      tools: [bashTool], messages: [{ role: "user", content: "original long conversation" }],
    });
    const old = (await first.json()) as any;
    assert.equal(old.choices[0].finish_reason, "tool_calls");

    // Another provider has completed the compaction. OpenCode's next request contains only its
    // checkpoint; the pending old call now exists as text in recent-context.
    const checkpoint = [{ role: "user", content: "<conversation-checkpoint>\n<summary>Continue current work</summary>\n<recent-context>old-work finished</recent-context>\n</conversation-checkpoint>" }];
    const after = await post("cross-provider", { tools: [bashTool], messages: checkpoint });
    const fresh = (await after.json()) as any;
    assert.equal(spawns, 2, "cross-provider checkpoint must replace the parked turn, not re-emit its old call");
    assert.ok(log.includes("turn-1:interrupt"), "old process stopped before replacing its binding");
    const call = fresh.choices[0].message.tool_calls[0];
    assert.notEqual(call.id, old.choices[0].message.tool_calls[0].id);
    assert.equal(JSON.parse(call.function.arguments).command, "new-work");

    // Retrying an unchanged checkpoint must reuse the new park, not reset again.
    const retry = await post("cross-provider", { tools: [bashTool], messages: checkpoint });
    assert.equal(((await retry.json()) as any).choices[0].message.tool_calls[0].id, call.id);
    assert.equal(spawns, 2);
    const continued = await post("cross-provider", {
      tools: [bashTool], messages: [
        ...checkpoint,
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: "done" },
      ],
    });
    assert.equal(((await continued.json()) as any).choices[0].finish_reason, "stop");
    assert.equal(spawns, 2, "normal post-checkpoint tool continuation stays on the same turn");
    console.log("cross-provider-compaction regression ok: stale park replaced; unchanged checkpoint reused");
  } finally {
    clearInterval(keepAlive);
    await proxy.stopProxy?.();
  }
}
main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
