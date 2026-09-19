/**
 * Regression: bridged OpenCode tools must keep their full parameter schema
 * (descriptions, enums, nested item shapes, nested required fields) instead
 * of the old primitive mapping, where e.g. todowrite showed up as
 * `todos: array of anything`. A schema the SDK cannot serialise must fall
 * back without breaking tools/list for the other tools.
 *
 * Run: bun test/tool-schema-fidelity-regression.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-claude-schema-"));
  process.env.XDG_DATA_HOME = tmp;
  process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = join(tmp, "rate-limit.json");

  const { startProxy, stopProxy, setClaudeQueryStarter } = await import(
    "../src/proxy.ts"
  );
  const port = await startProxy();

  const todowrite = {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The updated todo list",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Brief description" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "cancelled"],
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  };
  // Something the SDK cannot list: a property typed as an unresolved $ref.
  const odd = {
    type: "object",
    properties: {
      name: { type: "string" },
      thing: { $ref: "#/$defs/missing" },
    },
    required: ["name"],
  };

  try {
    let seen: Record<string, any> | null = null;
    setClaudeQueryStarter(async (params) => {
      seen = params as unknown as Record<string, any>;
      return {
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "schema-sess" };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      };
    });
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": "schema-fidelity",
      },
      body: JSON.stringify({
        model: "sonnet",
        stream: false,
        tools: [
          { type: "function", function: { name: "todowrite", description: "todos", parameters: todowrite } },
          { type: "function", function: { name: "odd", description: "odd", parameters: odd } },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(res.status, 200);

    const server = seen!.mcpServers.opencode;
    const handlers =
      server.instance.server?._requestHandlers ?? server.instance._requestHandlers;
    const listed = await handlers.get("tools/list")({ method: "tools/list", params: {} }, {});
    const byName = new Map<string, any>(
      listed.tools.map((t: { name: string }) => [t.name, t]),
    );
    assert.deepEqual([...byName.keys()].sort(), ["odd", "todowrite"]);

    const todos = byName.get("todowrite").inputSchema.properties.todos;
    assert.equal(todos.description, "The updated todo list");
    assert.equal(todos.items.type, "object");
    assert.deepEqual(todos.items.properties.status.enum, [
      "pending",
      "in_progress",
      "completed",
      "cancelled",
    ]);
    assert.deepEqual([...todos.items.required].sort(), ["content", "status"]);

    const oddSchema = byName.get("odd").inputSchema;
    assert.equal(oddSchema.properties.name.type, "string");
    assert.deepEqual(oddSchema.required, ["name"]);
  } finally {
    await stopProxy();
  }
  console.log("ok — tool schema fidelity regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
