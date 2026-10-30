/**
 * OpenCode lists the tools of its `execute` tool (Code Mode: MCP servers, OpenCode's own namespace) only in its
 * system prompt, and its skills likewise; a custom agent's prompt sits there before "# Your Model". The plugin keeps
 * these parts of a prompt it otherwise drops: the Code Mode catalog alone (none of what follows it: the MCP servers'
 * instructions, the skills, instruction files, the date and the environment, a host's context), the skills list, a
 * custom agent's persona — and never OpenCode's stock prompt.
 *
 * On the simulators (test/simulators/): OpenCode's system prompt as OpenCode 2.0.32 builds it from its setup
 * (`opencode.state`: `codeMode`, `mcpServers`, `skills`, `agent`, `instructions`, `contextEntries`; BEHAVIOR.md "The
 * system prompt"); each case is a chat turn, and what Claude got is the query's system prompt. Each case is its own
 * chat: OpenCode keeps a session's instructions as it first observed them.
 *
 * Run: bun test/code-mode-catalog-regression.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { codeModeInstructions, skillsInstructions, type CodeModeTool } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

const world = await createWorld("code-mode-catalog");
const { opencode, claude } = world;
const failures: string[] = [];
/** One independent case: a failure is reported, the others still run. */
const check = async (name: string, body: () => Promise<void>) => {
  const saved = structuredClone({ ...opencode.state, sleep: undefined });
  try {
    await body();
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    Object.assign(opencode.state, { ...saved, sleep: opencode.state.sleep });
  }
};
/** A chat turn in `directory` (default: the world's); what OpenCode sent as its system prompt and what Claude Code got. */
const turnIn = async (text = "hi", directory?: string) => {
  const chat = opencode.newChat(undefined, directory);
  await opencode.say(chat, text);
  const turn = await opencode.turn(chat);
  assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status}`);
  const system = String(turn.requests[0]!.body.messages[0]!.content);
  const append = String((claude.queries.at(-1)!.params.systemPrompt as { append?: string })?.append ?? "");
  return { system, append };
};
/** The catalog as the plugin forwarded it: its section up to the plugin's own line naming the tool. */
const forwardedCatalog = (append: string) => {
  const start = append.indexOf("# Code Mode");
  if (start < 0) return "";
  const end = append.indexOf("\n\nThe `execute` tool above is ", start);
  assert.ok(end > start, `the catalog's section ends with the plugin's line: ${append.slice(start, start + 300)}`);
  return append.slice(start, end);
};

const demo: CodeModeTool[] = [
  { namespace: "demo", name: "read", description: "Read a file", input: { type: "object", properties: { path: { type: "string", description: "Where" } }, required: ["path"] } },
  { namespace: "demo", name: "status", description: "Status", input: { type: "object", properties: {} } },
];
const DATE_OR_ENV = /Today's date|<env>|Working directory:|# Your Model|a coding agent harness/;

try {
  await opencode.startPlugin();

  // A complete catalog, followed by each section OpenCode 2.0.32 puts after it (the date and the environment always
  // come; since 2.0.19 they follow the catalog): only the catalog comes along, its multi-line signature and later
  // tools whole.
  const followers: Record<string, () => void> = {
    "the date and the environment": () => {},
    "an MCP server's instructions": () => {
      opencode.state.mcpServers = [{ server: "linear", instructions: "Use tools.", tools: [{ name: "list_issues", description: "List issues" }] }];
    },
    "the skills": () => {
      opencode.state.skills = [{ id: "demo", name: "demo", description: "Demo skill" }];
    },
    "an instruction file": () => {
      const file = join(world.tmp, "rules", "rules.md");
      mkdirSync(join(world.tmp, "rules"), { recursive: true });
      writeFileSync(file, "# Rules\r\n\r\nWindows line endings.\r\n");
      opencode.state.instructions = [file];
    },
    "a host's context": () => {
      opencode.state.contextEntries = { "openchamber.guidance": "Link pull requests." };
    },
  };
  for (const [after, setup] of Object.entries(followers)) {
    await check(`a complete catalog, then ${after}`, async () => {
      opencode.state.codeMode = { namespaces: [{ name: "demo", description: "Example tools" }], tools: demo };
      setup();
      const { system, append } = await turnIn();
      const tools = [...demo, ...opencode.state.mcpServers.flatMap((s) => s.tools.map((t) => ({ namespace: s.server, name: t.name, description: t.description ?? "", output: {} })))];
      const rendered = codeModeInstructions(tools, opencode.state.codeMode!.namespaces);
      assert.ok(system.includes(rendered), "OpenCode's prompt holds the catalog");
      assert.equal(forwardedCatalog(append), rendered);
      assert.match(rendered, /path: string,[\s\S]*tools\.demo\.status\(\)/, "the signature and the later tool whole");
      assert.doesNotMatch(forwardedCatalog(append), /available_skills|mcp_instructions|Instructions from|<context|Today's date|<env>/);
      assert.doesNotMatch(append, DATE_OR_ENV, "nothing else of OpenCode's prompt");
    });
  }

  // A partial catalog: more tools than its inline budget; the `search` guidance before the listings, a namespace
  // with none of its tools shown.
  await check("a partial catalog", async () => {
    const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`field${i}`, { type: "string", description: `The field number ${i} of the record` }])) };
    const many: CodeModeTool[] = Array.from({ length: 40 }, (_, i) => ({ namespace: `ns${i % 3}`, name: `tool${i}`, description: `Does thing ${i}`, input: wide }));
    const huge: CodeModeTool = { namespace: "zbig", name: "huge", description: "Too big to list", input: { type: "object", properties: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`p${i}`, { type: "string" }])) } };
    opencode.state.codeMode = { tools: [...many, huge] };
    const { system, append } = await turnIn();
    const rendered = codeModeInstructions([...many, huge]);
    assert.ok(system.includes(rendered));
    assert.match(rendered, /The catalog is partial[\s\S]*- search\(\{[\s\S]*## Available tools[\s\S]*- zbig \(1 tool, none shown\)$/);
    assert.equal(forwardedCatalog(append), rendered);
    assert.doesNotMatch(append, DATE_OR_ENV);
  });

  // OpenCode 2.2.1 reworded the section and renamed the listing's heading to "## Code Mode tools (call only inside
  // `execute`)": the catalog still comes along whole, complete or partial, and nothing after it.
  for (const [kind, tools] of [["complete", demo], ["partial", Array.from({ length: 40 }, (_, i) => ({ namespace: `ns${i % 3}`, name: `tool${i}`, description: `Does thing ${i}`, input: { type: "object", properties: Object.fromEntries(Array.from({ length: 6 }, (_, k) => [`field${k}`, { type: "string", description: `The field number ${k} of the record` }])) } }))]] as Array<[string, CodeModeTool[]]>) {
    await check(`OpenCode 2.2.1's heading: a ${kind} catalog`, async () => {
      opencode.state.version = "2.2.1";
      opencode.state.codeMode = { namespaces: [{ name: "demo", description: "Example tools" }], tools };
      opencode.state.skills = [{ id: "demo", name: "demo", description: "Demo skill" }];
      const { system, append } = await turnIn();
      const rendered = codeModeInstructions(tools, opencode.state.codeMode!.namespaces, "2.2.1");
      assert.match(rendered, /\n## Code Mode tools \(call only inside `execute`\)\n/);
      assert.ok(system.includes(rendered), "OpenCode's prompt holds the 2.2.1 catalog");
      assert.equal(forwardedCatalog(append), rendered);
      assert.doesNotMatch(forwardedCatalog(append), /available_skills|Today's date|<env>/);
      assert.doesNotMatch(append, DATE_OR_ENV, "nothing else of OpenCode's prompt");
    });
  }

  // Code Mode with no tool at all: OpenCode's note instead of a catalog; nothing forwarded — also when an
  // instruction file holds catalog-like headings with no listing.
  await check("no Code Mode tool", async () => {
    opencode.state.codeMode = { tools: [] };
    // The file is the user's own configured instructions (outside the project, so the plugin forwards the file
    // itself): only the catalog's own section is the question here.
    const file = join(world.tmp, "headings", "notes.md");
    mkdirSync(join(world.tmp, "headings"), { recursive: true });
    writeFileSync(file, "Mention # Code Mode inline.\n\n# Code Mode\n\nNo catalog heading.\n\n# Code Mode\n\n## Available tools\n\nNot a namespace listing\n");
    opencode.state.instructions = [file];
    const { system, append } = await turnIn();
    assert.match(system, /No Code Mode tools are currently available\./);
    assert.match(system, /## Available tools\n\nNot a namespace listing/, "the file is in OpenCode's prompt");
    assert.doesNotMatch(append, /The `execute` tool above is |No Code Mode tools/, "no catalog forwarded");
  });

  // A user message that quotes a catalog: OpenCode's own catalog is the one forwarded.
  await check("a catalog quoted by the user", async () => {
    opencode.state.codeMode = { tools: demo };
    const quoted = "# Code Mode\n\n## Available tools\n\n- fake (1 tool)\n  - tools.fake.run(): Promise<void>";
    const { append } = await turnIn(quoted);
    assert.equal(forwardedCatalog(append), codeModeInstructions(demo));
    assert.doesNotMatch(append, /tools\.fake/);
  });

  // The skills list: Claude needs its ids for the skill tool; nothing after it comes along. No skill: no list.
  await check("the skills list", async () => {
    const skills = [
      { id: "zeta", name: "Zeta", description: "Last one" },
      { id: "demo", name: "demo", description: "Demo skill" },
    ];
    opencode.state.skills = skills;
    opencode.state.codeMode = { tools: demo };
    const { system, append } = await turnIn();
    const rendered = skillsInstructions(skills);
    assert.ok(system.includes(rendered));
    assert.match(rendered, /<id>demo<\/id>[\s\S]*<id>zeta<\/id>/, "sorted by id");
    assert.ok(append.includes(`${rendered}\n\nThe skill tool above is `), `the list as OpenCode rendered it: ${append}`);
    assert.doesNotMatch(append, DATE_OR_ENV);
  });
  await check("no skills", async () => {
    opencode.state.skills = [];
    const { system, append } = await turnIn();
    assert.doesNotMatch(system, /Skills provide/, "OpenCode lists none");
    assert.doesNotMatch(append, /Skills provide|available_skills/);
  });

  // A custom agent's own prompt (it replaces OpenCode's stock one, "# Your Model" follows): forwarded as the agent's
  // role. The stock prompt (build, with the Anthropic part OpenCode appends for a Claude model) is not.
  await check("a custom agent's persona", async () => {
    const persona = "You hand-write text and data for the task you are given.\n\nNever use templates.";
    opencode.state.agent = { name: "writer", system: persona };
    const { system, append } = await turnIn();
    assert.ok(system.startsWith(`${persona}\n# Your Model\n`), `the persona first, then the model: ${system.slice(0, 200)}`);
    assert.ok(append.includes(`# Agent role`) && append.includes(`)\n\n${persona}`), `the persona as Claude's role: ${append}`);
    assert.doesNotMatch(append, DATE_OR_ENV);
  });
  await check("the stock prompt", async () => {
    const { system, append } = await turnIn();
    assert.match(system, /^You are an AI agent running in OpenCode, a coding agent harness\.[\s\S]*# Code comments\n[\s\S]*\n# Your Model\n/);
    assert.doesNotMatch(append, /# Agent role|# Code comments|a coding agent harness/);
  });

  const errors = world.journal().filter((line) => /level=error/.test(line));
  if (errors.length > 0) failures.push(`the plugin's journal has errors: ${errors.join("\n")}`);
} finally {
  await world.dispose();
}
if (failures.length > 0) {
  console.error(`code mode catalog regression: ${failures.length} failed\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("code mode catalog regression ok");
process.exit(0);
