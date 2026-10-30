/**
 * Live Haiku matrix for opencode-claude.
 *
 * A live world (test/simulators/world.ts, `realClaude`): the OpenCode
 * simulator builds every request through the plugin's hooks as OpenCode
 * 2.0.32 does, the plugin is the real one, and Claude Code is the machine's
 * own signed-in CLI. Each case is what a user does in OpenCode on the
 * catalog's Haiku model (the newest one offering effort variants) with the
 * variant "high"; what came back is the turn's requests and the plugin's
 * journal. It spends the subscription: run it on purpose, not in the suite.
 *
 * Dropped from the matrix of hand-made OpenAI bodies:
 * - non-stream text (`stream: false`): OpenCode 2.0.32 always streams; the
 *   text case reads the streamed answer and its usage.
 * - JPEG as the AI SDK `image` part: a body only OpenCode 1.x sent; 2.0.32
 *   sends every image as `image_url` (the PNG cases).
 * - empty `messages` → 400: OpenCode 2.0.32 never sends a request without
 *   messages.
 * - `opencode run --file` through the OpenCode binary: now the user attaches
 *   a file from disk in the OpenCode simulator (haiku.attach_png_from_disk).
 *
 * `/health` and `/rate-limit` are read at the provider's registered address,
 * as OpenChamber's UI reads them (OpenCode itself never does).
 *
 * Run: $env:OPENCHAMBER_RUNTIME=''; bun test/haiku-live.ts
 * One or more cases: $env:HAIKU_CASES = "haiku.attach_pdf,haiku.tools_park_resume"
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import type { SentRequest, ToolCall, ToolDefinitions } from "./simulators/opencode.ts";
import { createWorld, type World } from "./simulators/world.ts";

type CaseResult = {
  id: string;
  ok: boolean;
  detail: string;
  usage?: Usage;
  ms: number;
};
type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost_usd: number };

const RESULTS: CaseResult[] = [];
const TOTAL_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, turns: 0 };
const ONLY = (process.env.HAIKU_CASES ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

/** The usage of every request of a turn, summed (each tool step is a request of its own). */
function usageOf(requests: SentRequest[]): Usage {
  const total: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
  for (const request of requests) {
    const u = (request.reply?.usage ?? {}) as Record<string, unknown>;
    total.prompt_tokens += Number(u.prompt_tokens || 0);
    total.completion_tokens += Number(u.completion_tokens || 0);
    total.total_tokens += Number(u.total_tokens || 0);
    total.cost_usd += Number(u.cost_usd || 0);
  }
  return total;
}

function accumulateUsage(usage: Usage | undefined, turns: number): void {
  if (!usage) return;
  TOTAL_USAGE.prompt_tokens += usage.prompt_tokens;
  TOTAL_USAGE.completion_tokens += usage.completion_tokens;
  TOTAL_USAGE.total_tokens += usage.total_tokens;
  TOTAL_USAGE.cost_usd += usage.cost_usd;
  TOTAL_USAGE.turns += turns;
}

