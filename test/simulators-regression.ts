/**
 * Chat scenarios on the simulators (test/simulators/), for any tree of the
 * plugin: what a user does in OpenCode, and what Claude then sees. The same
 * file runs on main, a preliminary branch or a chain step:
 *
 *   bun test/simulators-regression.ts                       (this checkout)
 *   $env:OPENCODE_CLAUDE_PLUGIN_DIR = "<tree>"; bun test/simulators-regression.ts
 *
 * First the simulators themselves against OpenCode 2.0.32 (the forms read in
 * its code), then the chat
 * scenarios. Each scenario prints ok or FAIL with what was seen; the exit
 * code is 1 when one failed. Every scenario reads the plugin's journal too.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { boundImages, CONTINUE_AFTER_INTERRUPTION, instructionFiles, openCodeConfigDir, CONTINUE_AFTER_OUTPUT_LIMIT, failureOf, IMAGE_REMOVED, LoweringError, lowerMessages, mediaPart, messageToText, OUTPUT_LIMIT_EXHAUSTED, outputLimitExhausted, retryDelay, SUMMARY_NUDGE, testPng, toList, type FailureKind, type ListMessage, type Msg, type Reply } from "./simulators/opencode.ts";
import { CONFIRM_MS, contentText, costOf, isChainRecord, MALFORMED_TOOL_USE_TEXT, modelAttachment } from "./simulators/claude-code.ts";
import { createWorld, pluginModule, releaseTree } from "./simulators/world.ts";

const outcomes: Array<{ name: string; ok: boolean; detail: string }> = [];
async function scenario(name: string, body: () => Promise<string | void>) {
  try {
    const detail = (await body()) ?? "";
    outcomes.push({ name, ok: true, detail });
  } catch (error) {
    outcomes.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  const last = outcomes.at(-1)!;
  console.log(`${last.ok ? "ok  " : "FAIL"} ${name}${last.detail ? `\n       ${last.detail}` : ""}`);
}

// ---- the OpenCode simulator against OpenCode's own forms ----

await scenario("lowering: text parts joined without a separator, a system update escaped after the user's text", async () => {
  const list: ListMessage[] = [
    { id: "m1", role: "user", content: [{ type: "text", text: "Attached file: a.png" }, { type: "text", text: "look" }] },
    { role: "system", content: [{ type: "text", text: "a <b> & c" }] },
  ];
  const body = lowerMessages([{ text: "S1" }, { text: "S2" }], list, "claude-sonnet-5-5");
  assert.deepEqual(body, [
    { role: "system", content: "S1\nS2" },
    { role: "user", content: "Attached file: a.pnglook\n<system-update>\na &lt;b&gt; &amp; c\n</system-update>" },
  ]);
});

await scenario("lowering: a step's tool files go as one user message after the step's results", async () => {
  const file = (n: string) => ({ type: "file", uri: n, mime: "image/png" });
  const list: ListMessage[] = [
    { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: {} }, { type: "tool-call", id: "c2", name: "read", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "content", value: [{ type: "text", text: "one" }, file("AAAA")] } }] },
    { role: "tool", content: [{ type: "tool-result", id: "c2", name: "read", result: { type: "content", value: [file("BBBB")] } }] },
    { id: "u2", role: "user", content: [{ type: "text", text: "next" }] },
  ];
  const body = lowerMessages([], list, "claude-sonnet-5-5");
  assert.deepEqual(body.map((m) => m.role), ["assistant", "tool", "tool", "user", "user"]);
  assert.equal(body[0]!.content, null);
  assert.deepEqual(body[3]!.content, [
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
  ]);
});

await scenario("lowering: a tool's image by URL stays a URL, a data URL takes the declared type, a PDF by URL cannot be sent", async () => {
  const step = (uri: string, mime: string): ListMessage[] => [
    { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "content", value: [{ type: "file", uri, mime }] } }] },
  ];
  const files = (list: ListMessage[]) => lowerMessages([], list, "claude-sonnet-5-5").at(-1)!.content;
  assert.deepEqual(files(step("https://example.com/a.png", "image/png")), [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }]);
  assert.deepEqual(files(step("data:image/jpeg;base64,QUJD", "image/png")), [{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }]);
  assert.throws(() => files(step("https://example.com/a.pdf", "application/pdf")), LoweringError);
});

await scenario("list: a user message with a file from disk; an empty answer with a tool call", async () => {
  const list = toList([
    { type: "user", id: "u1", seq: 1, text: "see", files: [{ mediaType: "image/png", data: "QUJD", name: "a.png", path: "C:\\p\\a.png" }], metadata: { k: 1 } },
    { type: "assistant", id: "a1", seq: 2, text: "", toolCalls: [{ id: "c1", name: "bash", input: {} }], toolResults: [{ id: "c1", output: "out" }] },
  ]);
  assert.deepEqual(list[0], {
    id: "u1",
    role: "user",
    content: [{ type: "text", text: "see" }, { type: "text", text: "Attached file: C:\\p\\a.png" }, mediaPart("QUJD", "image/png", "a.png")],
    metadata: { k: 1 },
  });
  assert.deepEqual(list.slice(1).map((m) => m.role), ["assistant", "tool"]);
  assert.deepEqual(list[2]!.content[0]!.result, { type: "text", value: "out" });
});

await scenario("boundImages: over 25 MiB the oldest images become OpenCode's note until 15 MiB are left", async () => {
  const big = "A".repeat(6 * 1024 * 1024);
  const list: ListMessage[] = [1, 2, 3, 4, 5].map((n) => ({ id: `u${n}`, role: "user", content: [mediaPart(big, "image/png")] }));
  const bounded = boundImages(list);
  const removed = bounded.filter((m) => m.content[0]!.type === "text").length;
  assert.equal(removed, 3, "30 MiB of five images: three removed (24, 18, 12 MiB left), 12 ≤ 15 stops");
  assert.equal(bounded[0]!.content[0]!.text, IMAGE_REMOVED);
});

await scenario("failures: OpenCode's kind and retry decision (provider-error.js, retry.ts)", async () => {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    ({ status, text: "", reasoning: "", toolCalls: [], raw: JSON.stringify(body), headers: new Headers(headers) }) as Reply;
  const cases: Array<[Reply, FailureKind, boolean]> = [
    [reply(429, { error: { type: "rate_limit_error", message: "limit" } }, { "retry-after": "30" }), "rate-limit", true],
    [reply(400, { error: { type: "invalid_request_error", message: "Prompt is too long" } }, { "x-should-retry": "false" }), "context-overflow", false],
    [reply(400, { error: { type: "invalid_request_error", message: "bad" } }, { "x-should-retry": "false" }), "invalid-request", false],
    [reply(503, { error: { type: "api_error", message: "down" } }, { "x-should-retry": "false" }), "provider-internal", false],
    [reply(500, { error: { type: "api_error", message: "boom" } }), "provider-internal", true],
    [reply(413, { error: { message: "Request too large (max 32MB)" } }), "payload-too-large", false],
    [reply(413, { error: { type: "request_too_large", message: "Request too large (max 32MB)" } }), "context-overflow", false],
    [reply(401, { error: { type: "authentication_error", message: "no" } }), "authentication", false],
    [reply(402, { error: { message: "credit" } }), "quota", false],
  ];
  for (const [r, kind, retryable] of cases) {
    const failure = failureOf(r)!;
    assert.equal(failure.kind, kind, `${r.status} ${r.raw}`);
    assert.equal(failure.retryable, retryable, `${r.status} ${r.raw} retryable`);
  }
  assert.equal(failureOf(reply(429, { error: { message: "x" } }, { "retry-after": "30" }))!.retryAfterMs, 30_000);
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => retryDelay(n)), [2_000, 4_000, 8_000, 10_000, 10_000]);
  assert.equal(retryDelay(1, 30_000), 30_000, "retry-after is the floor");
  const stream = { status: 200, text: "x", reasoning: "", toolCalls: [], headers: new Headers() } as Reply;
  assert.equal(failureOf({ ...stream, finish: "stop" }), undefined);
  assert.equal(failureOf(stream)!.kind, "incomplete-stream", "a stream with no finish_reason");
  assert.equal(failureOf({ ...stream, finish: "length" }), undefined, "a cut answer is no failure: the step decides");
});

await scenario("an answer cut at the output limit: the step fails when the three latest user and assistant messages are cut answers (instance-71svxegq.js 311–321)", async () => {
  let seq = 0;
  const msg = (type: Msg["type"], finish?: Msg["finish"]) => ({ type, id: `m${++seq}`, seq, text: "x", ...(finish ? { finish } : {}) }) as Msg;
  const user = msg("user");
  const cut = () => msg("assistant", "length");
  const synthetic = () => msg("synthetic");
  assert.equal(outputLimitExhausted([user, cut(), synthetic(), cut()]), false, "two cut answers after the user's message: once more");
  assert.equal(outputLimitExhausted([user, cut(), synthetic(), cut(), synthetic(), cut()]), true, "three cut answers, synthetic texts between: failed");
  assert.equal(outputLimitExhausted([user, msg("assistant", "tool-calls"), cut(), synthetic(), cut()]), false, "a tool step that was not cut counts");
  assert.equal(outputLimitExhausted([cut(), cut(), user, cut(), synthetic(), cut()]), false, "the user's message breaks the run");
});

// ---- chat scenarios on the plugin ----

const world = await createWorld("simulators");
const { opencode, claude } = world;
console.log(`plugin tree: ${world.dir}`);
await opencode.startPlugin();
const chatQueries = () => claude.queries.filter((q) => q.kind === "chat");
const lastChat = () => chatQueries().at(-1)!;
const times = (text: string, needle: string) => text.split(needle).length - 1;
const errorsInJournal = () => world.journal().filter((line) => /level=error/.test(line));

try {
  await scenario("the CLI outside a turn: the plugin finds it, reads its version, sign-in and model list (probe 2.1.312)", async () => {
    const until = async (what: string, ok: () => boolean) => {
      for (let waited = 0; !ok(); waited += 50) {
        assert.ok(waited < 15_000, `no ${what} in 15 s; CLI calls: ${JSON.stringify(claude.cli.calls().map((c) => c.args.slice(0, 2)))}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const started = (first: string, second?: string) => claude.cli.calls().some((c) => c.args[0] === first && (second === undefined || c.args[1] === second));
    await until("`claude --version`", () => started("--version"));
    await until("`claude auth status`", () => started("auth", "status"));
    // The model list through the SDK's control protocol: the same rows the real CLI gave.
    await until("the model list (stream-json)", () => started("--output-format", "stream-json"));
    await until("the catalog from the CLI's list", () => opencode.instances[0]!.provider.models.some((m: any) => /haiku-4-5/.test(m.id)));
    // The real SDK against the simulated process: the model list, then set_model and get_context_usage as #59 asks them.
    const { query: sdkQuery } = await import("@anthropic-ai/claude-agent-sdk");
    let release = () => {};
    const idle = (async function* () {
      await new Promise<void>((resolve) => (release = resolve));
    })();
    const executable = await (await pluginModule("executable-path")).resolveClaudeCli(process.env);
    const q = sdkQuery({ prompt: idle as any, options: { persistSession: false, pathToClaudeCodeExecutable: executable, ...(/\.js$/.test(executable) ? { executable: "node" } : {}) } as any }) as any;
    try {
      const rows = (await q.supportedModels()) as Array<{ value: string }>;
      assert.deepEqual(rows.map((r) => r.value), ["default", "opus", "fable", "sonnet", "haiku", "claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5", "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]);
      await q.setModel("claude-opus-4-6");
      assert.equal((await q.getContextUsage({ detail: "summary" })).rawMaxTokens, 200_000);
      await q.setModel("claude-opus-4-6[1m]");
      assert.equal((await q.getContextUsage({ detail: "summary" })).rawMaxTokens, 1_000_000);
      await assert.rejects(q.setModel("claude-sonnet-4-6[1m]"), /Sonnet with 1M context is not available for your account/);
      await assert.rejects(q.setModel("no-such-model"), /Model 'no-such-model' not found/);
    } finally {
      release();
      q.close();
    }
    return `${claude.cli.calls().length} starts of the CLI: ${[...new Set(claude.cli.calls().map((c) => c.args[0]))].join(", ")}`;
  });

  await scenario("the CLI signed out, offline, an older one (temp/cli-oob2-probe); its control requests logged; OpenCode's reloads counted", async () => {
    const { query: sdkQuery } = await import("@anthropic-ai/claude-agent-sdk");
    const executable = await (await pluginModule("executable-path")).resolveClaudeCli(process.env);
    /** One idle query of the real SDK against the world's CLI; `run` asks it, then it is closed. */
    const idleQuery = async <T,>(run: (q: any) => Promise<T>): Promise<T> => {
      let release = () => {};
      const idle = (async function* () {
        await new Promise<void>((resolve) => (release = resolve));
      })();
      const q = sdkQuery({ prompt: idle as any, options: { persistSession: false, pathToClaudeCodeExecutable: executable, ...(/\.js$/.test(executable) ? { executable: "node" } : {}) } as any }) as any;
      try {
        return await run(q);
      } finally {
        release();
        q.close();
      }
    };
    claude.cli.set({ auth: "loggedOut" });
    await idleQuery(async (q) => {
      assert.deepEqual(((await q.supportedModels()) as Array<{ value: string }>).map((r) => r.value), ["default", "opus", "fable", "sonnet", "haiku"]);
      assert.deepEqual((await q.initializationResult()).account, { tokenSource: "none", apiProvider: "firstParty" });
      assert.equal((await q.getContextUsage({ detail: "summary" })).rawMaxTokens, 1_000_000, "the window of the model it starts on");
      await assert.rejects(q.setModel("claude-sonnet-5-5"), /Unable to validate model: Could not resolve authentication method/);
      await q.setModel("claude-opus-5-5[1m]");
      await q.setModel("sonnet");
      assert.equal((await q.getContextUsage({ detail: "summary" })).rawMaxTokens, 1_000_000, "an alias's window");
      await q.setModel("haiku");
    });
    claude.cli.set({ auth: undefined, account: { subscriptionType: "Claude Pro" }, offline: true, unsupported: ["get_context_usage"] });
    await idleQuery(async (q) => {
      assert.equal((await q.initializationResult()).account.subscriptionType, "Claude Pro");
      await assert.rejects(q.setModel("claude-opus-4-6[1m]"), /Network error\. Please check your internet connection\./);
      await assert.rejects(q.setModel("claude-sonnet-4-6[1m]"), /Sonnet with 1M context is not available/, "a refusal the CLI knows by itself still comes");
      await assert.rejects(q.getContextUsage({ detail: "summary" }), /Unsupported control request subtype: get_context_usage/);
    });
    claude.cli.set({ account: undefined, offline: undefined, unsupported: undefined });
    // Give the closed process a moment to log the end of its input.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const controls = claude.cli.controls();
    const last = controls.at(-1)!.pid;
    assert.deepEqual(controls.filter((c) => c.pid === last && c.subtype === "set_model").map((c) => c.model), ["claude-opus-4-6[1m]", "claude-sonnet-4-6[1m]"]);
    assert.ok(controls.some((c) => c.pid === last && c.end === "stdin-closed"), `the SDK's close() ended the input: ${JSON.stringify(controls.filter((c) => c.pid === last))}`);
    // Signed out, Haiku 5.5 runs at 1M as the other models (CLI 2.1.312 with an empty profile).
    claude.cli.set({ auth: "loggedOut" });
    await idleQuery(async (q) => {
      await q.setModel("haiku");
      const usage = await q.getContextUsage({ detail: "summary" });
      assert.deepEqual([usage.model, usage.rawMaxTokens], ["claude-haiku-5-5", 1_000_000]);
    });
    claude.cli.set({ auth: undefined });
    const instance = opencode.instances[0]!;
    const before = instance.reloads.count;
    await instance.ctx.provider.reload();
    assert.equal(instance.reloads.count, before + 1);
    instance.reloads.fails = "location disposed";
    await assert.rejects(instance.ctx.provider.reload(), /location disposed/);
    instance.reloads.fails = undefined;
  });

  await scenario("the CLI's windows (temp/cli-windows-probe): the 1M switch in the environment and settings.json, a [1m] the account may use, an API key", async () => {
    const { query: sdkQuery } = await import("@anthropic-ai/claude-agent-sdk");
    const { join } = await import("node:path");
    const { rmSync, writeFileSync } = await import("node:fs");
    const executable = await (await pluginModule("executable-path")).resolveClaudeCli(process.env);
    /** One idle query of the real SDK against the world's CLI, with this environment and these setting sources. */
    const idleQuery = async <T,>(options: { env?: Record<string, string>; settingSources?: string[] }, run: (q: any) => Promise<T>): Promise<T> => {
      let release = () => {};
      const idle = (async function* () {
        await new Promise<void>((resolve) => (release = resolve));
      })();
      const q = sdkQuery({
        prompt: idle as any,
        options: {
          persistSession: false, pathToClaudeCodeExecutable: executable, ...(/\.js$/.test(executable) ? { executable: "node" } : {}),
          ...(options.env ? { env: { ...process.env, ...options.env } } : {}), ...(options.settingSources ? { settingSources: options.settingSources } : {}),
        } as any,
      }) as any;
      try {
        return await run(q);
      } finally {
        release();
        q.close();
      }
    };
    const windowAfter = async (q: any, id?: string) => {
      if (id) await q.setModel(id);
      const usage = await q.getContextUsage({ detail: "summary" });
      return `${usage.model} ${usage.rawMaxTokens}`;
    };
    // The switch in the environment: every model at 200K, a [1m] of Opus 4.6 refused by the CLI itself, one it
    // accepts keeps its suffix.
    await idleQuery({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: " TRUE " } }, async (q) => {
      assert.equal(await windowAfter(q), "claude-opus-5-5 200000");
      assert.equal(await windowAfter(q, "sonnet"), "claude-sonnet-5-5 200000");
      assert.equal(await windowAfter(q, "claude-fable-5-1[1m]"), "claude-fable-5-1[1m] 200000");
      await assert.rejects(q.setModel("claude-opus-4-6[1m]"), /Opus with 1M context is not available for your account/);
      await assert.rejects(q.setModel("claude-sonnet-5[1m]"), /Sonnet with 1M context is not available for your account/);
    });
    await idleQuery({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" } }, async (q) => assert.equal(await windowAfter(q, "claude-fable-5-1[1m]"), "claude-fable-5-1 1000000", "off: a 1M model drops [1m]"));
    // The switch in the profile's settings.json: read with the user's settings, over the environment.
    const settings = join(process.env.CLAUDE_CONFIG_DIR!, "settings.json");
    writeFileSync(settings, JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: true } }));
    try {
      await idleQuery({ settingSources: ["user"], env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0" } }, async (q) => assert.equal(await windowAfter(q, "claude-opus-4-6"), "claude-opus-4-6 200000"));
      await idleQuery({ settingSources: [] }, async (q) => assert.equal(await windowAfter(q, "claude-opus-4-6[1m]"), "claude-opus-4-6[1m] 1000000", "the user's settings not loaded"));
    } finally {
      rmSync(settings, { force: true });
    }
    // A [1m] the probed account was refused, lifted: the account may use it.
    claude.cli.set({ setModelErrors: { "claude-sonnet-4-6[1m]": null } });
    try {
      await idleQuery({}, async (q) => {
        assert.equal(await windowAfter(q, "claude-sonnet-4-6[1m]"), "claude-sonnet-4-6[1m] 1000000");
        await assert.rejects(q.setModel("claude-haiku-4-5-20251001[1m]"), /long context beta is not yet available/, "the other refusal stays");
      });
      await idleQuery({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" } }, async (q) => {
        await assert.rejects(q.setModel("claude-sonnet-4-6[1m]"), /Sonnet with 1M context is not available/, "the switch refuses it whatever the account");
      });
    } finally {
      claude.cli.set({ setModelErrors: undefined });
    }
    // An API key: five rows, the key's source in the account, the switches the API accepts.
    claude.cli.set({ auth: "apiKey" });
    try {
      await idleQuery({}, async (q) => {
        assert.deepEqual(((await q.supportedModels()) as Array<{ value: string }>).map((r) => r.value), ["default", "opus", "fable", "sonnet", "haiku"]);
        assert.deepEqual((await q.initializationResult()).account, { tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" });
        assert.equal(await windowAfter(q, "claude-sonnet-4-6[1m]"), "claude-sonnet-4-6[1m] 1000000");
        assert.equal(await windowAfter(q, "claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001 200000");
      });
    } finally {
      claude.cli.set({ auth: undefined });
    }
  });

  await scenario("install layouts of the CLI (npm view 2.1.312): each found where the plugin looks, each answering as the CLI", async () => {
    const { spawnSync } = await import("node:child_process");
    const { join } = await import("node:path");
    const windows = process.platform === "win32";
    const run = (file: string) => spawnSync(/\.js$/.test(file) ? "node" : file, /\.js$/.test(file) ? [file, "--version"] : ["--version"], { encoding: "utf8" }).stdout.trim();
    const pkg = (dir: string) => join(dir, "node_modules", "@anthropic-ai", "claude-code");
    const cases: Array<[string, (dir: string) => string]> = [
      ["npm-legacy", (dir) => join(pkg(dir), "cli.js")],
      ["npm", (dir) => join(pkg(dir), "bin", windows ? "claude.exe" : "claude")],
      ["local-bin", (dir) => join(dir, windows ? "claude.exe" : "claude")],
    ];
    for (const [layout, entry] of cases) {
      const dir = join(world.tmp, `layout-${layout}`);
      const handle = claude.installCli(dir, { layout: layout as any });
      assert.equal(run(entry(dir)), "2.1.312 (Claude Code)", layout);
      assert.equal(handle.calls().length, 1, `${layout}: the start is logged in its own install`);
    }
    const orphan = claude.installCli(join(world.tmp, "layout-orphan"), { layout: "orphan" });
    assert.equal(orphan.home, undefined, "an orphaned shim has nothing to run");
    assert.ok(claude.cli.calls().every((c) => !c.args.includes("layout")), "claude.cli stays the CLI on PATH");
  });

  await scenario("`claude update` of a native install as 2.1.300 printed it live: the outcome, the version after it, a helper holding the output", async () => {
    const { spawn, spawnSync } = await import("node:child_process");
    const { join } = await import("node:path");
    const dir = join(world.tmp, "update-local-bin");
    const handle = claude.installCli(dir, { layout: "local-bin" });
    const exe = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    const run = (...args: string[]) => spawnSync(exe, args, { encoding: "utf8" });
    const version = () => run("--version").stdout.trim();
    let r = run("update");
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "Current version: 2.1.312\nChecking for updates to latest version...\nClaude Code is up to date (2.1.312)\n");
    handle.set({ update: { outcome: "updated", to: "2.1.313" } });
    r = run("update");
    assert.equal(r.status, 0);
    assert.equal(r.stdout.split("\n").at(-2), "Successfully updated from 2.1.312 to version 2.1.313");
    assert.equal(version(), "2.1.313 (Claude Code)", "the new version answers");
    assert.match(run("update").stdout, /Claude Code is up to date \(2\.1\.313\)/, "then it is up to date");
    handle.set({ version: "2.1.312", update: { outcome: "launcherHeld", to: "2.1.313" } });
    assert.match(run("update").stdout, /Successfully updated from 2\.1\.312 to version 2\.1\.313/);
    assert.equal(version(), "2.1.312 (Claude Code)", "the launcher held open: the old version stays");
    handle.set({ update: { outcome: "cutMidway", to: "2.1.313" } });
    r = run("update");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^Error: Failed to install native update\nTelemetrySafeError: The connection dropped while downloading the update \(attempt 3\/3: aborted\)\..*\nTry running "claude doctor" for diagnostics\n$/);
    handle.set({ update: { outcome: "busy" } });
    r = run("update");
    assert.equal(r.status, 0, "busy exits 0: the plugin must read the output");
    assert.match(r.stdout, /^Another Claude process \(PID \d+\) is currently running\. Please try again in a moment\.\n$/);
    // A helper holds the output: the process exits at once, the pipes close later with the helper's text.
    handle.set({ update: { outcome: "upToDate", afterExit: { ms: 400, text: "late line\n" } } });
    const child = spawn(exe, ["update"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += chunk));
    const started = performance.now();
    const exited = new Promise<number>((resolve) => child.on("exit", () => resolve(performance.now() - started)));
    const closed = new Promise<number>((resolve) => child.on("close", () => resolve(performance.now() - started)));
    const [exitedAt, closedAt] = await Promise.all([exited, closed]);
    assert.ok(closedAt - exitedAt >= 300, `the output closed after the helper (exit ${Math.round(exitedAt)} ms, close ${Math.round(closedAt)} ms)`);
    assert.ok(output.endsWith("late line\n"), output);
    // An npm install: the failures the binary's strings hold; its success is not probed, the simulator says so.
    const npm = claude.installCli(join(world.tmp, "update-npm"), { layout: "npm-legacy" });
    const npmUpdate = () => spawnSync("node", [join(npm.home!, "cli.js"), "update"], { encoding: "utf8" });
    r = npmUpdate();
    assert.equal(r.status, 70);
    assert.match(r.stderr, /does not know `claude update` of an npm install/);
    npm.set({ update: { outcome: "npmOffline" } });
    r = npmUpdate();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Failed to check for updates\nUnable to fetch latest version from npm registry\n\nPossible causes:/);
    // Seen in anthropics/claude-code issues: a PATH warning on every run (#104403), an update with no output (#66946),
    // a hang after "Checking for updates" (docs, before 2.1.214), and an npm update that leaves the placeholder (#96265).
    handle.set({ version: "2.1.312", update: { outcome: "upToDate", pathWarning: true } });
    assert.match(run("update").stdout, /up to date \(2\.1\.312\)\nWarning: Native installation exists but ~\/\.local\/bin is not in your PATH\nFix: /);
    handle.set({ update: { outcome: "silent", code: 3 } });
    r = run("update");
    assert.deepEqual([r.status, r.stdout, r.stderr], [3, "", ""]);
    handle.set({ update: { outcome: "fetchRefused" } });
    assert.match(run("update").stderr, /status code 403\n$/);
    handle.set({ update: { outcome: "eexist", to: "2.1.313" } });
    r = run("update");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^Error: Failed to install native update\nError: EEXIST: file already exists, mkdir '.*versions'\nTry running "claude doctor"/);
    handle.set({ update: { outcome: "socketClosed" } });
    r = run("update");
    assert.deepEqual([r.status, r.stdout], [1, ""]);
    assert.match(r.stderr, /^Error: The socket connection was closed unexpectedly\./);
    handle.set({ update: { outcome: "homebrew", to: "2.1.313" } });
    r = run("update");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Claude is managed by Homebrew\.\nUpdate available: 2\.1\.312 → 2\.1\.313\n\nTo update, run:\n  brew upgrade claude-code\n$/);
    handle.set({ update: { outcome: "bunImpostor", to: "2.1.313" } });
    assert.match(run("update").stdout, /Successfully updated from 2\.1\.312 to version 2\.1\.313/);
    assert.equal(version(), "1.4.0", "Bun's version where Claude Code should be (#80933)");
    handle.set({ versionText: undefined });
    handle.set({ update: { outcome: "hang" } });
    r = spawnSync(exe, ["update"], { encoding: "utf8", timeout: 1_500 });
    assert.equal(r.stdout, "Current version: 2.1.312\nChecking for updates to latest version...\n", "hangs after the preamble");
    const npmBin = claude.installCli(join(world.tmp, "update-npm-bin"), { layout: "npm" });
    const npmExe = join(npmBin.home!, process.platform === "win32" ? "claude.exe" : "claude");
    npmBin.set({ update: { outcome: "npmPlaceholderLeft", to: "2.1.313" } });
    r = spawnSync(npmExe, ["update"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Successfully updated from 2\.1\.312 to version 2\.1\.313\n$/);
    r = spawnSync(npmExe, ["--version"], { encoding: "utf8" });
    assert.ok(!/\(Claude Code\)/.test(r.stdout ?? "") && (r.error !== undefined || r.status !== 0), `the placeholder answers no version: ${r.status} ${r.error} ${r.stderr}`);
  });

  await scenario("what the plugin hands the SDK: its real query starter, the real SDK, the simulated CLI process logs the start", async () => {
    // One start of the CLI, the turn stopped by the user, no repeat (throughRealSdk checks these).
    const start = await world.throughRealSdk(claude.cli, "Q-sdk-path");
    assert.ok(start, "the SDK started the CLI and sent initialize");
    // SDK 0.3.300 writes `--model=<id>`, 0.3.224 (main's lock) `--model <id>`.
    assert.ok(start!.args.includes("--input-format") && start!.args.some((a) => a === "--model" || a.startsWith("--model=")), start!.args.join(" "));
    assert.equal(start!.runner, process.platform === "win32" ? "node" : start!.runner, "npm's cli.js runs through node");
    assert.ok("sdkMcpServers" in start!.initialize!, "the plugin's MCP server reaches the CLI");
    return `initialize: ${Object.keys(start!.initialize!).join(", ")}`;
  });

  await scenario("a title and a summary through the real SDK: the start logged, the process killed on the prompt (probes 8, 10)", async () => {
    const title = await world.throughRealSdk(claude.cli, "Q-title", "title");
    assert.ok(title.args.includes("--input-format"), title.args.join(" "));
    const summary = await world.throughRealSdk(claude.cli, "Q-summary", "summary");
    assert.ok(summary.args.some((a) => a === "--resume" || a.startsWith("--resume=")) && summary.args.includes("--fork-session"), `a summary forks the chat: ${summary.args.join(" ")}`);
    assert.equal(JSON.parse(readFileSync(join(world.tmp, "bin", "node_modules", "@anthropic-ai", "claude-code", "state.json"), "utf8")).killOnPrompt, undefined, "the switch is off again");
    // The next chat turn is the simulator's again.
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-after");
    assert.ok((await opencode.turn(chat)).ok);
  });

  await scenario("an error result reports the calls' usage, cost and modelUsage (temp/cli-failures2-probe tool-then-400); a fresh module copy", async () => {
    const name = crypto.randomUUID();
    for await (const _ of (await claude.chat({ prompt: "Q-usage-first", sessionId: name, model: "claude-haiku-4-5" })).stream as AsyncIterable<any>);
    claude.state.failures = ["oauthOrg"];
    let result: any;
    // The SDK throws after the error result, as it does for the CLI's.
    await assert.rejects(async () => {
      for await (const e of (await claude.chat({ prompt: "Q-usage", resume: name, model: "claude-haiku-4-5" })).stream as AsyncIterable<any>) if (e.type === "result") result = e;
    }, /Claude Code returned an error result/);
    assert.equal(result.is_error, true);
    for (const key of ["cache_creation_input_tokens", "cache_read_input_tokens", "input_tokens", "output_tokens"]) assert.equal(typeof result.usage[key], "number", key);
    assert.equal(result.usage.input_tokens, 0, "this query's calls: none answered");
    assert.ok(result.total_cost_usd > 0, "the session's cost so far");
    assert.ok(result.modelUsage && Object.keys(result.modelUsage).length === 1, JSON.stringify(result.modelUsage));
    const [one, two, again] = await Promise.all([pluginModule("usage"), pluginModule("usage", { copy: "reloaded" }), pluginModule("usage")]);
    assert.notEqual(one, two, "a copy is another instance");
    assert.equal(one, again);
  });

  await scenario("usage as CLI 2.1.312 counts it (temp/not-yet-probe usage-resume, usage-copy-and-side, prices): the session's cost and modelUsage, the price by model", async () => {
    const drain = async (params: Record<string, unknown>) => {
      let result: any;
      for await (const e of (await claude.chat(params as any)).stream as AsyncIterable<any>) if (e.type === "result") result = e;
      return result;
    };
    const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);
    const name = crypto.randomUUID();
    claude.state.usage = { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 5 };
    const first = await drain({ prompt: "Q-spend-1", sessionId: name, model: "claude-haiku-4-5" });
    near(first.total_cost_usd, 0.000405);
    assert.equal(first.modelUsage["claude-haiku-4-5"].canonicalModel, "claude-haiku-4-5");
    assert.equal(first.modelUsage["claude-haiku-4-5"].contextWindow, 200_000);
    claude.state.usage = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 7 };
    const second = await drain({ prompt: "Q-spend-2", resume: name, model: "claude-haiku-4-5" });
    near(second.total_cost_usd, 0.000478);
    assert.deepEqual([second.usage.input_tokens, second.modelUsage["claude-haiku-4-5"].inputTokens, second.modelUsage["claude-haiku-4-5"].outputTokens], [10, 110, 12], "usage this query's, modelUsage the session's");
    claude.state.usage = { input_tokens: 6, cache_creation_input_tokens: 8, cache_read_input_tokens: 10, output_tokens: 12 };
    const third = await drain({ prompt: "Q-spend-3", resume: name, model: "claude-sonnet-5-5" });
    near(third.modelUsage["claude-sonnet-5-5"].costUSD, 0.000153);
    assert.equal(third.modelUsage["claude-sonnet-5-5"].contextWindow, 1_000_000);
    assert.equal(third.modelUsage["claude-haiku-4-5"].canonicalModel, undefined, "a model only restored does not name itself");
    near(claude.records(name).findLast((r) => r.type === "cost-state")!.totalCostUSD, third.total_cost_usd);
    // A copy and a side query start from the source's cost; the side query writes none.
    claude.state.usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 70 };
    const copy = await drain({ prompt: "Q-spend-copy", resume: name, forkSession: true, sessionId: crypto.randomUUID(), model: "claude-haiku-4-5" });
    assert.equal(copy.modelUsage["claude-haiku-4-5"].inputTokens, 1110);
    const costLines = claude.records(name).filter((r) => r.type === "cost-state").length;
    const side = await drain({ prompt: "Q-spend-side", resume: name, persistSession: false, model: "claude-haiku-4-5" });
    assert.equal(side.modelUsage["claude-haiku-4-5"].inputTokens, 1110);
    assert.equal(claude.records(name).filter((r) => r.type === "cost-state").length, costLines);
    claude.state.usage = {};
    // The price by model, $ a million: Opus 5.5 4 / 20, Fable 5.1 10 / 50, an unknown model as the CLI's default.
    assert.deepEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-unknown-9"].map((m) => costOf(m, { input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })), [24, 60, 30]);
  });

  await scenario("a refusal by model and category as CLI 2.1.312 ends it (temp/not-yet-probe refusal-*): the fallback model, its notice, the texts", async () => {
    const run = async (model: string, details: Record<string, unknown> | undefined) => {
      claude.state.failures = ["refusal"];
      claude.state.refusalDetails = details as any;
      const events: any[] = [];
      let threw = "";
      const name = crypto.randomUUID();
      try {
        for await (const e of (await claude.chat({ prompt: "Q-refuse", sessionId: name, model })).stream as AsyncIterable<any>) events.push(e);
      } catch (error) {
        threw = String(error);
      }
      return { events, threw, name };
    };
    const haiku = await run("claude-haiku-4-5", { category: "bio", explanation: "x" });
    assert.match(haiku.threw, /Haiku 4\.5 can't help with this\. Start a new session to continue\.\n\nLearn more: https:\/\/www\.anthropic\.com\/legal\/aup\n\nDetails: `\[bio\]`/);
    const opus = await run("claude-opus-5-5", { category: "bio", explanation: "x" });
    const fallback = opus.events.find((e) => e.subtype === "model_refusal_fallback");
    assert.equal(fallback?.fallback_model, "claude-opus-5");
    assert.match(fallback.content, /^Opus 5\.5's safeguards flagged this session\. .*biology-research-adjacent work\. .*Opus 5 is answering instead/);
    const retracted = fallback.retracted_message_uuids[0];
    assert.ok(opus.events.some((e) => e.type === "assistant" && e.uuid === retracted), "the retracted call streamed");
    assert.ok(!claude.records(opus.name).some((r) => r.uuid === retracted), "and was not written");
    assert.equal(opus.events.find((e) => e.subtype === "model_refusal_no_fallback")?.original_model, "claude-opus-5");
    assert.match(opus.threw, /Opus 5's safeguards flagged this message \(https:\/\/www\.anthropic\.com\/legal\/aup\)\. Our intentionally broad .*biology tasks\. Claude Code can't respond to this message with Opus 5\.\n\nTry rephrasing.*\n\nLearn more: https:\/\/support\.claude\.com\/en\/articles\/16049681/s);
    const answered = await run("claude-fable-5-1", { category: "cyber", explanation: "x", fallbackAnswers: true });
    assert.equal(answered.threw, "");
    assert.match(answered.events.find((e) => e.subtype === "model_refusal_fallback").content, /^Fable 5\.1's safeguards flagged this message\. .* Switched to Opus 4\.8\./);
    assert.equal(answered.events.at(-1).subtype, "success");
    assert.ok(answered.events.at(-1).modelUsage["claude-opus-4-8"], "the fallback model's call counted");
    claude.state.refusalDetails = undefined;
  });

  await scenario("the CLI's retries and 5xx texts (temp/cli-failures-probe, the CLI's code): the api_error record's error whole; the status page for Anthropic's own address", async () => {
    const run = async (env: Record<string, string> | undefined) => {
      claude.state.failures = ["overloaded"];
      const name = crypto.randomUUID();
      let threw = "";
      try {
        for await (const _ of (await claude.chat({ prompt: "Q-529", sessionId: name, ...(env ? { env } : {}) })).stream as AsyncIterable<any>);
      } catch (error) {
        threw = String(error);
      }
      return { threw, records: claude.records(name) };
    };
    const own = await run(undefined);
    assert.match(own.threw, /529 Overloaded\. This is a server-side issue, usually temporary — try again in a moment\. If it persists, check https:\/\/status\.claude\.com\.$/);
    const retried = own.records.find((r) => r.subtype === "api_error")!;
    const { requestId, ...error } = retried.error;
    assert.deepEqual(error, { message: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', status: 529, formatted: "529 Overloaded", connection: null, isNetworkDown: false, rateLimits: null, noResponse: null });
    // The attempt's request id (the API's `request-id` header) and the record's source (CLI 2.1.312 against a local stub of the API answering 529).
    assert.match(String(requestId), /^req_sim_\d+$/);
    assert.equal(retried.source, "request_retry");
    const synthetic = own.records.find((r) => r.isApiErrorMessage)!;
    assert.ok(synthetic.error === "server_error" && /^req_sim_\d+$/.test(synthetic.requestId) && synthetic.requestId !== requestId, "529's record: server_error, the last attempt's request id");
    const gateway = await run({ ANTHROPIC_BASE_URL: "http://127.0.0.1:35316" });
    assert.match(gateway.threw, /If it persists, check your inference gateway \(127\.0\.0\.1:35316\)\.$/);
  });

  await scenario("the stream of a model call as CLI 2.1.312 passes its usage on (temp/stream-usage-probe usage-*): the assistant events the message_start snapshot, message_delta the final count and thinking tokens, the records the final count; each call its own usage", async () => {
    // Two calls of one query (a refusal: the CLI calls once more), each with its own usage — the live case of 500 059
    // then 501 050 of context; the first reports thinking tokens.
    claude.state.failures = ["refusal"];
    claude.state.usage = [
      { input_tokens: 2, cache_read_input_tokens: 500_059, cache_creation_input_tokens: 0, output_tokens: 168, output_tokens_details: { thinking_tokens: 120 } },
      { input_tokens: 2, cache_read_input_tokens: 500_059, cache_creation_input_tokens: 991, output_tokens: 40 },
    ];
    const name = crypto.randomUUID();
    const events: any[] = [];
    try {
      for await (const e of (await claude.chat({ prompt: "Q-stream-usage", sessionId: name, model: "claude-opus-5-5" })).stream as AsyncIterable<any>) events.push(e);
    } catch {}
    assert.deepEqual(claude.state.usage, [], "each call took its entry");
    claude.state.usage = {};
    const starts = events.filter((e) => e.event?.type === "message_start").map((e) => e.event.message.usage);
    assert.deepEqual(starts, [
      { input_tokens: 2, cache_read_input_tokens: 500_059, cache_creation_input_tokens: 0, output_tokens: 1 },
      { input_tokens: 2, cache_read_input_tokens: 500_059, cache_creation_input_tokens: 991, output_tokens: 1 },
    ]);
    const assistants = events.filter((e) => e.type === "assistant" && !e.error);
    assert.equal(assistants.length, 2, "a text block of each call");
    for (const e of assistants) {
      assert.equal(e.message.usage.output_tokens, 1, "an assistant event carries the opening snapshot");
      assert.equal(e.message.stop_reason, null);
    }
    const deltas = events.filter((e) => e.event?.type === "message_delta").map((e) => e.event.usage);
    assert.deepEqual(deltas, [{ output_tokens: 168, output_tokens_details: { thinking_tokens: 120 } }, { output_tokens: 40 }]);
    const answers = claude.records(name).filter((r) => r.type === "assistant" && !r.isApiErrorMessage);
    assert.deepEqual(
      answers.map((r) => [r.message.usage.cache_creation_input_tokens, r.message.usage.output_tokens, r.message.usage.output_tokens_details.thinking_tokens, r.message.usage.service_tier]),
      [[0, 168, 120, "standard"], [991, 40, 0, "standard"]],
      "each record its call's final count",
    );
    assert.ok(answers.every((r) => /^req_sim_\d+$/.test(r.requestId)), "the records name the API's request id");
    const result = events.find((e) => e.type === "result");
    assert.deepEqual([result.usage.cache_read_input_tokens, result.usage.output_tokens, result.usage.output_tokens_details.thinking_tokens], [1_000_118, 208, 120], "the result sums the query's calls");
    assert.equal(claude.records(name).findLast((r) => r.type === "cost-state")!.modelUsage["claude-opus-5-5"].thinkingTokens, 120);
    const synthetic = claude.records(name).find((r) => r.isApiErrorMessage)!;
    assert.deepEqual([synthetic.message.usage.output_tokens_details, synthetic.message.usage.service_tier], [null, null], "the synthetic record's usage is empty");
  });

  await scenario("failures CLI 2.1.312 names by their own codes (temp/stream-usage-probe fail-*, the CLI's code): 404 model_not_found, 403 verification_required, no cloud credentials, account on hold", async () => {
    const run = async (failure: any, env?: Record<string, string>) => {
      claude.state.failures = [failure];
      const name = crypto.randomUUID();
      const events: any[] = [];
      let threw = "";
      try {
        for await (const e of (await claude.chat({ prompt: `Q-${failure}`, sessionId: name, model: "claude-haiku-4-5", ...(env ? { env } : {}) })).stream as AsyncIterable<any>) events.push(e);
      } catch (error) {
        threw = String(error);
      }
      const lines = claude.records(name);
      const record = lines.find((r) => r.isApiErrorMessage)!;
      const result = events.find((e) => e.type === "result");
      return { threw, events, lines, record, result, retries: events.filter((e) => e.subtype === "api_retry") };
    };
    const missing = await run("modelNotFound");
    assert.deepEqual([missing.record.error, missing.record.apiErrorStatus, missing.result.api_error_status], ["model_not_found", 404, 404]);
    assert.match(missing.threw, /There's an issue with the selected model \(claude-haiku-4-5\)\. It may not exist or you may not have access to it\.$/);
    assert.equal(missing.lines.filter((r) => r.type === "api-request").length, 2, "streaming, then once more without streaming");
    assert.deepEqual(missing.retries, []);
    const verify = await run("verificationRequired");
    assert.deepEqual([verify.record.error, verify.record.apiErrorStatus, verify.record.apiErrorCode], ["verification_required", 403, "verification_required"]);
    assert.match(verify.threw, /API Error: Verify your identity/);
    const bedrock = await run("cloudCredentials", { CLAUDE_CODE_USE_BEDROCK: "1" });
    assert.deepEqual([bedrock.record.error, bedrock.record.apiErrorStatus, bedrock.record.requestId, bedrock.result.api_error_status], ["cloud_credential_error", undefined, undefined, null]);
    assert.deepEqual(bedrock.retries.map((e) => [e.attempt, e.max_retries, e.error_status, e.error]), [[1, 2, null, "cloud_credential_error"], [2, 2, null, "cloud_credential_error"]]);
    assert.match(bedrock.threw, /Could not load AWS credentials · Could not load credentials from any providers\./);
    const errors = bedrock.lines.filter((r) => r.subtype === "api_error");
    assert.ok(errors.length === 2 && errors.every((r) => r.error.isCloudCredentialError === true && r.error.requestId === undefined && r.source === "request_retry"));
    const vertex = await run("cloudCredentials", { CLAUDE_CODE_USE_VERTEX: "1", GOOGLE_APPLICATION_CREDENTIALS: "C:\\no\\key.json" });
    assert.match(vertex.threw, /Could not load Google Cloud credentials · The file at C:\\no\\key\.json does not exist/);
    const onHold = await run("accountOnHold");
    assert.deepEqual([onHold.record.error, onHold.record.apiErrorStatus, onHold.result.api_error_status], ["account_on_hold", undefined, null]);
    assert.match(onHold.threw, /Your account is on hold and can't use Claude Code\. View details or appeal: https:\/\/claude\.ai\/restricted$/);
    // 529: `overloaded` is the retry event's code, the record's is server_error.
    claude.state.failures = ["overloaded"];
    const events: any[] = [];
    try {
      for await (const e of (await claude.chat({ prompt: "Q-529-codes", sessionId: crypto.randomUUID() })).stream as AsyncIterable<any>) events.push(e);
    } catch {}
    assert.ok(events.filter((e) => e.subtype === "api_retry").every((e) => e.error === "overloaded"));
    assert.equal(events.find((e) => e.type === "assistant" && e.error)?.error, "server_error");
  });

  await scenario("the CLI's auto compaction is reactive (temp/not-yet-probe compact-reactive): the API's prompt too long, then the boundary, the summary and the kept question", async () => {
    const drain = async (params: Record<string, unknown>) => {
      const events: any[] = [];
      let threw = "";
      try {
        for await (const e of (await claude.chat(params as any)).stream as AsyncIterable<any>) events.push(e);
      } catch (error) {
        threw = String(error);
      }
      return { events, threw };
    };
    const name = crypto.randomUUID();
    await drain({ prompt: "Q-react-1", sessionId: name });
    claude.state.failures = ["promptTooLong"];
    // `settings` as the SDK passes them: the setting left alone (the CLI's default, on).
    const compacted = await drain({ prompt: "Q-react-2", resume: name, settings: {} });
    assert.equal(compacted.threw, "");
    const boundary = compacted.events.find((e) => e.subtype === "compact_boundary");
    assert.equal(boundary.compact_metadata.trigger, "auto");
    const question = claude.records(name).find((r) => r.type === "user" && contentText(r.message?.content) === "Q-react-2")!;
    assert.equal(boundary.compact_metadata.preserved_segment.head_uuid, question.uuid, "the turn's question kept");
    const view = claude.queries.at(-1)!.view;
    assert.ok(view.indexOf("Summary:") >= 0 && view.indexOf("Q-react-2") > view.indexOf("Summary:"), `the model reads the summary, then the question: ${view.slice(0, 120)}`);
    assert.ok(!view.includes("Q-react-1"));
    await drain({ prompt: "Q-react-3", resume: name });
    assert.ok(claude.queries.at(-1)!.view.includes("Q-react-2"), "a later turn still reads the kept question");
    // The setting off: the CLI fails as the API did.
    claude.state.failures = ["promptTooLong"];
    const off = await drain({ prompt: "Q-react-off", sessionId: crypto.randomUUID(), settings: { autoCompactEnabled: false } });
    assert.match(off.threw, /Prompt is too long/);
  });

  await scenario("too long after a tool step and in a side query, the CLI's auto compaction on (temp/cli-too-long-probe of test/simulators-opencode-prompt)", async () => {
    const results: string[] = [];
    // After a tool step: the request after the tool's result refused; the CLI compacts with nothing kept verbatim -
    // the summary alone (the tools used named), environment and model before the part's context - and answers.
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-tool-too-long one");
    await opencode.turn(chat);
    await opencode.say(chat, "Q-tool-too-long two");
    claude.state.toolTurn = true;
    claude.state.failures = ["promptTooLong"];
    claude.state.failingCall = 2;
    const from = claude.queries.length;
    const turn = await opencode.turn(chat);
    claude.state.failures = [];
    const query = claude.queries[from]!;
    const settings = (query.params as Record<string, any>).settings;
    if (settings?.autoCompactEnabled === false) {
      // The tree turns the CLI's compaction off: it fails as the API did.
      assert.ok(claude.records(query.name).some((r) => r.isApiErrorMessage), "the CLI's failure");
      results.push("auto compaction off: the turn's query failed");
    } else {
      assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
      const records = claude.records(query.name);
      const boundaryAt = records.findIndex((r) => r.subtype === "compact_boundary");
      const boundary = records[boundaryAt]!;
      assert.equal(boundary.compactMetadata.trigger, "auto");
      assert.equal(boundary.compactMetadata.preservedSegment, undefined, "nothing kept verbatim");
      const after = records.slice(boundaryAt + 1).filter(isChainRecord).map((r) => (r.isCompactSummary ? "summary" : r.attachment?.type ?? r.type));
      assert.deepEqual(after.slice(0, 6), ["summary", "environment", "model", "session_context", "date", "prompt_snapshot"], after.join(","));
      const summary = records.find((r) => r.isCompactSummary)!;
      assert.match(String(summary.message.content), /<tools-used-before-summary>mcp__opencode__bash<\/tools-used-before-summary>/);
      assert.match(String(summary.message.content), /read the full transcript at: .*\.jsonl\n/);
      assert.match(String(summary.message.content), /Pick up the last task as if the break never happened\.$/, "no note on kept messages");
      assert.ok(query.view.startsWith("This session is being continued") && !query.view.includes("Q-tool-too-long two"), `the model reads the summary alone: ${query.view.slice(0, 80)}`);
      results.push(`compacted after the tool step (${after.length} records after the boundary)`);
    }
    // A side query (no transcript) on a chat: compacts, writes nothing, keeps its question; off: fails.
    const name = crypto.randomUUID();
    for await (const _ of (await claude.chat({ prompt: "Q-side one", sessionId: name })).stream as AsyncIterable<any>);
    const lines = claude.records(name).length;
    const side = async (settings: Record<string, unknown>) => {
      claude.state.summaryFailures = ["promptTooLong"];
      const events: any[] = [];
      let threw = "";
      try {
        for await (const e of (await claude.chat({ prompt: "Q-side question", resume: name, persistSession: false, settings } as any)).stream as AsyncIterable<any>) events.push(e);
      } catch (error) {
        threw = String(error);
      } finally {
        claude.state.summaryFailures = [];
      }
      return { events, threw };
    };
    const on = await side({});
    assert.equal(on.threw, "");
    const boundary = on.events.find((e) => e.subtype === "compact_boundary");
    assert.ok(boundary.compact_metadata.preserved_segment, "the question kept");
    const summaryText = on.events.find((e) => e.type === "user" && e.isSynthetic).message.content[0].text as string;
    assert.match(summaryText, /Summary:\n[\s\S]*\n\nNote: the earliest part of the conversation was too large to include and is NOT covered by this summary\. If the task/);
    assert.doesNotMatch(summaryText, /full transcript/);
    assert.match(summaryText, /\n\nThe messages after this summary are the most recent messages from before compaction/);
    assert.equal(on.events.at(-1).num_turns, 2);
    assert.ok(claude.queries.at(-1)!.view.includes("Q-side question"), "the side question after the summary");
    assert.equal(claude.records(name).length, lines, "the side query wrote nothing");
    const off = await side({ autoCompactEnabled: false });
    assert.match(off.threw, /Prompt is too long/);
    results.push("a side query compacted, and failed with the setting off");
    assert.deepEqual(errorsInJournal(), [], "no error in the plugin's journal");
    return results.join("; ");
  });

  await scenario("a 401 as CLI 2.1.312 ends it (temp/cli-failures-probe \"401 authentication\"): ten retries, the synthetic record, the result", async () => {
    claude.state.failures = ["authentication"];
    const events: any[] = [];
    const name = crypto.randomUUID();
    await assert.rejects(async () => {
      for await (const e of (await claude.chat({ prompt: "Q-401", sessionId: name })).stream as AsyncIterable<any>) events.push(e);
    }, /Claude Code returned an error result: Invalid API key · Fix external API key/);
    const retries = events.filter((e) => e.subtype === "api_retry");
    assert.equal(retries.length, 10);
    assert.ok(retries.every((e) => e.error_status === 401 && e.error === "authentication_failed"));
    assert.deepEqual(retries.map((e) => e.retry_delay_ms).slice(-3), [32_000, 32_000, 32_000], "the waits stop doubling at 32 s");
    const result = events.find((e) => e.type === "result");
    assert.equal(result.api_error_status, 401);
    assert.equal(result.terminal_reason, "api_error");
    assert.ok(claude.records(name).some((r) => r.isApiErrorMessage && r.error === "authentication_failed"));
  });

  await scenario("rate-limit events where a subscription sends them (temp/cli-ratelimit-probe): as the response starts, and after the answer", async () => {
    claude.state.rateLimitEvents = [{ status: "allowed", rateLimitType: "five_hour", resetsAt: 1 }];
    claude.state.rateLimitEventsAfter = [{ status: "allowed_warning", rateLimitType: "seven_day_overage_included", utilization: 0.85, surpassedThreshold: 0.75, resetsAt: 2 }];
    const order: string[] = [];
    for await (const e of (await claude.chat({ prompt: "Q-limits", sessionId: crypto.randomUUID() })).stream as AsyncIterable<any>) {
      order.push(e.type === "stream_event" ? e.event.type : e.type === "rate_limit_event" ? `rate_limit:${e.rate_limit_info.status}` : `${e.type}${e.subtype ? `/${e.subtype}` : ""}${e.status ? `:${e.status}` : ""}`);
    }
    const at = (name: string) => order.indexOf(name);
    assert.ok(at("system/status:requesting") < at("rate_limit:allowed") && at("rate_limit:allowed") < at("message_start"), order.join(" "));
    assert.ok(at("message_stop") < at("rate_limit:allowed_warning") && at("rate_limit:allowed_warning") < at("result/success"), order.join(" "));
  });

  await scenario("Opus 5.5's blocks (temp/cli-narration-probe) and the CLI's sign-in (temp/cli-login-probe)", async () => {
    const { THINKING_SIGNATURE } = await import("./simulators/claude-code.ts");
    claude.state.thinking = "";
    const events: any[] = [];
    for await (const event of (await claude.chat({ prompt: "Q-think", sessionId: crypto.randomUUID() })).stream as AsyncIterable<any>) events.push(event);
    const deltas = events.filter((e) => e.event?.type === "content_block_delta").map((e) => e.event.delta);
    assert.deepEqual(deltas.slice(0, 2), [{ type: "thinking_delta", thinking: "" }, { type: "signature_delta", signature: THINKING_SIGNATURE }]);
    assert.ok(Buffer.from(THINKING_SIGNATURE, "base64").toString("latin1").includes("B\bthinking"), "the signature carries the tag");
    claude.state.thinking = undefined;
    // The sign-in prints the authorize URL with a new state each start, then waits for the code.
    const { spawnSync } = await import("node:child_process");
    const { join } = await import("node:path");
    const cliJs = join(world.tmp, "bin", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    const states = [1, 2].map(() => {
      const out = spawnSync("node", [cliJs, "auth", "login", "--claudeai"], { encoding: "utf8", input: "" }).stdout;
      assert.match(out, /^Opening browser to sign in…\nIf the browser didn't open, visit: https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&/);
      return /state=([\w-]+)/.exec(out)![1];
    });
    assert.notEqual(states[0], states[1]);
  });

  await scenario("the plugin's installer against the simulator's curl and bash (npm: not on Windows, a .cmd it cannot spawn)", async () => {
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");
    const install = await pluginModule("cli-install");
    claude.installers.install(join(world.tmp, "bin"));
    claude.installers.set({ npm: "fail" });
    const ok = await install.installClaudeCli();
    assert.deepEqual(ok, { ok: true });
    assert.ok(claude.installers.calls().some((c) => c.command === "bash"), "the script ran");
    assert.ok(existsSync(join(process.env.USERPROFILE ?? process.env.HOME!, ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude")), "claude in ~/.local/bin");
    claude.installers.set({ curl: "fail" });
    const failed = await install.installClaudeCli();
    assert.equal(failed.ok, false);
    assert.match(failed.message, /Install script failed: curl: failed/);
  });

  await scenario("the CLI signed in with an API key: the plugin refuses the turn (auth status as the probe saw it)", async () => {
    claude.cli.set({ auth: "apiKey" });
    // The plugin keeps a sign-in check for a minute; this drops it, the real probe then runs.
    world.plugin.detect.setAuthStatusProbe(null);
    try {
      const chat = opencode.newChat();
      await opencode.say(chat, "Q-api-key");
      const turn = await opencode.turn(chat);
      assert.equal(turn.ok, false, "the turn is refused");
      const said = JSON.stringify(turn.requests.at(-1)?.reply?.raw ?? turn.failure ?? "");
      assert.match(said, /signed in with an API key/, said);
    } finally {
      claude.cli.set({ auth: undefined });
      world.plugin.detect.setAuthStatusProbe(null);
    }
  });

  await scenario("interrupt() as CLI 2.1.312 ends a turn (temp/cli-interrupt-probe): mid-answer, and before the answer", async () => {
    const run = async (holdWhere: "holdMidAnswer" | "hold") => {
      const name = crypto.randomUUID();
      let release = () => {};
      claude.state[holdWhere] = new Promise<void>((resolve) => (release = resolve));
      // The input as the probe gave it (and the plugin does): a stream, a message with a uuid, open until the end.
      let endInput = () => {};
      const open = new Promise<void>((resolve) => (endInput = resolve));
      const prompt = (async function* () {
        yield { type: "user", message: { role: "user", content: "Q-interrupt" }, parent_tool_use_id: null, uuid: crypto.randomUUID() };
        await open;
      })();
      const handle: any = await claude.chat({ prompt, sessionId: name });
      const events: any[] = [];
      let threw = "";
      const reading = (async () => {
        try {
          for await (const event of handle.stream) events.push(event);
        } catch (error) {
          threw = String(error);
        }
      })();
      for (let waited = 0; holdWhere === "holdMidAnswer" && !events.some((e) => e.event?.type === "content_block_delta"); waited += 10) {
        assert.ok(waited < 2_000, "the answer started");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      await handle.interrupt();
      await reading;
      endInput();
      release();
      const chain = claude.records(name).filter(isChainRecord);
      return { events, threw, chain };
    };
    const mid = await run("holdMidAnswer");
    // A message with a uuid is a command (CLI 2.1.312 and SDK 0.3.300 against a local stub of the API): queued,
    // started, cancelled after the stop's result — which is why the SDK throws the exit code, not the result's text.
    assert.deepEqual(mid.events.filter((e) => e.type === "command_lifecycle").map((e) => e.state), ["queued", "started", "cancelled"]);
    assert.match(mid.threw, /exited with code 1/);
    assert.ok(mid.events.some((e) => e.type === "assistant" && e.aborted), "the shown part streamed as an aborted answer");
    assert.deepEqual(mid.events.filter((e) => e.type === "result").map((e) => e.terminal_reason), ["aborted_streaming"]);
    assert.deepEqual(mid.chain.slice(-2).map((r) => r.type), ["assistant", "user"]);
    assert.equal(mid.chain.at(-1)!.message.content[0].text, "[Request interrupted by user]");
    const before = await run("hold");
    assert.match(before.threw, /exited with code 1/);
    assert.ok(!before.chain.some((r) => r.type === "assistant"), "no answer before it started");
    assert.equal(before.chain.at(-1)!.message.content[0].text, "[Request interrupted by user]");
  });

  await scenario("model calls as CLI 2.1.312 reports them (temp/cli-failures2-probe): retries, a refusal's details, one step too many, a failure after a tool", async () => {
    const drain = async (handle: any) => {
      const events: any[] = [];
      let threw = "";
      try {
        for await (const event of handle.stream) events.push(event);
      } catch (error) {
        threw = String(error);
      }
      return { events, threw };
    };
    // Two retries of the CLI's own, then the answer.
    claude.state.apiRetries = { failure: "overloaded", attempts: 2 };
    const retried = crypto.randomUUID();
    const a = await drain(await claude.chat({ prompt: "Q-retries", sessionId: retried }));
    assert.equal(a.threw, "");
    assert.deepEqual(a.events.filter((e) => e.subtype === "api_retry").map((e) => [e.attempt, e.error_status, e.error]), [[1, 529, "overloaded"], [2, 529, "overloaded"]]);
    assert.equal(claude.records(retried).filter((r) => r.subtype === "api_error").length, 2);
    assert.equal(a.events.at(-1).subtype, "success");
    // A refusal with its stop_details and no text: nothing streamed, the details in the event.
    claude.state.failures = ["refusal"];
    claude.state.refusalDetails = { category: "cyber", explanation: "an attack", text: "" };
    const b = await drain(await claude.chat({ prompt: "Q-refused", sessionId: crypto.randomUUID() }));
    assert.ok(!b.events.some((e) => e.event?.type === "content_block_delta"), "the refused calls streamed nothing");
    const refusal = b.events.find((e) => e.subtype === "model_refusal_no_fallback");
    assert.equal(refusal.api_refusal_category, "cyber");
    assert.equal(refusal.api_refusal_explanation, "an attack");
    assert.match(b.threw, /safeguards flagged this message/);
    // A side query that asked for a tool in its single step.
    claude.state.summaryFailures = ["maxTurns"];
    const c = await drain(await claude.chat({ prompt: "Q-title", persistSession: false }));
    assert.equal(c.events.at(-1).subtype, "error_max_turns");
    assert.match(c.threw, /Reached maximum number of turns \(1\)/);
    // The model call after a tool step fails: the file holds the result, then the synthetic error.
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-tool-then-failure");
    claude.state.toolTurn = true;
    // A failure the CLI's own compaction does not answer (a prompt too long would be compacted where the setting is on).
    claude.state.failures = ["badRequest"];
    claude.state.failingCall = 2;
    const queriesBefore = claude.queries.length;
    const turn = await opencode.turn(chat);
    const seen = claude.queries.slice(queriesBefore).map((q) => `${q.kind}:${q.outcome}`).join(" ");
    // The turn's first query (OpenCode may send the step again: later queries).
    const records = claude.records(claude.queries[queriesBefore]!.name).filter(isChainRecord);
    assert.ok(records.some((r) => r.toolUseResult !== undefined), `a tool step ran (queries: ${seen}; requests ${turn.requests.map((r) => r.status).join(",")})`);
    const resultAt = records.findIndex((r) => r.toolUseResult !== undefined);
    const errorAt = records.findIndex((r) => r.isApiErrorMessage);
    assert.ok(resultAt >= 0 && errorAt > resultAt, `the tool's result, then the failure: ${records.map((r) => r.type).join(",")}`);
  });

  await scenario("the CLI compacts by itself (temp/cli-compact-probe): a boundary off the chain, the summary; the model reads from it, a resume point may lie before it", async () => {
    const drain = async (handle: any) => {
      for await (const _ of handle.stream);
    };
    const name = crypto.randomUUID();
    await drain(await claude.chat({ prompt: "Q-pre-compaction", sessionId: name }));
    const before = claude.leafOf(name)!.uuid!;
    claude.state.compactBeforeAnswer = { summary: "SUMMARY-X" };
    await drain(await claude.chat({ prompt: "Q-compacting", resume: name }));
    const records = claude.records(name);
    const boundary = records.find((r) => r.subtype === "compact_boundary")!;
    assert.equal(boundary.parentUuid, null);
    // Between them the part's context and date, as cli-contract-live saw on CLI 2.1.312 (check 22).
    const summary = records.find((r) => r.isCompactSummary)!;
    const between = claude.chainTo(name, summary.uuid!).slice(-3, -1).map((r) => r.attachment?.type);
    assert.equal(claude.chainTo(name, summary.uuid!).at(-4)?.uuid, boundary.uuid, "the summary hangs off the boundary");
    assert.deepEqual(between, ["session_context", "date"]);
    await drain(await claude.chat({ prompt: "Q-after", resume: name }));
    const view = claude.queries.at(-1)!.view;
    assert.ok(!view.includes("Q-pre-compaction") && view.includes("SUMMARY-X"), `the model reads from the summary: ${view.slice(0, 200)}`);
    assert.ok(claude.onLeafChain(name, before), "a resume point before the boundary is on the chain (check C 22)");
  });

  await scenario("two turns: the second continues the first, Claude sees each message once", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-alpha first question");
    const first = await opencode.turn(chat);
    assert.ok(first.ok, `first turn: ${first.requests.at(-1)?.status} ${first.requests.at(-1)?.reply?.raw ?? ""}`);
    assert.equal(first.requests[0]!.body.stream, true);
    await opencode.say(chat, "Q-beta second question");
    const second = await opencode.turn(chat);
    assert.ok(second.ok, "second turn");
    const view = lastChat().view;
    assert.equal(times(view, "Q-alpha"), 1, `Claude saw the first question ${times(view, "Q-alpha")} times: ${view}`);
    assert.equal(times(view, "Q-beta"), 1);
    assert.equal(times(view, first.answer!.text), 1, "the first answer once");
    assert.ok(world.journal().length > 0, "the plugin wrote its journal");
    const named = chatQueries()[0]!.params.sessionId !== undefined ? "the plugin names the transcript (sessionId)" : "the CLI names the transcript";
    const metadata = opencode.session(chat).messages[0]!.metadata;
    return `${named}; prompt hook metadata: ${metadata ? JSON.stringify(metadata) : "none"}`;
  });

  await scenario("a query whose start takes time (holdStart): no CLI process until it is released, then answered once", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-tau slow start");
    let release!: () => void;
    claude.state.holdStart = new Promise<void>((resolve) => (release = resolve));
    const held = claude.heldStarts;
    const queries = claude.queries.length;
    const starts = claude.cli.calls().length;
    const turn = opencode.turn(chat);
    for (let waited = 0; claude.heldStarts === held; waited += 10) {
      if (waited > 5_000) throw new Error("the start was not held");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(claude.queries.length, queries, "the start holds: no query ran yet");
    assert.equal(claude.cli.calls().length, starts, "and no CLI process started");
    release();
    assert.ok((await turn).ok, "the turn answers once the start is released");
    assert.equal(claude.queries.length, queries + 1, "one query only");
  });

  await scenario("every chat query goes through the plugin's real starter and the real SDK into the CLI process", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-tau2 through the SDK");
    const starts = claude.cli.calls().filter((call) => call.initialize).length;
    assert.ok((await opencode.turn(chat)).ok);
    const query = lastChat();
    const start = claude.cli.calls().filter((call) => call.initialize).at(-1)!;
    assert.equal(claude.cli.calls().filter((call) => call.initialize).length, starts + 1, "one CLI process for the turn");
    assert.deepEqual(query.params.args, start.args, "the query reads the process's own arguments");
    // SDK 0.3.300 writes `--model=<id>`, 0.3.224 (main's lock) `--model <id>`: both are the SDK's own form.
    const modelArg = start.args.some((arg, i) => arg === `--model=${query.params.model}` || (arg === "--model" && start.args[i + 1] === query.params.model));
    assert.ok(modelArg, `the model as the SDK wrote it: ${start.args.join(" ")}`);
    assert.ok((query.params.mcpServers as Record<string, unknown>).opencode, "the plugin's MCP server named in initialize");
  });

  await scenario("records without a turn confirmed as CLI 2.1.312 confirms them (temp/confirm-probe): the first once the process started, the later ones a few ms after; readAt; confirmMs sets it", async () => {
    /** A chat query on the simulator whose input the scenario feeds as the SDK would, message by message. */
    const fed = async (params: Record<string, unknown>) => {
      const queue: any[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      const seen = new Set<string>();
      const waiters = new Map<string, () => void>();
      async function* prompt() {
        for (;;) {
          while (queue.length === 0 && !done) await new Promise<void>((resolve) => (wake = resolve));
          if (queue.length === 0) return;
          yield queue.shift();
        }
      }
      const handle: any = await claude.chat({ ...params, prompt: prompt() } as any);
      const query = claude.queries.at(-1)!;
      const results: any[] = [];
      const reading = (async () => {
        for await (const e of handle.stream as AsyncIterable<any>) {
          if (e.type !== "result") continue;
          results.push(e);
          if (e.num_turns === 0 && e.user_message_uuid) {
            seen.add(e.user_message_uuid);
            waiters.get(e.user_message_uuid)?.();
          }
        }
      })();
      return {
        query,
        send: (uuid: string, noTurn = true) => {
          queue.push({ type: "user", message: { role: "user", content: uuid }, parent_tool_use_id: null, uuid, ...(noTurn ? { shouldQuery: false } : {}) });
          wake?.();
        },
        confirmed: (uuid: string) => (seen.has(uuid) ? Promise.resolve() : new Promise<void>((resolve) => waiters.set(uuid, resolve))),
        end: async () => {
          done = true;
          wake?.();
          await reading;
          return results;
        },
      };
    };
    const entry = (q: (typeof claude.queries)[number], uuid: string) => q.input.find((i) => i.uuid === uuid)!;
    const took = (q: (typeof claude.queries)[number], uuid: string) => entry(q, uuid).confirmedAt! - entry(q, uuid).readAt;
    const withoutTurn = (name: string) => claude.records(name).filter((r) => r.queueTranscriptOnly).map((r) => [r.uuid, r.message?.content]);
    const { startingNew, startingResume, running } = CONFIRM_MS;
    // On Windows a timer fires up to a millisecond early, and late by any amount: the lower bounds hold; the upper ones allow
    // for the lateness a timer of this process showed meanwhile (`lag`: under load every timer here is late alike).
    const upTo = 150;
    let lag = 0;
    let last = performance.now();
    const meter = setInterval(() => {
      const now = performance.now();
      lag = Math.max(lag, now - last - 5);
      last = now;
    }, 5);
    try {
      // A new transcript as the plugin hands it: the start record, a record once that is confirmed, the last one with the question at once.
      const name = crypto.randomUUID();
      const first = await fed({ sessionId: name });
      first.send("S");
      await first.confirmed("S");
      first.send("A");
      await first.confirmed("A");
      first.send("B");
      first.send("Q", false);
      const firstResults = await first.end();
      const q1 = first.query;
      assert.deepEqual(firstResults.map((r) => r.user_message_uuid), ["S", "A", "B", "Q"], "each record confirmed, then the question's turn");
      assert.deepEqual(withoutTurn(name), [["S", "S"], ["A", "A"], ["B", "B"]], "each under its own name");
      // By what they mean, not the clock's milliseconds: under load Windows fires a timer a few ms early.
      assert.ok(took(q1, "S") >= startingNew / 2 && took(q1, "S") < startingNew + running + upTo + lag, `the first record, the process starting: ${took(q1, "S").toFixed(1)} ms (timers late by up to ${lag.toFixed(0)} ms)`);
      assert.ok(took(q1, "A") >= 0 && took(q1, "A") < running + upTo + lag, `a later one: ${took(q1, "A").toFixed(1)} ms`);
      assert.ok(took(q1, "S") > took(q1, "A"), "the first waits for the process's start, the later ones do not");
      assert.ok(entry(q1, "Q").readAt < entry(q1, "B").confirmedAt!, "the question read before the record ahead of it was confirmed");
      assert.equal(entry(q1, "Q").confirmedAt, undefined, "a question is not confirmed so");

      // A resumed process: its first records wait for its start and are joined (cli-contract-live.ts, check 5.1); a record
      // that comes to a running one is taken alone, the ones that came meanwhile together, under the last one's name.
      const resumed = await fed({ resume: name });
      resumed.send("X");
      resumed.send("Y");
      await resumed.confirmed("Y");
      resumed.send("C1");
      resumed.send("C2");
      resumed.send("C3");
      await resumed.confirmed("C3");
      const resumedResults = await resumed.end();
      const q2 = resumed.query;
      assert.deepEqual(resumedResults.map((r) => r.user_message_uuid), ["Y", "C1", "C3"]);
      assert.deepEqual(withoutTurn(name).slice(3), [["Y", "X\nY"], ["C1", "C1"], ["C3", "C2\nC3"]], "joined under the last one's name");
      assert.ok(took(q2, "Y") >= startingResume / 2 && took(q2, "Y") < startingResume + running + upTo + lag, `a resumed process's first record: ${took(q2, "Y").toFixed(1)} ms`);
      assert.equal(entry(q2, "X").confirmedAt, undefined, "a record joined into the next is not confirmed by its own name");
      assert.equal(q2.outcome, "records");

      // confirmMs: at once.
      claude.state.confirmMs = { starting: 0, running: 0 };
      try {
        const instant = await fed({ resume: name });
        instant.send("I");
        await instant.confirmed("I");
        await instant.end();
        assert.ok(took(instant.query, "I") < running + 20 + lag, `confirmMs 0: ${took(instant.query, "I").toFixed(1)} ms`);
      } finally {
        claude.state.confirmMs = undefined;
      }
      return `new ${took(q1, "S").toFixed(1)} ms, resumed ${took(q2, "Y").toFixed(1)} ms, running ${took(q1, "A").toFixed(1)}–${took(q2, "C1").toFixed(1)} ms`;
    } finally {
      clearInterval(meter);
    }
  });

  await scenario("a process killed after its records without a turn (killedAfterRecords): the question is not in the file", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-upsilon first");
    assert.ok((await opencode.turn(chat)).ok);
    // Another model's turn: a tree that names records sends it as a record without a turn first.
    await opencode.say(chat, "Q-upsilon elsewhere");
    opencode.otherModelAnswer(chat, "answered by another model");
    await opencode.say(chat, "Q-upsilon killed");
    const before = claude.queries.length;
    claude.state.failures = ["killedAfterRecords"];
    const turn = await opencode.turn(chat);
    claude.state.failures = [];
    const killed = claude.queries[before]!;
    assert.equal(killed.outcome, "killed");
    assert.equal(killed.trigger, undefined, "the killed process wrote no record with the turn (a retry of OpenCode's may write it later)");
    return `records without a turn confirmed: ${killed.input.filter((m) => m.noTurn).length}; OpenCode's turn ${turn.ok ? "answered on a retry" : "failed"}`;
  });

  await scenario("session.context and the list as OpenCode 2.0.32 keeps them: reasoning, skills, files; a message at each tool step", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-phi with a skill", [{ mediaType: "image/png", data: testPng("Q-phi", 4, 4).toString("base64"), name: "shot.png" }], { skills: [{ name: "review", text: "SKILL-TEXT review" }] });
    const asked = opencode.session(chat).messages.at(-1)!;
    const listed = toList([asked])[0]!;
    assert.equal(listed.content[0]!.text, "SKILL-TEXT review", "the list: the skill's text first (to-llm-message.ts)");
    assert.match(messageToText(asked), /^\[Skill activated: review\]\nSKILL-TEXT review\n\[User\]: Q-phi with a skill\n\[Attached image\/png: shot\.png\]$/);
    claude.state.thinking = "THOUGHT-phi";
    claude.state.toolSteps = [[{ name: "bash", input: { command: "a" } }], [{ name: "bash", input: { command: "b" } }]];
    const turn = await opencode.turn(chat, { steer: ["STEER-one", "STEER-two"] });
    claude.state.thinking = undefined;
    assert.ok(turn.ok, "the turn answered");
    const infos = (await opencode.context({ sessionID: chat })) as Array<Record<string, any>>;
    const user = infos.find((m) => m.id === asked.id)!;
    assert.deepEqual(user.skills, [{ name: "review", text: "SKILL-TEXT review" }]);
    assert.equal(user.files?.[0]?.mime, "image/png", "the files of the message");
    assert.deepEqual(user.files?.[0]?.source, { type: "inline" }, "an inline file's source (history.d.ts 80–96)");
    const skill = opencode.between(chat, "skill", "SKILL-BODY lint", { skillName: "lint" });
    assert.equal(messageToText(skill), "[Skill activated: lint]\nSKILL-BODY lint", "a skill message in a summary's text: its name, then its text");
    assert.ok(infos.some((m) => m.type === "assistant" && m.content[0]?.type === "reasoning" && m.content[0].text === "THOUGHT-phi"), "an answer's reasoning first");
    const texts = opencode.session(chat).messages.filter((m) => m.type === "user").map((m) => m.text);
    assert.deepEqual(texts.slice(-2), ["STEER-one", "STEER-two"], "a message at each tool step, in order");
  });

  await scenario("the CLI's service records as CLI 2.1.312 writes them: a question, a second one, a tool step with a message meanwhile", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-service one");
    assert.ok((await opencode.turn(chat)).ok);
    await opencode.say(chat, "Q-service two");
    assert.ok((await opencode.turn(chat)).ok);
    await opencode.say(chat, "Q-service tool");
    claude.state.toolSteps = [[{ name: "bash", input: { command: "a" } }]];
    assert.ok((await opencode.turn(chat, { steer: ["STEER-service"] })).ok);
    const name = claude.queries.at(-1)!.name;
    const lines = claude.records(name);
    const kind = (r: Record<string, any>) =>
      r.type === "attachment" ? `${r.attachment.type}${r.attachment.type === "prompt_snapshot" ? (Array.isArray(r.attachment.tools) ? " full" : " partial") : ""}` : r.type === "user" && r.queueTranscriptOnly ? "no turn" : r.type === "user" && r.toolUseResult ? "result" : r.type;
    const chain = lines.filter(isChainRecord).map(kind);
    // The cli-contract-live run of 29.10.2026 (BEHAVIOR.md "Transcript files"): a file that starts with a record
    // without a turn has its environment and model after that record, otherwise after the first question.
    const start = chain[0] === "no turn" ? ["no turn", "environment", "model", "user"] : ["user", "environment", "model"];
    assert.deepEqual(chain, [
      ...start,
      "total_tokens_reminder", "session_context", "date", "prompt_snapshot partial",
      "assistant", "prompt_snapshot full",
      "user", "total_tokens_reminder", "assistant",
      "user", "total_tokens_reminder", "assistant", "result", "queued_command", "total_tokens_reminder", "assistant",
    ]);
    const off = new Set(lines.filter((r) => !isChainRecord(r)).map((r) => r.type));
    for (const type of ["queue-operation", "api-request-shape", "api-request-blob", "api-request", "last-prompt", "cost-state"]) assert.ok(off.has(type), `no ${type} line`);
    assert.equal(lines.findLast((r) => r.type === "last-prompt")?.lastPrompt, "Q-service tool");
    return `${chain.length} chain records`;
  });

  await scenario("the service records' contents and moments as CLI 2.1.312 writes them (temp/service-records-probe): a question with an image, a resumed one, a tool step with an image", async () => {
    // The model attachment by the probe's table: a known id, an alias, `[1m]`, a model the CLI does not know.
    assert.equal(modelAttachment("claude-haiku-4-5").text, "You are powered by the model named Haiku 4.5. The exact model ID is claude-haiku-4-5. Assistant knowledge cutoff is February 2025.");
    assert.deepEqual(modelAttachment("opus").identity, { modelId: "claude-opus-5-5", marketingName: "Opus 5.5", knowledgeCutoff: "June 2026" });
    assert.equal(modelAttachment("claude-sonnet-4-6[1m]").identity.knowledgeCutoff, "August 2025");
    assert.deepEqual(modelAttachment("claude-fable-9"), { type: "model", identity: { modelId: "claude-fable-9", marketingName: null, knowledgeCutoff: null }, text: "You are powered by the model claude-fable-9." });
    const chat = opencode.newChat();
    const picture = testPng("RECORDS-IMAGE");
    await opencode.say(chat, "Q-records one", [{ mediaType: "image/png", data: picture, name: "shot.png" }]);
    assert.ok((await opencode.turn(chat)).ok);
    const first = claude.queries.at(-1)!;
    await opencode.say(chat, "Q-records two");
    assert.ok((await opencode.turn(chat)).ok);
    const second = claude.queries.at(-1)!;
    await opencode.say(chat, "Q-records tool");
    claude.state.toolTurn = true;
    const toolPicture = testPng("RECORDS-TOOL-IMAGE");
    assert.ok((await opencode.turn(chat, { toolOutput: "the picture", toolFiles: [{ mime: "image/png", data: toolPicture, name: "p.png" }] })).ok);
    const third = claude.queries.at(-1)!;
    assert.equal(third.name, first.name, "one transcript");
    const lines = claude.records(first.name);
    const kind = (r: Record<string, any>) =>
      r.type === "attachment" ? `${r.attachment.type}${r.attachment.type === "prompt_snapshot" ? (Array.isArray(r.attachment.tools) ? " full" : " partial") : ""}` : r.type === "user" && r.queueTranscriptOnly ? "no turn" : r.type;
    /** A turn's lines: from its question's queue lines to its cost-state. */
    const turnLines = (query: typeof first) => {
      const at = lines.findIndex((r) => r.uuid === query.trigger);
      const end = lines.findIndex((r, i) => i > at && r.type === "cost-state");
      return lines.slice(at - 2, end + 1);
    };
    // The file's first turn, line by line as the probe's new file (records without a turn before it, if the tree sends any).
    assert.deepEqual(turnLines(first).map(kind), [
      "queue-operation", "queue-operation", "user", ...(lines.some((r) => r.queueTranscriptOnly) ? [] : ["environment", "model"]), "total_tokens_reminder", "atis-latch",
      "session_context", "date", "prompt_snapshot partial", "api-request-shape", "api-request-blob", "api-request", "assistant", "prompt_snapshot full",
      "last-prompt", "cost-state",
    ], "the first turn");
    // A resumed process: no shape again (the file has it), `mode` between the last prompt and the cost.
    if (second.params.resume) {
      assert.deepEqual(turnLines(second).map(kind), ["queue-operation", "queue-operation", "user", "total_tokens_reminder", "api-request-blob", "api-request", "assistant", "last-prompt", "mode", "cost-state"], "a resumed turn");
    }
    // The tool step: `tools-used` once, before the call's record; the result's reminder counts what the step read and wrote.
    const toolTurn = turnLines(third);
    assert.deepEqual(lines.filter((r) => r.type === "tools-used").map((r) => r.tools), [["mcp__opencode__bash"]]);
    const callAt = toolTurn.findIndex((r) => r.type === "assistant" && r.message?.content?.[0]?.type === "tool_use");
    assert.equal(toolTurn[callAt - 1]?.type, "tools-used", "tools-used right before the call's record");
    const reminders = toolTurn.filter((r) => r.attachment?.type === "total_tokens_reminder").map((r) => Number(/\d+/.exec(r.attachment.text)![0]));
    assert.ok(reminders.length === 2 && reminders[0] === 15_000_000 && reminders[1]! < 15_000_000, `the tokens left: ${reminders}`);
    // The environment and the model as the CLI writes them, with the text the model reads.
    const environment = lines.find((r) => r.attachment?.type === "environment")!;
    assert.notEqual(environment.attachment.snapshot.osVersion, "simulated");
    assert.match(environment.rendered[0].content, /^<system-reminder>\n# Environment\nYou have been invoked in the following environment: \n - Primary working directory: /);
    const model = lines.find((r) => r.attachment?.type === "model")!;
    assert.deepEqual(model.attachment, modelAttachment(String(first.params.model)), "the model of the query");
    assert.equal(model.rendered[0].content, `<system-reminder>\n${model.attachment.text}\n</system-reminder>`);
    // The full snapshot's tools and the request shape's: the offered tools with their schemas, by name.
    const snapshot = lines.find((r) => r.attachment?.type === "prompt_snapshot" && Array.isArray(r.attachment.tools))!.attachment;
    assert.ok(snapshot.tools.length > 0 && snapshot.tools.every((t: any) => t.name.startsWith("mcp__opencode__") && t.server === "opencode" && t.schema?.name === t.name && t.schema.input_schema), "the snapshot's tools");
    assert.equal(snapshot.cliPrefix, "You are a Claude agent, built on Anthropic's Claude Agent SDK.");
    const shapes = lines.filter((r) => r.type === "api-request-shape");
    assert.equal(shapes.length, new Set(shapes.map((r) => r.shapeHash)).size, "a shape once a file");
    assert.deepEqual(shapes[0].shape.tools.map((t: any) => t.name), snapshot.tools.map((t: any) => t.name));
    // Blobs: once a hash; the question's holds the reminders, the question and the image's data again; the tool
    // result's holds its image's data and the tokens left inside the result.
    const blobs = lines.filter((r) => r.type === "api-request-blob");
    assert.equal(blobs.length, new Set(blobs.map((r) => r.hash)).size, "a blob once a file");
    const firstBlob = JSON.stringify(blobs[0].message);
    for (const text of ["# Environment", "You are powered by the model", "tokens left", "Today's date is", "Q-records one", picture.toString("base64")]) assert.ok(firstBlob.includes(text), `the first blob holds ${text.slice(0, 30)}`);
    const resultBlob = blobs.find((r) => r.message.content.some((b: any) => b.type === "tool_result"));
    assert.ok(resultBlob, "the tool result's blob");
    const inResult = resultBlob.message.content.find((b: any) => b.type === "tool_result").content;
    assert.ok(JSON.stringify(inResult).includes(toolPicture.toString("base64")) && String(inResult.at(-1).text).includes("tokens left"), "the result's image data and the tokens left in it");
    // Requests: a process's first sends all, the next one keeps what the first sent and adds the answer and the result.
    const requests = toolTurn.filter((r) => r.type === "api-request");
    assert.equal(requests.length, 2);
    assert.ok(requests[0].base === undefined && requests[0].keep === 0, "a process's first request");
    assert.ok(requests[1].base === requests[0].id && requests[1].keep === requests[0].tail.length && requests[1].tail.length === 2, "the request after the tool step");
    const refs = new Set(lines.filter((r) => r.type === "api-request").map((r) => r.id));
    assert.ok(lines.filter((r) => r.type === "assistant").every((r) => refs.has(r.requestRef)), "every answer names its request");
    // The session's cost grows from turn to turn; one start time.
    const costs = lines.filter((r) => r.type === "cost-state");
    assert.equal(costs.length, 3);
    assert.ok(costs[0].totalCostUSD > 0 && costs[2].totalCostUSD > costs[1].totalCostUSD && costs[1].totalCostUSD > costs[0].totalCostUSD, "the cost adds up");
    assert.ok(costs.every((r) => r.startTime === costs[0].startTime) && costs[2].totalToolDuration >= 0 && costs[2].modelUsage[String(first.params.model)], "the start time, the model's row");
    return `${lines.length} lines; resumed: ${second.params.resume ? "yes" : "no"}`;
  });

  await scenario("the service records after a refusal, a cut answer, a generic 400, 529 retried, a stop (temp/service-records-probe)", async () => {
    const drain = async (handle: any) => {
      let threw = "";
      const events: any[] = [];
      try {
        for await (const event of handle.stream) events.push(event);
      } catch (error) {
        threw = String(error);
      }
      return { threw, events };
    };
    const run = async (failure: any) => {
      claude.state.failures = [failure];
      const name = crypto.randomUUID();
      const outcome = await drain(await claude.chat({ prompt: `Q-after-${failure}`, sessionId: name }));
      const lines = claude.records(name);
      const after = lines.slice(lines.findIndex((r) => r.attachment?.type === "prompt_snapshot") + 1);
      const kinds = after.map((r) => (r.type === "system" ? `system/${r.subtype}` : r.type === "assistant" && r.isApiErrorMessage ? "synthetic" : r.type));
      return { ...outcome, lines, after, kinds };
    };
    // A refusal: the refused call, the notice, the note, the second call, the refusal record, the synthetic one;
    // no full snapshot (no call answered); the turn's end lines.
    const refused = await run("refusal");
    assert.deepEqual(refused.kinds, ["api-request-shape", "api-request-blob", "api-request", "assistant", "system/informational", "user", "api-request", "assistant", "system/model_refusal_no_fallback", "synthetic", "last-prompt", "cost-state"]);
    const [one, two] = refused.after.filter((r) => r.type === "api-request");
    assert.ok(two.base === one.id && two.keep === 1 && two.tail.length === 2, "the second call keeps the question, adds the answer and the note (no blob of the note)");
    assert.ok(refused.after.at(-1).totalCostUSD > 0, "refused calls cost");
    // Cut by max_tokens: four calls, three notes, the synthetic record.
    const cut = await run("maxTokens");
    assert.deepEqual(cut.kinds.filter((k) => k === "api-request").length, 4);
    assert.deepEqual(cut.kinds.slice(-3), ["synthetic", "last-prompt", "cost-state"]);
    assert.ok(!cut.lines.some((r) => Array.isArray(r.attachment?.tools)), "no full snapshot");
    // A generic 400: sent twice, the second without the last beta; the synthetic record "API Error: 400 …".
    const bad = await run("badRequest");
    assert.deepEqual(bad.kinds, ["api-request-shape", "api-request-blob", "api-request", "api-request", "synthetic", "last-prompt", "cost-state"]);
    const [sent, again] = bad.after.filter((r) => r.type === "api-request");
    assert.ok(sent.params.betas.includes("thinking-token-count-2026-05-13") && !again.params.betas.includes("thinking-token-count-2026-05-13"), "the second without the beta");
    assert.ok(again.base === sent.id && again.keep === 1 && again.tail.length === 0, "the same messages");
    const synthetic = bad.after.find((r) => r.isApiErrorMessage);
    assert.deepEqual([synthetic.error, synthetic.apiErrorStatus, synthetic.message.content[0].text], ["unknown", 400, "API Error: 400 stub failure"]);
    assert.ok(!bad.events.some((e) => e.subtype === "api_retry"), "no retry event");
    assert.equal(bad.events.find((e) => e.type === "result")?.api_error_status, 400);
    assert.match(bad.threw, /Claude Code returned an error result: API Error: 400 stub failure/);
    assert.deepEqual([bad.after.at(-1).totalCostUSD, bad.after.at(-1).modelUsage], [0, {}], "a failed call costs nothing");
    // 529: each attempt's request line, the retried ones before their error records.
    const overloaded = await run("overloaded");
    assert.equal(overloaded.kinds.filter((k) => k === "api-request").length, 11);
    assert.deepEqual(overloaded.kinds.slice(2, 6), ["api-request", "system/api_error", "api-request", "system/api_error"]);
    assert.deepEqual(overloaded.kinds.slice(-4), ["api-request", "synthetic", "last-prompt", "cost-state"]);
    // A stop while the answer streams: the aborted part, the interruption record, then the end lines; nothing costs.
    let release = () => {};
    claude.state.holdMidAnswer = new Promise<void>((resolve) => (release = resolve));
    const name = crypto.randomUUID();
    const handle: any = await claude.chat({ prompt: "Q-records-stop", sessionId: name });
    const events: any[] = [];
    const reading = (async () => {
      try {
        for await (const event of handle.stream) events.push(event);
      } catch {}
    })();
    for (let waited = 0; !events.some((e) => e.event?.type === "content_block_delta"); waited += 10) {
      assert.ok(waited < 2_000, "the answer started");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await handle.interrupt();
    await reading;
    release();
    const stopped = claude.records(name);
    const tail = stopped.slice(-4);
    assert.deepEqual(tail.map((r) => r.type), ["assistant", "user", "last-prompt", "cost-state"]);
    assert.ok(tail[0].isAbortedMidStream && tail[2].leafUuid === tail[1].uuid && tail[3].totalCostUSD === 0, "the aborted answer, the leaf, no cost");
  });

  await scenario("a tool step: the call runs in OpenCode, its result reaches Claude, the turn answers", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-gamma run a tool");
    claude.state.toolTurn = true;
    const turn = await opencode.turn(chat, { toolOutput: "TOOL-OUTPUT-1" });
    assert.ok(turn.ok, `turn: ${turn.requests.map((r) => r.status).join(",")}`);
    assert.equal(turn.requests.length, 2, "one request with the call, one with its result");
    const step = opencode.session(chat).messages.find((m) => m.toolCalls?.length);
    assert.ok(step, "the answer's tool step is on the screen");
    const records = claude.records(lastChat().name);
    assert.ok(records.some((r) => JSON.stringify(r.message?.content ?? "").includes("TOOL-OUTPUT-1")), "the tool's output is in Claude's transcript");
  });

  await scenario("tool calls of one message (probe temp/cli-tool-timing-probe): read-only side by side, others one after another", async () => {
    const step = (name: string) => [
      { name, input: { filePath: "a.txt" } },
      { name, input: { filePath: "b.txt" } },
    ];
    const tool = { description: "a file tool", input: { type: "object", properties: { filePath: { type: "string" } } } };
    const saved = opencode.state.tools;
    opencode.state.tools = { read: tool, edit: tool };
    try {
      const responses = async (name: string) => {
        const chat = opencode.newChat();
        await opencode.say(chat, `Q-${name} two files`);
        claude.state.toolSteps = [step(name)];
        const turn = await opencode.turn(chat);
        assert.ok(turn.ok, `${name}: ${turn.requests.map((r) => r.status).join(",")}`);
        return turn.requests.map((r) => r.reply?.toolCalls.length ?? 0);
      };
      // Two reads start together: OpenCode gets both in one response.
      assert.deepEqual(await responses("read"), [2, 0]);
      // The second edit starts only after the first one's result: two responses.
      assert.deepEqual(await responses("edit"), [1, 1, 0]);
      // Mixed (CLI 2.1.312 against a local stub of the API, a read during an edit and the reverse): a read waits for an earlier edit, an
      // edit for every earlier call.
      const mixed = async (names: string[]) => {
        const chat = opencode.newChat();
        await opencode.say(chat, `Q-mixed ${names.join(" ")}`);
        claude.state.toolSteps = [names.map((name, k) => ({ name, input: { filePath: `${k}.txt` } }))];
        const turn = await opencode.turn(chat);
        assert.ok(turn.ok, `${names}: ${turn.requests.map((r) => r.status).join(",")}`);
        return turn.requests.map((r) => r.reply?.toolCalls.length ?? 0);
      };
      assert.deepEqual(await mixed(["edit", "read"]), [1, 1, 0]);
      assert.deepEqual(await mixed(["read", "read", "edit", "read"]), [2, 1, 1, 0]);
    } finally {
      opencode.state.tools = saved;
    }
  });

  await scenario("two calls of one answer, a message sent meanwhile (temp/two-calls-probe): each result under its call, the message after both", async () => {
    const step = (name: string) => [
      { name, input: { filePath: "a.txt" } },
      { name, input: { filePath: "b.txt" } },
    ];
    const tool = { description: "a file tool", input: { type: "object", properties: { filePath: { type: "string" } } } };
    const saved = opencode.state.tools;
    opencode.state.tools = { read: tool, edit: tool };
    const seen: string[] = [];
    try {
      // read: both calls in one response, the message with both results; edit: the second call after the
      // first one's result, the message with the first result (the probe's "A msg B").
      for (const name of ["read", "edit"]) {
        const chat = opencode.newChat();
        await opencode.say(chat, `Q-two-${name} two files`);
        claude.state.toolSteps = [step(name)];
        const turn = await opencode.turn(chat, { steer: [`STEER-two-${name}`], toolOutput: (call) => `OUT-${name}-${call.input.filePath}` });
        assert.ok(turn.ok, `${name}: ${turn.requests.map((r) => r.status).join(",")}`);
        const file = claude.queries.at(-1)!.name;
        const lines = claude.records(file);
        const at = (r: Record<string, any> | undefined) => lines.indexOf(r!);
        const calls = lines.filter((r) => r.type === "assistant" && r.message?.content?.[0]?.type === "tool_use");
        const results = lines.filter((r) => r.type === "user" && r.toolUseResult);
        assert.equal(calls.length, 2, `${name}: two call records`);
        assert.equal(results.length, 2, `${name}: two result records`);
        for (const result of results) {
          const call = calls.find((c) => c.message.content[0].id === result.message.content[0].tool_use_id);
          assert.ok(call && result.parentUuid === call.uuid && result.sourceToolAssistantUUID === call.uuid, `${name}: a result's parent is its own call's record`);
        }
        const absorbed = lines.find((r) => r.type === "attachment" && r.attachment?.type === "queued_command");
        assert.ok(absorbed && String(absorbed.attachment.prompt).includes(`STEER-two-${name}`), `${name}: the message absorbed as an attachment`);
        // After the last result: the full snapshot (the file's first model call), the message, the tokens left, the answer.
        const after = lines.slice(at(results[1]) + 1).filter(isChainRecord).map((r) => (r.type === "attachment" ? r.attachment.type : r.type));
        assert.deepEqual(after, ["prompt_snapshot", "queued_command", "total_tokens_reminder", "assistant"], `${name}: what follows the last result`);
        const queue = (operation: string) => lines.findIndex((r) => r.type === "queue-operation" && r.operation === operation && String(r.content ?? "").includes(`STEER-two-${name}`));
        assert.ok(queue("enqueue") >= 0 && queue("enqueue") < at(absorbed) && queue("remove") > at(absorbed), `${name}: the queue line written as it came, removed when absorbed`);
        // Off the parent line, the first result is put back by the loader: the chain from the end holds both.
        const chain = claude.chainTo(file, claude.leafOf(file)!.uuid!);
        assert.deepEqual(chain.filter((r) => r.type === "user" && r.toolUseResult).map((r) => r.uuid), results.map((r) => r.uuid), `${name}: the chain holds both results in the order written`);
        // Down to the first-written result (a resume there), the other one is put back before it.
        const toFirst = claude.chainTo(file, results[0]!.uuid!).filter((r) => r.type === "user" && r.toolUseResult).map((r) => r.uuid);
        assert.deepEqual(toFirst, [results[1]!.uuid, results[0]!.uuid], `${name}: down to the first-written result, the other result comes first`);
        // The next turn: Claude reads both results and the message once.
        await opencode.say(chat, `Q-two-${name} next`);
        assert.ok((await opencode.turn(chat)).ok, `${name}: the next turn`);
        const view = claude.queries.at(-1)!.view;
        for (const text of [`OUT-${name}-a.txt`, `OUT-${name}-b.txt`, `STEER-two-${name}`]) assert.equal(view.split(text).length - 1, 1, `${name}: the next turn's model reads ${text} once`);
        seen.push(`${name}: ${results.map((r) => r.message.content[0].tool_use_id.slice(-1)).join(",")}`);
      }
    } finally {
      opencode.state.tools = saved;
    }
    return `results in the order the calls ended (${seen.join("; ")})`;
  });

  await scenario("two calls of one answer stopped (temp/two-calls-interrupt-probe): an ended call keeps its result, each rejected one hangs off its own call", async () => {
    const tool = { description: "a file tool", input: { type: "object", properties: { filePath: { type: "string" } } } };
    const saved = opencode.state.tools;
    opencode.state.tools = { read: tool };
    try {
      const chat = opencode.newChat();
      await opencode.say(chat, "Q-two-stopped two files");
      claude.state.toolSteps = [[{ name: "read", input: { filePath: "a.txt" } }, { name: "read", input: { filePath: "b.txt" } }]];
      const stopped = await opencode.turn(chat, { stopParked: true });
      assert.ok(stopped.stopped, "the user stopped the turn while both calls ran");
      await new Promise((resolve) => setTimeout(resolve, 200));
      const name = claude.queries.at(-1)!.name;
      const lines = claude.records(name);
      const calls = lines.filter((r) => r.type === "assistant" && r.message?.content?.[0]?.type === "tool_use");
      const rejected = lines.filter((r) => r.type === "user" && r.toolUseResult === "User rejected tool use");
      assert.equal(rejected.length, 2, "a rejected result for each call");
      for (const [k, result] of rejected.entries()) {
        assert.equal(result.message.content[0].tool_use_id, calls[k]!.message.content[0].id, "in the order of the calls");
        assert.ok(result.parentUuid === calls[k]!.uuid && result.sourceToolAssistantUUID === calls[k]!.uuid, "hung off its own call's record");
      }
      const after = lines.slice(lines.indexOf(rejected[1]!) + 1).filter(isChainRecord).map((r) => (r.type === "attachment" ? r.attachment.type : claude.recordText(r)));
      assert.deepEqual(after, ["prompt_snapshot", "[Request interrupted by user for tool use]"], "then the file's full snapshot and the interruption record");
      const chain = claude.chainTo(name, claude.leafOf(name)!.uuid!);
      assert.deepEqual(chain.filter((r) => r.toolUseResult).map((r) => r.uuid), rejected.map((r) => r.uuid), "the loader puts the first back: both on the chain");
    } finally {
      opencode.state.tools = saved;
    }
  });

  await scenario("project folders by working folder as CLI 2.1.312 keeps them (temp/folders-probe): the real path's slug, cut at 200; a resume and a copy from another folder", async () => {
    const drain = async (options: Record<string, any>) => {
      try {
        for await (const _ of (await claude.chat(options)).stream as AsyncIterable<unknown>);
      } catch {}
    };
    const projects = dirname(claude.projectDir);
    const slug = (path: string) => path.replace(/[^a-zA-Z0-9]/g, "-");
    const holder = (name: string) => readdirSync(projects).find((folder) => existsSync(join(projects, folder, `${name}.jsonl`)));
    assert.equal(basename(claude.projectDir), slug(world.tmp), "the world's working folder");
    // A slug over 200 characters from a path under Windows' MAX_PATH (260), whatever the world's root: a longer working
    // folder reaches the CLI process in its 8.3 form (process.cwd()), and the probe measured the long form.
    let longPath = join(world.tmp, "long2");
    for (const c of "abcdefghijkl") if (longPath.length + 21 <= 240) longPath = join(longPath, c.repeat(20));
    assert.ok(longPath.length > 200, `the long folder's path over 200 characters: ${longPath.length}`);
    const folders: Record<string, string> = {
      spaces: join(world.tmp, "my work dir"),
      cyrillic: join(world.tmp, "папка"),
      emoji: join(world.tmp, "dir😀x"),
      long: longPath,
    };
    for (const dir of Object.values(folders)) mkdirSync(dir, { recursive: true });
    folders.junction = join(world.tmp, "junction");
    symlinkSync(folders.spaces!, folders.junction, "junction");
    const names: Record<string, string> = {};
    for (const [key, cwd] of Object.entries(folders)) {
      names[key] = crypto.randomUUID();
      await drain({ prompt: `Q-folder ${key}`, sessionId: names[key], cwd });
    }
    assert.equal(holder(names.spaces!), slug(folders.spaces!));
    assert.equal(holder(names.cyrillic!), slug(folders.cyrillic!));
    assert.ok(holder(names.emoji!)!.endsWith("dir--x"), "an emoji: two dashes");
    assert.equal(holder(names.junction!), slug(folders.spaces!), "a junction: its target's folder");
    const long = holder(names.long!)!;
    assert.match(long, /^.{200}-[0-9a-z]+$/, `a slug over 200 characters: cut, the path's hash after: ${long}`);
    assert.equal(long.slice(0, 200), slug(folders.long!).slice(0, 200));
    // A resume from another folder appends to the session's own file; nothing new in the other folder.
    const cyrillicFiles = readdirSync(join(projects, slug(folders.cyrillic!)));
    await drain({ prompt: "Q-folder from elsewhere", resume: names.spaces, cwd: folders.cyrillic });
    assert.deepEqual(readdirSync(join(projects, slug(folders.cyrillic!))), cyrillicFiles);
    const resumed = claude.records(names.spaces!);
    assert.ok(resumed.some((r) => r.type === "user" && claude.recordText(r).includes("Q-folder from elsewhere")), "the question in the session's own file");
    assert.equal(resumed.filter((r) => r.attachment?.type === "environment").at(-1)!.attachment.changes?.[0]?.field, "workingDirectory", "the folder's change noted");
    // A copy from another folder goes to that folder.
    const copy = crypto.randomUUID();
    await drain({ prompt: "Q-folder a copy", resume: names.spaces, forkSession: true, sessionId: copy, cwd: folders.cyrillic });
    assert.equal(holder(copy), slug(folders.cyrillic!), "the copy in the working folder's project folder");
    return `the long one: ${long.slice(-12)}`;
  });

  await scenario("an answer the CLI takes back (temp/leaf-loss-probe malformed): streamed, never written, the next record hangs off it, the chain read across the gap", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-tomb do the thing");
    claude.state.malformedToolUse = true;
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok);
    assert.ok(turn.requests.at(-1)!.reply!.text.startsWith(MALFORMED_TOOL_USE_TEXT), "the reader got the taken-back answer's text");
    const name = lastChat().name;
    const records = claude.records(name);
    assert.ok(!records.some((r) => r.type === "assistant" && JSON.stringify(r.message?.content).includes(MALFORMED_TOOL_USE_TEXT)), "the file never holds it");
    const uuids = new Set(records.map((r) => r.uuid).filter(Boolean));
    const orphans = records.filter((r) => r.parentUuid && !uuids.has(r.parentUuid));
    assert.deepEqual(orphans.map((r) => r.attachment?.type ?? r.type), ["prompt_snapshot"], "the full snapshot after it keeps its uuid as the parent");
    const note = records.find((r) => r.type === "user" && r.isMeta && contentText(r.message?.content).startsWith("The previous response failed to produce a valid tool call"));
    assert.equal(note?.parentUuid, orphans[0]!.uuid, "the note after the snapshot");
    const chain = claude.chainTo(name, claude.leafOf(name)!.uuid!);
    assert.ok(chain.some((r) => r.type === "user" && contentText(r.message?.content) === "Q-tomb do the thing"), "the CLI's loader reads the question before the gap");
  });

  await scenario("a process killed right after a tool's result (temp/killed-after-result-probe): on disk (killedAfterResult), not yet flushed (killedBeforeFlush)", async () => {
    // The tools a query offers, as the plugin's in-process server would: the simulator calls `bash` through the SDK.
    const server = sdk.createSdkMcpServer({ name: "opencode", version: "1.0.0", tools: [sdk.tool("bash", "Run a command.", { command: z.string() }, async () => ({ content: [{ type: "text" as const, text: "OUT-killed" }] }))] });
    const run = async (failure: "killedAfterResult" | "killedBeforeFlush", resumed: boolean) => {
      const name = crypto.randomUUID();
      const drain = async (options: Record<string, any>) => {
        const events: any[] = [];
        let threw = "";
        try {
          for await (const e of (await claude.chat({ mcpServers: { opencode: server }, allowedTools: ["mcp__opencode__bash"], ...options })).stream as AsyncIterable<any>) events.push(e);
        } catch (error) {
          threw = String(error);
        }
        return { events, threw };
      };
      if (resumed) await drain({ prompt: "Q-killed first", sessionId: name });
      const before = existsSync(claude.fileOf(name)) ? readFileSync(claude.fileOf(name), "utf8") : undefined;
      claude.state.toolTurn = true;
      claude.state.failures = [failure];
      const killed = await drain({ prompt: "Q-killed run", ...(resumed ? { resume: name } : { sessionId: name }) });
      claude.state.failures = [];
      // The process kills itself; on Windows that is no signal to its parent, and the SDK reads exit code 1.
      const signal = process.platform === "win32" ? /terminated by signal SIGKILL|exited with code 1$/ : /terminated by signal SIGKILL/;
      assert.match(killed.threw, signal, `${failure}: the SDK throws the process's end: ${killed.threw}`);
      assert.ok(killed.events.some((e) => e.type === "user" && JSON.stringify(e.message?.content).includes("OUT-killed")), `${failure}: the reader saw the result`);
      assert.equal(claude.queries.at(-1)!.outcome, "killed");
      const after = existsSync(claude.fileOf(name)) ? readFileSync(claude.fileOf(name), "utf8") : undefined;
      return { before, after, lines: claude.records(name) };
    };
    for (const resumed of [false, true]) {
      const flushed = await run("killedBeforeFlush", resumed);
      assert.equal(flushed.after, flushed.before, `killedBeforeFlush${resumed ? " (resumed)" : ""}: the file as the process found it${resumed ? "" : " - none"}`);
      const written = await run("killedAfterResult", resumed);
      assert.ok(written.after!.startsWith(written.before ?? ""), "appended");
      const lines = written.lines;
      const result = lines.findLastIndex((r) => r.type === "user" && r.toolUseResult);
      const tail = lines.slice(result + 1).map((r) => (r.type === "attachment" ? r.attachment.type : r.type));
      const expected = [...(resumed ? [] : ["prompt_snapshot"]), "total_tokens_reminder", "api-request-blob", "api-request"];
      assert.deepEqual(tail, expected, `killedAfterResult${resumed ? " (resumed)" : ""}: after the result`);
    }
  });

  await scenario("a stop where the CLI had more of the answer than its reader (unreadAtStop, temp/stop-lag-probe)", async () => {
    const run = async (holdWhere: "holdMidAnswer" | "hold", unread: number) => {
      const name = crypto.randomUUID();
      let release = () => {};
      claude.state[holdWhere] = new Promise<void>((resolve) => (release = resolve));
      claude.state.unreadAtStop = unread;
      claude.state.replies = ["Paris, the capital of France."];
      let endInput = () => {};
      const open = new Promise<void>((resolve) => (endInput = resolve));
      const prompt = (async function* () {
        yield { type: "user", message: { role: "user", content: "Q-lag" }, parent_tool_use_id: null, uuid: crypto.randomUUID() };
        await open;
      })();
      const handle: any = await claude.chat({ prompt, sessionId: name });
      const events: any[] = [];
      const reading = (async () => {
        try {
          for await (const event of handle.stream) events.push(event);
        } catch {}
      })();
      for (let waited = 0; holdWhere === "holdMidAnswer" && !events.some((e) => e.event?.type === "content_block_delta"); waited += 10) {
        assert.ok(waited < 2_000, "the answer started");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      const readBefore = events.filter((e) => e.event?.delta?.type === "text_delta").map((e) => e.event.delta.text).join("");
      await handle.interrupt();
      await reading;
      endInput();
      release();
      const read = events.filter((e) => e.event?.delta?.type === "text_delta").map((e) => e.event.delta.text).join("");
      const answer = claude.records(name).findLast((r) => r.type === "assistant")!;
      return { readBefore, read, answer, leaf: claude.records(name).filter(isChainRecord).at(-1)! };
    };
    const ahead = await run("holdMidAnswer", 1);
    assert.equal(ahead.readBefore, "Paris, the ", "the reader had the first piece");
    assert.equal(ahead.answer.message.content[0].text, "Paris, the capital of ", "the record holds what the CLI had");
    assert.ok(ahead.answer.isAbortedMidStream);
    assert.equal(ahead.read, "Paris, the capital of ", "the rest reached the reader after the stop");
    const whole = await run("holdMidAnswer", 5);
    assert.equal(whole.answer.message.content[0].text, "Paris, the capital of France.", "the CLI had the block's end: a whole record");
    assert.ok(!whole.answer.isAbortedMidStream && whole.answer.message.stop_reason === null, "not aborted, no stop reason");
    assert.equal(claude.recordText(whole.leaf), "[Request interrupted by user]");
    const none = await run("hold", 1);
    assert.equal(none.readBefore, "", "the reader had nothing");
    assert.equal(none.answer.message.content[0].text, "Paris, the ", "the CLI wrote what it had");
    assert.ok(none.answer.isAbortedMidStream);
    assert.equal(claude.recordText(none.leaf), "[Request interrupted by user]");
  });

  await scenario("a tool's image reaches Claude as a block; the file keeps it with the CLI's note", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-tool-image show it");
    claude.state.toolTurn = true;
    const image = testPng("TOOL-IMAGE");
    const turn = await opencode.turn(chat, { toolOutput: "the picture", toolFiles: [{ mime: "image/png", data: image, name: "p.png" }] });
    assert.ok(turn.ok, `turn: ${turn.requests.map((r) => r.status).join(",")}`);
    const record = claude.records(lastChat().name).find((r) => r.type === "user" && Array.isArray(r.message?.content) && r.message.content[0]?.type === "tool_result");
    const blocks = JSON.stringify(record?.message?.content ?? "");
    if (!blocks.includes('"type":"image"')) return `the plugin gave the CLI no image block: ${blocks.slice(0, 200)}`;
    assert.ok(blocks.includes("[Image: source: "), "the CLI's note of the saved file");
    assert.ok(Array.isArray(record!.toolUseResult), "toolUseResult is the blocks");
    return "image block and note in the transcript";
  });

  await scenario("an image the user attached reaches Claude", async () => {
    const chat = opencode.newChat();
    const data = testPng("IMAGE-DELTA");
    await opencode.say(chat, "Q-delta what is on it", [{ mediaType: "image/png", data, name: "shot.png" }]);
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, "turn");
    assert.ok(lastChat().view.includes(data), `Claude saw no image: ${lastChat().view}`);
  });

  await scenario("attachments as OpenCode takes them: the type from the bytes, at most 20 MiB, the prompt hook's text", async () => {
    const chat = opencode.newChat();
    // "image/png" declared, text bytes: OpenCode makes it a text attachment.
    await opencode.say(chat, "Q-omicron", [{ mediaType: "image/png", data: Buffer.from("not a picture").toString("base64"), name: "fake.png" }]);
    const taken = opencode.session(chat).messages.at(-1)!;
    assert.equal(taken.files?.[0]?.mediaType, "text/plain");
    assert.match(String(toList([taken])[0]!.content.at(-1)!.text), /Attached file: fake\.png\n\nnot a picture/);
    const tooBig = Buffer.alloc(20 * 1024 * 1024 + 1, 0x41).toString("base64");
    await assert.rejects(opencode.say(chat, "Q-pi", [{ mediaType: "text/plain", data: tooBig }]), /exceeds the 20971520 byte limit/);
    assert.ok(!opencode.session(chat).messages.some((m) => m.text === "Q-pi"), "a refused message is not in the chat");
    opencode.state.foreignPromptHook = (event) => {
      event.prompt.text = `${event.prompt.text} REWRITTEN-BY-HOOK`;
    };
    try {
      await opencode.say(chat, "Q-rho");
    } finally {
      opencode.state.foreignPromptHook = undefined;
    }
    assert.equal(opencode.session(chat).messages.at(-1)!.text, "Q-rho REWRITTEN-BY-HOOK", "the message is what the prompt hook left");
    // The client's metadata goes to the prompt hook as a copy (session/prompt.ts Input.metadata); the message keeps what the hooks left.
    const sent = { client: "tag" };
    let seen: Record<string, unknown> | undefined;
    opencode.state.foreignPromptHook = (event) => {
      seen = event.metadata;
    };
    try {
      await opencode.say(chat, "Q-sigma", undefined, { metadata: sent });
    } finally {
      opencode.state.foreignPromptHook = undefined;
    }
    assert.equal(seen?.client, "tag", "the prompt hook gets the client's metadata");
    assert.notEqual(seen, sent, "a copy, not the client's object");
    assert.equal(opencode.session(chat).messages.at(-1)!.metadata?.client, "tag", "the message keeps it");
  });

  await scenario("a revert: the undone question is gone from what Claude sees next", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-epsilon keep this");
    await opencode.turn(chat);
    const undone = await opencode.say(chat, "Q-zeta undo this");
    await opencode.turn(chat);
    opencode.undoBefore(chat, undone);
    await opencode.say(chat, "Q-eta instead");
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, "turn after the revert");
    const view = lastChat().view;
    assert.ok(!view.includes("Q-zeta"), `Claude still sees the undone question: ${view}`);
    assert.equal(times(view, "Q-epsilon"), 1);
    // main reverts through the SDK's forkSession: the real one, on the simulator's files (it adds its title record).
    const forked = world.journal().find((line) => line.includes("resuming a fork of the Claude session"));
    if (!forked) return "the revert continued without the SDK's forkSession";
    const copy = JSON.parse(forked.slice(forked.indexOf("{"))).fork as string;
    const records = claude.records(copy);
    assert.ok(records.some((r) => r.type === "custom-title"), `the copy ${copy} is not the SDK's: ${records.map((r) => r.type).join(",")}`);
    return `the revert went through the SDK's own forkSession (${records.length} lines)`;
  });

  await scenario("a fork: the child's first turn knows the parent's history up to the fork", async () => {
    const parent = opencode.newChat();
    await opencode.say(parent, "Q-theta parent question");
    await opencode.turn(parent);
    const answer = opencode.lastId(parent);
    await opencode.say(parent, "Q-iota after the fork point");
    await opencode.turn(parent);
    const child = await opencode.fork(parent, opencode.through(answer));
    await opencode.say(child, "Q-kappa in the fork");
    const turn = await opencode.turn(child);
    assert.ok(turn.ok, "the fork's turn");
    const view = lastChat().view;
    assert.equal(times(view, "Q-theta"), 1, `the parent's question: ${view}`);
    assert.ok(!view.includes("Q-iota"), "the parent's message after the fork point");
  });

  await scenario("a compaction, then a turn: the summary answers, the chat goes on", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-lambda before the summary");
    await opencode.turn(chat);
    await opencode.say(chat, "Q-mu the latest");
    await opencode.turn(chat);
    const compaction = await opencode.compact(chat);
    assert.match(compaction.reply.text, /the summary/);
    await opencode.say(chat, "Q-nu after the summary");
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, "turn after the compaction");
    assert.ok(lastChat().view.includes("Q-nu"));
  });

  await scenario("the body is what the hooks left: system, messages, generation options, tools (invented ones dropped)", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-xi hooked");
    opencode.state.foreignHook = (event) => {
      event.system = [{ type: "text", text: "SYSTEM-FROM-HOOK" }];
      event.messages = [...event.messages, { id: "m-extra", role: "user", content: [{ type: "text", text: "EXTRA-FROM-HOOK" }] }];
      event.options = { maxTokens: 777, temperature: 0.5, topK: 9, someProviderKey: true };
      event.tools = { shell: event.tools.bash!, invented: { description: "made up", input: {} } };
    };
    try {
      const turn = await opencode.turn(chat);
      const body = turn.requests[0]!.body as Record<string, any>;
      assert.equal(body.messages[0].content, "SYSTEM-FROM-HOOK");
      assert.ok(JSON.stringify(body.messages).includes("EXTRA-FROM-HOOK"), "the hook's message is in the body");
      assert.equal(body.max_completion_tokens, 777);
      assert.equal(body.temperature, 0.5);
      assert.ok(!("top_k" in body) && !("someProviderKey" in body), "OpenAI Chat has no top_k; provider keys are not body fields");
      assert.deepEqual(body.tools.map((t: any) => t.function.name), ["shell"], "the renamed tool stays, the invented one is dropped");
    } finally {
      opencode.state.foreignHook = undefined;
    }
  });

  await scenario("OpenCode's own tools by default (2.2.0 as 2.0.32): `execute` with the `opencode` namespace, the skill tool with no skill listed", async () => {
    // The catalog as OpenCode 2.0.32 lists its own namespace (its live system prompt on this machine, the namespace's
    // part): eight tools, four pinned, complete with no MCP server.
    const catalog = `# Code Mode

Use the \`execute\` tool to call the tools listed below. They cannot be called directly. They only work inside code you pass to \`execute\`.

The catalog is complete. Do not guess tool names.

## Available tools

- opencode (8 tools) // Tools for managing OpenCode itself, such as working with sessions and worktrees, searching the available models, and reading MCP resources.
  - tools.opencode.list_mcp_resources({
  /** MCP server name as configured. Omit to list every server. */
  server?: string,
}): Promise<{
  resources: Array<{
      server: string,
      name: string,
      uri: string,
      description?: string,
      mimeType?: string,
    }>,
  templates: Array<{
      server: string,
      name: string,
      uriTemplate: string,
      description?: string,
      mimeType?: string,
    }>,
}> // List documents, records, and other data exposed by MCP servers. Use this when the user refers to something that is no...
  - tools.opencode.models({
  /** Text to search for in model names and IDs. */
  query?: string,
  /** Provider ID or name to filter by. Try your own provider first. */
  provider?: string,
  /** Include older versions of each model family. By default only the newest version is listed. */
  all?: boolean,
  /** Maximum number of models to return. Defaults to 20. @integer @minimum 1 @maximum 100 */
  limit?: number,
  /** Number of models to skip, for paging through results. @integer @minimum 0 */
  offset?: number,
}): Promise<{
  /** Matching models grouped by provider. Your own provider comes first. */
  providers: Array<{
      id: string,
      name: string,
      /** Newest first. */
      models: Array<{
          /** providerID/modelID */
          id: string,
          name: string,
          /** Release date as a Unix timestamp in milliseconds, or 0 when unknown. */
          released: number,
          variants: Array<string>,
          /** Pricing in USD per million tokens. */
          cost: Array<{
              tier?: {
                type: "context",
                /** @integer */
                size: number,
              },
              input: number,
              output: number,
              cache: {
                read: number,
                write: number,
              },
            }>,
          status: "alpha" | "beta" | "deprecated" | "active",
        }>,
    }>,
  /** Number of matching models across all pages. @integer */
  total: number,
  /** Offset of the next page, or null on the last page. */
  next: number | null,
}> // Search the models available to use. Use this to turn a model name the user mentions into an exact reference before ru...
  - tools.opencode.read_mcp_resource({
  /** The server field of the discovered resource. */
  server: string,
  /** Exact resource URI from discovery, an expanded uriTemplate, or the user. */
  uri: string,
}): Promise<{
  server: string,
  uri: string,
  contents: Array<{
        type: "text",
        uri: string,
        text: string,
        mimeType?: string,
      } | {
        type: "blob",
        uri: string,
        blob: string,
        mimeType?: string,
      }>,
}> // Read one MCP resource by server and URI. Not for local files. Always return the full contents rather than slicing or ...
  - tools.opencode.session_move({
  /** Omit to move the current session. @pattern ^ses */
  sessionID?: string,
  /** Destination directory, relative to the target session's directory or absolute. Supports ~. @minLength 1 */
  directory: string,
}): Promise<{
  /** @pattern ^ses */
  sessionID: string,
  directory: string,
}> // Move a session to another directory, or omit sessionID to move the current session. The current session moves at the ...
  - tools.opencode.session_rename({
  /** Omit to rename the current session. @pattern ^ses */
  sessionID?: string,
  /** New session title. @minLength 1 */
  title: string,
}): Promise<{
  /** @pattern ^ses */
  sessionID: string,
  title: string,
}> // Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the wo...
  - tools.opencode.worktree_create({
  name: string,
}): Promise<{
  directory: string,
}> // Create a named worktree. Returns its directory.
  - tools.opencode.worktree_list(): Promise<{
  worktrees: Array<{
      directory: string,
      strategy?: string,
    }>,
}> // List a repository's worktrees.
  - tools.opencode.worktree_remove({
  /** Absolute path of the worktree to remove. @minLength 1 */
  directory: string,
  /** Discard modified and untracked files. Only set this when the user has confirmed forced removal. */
  force?: boolean,
}): Promise<{
  directory: string,
  removed: boolean,
}> // Remove a worktree. The repository location selects configuration; directory identifies the worktree to remove.`;
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-default tools");
    const turn = await opencode.turn(chat);
    const body = turn.requests[0]!.body as Record<string, any>;
    const system = String(body.messages[0]!.content);
    // The catalog opens the instructions part (after "# Your Model"), the date follows; no skills section (an empty
    // list is none).
    assert.ok(system.includes(`\n${catalog}\n\nToday's date: `), `the catalog of OpenCode's own namespace, then the date:\n${system}`);
    assert.doesNotMatch(system, /available_skills|No skills are currently available|mcp_instructions/);
    // The skill tool among the direct ones by name, `execute` last.
    assert.deepEqual(body.tools.map((t: any) => t.function.name), ["bash", "skill", "execute"], "what the request offers");

    // The switches: `execute` and the skill tool denied (an agent's permission): no `execute`, no catalog, no skill
    // tool; OpenCode 2.2.0 offers its own namespace's tools directly (tool.ts snapshot), 2.0.32 dropped them.
    const saved = { codeMode: opencode.state.codeMode, skills: opencode.state.skills, version: opencode.state.version };
    try {
      Object.assign(opencode.state, { codeMode: undefined, skills: undefined });
      const denied = opencode.newChat();
      await opencode.say(denied, "Q-default tools denied");
      const bare = (await opencode.turn(denied)).requests[0]!.body as Record<string, any>;
      const direct = ["list_mcp_resources", "models", "read_mcp_resource", "session_move", "session_rename", "worktree_create", "worktree_list", "worktree_remove"].map((name) => `opencode_${name}`);
      assert.deepEqual(bare.tools.map((t: any) => t.function.name), ["bash", ...direct], "2.2.0: OpenCode's own tools offered directly");
      assert.doesNotMatch(String(bare.messages[0]!.content), /# Code Mode/);
      opencode.state.version = "2.0.32";
      const old = opencode.newChat();
      await opencode.say(old, "Q-default tools denied on 2.0.32");
      const bare2 = (await opencode.turn(old)).requests[0]!.body as Record<string, any>;
      assert.deepEqual(bare2.tools.map((t: any) => t.function.name), ["bash"], "2.0.32: none of them");
    } finally {
      Object.assign(opencode.state, saved);
    }
    assert.deepEqual(errorsInJournal(), [], "no error in the plugin's journal");
  });

  await scenario("the system prompt as OpenCode 2.0.32 builds it: the agent's prompt, OpenCode's own plugins, the instruction sections in order; kept per session", async () => {
    const saved = { tools: opencode.state.tools, agent: opencode.state.agent, codeMode: opencode.state.codeMode, skills: opencode.state.skills };
    const parts = (system: string) => system.split("\n");
    try {
      // The stock prompt with the guidance of the tools offered, the Anthropic part for a "claude" model, "# Your
      // Model", the instructions (date and environment at least), the worktree note last; the parts joined by "\n".
      opencode.state.tools = { shell: { description: "Run", input: {} }, edit: { description: "Edit", input: {} }, write: { description: "Write", input: {} } };
      const chat = opencode.newChat();
      await opencode.say(chat, "Q-system stock");
      const turn = await opencode.turn(chat);
      const system = String(turn.requests[0]!.body.messages[0]!.content);
      const { ref, info } = { ref: { id: String(turn.requests[0]!.body.model) }, info: opencode.instances[0]!.provider.models.find((m: any) => m.id === turn.requests[0]!.body.model) };
      assert.ok(system.startsWith("You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.\n\n# Harness\n"));
      assert.ok(system.includes("- Prefer parallelizing independent tool calls.\n- Prefer dedicated tools over shell commands;"), "the shell's guidance");
      assert.ok(system.includes("- Use the write tool to create files") && system.includes("- Use the edit tool for targeted changes"), "the write and edit guidance");
      assert.ok(system.includes("investigate before deleting or overwriting them.\n\n\n# Code comments\nBy default, match the surrounding comment density"), "the Anthropic part after the stock prompt");
      assert.ok(system.includes(`precedence over this guidance.\n\n# Your Model\n- Name: ${info?.name}\n- Provider ID: claude-code\n- Model ID: ${ref.id}\n`), `the model second: ${system.slice(1500, 2200)}`);
      const date = system.indexOf(`\nToday's date: ${new Date().toDateString()}\n\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: ${world.tmp}\n`);
      assert.ok(date > 0, "the date, then the environment");
      assert.match(system, /  Is directory a git repo: no\n  Platform: \w+\n  Prefer .+ over generic system temporary directories such as \/tmp; it is pre-created and approved for external access\.\n<\/env>\nWhen you create a worktree outside the current working directory/);
      assert.equal(parts(system).at(-1), "When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.");
      assert.ok(system.includes(`- Model ID: ${ref.id}\n# Code Mode\n\n`) && system.includes("\n- opencode (8 tools) // "), "OpenCode's own Code Mode namespace");
      assert.doesNotMatch(system, /mcp_instructions|available_skills|No skills are currently available|Instructions from:/, "no section with nothing to say");

      // Every section, in OpenCode's order (session/context.ts select): Code Mode, MCP, skills, instruction files,
      // date, environment, a host's context; `execute` last among the tools, the skill tool with the direct ones.
      opencode.state.codeMode = { namespaces: [{ name: "demo", description: "Example tools" }], tools: [{ namespace: "demo", name: "read", description: "Read a file", input: { type: "object", properties: { path: { type: "string", description: "Where" } }, required: ["path"] } }] };
      opencode.state.mcpServers = [{ server: "linear", instructions: "Use tools.", tools: [{ name: "list_issues", description: "List issues" }] }];
      opencode.state.skills = [{ id: "demo", name: "demo", description: "Demo skill" }];
      const rules = join(world.tmp, "sections-rules.md");
      writeFileSync(rules, "Rules.\n");
      opencode.state.instructions = [rules];
      opencode.state.contextEntries = { "host.note": "A note.", "host.data": { a: 1 } };
      const all = opencode.newChat();
      await opencode.say(all, "Q-system all");
      const full = await opencode.turn(all);
      const text = String(full.requests[0]!.body.messages[0]!.content);
      const catalog = [
        "# Code Mode",
        "",
        "Use the `execute` tool to call the tools listed below. They cannot be called directly. They only work inside code you pass to `execute`.",
        "",
        "The catalog is complete. Do not guess tool names.",
        "",
        "## Available tools",
        "",
        "- demo (1 tool) // Example tools",
        "  - tools.demo.read({",
        "  /** Where */",
        "  path: string,",
        "}): Promise<unknown> // Read a file",
        "- linear (1 tool)",
        "  - tools.linear.list_issues(): Promise<unknown> // List issues",
      ].join("\n");
      const mcp = '<mcp_instructions>\n  <server name="linear">\n    Use tools from this server through `execute` under `tools["linear"]`.\n    Use tools.\n  </server>\n</mcp_instructions>';
      const skills = "Skills provide specialized instructions and workflows for specific tasks.\nUse the skill tool to load a skill when a task matches its description.\nThe user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.\n<available_skills>\n  <skill>\n    <id>demo</id>\n    <name>demo</name>\n    <description>Demo skill</description>\n  </skill>\n</available_skills>";
      const files = `Instructions from: ${realpathSync(rules)}\nRules.\n`;
      const context = '<context key="host.data">\n{\n  "a": 1\n}\n</context>\n\n<context key="host.note">\nA note.\n</context>';
      const order = [catalog, mcp, skills, files, "Today's date: ", "<env>", context].map((part) => text.indexOf(part));
      assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)), `every section, in order: ${order.join(", ")}\n${text}`);
      assert.ok(text.includes(`${catalog}\n\n${mcp}\n\n${skills}\n\n${files}\n\nToday's date: `), "joined by a blank line");
      assert.ok(text.includes(`</env>\n\n${context}\nWhen you create a worktree`), "the context entries sorted by key, the note after them");
      assert.deepEqual(Object.keys(opencode.offeredTools()), ["edit", "shell", "skill", "write", "execute"]);
      assert.deepEqual(full.requests[0]!.body.tools.map((t: any) => t.function.name), ["edit", "shell", "skill", "write", "execute"], "what the request offers");

      // Kept per session: a change of the setup after the first request does not touch the chat's prompt; a
      // compaction observes it again; a new chat sees it at once.
      opencode.state.skills = [{ id: "other", name: "other", description: "Another skill" }];
      await opencode.say(all, "Q-system again");
      const again = await opencode.turn(all);
      assert.equal(String(again.requests[0]!.body.messages[0]!.content), text, "the same prompt for the same session");
      assert.equal((await opencode.compact(all)).status, "completed");
      await opencode.say(all, "Q-system after the summary");
      const after = await opencode.turn(all);
      assert.match(String(after.requests[0]!.body.messages[0]!.content), /<id>other<\/id>/, "observed again after the compaction");

      // A partial catalog: the `search` function before the listings, as the package 2.0.32 renders its signature.
      const wide = { type: "object", properties: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`field${i}`, { type: "string", description: `The field number ${i}` }])) };
      opencode.state.codeMode = { tools: Array.from({ length: 40 }, (_, i) => ({ namespace: "many", name: `tool${i}`, description: `Tool ${i}`, input: wide })) };
      opencode.state.mcpServers = [];
      const partial = opencode.newChat();
      await opencode.say(partial, "Q-system partial");
      const cut = String((await opencode.turn(partial)).requests[0]!.body.messages[0]!.content);
      assert.match(cut, /They cannot be called directly, and neither can `search`\. Both only work inside code you pass to `execute`\.\n\nThe catalog is partial\. Inside `execute`, use `search\(\.\.\.\)` to find a tool[^\n]*\n\n- search\(\{\n  query\?: string,\n  namespace\?: string,\n  \/\*\* @integer @exclusiveMinimum 0 \*\/\n  limit\?: number,/);
      assert.match(cut, /\n- many \(40 tools, \d+ shown\)\n/);

      // A custom agent: its prompt in place of the stock one, no Anthropic part, "# Your Model" second.
      opencode.state.agent = { name: "writer", system: "PERSONA-system line one.\n\nPERSONA line two." };
      const custom = opencode.newChat();
      await opencode.say(custom, "Q-system persona");
      const persona = String((await opencode.turn(custom)).requests[0]!.body.messages[0]!.content);
      assert.ok(persona.startsWith("PERSONA-system line one.\n\nPERSONA line two.\n# Your Model\n"), persona.slice(0, 120));
      assert.doesNotMatch(persona, /# Code comments|a coding agent harness/);
      // A title has its own agent's prompt alone (no "# Your Model").
      const titled = await opencode.title(custom);
      assert.equal(titled.requests[0]!.list.length, 1);
      assert.doesNotMatch(String(titled.requests[0]!.body.messages[0]!.content), /# Your Model/);
    } finally {
      Object.assign(opencode.state, saved, { mcpServers: [], instructions: [], contextEntries: {} });
    }
    assert.deepEqual(errorsInJournal(), [], "no error in the plugin's journal");
  });

  await scenario("the instruction files OpenCode 2.0.32 loads: its global AGENTS.md, the project's from the folder up to the project's, the configured files", async () => {
    const project = join(world.tmp, "loading", "repo");
    const nested = join(project, "pkg", "sub");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, "AGENTS.md"), "Repo rules.\n");
    writeFileSync(join(project, "pkg", "AGENTS.md"), "Package rules.\n");
    writeFileSync(join(world.tmp, "loading", "AGENTS.md"), "Above the repository: not read.\n");
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs", "b.md"), "B.\n");
    writeFileSync(join(project, "docs", "a.md"), "A.\n");
    const configDir = openCodeConfigDir();
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "AGENTS.md"), "Global rules.\n");
    try {
      const loaded = instructionFiles(nested, ["docs/*.md", join(project, "AGENTS.md")]);
      const real = (path: string) => realpathSync(path);
      assert.deepEqual(loaded.map((file) => file.path), [
        real(join(configDir, "AGENTS.md")),
        real(join(project, "pkg", "AGENTS.md")),
        real(join(project, "AGENTS.md")),
        real(join(project, "docs", "a.md")),
        real(join(project, "docs", "b.md")),
      ], "global, then nearest first up to the repository, then the configured ones sorted; a file once, where it first came");
      assert.equal(loaded[0]!.content, "Global rules.\n", "read as it is");
      // In a chat: the blocks in the system prompt, a blank line between them.
      opencode.state.instructions = ["docs/*.md"];
      const chat = opencode.newChat(undefined, nested);
      await opencode.say(chat, "Q-instructions");
      const system = String((await opencode.turn(chat)).requests[0]!.body.messages[0]!.content);
      assert.ok(system.includes(`Instructions from: ${real(join(configDir, "AGENTS.md"))}\nGlobal rules.\n\n\nInstructions from: ${real(join(project, "pkg", "AGENTS.md"))}\nPackage rules.\n`), system);
      assert.match(system, /  Workspace root folder: .*repo\n  Is directory a git repo: yes\n/);
      assert.doesNotMatch(system, /Above the repository/);
    } finally {
      rmSync(join(configDir, "AGENTS.md"));
      opencode.state.instructions = [];
    }
    assert.deepEqual(errorsInJournal(), [], "no error in the plugin's journal");
  });

  await scenario("a page in the browser calls the proxy as the Fetch standard has it: Origin, Host after DNS rebinding, a preflight", async () => {
    const port = world.plugin.proxy.getProxyPort();
    const evil = "https://evil.example";
    const get = await world.fromBrowser({ page: evil, path: "/v1/models" });
    assert.ok(get.wrote[0]!.startsWith(`GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${evil}\r\n`), get.wrote[0]);
    const img = await world.fromBrowser({ page: evil, path: "/v1/models", mode: "no-cors" });
    assert.doesNotMatch(img.wrote[0]!, /Origin:/, "a no-cors GET (an image) has no Origin");
    const form = await world.fromBrowser({ page: evil, path: "/v1/chat/completions", method: "POST", contentType: "text/plain", body: "{}", mode: "no-cors" });
    assert.equal(form.wrote.length, 1, "a form's POST needs no preflight");
    assert.match(form.wrote[0]!, /^POST \/v1\/chat\/completions HTTP\/1\.1\r\nHost: [^\r]+\r\nOrigin: https:\/\/evil\.example\r\nContent-Type: text\/plain\r\n/);
    const json = await world.fromBrowser({ page: evil, path: "/v1/chat/completions", method: "POST", contentType: "application/json", body: "{}" });
    assert.match(json.wrote[0]!, /^OPTIONS \/v1\/chat\/completions HTTP\/1\.1\r\nHost: [^\r]+\r\nOrigin: https:\/\/evil\.example\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type\r\n/);
    assert.equal(json.sent, json.wrote.length === 2, "the request itself only after an allowing preflight");
    assert.deepEqual(await world.fromBrowser({ page: evil, path: "/v1/chat/completions", method: "PUT", mode: "no-cors" }), { sent: false, wrote: [] }, "a no-cors PUT is never sent");
    const rebound = await world.fromBrowser({ page: `http://rebind.evil.example:${port}`, rebound: "rebind.evil.example", path: "/v1/models" });
    assert.match(rebound.wrote[0]!, new RegExp(`^GET /v1/models HTTP/1\\.1\\r\\nHost: rebind\\.evil\\.example:${port}\\r\\nConnection: close`), "same-origin GET: no Origin");
    return `statuses ${[get, img, form, rebound].map((r) => ("status" in r ? r.status : "-")).join(" ")}`;
  });

  /** A turn the user stops once the answer has started to stream. */
  const stopMidAnswer = async (chat: string) => {
    let release!: () => void;
    claude.state.holdMidAnswer = new Promise<void>((resolve) => (release = resolve));
    claude.state.replies = ["PARTIAL-START and the rest of a long answer that never arrives"];
    const stop = new AbortController();
    const running = opencode.turn(chat, { stop: stop.signal });
    // The user stops once the screen shows the answer's start (no wait by time).
    for (let i = 0; i < 1000 && !opencode.shown(chat).startsWith("PARTIAL-START"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(opencode.shown(chat).startsWith("PARTIAL-START"), `the answer's start never reached the screen: ${JSON.stringify(opencode.shown(chat))}`);
    stop.abort();
    const turn = await running;
    release();
    claude.state.replies = [];
    return turn;
  };

  await scenario("text, stop, next turn: what was shown stays with the error and goes in the next request", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-stop first");
    const stopped = await stopMidAnswer(chat);
    assert.ok(stopped.stopped, "the turn was stopped");
    const shown = opencode.session(chat).messages.find((m) => m.type === "assistant");
    assert.ok(shown?.text.startsWith("PARTIAL-START"), `the shown start stays on the screen: ${JSON.stringify(shown)}`);
    assert.equal(shown!.error, "interrupted");
    await opencode.say(chat, "Q-after the stop");
    const next = await opencode.turn(chat);
    assert.ok(next.ok, "the next turn");
    assert.ok(JSON.stringify(next.requests[0]!.list).includes("PARTIAL-START"), "the next request's list carries the shown start");
    return `Claude then saw the shown start ${lastChat().view.includes("PARTIAL-START") ? "" : "not "}(continued: ${lastChat().at !== null})`;
  });

  await scenario("text, stop, fork: the fork copies the shown start and its first turn answers", async () => {
    const parent = opencode.newChat();
    await opencode.say(parent, "Q-stop parent");
    await stopMidAnswer(parent);
    const child = await opencode.fork(parent, opencode.through(opencode.lastId(parent)));
    assert.ok(opencode.session(child).messages.some((m) => m.text.startsWith("PARTIAL-START")), "the fork has the shown start");
    await opencode.say(child, "Q-in the fork after the stop");
    const turn = await opencode.turn(child);
    assert.ok(turn.ok, "the fork's first turn");
  });

  /**
   * Runs `body` with OpenCode's timeouts and clock set for it, then puts them back. The timeouts are a few hundred
   * ms, so Claude Code confirms records without a turn at once meanwhile (`confirmMs`): a tree that starts a new
   * transcript with a record would otherwise spend the CLI's start on it (≈350 ms live) against the header timeout.
   */
  const withTiming = async <T>(timing: { headerTimeoutMs?: number; chunkTimeoutMs?: number; sleep?: (ms: number) => Promise<void> }, body: () => Promise<T>) => {
    const saved = { headerTimeoutMs: opencode.state.headerTimeoutMs, chunkTimeoutMs: opencode.state.chunkTimeoutMs, sleep: opencode.state.sleep };
    Object.assign(opencode.state, timing);
    claude.state.confirmMs = { starting: 0, running: 0 };
    try {
      return await body();
    } finally {
      Object.assign(opencode.state, saved);
      claude.state.confirmMs = undefined;
    }
  };

  await scenario("no headers in time (headerTimeoutMs): a retryable timeout, sent again; a step's 4th timeout fails the turn", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-headers late");
    // The plugin sends its headers with the answer's first event: Claude holding the answer holds them. The wait
    // before a retry lets the held query go (its answer then reaches a closed request) and holds the next one.
    const releases: Array<() => void> = [];
    const holdNext = () => void (claude.state.hold = new Promise<void>((resolve) => releases.push(resolve)));
    const releaseAll = () => releases.splice(0).forEach((release) => release());
    const holdThen = (held: number) => {
      let waits = 0;
      return async () => {
        releaseAll();
        if (++waits < held) holdNext();
      };
    };
    const before = opencode.retries.length;
    // Two timeouts, then the headers come in time.
    holdNext();
    // Long enough for a start of the CLI process through the real SDK (about 100 ms), short enough to wait out.
    const retried = await withTiming({ headerTimeoutMs: 1_500, sleep: holdThen(2) }, () => opencode.turn(chat)).finally(releaseAll);
    claude.state.hold = undefined;
    assert.ok(retried.ok, `answered after the timeouts: ${JSON.stringify(retried.failure)}`);
    assert.deepEqual(retried.requests.map((r) => r.status), [0, 0, 200]);
    assert.deepEqual(opencode.retries.slice(before).map((r) => [r.attempt, r.kind]), [[1, "transport"], [2, "transport"]]);
    // Every request times out: three retries, the fourth timeout is not retried.
    await opencode.say(chat, "Q-headers never");
    const from = opencode.retries.length;
    holdNext();
    const failed = await withTiming({ headerTimeoutMs: 1_500, sleep: holdThen(Infinity) }, () => opencode.turn(chat)).finally(releaseAll);
    claude.state.hold = undefined;
    assert.equal(failed.ok, false);
    assert.equal(failed.requests.length, 4, "the first request and three retries");
    assert.equal(opencode.retries.length - from, 3);
    assert.deepEqual(failed.failure, { kind: "transport", message: "Timed out waiting for response headers", retryable: true, code: "Timeout" });
    assert.ok(!opencode.session(chat).messages.some((m) => m.type === "assistant" && m.pending), "no answer left pending");
  });

  await scenario("a chunk timeout mid-answer (chunkTimeoutMs): the shown part stays, OpenCode asks to continue and the turn answers", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-chunk late");
    let release!: () => void;
    claude.state.holdMidAnswer = new Promise<void>((resolve) => (release = resolve));
    claude.state.replies = ["PARTIAL-CHUNK and the rest of an answer that never arrives"];
    const before = opencode.retries.length;
    // The stream stalls after its first piece; the wait before the request again restores the default.
    const turn = await withTiming({ chunkTimeoutMs: 300, sleep: async () => void (opencode.state.chunkTimeoutMs = 900_000) }, () => opencode.turn(chat)).finally(() => {
      release();
      claude.state.replies = [];
    });
    assert.equal(turn.requests.length, 2, `the request, then the continuation: ${turn.requests.map((r) => r.status).join(",")}`);
    assert.deepEqual(failureOf(turn.requests[0]!.reply!), { kind: "transport", message: "Timed out waiting for response data", retryable: true, code: "Timeout" });
    assert.deepEqual(opencode.retries.slice(before).map((r) => r.kind), ["transport"]);
    const messages = opencode.session(chat).messages;
    const at = messages.findIndex((m) => m.type === "assistant" && m.text.startsWith("PARTIAL-CHUNK"));
    assert.ok(at >= 0, "the shown part stays as an answer");
    assert.equal(messages[at]!.error, "Timed out waiting for response data");
    assert.deepEqual([messages[at + 1]!.type, messages[at + 1]!.text], ["synthetic", CONTINUE_AFTER_INTERRUPTION]);
    const list = turn.requests[1]!.list;
    const partial = list.findIndex((m) => m.role === "assistant" && JSON.stringify(m.content).includes("PARTIAL-CHUNK"));
    assert.ok(partial >= 0, `the continuation's list has the partial answer: ${JSON.stringify(list).slice(0, 400)}`);
    assert.deepEqual(list[partial + 1], { id: messages[at + 1]!.id, role: "user", content: [{ type: "text", text: CONTINUE_AFTER_INTERRUPTION }] }, "then the synthetic message as a plain user message");
    const body = JSON.stringify(turn.requests[1]!.body.messages);
    assert.ok(body.includes("PARTIAL-CHUNK") && body.includes(CONTINUE_AFTER_INTERRUPTION), "both in the body");
    assert.ok(turn.ok, `the continuation answers: ${JSON.stringify(turn.failure)}`);
    return `Claude then saw the partial answer ${lastChat().view.includes("PARTIAL-CHUNK") ? "" : "not "}and the request to continue ${lastChat().view.includes("The previous response was interrupted") ? "" : "not "}`;
  });

  await scenario("where a chat ends: the simulator's rule is the SDK's (a fork without a point copies down to the end)", async () => {
    const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
    // Files of every shape the simulator writes: turns, a tool step, a stopped answer, the SDK's own copy of one.
    const names = [...new Set(chatQueries().map((q) => q.name))].filter((name) => claude.records(name).some(isChainRecord));
    assert.ok(names.length >= 5, `chats to compare: ${names.length}`);
    const compare = async (name: string) => {
      const { sessionId } = await forkSession(name);
      const copied = claude.records(sessionId).filter(isChainRecord).at(-1);
      assert.equal(copied?.forkedFrom?.messageUuid, claude.leafOf(name)?.uuid, `${name}: the SDK ends the chat at another record`);
      return sessionId;
    };
    let copy = "";
    for (const name of names) copy = await compare(name);
    // A copy the SDK just made ends with its own service lines (custom-title): the chat still ends at a message.
    await compare(copy);
    return `${names.length + 1} chats`;
  });

  const summaries = () => claude.queries.filter((q) => q.kind === "summary");
  const lastBody = (requests: Array<{ body?: { messages: Array<Record<string, any>> } }>) => JSON.stringify(requests.at(-1)?.body?.messages ?? []);

  await scenario("compaction: OpenCode's prompt, the tail by the keep budget, an update prompt the second time", async () => {
    const chat = opencode.newChat();
    // About 25 000 tokens of turns: the newest ~15 000 stay verbatim as the tail.
    for (let i = 0; i < 6; i++) {
      await opencode.say(chat, `Q-long ${i} ${"x".repeat(16_000)}`);
      await opencode.turn(chat);
    }
    const first = await opencode.compact(chat);
    assert.equal(first.status, "completed", JSON.stringify(first.error ?? ""));
    assert.ok(lastBody(first.requests).includes("You MUST summarize the conversation above"), "the first summary's prompt");
    const checkpoint = opencode.session(chat).messages.at(-1)!;
    assert.equal(checkpoint.type, "compaction");
    const kept = (checkpoint.recent?.match(/Q-long \d/g) ?? []).length;
    assert.ok(kept >= 2 && kept < 6, `the tail keeps the newest exchanges within 15 000 tokens: ${kept}`);
    await opencode.say(chat, "Q-after the first summary");
    await opencode.turn(chat);
    const second = await opencode.compact(chat);
    assert.equal(second.status, "completed");
    assert.ok(lastBody(second.requests).includes("Update the existing checkpoint"), "the second summary updates the checkpoint");
    return `tail: ${kept} of 6 exchanges`;
  });

  await scenario("compaction: a reply without the template gets one reminder; two such replies fail with the event", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-sigma one");
    await opencode.turn(chat);
    await opencode.say(chat, "Q-sigma two");
    await opencode.turn(chat);
    claude.state.summaryReplies = ["no headings here", "## Objective\n- after the reminder"];
    const nudged = await opencode.compact(chat);
    assert.equal(nudged.status, "completed");
    assert.equal(nudged.requests.length, 2, "the summary, then the reminder");
    assert.ok(lastBody(nudged.requests).includes(SUMMARY_NUDGE), "the second request carries the reminder");
    const before = opencode.session(chat).messages.length;
    claude.state.summaryReplies = ["still no headings", "nor here"];
    await opencode.say(chat, "Q-sigma three");
    await opencode.turn(chat);
    const failed = await opencode.compact(chat);
    assert.equal(failed.status, "failed");
    assert.match(String(failed.error?.message), /did not match the required template/);
    assert.ok(!opencode.session(chat).messages.slice(before).some((m) => m.type === "compaction"), "no checkpoint after a failed summary");
    assert.ok(world.journal().length > 0);
  });

  await scenario("compaction: a hook that gives the summary itself sends no request", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-tau one");
    await opencode.turn(chat);
    await opencode.say(chat, "Q-tau two");
    await opencode.turn(chat);
    const asked = summaries().length;
    opencode.state.foreignHook = (event) => {
      (event as { result?: unknown }).result = { summary: "## Objective\n- from the hook" };
    };
    try {
      const done = await opencode.compact(chat);
      assert.equal(done.status, "completed");
      assert.equal(done.requests.length, 0);
    } finally {
      opencode.state.foreignHook = undefined;
    }
    assert.equal(summaries().length, asked, "Claude was not asked");
    assert.equal(opencode.session(chat).messages.at(-1)!.summary, "## Objective\n- from the hook");
  });

  await scenario("auto compaction: a turn whose measured context reached the ceiling compacts first", async () => {
    const chat = opencode.newChat();
    await opencode.say(chat, "Q-upsilon one");
    // The model's window from the plugin's catalog; the ceiling is 15% below it (2.0.32: 10%).
    const window = (opencode.instances[0]!.provider.models as any[]).find((m) => m.id === opencode.state.modelID || /sonnet/.test(m.id))!.limit.context as number;
    claude.state.usage = { input_tokens: Math.ceil(window * 0.95) };
    await opencode.turn(chat);
    claude.state.usage = {};
    const answer = opencode.session(chat).messages.at(-1)!;
    assert.ok((answer.tokens?.input ?? 0) + (answer.tokens?.cacheRead ?? 0) >= window * 0.95, `the answer's tokens: ${JSON.stringify(answer.tokens)}`);
    await opencode.say(chat, "Q-upsilon two");
    const asked = summaries().length;
    const next = await opencode.turn(chat);
    assert.ok(next.ok, "the turn after the compaction");
    assert.equal(next.compactions?.[0]?.status, "completed", "compacted before the request");
    assert.equal(summaries().length, asked + 1, "one summary");
    assert.ok(opencode.session(chat).messages.some((m) => m.type === "compaction"));
  });

  await scenario("OpenCode 2.2.0 and the 2.0.32 switch: the body, the title's prompt, the summary of the whole conversation, the checkpoint's keepID", async () => {
    const chat = opencode.newChat();
    for (let i = 0; i < 6; i++) {
      await opencode.say(chat, `Q-v22 ${i} ${"x".repeat(16_000)}`);
      await opencode.turn(chat);
    }
    const body = (await opencode.turn(chat)).requests[0]!.body as Record<string, unknown>;
    assert.ok(!("store" in body), "2.2.0: no store in the body");
    const titled = (await opencode.title(chat)).requests[0];
    assert.match(String(titled?.list[0]?.content[0]?.text), /^Here is the first message of the conversation:\n\n<message>\nQ-v22 0 /, "2.2.0: the title's prompt");
    const compacted = await opencode.compact(chat);
    assert.equal(compacted.status, "completed", JSON.stringify(compacted.error ?? ""));
    const asked = compacted.requests[0]!.list.map((m) => JSON.stringify(m.content)).join("\n");
    assert.match(asked, /Q-v22 5/, "2.2.0: the summary's hook gets the whole conversation, the tail too");
    const s = opencode.session(chat);
    const checkpoint = s.messages.at(-1)!;
    const keepID = checkpoint.metadata?.keepID as string | undefined;
    assert.ok(keepID && s.messages.some((m) => m.id === keepID && m.type === "user"), `the checkpoint keeps the first kept message's id: ${keepID}`);
    assert.match(String(checkpoint.recent), /Q-v22 5/, "the tail read from it");
    const read = (await opencode.context({ sessionID: chat }))[0] as Record<string, any>;
    assert.ok(!("recent" in read) && read.metadata?.keepID === keepID && /Q-v22 5/.test(read.metadata?.recent), "session.context: metadata.keepID and metadata.recent");
    const saved = opencode.state.version;
    try {
      opencode.state.version = "2.0.32";
      const old = opencode.newChat();
      for (let i = 0; i < 6; i++) {
        await opencode.say(old, `Q-v20 ${i} ${"x".repeat(16_000)}`);
        await opencode.turn(old);
      }
      const oldBody = (await opencode.turn(old)).requests[0]!.body as Record<string, unknown>;
      assert.equal(oldBody.store, false, "2.0.32: store false");
      assert.match(String((await opencode.title(old)).requests[0]?.list[0]?.content[0]?.text), /^Q-v20 0 /, "2.0.32: the first message as it is");
      const oldCompacted = await opencode.compact(old);
      assert.doesNotMatch(oldCompacted.requests[0]!.list.map((m) => JSON.stringify(m.content)).join("\n"), /Q-v20 5/, "2.0.32: the older part alone");
      const oldRead = (await opencode.context({ sessionID: old }))[0] as Record<string, any>;
      assert.match(String(oldRead.recent), /Q-v20 5/, "2.0.32: session.context's recent");
    } finally {
      opencode.state.version = saved;
    }
    assert.deepEqual(errorsInJournal(), [], "no error in the plugin's journal");
  });

  await scenario("background compaction (2.2.0): near the ceiling a summary is written while the chat goes on, then swapped in", async () => {
    const window = (opencode.instances[0]!.provider.models as any[]).find((m) => m.id === opencode.state.modelID || /sonnet/.test(m.id))!.limit.context as number;
    const saved = { buffer: opencode.state.compactionBuffer, background: opencode.state.backgroundCompaction };
    try {
      // A ceiling of 100 000 tokens; an answer measured at 90 000 is over 85% of it.
      Object.assign(opencode.state, { compactionBuffer: window - 100_000, backgroundCompaction: true });
      const chat = opencode.newChat();
      await opencode.say(chat, "Q-bg one");
      claude.state.usage = { input_tokens: 90_000 };
      await opencode.turn(chat);
      const anchor = opencode.session(chat).messages.at(-1)!;
      const held = opencode.backgroundSummaries.at(-1);
      assert.ok(held && held.chat === chat && held.keepID === anchor.id, "a summary started after the turn, up to its answer");
      const written = await held.summary;
      assert.ok("text" in written, JSON.stringify(written));
      assert.deepEqual(held.requests[0]!.list.map((m) => m.role), ["user"], "the messages before the measured answer");
      const asked = summaries().length;
      // The next answer passes the ceiling: the turn after it compacts with the summary already written.
      await opencode.say(chat, "Q-bg two");
      claude.state.usage = { input_tokens: 101_000 };
      await opencode.turn(chat);
      claude.state.usage = {};
      await opencode.say(chat, "Q-bg three");
      const next = await opencode.turn(chat);
      assert.equal(next.compactions?.[0]?.status, "completed", "compacted before the request");
      assert.equal(summaries().length, asked, "no new summary: the one written in the background");
      const checkpoint = opencode.session(chat).messages.find((m) => m.type === "compaction")!;
      assert.equal(checkpoint.metadata?.keepID, anchor.id, "kept from the measured answer");
      assert.match(String(checkpoint.recent), /Q-bg two/);
    } finally {
      claude.state.usage = {};
      Object.assign(opencode.state, { compactionBuffer: saved.buffer, backgroundCompaction: saved.background });
    }
    assert.deepEqual(errorsInJournal(), [], "no error in the plugin's journal");
  });

  await scenario("cache warming: with `warming`, an idle chat is pinged with OpenCode's keep-alive prompt as a generation", async () => {
    try {
      opencode.state.warming = { interval: 50, duration: 3_000 };
      const chat = opencode.newChat();
      await opencode.say(chat, "Q-warm");
      await opencode.turn(chat);
      const deadline = Date.now() + 5_000;
      while (!opencode.warming.pings.some((p) => p.chat === chat) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      const ping = opencode.warming.pings.find((p) => p.chat === chat);
      assert.ok(ping, "a ping after the chat was idle");
      const direct = await opencode.generate(chat, "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK");
      return `ping answered ${JSON.stringify(ping.text.slice(0, 40))}${ping.failure ? ` (${ping.failure.kind})` : ""}; the same as a generation: ${JSON.stringify(direct.text.slice(0, 40))}`;
    } finally {
      opencode.state.warming = undefined;
      opencode.stopBackground();
    }
  });

  // What OpenCode does with the plugin's answer to a failed Claude call. The
  // plugin's answer differs between trees; each scenario checks OpenCode's side
  // for the kind the answer had, and reports that kind.
  const twoTurns = async (label: string) => {
    const chat = opencode.newChat();
    await opencode.say(chat, `${label} one`);
    await opencode.turn(chat);
    await opencode.say(chat, `${label} two`);
    return chat;
  };

  await scenario("prompt too long: OpenCode compacts and sends the step again, once", async () => {
    const chat = await twoTurns("Q-phi");
    claude.state.failures = ["promptTooLong"];
    const turn = await opencode.turn(chat);
    claude.state.failures = [];
    const first = failureOf(turn.requests[0]!.reply!);
    if (first?.kind !== "context-overflow") return `the plugin's answer: ${first?.kind ?? "no failure"} (${turn.requests[0]!.status})`;
    assert.equal(turn.compactions?.[0]?.status, "completed", "compacted after the overflow");
    assert.ok(turn.ok, "the step sent again after the compaction answers");
    assert.ok(opencode.session(chat).messages.some((m) => m.type === "compaction"));
    return "context-overflow → compaction → answered";
  });

  await scenario("an answer cut at the output limit (Claude's max_tokens): finish length → OpenCode asks to continue; three cut in a row fail the step", async () => {
    const chat = await twoTurns("Q-length");
    const before = opencode.retries.length;
    claude.state.failures = ["maxTokens", "maxTokens", "maxTokens"];
    const turn = await opencode.turn(chat).finally(() => (claude.state.failures = []));
    const first = turn.requests[0]!.reply!;
    const asked = () => opencode.session(chat).messages.filter((m) => m.type === "synthetic" && m.text === CONTINUE_AFTER_OUTPUT_LIMIT);
    if (first.finish !== "length") {
      // OpenCode continues only a `length` finish (finish-reason-regression's finding where the plugin answers otherwise).
      assert.equal(asked().length, 0, "no request to continue after another finish");
      return `the plugin's answer: finish ${first.finish}, ${turn.requests.length} request — nothing to continue`;
    }
    assert.equal(turn.requests.length, 3, `three cut answers: ${turn.requests.map((r) => r.reply?.finish).join(",")}`);
    assert.equal(opencode.retries.length, before, "a continuation is no retry");
    assert.equal(turn.ok, false);
    assert.equal(turn.failure?.message, OUTPUT_LIMIT_EXHAUSTED);
    const tail = opencode.session(chat).messages.slice(-5);
    assert.deepEqual(
      tail.map((m) => (m.type === "assistant" ? `assistant ${m.finish}` : `${m.type} ${m.text}`)),
      ["assistant length", `synthetic ${CONTINUE_AFTER_OUTPUT_LIMIT}`, "assistant length", `synthetic ${CONTINUE_AFTER_OUTPUT_LIMIT}`, "assistant length"],
    );
    assert.deepEqual(turn.requests[1]!.list.at(-1), { id: tail[1]!.id, role: "user", content: [{ type: "text", text: CONTINUE_AFTER_OUTPUT_LIMIT }] }, "the request again ends with the synthetic text");
    return `finish length ×3: two continuations, then "${OUTPUT_LIMIT_EXHAUSTED}"`;
  });

  await scenario("an image over the API's 5 MB: the CLI's record and result as 2.1.312 writes them (probe case \"400 image too large\")", async () => {
    const chat = await twoTurns("Q-img");
    claude.state.failures = ["imageTooLarge"];
    const turn = await opencode.turn(chat);
    claude.state.failures = [];
    const query = claude.queries.at(-1)!;
    assert.equal(query.outcome, "imageTooLarge");
    const synthetic = claude.records(query.name).findLast((r) => r.isApiErrorMessage === true) as Record<string, any> | undefined;
    assert.equal(synthetic?.error, "invalid_request", "the synthetic record's error");
    assert.match(JSON.stringify(synthetic?.message?.content ?? ""), /Image was too large\. Try resizing the image/);
    const first = failureOf(turn.requests[0]!.reply!);
    return `the plugin's answer: ${first?.kind ?? "no failure"} (${turn.requests[0]!.status})`;
  });

  /** The plugin's hooks OpenCode called while `body` ran, by name (only the hooks the plugin registered). */
  const hooksCalled = async (body: () => Promise<unknown>) => {
    const hooks = opencode.instances[0]!.hooks;
    const original = { ...hooks };
    const called: string[] = [];
    for (const name of Object.keys(hooks)) {
      hooks[name] = async (payload: any) => {
        called.push(name === "model.request" ? `model.request:${payload.kind}` : name);
        return original[name]!(payload);
      };
    }
    try {
      await body();
    } finally {
      Object.assign(hooks, original);
    }
    return called;
  };

  await scenario("a title: the title hook and kind, the title agent's prompt, the first line of the answer", async () => {
    const chat = await twoTurns("Q-title");
    let titled: Awaited<ReturnType<typeof opencode.title>> | undefined;
    const called = await hooksCalled(async () => (titled = await opencode.title(chat)));
    const registered = Object.keys(opencode.instances[0]!.hooks);
    for (const name of ["title", "model.request"]) if (registered.includes(name)) assert.ok(called.some((c) => c.startsWith(name)), `${name} hook: ${called.join(",")}`);
    assert.ok(!called.includes("context"), "no context hook for a title");
    if (registered.includes("model.request")) assert.ok(called.includes("model.request:title"), called.join(","));
    const body = titled!.requests[0]?.body as { messages: Array<Record<string, any>>; tools?: unknown } | undefined;
    if (body) assert.match(String(body.messages[0]?.content), /^You are a title generator/);
    return `title: ${JSON.stringify(titled!.title)}; hooks: ${called.join(", ") || "none"}`;
  });

  // Before the rate-limit scenario: the limit it leaves stored makes the plugin refuse a request sent again for the same chat and messages.
  await scenario("a title's second attempt: the title model failed or answered blank → once more on the primary model; the same model: once", async () => {
    const models = (opencode.instances[0]!.provider.models as Array<{ id: string }>).map((m) => m.id);
    const plain = (await opencode.title(await twoTurns("Q-title-primary"))).requests[0];
    const primary = plain?.body?.model as string | undefined;
    const variant = opencode.state.variant;
    const small = models.find((id) => id !== primary && /haiku/.test(id)) ?? models.find((id) => id !== primary);
    if (!primary || !small) return `no second model in the catalog (${models.join(", ")})`;
    const results: string[] = [];
    try {
      for (const [label, set] of [
        ["failed", () => (claude.state.summaryFailures = ["badRequest"])],
        ["blank", () => (claude.state.summaryReplies = [" \n  \n"])],
      ] as const) {
        opencode.state.titleModelID = small;
        set();
        claude.state.summaryReplies.push("Second Attempt Title");
        const titled = await opencode.title(await twoTurns(`Q-title-${label}`));
        claude.state.summaryFailures = [];
        claude.state.summaryReplies = [];
        assert.deepEqual(titled.requests.map((r) => r.body?.model), [small, primary], `${label}: the title model, then the primary`);
        assert.equal(titled.title, "Second Attempt Title", `${label}: the title from the second attempt, not ${JSON.stringify(titled.title)} (${titled.requests.map((r) => `${r.status} ${JSON.stringify(r.reply?.text)}`).join(", ")})`);
        results.push(`${label}: ${titled.requests.map((r) => `${r.body?.model} ${r.status}`).join(" → ")}`);
      }
      // The same model and variant: the title agent's model is the primary, and the user picked the variant it takes by
      // default (the first of none / minimal / low the model offers; a variant alone differing is another model).
      const offered = ((opencode.instances[0]!.provider.models as Array<{ id: string; variants?: Array<{ id: string }> }>).find((m) => m.id === primary)?.variants ?? []).map((v) => v.id);
      opencode.state.titleModelID = primary;
      opencode.state.variant = ["none", "minimal", "low"].find((v) => offered.includes(v));
      claude.state.summaryFailures = ["badRequest"];
      const once = await opencode.title(await twoTurns("Q-title-same"));
      claude.state.summaryFailures = [];
      assert.equal(once.requests.length, 1, "the same model: no second attempt");
      assert.equal(once.title, undefined, "a failed title keeps the title");
      results.push(`same model and variant (${plain?.model?.variant ?? "none"}): ${once.requests.length} request, no title`);
    } finally {
      opencode.state.titleModelID = undefined;
      opencode.state.variant = variant;
      claude.state.summaryFailures = [];
      claude.state.summaryReplies = [];
    }
    return results.join("; ");
  });

  await scenario("a title's variant: the title agent's own, else the first of none / minimal / low the model offers; the variant alone differing → a second attempt", async () => {
    const models = opencode.instances[0]!.provider.models as Array<{ id: string; variants?: Array<{ id: string }> }>;
    const sent = (await opencode.title(await twoTurns("Q-title-variant"))).requests[0]?.model;
    assert.ok(sent, "the title's request names its model");
    const offered = models.find((m) => m.id === sent.id)?.variants?.map((v) => v.id) ?? [];
    // No title agent's model and no small model: 2.2.0 titles on the primary with the first of none / minimal / low it
    // offers, "low" only below the user's variant (context.ts lowerVariant); 2.0.32 took the first of the three.
    const lower = (picked?: string) => ["none", "minimal", "low"].find((v) => offered.includes(v) && (v !== "low" || offered.indexOf(v) < offered.indexOf(picked ?? "")));
    assert.equal(sent.variant ?? undefined, lower(opencode.state.variant) ?? opencode.state.variant, `2.2.0: none / minimal / low below the user's variant, of ${offered.join(",") || "no variants"}`);
    const savedVariant = opencode.state.variant;
    const higher = offered.at(-1);
    if (higher && higher !== "low") {
      try {
        opencode.state.variant = higher;
        const below = (await opencode.title(await twoTurns("Q-title-variant-high"))).requests[0]?.model;
        assert.equal(below?.variant, lower(higher), `the user's ${higher}: the title below it`);
        opencode.state.variant = savedVariant;
        opencode.state.version = "2.0.32";
        const old = (await opencode.title(await twoTurns("Q-title-variant-2.0.32"))).requests[0]?.model;
        assert.equal(old?.variant, ["none", "minimal", "low"].find((v) => offered.includes(v)), "2.0.32: the first of none / minimal / low");
      } finally {
        opencode.state.variant = savedVariant;
        opencode.state.version = "2.2.0";
      }
    }
    // The agent's own: a variant the model offers (another one OpenCode could not resolve and would title on the primary).
    const own = offered.find((v) => v !== sent.variant && v !== opencode.state.variant);
    if (!own) return `default variant ${sent.variant ?? "none"}; the model offers no other variant (${offered.join(",") || "none"})`;
    try {
      opencode.state.titleVariant = own;
      claude.state.summaryFailures = ["badRequest"];
      claude.state.summaryReplies = ["Primary Model Title"];
      const again = await opencode.title(await twoTurns("Q-title-variant-own"));
      assert.deepEqual(
        again.requests.map((r) => [r.model?.id, r.model?.variant]),
        [
          [sent.id, own],
          [sent.id, opencode.state.variant],
        ],
        "the title agent's variant, then the primary as the user picked it",
      );
      assert.equal(again.title, "Primary Model Title");
      return `default variant ${sent.variant ?? "none"} (offered ${offered.join(",") || "none"}); the agent's own failed → ${again.requests.length} requests`;
    } finally {
      opencode.state.titleVariant = undefined;
      claude.state.summaryFailures = [];
      claude.state.summaryReplies = [];
    }
  });

  await scenario("rate limit: OpenCode waits at least the retry-after, then sends again", async () => {
    const chat = await twoTurns("Q-chi");
    const before = opencode.retries.length;
    claude.state.failures = ["rateLimit"];
    const turn = await opencode.turn(chat);
    claude.state.failures = [];
    const first = failureOf(turn.requests[0]!.reply!);
    const waits = opencode.retries.slice(before);
    if (first?.kind !== "rate-limit") return `the plugin's answer: ${first?.kind ?? "no failure"} (${turn.requests[0]!.status}); retries ${waits.length}`;
    assert.ok(waits.length >= 1, "retried");
    if (first.retryAfterMs !== undefined) assert.ok(waits[0]!.delay >= first.retryAfterMs, `waited ${waits[0]!.delay} ms, retry-after ${first.retryAfterMs}`);
    return `rate-limit, retry-after ${first.retryAfterMs ?? "none"} ms, ${waits.length} retries, then ${turn.ok ? "answered" : "failed"}`;
  });

  await scenario("an account failure: OpenCode does not send it again", async () => {
    const chat = await twoTurns("Q-psi");
    const before = opencode.retries.length;
    claude.state.failures = ["oauthOrg"];
    const turn = await opencode.turn(chat);
    claude.state.failures = [];
    const first = failureOf(turn.requests[0]!.reply!);
    assert.ok(!turn.ok, "the turn fails");
    if (first && !first.retryable) assert.equal(opencode.retries.length, before, "no retry of a failure OpenCode does not retry");
    return `the plugin's answer: ${first?.kind ?? "no failure"} (${turn.requests[0]!.status}), retryable ${first?.retryable}`;
  });

  await scenario("compaction after a 413: the summary request is sent again as text", async () => {
    const chat = await twoTurns("Q-omega");
    await opencode.turn(chat);
    claude.state.summaryFailures = ["requestTooLarge"];
    const done = await opencode.compact(chat);
    claude.state.summaryFailures = [];
    const first = failureOf(done.requests[0]!.reply!);
    if (first?.kind !== "payload-too-large") return `the plugin's answer to the summary: ${first?.kind ?? "no failure"} (${done.requests[0]!.status}); ${done.status}`;
    assert.equal(done.requests.length, 2, "the summary, then the summary as text");
    const asText = done.requests[1]!.body!.messages as Array<Record<string, any>>;
    assert.ok(asText.every((m) => typeof m.content === "string" || m.content === null), "the second request has no media parts");
    return `payload-too-large → as text → ${done.status}`;
  });

  await scenario("generate in a session: the generate hook and kind, the chat then the prompt", async () => {
    const chat = await twoTurns("Q-gen");
    let generated: Awaited<ReturnType<typeof opencode.generate>> | undefined;
    const called = await hooksCalled(async () => (generated = await opencode.generate(chat, "GENERATE-PROMPT")));
    const registered = Object.keys(opencode.instances[0]!.hooks);
    if (registered.includes("model.request")) assert.ok(called.includes("model.request:generate"), called.join(","));
    assert.ok(!called.includes("context"));
    const messages = generated!.body.messages as Array<Record<string, any>>;
    assert.equal(messages.at(-1)!.content, "GENERATE-PROMPT");
    assert.ok(JSON.stringify(messages).includes("Q-gen one"), "the chat's messages before the prompt");
    return `status ${generated!.reply?.status}; hooks: ${called.join(", ") || "none"}`;
  });

  await scenario("generate with no session: no hook of any kind, the provider's own address", async () => {
    let generated: Awaited<ReturnType<typeof opencode.generateText>> | undefined;
    const called = await hooksCalled(async () => (generated = await opencode.generateText("STANDALONE-PROMPT")));
    assert.deepEqual(called, [], "no hook");
    assert.deepEqual(generated!.body.messages, [{ role: "user", content: "STANDALONE-PROMPT" }]);
    return `status ${generated!.reply.status}: ${generated!.text.slice(0, 40)}`;
  });

  // ---- other processes and other builds of the plugin on the world's machine ----

  await scenario("a second process on the same machine: the same data, Claude profile and CLI; its own clock", async () => {
    const callsBefore = claude.cli.calls().length;
    const day = 86_400_000;
    const other = await world.secondProcess({ clockShiftMs: -day });
    try {
      await other.start();
      await other.call("opencode.newChat", "second-1");
      await other.call("opencode.say", "second-1", "hello from another server");
      const turn = await other.call("opencode.turn", "second-1");
      assert.ok(turn.ok, "the other server's turn answered");
      const query = await other.call("claude.queries.at", -1);
      assert.ok(query?.name, "the other process's Claude Code ran the query");
      assert.ok(claude.records(query.name).some((r) => r.type === "assistant"), "its transcript is in the world's Claude profile");
      assert.ok(claude.cli.calls().length > callsBefore, "it started the world's CLI install (one log)");
      const yesterday = new Date(Date.now() - day).toISOString().slice(0, 10);
      const its = world.journal().filter((line) => line.startsWith(yesterday));
      assert.ok(its.some((line) => line.includes("second-1")), "its journal lines in the shared debug.log carry its clock");
      assert.equal((await other.journal())[0], world.journal()[0], "one journal file");
      assert.equal(await other.exit(), 0, "it exits as OpenCode exits");
      return `${claude.cli.calls().length - callsBefore} CLI starts; ${its.length} lines a day behind`;
    } finally {
      await other.kill();
    }
  });

  await scenario("a server killed while it rewrites a file leaves it as a kill does (empty), and the next server opens its database", async () => {
    // main 1.6.0 rewrites sessions.json whole on every streamed event (writeFileSync): the kill lands there.
    const other = await world.secondProcess({ tree: releaseTree("v1.6.0") });
    const store = join(process.env.XDG_DATA_HOME!, "opencode-claude", "sessions.json");
    try {
      await other.start();
      for (const chat of ["killed-a", "killed-b"]) {
        await other.call("opencode.newChat", chat);
        await other.call("opencode.say", chat, `hello ${chat}`);
        assert.ok((await other.call("opencode.turn", chat)).ok);
      }
      assert.ok(readFileSync(store, "utf8").includes("killed-b"), "both chats bound");
      await other.call("opencode.say", "killed-b", "again");
      const saved = await other.call("opencode.database");
      await other.killAtWrite("sessions.json");
      const ended = await other.call("opencode.turn", "killed-b").then(
        () => "answered",
        (error: Error) => error.message,
      );
      assert.match(ended, /the second process ended/, "the turn ends with the process");
      assert.notEqual(other.exitCode, 0);
      assert.equal(readFileSync(store, "utf8"), "", "truncated, nothing written");
      const before = opencode.sessions.size;
      opencode.openDatabase(saved);
      assert.equal(opencode.sessions.size, before + 2, "the killed server's chats");
      assert.deepEqual(opencode.session("killed-b").messages.map((m) => m.type), ["user", "assistant", "user"]);
      const later = opencode.newChat();
      await opencode.say(later, "after the restart");
      const ids = [...opencode.session("killed-b").messages, ...opencode.session(later).messages].map((m) => m.id);
      assert.deepEqual([...ids].sort(), ids, "new ids come after the database's");
      await opencode.say("killed-a", "killed-a again");
      assert.ok((await opencode.turn("killed-a")).ok, "the next server serves the chat");
    } finally {
      await other.kill();
    }
  });

  await scenario("an older release before the tree under test, on the same folders (v1.3.0, then this tree)", async () => {
    const old = await world.build(releaseTree("v1.3.0"));
    const current = opencode.instances[0]!;
    await opencode.stopPlugin(current);
    const queriesBefore = claude.queries.length;
    const instance = await opencode.startPlugin(undefined, { setup: old.setup });
    const chat = opencode.newChat("upgraded-1");
    await opencode.say(chat, "with 1.3.0");
    const turn = await opencode.turn(chat);
    await opencode.stopPlugin(instance);
    await opencode.startPlugin();
    assert.ok(turn.ok, "1.3.0 answered");
    assert.equal(claude.queries.length, queriesBefore + 1, "one query, through 1.3.0's own starter into the world's CLI");
    const store = JSON.parse(readFileSync(join(process.env.XDG_DATA_HOME!, "opencode-claude", "sessions.json"), "utf8"));
    const turns = store[chat]?.turns as Array<Record<string, unknown>> | undefined;
    assert.deepEqual(Object.keys(turns?.[0] ?? {}).sort(), ["count", "hash", "leafUuid"], "1.3.0's record: boundaries without a session id");
    await opencode.say(chat, "after the upgrade");
    assert.ok((await opencode.turn(chat)).ok, "the tree under test serves the chat after it");
  });

  await scenario("a copy of the whole plugin, as OpenCode 2.0.32 loads a local plugin (every module afresh, packages shared)", async () => {
    const modelsBefore = await pluginModule("models");
    const proxyBefore = await pluginModule("proxy");
    const copy = await world.build(world.dir, { copy: true });
    const copyModels = await copy.module("models");
    assert.notEqual(copy.index, world.plugin.index, "a fresh index");
    assert.notEqual(copy.proxy, proxyBefore, "a fresh proxy: imported by the copy's index, not shared with the first");
    assert.notEqual(copyModels, modelsBefore, "a fresh models.ts");
    assert.equal(await pluginModule("models"), copyModels, "the registry holds the latest copy");
    const folder = join(world.tmp, "copy-folder");
    mkdirSync(folder, { recursive: true });
    const instance = await opencode.startPlugin(undefined, { directory: folder, setup: copy.setup });
    const chat = opencode.newChat("copy-1", folder);
    await opencode.say(chat, "in another folder");
    const turn = await opencode.turn(chat);
    await opencode.stopPlugin(instance);
    assert.ok(turn.ok, "the copy serves its folder");
  });

  await scenario("the plugin's journal holds no error", async () => {
    const errors = errorsInJournal();
    assert.equal(errors.length, 0, errors.slice(0, 3).join("\n"));
  });
} finally {
  await world.dispose();
}

const failed = outcomes.filter((o) => !o.ok);
console.log(`\n${outcomes.length - failed.length} passed, ${failed.length} failed (plugin tree ${world.dir})`);
process.exit(failed.length > 0 ? 1 : 0);
