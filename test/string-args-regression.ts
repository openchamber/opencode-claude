/**
 * Regression: Claude sometimes sends typed tool arguments as their string
 * encoding ("true", "300000", a JSON array), and the bridge's validation
 * answered -32602 before OpenCode saw the call. String-encoded arguments for
 * parameters that cannot take a string reach OpenCode decoded; values that do
 * not decode are still rejected.
 *
 * On the simulators (test/simulators/): Claude Code calls the plugin's MCP
 * tool with the arguments as the model wrote them (`state.toolSteps`); a call
 * the bridge accepts reaches OpenCode as the turn's tool call (its input is
 * what OpenCode got), a call it rejects never does: Claude Code gets the
 * validation error as the tool's result and answers. `coerceStringArgument`
 * itself is a pure function of the proxy.
 *
 * Run: bun test/string-args-regression.ts
 */
import assert from "node:assert/strict";

import { contentText, listPluginTools } from "./simulators/claude-code.ts";
import type { ToolDefinitions } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

const fn = (name: string, properties: Record<string, unknown>, required: string[] = []) =>
  [name, { description: name, input: { type: "object", properties, required, additionalProperties: false } }] as const;

const TOOLS: ToolDefinitions = Object.fromEntries([
  fn("subagent", { agent: { type: "string" }, prompt: { type: "string" }, background: { type: "boolean" } }, ["agent", "prompt"]),
  fn("shell", { command: { type: "string" }, timeout: { type: "integer", minimum: 0 } }, ["command"]),
  fn("question", { questions: { type: "array", minItems: 1, items: { type: "object", properties: { header: { type: "string" } }, required: ["header"] } } }, ["questions"]),
  fn("compress", { content: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] } }),
  // z.fromJSONSchema cannot resolve the $ref, so this tool takes the fallback shape.
  fn("fallback", { n: { type: "integer" }, r: { $ref: "#/$defs/missing" } }, ["n"]),
  fn("defaults", { limit: { type: "integer", default: 5 }, all: { type: "boolean", default: false }, n: { type: ["integer", "null"] } }, ["all"]),
]);

async function main() {
  const world = await createWorld("string-args");
  const { opencode, claude } = world;
  const { coerceStringArgument } = world.plugin.proxy;
  opencode.state.tools = TOOLS;

  /** Claude calls `name` with `args` in a turn of its own chat. */
  const callTurn = async (name: string, args: Record<string, unknown>) => {
    const chat = opencode.newChat();
    await opencode.say(chat, `use ${name}`);
    claude.state.toolSteps = [[{ name, input: args }]];
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `${name} ${JSON.stringify(args)}: the turn answered (${turn.requests.map((r) => r.status).join(",")})`);
    return turn;
  };
  /** The call reached OpenCode: the arguments it got. */
  const sent = async (name: string, args: Record<string, unknown>) => {
    const turn = await callTurn(name, args);
    const first = turn.requests[0]!.reply!;
    assert.equal(first.finish, "tool_calls", `${name} ${JSON.stringify(args)}: the call reached OpenCode`);
    assert.equal(first.toolCalls.length, 1);
    assert.equal(first.toolCalls[0]!.name, name);
    return first.toolCalls[0]!.input;
  };
  /** The bridge refused the call: OpenCode never saw it, Claude got the validation error. */
  const rejected = async (name: string, args: Record<string, unknown>) => {
    const turn = await callTurn(name, args);
    assert.equal(turn.requests.length, 1, `${name} ${JSON.stringify(args)} should be rejected before OpenCode`);
    assert.equal(turn.requests[0]!.reply!.toolCalls.length, 0);
    const result = claude.records(claude.queries.at(-1)!.name).findLast((r) => r.toolUseResult);
    assert.match(contentText(result?.toolUseResult), /Input validation error/, `${name} ${JSON.stringify(args)}: Claude got the validation error`);
  };

  try {
    await opencode.startPlugin();

    // String encodings reach OpenCode as the declared type.
    assert.deepEqual(await sent("subagent", { agent: "a", prompt: "p", background: "true" }), { agent: "a", prompt: "p", background: true });
    assert.deepEqual(await sent("subagent", { agent: "a", prompt: "p", background: "false" }), { agent: "a", prompt: "p", background: false });
    assert.deepEqual(await sent("shell", { command: "c", timeout: "300000" }), { command: "c", timeout: 300000 });
    assert.deepEqual(await sent("question", { questions: '[{"header":"h"}]' }), { questions: [{ header: "h" }] });
    assert.deepEqual(await sent("fallback", { n: "5" }), { n: 5 });

    assert.deepEqual(await sent("defaults", { all: "true", n: "null" }), { limit: 5, all: true, n: null });

    // Schema defaults still apply to omitted arguments, required or not.
    assert.deepEqual(await sent("defaults", {}), { limit: 5, all: false });

    // Typed values, omitted optionals, strings where strings are allowed and
    // unnamed keys pass through unchanged.
    assert.deepEqual(await sent("subagent", { agent: "a", prompt: "p", background: true }), { agent: "a", prompt: "p", background: true });
    assert.deepEqual(await sent("subagent", { agent: "a", prompt: "p" }), { agent: "a", prompt: "p" });
    assert.deepEqual(await sent("compress", { content: "[1]" }), { content: "[1]" });
    assert.deepEqual(await sent("subagent", { agent: "a", prompt: "p", extra: 1 }), { agent: "a", prompt: "p", extra: 1 });

    // Values that do not decode to the declared type are still rejected.
    await rejected("subagent", { agent: "a", prompt: "p", background: "yes" });
    await rejected("shell", { command: "c", timeout: "abc" });
    await rejected("shell", { command: "c", timeout: "1.5" });
    await rejected("question", { questions: '{"header":"h"}' });
    await rejected("subagent", { prompt: "p" });
    await rejected("fallback", {});
    await rejected("fallback", { n: "1.5" });
    await rejected("defaults", { limit: "2.5" });

    // The served tools/list is still OpenCode's own schema (OpenCode offers its tools sorted by name, its skill tool
    // among them, then `execute`).
    const listed = await listPluginTools(claude.queries.at(-1)!.params);
    assert.deepEqual(
      Object.fromEntries(listed.map((t) => [t.name, t.inputSchema])),
      Object.fromEntries(Object.entries(opencode.offeredTools()).map(([name, t]) => [name, t.input])),
    );

    // Union types: a type that takes strings keeps them, null decodes.
    assert.equal(coerceStringArgument("true", { type: ["boolean", "string"] }), "true");
    assert.equal(coerceStringArgument("null", { type: ["integer", "null"] }), null);
    assert.equal(coerceStringArgument(" 7 ", { type: "number" }), 7);
    assert.equal(coerceStringArgument("7", {}), "7");

    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — string-encoded tool args regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