async function runCase(
  id: string,
  fn: () => Promise<{ detail: string; usage?: Usage; turns?: number }>,
): Promise<void> {
  if (ONLY.length > 0 && !ONLY.includes(id)) return;
  const t0 = Date.now();
  try {
    const { detail, usage, turns } = await fn();
    accumulateUsage(usage, turns ?? (usage ? 1 : 0));
    RESULTS.push({ id, ok: true, detail, usage, ms: Date.now() - t0 });
    console.log(`PASS  ${id}  (${Date.now() - t0}ms)  ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    RESULTS.push({ id, ok: false, detail, ms: Date.now() - t0 });
    console.log(`FAIL  ${id}  (${Date.now() - t0}ms)  ${detail}`);
  }
}

// ---- test files: a solid-colour PNG and a one-page PDF ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A `size` × `size` PNG of one colour, base64 (testPng is noise: a colour question needs a plain image). */
function solidPng(rgb: [number, number, number], size = 64): string {
  const chunk = (type: string, data: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", new Uint8Array()),
  ]).toString("base64");
}

/** A one-page PDF showing `text` in Helvetica, base64. */
function textPdf(text: string): string {
  const content = `BT /F1 24 Tf 40 70 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1").toString("base64");
}

const RED: [number, number, number] = [220, 20, 20];
const BLUE: [number, number, number] = [20, 40, 220];

// ---- the journal ----

/** The journal's entries of `message` since line `from`: the object logged with each. */
function entries(world: World, from: number, message: string): Array<Record<string, any>> {
  return world
    .journal()
    .slice(from)
    .filter((line) => line.includes(message))
    .map((line) => {
      const at = line.indexOf("{", line.indexOf(message));
      return at >= 0 ? JSON.parse(line.slice(at)) : {};
    });
}

/** The journal's errors since line `from` (warnings are reported, not failed). */
function errorsSince(world: World, from: number): string[] {
  return world.journal().slice(from).filter((line) => /level=error/.test(line));
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

async function main() {
  const world = await createWorld("haiku-live", {}, { realClaude: true });
  const { opencode } = world;
  try {
    const detection = await world.plugin.detect.detectClaudeCode();
    if (!detection.loggedIn) {
      console.error("SKIP live cases — Claude Code CLI is not logged in");
      return;
    }

    await opencode.startPlugin();
    const provider = opencode.instances[0]!.provider;
    // The catalog first holds the plugin's fallback list; the real CLI's list replaces it in the background.
    const initial = provider.models.map((m: any) => m.id).join();
    for (let waited = 0; waited < 30_000 && provider.models.map((m: any) => m.id).join() === initial; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const haikus = provider.models.filter((m: any) => /haiku/i.test(m.id) && !/fast/.test(m.id));
    const model = haikus.find((m: any) => m.variants?.some((v: { id: string }) => v.id === "high")) ?? haikus[0];
    assert.ok(model, `a Haiku model in the catalog: ${provider.models.map((m: any) => m.id).join(",")}`);
    opencode.state.modelID = model.id;
    opencode.state.variant = model.variants?.some((v: { id: string }) => v.id === "high") ? "high" : undefined;
    // Turns without tools unless a case offers some.
    opencode.state.tools = {};
    console.log(`model: ${model.id} variant: ${opencode.state.variant ?? "none"} (plugin ${world.label})`);

    const baseURL: string = provider.info.settings.baseURL;
    const say = async (text: string, files?: Parameters<typeof opencode.say>[2]) => {
      const chat = opencode.newChat();
      await opencode.say(chat, text, files);
      return chat;
    };
    /** A turn that must answer: every request 200, the answer text. */
    const answered = async (chat: string, options: Parameters<typeof opencode.turn>[1] = {}) => {
      const from = world.journal().length;
      const turn = await opencode.turn(chat, options);
      const statuses = turn.requests.map((r) => r.status).join(",");
      assert.ok(turn.ok, `the turn answered (statuses ${statuses}): ${JSON.stringify(turn.failure ?? turn.requests.at(-1)?.reply?.raw ?? "")}`);
      assert.deepEqual(errorsSince(world, from), [], "no error in the plugin's journal");
      const last = turn.requests.at(-1)!.reply!;
      return { turn, text: turn.answer!.text, last, usage: usageOf(turn.requests), from };
    };

    // The catalog: a Haiku model with effort variants, the proxy healthy
    await runCase("catalog.haiku_health", async () => {
      const h = await fetch(`${baseURL.replace(/\/v1$/, "")}/health`);
      assert.equal(h.status, 200);
      const health = (await h.json()) as { ok: boolean; rateLimit?: { limited?: boolean } };
      assert.equal(health.ok, true);
      assert.equal(typeof health.rateLimit?.limited, "boolean");
      return {
        detail: `haiku=${haikus.map((m: any) => `${m.id}[${(m.variants ?? []).map((v: any) => v.id).join("/")}]`).join(",")} limited=${health.rateLimit?.limited}`,
      };
    });

    // Rate-limit counter endpoint (pre-turn shape)
    await runCase("proxy.rate_limit_endpoint", async () => {
      const res = await fetch(`${baseURL}/rate-limit`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(typeof body.limited, "boolean");
      return { detail: `limited=${body.limited} status=${body.status ?? "n/a"} util=${body.utilization ?? "n/a"}` };
    });

    // 1) Text: the streamed answer, its finish and usage on the final chunk
    await runCase("haiku.text_usage", async () => {
      const chat = await say("Reply with exactly the token OK_HAIKU_TEXT and nothing else.");
      const { text, last, usage } = await answered(chat);
      assert.match(text, /OK_HAIKU_TEXT/);
      assert.equal(last.finish, "stop");
      const u = last.usage as Usage | undefined;
      assert.ok(u, "expected usage on the stream's last chunk");
      assert.ok(u.prompt_tokens > 0);
      assert.ok(u.completion_tokens > 0);
      assert.ok(u.total_tokens > 0);
      return { detail: `text=${text.trim()} usage=${JSON.stringify(last.usage)}`, usage };
    });

    // 2) Effort high: the variant reaches Claude Code's query as its effort
    await runCase("haiku.effort_high", async () => {
      const chat = await say("Think carefully, then reply with exactly EFFORT_HIGH_OK on its own line.");
      const { text, turn, usage, from } = await answered(chat);
      assert.match(text, /EFFORT_HIGH_OK/);
      const [query] = entries(world, from, "starting Claude Agent SDK query");
      assert.ok(query, "the plugin started a query");
      assert.match(String(query.model), /haiku/i, `the query's model: ${JSON.stringify(query)}`);
      if (opencode.state.variant) assert.equal(query.effort, "high", `the query's effort: ${JSON.stringify(query)}`);
      return { detail: `model=${query.model} effort=${query.effort ?? "none"} reasoning_len=${turn.answer!.reasoning?.length ?? 0} usage=${usage.total_tokens}`, usage };
    });

    // 3) PNG attachment (a data URL)
    await runCase("haiku.attach_png", async () => {
      const chat = await say("Dominant color one word (red/green/blue). Then OC_IMAGE_OK.", [{ mediaType: "image/png", data: solidPng(RED), name: "red.png" }]);
      const { text, turn, usage } = await answered(chat);
      assert.ok(JSON.stringify(turn.requests[0]!.body.messages).includes("image_url"), "the image went as image_url");
      assert.match(text, /red/i);
      assert.match(text, /OC_IMAGE_OK/);
      return { detail: oneLine(text), usage };
    });

    // 4) PDF document
    await runCase("haiku.attach_pdf", async () => {
      const chat = await say(
        "Read the attached PDF carefully. Extract the exact visible text token on the page (letters only). Then write OC_PDF_OK on the next line.",
        [{ mediaType: "application/pdf", data: textPdf("PDFTOKEN"), name: "note.pdf" }],
      );
      const { text, usage } = await answered(chat);
      assert.match(text, /PDFTOKEN/i);
      assert.match(text, /OC_PDF_OK/);
      return { detail: oneLine(text), usage };
    });

    // 5) Two images in one message, in order
    await runCase("haiku.attach_mixed_two_images", async () => {
      const chat = await say("Two images attached in order. Reply exactly: FIRST=<color> SECOND=<color> MIXED_OK", [
        { mediaType: "image/png", data: solidPng(RED), name: "red.png" },
        { mediaType: "image/png", data: solidPng(BLUE), name: "blue.png" },
      ]);
      const { text, usage } = await answered(chat);
      assert.match(text, /FIRST=\s*red/i);
      assert.match(text, /SECOND=\s*blue/i);
      assert.match(text, /MIXED_OK/);
      return { detail: oneLine(text), usage };
    });

    // 6) A file from disk (was `opencode run --file`): OpenCode names its path, then the image
    await runCase("haiku.attach_png_from_disk", async () => {
      const path = join(world.tmp, "red.png");
      const data = solidPng(RED);
      writeFileSync(path, Buffer.from(data, "base64"));
      const chat = await say("Dominant color one word, then OC_CLI_IMAGE_OK.", [{ mediaType: "image/png", data, path }]);
      const { text, turn, usage } = await answered(chat);
      assert.ok(JSON.stringify(turn.requests[0]!.body.messages).includes("Attached file:"), "OpenCode named the file");
      assert.match(text, /OC_CLI_IMAGE_OK/);
      assert.match(text, /red/i);
      return { detail: oneLine(text), usage };
    });

    // 7) Tool park + resume (MCP bridge)
    await runCase("haiku.tools_park_resume", async () => {
      const tools: ToolDefinitions = {
        get_secret: {
          description: "Return a secret code for the given label",
          input: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
        },
      };
      opencode.state.tools = tools;
      try {
        const chat = await say("Call get_secret with label=alpha. Do not invent the result; use the tool.");
        const calls: ToolCall[] = [];
        const { text, turn, usage, from } = await answered(chat, {
          toolOutput: (call) => {
            calls.push(call);
            return "SECRET_TOOL_VALUE_55";
          },
        });
        const first = turn.requests[0]!.reply!;
        assert.equal(first.finish, "tool_calls");
        assert.ok(first.toolCalls.length >= 1);
        assert.equal(first.toolCalls[0]!.name, "get_secret");
        assert.ok(first.toolCalls[0]!.id);
        assert.equal(calls[0]!.input.label, "alpha");
        assert.match(text, /SECRET_TOOL_VALUE_55/);
        assert.ok(entries(world, from, "resuming parked bridge").length >= 1, "the tool result resumed the parked turn");
        return {
          detail: `parked=${first.toolCalls.length} requests=${turn.requests.length} resume=${oneLine(text)} usage=${usage.total_tokens}`,
          usage,
          turns: turn.requests.length,
        };
      } finally {
        opencode.state.tools = {};
      }
    });

    // 8) Multi-tool park — every pending call resolved in the next request
    await runCase("haiku.tools_multi_park", async () => {
      const number = { type: "number" };
      opencode.state.tools = {
        add: { description: "Add two integers a+b", input: { type: "object", properties: { a: number, b: number }, required: ["a", "b"] } },
        mul: { description: "Multiply two integers a*b", input: { type: "object", properties: { a: number, b: number }, required: ["a", "b"] } },
      };
      try {
        const chat = await say(
          "You must call BOTH tools in this turn: add(a=3,b=4) and mul(a=5,b=6). After tool results, reply exactly: SUM=7 PRODUCT=30 TOOLS_OK",
        );
        const called: string[] = [];
        const { text, turn, usage } = await answered(chat, {
          toolOutput: (call) => {
            called.push(call.name);
            const a = Number(call.input.a);
            const b = Number(call.input.b);
            return String(call.name === "add" ? a + b : call.name === "mul" ? a * b : 0);
          },
        });
        assert.deepEqual([...new Set(called)].sort(), ["add", "mul"], `both tools ran: ${called}`);
        assert.match(text, /SUM\s*=\s*7/i);
        assert.match(text, /PRODUCT\s*=\s*30/i);
        assert.match(text, /TOOLS_OK/);
        const steps = turn.requests.map((r) => r.reply!.toolCalls.map((c) => c.name).join("+") || r.reply!.finish).join(" → ");
        return { detail: `${oneLine(text)} steps=${steps}`, usage, turns: turn.requests.length };
      } finally {
        opencode.state.tools = {};
      }
    });

    // 9) The next turn of a chat resumes its Claude session (no history transfer)
    await runCase("haiku.session_resume", async () => {
      const chat = await say("For this coding session, the repository codename is NIGHTJAR. Reply with exactly STORED_OK.");
      const first = await answered(chat);
      assert.match(first.text, /STORED_OK/, `the first answer: ${JSON.stringify({ ...first.last, headers: undefined })}\n${world.journal().slice(first.from).join("\n")}`);
      await opencode.say(chat, "What repository codename did I give you in this session? Reply with the codename only.");
      const second = await answered(chat);
      assert.match(second.text, /NIGHTJAR/);
      const [query] = entries(world, second.from, "starting Claude Agent SDK query");
      assert.equal(query?.resume, true, `the second turn resumed the Claude session: ${JSON.stringify(query)}`);
      assert.deepEqual(entries(world, second.from, "injecting transferred conversation history"), [], "no history transfer on a resume");
      const usage = usageOf([...first.turn.requests, ...second.turn.requests]);
      return { detail: `resume=${second.text.trim()}`, usage, turns: 2 };
    });

    // 10) A large prompt: its usage reflects the size (a soft check of context pressure)
    await runCase("haiku.context_large_prompt_usage", async () => {
      const blob = ("CONTEXT_PAD_LINE " + "x".repeat(200) + "\n").repeat(400);
      const chat = await say(`${blob}\n\nIgnore the padding. Reply with exactly CONTEXT_OK.`);
      const { text, last, usage } = await answered(chat);
      assert.match(text, /CONTEXT_OK/);
      const u = last.usage as Usage;
      assert.ok(u.prompt_tokens > 5000, `expected large prompt_tokens, got ${u.prompt_tokens}`);
      const compactHit = /\[compact\]/i.test(last.reasoning);
      return { detail: `prompt_tokens=${u.prompt_tokens} compact=${compactHit} reasoning_len=${last.reasoning.length}`, usage };
    });

    // 11) The rate-limit tracker recorded the CLI's telemetry of the live turns
    await runCase("haiku.rate_limit_recorded", async () => {
      const res = await fetch(`${baseURL}/rate-limit`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(typeof body.limited, "boolean");
      assert.ok(typeof body.status === "string" && body.status.length > 0, `expected recorded limiter status, got ${JSON.stringify(body)}`);
      assert.ok(body.updatedAt, "expected updatedAt");
      return { detail: `status=${body.status} util=${body.utilization ?? "n/a"} resetsAt=${body.resetsAtISO ?? "n/a"} limited=${body.limited}` };
    });

    const warnings = world.journal().filter((line) => /level=warn/.test(line));
    if (warnings.length > 0) console.log(`journal warnings:\n${warnings.join("\n")}`);
  } finally {
    await world.dispose();
  }
}

function printSummary(): void {
  const passed = RESULTS.filter((r) => r.ok).length;
  const failed = RESULTS.filter((r) => !r.ok).length;
  console.log("\n========== HAIKU MATRIX SUMMARY ==========");
  console.log(`cases: ${RESULTS.length}  pass: ${passed}  fail: ${failed}  time: ${Math.round(RESULTS.reduce((s, r) => s + r.ms, 0) / 1000)}s`);
  console.log(
    `usage totals: prompt=${TOTAL_USAGE.prompt_tokens} completion=${TOTAL_USAGE.completion_tokens} total=${TOTAL_USAGE.total_tokens} cost_usd≈${TOTAL_USAGE.cost_usd.toFixed(6)} requests=${TOTAL_USAGE.turns}`,
  );
  for (const r of RESULTS) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.id} (${r.ms}ms) — ${r.detail}`);
  }
  console.log("==========================================\n");
}

main().then(
  () => {
    printSummary();
    process.exit(RESULTS.some((r) => !r.ok) ? 1 : 0);
  },
  (err) => {
    console.error(err);
    printSummary();
    process.exit(1);
  },
);
