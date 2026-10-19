/**
 * Regression: Claude sometimes sends a non-text argument as text ({} as
 * "{}", 22 as "22", true as "true"; seen after compaction). The bridge must
 * parse it back instead of failing MCP validation with -32602, on both the
 * fromJSONSchema path and the hand-built fallback.
 *
 * Run: bun test/stringified-args-regression.ts
 */
import { assert, callTool } from "./helpers.ts";

async function main() {
  const { buildOpenCodeMcpServer } = await import("../src/proxy.ts");
  const pending = new Map<string, any>();
  const servers: any = await buildOpenCodeMcpServer(
    [{
      type: "function",
      function: {
        name: "openchamber_knowledge",
        description: "knowledge",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string" },
            parameters: { type: "object", properties: {}, additionalProperties: true },
            limit: { type: "integer" },
            background: { type: "boolean" },
            label: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
    }] as any,
    pending,
    () => {
      for (const call of pending.values()) call.resolve([{ type: "text", text: call.arguments }]);
    },
  );

  const run = async (args: Record<string, unknown>) => {
    const out = await callTool({ mcpServers: servers }, "openchamber_knowledge", args);
    assert.ok(!out.isError, JSON.stringify(out));
    return JSON.parse(out.content[0].text);
  };

  assert.deepEqual(await run({ action: "knowledge.list" }), { action: "knowledge.list" });
  assert.deepEqual(
    await run({ action: "knowledge.list", parameters: {} }),
    { action: "knowledge.list", parameters: {} },
  );
  assert.deepEqual(
    await run({ action: "knowledge.save", parameters: '{"kind":"note","body":"test"}' }),
    { action: "knowledge.save", parameters: { kind: "note", body: "test" } },
  );
  assert.deepEqual(
    await run({ action: "read", limit: "22", background: "true", label: "22" }),
    { action: "read", limit: 22, background: true, label: "22" },
  );
  // A string that is not JSON still fails validation rather than passing through.
  const bad: any = await callTool({ mcpServers: servers }, "openchamber_knowledge", {
    action: "knowledge.list",
    parameters: "nope",
  });
  assert.ok(bad.isError);

  // Fallback path: an unresolvable $ref makes fromJSONSchema throw.
  pending.clear();
  const fallback: any = await buildOpenCodeMcpServer(
    [{
      type: "function",
      function: {
        name: "subagent",
        description: "subagent",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string" },
            background: { type: "boolean" },
            timeout: { type: "number" },
            extra: { $ref: "#/nope" },
          },
          required: ["prompt"],
        },
      },
    }] as any,
    pending,
    () => {
      for (const call of pending.values()) call.resolve([{ type: "text", text: call.arguments }]);
    },
  );
  const out = await callTool({ mcpServers: fallback }, "subagent", {
    prompt: "true",
    background: "true",
    timeout: "5",
  });
  assert.ok(!(out as any).isError, JSON.stringify(out));
  assert.deepEqual(JSON.parse(out.content[0].text), { prompt: "true", background: true, timeout: 5 });

  console.log("ok — stringified args regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
