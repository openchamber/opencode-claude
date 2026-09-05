/**
 * Smoke tests for opencode-claude — no live Claude CLI required.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function main() {
  const { buildClaudeCodeChildEnv } = await import("../src/auth-env.ts");
  const {
    interpretClaudeAuthStatus,
  } = await import("../src/detect.ts");
  const {
    CLAUDE_CODE_MODELS,
    buildEffortVariants,
    getClaudeModels,
    resolveClaudeModelId,
  } = await import("../src/models.ts");
  const {
    encodeClaudeModelSelection,
    decodeClaudeModelSelection,
    resolveClaudeModelSelection,
  } = await import("../src/model-selection.ts");
  const { conversationKeyFromMessages } = await import(
    "../src/session-store.ts"
  );
  const { isClaudeEffort, PROVIDER_ID, EFFORT_LEVELS } = await import(
    "../src/constants.ts"
  );
  const {
    applyClaudeRequestContextHeaders,
    buildAuthMethods,
    manualInstallResponse,
    ClaudeCodePlugin,
  } = await import("../src/index.ts");
  const {
    startProxy,
    stopProxy,
    getProxyPort,
    getClaudeProxyBaseUrl,
    PROXY_IDLE_TIMEOUT_SECONDS,
  } = await import("../src/proxy.ts");

  // Auth env stripping
  const cleaned = buildClaudeCodeChildEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-secret",
    ANTHROPIC_AUTH_TOKEN: "tok",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    KEEP: "1",
  });
  assert.equal(cleaned.ANTHROPIC_API_KEY, undefined);
  assert.equal(cleaned.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(cleaned.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(cleaned.KEEP, "1");
  assert.equal(cleaned.PATH, "/usr/bin");

  // The UI login relays the official CLI flow: its authorize URL comes back to
  // the host, and the code the user pastes goes into the CLI's stdin.
  {
    const {
      getClaudeCliLoginStatus,
      resetClaudeCliLoginForTests,
      startClaudeCliLogin,
      submitClaudeCliLoginCode,
    } = await import("../src/cli-login.ts");

    const createFakeCli = () => {
      const makeStream = () =>
        Object.assign(new EventEmitter(), { setEncoding() {} });
      const writes: string[] = [];
      const child = Object.assign(new EventEmitter(), {
        pid: 1234,
        exitCode: null as number | null,
        killed: false,
        stdout: makeStream(),
        stderr: makeStream(),
        stdin: Object.assign(new EventEmitter(), {
          writable: true,
          write(chunk: string) {
            writes.push(chunk);
            return true;
          },
        }),
        kill() {
          this.killed = true;
          return true;
        },
      });
      return { child, writes };
    };
    const authorizeUrl =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz";
    const cliBanner = (url: string) =>
      `Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\nPaste code here if prompted > `;
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    // Accepted code: URL relayed out, code relayed in, exit 0 is the success.
    {
      const { child, writes } = createFakeCli();
      let invocation: {
        executable: string;
        args: string[];
        options: Record<string, unknown>;
      } | null = null;
      const pending = startClaudeCliLogin({
        binaryPath: "/usr/local/bin/claude",
        env: {
          PATH: "/usr/local/bin",
          CLAUDE_CODE_OAUTH_TOKEN: "must-not-leak",
        },
        spawnLogin(executable, args, options) {
          invocation = {
            executable,
            args,
            options: options as Record<string, unknown>,
          };
          return child as any;
        },
      });
      await tick();
      child.stdout.emit("data", cliBanner(authorizeUrl));
      const started = await pending;

      assert.deepEqual(started, { state: "awaiting-code", url: authorizeUrl });
      assert.equal(invocation!.executable, "/usr/local/bin/claude");
      assert.deepEqual(invocation!.args, ["auth", "login", "--claudeai"]);
      assert.deepEqual(invocation!.options.stdio, ["pipe", "pipe", "pipe"]);
      assert.equal(
        (invocation!.options.env as Record<string, unknown>)
          .CLAUDE_CODE_OAUTH_TOKEN,
        undefined,
      );

      const submitted = submitClaudeCliLoginCode("  pasted-code  ");
      assert.deepEqual(writes, ["pasted-code\n"]);
      await tick();
      child.exitCode = 0;
      child.emit("exit", 0, null);
      assert.deepEqual(await submitted, { ok: true });
      assert.deepEqual(getClaudeCliLoginStatus(), { state: "succeeded" });
      resetClaudeCliLoginForTests();
    }

    // Rejected code: the CLI keeps prompting on the same challenge, so failure
    // is reported from its stderr rather than from an exit that never comes.
    {
      const { child, writes } = createFakeCli();
      const pending = startClaudeCliLogin({
        binaryPath: "/usr/local/bin/claude",
        env: { PATH: "/usr/local/bin" },
        spawnLogin: () => child as any,
      });
      await tick();
      child.stdout.emit("data", cliBanner(authorizeUrl));
      await pending;

      const submitted = submitClaudeCliLoginCode("wrong-code");
      await tick();
      child.stderr.emit(
        "data",
        "Invalid code. Please make sure the full code was copied.\n",
      );
      const result = await submitted;
      assert.equal(result.ok, false);
      assert.match(
        result.ok ? "" : result.message,
        /Invalid code\. Please make sure the full code was copied\./,
      );

      // Retrying reuses the live sign-in and its still-valid URL — respawning
      // would abandon the verifier the CLI holds in memory.
      const resumed = await startClaudeCliLogin({
        binaryPath: "/usr/local/bin/claude",
        env: { PATH: "/usr/local/bin" },
        spawnLogin: () => {
          throw new Error("a live sign-in must be reused, not respawned");
        },
      });
      assert.deepEqual(resumed, { state: "awaiting-code", url: authorizeUrl });

      // The stale rejection must not fail the next code before the CLI reads it.
      const retried = submitClaudeCliLoginCode("second-code");
      assert.deepEqual(writes, ["wrong-code\n", "second-code\n"]);
      await tick();
      child.exitCode = 0;
      child.emit("exit", 0, null);
      assert.deepEqual(await retried, { ok: true });
      resetClaudeCliLoginForTests();
    }

    // No CLI found: the host falls back to terminal instructions.
    {
      const missing = await startClaudeCliLogin({
        binaryPath: null,
        env: { PATH: "/usr/local/bin", HOME: "/nonexistent" },
        spawnLogin: () => {
          throw new Error("must not spawn without a binary");
        },
      });
      assert.equal(missing.state, "failed");
      assert.match(
        missing.state === "failed" ? missing.message : "",
        /npm install -g @anthropic-ai\/claude-code/,
      );
      resetClaudeCliLoginForTests();
    }

    // A code submitted with no sign-in running is refused, not written blind.
    {
      const orphan = await submitClaudeCliLoginCode("code-without-session");
      assert.equal(orphan.ok, false);
    }
  }

  // CLI resolution finds install locations a clean server PATH misses.
  {
    const { mkdtempSync, writeFileSync, chmodSync, mkdirSync } = await import(
      "node:fs"
    );
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { resolveClaudeCli } = await import("../src/executable-path.ts");

    const home = mkdtempSync(join(tmpdir(), "oc-claude-home-"));
    const binDir = join(home, ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const fake = join(
      binDir,
      process.platform === "win32" ? "claude.cmd" : "claude",
    );
    writeFileSync(
      fake,
      process.platform === "win32"
        ? '@echo off\r\necho 2.1.226 (Claude Code)\r\n'
        : '#!/bin/sh\necho "2.1.226 (Claude Code)"\n',
      { mode: 0o755 },
    );
    chmodSync(fake, 0o755);

    assert.equal(resolveClaudeCli({ PATH: "/usr/bin:/bin", HOME: home }), fake);
    // And PATH itself still wins when the CLI is on it.
    assert.ok(resolveClaudeCli({ PATH: "/usr/bin:/bin", HOME: home }));
  }

  // The one-click install path: official npm package, script as fallback.
  {
    const { installClaudeCli } = await import("../src/cli-install.ts");
    const { EventEmitter: CliEventEmitter } = await import("node:events");

    const fakeCli = () => {
      const streams = { stdout: new CliEventEmitter(), stderr: new CliEventEmitter() };
      const child = Object.assign(new CliEventEmitter(), {
        pid: 7,
        stdout: streams.stdout,
        stderr: streams.stderr,
        kill() {
          return true;
        },
      });
      return { child, streams };
    };

    // npm succeeds → no script fallback runs.
    {
      const { child, streams } = fakeCli();
      const calls: string[][] = [];
      const pending = installClaudeCli({
        env: { PATH: "/usr/bin" },
        spawnInstall(command, args) {
          calls.push([command, ...args]);
          return child as any;
        },
      });
      await new Promise((r) => setTimeout(r, 0));
      streams.stdout.emit("data", "added 1 package\n");
      child.emit("exit", 0);
      assert.deepEqual(await pending, { ok: true });
      assert.deepEqual(calls, [["npm", "install", "-g", "@anthropic-ai/claude-code"]]);
    }

    // npm fails → the official install script runs; its failure is reported.
    {
      const failures = [fakeCli(), fakeCli()];
      let call = 0;
      const pending = installClaudeCli({
        env: { PATH: "/usr/bin" },
        spawnInstall(command) {
          const { child, streams } = failures[call]!;
          call += 1;
          process.nextTick(() => {
            if (command === "npm") {
              streams.stderr.emit("data", "npm: not found\n");
              child.emit("exit", 127);
            } else {
              streams.stderr.emit("data", "curl: could not resolve host\n");
              child.emit("exit", 6);
            }
          });
          return child as any;
        },
      });
      const result = await pending;
      assert.equal(result.ok, false);
      assert.match(
        result.ok ? "" : result.message,
        /curl: could not resolve host/,
      );
    }
  }


  // Auth status interpretation (subscription vs API-key-only)
  assert.equal(
    interpretClaudeAuthStatus({ loggedIn: true, authMethod: "oauth" }).loggedIn,
    true,
  );
  assert.equal(
    interpretClaudeAuthStatus({ loggedIn: true, authMethod: "api_key" })
      .loggedIn,
    false,
  );
  assert.equal(
    interpretClaudeAuthStatus({ loggedIn: false, authMethod: "none" }).loggedIn,
    false,
  );

  // Models / effort
  const models = getClaudeModels();
  assert.ok(models.length >= 4);
  assert.ok(models.some((m) => m.id === "sonnet"));
  assert.ok(models.some((m) => m.id === "opus"));
  assert.equal(resolveClaudeModelId("haiku"), "claude-haiku-4-5");
  assert.equal(resolveClaudeModelId("sonnet"), "sonnet");

  const sonnet = CLAUDE_CODE_MODELS.find((m) => m.id === "sonnet")!;
  const variants = buildEffortVariants(sonnet);
  for (const level of EFFORT_LEVELS) {
    assert.ok(variants[level]);
    assert.equal(isClaudeEffort(level), true);
    assert.ok(
      variants[level] &&
        typeof variants[level] === "object" &&
        "effort" in variants[level],
    );
  }
  assert.deepEqual(variants.none, { disabled: true });
  assert.deepEqual(variants.minimal, { disabled: true });
  assert.equal(isClaudeEffort("nope"), false);

  const selection = resolveClaudeModelSelection("sonnet", "high");
  const encoded = encodeClaudeModelSelection(selection);
  const decoded = decodeClaudeModelSelection(encoded);
  assert.deepEqual(decoded, { modelId: "sonnet", effort: "high" });

  // Multimodal prompt conversion
  const {
    openaiContentToAnthropicBlocks,
    latestUserPrompt: buildPrompt,
    contentHasAttachments,
  } = await import("../src/prompt.ts");
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const blocks = openaiContentToAnthropicBlocks([
    { type: "text", text: "what color?" },
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${png}` },
    },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.type, "text");
  assert.equal(blocks[1]?.type, "image");
  assert.equal(contentHasAttachments([{ type: "image_url", image_url: { url: "x" } }]), true);

  // OpenAI-compatible PDF shape from @ai-sdk/openai-compatible
  const pdfB64 = "JVBERi0xLjAK"; // "%PDF-1.0" stub
  const pdfBlocks = openaiContentToAnthropicBlocks([
    { type: "text", text: "summarise" },
    {
      type: "file",
      file: {
        filename: "note.pdf",
        file_data: `data:application/pdf;base64,${pdfB64}`,
      },
    },
  ]);
  assert.equal(pdfBlocks.length, 2);
  assert.equal(pdfBlocks[0]?.type, "text");
  assert.equal(pdfBlocks[1]?.type, "document");
  assert.equal(
    pdfBlocks[1] && "source" in pdfBlocks[1] && pdfBlocks[1].source.type === "base64"
      ? pdfBlocks[1].source.media_type
      : null,
    "application/pdf",
  );
  assert.equal(
    pdfBlocks[1] && "source" in pdfBlocks[1] && pdfBlocks[1].source.type === "base64"
      ? pdfBlocks[1].source.data
      : null,
    pdfB64,
  );
  const pdfPrompt = buildPrompt([
    {
      role: "user",
      content: [
        { type: "text", text: "read this" },
        {
          type: "file",
          file: {
            filename: "note.pdf",
            file_data: `data:application/pdf;base64,${pdfB64}`,
          },
        },
      ],
    },
  ]);
  assert.equal(
    typeof pdfPrompt === "object" &&
      pdfPrompt !== null &&
      pdfPrompt.type === "user" &&
      Array.isArray(pdfPrompt.message.content) &&
      pdfPrompt.message.content.some((b) => b.type === "document"),
    true,
  );

  // AI SDK-style { type: "image", image: dataUrl } must not be dropped
  const sdkImage = openaiContentToAnthropicBlocks([
    { type: "text", text: "see?" },
    { type: "image", image: `data:image/png;base64,${png}` },
  ]);
  assert.equal(sdkImage.some((b) => b.type === "image"), true);
  const namedDataUrl = openaiContentToAnthropicBlocks([
    {
      type: "image_url",
      image_url: { url: `data:image/png;name=x.png;base64,${png}` },
    },
  ]);
  assert.equal(namedDataUrl.length, 1);
  assert.equal(namedDataUrl[0]?.type, "image");

  const multi = buildPrompt([
    {
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
      ],
    },
  ]);
  assert.equal(typeof multi === "object" && multi !== null && multi.type === "user", true);

  // Conversation key stability
  const key = conversationKeyFromMessages([
    { role: "user", content: "hello world" },
  ]);
  assert.ok(key.startsWith("conv_"));
  // Key must be stable as the conversation grows — a per-turn changing key
  // defeats Claude session resume when the session header is absent.
  const keyLater = conversationKeyFromMessages([
    { role: "user", content: "hello world" },
    { role: "assistant", content: "hi!" },
    { role: "user", content: "follow up" },
  ]);
  assert.equal(keyLater, key);

  // ---- Conversation-history transfer (context when resume is impossible) ----
  {
    const {
      buildConversationTranscript,
      priorMessagesOf,
      withConversationContext,
    } = await import("../src/prompt.ts");

    const history = [
      { role: "system", content: "You are a huge internal system prompt." },
      { role: "user", content: "remember the codename AXIOM-9042" },
      { role: "assistant", content: "Got it — codename AXIOM-9042 noted." },
      { role: "user", content: "what is the codename?" },
    ];

    // priorMessagesOf excludes the latest user turn
    const prior = priorMessagesOf(history);
    assert.equal(prior.length, 3);
    assert.equal(prior[prior.length - 1]?.role, "assistant");

    const transcript = buildConversationTranscript(prior);
    assert.match(transcript, /AXIOM-9042/);
    assert.match(transcript, /^User:/m);
    assert.match(transcript, /^Assistant:/m);
    // system prompt never leaks into the transfer
    assert.doesNotMatch(transcript, /huge internal system prompt/);

    // tool calls/results are condensed but present
    const withTools = buildConversationTranscript([
      { role: "user", content: "run tests" },
      {
        role: "assistant",
        content: "running",
        tool_calls: [
          { id: "c1", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "x".repeat(5000) },
    ]);
    assert.match(withTools, /\[called tool: bash\]/);
    assert.match(withTools, /Tool result/);
    assert.match(withTools, /chars omitted/);

    // budget keeps the NEWEST messages, drops oldest first
    const tight = buildConversationTranscript(
      [
        { role: "user", content: "OLD-MESSAGE-MARKER " + "y".repeat(200) },
        { role: "user", content: "NEW-MESSAGE-MARKER" },
      ],
      100,
    );
    assert.match(tight, /NEW-MESSAGE-MARKER/);
    assert.doesNotMatch(tight, /OLD-MESSAGE-MARKER/);
    assert.match(tight, /earlier message\(s\) omitted/);

    // zero budget disables transfer entirely
    assert.equal(buildConversationTranscript(prior, 0), "");

    // attachments in history leave an explicit note
    const withImage = buildConversationTranscript([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
        ],
      },
    ]);
    assert.match(withImage, /attachment\(s\) omitted/);

    // withConversationContext: string prompt gets the history prefix
    const wrapped = withConversationContext("what is the codename?", transcript);
    assert.equal(typeof wrapped, "string");
    assert.match(wrapped as string, /<conversation_history>/);
    assert.match(wrapped as string, /AXIOM-9042/);
    assert.match(wrapped as string, /Latest user message:\nwhat is the codename\?/);

    // empty transcript leaves the prompt untouched
    assert.equal(withConversationContext("hi", ""), "hi");

    // multimodal prompt gets a leading text block, attachments preserved
    const multiWrapped = withConversationContext(
      {
        type: "user" as const,
        message: {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "see this" },
            {
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/png",
                data: "AA",
              },
            },
          ],
        },
        parent_tool_use_id: null,
      },
      transcript,
    );
    assert.equal(typeof multiWrapped, "object");
    const mwContent = (multiWrapped as { message: { content: unknown[] } })
      .message.content;
    assert.equal((mwContent[0] as { type: string }).type, "text");
    assert.match(
      (mwContent[0] as { text: string }).text,
      /<conversation_history>/,
    );
    assert.equal((mwContent[2] as { type: string }).type, "image");
  }

  // Usage + compact helpers
  const { usageFromSdkResult, formatCompactNote } = await import(
    "../src/usage.ts"
  );
  const usage = usageFromSdkResult({
    type: "result",
    is_error: false,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 50,
      output_tokens: 10,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 0,
    },
  });
  // prompt_tokens follows the OpenAI contract: inclusive of cached tokens
  // (Anthropic's input_tokens excludes them, so 50 + 5 + 0 = 55).
  assert.equal(usage?.prompt_tokens, 55);
  assert.equal(usage?.completion_tokens, 10);
  assert.equal(usage?.prompt_tokens_details?.cached_tokens, 5);

  // Per-call usage from assistant events (the only usage signal available
  // for parked tool-call turns) + accumulation across API calls.
  const {
    usageFromAssistantEvent,
    addOpenAIUsage,
    addUniqueAssistantUsage,
    resolveTurnUsage,
  } = await import("../src/usage.ts");
  const callUsage = usageFromAssistantEvent({
    type: "assistant",
    message: {
      role: "assistant",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 30,
      },
    },
  });
  assert.equal(callUsage?.prompt_tokens, 1030);
  assert.equal(callUsage?.completion_tokens, 20);
  assert.equal(callUsage?.prompt_tokens_details?.cached_tokens, 900);
  assert.equal(callUsage?.prompt_tokens_details?.cache_write_tokens, 30);
  assert.equal(
    usageFromAssistantEvent({ type: "result", usage: { input_tokens: 1 } }),
    null,
  );

  const summed = addOpenAIUsage(callUsage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 7 },
  });
  assert.equal(summed.prompt_tokens, 1040);
  assert.equal(summed.completion_tokens, 25);
  assert.equal(summed.total_tokens, 1065);
  assert.equal(summed.prompt_tokens_details?.cached_tokens, 907);
  assert.equal(summed.prompt_tokens_details?.cache_write_tokens, 30);

  const seenAssistantUsageIds = new Set<string>();
  const firstUnique = addUniqueAssistantUsage(
    null,
    callUsage!,
    "sdk-message-1",
    seenAssistantUsageIds,
  );
  const replayed = addUniqueAssistantUsage(
    firstUnique,
    callUsage!,
    "sdk-message-1",
    seenAssistantUsageIds,
  );
  assert.deepEqual(replayed, firstUnique);
  const secondUnique = addUniqueAssistantUsage(
    replayed,
    callUsage!,
    "sdk-message-2",
    seenAssistantUsageIds,
  );
  assert.equal(secondUnique?.total_tokens, callUsage!.total_tokens * 2);

  // Accumulated per-response usage wins over the cumulative result snapshot
  // (which would double-count prior turns of a continued Claude query), but
  // inherits cost/model breakdown metadata from it.
  const resolved = resolveTurnUsage(summed, {
    prompt_tokens: 999999,
    completion_tokens: 999999,
    total_tokens: 999999,
    cost_usd: 0.42,
  });
  assert.equal(resolved?.prompt_tokens, 1040);
  assert.equal(resolved?.cost_usd, 0.42);
  assert.equal(resolveTurnUsage(null, null), null);
  assert.match(
    formatCompactNote({ trigger: "auto", pre_tokens: 1000, post_tokens: 100 }),
    /1000 → 100/,
  );

  // Session auto-naming: detect title/summary meta requests.
  {
    const {
      detectMetaRequestKind,
      isTitleGenerationRequest,
      requestKeyNamespace,
    } = await import("../src/request-kind.ts");

    const titleMessages = [
      {
        role: "system",
        content:
          "You are a title generator. Generate a brief title for this conversation. Output only the title.",
      },
      { role: "user", content: "Explain binary trees and their basic operations" },
    ];
    assert.equal(isTitleGenerationRequest(titleMessages), true);
    assert.equal(detectMetaRequestKind(titleMessages), "title");
    assert.equal(requestKeyNamespace("title"), "title:");
    assert.equal(requestKeyNamespace(null), "");

    const summaryMessages = [
      {
        role: "system",
        content: "You are tasked with summarizing conversations for compaction.",
      },
      { role: "user", content: "Please summarize what was done in this conversation." },
    ];
    assert.equal(detectMetaRequestKind(summaryMessages), "summary");

    const actualOpenCodeUpdateSummaryPrompt = [
      "Here is the conversation so far:",
      "<conversation>",
      "User: Continue the implementation.",
      "</conversation>",
      "Here is the summary of the conversation before the <conversation> above:",
      "<prior-summary>",
      "## Objective\n- Continue the implementation",
      "</prior-summary>",
      "The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both.",
      "The <prior-summary> is discarded after this response, so preserve important information.",
      "When combining:",
      "- Preserve decisions and current state.",
      "- Remove obsolete details.",
      "Output exactly the Markdown structure shown inside <template> and keep the section order unchanged.",
    ].join("\n");
    assert.equal(
      detectMetaRequestKind([{ role: "user", content: actualOpenCodeUpdateSummaryPrompt }]),
      "summary",
    );
    assert.equal(
      detectMetaRequestKind([
        { role: "user", content: "Explain what the <prior-summary> tag means in OpenCode." },
      ]),
      null,
    );

    const normalMessages = [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "fix a bug" },
    ];
    assert.equal(detectMetaRequestKind(normalMessages), null);
  }

  // Logger: errors always emit; info is debug-gated; durable file mirror
  {
    const { spawnSync } = await import("node:child_process");
    const { readFileSync, unlinkSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const logPath = join(homedir(), ".local", "share", "opencode-claude", "debug.log");
    if (existsSync(logPath)) unlinkSync(logPath);

    const off = spawnSync(
      "bun",
      [
        "-e",
        `import { log } from "./src/log.ts"; log.info("SILENT_INFO"); log.error("ALWAYS_ERROR");`,
      ],
      {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
        env: { ...process.env, OPENCODE_CLAUDE_DEBUG: "0" },
      },
    );
    assert.equal(off.status, 0, off.stderr);
    assert.doesNotMatch(off.stderr, /SILENT_INFO/);
    assert.match(off.stderr, /ALWAYS_ERROR/);

    const on = spawnSync(
      "bun",
      [
        "-e",
        `import { log } from "./src/log.ts"; log.info("DEBUG_INFO", { ok: true });`,
      ],
      {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
        env: { ...process.env, OPENCODE_CLAUDE_DEBUG: "1" },
      },
    );
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stderr, /DEBUG_INFO/);
    assert.match(on.stderr, /"ok":true/);
    assert.ok(existsSync(logPath), "expected durable debug.log");
    const fileBody = readFileSync(logPath, "utf8");
    assert.match(fileBody, /ALWAYS_ERROR/);
    assert.match(fileBody, /DEBUG_INFO/);
  }

  // Plugin export
  assert.equal(typeof ClaudeCodePlugin, "function");

  // Auth methods mirror CLI presence: install only when missing, relay only
  // when present, and every path carries the terminal alternative. The method
  // bodies are not invoked here — on a CI host without the CLI the install
  // method would run a real `npm install -g` — so the terminal fallback is
  // exercised through its pure builder instead.
  {
    const withoutCli = buildAuthMethods(false, "/tmp");
    assert.equal(withoutCli.length, 1);
    assert.equal(
      withoutCli[0]!.label,
      "Install Claude Code CLI and sign in",
    );

    const withCli = buildAuthMethods(true, "/tmp");
    assert.equal(withCli.length, 1);
    assert.equal(withCli[0]!.label, "Sign in with Claude Code CLI");

    // The fallback instructions always name both the install and the auth
    // command, whatever the launch failure message was.
    const fallback = manualInstallResponse("boom");
    assert.match(fallback.instructions, /npm install -g @anthropic-ai\/claude-code/);
    assert.match(fallback.instructions, /claude auth login --claudeai/);
    assert.equal(fallback.method, "auto");
  }

  const requestHeaders: Record<string, string> = {};
  applyClaudeRequestContextHeaders(
    requestHeaders,
    "/data/projects/infra",
    "ses_test",
  );
  assert.equal(
    requestHeaders["x-opencode-claude-directory"],
    "/data/projects/infra",
  );
  assert.equal(requestHeaders["x-opencode-claude-session"], "ses_test");
  assert.equal(PROVIDER_ID, "claude-code");
  // Proxy health (without Agent SDK turn)
  await stopProxy();
  const port = await startProxy();
  assert.ok(port > 0);
  assert.equal(getProxyPort(), port);
  assert.ok(getClaudeProxyBaseUrl().includes(String(port)));
  // Bun's default 10s idleTimeout RSTs the socket while we probe the Claude
  // turn (no HTTP bytes until first content). 0 disables, matching OpenCode.
  assert.equal(PROXY_IDLE_TIMEOUT_SECONDS, 0);

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const healthJson = (await health.json()) as { ok: boolean };
  assert.equal(healthJson.ok, true);

  const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(modelsRes.status, 200);
  const modelsJson = (await modelsRes.json()) as { data: unknown[] };
  assert.ok(Array.isArray(modelsJson.data));
  assert.ok(modelsJson.data.length > 0);

  // Title meta requests use a constrained, tool-free Agent SDK turn.
  {
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    let titleOptions: Record<string, unknown> | null = null;
    setClaudeQueryStarter(async (params) => {
      titleOptions = params as unknown as Record<string, unknown>;
      return {
        stream: (async function* () {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "Binary search trees" },
            },
          };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      };
    });
    try {
      const titleRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            stream: true,
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
          }),
        },
      );
      assert.equal(titleRes.status, 200);
      const titleBody = await titleRes.text();
      assert.match(titleBody, /data: /);
      assert.match(titleBody, /\[DONE\]/);
      assert.match(titleBody, /Binary search trees/);
      assert.ok(titleOptions, "title request reached Agent SDK");
      assert.equal(
        (titleOptions!.env as Record<string, unknown>).CLAUDE_CODE_OAUTH_TOKEN,
        undefined,
      );
      assert.deepEqual(titleOptions!.tools, []);
      assert.deepEqual(titleOptions!.settingSources, []);
      assert.deepEqual(titleOptions!.skills, []);
      assert.equal(titleOptions!.maxTurns, 1);
      assert.equal(titleOptions!.autoCompactEnabled, false);
      assert.deepEqual(titleOptions!.thinking, { type: "disabled" });
      assert.equal(titleOptions!.resume, undefined);
      assert.equal(
        titleOptions!.systemPrompt,
        "You generate short session titles. Follow the requested output format exactly.",
      );
      assert.match(String(titleOptions!.prompt), /<request>\nExplain how binary search trees work\n<\/request>/);
    } finally {
      setClaudeQueryStarter(null);
    }
  }

  // ---- Rate-limit tracker + tool/plan behavior (mocked Agent SDK) ----
  {
    const {
      __resetRateLimitNoteDedupe,
      formatResetCountdown,
      getRateLimitSnapshot,
      isClaudeRateLimitText,
      maybeRateLimitNote,
      normalizeClaudeErrorText,
      parseResetTimeFromText,
      rateLimitGate,
      recordRateLimitErrorText,
      recordRateLimitInfo,
    } = await import("../src/rate-limit.ts");
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    const tmpDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-rl-"));
    const storeFile = joinPath(tmpDir, "rate-limit.json");
    const prevStoreEnv = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = storeFile;

    try {
      // Unit: text detection + normalization
      assert.equal(
        isClaudeRateLimitText(
          "You've hit your session limit · resets 1:10am (Europe/Kyiv)",
        ),
        true,
      );
      assert.equal(isClaudeRateLimitText("all good"), false);
      assert.equal(
        normalizeClaudeErrorText(
          "Claude Code returned an error result: You've hit your session limit · resets 1:10am (Europe/Kyiv)",
        ),
        normalizeClaudeErrorText(
          "[claude-code error] You've hit your session limit · resets 1:10am (Europe/Kyiv)",
        ),
      );

      // Unit: reset-time parsing (wall clock + IANA zone, ISO, none)
      const wallReset = parseResetTimeFromText(
        "You've hit your session limit · resets 1:10am (Europe/Kyiv)",
      );
      assert.ok(wallReset, "expected wall-clock reset parse");
      assert.ok(wallReset! > Date.now(), "reset must be in the future");
      assert.ok(
        wallReset! <= Date.now() + 26 * 3600_000,
        "reset must be within 26h",
      );
      const isoReset = parseResetTimeFromText(
        "usage limit reached, resets at 2099-01-02T03:04:05Z",
      );
      assert.equal(isoReset, Date.parse("2099-01-02T03:04:05Z"));
      assert.equal(parseResetTimeFromText("no reset hint"), undefined);
      assert.equal(formatResetCountdown(0), "now");
      assert.equal(formatResetCountdown(3_900_000), "65m");
      assert.match(formatResetCountdown(5_700_000), /^1h 35m$/);

      // Unit: structured event recording (SDK emits epoch seconds)
      const futureSec = Math.floor(Date.now() / 1000) + 5400;
      const recorded = recordRateLimitInfo({
        status: "allowed_warning",
        resetsAt: futureSec,
        rateLimitType: "five_hour",
        utilization: 0.99,
      });
      assert.ok(recorded);
      assert.equal(recorded!.limited, false); // events alone never gate
      assert.equal(recorded!.resetsAt, futureSec * 1000);
      assert.equal(recorded!.utilization, 0.99);

      // Unit: note dedupe (first yes, same signature no)
      __resetRateLimitNoteDedupe();
      const note1 = maybeRateLimitNote(recorded);
      assert.ok(note1 && /rate-limit/.test(note1) && /99%/.test(note1));
      assert.equal(maybeRateLimitNote(recorded), null);

      // Proxy: /v1/rate-limit counter endpoint reflects recorded state
      const rlRes = await fetch(`http://127.0.0.1:${port}/v1/rate-limit`);
      assert.equal(rlRes.status, 200);
      const rlBody = (await rlRes.json()) as Record<string, unknown>;
      assert.equal(rlBody.limited, false);
      assert.equal(rlBody.status, "allowed_warning");
      assert.equal(rlBody.utilization, 0.99);
      assert.equal(rlBody.resetsAt, futureSec * 1000);

      // /health carries a compact counter too
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      const healthBody = (await healthRes.json()) as {
        rateLimit?: { limited?: boolean; utilization?: number };
      };
      assert.equal(healthBody.rateLimit?.limited, false);
      assert.equal(healthBody.rateLimit?.utilization, 0.99);

      // Regression: an "allowed" event that omits utilization (the SDK does
      // this on plenty of events) must NOT resurrect the previous window's
      // stale 99% — the store drops utilization and no warning note fires.
      const staleResetSec = futureSec + 3600; // new window
      const staleState = recordRateLimitInfo({
        status: "allowed",
        resetsAt: staleResetSec,
        rateLimitType: "five_hour",
        // utilization deliberately absent
      });
      assert.equal(
        staleState!.utilization,
        undefined,
        "stale utilization must be cleared by an allowed event",
      );
      __resetRateLimitNoteDedupe();
      assert.equal(
        maybeRateLimitNote(staleState, {
          status: "allowed",
          resetsAt: staleResetSec,
          rateLimitType: "five_hour",
        }),
        null,
        "no warning note for an allowed event without fresh utilization",
      );
      // Fresh utilization the event itself reports still surfaces.
      const freshWarn = maybeRateLimitNote(staleState, {
        status: "allowed_warning",
        resetsAt: staleResetSec,
        rateLimitType: "five_hour",
        utilization: 0.95,
      });
      assert.ok(freshWarn && /95%/.test(freshWarn), "fresh warning noted");
      __resetRateLimitNoteDedupe();

      // Proxy + mock SDK: successful turn streams text, note, usage — and the
      // todowrite alias + plan-persistence prompt reach the query starter.
      __resetRateLimitNoteDedupe();
      let seenParams: Record<string, unknown> | null = null;
      setClaudeQueryStarter(async (params) => {
        seenParams = params as unknown as Record<string, unknown>;
        const events = [
          { type: "system", subtype: "init", session_id: "mock-sess-1" },
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed_warning",
              resetsAt: futureSec,
              rateLimitType: "five_hour",
              utilization: 0.99,
            },
          },
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed_warning",
              resetsAt: futureSec,
              rateLimitType: "five_hour",
              utilization: 0.99,
            },
          },
          {
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed",
              resetsAt: futureSec,
              rateLimitType: "five_hour",
              // utilization deliberately absent — stale 0.99 must NOT
              // produce a second bogus "99% of window used" note
            },
          },
          {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "MOCK_OK" },
            },
          },
          {
            type: "result",
            is_error: false,
            total_cost_usd: 0.001,
            usage: { input_tokens: 11, output_tokens: 3 },
          },
        ];
        return {
          stream: (async function* () {
            for (const ev of events) yield ev;
          })(),
          interrupt: async () => {},
          close: () => {},
          getPid: () => null,
        };
      });

      const okRes = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": "smoke-mock-ok",
          "x-opencode-claude-directory": "/data/projects/infra",
        },
        body: JSON.stringify({
          model: "sonnet",
          stream: false,
          tools: [
            {
              type: "function",
              function: {
                name: "todowrite",
                description: "Write the todo list",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
          messages: [{ role: "user", content: "plan something" }],
        }),
      });
      assert.equal(okRes.status, 200);
      const okJson = (await okRes.json()) as {
        choices?: Array<{ message?: Record<string, unknown> }>;
        usage?: { prompt_tokens?: number };
      };
      const okMsg = okJson.choices?.[0]?.message ?? {};
      assert.match(String(okMsg.content ?? ""), /MOCK_OK/);
      // rate-limit note surfaced once (two identical warning events → one
      // note; the trailing "allowed" event without utilization must NOT add
      // a stale-utilization note — regression for the 99%-after-reset bug)
      const okReasoning = String(okMsg.reasoning_content ?? "");
      assert.equal(okReasoning.match(/\[rate-limit\]/g)?.length ?? 0, 1);
      assert.match(okReasoning, /99%/);
      assert.equal(okJson.usage?.prompt_tokens, 11);

      // Query starter received the todo alias + plan-persistence append
      assert.ok(seenParams, "query starter params captured");
      assert.equal(seenParams.cwd, "/data/projects/infra");
      const aliases = (seenParams as { toolAliases?: Record<string, string> })
        .toolAliases;
      assert.equal(aliases?.TodoWrite, "mcp__opencode__todowrite");
      assert.equal(aliases?.todowrite, "mcp__opencode__todowrite");
      const sysPrompt = seenParams.systemPrompt as { append?: string };
      assert.match(sysPrompt.append ?? "", /mcp__opencode__todowrite/);
      assert.match(sysPrompt.append ?? "", /[Bb]atch independent tool calls/);

      // Proxy + mock SDK: hard limit error BEFORE any content — the proxy
      // must answer with a truthful HTTP 429 (not a fake-200 error stream),
      // flip the store to limited, and fail fast on the next request.
      setClaudeQueryStarter(async () => {
        const limitText =
          "You've hit your session limit · resets 1:10am (Europe/Kyiv)";
        return {
          stream: (async function* () {
            yield { type: "system", subtype: "init", session_id: "mock-sess-2" };
            yield {
              type: "result",
              is_error: true,
              result: limitText,
              total_cost_usd: 0.0005,
              usage: { input_tokens: 7, output_tokens: 1 },
            };
            throw new Error(
              `Claude Code returned an error result: ${limitText}`,
            );
          })(),
          interrupt: async () => {},
          close: () => {},
          getPid: () => null,
        };
      });

      const errRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-mock-err",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      assert.equal(errRes.status, 429, "hard limit must fail fast with 429");
      assert.ok(errRes.headers.get("retry-after"), "429 carries Retry-After");
      const errJson = (await errRes.json()) as {
        error?: { type?: string; message?: string; code?: string };
      };
      assert.equal(errJson.error?.type, "rate_limit_error");
      assert.equal(errJson.error?.code, "claude_session_limit");
      assert.match(errJson.error?.message ?? "", /session limit/);
      assert.match(errJson.error?.message ?? "", /limit resets in/);

      // Same death on the non-streaming path → same 429, not a fake-200.
      const errRes2 = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-mock-err2",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: false,
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      assert.equal(errRes2.status, 429, "non-stream hard limit also 429");

      const snap = getRateLimitSnapshot();
      assert.equal(snap.limited, true);
      assert.ok(
        snap.resetInSeconds !== undefined && snap.resetInSeconds > 0,
        "expected a countdown while limited",
      );

      const gate = rateLimitGate();
      assert.equal(gate.blocked, true);
      if (gate.blocked) assert.ok(gate.retryAfterSeconds > 0);

      // Fast-fail: new main turns get HTTP 429 + Retry-After + reset headers
      const blockedRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-mock-blocked",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: false,
            messages: [{ role: "user", content: "hi again" }],
          }),
        },
      );
      assert.equal(blockedRes.status, 429);
      assert.ok(blockedRes.headers.get("retry-after"));
      const blockedJson = (await blockedRes.json()) as {
        error?: { type?: string; message?: string; retry_after?: number };
      };
      assert.equal(blockedJson.error?.type, "rate_limit_error");
      assert.match(blockedJson.error?.message ?? "", /limit resets in/);
      assert.ok((blockedJson.error?.retry_after ?? 0) > 0);

      // Meta requests use Agent SDK too, so a confirmed hard limit gates them.
      const metaRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            stream: false,
            messages: [
              {
                role: "system",
                content:
                  "You are a title generator. Generate a brief title. Output only the title.",
              },
              { role: "user", content: "Explain quicksort" },
            ],
          }),
        },
      );
      assert.equal(metaRes.status, 429);

      // Counter endpoint reports the active limit with countdown
      const limitedRes = await fetch(`http://127.0.0.1:${port}/v1/rate-limit`);
      const limitedBody = (await limitedRes.json()) as {
        limited?: boolean;
        resetInSeconds?: number;
        message?: string;
      };
      assert.equal(limitedBody.limited, true);
      assert.ok((limitedBody.resetInSeconds ?? 0) > 0);
      assert.match(limitedBody.message ?? "", /session limit/);

      // Regression: if the limit is exhausted after the run already produced
      // content/tool work, Claude emits a synthetic assistant API-error event.
      // There is no new user request to trigger the pre-flight gate, so this
      // event itself must activate the timer immediately.
      rmSync(storeFile, { force: true });
      const midRunLimitText =
        "You've hit your session limit · resets 1:10am (Europe/Kyiv)";
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "mock-sess-mid-run" };
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "work completed before limit" },
            },
          };
          yield {
            type: "assistant",
            error: "rate_limit",
            message: {
              role: "assistant",
              content: [{ type: "text", text: midRunLimitText }],
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));

      const midRunRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-mock-mid-run-limit",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: true,
            messages: [{ role: "user", content: "keep working" }],
          }),
        },
      );
      assert.equal(midRunRes.status, 200);
      const midRunBody = await midRunRes.text();
      assert.match(midRunBody, /work completed before limit/);
      assert.match(midRunBody, /claude_session_limit/);
      assert.match(midRunBody, /server_error/);
      assert.doesNotMatch(midRunBody, /\[claude-code error\]/);
      assert.match(midRunBody, /limit resets in/);

      const midRunSnapshot = getRateLimitSnapshot();
      assert.equal(midRunSnapshot.limited, true);
      assert.ok((midRunSnapshot.resetInSeconds ?? 0) > 0);
      const midRunCounter = await fetch(
        `http://127.0.0.1:${port}/v1/rate-limit`,
      );
      const midRunCounterBody = (await midRunCounter.json()) as {
        limited?: boolean;
        resetInSeconds?: number;
      };
      assert.equal(midRunCounterBody.limited, true);
      assert.ok((midRunCounterBody.resetInSeconds ?? 0) > 0);

      // The stream error makes OpenCode retry once; that retry must receive
      // the stored reset as a real 429 + Retry-After, which drives the timer.
      const midRunRetry = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-mock-mid-run-limit",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: true,
            messages: [{ role: "user", content: "keep working" }],
          }),
        },
      );
      assert.equal(midRunRetry.status, 429);
      assert.ok(midRunRetry.headers.get("retry-after"));
      assert.match(await midRunRetry.text(), /limit resets in/);

      // Gate env kill-switch
      process.env.OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL = "0";
      assert.equal(rateLimitGate().blocked, false);
      delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL;
      assert.equal(rateLimitGate().blocked, true);

      // Expired hard block self-heals on read
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        storeFile,
        JSON.stringify({
          limited: true,
          limitedUntil: Date.now() - 1000,
          updatedAt: Date.now() - 60_000,
        }),
      );
      assert.equal(getRateLimitSnapshot().limited, false);
      rmSync(storeFile, { force: true });
    } finally {
      setClaudeQueryStarter(null);
      if (prevStoreEnv === undefined) {
        delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
      } else {
        process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = prevStoreEnv;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ---- History injection through the proxy (mocked Agent SDK) ----
  {
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    const {
      clearForeignSessionId,
      findClaudeSessionFile,
      getForeignSessionId,
      setForeignSessionId,
    } = await import("../src/session-store.ts");
    const { mkdirSync, rmSync, writeFileSync, mkdtempSync } = await import(
      "node:fs"
    );
    const { homedir, tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    // Isolate the rate-limit store: this block mocks healthy turns, so a
    // confirmed limit in the HOST's real store (e.g. the dev machine is
    // actually rate-limited right now) must not gate them into 429s.
    const histTmpDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-hist-"));
    const histPrevStoreEnv = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = joinPath(
      histTmpDir,
      "rate-limit.json",
    );

    const mockTurn = (
      seen: { params: Record<string, unknown> | null },
      sessionId: string | null,
    ) => {
      setClaudeQueryStarter(async (params) => {
        seen.params = params as unknown as Record<string, unknown>;
        return {
          stream: (async function* () {
            if (sessionId) {
              yield { type: "system", subtype: "init", session_id: sessionId };
            }
            yield {
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "MOCK_OK" },
              },
            };
            yield { type: "result", is_error: false, usage: {} };
          })(),
          interrupt: async () => {},
          close: () => {},
          getPid: () => null,
        };
      });
    };

    const postChat = (sessionHeader: string, messages: unknown[]) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": sessionHeader,
        },
        body: JSON.stringify({ model: "sonnet", stream: false, messages }),
      });

    try {
      const historyMessages = [
        { role: "system", content: "internal system prompt" },
        { role: "user", content: "remember the codename AXIOM-9042" },
        { role: "assistant", content: "Codename AXIOM-9042 noted." },
        { role: "user", content: "what is the codename?" },
      ];

      // 1. No stored binding → history injected, no resume attempted
      clearForeignSessionId("smoke-history-fresh");
      const seen1 = { params: null as Record<string, unknown> | null };
      mockTurn(seen1, "mock-sess-fresh");
      const res1 = await postChat("smoke-history-fresh", historyMessages);
      assert.equal(res1.status, 200);
      const res1Json = (await res1.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      assert.match(String(res1Json.choices?.[0]?.message?.content ?? ""), /MOCK_OK/);
      assert.ok(seen1.params, "query starter called");
      assert.equal(seen1.params!.resume, undefined);
      const promptText = String(seen1.params!.prompt ?? "");
      assert.match(promptText, /<conversation_history>/);
      assert.match(promptText, /AXIOM-9042/);
      assert.match(promptText, /Latest user message:\nwhat is the codename\?/);
      assert.doesNotMatch(promptText, /internal system prompt/);
      // turn stored the new foreign session for follow-up resume
      assert.equal(
        getForeignSessionId("smoke-history-fresh"),
        "mock-sess-fresh",
      );

      // 2. Stored binding whose transcript file EXISTS → resume, no injection
      const fakeProjectsDir = joinPath(
        homedir(),
        ".claude",
        "projects",
        "opencode-claude-smoke",
      );
      mkdirSync(fakeProjectsDir, { recursive: true });
      writeFileSync(joinPath(fakeProjectsDir, "mock-sess-live.jsonl"), "{}\n");
      assert.ok(findClaudeSessionFile("mock-sess-live"));
      setForeignSessionId("smoke-history-resume", "mock-sess-live");
      const seen2 = { params: null as Record<string, unknown> | null };
      mockTurn(seen2, "mock-sess-live");
      const res2 = await postChat("smoke-history-resume", historyMessages);
      assert.equal(res2.status, 200);
      await res2.text();
      assert.equal(seen2.params!.resume, "mock-sess-live");
      assert.doesNotMatch(
        String(seen2.params!.prompt ?? ""),
        /<conversation_history>/,
      );
      rmSync(fakeProjectsDir, { recursive: true, force: true });

      // 3. Stored binding with a MISSING transcript file → binding dropped,
      //    history injected instead of a doomed resume
      setForeignSessionId("smoke-history-dead", "mock-sess-gone");
      const seen3 = { params: null as Record<string, unknown> | null };
      mockTurn(seen3, null); // no init event → store not rewritten
      const res3 = await postChat("smoke-history-dead", historyMessages);
      assert.equal(res3.status, 200);
      await res3.text();
      assert.equal(seen3.params!.resume, undefined);
      assert.match(String(seen3.params!.prompt ?? ""), /<conversation_history>/);
      assert.equal(getForeignSessionId("smoke-history-dead"), undefined);

      clearForeignSessionId("smoke-history-fresh");
      clearForeignSessionId("smoke-history-resume");
      clearForeignSessionId("smoke-history-dead");
    } finally {
      setClaudeQueryStarter(null);
      if (histPrevStoreEnv === undefined) {
        delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
      } else {
        process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = histPrevStoreEnv;
      }
      rmSync(histTmpDir, { recursive: true, force: true });
    }
  }

  // ---- Fail-fast taxonomy: dead turns get truthful HTTP statuses ----
  {
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    const { classifyClaudeFailure } = await import("../src/failure.ts");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");

    // Isolate the rate-limit store so this section starts clean.
    const tmpDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-ff-"));
    const prevStoreEnv = process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
    process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = joinPath(
      tmpDir,
      "rate-limit.json",
    );

    const postTurn = (sessionHeader: string, stream: boolean) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": sessionHeader,
        },
        body: JSON.stringify({
          model: "sonnet",
          stream,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    const mockDeath = (text: string) => {
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "ff-sess" };
          yield { type: "result", is_error: true, result: text };
          throw new Error(`Claude Code returned an error result: ${text}`);
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));
    };

    try {
      // Unit: classifier
      assert.equal(
        classifyClaudeFailure(
          "token refresh rejected (HTTP 400): invalid_grant",
        ),
        "auth",
      );
      assert.equal(
        classifyClaudeFailure("Invalid API key · Please run /login"),
        "auth",
      );
      assert.equal(
        classifyClaudeFailure("You've hit your session limit · resets 1:10am"),
        "rate_limit",
      );
      assert.equal(classifyClaudeFailure("boom"), "unknown");

      // Auth death before content → 401 (non-retryable), both modes
      mockDeath("Invalid API key · Please run /login");
      const authStream = await postTurn("ff-auth-stream", true);
      assert.equal(authStream.status, 401);
      const authStreamJson = (await authStream.json()) as {
        error?: { type?: string; code?: string; message?: string };
      };
      assert.equal(authStreamJson.error?.type, "authentication_error");
      assert.equal(authStreamJson.error?.code, "claude_auth");
      assert.match(authStreamJson.error?.message ?? "", /claude auth login/);

      const authBuffered = await postTurn("ff-auth-buffered", false);
      assert.equal(authBuffered.status, 401);
      assert.equal(
        ((await authBuffered.json()) as { error?: { type?: string } }).error
          ?.type,
        "authentication_error",
      );

      // Unknown death before content → 500
      mockDeath("Claude Code process exploded unexpectedly");
      const boomRes = await postTurn("ff-boom", true);
      assert.equal(boomRes.status, 500);
      assert.equal(
        ((await boomRes.json()) as { error?: { type?: string } }).error?.type,
        "server_error",
      );

      // Error AFTER content → still a 200 stream with the inline note once
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "ff-late" };
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "partial answer" },
            },
          };
          yield {
            type: "result",
            is_error: true,
            result: "Claude Code process exploded unexpectedly",
          };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));
      const lateRes = await postTurn("ff-late-content", true);
      assert.equal(lateRes.status, 200);
      const lateBody = await lateRes.text();
      assert.match(lateBody, /partial answer/);
      assert.equal(
        lateBody.match(/\[claude-code error\]/g)?.length ?? 0,
        1,
        "mid-stream error note appears exactly once",
      );
      assert.match(lateBody, /\[DONE\]/);

      // Empty-but-successful turn → legit 200 with empty content
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "ff-empty" };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));
      const emptyRes = await postTurn("ff-empty-ok", true);
      assert.equal(emptyRes.status, 200);
      assert.match(await emptyRes.text(), /\[DONE\]/);

      // First content after Bun's default 10s idleTimeout must not RST.
      // OpenCode surfaces that as retryable "Connection reset by server".
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          await new Promise((r) => setTimeout(r, 11_000));
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "SLOW_OK" },
            },
          };
          yield { type: "result", is_error: false, usage: {} };
        })(),
        interrupt: async () => {},
        close: () => {},
        getPid: () => null,
      }));
      const slowStarted = Date.now();
      const slowRes = await postTurn("ff-slow-first-byte", true);
      assert.equal(
        slowRes.status,
        200,
        "probe longer than Bun's 10s default must not RST the socket",
      );
      const slowBody = await slowRes.text();
      assert.match(slowBody, /SLOW_OK/);
      assert.match(slowBody, /\[DONE\]/);
      assert.ok(
        Date.now() - slowStarted >= 11_000,
        "slow-first-byte test did not actually wait out the default idleTimeout",
      );
    } finally {
      setClaudeQueryStarter(null);
      if (prevStoreEnv === undefined) {
        delete process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE;
      } else {
        process.env.OPENCODE_CLAUDE_RATE_LIMIT_STORE = prevStoreEnv;
      }
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // ---- Turn stall watchdog + client-cancel teardown + CLI resolution cache ----
  {
    const { setClaudeQueryStarter } = await import("../src/proxy.ts");
    const { mkdtempSync, rmSync, writeFileSync, chmodSync, unlinkSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const { resolveClaudeCli, resetClaudeCliResolutionCache } = await import(
      "../src/executable-path.ts"
    );

    const postStream = (sessionHeader: string) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-claude-session": sessionHeader,
        },
        body: JSON.stringify({
          model: "sonnet",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    const prevStallEnv = process.env.OPENCODE_CLAUDE_TURN_STALL_MS;
    process.env.OPENCODE_CLAUDE_TURN_STALL_MS = "2000";
    try {
      // A turn that goes silent after init must fail truthfully (HTTP 500
      // via the pre-content probe), not hold the response open forever.
      let stalledCloseCalled = false;
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield { type: "system", subtype: "init", session_id: "stall-sess" };
          await new Promise(() => {}); // never produces another event
        })(),
        interrupt: async () => {},
        close: () => {
          stalledCloseCalled = true;
        },
        getPid: () => null,
      }));
      const stallStarted = Date.now();
      const stallRes = await postStream("smoke-stall");
      assert.equal(
        stallRes.status,
        500,
        "silent turn must fail with a truthful HTTP error",
      );
      const stallJson = (await stallRes.json()) as {
        error?: { message?: string };
      };
      assert.match(String(stallJson.error?.message ?? ""), /no output/);
      assert.ok(
        Date.now() - stallStarted < 15_000,
        "stall watchdog took too long to fire",
      );
      assert.ok(stalledCloseCalled, "stalled turn must close the CLI handle");

      // Client disconnect mid-turn must tear the turn down (close handle)
      // instead of leaking a live CLI + bridge nobody can resume. The stall
      // watchdog is moved out of the way so only cancel() can do it.
      process.env.OPENCODE_CLAUDE_TURN_STALL_MS = "60000";
      let cancelCloseCalled = false;
      setClaudeQueryStarter(async () => ({
        stream: (async function* () {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "FIRST_CHUNK" },
            },
          };
          await new Promise(() => {}); // turn continues forever
        })(),
        interrupt: async () => {},
        close: () => {
          cancelCloseCalled = true;
        },
        getPid: () => null,
      }));
      const abort = new AbortController();
      const cancelRes = await fetch(
        `http://127.0.0.1:${port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-opencode-claude-session": "smoke-cancel",
          },
          body: JSON.stringify({
            model: "sonnet",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: abort.signal,
        },
      );
      assert.equal(cancelRes.status, 200);
      const reader = cancelRes.body!.getReader();
      const first = await reader.read();
      assert.match(new TextDecoder().decode(first.value), /FIRST_CHUNK/);
      // A real client abort (OpenCode timeout/session stop) destroys the
      // socket — the server-side stream must observe it via cancel().
      abort.abort();
      const cancelDeadline = Date.now() + 5_000;
      while (!cancelCloseCalled && Date.now() < cancelDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        cancelCloseCalled,
        "client cancel must close the orphaned CLI handle",
      );
    } finally {
      setClaudeQueryStarter(null);
      if (prevStallEnv === undefined) {
        delete process.env.OPENCODE_CLAUDE_TURN_STALL_MS;
      } else {
        process.env.OPENCODE_CLAUDE_TURN_STALL_MS = prevStallEnv;
      }
    }

    // CLI resolution is memoized per PATH+HOME: re-probing spawns sync
    // child processes that hard-block the host's event loop on every query.
    const binDir = mkdtempSync(joinPath(tmpdir(), "oc-claude-bin-"));
    try {
      const fakeCli = joinPath(
        binDir,
        process.platform === "win32" ? "claude.cmd" : "claude",
      );
      writeFileSync(
        fakeCli,
        process.platform === "win32"
          ? "@echo off\r\necho 9.9.9-smoke\r\n"
          : "#!/bin/sh\necho 9.9.9-smoke\n",
      );
      chmodSync(fakeCli, 0o755);
      // HOME points at the temp dir so the well-known-location fallback
      // (~/.local/bin/claude on this dev box) cannot mask a negative result.
      const env = { PATH: binDir, HOME: binDir };
      resetClaudeCliResolutionCache();
      const first = resolveClaudeCli(env);
      assert.ok(
        first && /[\\/]claude(?:\.cmd|\.exe|\.bat)?$/i.test(first),
        "fake CLI resolved",
      );
      unlinkSync(fakeCli);
      const second = resolveClaudeCli(env);
      assert.equal(second, first, "resolution must be memoized");
      resetClaudeCliResolutionCache();
      assert.equal(
        resolveClaudeCli(env),
        null,
        "cache reset must re-probe (and negatives stay uncached)",
      );
      resetClaudeCliResolutionCache();
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }

  await stopProxy();

  // TypeScript build
  const build = spawnSync("bun", ["run", "build"], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    console.error(build.stdout);
    console.error(build.stderr);
    throw new Error("build failed");
  }

  console.log("ok — opencode-claude smoke tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
