/**
 * Regression: a large live tool result reaches Claude as its head and tail,
 * and Claude reads the dropped middle back with the local output_slice tool.
 * The store holding the full outputs stays within its caps.
 *
 * Run: bun test/large-output-regression.ts
 */
import { assert, bashTool, callTool, mcpHandlers, mcpExtra, mockHandle, startMockedProxy, textDelta } from "./helpers.ts";

async function storeAndCut() {
  const { OutputStore, formatSlice } = await import("../src/output-store.ts");
  const { cutLargeOutput } = await import("../src/large-output.ts");
  let clock = 0;
  const now = () => clock;
  const kb = (n: number, ch: string) => ch.repeat(n * 512); // n KB as UTF-16

  // Small outputs, reads and a cut that would save little pass unchanged.
  const store = new OutputStore({ maxBytes: 1024 * 1024, now });
  assert.equal(cutLargeOutput("bash", "short", store, 1000), "short");
  const big = `${"H".repeat(400)}MIDDLE-MARKER${"m".repeat(6000)}${"T".repeat(2000)}`;
  assert.equal(cutLargeOutput("read", big, store, 1000), big);
  assert.equal(cutLargeOutput("bash", "x".repeat(3000), store, 1000), "x".repeat(3000));
  assert.equal(cutLargeOutput("bash", big, store, 0), big, "0 turns cutting off");
  assert.equal(store.size, 0, "nothing stored for outputs that were not cut");

  // A cut note keeps head and tail, names the id, and the middle comes back.
  const cut = cutLargeOutput("bash", big, store, 1000);
  assert.doesNotMatch(cut, /MIDDLE-MARKER/);
  assert.match(cut, /T{2000}/);
  const id = /output id: (o[0-9a-f]+)/.exec(cut)?.[1];
  assert.ok(id, "cut note carries an output id");
  assert.match(cut, new RegExp(`output_slice\\(id="${id}", offset=400\\)`));
  const slice = store.slice(id!, 400, 100);
  assert.ok(slice.ok && slice.text.startsWith("MIDDLE-MARKER"));
  assert.match(formatSlice(id!, slice), /chars 400-500 of \d+; next: mcp__opencode__output_slice/);
  const whole = store.slice(id!, 0, 1_000_000);
  assert.ok(whole.ok && whole.text.length === 8000, "a slice never exceeds the per-call cap");
  assert.equal(store.put(big), id, "the same output is stored once");
  assert.equal(store.size, 1);

  // Without a store the note says the middle is gone.
  assert.match(cutLargeOutput("bash", big, null, 1000), /The middle is not kept/);

  // The total cap holds; the least recently used entry goes first.
  const small = new OutputStore({ maxBytes: 100 * 1024, now });
  const a = small.put(kb(40, "a"))!;
  const b = small.put(kb(40, "b"))!;
  assert.ok(small.slice(a).ok); // touch a, so b is now the oldest
  const c = small.put(kb(40, "c"))!;
  assert.equal(small.slice(b).ok, false, "LRU entry evicted");
  assert.ok(small.slice(a).ok && small.slice(c).ok);
  for (let i = 0; i < 50; i++) small.put(kb(30, String.fromCharCode(100 + i)));
  assert.ok(small.bytes <= 100 * 1024, `cap held: ${small.bytes}`);

  // An output above the per-entry cap is not kept.
  const capped = new OutputStore({ maxBytes: 1024 * 1024, maxEntryBytes: 64 * 1024, now });
  assert.equal(capped.put(kb(65, "z")), undefined);
  assert.match(cutLargeOutput("bash", kb(65, "z"), capped, 1000), /The middle is not kept/);

  // Idle entries expire; reading one keeps it alive.
  const ttl = new OutputStore({ maxBytes: 1024 * 1024, ttlMs: 1000, now });
  const old = ttl.put("old output")!;
  const kept = ttl.put("kept output")!;
  clock = 900;
  assert.ok(ttl.slice(kept).ok);
  clock = 1500;
  const gone = ttl.slice(old);
  assert.equal(gone.ok, false);
  assert.match(formatSlice(old, gone), /no longer available/);
  assert.ok(ttl.slice(kept).ok);
  assert.equal(ttl.bytes, "kept output".length * 2);
}

async function liveTurn() {
  const { post, proxy } = await startMockedProxy("large-output");
  const session = "ses_large_output";
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  let allowed: string[] | undefined;
  let listedNames: string[] = [];
  let cutText = "";
  const slices: Array<{ isError?: boolean; text: string }> = [];

  proxy.setClaudeQueryStarter(async (params) =>
    mockHandle(
      (async function* () {
        allowed = (params as { allowedTools?: string[] }).allowedTools;
        const list = await mcpHandlers(params).get("tools/list")!({ method: "tools/list" }, mcpExtra);
        listedNames = list.tools.map((t: { name: string }) => t.name);
        yield { type: "system", subtype: "init", session_id: "large-output-sess" };
        const cut = await callTool(params, "bash", { command: "cat big" });
        cutText = cut.content[0]!.text;
        const id = /output id: (o[0-9a-f]+)/.exec(cutText)?.[1];
        for (const args of [{ id, offset: 400, limit: 500 }, { id: "o000000000000" }]) {
          const res = (await callTool(params, "output_slice", args)) as { isError?: boolean; content: Array<{ text: string }> };
          slices.push({ isError: res.isError, text: res.content[0]!.text });
        }
        yield { type: "user", message: { role: "user", content: [] } };
        yield textDelta("DONE");
        yield { type: "result", is_error: false, usage: {} };
      })(),
    ),
  );

  try {
    const history: Array<Record<string, unknown>> = [{ role: "user", content: "read the big file" }];
    const first = await (await post(session, { tools: [bashTool], messages: history })).json();
    const call = first.choices[0].message.tool_calls[0];
    history.push({ role: "assistant", content: null, tool_calls: [call] });
    history.push({ role: "tool", tool_call_id: call.id, content: big });
    const last = await (await post(session, { tools: [bashTool], messages: history })).json();
    assert.match(String(last.choices[0].message.content), /DONE/);

    // Claude sees output_slice and may call it under dontAsk.
    assert.ok(listedNames.includes("output_slice"), `listed: ${listedNames}`);
    assert.ok(allowed?.includes("mcp__opencode__output_slice"), `allowed: ${allowed}`);
    // The result Claude got was cut; the slice returns the dropped middle.
    assert.match(cutText, /^\[output cut; \d+ chars/);
    assert.ok(cutText.length < big.length / 4);
    assert.equal(slices[0]!.isError, undefined);
    assert.ok(slices[0]!.text.endsWith(big.slice(400, 900)));
    assert.equal(slices[1]!.isError, true);
    assert.match(slices[1]!.text, /no longer available/);
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
}

async function main() {
  await storeAndCut();
  await liveTurn();

  // 0 MB turns the store, and with it output_slice, off.
  const { sharedOutputStore } = await import("../src/output-store.ts");
  process.env.OPENCODE_CLAUDE_OUTPUT_STORE_MB = "0";
  assert.equal(sharedOutputStore(), null);
  delete process.env.OPENCODE_CLAUDE_OUTPUT_STORE_MB;
  assert.notEqual(sharedOutputStore(), null);
  console.log("ok — large output regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
