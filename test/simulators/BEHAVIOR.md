# Simulator behaviour register

The tests of this plugin talk to one OpenCode simulator (`opencode.ts`) and one Claude Code simulator
(`claude-code.ts`); `world.ts` puts the real plugin between them. There is no second simulator, no variant per
branch and no imitation inside a test: a behaviour a test needs is added here, to the simulator, with a row in this
register and a check of the simulator itself (`test/simulators-regression.ts`).

Rules:
- The simulator does what the original does. Special behaviour (a failure, an error, a timeout) is switched on
  explicitly, by a field of the simulator's `state`.
- What runs for free in the real software (no model, no network, no account, no Claude Code process) is not
  simulated: the real code runs. Example: the SDK's `forkSession` copies a transcript file on disk, so main's revert
  goes through the real SDK on the simulator's files; starting a query needs a Claude Code process, so that is
  simulated.
- The originals: OpenCode 2.2.0 (the version OpenChamber 2.5.3 ships; its npm packages `@opencode/core`,
  `@opencode/ai`, `@opencode/plugin`, `@opencode/schema`, `@opencode/codemode` 2.2.0, read in their `dist`: a
  bundled module is named below by its source path, `src/...`, as the bundle's comment names it, e.g. core
  `src/session/compaction.ts` in `dist/chunks/tool-r0yvbzfa.js`), with OpenCode 2.0.32 behind a switch where the two
  differ ("Versions" below); Claude Code 2.1.311-2.1.312 with SDK 0.3.300 (`test/cli-contract-live.ts` on the chain,
  and live probes). A line that still names 2.0.32 alone describes code 2.2.0 left unchanged (compared module by
  module, 30.10.2026).
- Probes: "the <topic> probe" below is the real CLI 2.1.312 started by the real SDK 0.3.300 against a local stub
  of the Messages API, a dummy key, a profile of its own, no subscription, unless the entry says otherwise; a quoted
  name after it is one of its cases. "Live" means the machine's own signed-in CLI and subscription. Numbered probes
  (1, 5–12, 39, 41, 47…) are the live probes of October 2026 (CLI 2.1.29x–2.1.310, mostly Haiku).
- Every tree runs with SDK 0.3.300 (agreed with the user): the trees' `node_modules` are junctions to the main
  clone's, which holds 0.3.300, whatever a tree's `bun.lock` names (main and the preliminary branches name 0.3.224;
  checked from the test process on 29.10.2026). The old 0.3.224 (main's own lock) is checked once before a PR to
  main is published, on a detached checkout of main whose node_modules is a 0.3.224 install. What the two SDKs send differs (0.3.224: `--model <id>` and
  `get_context_usage` with no `detail`; 0.3.300: `--model=<id>`, `detail: "summary"`); the CLI process answers both
  as CLI 2.1.312 does, and checks accept both.

Each entry: what the original does (and where that was read or measured), what the simulator does, the switch for
special behaviour, the tests that rely on it.

## Writing a test

A chat test is a user in OpenCode and what Claude Code then did; examples: `root-permissions-regression.ts` (the
parameters of a query), `overload-regression.ts` (a failed model call and OpenCode's retry),
`parallel-tools-regression.ts` (tool steps), `simulators-regression.ts` (many short scenarios).
- `createWorld(label)` from `simulators/world.ts`, then `world.opencode.startPlugin(options?)`; `world.dispose()` in
  `finally`, `process.exit` at the end.
- The world's folder (`world.tmp`, `opencode-claude-<label>-*`) is made in the folder `OPENCODE_CLAUDE_WORLD_ROOT`
  names (the test system's runs: `opencode-claude-worlds/<tree>`), else in `opencode-claude-worlds/by-hand` beside
  the tests' checkout — never in the system's temp or inside a checkout, where the CLAUDE.md and AGENTS.md of the
  folders above (the user's profile, the clone) would reach the plugin and OpenCode. It stays after the test: when the process exits with code 0 after `dispose`, the folder
  gets a file `passed` with the time; a failed, hung or killed test leaves none, and its folder stays until the user
  removes it. Each new world (not a second process on another world's machine) removes, in its own root only, the
  folders `opencode-claude-*` whose `passed` is over two hours old: every junction and symbolic link inside first,
  one by one and without entering it, each checked gone (a folder whose link stays is left whole), then the folder.
  The test's output says how many it removed ("world: N old passed world(s) removed from <root>"). This is the only
  place a world's folder is removed (the user's word, 30.10.2026).
- The chat through the OpenCode simulator: `newChat`, `say` (attachments: `testPng`), `turn` (tool outputs, a stop),
  `compact`, `fork`, `undoBefore`, `queue` / `deliver`, `title`, `generate`, `generateText`; history the plugin never
  served: `otherModelAnswer`, `between`. OpenCode's own settings: `opencode.state` (tools, model, title model, compaction;
  the agent, Code Mode, MCP servers, skills, instruction files and a host's context, which make its system prompt).
- What Claude Code does: `world.claude.state` (failures, tool steps, replies, usage, thinking, holds) before the turn;
  outside a turn `world.claude.cli.set(...)`.
- What happened: the turn's `requests` (the list after the hooks, the body, the reply with its status, text, finish,
  tool calls, usage, raw body), `opencode.retries`, `claude.queries` (parameters, what the model saw, outcome),
  `claude.records(name)` (the transcript), and the plugin's journal `world.journal()` — every test reads the
  journal.
- The plugin only through `world.plugin` and `pluginModule(name)`: no import of `../src` (the file must run on any
  tree, `OPENCODE_CLAUDE_PLUGIN_DIR`). A fresh instance of one module: `pluginModule(name, { copy: "<any word>" })`
  (its imports stay the first instance's); the whole plugin afresh, as OpenCode loads it for a project folder or
  after a change: `world.build(world.dir, { copy: true })` ("The machine" below).
- Another server, an older release, the next start: "The machine" below (`world.secondProcess`, `world.build`,
  `releaseTree`).
- No query starter, stream or CLI script of the test's own: a behaviour the simulator lacks is added to the
  simulator with a row here (from the original's code or a live probe), never imitated in a test.
- A live test (haiku-live): `createWorld(label, {}, { realClaude: true })` — the OpenCode simulator and the plugin as
  always, the machine's own signed-in Claude Code instead of the Claude Code simulator (its PATH, home and profile
  stay; only the plugin's data is the world's). It spends the subscription: run it on purpose, not in the suite.
  The model and its variant (effort): `opencode.state.modelID`, `opencode.state.variant`.
- A command looked up by the test itself (`Bun.which`) needs the world's PATH passed explicitly: without it Bun
  searches the PATH the process started with and finds the machine's npm, curl or claude.
- A test that fails is either a defect of the test or a finding about the plugin: the test keeps the behaviour it
  stands for, and the finding is written down with the trees it fails on. A case that fails by a finding lives in a
  file of its own, `<topic>-<finding>-regression.ts`, until the finding is fixed; the steps it shares with its topic
  file are in `simulators/turns.ts` (or `fork-world.ts` for the fork tests), not copied.

## OpenCode

### Versions
- Original: OpenCode 2.2.0 and 2.0.32, their npm packages compared module by module (30.10.2026; the list of
  differences and what became of each: `temp/opencode-2.2-report.md` of the branch `test/simulators-opencode-2.2`).
- Simulator: 2.2.0. `opencode.state.version = "2.0.32"` (one setting of the world, before the turn) brings back 2.0.32
  where the plugin's branches may act differently on it: the summary request and the checkpoint (below,
  "Compaction"), the ceiling's 10%, the summary's output cap, the body's `store: false`, the title's prompt and
  variant, a generation not retried, Code Mode tools dropped (not offered directly) with `execute` denied, the
  `session.context` form of a checkpoint, an unknown finish reason, the image bound, warming without the wait while
  a request runs, the `User-Agent` version. No background compaction on 2.0.32. A whole run on 2.0.32, the tests
  unchanged: `OPENCODE_CLAUDE_SIMULATOR_OPENCODE=2.0.32` (the default of `state.version` in every world of the run).
  `state.version = "2.2.1"`: 2.2.0 with 2.2.1's Code Mode section (below, "The system prompt"); nothing else of
  2.2.1 is simulated.
- Tests: `simulators-regression` ("OpenCode 2.2.0 and the 2.0.32 switch"), `code-mode-catalog` ("OpenCode 2.2.1's
  heading").

### The list the hooks get
- Original: core 2.2.0 `src/session/runner/to-llm-message.ts` (dist/chunks/tool-edkh5za3.js). A checkpoint carries its
  metadata: in 2.2.0 `keepID` and the kept tail as `recent` (loaded by `src/session/history.ts` withRecentText). Content is always parts. A user message: skill texts, its text unless empty,
  its attachments (`text/plain` inlined as "Attached file: <name>" and the content; an image or PDF as "Attached
  file: <path>" for a file from disk, then a `media` part), metadata. An answer: `text`, `reasoning`, `tool-call`;
  then one `tool` message per result (`text` for one text, `content` with files, `error`). Synthetic, shell, skill,
  location and compaction messages as their own user texts; a later instruction update as a `system` message.
- Simulator: `toList`.
- Tests: every chat test.

### Hooks of a request
- Original: `session/prompt.ts` (the `prompt` hook when a message is accepted), `session/model-request.ts` (`context`
  for a turn, `compaction` for a summary, then `model.request` with the request's kind, address and headers).
- Simulator: `accept`, `request`. A plugin that registers no hook (main) gets none called.
- Tests: every chat test.

### A message accepted: the prompt hook and attachments
- Original: `session/prompt.ts` 40–220: the `prompt` hook gets `{ sessionID, messageID, prompt: { text, files,
  agents, skills }, metadata, delivery }` once, when the message is accepted; the message is built from what the hook
  left (text, files, metadata, delivery). A file is a data URL or a `file://` URI; its bytes at most 20 MiB (else the
  message is refused); its type detected from the bytes (`mime.ts`: PNG, JPEG, GIF, BMP, PDF, WebP, AVIF, else
  `text/plain` or `application/octet-stream`), a declared type is not used; an image over 2000 × 2000 pixels or 5 MiB
  of base64 is resized (`image.ts`). In the list: `text/plain` inlined, an image or PDF as media (with "Attached
  file: <path>" for a file from disk), other types dropped.
- The metadata the client sent with the prompt (`Input.metadata`, 20–51) goes to the hook as a copy; the message
  keeps the hook's `metadata`. Simulator: `say` / `queue` with `{ metadata }`.
- Simulator: `accept`, `materialize`, `detectMime`; `testPng(label, width, height)` makes real PNGs for tests.
  The simulator has no resizer: an image OpenCode would resize is refused with an error naming it, not passed on.
- Switch: `state.foreignPromptHook` — another plugin's `prompt` hook after the plugin's own.
- Tests: `simulators-regression` (attachments as OpenCode takes them; an image reaches Claude), issue cases.

### What the request takes from the hooks
- Original: core 2.2.0 `src/session/model-request.ts` (dist/chunks/tool-f68rfrfr.js): the event `{ sessionID, model,
  system, messages, options, agent, tools }`; `options` starts as `{ maxTokens: outputLimit(...) }` for a turn and a
  summary (the catalog's output limit, at most 256 000, fitted to the room the prompt leaves; 2.0.32 also capped a
  summary's at 32 000); the headers name `User-Agent: opencode/<version>`; the request takes `system`, `messages`
  and `options` as the hooks left them: generation keys (`maxTokens`, `temperature`, `topP`, `topK`,
  `frequencyPenalty`, `presencePenalty`, `seed`, `stop`) become the body's fields where OpenAI Chat has them
  (`openai-chat.js` 663–671; no `top_k`), other keys are provider options; a tool the hook kept (by identity, even
  renamed) or under a real tool's name stays, a tool the hook invented is dropped.
- Simulator: `request`, `outputLimit`, `generationOf`, `toolsAfterHooks`, `requestBody`.
- Switch: `state.foreignHook` — another plugin's hook after the plugin's own, changing any field.
- Tests: `simulators-regression` (the body is what the hooks left), fork-monkey (a hook that rewrites the list).

### The system prompt
- Original: core 2.0.32. The parts before any hook (`session/model-request.ts` `baseTranscript`, instance-s3v8c45g.js
  81–91): the agent's own prompt, else the stock one (`session/runner/prompt/system.txt` with the guidance of the
  `shell`, `write`, `edit` tools the request offers, `session/system-prompt.ts`), then the instructions. The
  instructions (`session/context.ts` `select`, instance-egzk2yjk.js 155–175), each section once it has something to
  say, joined by a blank line (`instructions/index.ts` `render`): the Code Mode catalog (`codemode/instructions.ts`:
  complete, or partial with the `search` function's signature, or the note that no Code Mode tool is there; listings
  from `codemode/catalog.ts` `summarize` — namespaces sorted, a tool's first description line cut at 120, the cheapest
  listings first within an inline budget of 2000 tokens of 4 characters, pinned ones always; signatures by
  `@opencode/codemode` 2.0.32 from the tools' JSON Schemas), the MCP servers' instructions (`mcp/instructions.ts`: a
  server with a tool the agent may use, a Code Mode one only while `execute` is allowed; sorted; the line naming its
  namespace for `execute`), the project references (`reference/instructions.ts`), the skills (`skill/instructions.ts`:
  a skill with a description, sorted by id; none — no section, since an empty list counts as removed, so the
  renderer's "No skills are currently available." line is never rendered by 2.0.32), the instruction files (below), the date
  ("Today's date: " + `toDateString()`), the environment (`instructions/builtins.ts`: working directory, the project's
  folder, git, platform, OpenCode's temp folder `<tmpdir>/opencode`), a host's context entries (`<context key>`, sorted
  by key). Observed at the session's first request and kept; a change comes later as an update message
  (instruction-state.ts); a compaction starts a new epoch.
  Then OpenCode's own plugins, before any other (`plugin/internal.ts` `pre`): `opencode.prompt.anthropic` appends
  "# Code comments…" to the stock prompt of a model whose id holds "claude" (not to an agent's own prompt;
  `plugin/optimize.ts`), `opencode.prompt.identity` puts "# Your Model" (name, provider, model id) second
  (`plugin/identity.ts`), `opencode.tools` adds the worktree note at the end; on a turn, a summary and a generation,
  not on a title (its agent's prompt alone). The parts go to the body joined by "\n" ("The HTTP body"). A tool
  request's tools (`tool/registry` snapshot): the direct ones by name (an MCP server's with `codemode: false`, the
  `skill` tool), then `execute`.
- The instruction files (`config/plugin/instruction.ts`, instance-4hxt5e23.js): the global AGENTS.md of OpenCode's
  configuration folder (`OPENCODE_CONFIG_DIR`, else `XDG_CONFIG_HOME` or `~/.config`, then `opencode`), the project's
  AGENTS.md from the directory up to the project's folder (the work tree of the nearest `.git`, else the directory;
  the home folder instead when the directory is inside it), nearest first, then the configuration's `instructions` —
  an absolute path or pattern in its own folder, a relative one in every folder from the directory up to the
  project's, the matches sorted; a file once, where it first came; "Instructions from: <resolved path>\n<content as
  read>" (`instruction-discovery.ts` `render`). No CLAUDE.md or CONTEXT.md fallback in 2.0.32.
- OpenCode's own tools, there with no MCP server, no skill and no plugin of the user's: the `skill` tool
  (`tool/plugin/skill.ts`; no skill listed, so no skills section) and `execute` with the `opencode` namespace —
  `session_rename`, `session_move`, `worktree_create`, `worktree_list`, `worktree_remove`, `models`
  (`tool/plugin/opencode.ts`, instance-ngdgjn5a.js) and `list_mcp_resources`, `read_mcp_resource`
  (`tool/plugin/mcp-resource.ts`, instance-wndqf9wb.js), all registered unconditionally; `session_move` and the three
  worktree tools pinned. The catalog of these eight is complete and is the one OpenCode 2.0.32 lists in
  its live system prompt on this machine, signature by signature. The browser plugin's `browser` namespace
  (`@opencode/plugin-browser`, a `post` plugin) is not in that live prompt and not in the default.
- Simulator: `stockPrompt`, `modelIdentity`, `codeModeInstructions`, `codeModeSignature` (the package's
  `renderSchema` for JSON Schemas; checked against `@opencode/codemode` 2.0.32 itself: the package's `Tool.make`
  renders the same signatures),
  `SEARCH_SIGNATURE`, `mcpInstructionsBlock`, `skillsInstructions`, `instructionFiles`, `environmentBlock`,
  `contextBlock`, `OPENCODE_NAMESPACE`, `OPENCODE_TOOLS` (their Effect schemas as JSON Schemas), `openCodeCodeMode`; in
  the host `offeredTools`, `instructionsOf` (kept on the session, cleared by a compaction), `baseSystem`,
  `builtInHooks`, `systemOf` (a turn's system parts before the plugin's hook).
- Switches: `state.agent` (`{ name, system? }`), `state.codeMode` (`{ namespaces?, tools? }`, the Code Mode tools
  besides the MCP servers'; default `openCodeCodeMode()`; set: another set in place of OpenCode's own; unset: `execute`
  denied, as an agent's permission does), `state.mcpServers`, `state.skills` (default `[]`; unset: the skill tool
  denied), `state.instructions`, `state.contextEntries`; the world's home holds OpenCode's configuration folder
  (`openCodeConfigDir`).
- `execute` denied (`state.codeMode` unset), 2.2.0: the Code Mode tools are offered directly, OpenCode's own
  `opencode_<name>` and an MCP server's `<server>_<name>`, and a Code Mode server's instructions show as a direct
  server's (core 2.2.0 `src/tool.ts` snapshot, dist/chunks/tool-94as0g8p.js; `src/mcp/instructions.ts`,
  tool-dwxkhmt2.js); 2.0.32 offered none of them and left those instructions out. The Code Mode catalog
  (`src/codemode/instructions.ts`, tool-14kcwm24.js) is the same in 2.2.0 and 2.0.32: "# Code Mode", "## Available
  tools". 2.2.1 rewords the opening ("The tools listed below[, and `search`,] cannot be called directly: …") and
  renames the heading "## Code Mode tools (call only inside `execute`)"; its catalog lines are 2.2.0's (the tag
  v2.2.1's `packages/core/src/codemode/instructions.ts` and `catalog.ts`, read on GitHub 30.10.2026):
  `codeModeInstructions(…, "2.2.1")`, `state.version = "2.2.1"`.
- Not yet as the original: the update messages when the setup changes within a session (a test adds them with
  `between(chat, "system", text)`; 2.2.0 words a changed MCP server, skill or reference as its own list - "The
  following ... have changed" - where 2.0.32 repeated the whole list); project references; configured instructions by URL; the per-file instructions
  OpenCode adds as a synthetic message when a tool reads a file in a folder with its own AGENTS.md
  (`session/instructions.ts`); the model-specific prompts of other providers (gpt, kimi, trinity, muse) — no model of
  the plugin's catalog gets them; a hook of OpenCode's own that fails (the identity part then missing).
- Tests: `simulators-regression` (OpenCode 2.0.32's own tools by default; the system prompt as OpenCode 2.0.32 builds
  it; the instruction files OpenCode 2.0.32 loads), code-mode-catalog, instruction-files,
  instruction-files-mcp-without-execute (a Code Mode server's instructions with `execute` denied), session-context,
  smoke, every chat test.

### A page in the user's browser (the world)
- Original: the Fetch standard (fetch.spec.whatwg.org): a page's request names the host it addressed in `Host`;
  `Origin` is sent on a cross-origin `cors` request and on any request but GET and HEAD; a cross-origin request
  that is not CORS-safelisted (method other than GET, HEAD, POST, or a `Content-Type` other than text/plain, a form's)
  is preceded by an `OPTIONS` preflight and sent only if the answer allows it; a `no-cors` request must be safelisted.
  DNS rebinding: the attacker's name resolves to 127.0.0.1, the page calls it same-origin, `Host` is that name.
- World: `world.fromBrowser({ page, path, method, contentType, body, mode, rebound })` writes those requests to the
  proxy over a plain socket; returns whether it was sent, the statuses, and the heads written.
- Not modelled: cookies, `Referer`, a referrer policy that makes `Origin` "null", redirects; the proxy listens on
  127.0.0.1 only, so a client that names `[::1]` never reaches it.
- Tests: `simulators-regression` (a page in the browser calls the proxy as the Fetch standard has it), smoke.

### Media limits after the hooks
- Original: core 2.2.0 `src/session/model-request.ts` `unsupportedParts`, `boundImages`: the images counted in order;
  whenever the running total passes 25 MiB the oldest become a note until 15 MiB are left (2.0.32: the oldest until
  the whole total was 15 MiB).
- Simulator: `unsupportedParts`, `boundImages`.
- Tests: `simulators-regression` (boundImages), list-images-bound.

### The HTTP body
- Original: `@opencode/ai` 2.2.0 `dist/protocols/openai-chat.js` `lowerMessages`, `fromRequest`: system parts joined
  by "\n"; a text-only user message one string joined without a separator; a tool step's files as one user message
  before the next non-tool message (a tool's image never goes as text: its text parts in the `tool` message, the image
  as `image_url` after it - in 2.2.0 and 2.0.32 alike); a later system message as escaped `<system-update>` text;
  `stream: true`, `stream_options`, `max_completion_tokens`; no `store` (2.2.0 sends it to OpenAI and Azure alone,
  `detectSupportsStore`; 2.0.32 sent `store: false`).
- Media (`openai-chat.js` lowerMedia 237–251, `shared.js` toolFileMedia 165–173): a tool's file is base64, a data URL
  (its declared type gives way to the file's `mime`) or an http(s) URL; an image goes as `image_url` (a URL as it is),
  a PDF inline as `file`; a PDF by URL or any other type cannot be built — the request fails before HTTP as an invalid
  request, not retried.
- Simulator: `lowerMessages`, `lowerMedia`, `LoweringError`, `requestBody`.
- Tests: `simulators-regression` (lowering: separator, tool files, media sources), every chat test.

### Reading the answer; a stop or a broken stream
- Original: the event stream is read as it arrives and each part published at once (`instance-dy6575tn.js` 84–100);
  when the stream breaks or the user stops it after the answer started, what was shown stays on the message with the
  error (interrupted, or the stream's error), and the next request carries it; its reasoning then goes as text
  (`to-llm-message.ts` 153–232). A stop before anything arrived keeps nothing. A stop is not a broken stream: the turn
  ends. A stream that broke (a stream error, an incomplete stream, a chunk timeout) once the answer had started, with
  no tool call in it, and a retryable failure: the shown part stays with its error, then a synthetic user message
  "The previous response was interrupted. Continue from where you left off without repeating completed content."
  (a plain user message, instance-xt4njr3s.js 232–233) and the request again (`Outcome.Continue`, instance-dy6575tn.js
  137–206, instance-71svxegq.js 111, 302–309), within the step's 10 / 3 limits (below).
- A stop, in order (read in OpenCode 2.0.32's code on 30.10.2026): `session.interrupt` interrupts the turn's fiber
  (run-coordinator.ts, instance-yp2x3t23.js 59–72); the response stream's finalizer aborts the HTTP request at once
  (effect 4.0.1 http/HttpClient.js 835–841); then the step settles — the shown part stays, the step fails as
  interrupted, a snapshot is captured in a git project (git, instance-94t3kz80.js 87–101; none elsewhere)
  (instance-dy6575tn.js 101–186); only when the turn's fiber has exited is `session.execution.interrupted` published
  (session/execution.ts settled, instance-a2pz59r9.js 89–99). The plugin hears the abort (its response's `cancel`)
  and the event asynchronously, so either may reach it first. The simulator publishes the event as soon as the read
  ended.
- An answer that ends with finish `length` (instance-dy6575tn.js 198–200, Outcome.OutputLimit) is no failure: it stays
  as it is with finish `length`; when it and the two messages before it (the session's latest user and assistant
  messages, synthetic ones not counted) are all such answers the step fails, type `output-limit`, "Response still
  truncated after two output token limit continuations" (instance-71svxegq.js 311–321) — so the third cut answer in a
  row ends the turn; else a cut tool step goes on with its results, and a cut answer gets a synthetic user message
  "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself.
  Break the remaining work into smaller pieces." (CONTINUE_AFTER_OUTPUT_LIMIT, 112, 322–325) and the request again —
  no retry, no wait.
- What the screen shows while the answer streams: `opencode.shown(chat)` (the text of the chat's latest turn request so
  far); a test stops a turn by it, not after a wait.
- Simulator: `readReply` (reads the stream piece by piece, `streamError`), `outputStarted`, `turn` (`keepShown`, the
  synthetic message `CONTINUE_AFTER_INTERRUPTION`; a cut answer: `CONTINUE_AFTER_OUTPUT_LIMIT`, `outputLimitExhausted`,
  `OUTPUT_LIMIT_EXHAUSTED` — the failure's kind `unknown`), `toList` (parts in stream order, reasoning first; an answer
  with `error` gives its reasoning as text; the answer's metadata).
- The plugin answers Claude's `max_tokens` as `stop` on every tree so far (finish-reason-regression's finding): the
  turn's continuation runs only once a tree answers `length`; until then its rule is checked on built messages.
- Tests: `simulators-regression` (text, stop, next turn; text, stop, fork; a chunk timeout mid-answer continued; an
  answer cut at the output limit: the rule, and a turn on Claude's `max_tokens`), every chat test.

### A failed request: its kind and the retry
- Original: `@opencode/ai` 2.2.0 `dist/provider-error.js` (`classifyProviderFailure`, `isRetryable`; 2.2.0 adds
  overflow and policy phrases, AWS error types, a throttling exclusion, and a quota failure's retry-after),
  `route/executor.js` (message of the body, `retry-after-ms` / `retry-after`, rounded up to whole ms),
  `protocols/openai-chat.js` (a failure chunk in the stream; `finish_reason` `error`, `network_error`; an unknown one
  becomes finish `unknown` and core's `src/session/runner/step.ts` fails the step as an incomplete stream, "The provider
  response ended with an unknown finish reason." - 2.0.32: an unknown provider error "Provider finish_reason: <x>";
  the first finish reason stays; a stream with no `finish_reason` is incomplete); core 2.2.0 `src/model-retry.ts`
  (dist/chunks/tool-wnhgecwx.js; the policy moved there from `runner/retry.ts`, unchanged): retryable kinds are rate limit, provider internal, transport, incomplete stream, unknown;
  `x-should-retry` overrides; context overflow is not retried (compaction handles it); at most 10 retries, waits 2, 4,
  8, then 10 s, a provider's retry-after (at most 15 min) as the floor, with jitter; the `retry` hook may change the
  decision; `session.retry.scheduled`; a request whose answer had not started is sent again, one whose answer had
  started is continued (above, "Reading the answer").
- Timeouts (read in OpenCode 2.0.32's code on 29.10.2026): the headers
  within 300 s, each chunk of the stream within 900 s of the one before, the whole request unbounded (`@opencode/ai`
  schema/options.js 38–55, route/transport/http.js 58–81); a timeout aborts the request and is a retryable transport
  failure with code "Timeout" ("Timed out waiting for response headers" / "… response data"), retried as the others,
  but at most three of a step's retries may follow a timeout — the 4th timeout of a step fails the turn
  (runner/retry.ts 26–56, MAX_TIMEOUT_RETRIES); the step's total stays 10. The plugin's provider goes through this
  route. It matters: the CLI's own retries of a 429, 529 or 401 take about 3 minutes before the plugin can answer the
  headers (the plugin sends them with the answer's first event).
- Simulator: `classifyFailure` and its tables (the regular expressions verbatim, checked by script), `failureOf`,
  `retryDelay`, `isRetryableFailure`, `retryAfterMs`, `turn` (`scheduleRetry`, `mayRetry`), `retries`;
  `sendRequest` (the header timer), `readReply` (the chunk timer), `TransportTimeout`, `timeoutFailure` (a failure's
  `code: "Timeout"`); a compaction keeps the same three-timeout cap.
- Switches: `state.sleep` — OpenCode's clock for the waits; by default no real wait. `state.headerTimeoutMs` (default
  300 000), `state.chunkTimeoutMs` (default 900 000) — tests set short values to provoke a timeout. The timers run on
  the real clock, and only while the event loop is idle: the plugin answering in the same process can starve a very
  short one, so a test holds Claude (`claude.state.hold` keeps the headers back, `holdMidAnswer` stalls the stream).
- Not needed: the random factor of the waits (0.8 to 1.2 of min(2 s·2^(n−1), 10 s), runner/retry.ts 18–31) — the
  simulator waits only through `state.sleep`, no test reads a wait, and a random wait would make the tests' timing
  random.
- Tests: `simulators-regression` (failures: kind and retry decision; no headers in time: retried, the 4th timeout
  fails; a chunk timeout mid-answer continued), api-retry, overload.

### Compaction
- Original: core 2.2.0 `src/session/compaction.ts` (dist/chunks/tool-r0yvbzfa.js), `src/session/recent-text.ts`
  (tool-v2r1d0zg.js), `src/session/history.ts` (tool-88degkwg.js) and `src/session/runner/llm.ts` (tool-g2pxrbdf.js):
  before every request of a step `compact({ reason: "auto" })` - due when the measured context (the latest answer's
  tokens of this provider) plus an estimate of what came since (4 characters a token, 1500 an image, 2000 a PDF)
  reaches the ceiling (the window minus 15%, at least 16 000; `compaction.buffer` when below the window); a request
  refused as too long before its answer started - `compact({ reason: "overflow" })` aiming at 85% of the context,
  then the step again, once. `session.compaction.started` (not manual; `{ sessionID, reason }`) comes first, before any
  hook. The whole conversation goes to the `compaction` hook; a hook may answer itself (`event.result`, no request).
  The request reuses the hooks' list with the summary prompt (`buildPrompt`, first or update) added after it while the
  measured prompt fits the room a summary may take (`summaryRoom`: the window minus the smaller of 16 000 and the
  output limit); else the older part alone (`withoutTail`: the hooks' list up to the first kept message, found by its
  id); else the request as text, no tools, its exchanges losing detail oldest first, level by level (outputs clipped
  to 1000 + 1000 characters, outputs removed, the user's words alone, left out; `flattenAndDropOldest`). The output
  limit fitted (`fitOutput`, at least 32 000 where the window allows); a reply without the template's headings gets
  one reminder; a 413 on the list or the older part - the request as text; an overflow - shrunk to 85/70/50/35%;
  other failures retried like a turn; `length`, a content filter, a second reply without the template - failed. The
  checkpoint keeps the first kept message's id (`metadata.keepID`, the newest messages within 15 000 tokens cut at a
  user message); OpenCode reads the tail from it each time it loads the chat (`withRecentText`: `messageToText` of
  the messages from it to the checkpoint, reasoning left out, into `metadata.recent`), and the checkpoint's text
  carries it as `<recent-context>`. `session.compaction.ended` (`text`, no `recent`), or `session.compaction.failed`.
- 2.0.32 (`state.version`): the older part alone to the hook, `session.compaction.started` after the hooks with
  `recent`, the tail stored on the checkpoint (`recent`, reasoning included), the request as text dropping whole
  exchanges (tool outputs cut at 1250 characters), shrink 70/50/35%, the summary's output at most 32 000, the ceiling
  10% below the window.
- Simulator: `compact`, `summarize` (2.2.0), `summarizeLegacy` (2.0.32), `splitConversation` (`keepID`),
  `recentFrom`, `messageToText`, `buildSummaryPrompt`, `SUMMARY_NUDGE`, `flattenToFit` (2.2.0),
  `flattenAndDropOldest` (2.0.32), `estimatePrompt`, `measuredPrompt`, `calculateCeiling`; `turn` (auto, overflow);
  prompts compared with the package's own text (the template and prompts are the same in 2.2.0 and 2.0.32).
- Switches: `state.version`, `state.autoCompaction`, `state.compactionBuffer`, `state.compactionElsewhere` (the
  compaction agent on another provider's model: no request or hook of the plugin's, the same checkpoint and events);
  Claude Code `state.summaryReplies`, `state.summaryFailures`. `compactElsewhere(chat)` writes such a checkpoint
  without the events (not as the original; kept for the chain's tests).
- A skill message in the summary's text: "[Skill activated: <name>]" and its text (recent-text.ts messageToText);
  `between(chat, "skill", text, { skillName })`.
- Not needed: native (provider) compaction - only with `compaction: { type: "native" }` on a route that can (OpenAI
  Responses, Azure, xAI); the OpenAI-compatible chat route of the plugin's provider has none.
- Not yet as the original: `measuredPrompt` also requires the latest measured answer's model, variant and agent to
  be the session's (the simulator's answers carry no model; an answer of another provider is never measured); the
  instructions' epoch check of a held background summary (`heldIndex` compares `initial`).
- Tests: `simulators-regression` (compaction: prompt and tail; reminder and failure; hook result; auto compaction;
  prompt too long; compaction after a 413; "OpenCode 2.2.0 and the 2.0.32 switch"), compaction-resume, issue cases.

### Background compaction
- Original: core 2.2.0 `src/session/compaction.ts` `precompute`, `usePrecomputed`; `src/session/runner/llm.ts` (at a
  step's start when no compaction is due, and after a turn that needs no continuation); on with
  `experimental.background_compaction: true` (`src/config/plugin/compaction.ts`, dist/chunks/tool-x75vegnr.js). When
  the context is at 85% of the ceiling or more but not due, and the latest measured answer of this model has 64 000
  prompt tokens or more, OpenCode writes a summary of the messages before that answer in the background (the
  `compaction` hook and `model.request` kind `compaction` as any summary, no `session.compaction.*` event) while the
  chat goes on - the turn's next request, a parked tool step's results included, goes out beside it. A held summary
  stays while its tail (from that answer) is within min(max(2 x 15 000, 30 000), 25% of the budget); a failed one is
  tried again up to twice for the same answer; a newer one replaces it (the old request aborted). When the compaction
  is due, a held one whose tail still fits is swapped in (no summary request then), its `keepID` the answer it
  stopped before; else the usual summary. Not in 2.0.32.
- Simulator: `precompute` (called by `turn` where OpenCode calls it), `backgroundSummaries` (each: chat, `keepID`,
  its requests, the summary's promise), `compact` (the swap), `stopBackground` (world.dispose).
- Switch: `state.backgroundCompaction` (default off, as OpenCode's).
- Tests: `simulators-regression` ("background compaction (2.2.0)"), `compaction-live-turn` (the summary meets the
  chat's turn live: the continuation's model call held by Claude Code's `stallBeforeStop`).

### Cache warming
- Original: core 2.2.0 `src/plugin/warming.ts` (dist/chunks/tool-7tjh76vn.js), one of OpenCode's own plugins, run
  before the user's (`src/plugin/internal.ts` `pre`), on with the `warming` setting (`true`, or `{ prompt, interval,
  duration }`; defaults: "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly:
  OK", 4 minutes, 30 minutes). Its `context`, `compaction` and `generate` hooks (a root session only) schedule the
  chat: pinged when idle `interval` since its latest request, until `duration` after it; a request whose last message
  is the prompt alone (a ping) does not reschedule. A ping is `session.generate` with the prompt: the chat's messages
  and the prompt as a user message, kind `generate` (below). 2.2.0 holds a ping while the chat's own request runs
  (from its `context` hook to `session.step.streamed` / `.failed` or the execution's end, which also restart the idle
  time); 2.0.32 did not.
- Simulator: `warming` (the hooks inside `prepareRequest`, the end of a turn's request in `request`), its pings in
  `opencode.warming.pings`, one ping now `opencode.warming.ping(chat)`; timers on the real clock (`unref`), stopped by
  `stopBackground`.
- Switch: `state.warming` (`true` or `{ prompt?, interval?, duration? }` in ms; default unset, as OpenCode's).
- Not yet as the original: the timers do not follow `state.sleep`.
- Tests: `simulators-regression` ("cache warming"), `cache-warming`.

### A title, a generation
- Original: core 2.2.0 `src/session/title.ts` (dist/chunks/tool-m89ew3ks.js; the title agent's prompt `PROMPT_TITLE`,
  the first user message wrapped as "Here is the first message of the conversation:\n\n<message>\n<text>\n</message>\n\n
  Reply with only the title." - 2.0.32 sent it as it is -, later the original request and the recent conversation
  wrapped as `<conversation>`, the `title` hook with the draft alone, `model.request` kind `title`, the
  answer's first non-blank line, at most 100 characters, `session.renamed`; a failure keeps the title);
  `src/session/generate.ts` (dist/chunks/tool-d9hg8633.js; the chat's messages and the prompt as a user message, the
  `generate` hook with agent and tools, `model.request` kind `generate`, the chat unchanged; 2.2.0 sends a failed one
  again by `src/model-retry.ts` `retry` - the turn's waits and limits, no `retry` hook, no event; 2.0.32 did not); `generate.ts` `Generate.text` (no session: the prompt
  alone to the provider's registered address, no hook at all, a fresh `x-opencode-session`). Neither gets the default
  output limit. The title's model (`SessionContext.selectTitle`, instance-egzk2yjk.js 114–143): the title agent's
  model, else the small model of the primary's provider; its first attempt failed (a provider error, a failed request)
  or its answer has no non-blank line → once more on the session's primary model if that is another one, no further
  retries (title chunk instance-vcnzat6y.js 67–103, 136); a hook's own result (`event.result`, even "") ends it.
  The title model's variant (`src/session/context.ts` selectTitle, dist/chunks/tool-4jw80zew.js): the title agent's
  own (`agent.model.variant`), else the first of none / minimal / low the model offers, else none; 2.2.0 with neither
  a title agent's model nor a small model: the primary model with the first of none / minimal / low it offers, "low"
  only when it ranks below the user's variant (`lowerVariant`), none of them - the primary as the user picked it; the
  second attempt compares the whole ref (`isDeepStrictEqual`), so a variant that differs alone is another model.
- Simulator: `title`, `generate`, `generateText`, `TITLE_SYSTEM` (the same text in 2.2.0), `titleMessagePrompt`. The
  title's model: `state.titleModelID` (a title agent's or small model; unset: the primary - 2.2.0 with `lowerVariant`),
  its variant `state.titleVariant` (unset: the first of `TITLE_VARIANTS` the plugin's catalog offers for it - `low`
  for the Claude models with efforts); the first request
  (kind `title`, the same hooks) names that model and variant, the primary as the user picked it (`state.variant`)
  the second when the two refs differ. A title request records the model it named (`requests[].model`).
- Not needed: a retitle from the original request and recent conversation — core 2.0.32 asks a title only while the
  session has its default one (instance-71svxegq.js 214–217); the retitle runs only for a titled session, which no
  caller of 2.0.32's core does (the dev server's `session.update` with an empty title does; its 2.0.32 form not read).
- Tests: `simulators-regression` (a title; a title's second attempt — failed, blank, the same model and variant; a
  title's variant — the default one, the agent's own then the primary; generate in a session; generate with no
  session), concurrent-generate.

### Forks, reverts, stops, queued messages
- Original: `session/session.ts` `fork` (settled messages up to the boundary under new ids, metadata copied,
  `session.forked`); revert keeps the messages before the reverted one; `session.interrupt` aborts the request and
  emits `session.execution.interrupted`; a queued message passes the `prompt` hook at once and is delivered later.
- `session.context` (the plugin reads it for a fork): the messages in `Session.Message.Info` form — a user message
  with `skills` (`{ name, text }`) and `files` (`mime`, `name`, `source`: a file from disk `{ type: "uri", uri }`, an
  inline one `{ type: "inline" }` — history.d.ts 80–96), an answer's `content` with `reasoning` first, then `text` and `tool` parts
  (core 2.0.32 chunks/instance-1kn978n9.js 539–560, instance-h7s7r6s9.js 28). A checkpoint in 2.2.0: `summary` and
  `metadata` with `keepID` and the tail read from it as `recent` (core 2.2.0 `src/session/store.ts` context through
  `src/session/history.ts` load, withRecentText); no `recent` field (2.0.32 had it). A fork's checkpoint names the
  copy of its kept message (`src/session/projector.ts` projectFork, dist/chunks/tool-sbj9xhv5.js). An answer's parts
  carry the provider's data as `native` (2.0.32: `state`, `providerState`; the simulator sends none). A user message's skills: their texts
  first in the hook's list (instance-xt4njr3s.js 215), "[Skill activated: <name>]" lines in a summary's text;
  `say` / `queue` take them as `{ skills }`.
- Simulator: `fork`, `undoBefore`, `turn` (`stop`, `stopParked`; `steer` a text for the first tool step or a list,
  one entry per tool step, probe 26; a
  tool output may be a promise — OpenCode sends the step's results once every call ended), `queue` (with files),
  `deliver`.
- Plugin instances: OpenCode starts one per directory (`startPlugin(options, { directory })`); a chat's requests go
  to the instance of its directory (`newChat(id, directory)`, a location switch moves it; a fork keeps it); what
  `setup` registers serves at once, while setup still runs. The system parts of a request: "The system prompt".
- Switch: `state.hangReads` — OpenCode never answers `session.get` or `session.context`.
- The plugin API (`@opencode/plugin` 2.2.0 against 2.0.32): a compaction hook's own result names provider data
  `native` (was `providerState`); `ctx.event.subscribe({ types })` filters by event type; `session.list` and
  `session.instructions.entry` (list, put, remove) are new; `experimental.generate` (text, image, decisions); the
  hooks and their events are otherwise the same (`SessionRequestKind` primary, compaction, title, generate).
  Not yet as the original: the simulator's `pluginContext` has none of the new calls (no branch of the series uses
  them); its `event.subscribe` ignores `types`.
- Not yet as the original (2.2.0, no branch's code reacts to them): attachments kept as blob references
  (`experimental.media_blob`), the `todowrite` tool (`experimental.todo`), an MCP tool's non-media resource as text
  or a saved file (`src/tool/mcp.ts`), video media (`video_url`), sessions archived, a provider's reported cost.
- The plugin's `provider.reload()` of an instance: counted (`instance.reloads.count`); `instance.reloads.fails = "<message>"`
  makes the next reloads reject (a location being disposed; what 2.0.32 does then was not read).
- Tests: `simulators-regression`, fork-world tests, issue cases.

## Claude Code

### How a query reaches the simulator: the plugin's real starter, the real SDK, the CLI process
- Original: the plugin's starter (`src/query.ts` `startClaudeQuery`) builds the SDK options (environment, settings,
  permissions, system prompt, MCP servers) and calls the SDK's `query()`; the SDK starts Claude Code with arguments
  (sdk.mjs 0.3.300, ProcessTransport: `--model`, `--resume`, `--resume-session-at`, `--session-id`,
  `--fork-session`, `--no-session-persistence`, `--settings <json>`, `--max-turns`, `--permission-mode`,
  `--allowedTools`, `--tools`, `--setting-sources`, `--effort`, `--thinking`, `--strict-mcp-config`,
  `--include-partial-messages`…), writes `initialize` (system prompt or its addition, the in-process MCP servers by
  name with their manifests, tool aliases, agents, skills) and the input, reads the CLI's messages, answers the CLI's
  own requests (`mcp_message`: the plugin's tools) and throws when the process ends badly. Nothing of this is
  simulated: every query of every test goes this way.
- Simulator: the world installs the plugin's real starter (behind a guard that refuses a query no simulated CLI
  would answer, and `state.holdStart`); the SDK starts `claude-cli.mjs` from the world's PATH, which connects to the
  simulator (`serve` in `claude-code.ts`, the address in `OPENCODE_CLAUDE_SIMULATOR_HOST`) and carries the query
  both ways. The query runs in the test's process (`runQuery`: `chat`, `summary`) on what the process received
  (`paramsOfProcess`: the arguments read as the CLI reads them, its folder and environment, `initialize`);
  `claude.queries[i].params` is that, under the SDK options' names (`args`, `initialize`, `settings` parsed…).
  The plugin's tools are called back through the SDK (`McpChannel`: each server's tools from the manifest
  0.3.300 sends, else the MCP handshake over the control channel; `tools/call` with the call's id in `_meta`); the
  user's stop is the SDK's `interrupt` (confirmed at once); the end of the input (the SDK's `close()`, or a prompt
  that ended) marks the query closed, the CLI finishing what it does; a killed process stops the query. How a
  query ends becomes how the process ends: an error result then exit code 1, an exit code, a signal, a text on
  stderr ("Session ID … is already in use."); the SDK turns that into its own error. Partial messages only when
  the SDK asked (`--include-partial-messages`). The simulator's own checks drive queries the same way
  (`claude.chat(options)`: the real SDK into the world's CLI).
- The input's commands (the lifecycle probe, CLI 2.1.312, SDK 0.3.300, a local stub): an input message with a `uuid` is a command — `command_lifecycle`
  `queued` when the CLI reads it, `started` when it takes it (a record, a question, a message absorbed mid-turn),
  and after the result that ends it `completed`, or `cancelled` after an error result or a stop. A message without
  a `uuid` (main's prompts, a string prompt) has none. The SDK throws an error result's text ("Claude Code returned
  an error result: …") only when nothing follows the result: with a `uuid` it throws "Claude Code process exited
  with code 1". A query refused before it reads its input (no conversation, no message) has no command either.
- Cost: a CLI process a query, some 60 ms to start on Windows (measured with SDK 0.3.300 and the simulated CLI).
- Not yet as the original: the process starts in some 60 ms and its `init` follows at once (live 370–450 ms after
  the call); one turn a process — a second question in one process ends it with an error naming it; how the CLI
  orders a command's `queued` against the one it is taking when two come at once (here all read ones first).
- Tests: every chat test; `simulators-regression` ("every chat query goes through the plugin's real starter";
  "interrupt() as CLI 2.1.312 ends a turn": the commands of a message with a uuid).

### The CLI outside a turn: version, sign-in, model list
- Original: Claude Code 2.1.312, a live probe outside a turn with the machine's signed-in profile (no model call
  except one `[1m]` access check; the answers kept in `claude-cli-answers.json`, personal data replaced): `claude --version` prints "2.1.312 (Claude Code)"; `claude auth status
  --json` prints the sign-in (`claude.ai` with email, organization and plan; signed out `none` with exit 1;
  `api_key` with `apiKeySource` under ANTHROPIC_API_KEY; `third_party` / `bedrock` under CLAUDE_CODE_USE_BEDROCK).
  The SDK starts the CLI with `--output-format stream-json --verbose --input-format stream-json …` and speaks control
  requests, one JSON a line: `initialize` (the model rows, the account, `claude_code_version`, commands, agents…),
  `set_model` (the resolved id; `not_found` "Model '<id>' not found"; `unavailable_for_account` or `check_rejected`
  for a `[1m]` the account may not use), `get_context_usage` with `detail: "summary"` (`rawMaxTokens`: the window of
  the model set; Opus 4.6 and Sonnet 4.6 200K, `[1m]` 1M, the current models 1M for this account).
- Simulator: `claude-cli.mjs`, a process laid out by `installCli` the way npm installs the CLI (Windows `claude.cmd`
  and the package's `cli.js`, run through node; elsewhere a `claude` script) in the world's `bin` on PATH; the
  plugin's own code finds it and starts it. Every start is logged (`claude.cli.calls()`), a query's too (above:
  the query itself runs in the simulator); any other command or control request ends it with an error naming it.
- Switches: `claude.cli.set({ version, auth, authByConfigDir, models, windows, setModelErrors, delayMs, update,
  killOnPrompt, account, offline, unsupported })`.
- The model a `set_model` reports (the live probe above, and the windows probe: signed out and with a dummy key
  against a local stub of the API): a `[1m]` of a model that runs at 1M anyway drops the suffix ("claude-opus-5-5[1m]" →
  "claude-opus-5-5"), one of a 200K model keeps it ("claude-opus-4-6[1m]"); `get_context_usage` then names that model.
  Simulator: the same, by the window of the plain id.
- CLAUDE_CODE_DISABLE_1M_CONTEXT (the windows probe, CLI 2.1.312, no
  model call to the real API: an empty profile, and a dummy key against a local stub; the binary's `gP()`): read from the environment, from the `env` of the profile's settings.json when the user's
  settings load (`--setting-sources` absent or naming `user`; not with `--setting-sources=` or `project`) and from the
  `env` of the `--settings` JSON; settings.json wins over the environment both ways (env "0" with settings "1" is on,
  env "1" with settings "0" off). On: "1", "true", "yes", "on" in any case, spaces around ignored, JSON `true` and `1`;
  "0", "false", "no", "off", "", "2" are off. Then every model runs at 200K (`get_context_usage` before and after any
  switch, signed out and with a key); `set_model` to a `[1m]` of Sonnet 5.5, Sonnet 5, Opus 5, Opus 4.8, Opus 4.7,
  Opus 4.6, Sonnet 4.6 is refused by the CLI itself before any sign-in check ("Opus|Sonnet with 1M context is not
  available for your account…", `unavailable_for_account`), and a `[1m]` it accepts (Opus 5.5, Fable 5.1, Fable 5,
  Haiku 5.5, Haiku 4.5) keeps the suffix in the model it reports. Simulator: the same from the process's own
  environment, profile and arguments (no switch of its own: a test sets the variable or writes settings.json as a
  user would); the refused and accepted ids in `claude-cli-answers.json` `disable1m`; a `[1m]` of another id with the
  switch on ends the process with "probe it". Which of settings.json and `--settings` wins when both name it: not
  probed (the simulator takes `--settings`).
- A `[1m]` the account may use: `setModelErrors: { "<id>": null }` lifts a refusal the probed subscription got
  (`claude-sonnet-4-6[1m]`, `claude-haiku-4-5-20251001[1m]`); the switch then passes, reports the id with its suffix and
  the window 1M (`granted1m`: as CLI 2.1.312 answered when the API accepted the check — a dummy key against a stub;
  the windows probe). The switch's own refusals stay. Needs the live run at the end: a subscription with access to
  Sonnet 4.6 at 1M (whether the CLI's own refusal then lets it through to the API).
- An API key (`auth: "apiKey"`; the windows probe, a dummy key against a stub that accepts every check): `initialize`
  gives the five rows of the signed-out CLI and the account `{ tokenSource: "none", apiKeySource: "ANTHROPIC_API_KEY",
  apiProvider: "firstParty" }`; every probed id passes, at the windows the CLI reported (`apiKey.windows`). Not yet as
  the original: an API that refuses a check for the key's organization.
- Other sign-ins (the auth-status probe and the windows probe, CLI 2.1.312 with every connection sent to a dead
  proxy, dummy secrets): `auth: "oauthToken"` — a long-lived token (CLAUDE_CODE_OAUTH_TOKEN; ANTHROPIC_AUTH_TOKEN gives the
  same `auth status`): `authMethod: "oauth_token"`, no `apiKeySource`, exit 0; `initialize` rows default (Sonnet 5.5),
  sonnet, fable, opus, haiku and the account `{ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" }`.
  `auth: "apiKeyHelper"` — settings.json `apiKeyHelper`: `authMethod: "api_key_helper"`, `apiKeySource:
  "apiKeyHelper"`; the API key's rows, the account `{ tokenSource: "apiKeyHelper", apiKeySource: "apiKeyHelper",
  apiProvider: "firstParty" }`, switches as with a key. The words `auth status` has used since it came in 2.1.40
  (`cli.js` of the npm packages 2.1.40 and 2.1.50, the 2.1.312 binary): none, third_party, claude.ai, api_key_helper,
  oauth_token, api_key — never "oauth". Not yet as the original: a token's rows and windows online (the probe ran
  offline; the plan the token belongs to may change them) — the live run at the end.
- Signed out, offline, an older CLI (the signed-out probe, CLI 2.1.312 with an empty profile and with every connection
  sent to a dead proxy, no model call, the autoupdater off; answers added to `claude-cli-answers.json`): with an empty profile
  `initialize` lists five rows (default, opus, fable, sonnet, haiku) and the account `{ tokenSource: "none",
  apiProvider: "firstParty" }`; `set_model` to a listed alias passes, and to the model it runs on (`claude-opus-5-5`,
  also `[1m]`), any other id is refused "Unable to validate model: Could not resolve authentication method…"
  (`check_failed`) — as CLI 2.1.310 did on 26.10; `get_context_usage` gives 1M for the models reached (Opus 5.5,
  Fable 5.1, Sonnet 5.5, Haiku 5.5 — the last read by the windows probe); with every connection
  cut `set_model` fails "Network error. Please check your internet connection." (`check_failed`), a refusal the CLI
  knows by itself (Sonnet 4.6 `[1m]`) still comes; a control request the CLI does not know is answered "Unsupported
  control request subtype: <subtype>" with no code — how an older CLI answers a request it lacks.
- Every control request a started process answers, and the end of its input (the SDK's `close()`), is logged:
  `claude.cli.controls()` (a handle's `controls()`).
- Needs the live run at the end (a sign-in by subscription): offline, a refusal the API itself sends
  (`check_rejected`, an answer about the account) becomes the network error here - whether the CLI keeps an earlier
  answer of the account offline needs that account.
- Sign-in (CLI 2.1.312, a fresh profile, no subscription, killed before any code was sent): `claude auth login
  --claudeai` prints "Opening browser to sign in…", "If the browser didn't open, visit: https://claude.com/cai/oauth/
  authorize?…" (a new `code_challenge` and `state` each start) and "Paste code here if prompted > ", then waits on
  stdin. The simulator prints the same; the code exchange is not modelled (a line on stdin ends it with an error):
  no test signs in.
- The plugin's installers (`claude.installers.install(dir)`, `set({ npm, curl, bash })` with "ok" | "fail" |
  "hang", `calls()`): the same compiled program answering by the name it was started as. `curl` writes the script to
  its `-o` file, `bash` (the official script) puts `claude` in ~/.local/bin, `npm install -g` puts it beside npm.
  On Windows there is no `npm`: npm there is a `.cmd` the plugin cannot spawn without a shell (executable-path.ts),
  so the plugin goes on to curl and bash, as on a real host. Absent until installed (a host without them). Not as
  the original: the script's own output and the npm package's postinstall.
- Install layouts (`installCli(dir, { layout })`, each returns its own handle with `set` / `calls`; the first is the
  world's, `claude.cli`): `npm-legacy` (npm's `claude.cmd` and the package's `cli.js`, run through node; the
  default), `npm` (npm's `claude.cmd` and the package's `bin/claude.exe` — the `bin` of 2.1.312 by `npm view`),
  `local-bin` (the official installer's `claude.exe` alone), `orphan` (npm's shims with no package). The binaries
  are the same program compiled by `bun build --compile`, once per version of `claude-cli.mjs`, in
  `%TEMP%\opencode-claude-simulator-cli\<digest>` (about 110 MB), hard-linked into each layout; built under a name of
  its own process and then renamed, as is the world's link of node, so tests may run side by side. The answers
  (`claude-cli-answers.json`) are not built in: every start of the process, compiled or through node, reads them
  from the path the world sets in `OPENCODE_CLAUDE_SIMULATOR_ANSWERS` (beside `OPENCODE_CLAUDE_SIMULATOR_HOST`; the
  plugin's starters and the SDK pass the environment on), else from the path in `answers-path.txt` beside the
  install's `state.json` (a test's own start through Bun's spawn with no `env` gets the environment the test's
  process started with, without the world's variables — Bun 1.3.13), so a change of the answers needs no new build.
- What the plugin hands the SDK: `world.throughRealSdk(cli?)` — one chat turn through the plugin's real query
  starter and the real SDK into this process; the start is logged with its arguments (`--model=…`,
  `--allowedTools=…`, `--permission-mode=…`), its `runner` (node for npm's `cli.js` — the SDK's
  `executable: "node"` — or the executable) and the `initialize` request (`appendSystemPrompt`, `sdkMcpServers`,
  `excludeDynamicSections`…). The process then waits like a model before its answer, and the user stops the turn:
  `interrupt` is answered as CLI 2.1.312 answers it before an answer (the record, `aborted_streaming`, exit 1);
  OpenCode does not repeat a stopped request — one start, a clean journal.
- `claude update` of a native install (`local-bin`): as Claude Code 2.1.300 printed it live (an isolated
  install updated to 2.1.301) —
  "Current version: <A>", "Checking for updates to latest version...", "Updating to <B>...", "Successfully updated
  from <A> to version <B>", exit 0, and the next `--version` and `update` answer <B>; no network and a connection
  cut mid-download: "Error: Failed to install native update", "TelemetrySafeError: <cause>", "Try running \"claude
  doctor\" for diagnostics" on stderr, exit 1; the launcher held open: the success lines, the old version stays.
  From the 2.1.280 binary's strings (not seen live): "Claude Code is up to date (<A>)", "Another Claude process (PID
  n) is currently running. Please try again in a moment." (exit 0), "Claude is managed by winget…" (exit 0),
  "Failed to check for updates" (exit 1). Switch: `cli.set({ update: { outcome, to, afterExit } })` (`hang`; a
  helper holding the output after the exit — not a CLI behaviour seen, a process state the plugin must survive).
  An npm install (`npm-legacy`, `npm`): the failures the binary holds (2.1.302 as the author's test read them; the same
  lines are in 2.1.312, which adds advice lines) — `npmOffline` ("Failed to check for updates", "Unable to fetch latest
  version from npm registry", causes and advice), `npmPermissions` ("Error: Insufficient permissions to install
  update." and how to update by hand), `npmBusy` ("Error: Another instance is currently performing an update."), each
  exit 1.
  From reports of users (github.com/anthropics/claude-code issues, the texts quoted there): a warning on every run
  "Warning: Native installation exists but ~/.local/bin is not in your PATH" with its "Fix:" line (#104403, 2.1.308;
  `pathWarning`); no output at all (#66946, #63339, 2.1.153; `silent` with the exit code the test names — the issues
  give none); a hang right after "Checking for updates" (Claude Code docs, troubleshoot-install, before 2.1.214;
  `hang`); an npm update that says "Successfully updated" and leaves the package's placeholder script as
  bin/claude.exe (#96265 on Windows, #72690; `npmPlaceholderLeft`, `npm` layout): the running binary is renamed aside
  and the placeholder written in its place, so the next start meets the system's own answer — Windows refuses a text
  file as a program, elsewhere the script says "Error: claude native binary not installed." and exits 1. More, each
  with the output quoted in the report: the channel answering 403 (#89705, 2.1.241; `fetchRefused`), "Error: EEXIST:
  file already exists, mkdir '…versions'" under "Failed to install native update" (#81004, 2.1.215, Windows;
  `eexist`), the one line "Error: The socket connection was closed unexpectedly…" (#63126, 2.1.153, a proxy;
  `socketClosed`), success reported while the Bun runtime was installed in its place, whose `--version` is "1.4.0"
  (#80933, 2.1.219; `bunImpostor`, the CLI's `versionText`), "Claude is managed by Homebrew." with the update it
  offers and "brew upgrade claude-code" (#41194, 2.1.81; `homebrew`, exit 0). Old versions: some were fixed since;
  they stay for the plugin's reading of an unambiguous text.
  Not yet as the original: the stream (stdout or stderr) and the preamble of the outcomes not seen live; an npm
  install's success and "up to date" are not modelled — they end with an error naming them; the profile's
  `.claude.json` marks of a first native update are not written.
- A title and a summary through the real SDK: `world.throughRealSdk(cli, text, "title" | "summary")` — after one
  answered turn on the simulator; OpenCode cannot stop those, so the process the SDK started is killed once it has
  the prompt (`cli.set({ killOnPrompt })`, probes 8 and 10): the start and its arguments are logged (the SDK puts
  the plugin's `settings` on the command line, `--settings <json>`), the title stays, the compaction fails.
- A turn whose first attempt need not start the CLI: `world.turnThroughRealSdk(chat, { beforeRetry })` (a launcher
  the test removed: the SDK reports it missing); `beforeRetry` runs before OpenCode's first retry.
- Every query through the real SDK passes a guard: one whose CLI the plugin finds nowhere in the world is refused
  before the SDK runs — the SDK would start its own bundled executable (the platform package
  `@anthropic-ai/claude-agent-sdk-win32-x64`), a real Claude Code.
- The world puts only node itself (a hard link in a folder of its own) on PATH besides `bin`: node's own folder
  holds npm, which a test of the plugin's installer must never reach.
- Not yet as the original: `get_context_usage` repeats the probed answer except the model and the window; the
  `check_rejected` text holds U+FFFD where the probe's capture lost a character.
- Tests: `simulators-regression` (the CLI outside a turn; the CLI signed out, offline, an older one; the CLI's
  windows: the 1M switch, a `[1m]` the account may use, an API key; a CLI signed in with an API key; `claude update`),
  smoke (the sign-ins by plan, Bedrock, API key, OAuth token, apiKeyHelper, signed out), cli-update
  (feat/cli-auto-update).

### Transcript files
- Each Claude profile keeps its own: a query works in the profile its `env.CLAUDE_CONFIG_DIR` names (the plugin's
  `configDirs` option), else the world's; `claude.filesIn(<profile>/projects)` reads another profile's files.
- Project folders (CLI 2.1.312, the folders probe): a new session's file goes to
  `<profile>/projects/<folder>/<id>.jsonl`, the folder named after the working folder's real path (a junction resolved:
  the target's folder) with every character outside [a-zA-Z0-9] a "-" (each UTF-16 unit: Cyrillic and CJK one dash a
  letter, an emoji two; "x y" and "x-y" share a folder); a name over 200 characters is cut at 200 with "-" and the
  path's hash in base 36 after (the SDK's `iu` in sdk.mjs 0.3.300, the same rule). `--resume <id>` from another working
  folder, also with `resumeSessionAt`, finds the file in whichever folder holds it and appends to it there (the new
  records' `cwd` and an `environment` with `changes` name the new folder); a copy (`resume` + `forkSession` +
  `sessionId`) from another folder goes to that folder's project folder. Simulator: `projectFolderName`, `filesIn`
  (a name found in any project folder of the profile, a new file in the query's working folder's), `dirOf`;
  `claude.projectDir` is the project folder of the world's working folder (OpenCode's directory), `claude.records(name)`
  and `fileOf(name)` find a name in any folder of the world's profile. Check: `simulators-regression` "project folders
  by working folder".
- Not yet as the original: a working folder longer than Windows' MAX_PATH reaches the CLI in its 8.3 short form
  (`FOLDER~1\…\AAAAAA~1`, the probe's 311-character path), and the folder is named after that form; the simulator takes
  the long path. A new session's `--session-id` refused when the name is in use was probed in one folder only (probe
  39): the simulator refuses it whichever folder holds the name. Where a resumed session from another folder keeps a
  tool's saved image (`tool-results`): not probed, the session's own folder here.
- Original: live probes 1, 5–12: `user` records with the caller's uuid
  (`queueTranscriptOnly` for a record without a turn), `assistant` records, a tool result as a `user` record with
  `toolUseResult`, a message absorbed mid-turn as an `attachment` with `source_uuid`, `last-prompt` lines.
- Original, the CLI's service records, measured on CLI 2.1.312 by `test/cli-contract-live.ts`
  (29.10.2026, 13 files, all 26 checks passing; the order of the records of every file written out and compared;
  probe 42 on 2.1.310 saw the same):
  - On the chain (`attachment` records with a uuid, each the parent of the next): after a file's first record —
    a question or a record without a turn alike — `environment` (working folder, platform, shell, OS) and `model`
    (id, name, knowledge cutoff); after every question `total_tokens_reminder` ("<total_tokens>… tokens left");
    after the file's first question, before its first model call, also `session_context`, `date` and a partial
    `prompt_snapshot` (the system prompt alone). After the file's first model call a full `prompt_snapshot`
    (system prompt, `tools`, `cliPrefix`): behind the answer when that call answered — the chain's end is then that
    record, not the answer —, behind the tool's result when it asked for a tool. After a tool's result: the full
    `prompt_snapshot` (first call only), each absorbed message's `queued_command`, `total_tokens_reminder`. A later
    question: `total_tokens_reminder` alone, and `environment` again (with `changes`) when the working folder
    changed. After a compaction boundary: `session_context`, `date`, the summary, then `environment`, `model`, the
    partial and after the answer the full `prompt_snapshot`. `todo_reminder` was not seen.
  - Off the chain (no uuid): `queue-operation` (`enqueue` with the message's text, `dequeue`, `remove` for an absorbed
    message) around every input message; per model request `api-request-shape`, `api-request-blob` and
    `api-request`; `atis-latch`, `mode`, `tools-used`; after each turn `last-prompt` (`lastPrompt`, `leafUuid` the
    chain's end at that moment) and `cost-state`. About a third of a file's bytes are these lines.
  - A generic 400 (`invalid_request_error`, check 12): two model requests, then the error record.
- Original, the contents and moments of the service records (CLI 2.1.312, the service-records probe:
  a stub of the Messages API, Haiku 4.5, an MCP server with two tools):
  - Each attachment the model reads carries its text beside it, `rendered: [{ content: "<system-reminder>\n…\n
    </system-reminder>" }]` and `renderedRole: "system"`: `environment` (`snapshot` with `osVersion` "Windows 11 Pro
    10.0.26300"; the text "# Environment\nYou have been invoked in the following environment: …"), `model`,
    `total_tokens_reminder`, `date` ("Today's date is …."); `session_context` and `prompt_snapshot` carry none.
  - `model`: `identity` { modelId, marketingName, knowledgeCutoff } and `text` "You are powered by the model named
    Haiku 4.5. The exact model ID is claude-haiku-4-5. Assistant knowledge cutoff is February 2025." — the cutoff of
    20 ids in the probe (`MODEL_IDENTITIES`); an alias names its model (opus → claude-opus-5-5…), `[1m]` is dropped;
    an id the CLI does not know: name and cutoff null, "You are powered by the model <id>.".
  - `total_tokens_reminder`: 15000000 tokens at a question; after a tool step less what the turn's calls read and
    wrote so far (14999893 after 100 in and 7 out).
  - The full `prompt_snapshot`'s `tools`: { name `mcp__<server>__<tool>`, description, schema { name, description,
    input_schema }, server } for every tool of the in-process MCP servers (allowed or not), sorted by name; `cliPrefix`
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.". It comes after the first call that answered —
    not after a refused or a cut one.
  - `api-request-shape` { shapeHash, version, shape { system [cliPrefix, the system prompt], tools [{ name,
    description, input_schema }] } }: once a file (a resumed process writes none, a copy writes it again).
  - `api-request-blob` { hash, message }: each user message of a request as sent, the CLI's reminders folded in
    (before a question, the last ending in a newline; at the end of a tool result's content), once a hash a file; no
    blob of an answer or of the CLI's meta notes. An image's data is stored there again: a question's image (with the
    CLI's companion note) and a tool result's.
  - `api-request` { id, version, querySource "sdk", shapeHash, params { model, betas, max_tokens 32000, thinking,
    temperature 1 }, base (the process's previous request), keep (its messages this one starts with), tail (the
    rest's hashes, answers and notes included), cacheControl, requestDigest }; each answer record names it
    (`requestRef`), an answer stopped while it streamed is marked `isAbortedMidStream`.
  - `tools-used` { tools }: the file's tools used so far, before the record of a call of a tool new to the file.
  - `cost-state` { totalCostUSD, totalAPIDuration, totalAPIDurationWithoutRetries, totalToolDuration,
    totalLinesAdded, totalLinesRemoved, totalDuration, startTime, modelUsage per model { inputTokens, outputTokens,
    thinkingTokens, cache…, webSearchRequests, costUSD }, hasUnknownModelCost }: the session's totals, a resumed
    process and a copy going on from the file's (the source's) last one; calls that ended count (refused and cut
    ones too), a failed or stopped one not; the money at each model's prices, the same sums a result reports
    (section "The stream of a model call, usage").
  - The moments: a new file — `atis-latch` after its first question's `total_tokens_reminder`, no `mode`; a resumed
    process — `mode` between `last-prompt` and `cost-state`, no `atis-latch`; a copy — `mode`, `atis-latch`, the
    first message's queue lines, then the copied chain; a copy's `last-prompt` names the copied chain's first
    question (two runs).
  - After a refusal, a cut answer (`max_tokens`), a stop while the answer streams, a stop of a turn parked on a tool,
    and an API failure: `last-prompt` (leaf: the synthetic or the interruption record) and `cost-state` as after an
    answer; each attempt of a failed call writes its `api-request` (a retried one before its `api_error` record).
- Simulator: `chat` and its service records (`afterRecord`, `afterQuestion`, `afterModelCall`, `queueOperation`,
  `requestMessages`, `requestLines`, `toolUsed`, `costState`, `turnEnded`; `modelAttachment`, `offeredTools`): the
  chain records above by the same rules, each rule reading the chain from the last compaction boundary (a copy
  carries the source's, so a copy cut before the full snapshot writes it after its first call, as the run saw), and
  every line off the chain with the contents and at the moments above. A request's messages are rebuilt from the
  chain; hashes are sha256 of the simulator's JSON (the CLI's differ: same rule, other values). Checks:
  `simulators-regression` "the CLI's service records as CLI 2.1.312 writes them" (a question, a second one, a tool
  step with a message meanwhile), "the service records' contents and moments…" (a question with an image, a resumed
  one, a tool step with an image), "the service records after a refusal, a cut answer, a generic 400, 529 retried, a
  stop", "the CLI compacts by itself".
- Not yet as the original: the records' common fields (`timestamp`, `cwd`, `version`, `gitBranch`, `userType`,
  `entrypoint`, `promptId`…); the meta companion record of a question's image ("[Image:
  source: …]") and its folding into the blob; the text of an `environment` with `changes` (not probed: written
  without `rendered`); `osVersion` off Windows (the system's name and release, not probed); `params.thinking` other
  than disabled and a system prompt by preset (not probed: the query's own values); `tools-used` for two new tools in
  one answer and in a copy, `mode` of a resumed process with no turn, a copy's `last-prompt` when its chain starts
  with a record without a turn (not probed); durations are the simulator's own.
- Tests: every chat test.

### Where a resume continues
- Original: a plain `resume` continues from the last message record; `resume` + `resumeSessionAt` only along that
  chain, else "No message found" (probes 4, 8, 39). Service records with a uuid are not messages: the SDK's
  `forkSession` writes a `custom-title` record after the copied chain.
- The chain's records: the CLI's own set, read from the SDK's transcript loader (sdk.mjs 0.3.300): `user`,
  `assistant`, `progress`, `system`, `attachment` with a uuid; every other line is not on the chain.
- The calls of one answer (CLI 2.1.312, the two-calls probe "follow-ups"; the loader `lve` in sdk.mjs 0.3.300):
  each result hangs off its own call's record, so the parent line misses all but the last-written result; the
  loader puts the rest back after the line's last record of that message (`message.id`): the message's records off
  the line, then its calls' results off the line, in the order written. A plain resume, a resume at the
  first-written result and a copy all read both results; at the first-written result the other one comes first, and
  what the CLI writes next hangs off the rebuilt chain's latest-written record (the other result), not the point.
- Simulator: `CHAIN_TYPES`, `isChainRecord`, `leafOf` (the last chain record), `onLeafChain`, `chainTo` (the parent
  line with the loader's putting back), `chat` (the parent after a resume at a point). This is the one rule:
  helpers and tests take it from here, never a rule of their own (each hand-written copy got it wrong once).
- Subagents (CLI 2.1.312, the subagent probe "subagent": the stub
  answers a call of the CLI's `Agent` tool): the subagent's records go to a file of their own,
  `<project folder>/<session>/subagents/agent-<id>.jsonl` (each with `isSidechain: true` and `agentId`; a
  `.meta.json` beside), none into the session's file; the session's file holds the call, its result ("Async agent
  launched successfully…", `toolUseResult.status: "async_launched"`), the answer, and later a `user` record with the
  `<task-notification>` and an answer to it. Not yet as the original: subagents (the plugin offers no `Agent` tool;
  no test reaches one).
- Records the CLI takes back (CLI 2.1.312's code: `removeMessageByUuid` → `performRemoveByUuid`, the "tombstone" of a
  query, read in the binary with its callers; measured by the leaf-loss probe): a message the CLI abandons — a malformed tool use answer (`stop_reason:
  "tool_use"` with no call: "The previous response failed to produce a valid tool call. Please retry the tool call
  now." and a retry), an attempt retried after a refusal, the messages a model fallback discards — is removed from the
  file: never written when still in the batch, else cut out by rewriting the file's tail (`truncate` and the rest
  written again; above a size limit the whole file read and written without that line). The probe "malformed": the
  reader saw the answer's `assistant` event, the file never holds it, a `resumeSessionAt` its uuid is refused "No
  message found", and the next record (the full `prompt_snapshot`) keeps the removed uuid as its parent: a chain that
  does not meet. The CLI's own loader still reads the question before it (a plain resume sends the question, the
  note, the retry's answer); the SDK's loader (`lve`'s caller in sdk.mjs) stops at a missing parent.
- Simulator: `state.malformedToolUse` — the next answer's first call streams `MALFORMED_TOOL_USE_TEXT` with
  `stop_reason: "tool_use"` and no call, is not written (still in the batch), the full snapshot (when due) and the meta
  note hang off its uuid, then the answer. `chainTo` reads across a missing parent: the rule of the CLI's loader was
  not found in its code; taken from the probe (a plain resume read the question before the gap): the chain record
  written just before the orphan in the file. So a `resumeSessionAt` before the gap is accepted (not probed).
- Not yet as the original: the other removals (an attempt retried after a refusal, the messages a model fallback
  discards), the removal from a file already written (the tail rewritten); no test reaches them.
- Check: `simulators-regression` "where a chat ends" — the real SDK's `forkSession` without a point copies each chat
  down to its end; the simulator's end must be the same record, also for a copy that ends with the SDK's
  `custom-title`; "two calls of one answer" — the chain from the end and down to the first-written result.
- Tests: `simulators-regression` (revert on main; where a chat ends), every resume.

### The CLI's own compaction
- Original: CLI 2.1.312, `/compact` on a session (the compaction probe): events `status: "compacting"`, `status: null` with `compact_result: "success"`, `compact_boundary`
  (`compact_metadata` with `trigger`, `pre_tokens`, `post_tokens`…, `logical_parent_uuid`), the summary as a `user`
  message ("This session is being continued from a previous conversation that ran out of context…"); in the file a
  `system` / `compact_boundary` record with `parentUuid: null`, `logicalParentUuid` the last record before,
  `compactMetadata`, then the summary `user` record (`isCompactSummary`, `isVisibleInTranscriptOnly`). The model
  then reads from the summary on; a resume point before the boundary still counts as on the chain (check C 22).
- The auto compaction (the open-cases probe "compact-reactive", "compact-threshold"):
  reactive - a usage near the window starts none, on the next call or the
  next turn; the API refusing a turn's request as too long does, when the CLI's auto compaction is on (the
  `autoCompactEnabled` setting, on by default; DISABLE_AUTO_COMPACT, DISABLE_COMPACT): the refused request's lines,
  `status: "compacting"` (`compact_output_chars`), the summary's own model call (nothing in the file), `status: null`
  `compact_result: "success"`, the boundary (`trigger: "auto"`, `preservedSegment`: the turn's own records from its
  question, `headUuid`..`tailUuid`, kept verbatim after the summary, `anchorUuid`), the part's context and date, the
  summary record (the template with "Summary:", the transcript's path, the note on the earliest part and on the kept
  messages), environment, model, the partial snapshot, the answer. The next request holds the summary, then the
  question. Off: the turn fails "Prompt is too long", as before. The result counts the compaction as a turn
  (`num_turns` 2; 3 with a tool step).
- After a tool step, and in a side query (the too-long probe "tool-then-too-long", "side-too-long" and
  their "-off" cases, CLI 2.1.312): the request
  after the tool's result refused as too long — the CLI compacts with nothing kept verbatim (no preserved segment): the
  boundary, the summary (the tools the conversation used, "<tools-used-before-summary>a, b</…>" joined by ", " in the
  CLI's code; no note on kept messages), environment, model, the part's context and date, the partial snapshot; the
  model reads the summary alone (one message), then answers; the next turn reads the summary and its question. A side
  query (`persistSession: false`) refused as too long compacts the same way and answers, writing nothing: the events
  (`compacting`, success, the boundary keeping its question, the summary as a synthetic user event — no transcript
  path, the note on the earliest part without it, the note on kept messages), `num_turns` 2, its usage the answer's,
  `modelUsage` the session's with the summary's call. Off: both fail "Prompt is too long".
- Simulator: `chat` (`compactBeforeAnswer`, `reactive`, `afterTool`), `summary` (`compacted`), `compactSummaryText`,
  `autoCompactOn`, `sinceCompaction` (what the model reads: from the boundary, the kept records after the summary),
  `chainTo` (crosses the boundary by `logicalParentUuid`).
- Switches: `state.compactBeforeAnswer = { summary? }` - the API refuses the next answer as too long and the CLI
  compacts (whatever the setting). The setting itself is what the process got (`--settings`; none: on, the CLI's
  default): main's starter leaves it alone, the chain's sets it off.
- Not yet as the original: a refusal of a later tool step's own call (a turn of two tool steps, the second step's
  call refused: not probed, fails as before); the side query's events carry no `status: requesting` but around the
  compaction; the turn's compaction adds no summary call to the session's spend.
- Not needed: the `/compact` command (the plugin never sends it); its records for reference (the compaction probe's
  "command" case): after the summary a meta caveat "<local-command-caveat>:", "<command-name>/compact
  </command-name>:", "<local-command-stdout>Compacted </local-command-stdout>", trigger "manual".
- Tests: `simulators-regression` (the CLI compacts by itself; the CLI's auto compaction is reactive; too long after a
  tool step and in a side query), compact-leaf-main.

### main's revert: the SDK's forkSession
- Original: `forkSession(sessionId, { upToMessageId })` copies the chain into a new file under fresh uuids and adds
  a `custom-title` record; no process, no network.
- Simulator: none; the real SDK runs on the simulator's files.
- Tests: `simulators-regression` (revert: the copy carries the SDK's `custom-title`), issue cases on main.

### Names and copies
- Original: probes 12, 25, 39: `sessionId` names a new file, a new query on a name in use is refused; `resume` +
  `forkSession: true` + `sessionId` copies the source's chain with the same uuids; two copies at once both pass.
- Simulator: `chat`.
- Switches: `state.copyRace` (two copies at once), `state.refuseCopy` (the next copy refused).
- Tests: fork-world tests, issue cases.

### The input of a query
- Original: check C (probe 50): records without a turn are confirmed one by one by an empty `result` naming them;
  records waiting together are joined under the last uuid; a repeated uuid is dropped silently; a plain `resume` on
  a record without a turn is answered "No response requested." first; a blank text reaches the model as nothing.
- Original, when a record without a turn is confirmed (the confirmation probe, CLI 2.1.312,
  SDK 0.3.300, Windows, a local stub of the Messages API and a dummy key; 12 new and 12 resumed processes), from the SDK's write of the record to the CLI's stdin (the SDK
  writes `initialize` and then the records at once, some 6 ms after the spawn): the first record of a process once
  the process has started — 353 ms median (318–493) on a new transcript, 426 (342–519) resumed —; every later one
  7 ms median (481 records, 4–49), whether sent once the one before was confirmed or 50, 100, 300 ms apart. Never
  missing; never after the next record's write, except when the next was written within the 7 ms: three records
  written at once to a running process — the first taken alone (confirmed after the other two were written), the
  other two joined under the third's name (23 of 24; once each alone). A question written right after a record:
  the record's confirmation comes 7 ms after (after the question's write), then the question's turn; never joined.
- Simulator: `chat`. Each input message is read at once, as the SDK takes it from the plugin's stream
  (`query.input[i].readAt`); a record without a turn is taken once the process has started (`CONFIRM_MS.starting…`
  after the handle) with every record without a turn waiting by then joined, else when it comes, alone if the CLI
  was idle, with the ones that waited if it was busy; it is written and confirmed `CONFIRM_MS.running` (7 ms) after
  (`confirmedAt` on the entry of the record named; none for a record joined into the next or dropped). Defaults
  `CONFIRM_MS = { startingNew: 345, startingResume: 420, running: 7 }` (the medians less `running`). On Windows a
  7 ms timer fires after 7–25 ms.
- Switches: `state.joinWaitingRecords = false` (load stands that time the plugin alone: never joined);
  `state.confirmMs = { starting, running }` for every next chat query (`{ starting: 0, running: 0 }`: at once — the
  timeout scenarios of `simulators-regression`, whose timeouts are a few hundred ms).
- Not yet as the original: a query whose first message is a question answers without the process's start (live
  the CLI's `init` comes 370–450 ms after the call, "Failures of the process"); only records without a turn wait for it.
- Check: `simulators-regression` "records without a turn confirmed as CLI 2.1.312 confirms them".
- Tests: records-one-by-one, every turn of the chain.

### Tool calls and stops
- Original: the CLI calls the plugin's MCP tool with the call's id in `_meta` (probe 43; CLI 2.1.300 and 2.1.312 on
  every call, a subagent's too: the 2.1.300 probe). `interrupt()` (CLI
  2.1.312, the interrupt probe; live probe 41 before): a turn parked
  on tool calls writes and streams a rejected result for every call ("The user doesn't want to proceed with this
  tool use. The tool use was rejected …", `is_error`, `toolUseResult: "User rejected tool use"`), then "[Request
  interrupted by user for tool use]", a result `error_during_execution` with `terminal_reason: aborted_tools`;
  while the answer streams: the part shown as an `assistant` record and event (`aborted: true`), "[Request
  interrupted by user]", the message's end, a result with `aborted_streaming`; before the answer started: the
  record alone and `aborted_streaming`. In each case the process then exits with code 1 and the SDK throws. A user
  message sent while a tool runs, with priority "next" or none, is taken into the turn as a `queued_command`
  attachment after the results; with "later" it starts a turn of its own after the result. When the calls start (CLI 2.1.312, the tool-timing probe):
  each call as soon as its `tool_use` block is complete (after the block's
  `assistant` event and `content_block_stop`), while later blocks of the message still stream and before
  `message_stop`; calls of tools listed with `annotations.readOnlyHint` run side by side, any other tool's call
  waits until the previous such call ended. Mixed (the open-cases probe "readonly-during-edit",
  "edit-during-readonly", "readonly-after-edit-during-readonly"): another tool's call waits
  for every earlier call, a read-only call for an earlier other one - read, edit, read run one after another. A
  result is written and streamed as soon as its call ended, also while the message still streams, before
  `message_delta` ("result-before-stop"); the next block's record then hangs off that result
  ("result-between-blocks").
- Original, two calls of one answer with a message sent meanwhile (CLI 2.1.312, the two-calls probe,
  12 cases: a read-only tool and another, priority "next" and
  none, the message before the first result or between the two, the calls ending in order or the second first):
  each call's result is written and streamed as soon as that call ended, so in the order the calls ended; each
  result's `parentUuid` (and `sourceToolAssistantUUID`) is its own call's record, so only the last-written result
  lies on the parent line from the leaf. In every case the `queued_command` comes after both results: the last
  result, the full `prompt_snapshot` (first call), `queued_command`, `total_tokens_reminder`, the answer. The
  message's `queue-operation` `enqueue` line is written when it arrives (before the first result or between them),
  `remove` after the attachment, with the text, `reason: "absorbed_mid_turn"` and `commandUuid`. The next request
  holds the results in the order written, the message folded into the last one's content.
- Simulator: `chat` (the tool steps, `modelCall`'s `onBlock`), `callPluginTool`, `listPluginTools` (the CLI's
  `tools/list` at the start of a query, for the read-only set); a step's results as above (`callsRunning` for the
  queue line).
- Switches: `state.toolTurn`, `state.toolSteps` (a number of `bash` calls, or the calls with their tool and input),
  `state.hold`, `state.blockPauseMs` (the model streams slowly: a pause after
  each block; summaries too), `state.stallBeforeStop` (the stream stalls before `message_delta`),
  `state.ignoreInterrupt` (a hung CLI: `interrupt()` does nothing). Each query records `closedAt` (the plugin
  closed the process) and `endedAt` (its stream ended), and each input message its `priority`; "later" is not
  modelled (the simulator throws).
- Simulator, the order: `chat`'s `start` (each call after `barrier` or `allEnded`), `writeEnded` (results as calls
  end, from inside `modelCall` too: after each block and while `stallBeforeStop` holds the stream).
- Original, two calls stopped (CLI 2.1.312, the two-calls-interrupt probe,
  five cases: two edits with the first running or ended, two reads both running or one ended): a call that had ended
  keeps its result; a rejected result for each other call, in the order of the calls, each hung off its own call's
  record (`parentUuid` and `sourceToolAssistantUUID`) as a result is; then the full `prompt_snapshot` (the file's first
  call) and "[Request interrupted by user for tool use]". A plain resume reads both results and the interruption
  record, then the CLI's "No response requested.", then the question. Simulator: the records the same; check
  `simulators-regression` "two calls of one answer stopped". Not yet as the original: the "No response requested."
  of a plain resume whose leaf is an interruption record (the simulator answers so only after a record without a turn).
- A stop while the answer streams, against what the reader had read (CLI 2.1.312, the stop-lag probe,
  partial messages on, a stub streaming the answer in pieces): the aborted record
  holds every piece the CLI had from the API when it handled the stop, whatever its reader had read ("slow-reader":
  the reader had one piece, the record six); the pieces the reader had not read still reach it after the stop, before
  the aborted `assistant` event; a stop before the reader had any piece ("first-piece") still leaves an aborted record
  of what the CLI had; blocks the CLI had whole ("burst": the stop during a pause before `message_delta`) are written
  whole, not aborted, `stop_reason` null, then "[Request interrupted by user]". Switch: `state.unreadAtStop` — with
  `holdMidAnswer` (the reader had the first piece) or `hold` (it had none), the CLI had that many more pieces: they go
  into the record and to the reader after the stop; more than the block has left, the record is whole and the turn
  ends after that block. Check `simulators-regression` "a stop where the CLI had more of the answer than its reader".
- Tests: `simulators-regression` (tool step; tool calls of one message; two calls of one answer with a message
  meanwhile), parallel-tools, tool-call-ids, fork-world tests.

### Failures of the process
- Original: probes 8, 10, 39, 47: the process does not start; the process killed after the prompt; a process not
  stopped writes its answer later; a copying process killed after the file appeared.
- Simulator: `chat`.
- Switch: `state.failures` (`spawn`, `killed`, `zombie`, `copyKilled`), `state.zombies`; `killedAfterRecords` — the
  process killed once its records without a turn were confirmed, before the record with the turn (the same death,
  a moment earlier; a tree that sends no such records dies before its first record).
- When the file is written (CLI 2.1.312, the killed-after-result probe and the stop-lag probe "flush"):
  the CLI writes its file in batches, some 50-130 ms after the events of what it
  writes; an answer's block records once the message ended or was stopped (with the stop reason when
  `message_delta` came first). A process killed (SIGKILL) at a tool result's event, or when its next model request
  reached the API, leaves the file as it found it: no file at all for a new session, the earlier turns alone for a
  resumed one ("on-event", "on-request", "two-calls", "resumed", two runs each). Killed once the result's line was
  on disk ("on-line"): the batch holds the result, the full `prompt_snapshot` (the file's first call), the tokens left
  and the next request's lines (`api-request-blob`, `api-request`), nothing after; the SDK throws "Claude Code process
  terminated by signal SIGKILL". Switches (a tool step needed): `killedAfterResult` — the second; `killedBeforeFlush`
  — the first: the reader saw the turn's question, calls and results, the file is put back as the process found it.
  Check `simulators-regression` "a process killed right after a tool's result".
- Not yet as the original: the batches themselves (the simulator writes each record at once, so a test reads a turn's
  records as soon as their events came); a process the simulator ends by a signal ends itself, and on Windows its
  parent reads exit code 1, not the signal (the SDK then throws "exited with code 1").
- A line half written (the subagent probe "half-line": questions of 20 and 60 MB, the file watched every
  millisecond to kill the process on a line without its end): not reached — each batch appeared whole, the file always
  ending with a newline; a resume appends after it. The simulator writes whole lines.
- A start that takes time: the plugin's real starter awaits the SDK's import and the CLI's lookup before the SDK's
  `query()` (`src/query.ts`). Measured (the start-time probe, 29.10.2026: the plugin's own `startClaudeQuery` with a chat turn's params, its tool bridge built first, CLI 2.1.312
  against a local stub, SDK 0.3.300, Windows; 12 cold starts — the first of a fresh process — and 60 warm): its call →
  its handle, medians cold 18 ms (16–25; the CLI's lookup 3 ms of it), warm 4.5 ms (4–10); → the CLI's
  `system/init`, its first event, cold 454 ms (437–573), warm 366 ms (343–933). The first interval is now the real
  starter's own (every query goes through it, "How a query reaches the simulator"), the second the simulated process
  starting (some 60 ms). Switch: `state.holdStart` (a promise): the next start is held before the real starter is
  called, until the promise settles (`claude.heldStarts` counts them): no process, no query until then.
- Not yet as the original: the init comes some 60 ms after the call (live 340–570 ms); a stop in that window stops a
  process that has barely started.
- Tests: fork-world tests, attempts, monkey; `simulators-regression` (a start held), stopped-request (chain),
  branched-session-main (`killedBeforeFlush`: the plugin's leaf not in the file).

### Failures of a model call
- Original: CLI 2.1.312 against a local stub of the Messages API (the failures probe, the
  context-size probe): 429, 529 and 5xx are retried by the CLI itself ten times (`api_retry`
  events, waits up to about 40 s, some 3 minutes; 401 likewise); then, and at once for the others, a synthetic `assistant` record
  (`isApiErrorMessage`, `error` code, model `<synthetic>`), a result `{ subtype: "success", is_error: true, result,
  terminal_reason, stop_reason, api_error_status }`, and the SDK throws "Claude Code returned an error result: <text>"
  (the probe's prompt had no `uuid`; with one, the command's `cancelled` follows the result and the SDK throws "Claude
  Code process exited with code 1" — "How a query reaches the simulator").
  Prompt too long: `invalid_request`, `prompt_too_long`, 400. 413: `invalid_request`, `image_error`, "Request too large
  (max 32MB)…". The API's 400 "…image exceeds 5 MB maximum…" (probe case "400 image too large"): `invalid_request`,
  `image_error`, 400, "Image was too large. Try resizing the image or using a different approach.", not retried. Any other 400
  `invalid_request_error` (the service-records probe "400-generic"): the CLI
  sends the same request once more without the beta `thinking-token-count-2026-05-13` (no `api_retry`, the SDK's
  retry count 0 — the CLI's own), then "API Error: 400 <the API's message>", error `unknown`, `apiErrorStatus` 400,
  `api_error`, 400; when that second request answers ("400-once") the turn goes on as usual. 429: `rate_limit`. 529, 500: `server_error`. 403 org: `oauth_org_not_allowed`; 403 permission:
  `authentication_failed`; 400 credit: `billing_error`; 402: `unknown`. 401 with an API key, followed to its end
  (probe case "401 authentication", 29.10.2026): ten retries of the CLI (`authentication_failed`, about 3 minutes),
  then "Invalid API key · Fix external API key", `authentication_failed`, `api_error`, 401. The CLI's waits between
  its retries: 0.5 s doubling up to 32 s, plus up to a quarter at random (575, 1249, 2298, 4546, 8589, 18219, 34067,
  37239, 32110, 34677 ms in that case). A refused answer (`stop_reason: refusal`): a
  notice, a meta note, one more call, `model_refusal_no_fallback`, then the synthetic record "API Error: <Model> can't
  help with this…". `max_tokens`: three continuations with a meta note each, then `max_output_tokens`.
  More (the second failures probe, header names and `stop_details` taken from the CLI's own code): each
  retry of the CLI writes a `system` / `api_error` record and emits `api_retry` (a dropped connection:
  `error_status: null`, `error: "unknown"`), and when a retry then succeeds the answer follows as usual; a
  refusal's `stop_details` (category, explanation) reach `model_refusal_no_fallback` (`original_model`,
  `request_id`, `api_refusal_category`, `api_refusal_explanation`, `refused_user_message_uuid`) and, for "cyber",
  the text "…'s safeguards flagged this message…"; a refused call with no content streams none; a query of one step
  whose model asks for a tool: the call runs, then `error_max_turns` / `max_turns`, "Reached maximum number of
  turns (1)", and the SDK throws; a failure after a tool step: the result, then the synthetic error record; a
  process killed while its call runs: the call in the file, no result, the SDK throws "terminated by signal
  SIGKILL"; with an API key the CLI emits no `rate_limit_event` even when the unified rate-limit headers come.
  The `api_error` record's `error` keeps the API's body whole (the probes' stub sent Anthropic's error shape):
  `message` "529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}", `status`, `formatted`
  "529 Overloaded", `connection: null`, `isNetworkDown`, `rateLimits` (null without the unified headers), `noResponse`;
  a dropped connection: "Connection error.", "Connection dropped (ECONNRESET)" and a `connection` object (code,
  message, `isSSLError`). The 5xx texts end on where to look (the CLI's code, `NDr`): " If it persists, check
  https://status.claude.com." when the CLI talks to Anthropic's own address (no ANTHROPIC_BASE_URL), "check your
  inference gateway (<host>)" as the stub saw it.
  A refusal by model and category (the open-cases probe "refusal-*"):
  Sonnet 5.5 for cyber, Opus 5.5 and Fable 5.1 for cyber, bio and frontier_llm answer it with another model (cyber Opus
  4.8 / Sonnet 5, bio and frontier_llm Opus 5): the second refused call streams but is not written (retracted), a
  `system` / `model_refusal_fallback` record and event (`trigger: "refusal"`, `direction: "retry"`, `scope: "session"`,
  `original_model`, `fallback_model`, `retracted_message_uuids`, the notice in `content`), then one call of the
  fallback model with no note of its own; if it answers, the turn ends answered (its usage under its own model), if it
  refuses, `model_refusal_no_fallback` names it. Haiku 4.5 and other categories: no fallback. The error text by the
  model that refused last: cyber the same for Haiku 4.5, Sonnet 5 and Opus 4.8; Haiku 4.5 "can't help with this. Start
  a new session to continue." with the category's `Details`; Sonnet 5.5, Opus 5.5, Opus 5, Fable 5.1 "'s safeguards
  flagged this message (aup). <why> Claude Code can't respond to this message with <model>." and a page by model; the
  synthetic record carries `stop_details`. A one-step side query whose model asks for a tool runs the plugin's tool
  when the query lists it (the probe "max-turns-meta": the call ran), then `error_max_turns`.
- The synthetic record's `error` code (CLI 2.1.312's code: the function that turns a failed call into the record, and
  `cqn`, which names the `api_retry` event's `error`, read in the binary), measured by the stream-usage probe
  "fail-*": a 404
  `not_found_error` — the streaming request, then the same without streaming, no `api_retry`, `model_not_found`, 404,
  "There's an issue with the selected model (<model>). It may not exist or you may not have access to it."; a 403
  `permission_error` with `details.error_code: "verification_required"` — `verification_required`, 403, the record's
  `apiErrorCode` "verification_required", "API Error: <the API's message>"; Bedrock with no AWS credentials, Vertex
  with GOOGLE_APPLICATION_CREDENTIALS naming no file — no request reaches the API, two retries of the CLI (`api_retry`
  `error_status: null`, `error: "cloud_credential_error"`, `max_retries: 2`; their `api_error` records carry the
  provider's error with `isCloudCredentialError: true`), then `cloud_credential_error` with no status ("API Error:
  Could not load AWS credentials · …", "… Google Cloud credentials · The file at … does not exist…"), the result's
  `api_error_status` null; 529 — the record `server_error`: `overloaded` is only the `api_retry` event's `error`, never
  a record's. `account_on_hold` comes only from the OAuth token's refresh (a sign-in by subscription, behind a server
  flag): a Messages API 403 carrying that body gives `authentication_failed` ("fail-403-on-hold-body"); the text from
  the code: "Your account is on hold and can't use Claude Code. View details or appeal: <url>" (default
  https://claude.ai/restricted), no status.
- Request ids (the service-records probe "529", the stream-usage probe "fail-*"): an `api_error` record's `error`
  has the attempt's `requestId` (the API's `request-id` header) after `status`, and the record `source:
  "request_retry"`; the synthetic record names the last request's `requestId` when the API answered.
- Simulator: `API_FAILURES` (`FailureShape`), `apiErrorObject`, `failureText`, `cloudCredentials`, `REFUSAL_FALLBACK`,
  `refusalFallbackNotice`, `refusalText`, `chat` (`failedCall`, `retries`), `summary` (`summaryFailures`).
- Switches: `state.failures` with an `ApiFailure` (`promptTooLong`, `requestTooLarge`, `imageTooLarge`, `badRequest` (the probe's
  message "stub failure"), `rateLimit`, `overloaded`,
  `serverError` — also `api` —, `oauthOrg`, `permission`, `authentication`, `creditBalance`, `billing`, `modelNotFound`,
  `verificationRequired`, `cloudCredentials` (the query's env names the provider: CLAUDE_CODE_USE_BEDROCK, or
  CLAUDE_CODE_USE_VERTEX with GOOGLE_APPLICATION_CREDENTIALS; else the simulator ends with "probe it"), `accountOnHold`,
  `refusal`, `maxTokens`) or
  `killedWhileTool`; `state.failingCall` (which model call of the query fails); `state.apiRetries` (retries, then
  the answer), `state.waitRetries`; `state.refusalDetails` (`fallbackAnswers`: the fallback model answers);
  `state.summaryFailures` (also `maxTurns`).
- Not yet as the original: `account_on_hold` is read from the code, not seen (whether its request line is written
  before the refresh fails, and whether the CLI retries it); the cloud credentials failures of other forms (no
  `GOOGLE_APPLICATION_CREDENTIALS`, a profile that fails otherwise) not probed; the texts of a 404 on Bedrock and other
  providers (the code: "The model … is not available on your … deployment"); a refusal of a model or category not measured (Sonnet 4.6, Haiku 5.5, Opus 4.8 or Sonnet 5
  outside cyber) throws "probe it"; a later turn after a fallback (`scope: "session"`: whether the CLI stays on the
  fallback model) not probed; the fallback case's result `usage` counted only the refused model's calls live, the
  simulator all of them.
- Needs the live run at the end (a sign-in by subscription): 401 on a subscription sign-in (the CLI may refresh its
  token first); the 5xx texts against Anthropic's real endpoint (read from the CLI's code, not seen).
- Not yet as the original, needs the live run: the plan's own limit. The CLI composes "You've hit your <limit>
  · resets <time>" itself (the 2.1.312 binary: `C2s` reads `anthropic-ratelimit-unified-representative-claim`,
  `-reset`, `-overage-status`, `-overage-disabled-reason` of a 429; `Ht` / `Gt` / `k` word it; the limit names
  five_hour "5-hour limit" — no longer "session limit", which the CLI still reads back as the 5-hour one —, seven_day
  "weekly limit", seven_day_opus "Opus limit", seven_day_sonnet "Sonnet limit" (the weekly one on Pro and
  Enterprise), seven_day_overage_included "Fable limit"; " · progress saved" behind a feature flag; spend caps and
  credits have their own lines) only on a sign-in by subscription or an inference gateway's own sign-in (`jcn`); the
  synthetic record then carries that line as its content, `error: "rate_limit"`, `apiError: "usage_limit_reached"`
  with `apiErrorParams.rate_limit_info`. With an API key the same 429 and headers give the API's text
  (the limit-text probe: "API Error: Request rejected (429) · <the body's
  message>", `rate_limit`, `api_error_status` 429, one call, the SDK throws "Claude Code process exited with code 1"),
  which is the simulator's `rateLimit`. The form of the record and result around the composed line, and whether the
  CLI retries first, are seen only on a plan.
- Not needed: the random part of the CLI's waits — no test reads a wait, the plugin only shows it ("retrying in
  2s"), and a random value would make a test that reads it random; `rate_limit_event` is modelled from a live probe
  (section "The stream of a model call").
- Tests: `simulators-regression` (prompt too long, rate limit, account failure, compaction after a 413, the service
  records after a refusal, a cut answer, a generic 400, 529 retried; a refusal by model and category; the CLI's
  retries and 5xx texts; failures CLI 2.1.312 names by their own codes), account-failures, turn-errors.

### The stream of a model call, usage
- Original: CLI 2.1.312 (the context-size probe, a local responder): `system/init`, then per model call
  `message_start` (usage with `output_tokens: 1`), each content block — `content_block_start`, its deltas
  (`text_delta`, `thinking_delta`, `input_json_delta`), the `assistant` event of that block (the message id, model,
  usage), `content_block_stop` — then `message_delta` (stop reason, output tokens), `message_stop`; at the end
  `result` with `usage` (totals), `total_cost_usd` and `modelUsage` per model — an error result too, with the calls
  that ran (the second failures probe "tool-then-400": the one successful call's usage, the cost, `num_turns: 2`).
  Each content block is a record of its own in the file.
  A process stopped while the answer streams writes no answer record (probe 40).
- Where a call's usage goes (the stream-usage probe, "usage-*" cases; CLI 2.1.312, SDK
  0.3.300, a local stub): every `assistant` event of a call carries the `message_start` usage as the API sent it
  (`output_tokens: 1`, `stop_reason: null`); the final output comes only in `message_delta`; the call's records in
  the file hold the final count — the snapshot with what `message_delta` brought laid over it (a `message_delta` that
  repeats the input side wins there too, "usage-delta-full") — in the result's form (`output_tokens_details`,
  `server_tool_use`, `service_tier`, `cache_creation`, `inference_geo`, `iterations`, `speed`, `fallback_credit`),
  the call's `stop_reason` and the API's `request-id` as `requestId`. An answer stopped while it streams is written
  with the snapshot alone (the interrupt probe "answer"). Two calls of one turn ("usage-two-calls": 500 059,
  then 501 050 of context): each record and each `message_start` its own call's; the result sums them
  (`cache_read_input_tokens` 1 000 118). Thinking tokens: `output_tokens_details.thinking_tokens` passes through
  `message_start` and `message_delta` as the API sent them, the delta's value winning; the records, the result and
  `cost-state`'s `modelUsage.thinkingTokens` take the final one ("usage-thinking": 0 at the start, 120 in the delta →
  120; "usage-thinking-start": 7 at the start alone → 7). A synthetic error record's usage is empty
  (`output_tokens_details`, `service_tier`, `inference_geo`, `iterations`, `speed` null).
- What a result counts (the open-cases probe "usage-resume", "usage-copy-and-side", "prices"):
  `usage` this query's calls (with `output_tokens_details`,
  `server_tool_use`, `service_tier`, `cache_creation`, `inference_geo`, `iterations`, `speed`, `fallback_credit`);
  `total_cost_usd` and `modelUsage` the whole session's - the CLI restores the last `cost-state` line of the file it
  resumes (a copy: its source's; a side query too, and writes none) and adds each call; `cost-state` after a turn
  holds `totalCostUSD` and `modelUsage`. A `modelUsage` entry has the model's `costUSD`, `contextWindow` and
  `maxOutputTokens`; a model this query called also `canonicalModel`, `provider`, `costBasis`. Prices, $ a million
  in / out / cache write / cache read: Haiku 4.5 1 / 5 / 1.25 / 0.1, Haiku 5.5 0.1 / 0.5 / 0.125 / 0.01, Sonnet 4.6
  3 / 15 / 3.75 / 0.3, Sonnet 5 2 / 10 / 2.5 / 0.2, Sonnet 5.5 2 / 10 / 2.5 / 0.1, Opus 4.8 and Opus 5 5 / 25 / 6.25 /
  0.5, Opus 5.5 4 / 20 / 5 / 0.2, Fable 5.1 10 / 50 / 12.5 / 0.25; no higher price for a 300 000-token prompt; a model
  the CLI has no price for at 5 / 25 / 6.25 / 0.5 (its code). Windows: Haiku 4.5 and Sonnet 4.6 200K (32K out), the
  others 1M (Haiku 5.5, Sonnet 5.5, Opus 5.5 128K out; Sonnet 5, Opus 4.8, Opus 5, Fable 5.1 64K).
- Simulator: `modelCall` inside `chat`; usage estimated at 4 characters a token (what the call read, what it wrote),
  no cache; the text in a few deltas (`piecesOf`); `MODEL_PRICES`, `costOf`, `sessionSpend`, `resultTokens`;
  `callUsage` (a call's opening snapshot, its `message_delta`, its final count), `SYNTHETIC_USAGE`; each model request
  a `request-id` `req_sim_<n>` (`requestLines`). A summary's call the same way (no record).
- Opus 5.5 live (a live probe with a subscription, one turn of two tool steps, adaptive thinking): the thinking
  block came redacted — an empty `thinking_delta`, then a `signature_delta` whose bytes carry the tag "thinking";
  what it said before its first call came as a plain `text` block before the `tool_use` block, not as a thinking
  block tagged "narration" (one capture). Not modelled for that reason: a narration block was never seen live, and
  its form would be a guess; the plugin's `isNarrationSignature` stays without a test (the findings register's
  observation, a question for the author whether the form is alive). A capture that shows one is the way to add it.
- Switches: `state.usage` (over the estimate: one object for every call, or a list taken one entry a model call;
  `output_tokens_details` the call's thinking tokens, sent with its `message_delta`), `state.thinking` (a thinking block before the
  text, with the probed signature; "" for a redacted one), `state.toolPreamble` (a text block before the next tool
  step's calls), `state.holdMidAnswer` (the answer pauses after its first delta: a stop while it streams).
- Rate-limit windows: `rate_limit_event` `{ type, rate_limit_info, uuid, session_id }`, `rate_limit_info` from the
  `anthropic-ratelimit-unified-*` headers (`status`, `resetsAt`, `rateLimitType`, `utilization`, `overageStatus`…)
  — read from the CLI's own code (claude.exe 2.1.312); the CLI emits it only on a sign-in by subscription. Live
  (a live probe, one short Fable turn on a subscription at 85% of a weekly window): one event
  as the response starts, after `status: requesting` and before `message_start` (`allowed`, `five_hour`,
  `unifiedWindows` of the 5-hour and 7-day windows), and one after `message_stop`, before the result
  (`allowed_warning`, `seven_day_overage_included`, `utilization: 0.85`, `surpassedThreshold: 0.75`).
  Switches `state.rateLimitEvents` (as the next model call's response starts) and `state.rateLimitEventsAfter`
  (after the answer, before the result).
- Notices: `system` / `notification` (`key`, `text`, `priority` low | medium | high | immediate, `color`,
  `timeout_ms`) and `system` / `informational` (`content`, `level` info | notice | suggestion | warning,
  `tool_use_id`, `prevent_continuation`, `tag`) — schemas from the CLI's own code (claude.exe 2.1.312); a refusal's
  "informational" notice was also seen live. Switch `state.notices` (emitted before the next query's first model
  call; their real moments — a hook, a context warning — not probed).
- Not needed: cache tokens of the simulator's own - the CLI passes the API's counts on as they come (the probe's stub
  set them; the CLI marks `cache_control` on two system blocks and the newest message) and what is cached is the
  API's doing; a test that needs them sets `state.usage`.
- Not yet as the original: the `system` / `thinking_tokens` event (`estimated_tokens`, `estimated_tokens_delta`) the
  CLI emits as a thinking block streams ("usage-thinking": 4 for "Let me think.", after `message_start`) — its rule
  over longer thinking not probed; whether the API itself sends `output_tokens_details` in `message_start`, in
  `message_delta` or both (the stub chose; the simulator sends it in the delta); a `message_delta` that repeats the
  input side (the simulator's carries the output alone). The CLI's own refusal of a call whose previous call's context
  exceeds the model's window ("usage-two-calls" on Haiku 4.5, the first run: 500 061 of 200K — no request, "Prompt is
  too long", `invalid_request` with no status, terminal reason `blocking_limit`) is not modelled: the second call is
  sent.
- Tests: `simulators-regression` (usage as CLI 2.1.312 counts it; an error result reports the calls' usage; "the
  stream of a model call as CLI 2.1.312 passes its usage on"), every chat test.

### Tool results
- Original: CLI 2.1.312 (the tool-result probe; live probe 53): the
  record of an MCP result is a `user` record with `message.content: [{ tool_use_id, type: "tool_result", content:
  [blocks] }]` — text alone too is an array of text blocks, not a string —, `toolUseResult` the same blocks,
  `sourceToolAssistantUUID` the record of the call; an image is an `image` block, and the CLI saves it under the
  session's `tool-results` folder and adds a text block "[Image: source: <file>]". The stream's `user` event carries
  the same content, `tool_use_result` and `tool_result_meta`. Before each model call a `system` event `status:
  "requesting"`.
- Simulator: `chat` (tool steps), `blockOfMcp`, `modelCall` (status).
- Tests: `simulators-regression` (a tool step; a tool's image), tool-media.

## The machine

### A second OpenCode server on the machine
- Original: OpenChamber's OpenCode server and `opencode` in a terminal run side by side, each loading the plugin in
  its own process: the same plugin data folder (`$XDG_DATA_HOME/opencode-claude`: sessions.json, the windows cache,
  the CLI update record, debug.log), the same Claude profile and the same `claude` on PATH, one OpenCode database
  (each server writes every message there as it is accepted and as its answer streams). A server is also stopped
  (OpenCode exits, its instances disposed) or killed (Task Manager, a crash: TerminateProcess on Windows - nothing
  more runs in it; the processes it started run on).
- Simulator: `world.secondProcess({ tree, clockShiftMs, env })` - `test/simulators/second-process.ts` in a Bun
  process of its own: a world on the first one's machine (`createWorld(label, { machine })`: its data, profile,
  `bin` with the same CLI install - its state and log shared, `claude.installCli(dir, { existing })` -, home,
  rate-limit store and project folder), its own OpenCode simulator, Claude Code simulator and plugin modules (the
  build in `tree`, default the tree under test). Driven over IPC: `call(path, ...args)` (a function of its world:
  `"opencode.say"`, `"opencode.turn"`, `"claude.cli.set"`, `"claude.queries.at"`), `set(path, fields)`,
  `start(options, { directory })` / `stop(id)` (a plugin instance), `module(name, fn, ...args)`, `journal()`;
  `exit()` (OpenCode exits: instances disposed, its exit code), `kill()` (at once; a request then pending fails
  with the process's end). Its message ids follow the first process's (`OPENCODE_CLAUDE_WORLD_ID_BASE`), as two
  servers' ids on one database never meet.
- Switches: `clockShiftMs` - its clock runs that far from the machine's (`Date.now()`, `new Date()` of everything in
  it, the plugin's too; negative: a process that ran earlier - what it writes carries its time: a claim of the CLI
  update a minute or twelve minutes old, a windows cache saved a day ago; positive: a clock that later moved back);
  `env` - variables over the machine's before its plugin loads (an interval, a PATH order); `killAtWrite(file)`,
  `holdAtWrite(file)` - below.
- Not yet as the original: the two OpenCode simulators do not share one live database: a test hands one server's
  over (`opencode.database()` / `openDatabase`, below); chats a test makes in both need ids of its own (each
  simulator numbers `ses_<n>` from 1); the clock shift moves `Date` only - timers, `performance.now()` and the
  file times the system stamps run as they do.
- Tests: `simulators-regression` ("a second process on the same machine"), issue-two-servers (the two servers'
  writes meet, then each one's chats in a server started afresh), issue-cases 5a; for the
  claims of another process and the old claims of cli-update, a scratch run on the tree of the CLI auto-update
  change (not kept as a test).

### A server killed while it rewrites a file
- Original: the killed-write probe (Windows, bun
  1.3.13, 29.10.2026): a process rewriting a JSON file of 20 KB, 300 KB and 3 MB with `writeFileSync` (main's
  sessions.json is written so, whole, on every streamed event), killed at a random moment, 100 times each: the file
  whole (91-94) or empty (6-9) - truncated, nothing of the new content written; never a part of it.
- Simulator: `killAtWrite(file)` of a second process (`second-process-fs.ts`): its plugin modules import `node:fs`
  through a module that is the real one except at the armed file's next write - `writeFileSync` truncates it and the
  process kills itself (TerminateProcess), a `renameSync` onto it does not happen (the file before and the temporary
  one stay, as a kill before the rename leaves them).
- Not needed: a part of the file (a power cut, a full disk) - no kill left one; no test asks for it.
- Tests: `simulators-regression` ("a server killed while it rewrites a file"), issue-cases 5a.

### A server paused while it rewrites a file
- Original: the system stops running a process at any moment and runs another (a loaded machine, one core for
  several servers): one stopped right after `writeFileSync` truncated a file leaves it empty for as long as it stands,
  then writes its content - made from what it read before. Two servers with main's plugin rewrite one sessions.json
  so (read, change, write, all synchronous): a read by the other server meanwhile finds the file empty (JSON that does
  not parse: an empty store), its write keeps its own chats only, and the paused server's write then drops what the
  other wrote. Under load the meeting happened by itself: issue-two-servers on main lost 0 to 68 chats of 80 with
  turns of both servers at once (runs of 29-30.10.2026), the first version of that test.
- Simulator: `holdAtWrite(file)` of a second process (`second-process-fs.ts`): at the armed file's next
  `writeFileSync` the file is truncated and the whole process waits (the plugin's write is synchronous, nothing else
  of it runs) until the test's `release()`; then the write goes on as it was called. A `renameSync` onto the file
  waits before the rename. The test sees the pause begin by `held()` (a flag file; nothing of the process answers
  meanwhile); a pause left a minute ends by itself.
- Tests: issue-two-servers.

### OpenCode's database across servers
- Original: OpenCode 2.0.32 keeps sessions and messages in its database; the next server (a restart, another one on
  the machine) shows them as they were, an answer that was streaming as far as it got.
- Simulator: `opencode.database()` (every session and its messages, plain data) and `opencode.openDatabase(saved)`
  (the next server on it: the chats under their own ids, new ids and chats after them). A test takes the database
  of the server it is about to kill (`other.call("opencode.database")`) and opens it in the next one.
- Tests: `simulators-regression` ("... the next server opens its database"), issue-two-servers, issue-cases 5a.

### An older release before the tree under test
- Original: the user ran a released version (1.3.0, main 1.6.0) and upgrades: OpenCode stops it and loads the new
  one on the same folders - the record, the menu and the caches the old one left.
- Simulator: `releaseTree(ref)` - the release's tree, a detached checkout in temp/trees/<ref> of the tests'
  checkout made on first use (`git worktree add --detach`, node_modules a junction to that checkout's: SDK
  0.3.300); `world.build(dir)` - its modules in this process, its proxy's query starter the world's (its own real
  starter behind the guard); `opencode.startPlugin(options, { setup: build.setup })` runs it, `stopPlugin` stops it,
  then `startPlugin()` the tree under test. A release in another server (its own process, its own start):
  `world.secondProcess({ tree: releaseTree(ref) })`.
- Tests: `simulators-regression` ("an older release before the tree under test"), legacy-boundaries-main (v1.3.0),
  migration (v1.6.0).

### A copy of the whole plugin
- Original: OpenCode 2.0.32 loads a local plugin through `@opencode/plugin` 2.0.32 `source.bun.js`
  (`prepareSource`, read in the package's code): it walks the entry's
  imports, deletes every local file (not under node_modules) from the module registry (`require.cache`, ESM too in
  Bun) and imports the entry again - every module of the plugin evaluated afresh, the packages (the SDK) shared.
  Each project folder has its own plugin sources (`createPluginSources` per location), so its own copy; a changed
  file another one. Checked in Bun 1.3.13 (a probe of two local modules): after the deletion an import gives
  fresh instances of the module and of its local imports; the old instances live on where they are held.
- Simulator: `pluginCopy(dir?)` (the same walk and deletion, returns the copy's modules by name);
  `world.build(world.dir, { copy: true })` - the copy with the world's starter, `setup` for an instance of a folder.
  A plain `pluginModule(name)` afterwards gives the latest copy's module, as the registry then holds it.
- Tests: `simulators-regression` ("a copy of the whole plugin").
