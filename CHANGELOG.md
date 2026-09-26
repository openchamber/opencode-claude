# Changelog

## 1.1.1 - 2026-09-26

- **Fix: phantom "attachments" while tools run**: OpenCode 2.x sends images a
  tool returns (screenshots, `read` on a PNG) as a text-less message right
  after the tool result. The plugin took it for a message from the user, so
  Claude was told "the user sent attachments" that never arrived. That media
  now counts as part of the tool result.

## 1.1.0 - 2026-09-26

Several fixes in this release were found and first built by Bryan Galdámez
([@JosueGalRe](https://github.com/JosueGalRe)) in his fork; thanks!

- **Fix: messages before your prompt were dropped**: only the newest user
  message reached Claude, so OpenChamber's inline comments, queued messages
  and OpenCode's Plan-mode reminder were lost. Every user message since the
  last reply now reaches Claude, and messages typed while a tool runs arrive
  with its result.
- **Tool results with images and PDFs**: a screenshot or PDF read by a tool now
  reaches Claude instead of a text placeholder.
- **Parallel tool calls**: all tool calls of one Claude reply go to OpenCode at
  once (reads, subagents), instead of one round trip each. Fewer steps also
  means fewer re-reads of the whole context.
- **Subagents stay visible**: the subagent list moves to the front of the task
  tool description, which Claude Code truncates at 2048 characters.
- **Refusals are real errors**: an API refusal before any output is answered
  with its HTTP status and message instead of a 200 with error text.
- **Rate-limit resets**: weekly/dated ("resets Oct 6, 1pm") and hours-only
  resets are parsed, and a limit message without a reset time no longer reuses
  another window's reset (which could block turns for days).
- **No blocking CLI probes**: `claude auth status` and CLI lookups run async,
  so they no longer stall the OpenCode server.
- **Abandoned turns are reaped**: a turn parked on tool calls that never get
  answered is closed after an hour (`OPENCODE_CLAUDE_PARKED_TURN_TTL_MS`),
  and closing a turn now really stops its `claude` process.
- **Security: Claude Code's built-in tools are never enabled**: a turn that
  arrived without OpenCode tools used to get Bash/Edit auto-approved, bypassing
  OpenCode permissions. It now gets no tools.
- **Prompts, t3code-style**: chat turns keep Claude Code's system prompt and
  append a short note that Claude is running in OpenChamber through the
  Claude Code harness. Titles, summaries and generate use a one-line system
  prompt with the task in the user message (~15x smaller than before).
- **Stable model ids and honest names**: models are listed under their
  concrete ids (`claude-opus-5-5[1m]`, `claude-sonnet-5`…), like t3code, so a
  session no longer moves to a new model when the CLI's `opus` alias does.
  Names come from the id ("Opus 5.5"), not the CLI's version-dependent label.
  Sessions that picked a 1.0.0 alias (`opus[1m]`, `sonnet`, `haiku`) need a
  model picked once.
- **Clearer usage log**: `turn usage` shows steps, context per step, and totals.

## 1.0.0 - 2026-09-25

Requires OpenCode 2.x. OpenCode 1.x users stay on 0.14.

- **OpenCode 2.x plugin API**: the provider, its models, the sign-in button
  and request headers are registered through the v2 `{ id, setup }` API. No
  provider block is needed in `opencode.json`; register the plugin under
  `plugins`. `{ "options": { "debug": true } }` turns on the debug log.
- **Model list from Claude Code itself**: models come from the CLI's
  `supportedModels()` for the signed-in account (Opus 5.5, Fable 5.1, Sonnet 5,
  Opus 4.x, Haiku…), cached for the next start. 1M context variants follow the
  same per-family rules as t3code, and effort variants only appear where the
  model accepts them. Ids from earlier versions keep working.
- **Fix: tools lost their parameters**: tool schemas went through a lossy
  JSON Schema → zod conversion, so Claude saw no parameter descriptions, no
  nested fields and no enums, and unknown arguments were dropped. OpenCode's
  schemas now reach Claude verbatim and arguments reach OpenCode intact.
- **Fix: output tokens were undercounted**: usage came from the opening
  snapshot of each API call (output ≈ 1-4 tokens); the final `message_delta`
  count now wins, and thinking tokens are reported separately. Turn stats in
  OpenCode/OpenChamber now show real numbers.
- **Plan-only**: turns are refused when the CLI is signed in with an API key
  or routed to Bedrock/Vertex/Foundry; API keys belong to OpenCode's built-in
  Anthropic provider.
- **Less quota per turn**: chat turns get only OpenCode's tools — the user's
  Claude Code MCP servers and claude.ai connectors are no longer attached.
  Titles and compaction summaries run on Haiku, isolated and unsaved, and a
  compaction starts a fresh Claude session from the compacted history.
- **Stateless generation**: `/api/experimental/generate` requests (no session)
  run as one clean turn: no tools, no user context, nothing persisted.
- **No stray sessions**: title/summary/generate turns no longer land in the
  Claude Code history (`claude --resume`).
- **Security: loopback proxy refuses browser requests**: requests carrying an
  `Origin` header or a non-loopback `Host` get 403, so a web page cannot spend
  the subscription through CSRF or DNS rebinding.
- Per-run token usage (`turn usage`) is written to the debug log.
- README no longer implies Anthropic endorsement.

## 0.13.1 - 2026-08-18

- **Fix: turn stall watchdog** — a Claude turn that went totally silent (dead
  CLI, wedged SDK, stuck compact) held the SSE response open forever, leaving
  the OpenCode session "busy" until the host supervisor force-restarted the
  whole server mid-turn (the 2026-08-18 session hang). Any event gap longer
  than `OPENCODE_CLAUDE_TURN_STALL_MS` (default 10m) now kills the turn and
  answers with a truthful error instead.
- **Fix: client disconnect tears the turn down** — the SSE stream now has a
  `cancel()` handler: when OpenCode aborts the fetch mid-turn, the CLI handle
  is closed and the parked bridge dropped instead of leaking a live CLI
  process nobody can resume.
- **Fix: CLI resolution is memoized** — `resolveClaudeCli` ran synchronous
  process probes (`npm prefix -g`, `claude --version`) on every Agent SDK
  query, hard-blocking the host's event loop for ~1s per turn (worse on the
  managed server, whose PATH lacks `claude`). Resolution is now cached per
  PATH+HOME; only the first query pays.

## 0.13.0 - 2026-08-16

- **Sign in without leaving the host**: the provider sign-in action now relays
  the official CLI flow instead of only launching it. `claude auth login
  --claudeai` runs with piped stdio, its authorize URL is handed to
  OpenCode/OpenChamber to open, and the code Claude shows is pasted in the host
  and written to the CLI's stdin. Success is still the CLI's own exit status,
  and no OAuth, token, or credential handling moves into the plugin.
- **No documentation link in the sign-in flow**: the only URL the provider
  hands out is the CLI's own sign-in page. The Claude authentication docs link
  that previously opened alongside — or instead of — the real page is gone, so
  sign-in is either the link plus its code, or `claude auth login --claudeai`
  in a terminal. The terminal fallback is still offered on its own when the CLI
  is missing or its prompt cannot be read.
- **One-click CLI install**: a new provider action, **Install Claude Code CLI
  and sign in**, runs the official installer (`npm install -g
  @anthropic-ai/claude-code`, with Anthropic's install script as fallback) when
  the CLI is missing and then continues straight into the sign-in relay. The
  regular sign-in method now also prints both install and auth commands in its
  terminal fallback instead of only the auth command.
- **CLI resolution beyond PATH**: the CLI is looked up on PATH first, then in
  the official installer's `~/.local/bin` and the npm global bin, so an
  install that the managed OpenChamber server PATH cannot see is still found.
- **Methods match what the host needs**: the provider lists only **Sign in
  with Claude Code CLI** when `claude` is present, and only **Install Claude
  Code CLI and sign in** when it is missing — the install action is never
  shown to a host that already has a working CLI. The terminal alternative
  (`claude auth login --claudeai`) is always called out in the instructions
  on every path.

## 0.12.0 - 2026-08-15

- **Claude CLI-owned authentication**: removed the plugin's browser OAuth,
  credential-file parsing, token copying, token refresh, and OAuth environment
  injection. The plugin no longer writes an OpenCode connection marker; the
  official Claude Code CLI exclusively owns and reads its credentials. The
  provider sign-in action launches `claude auth login --claudeai`, so users can
  still complete the official browser flow from OpenCode/OpenChamber.
- **Agent SDK-only inference**: title and summary generation now follows the
  same Agent SDK / Claude Code path as normal chats. The plugin no longer sends
  direct requests to Anthropic inference or OAuth endpoints.
- **Reliable utility turns**: title and summary requests run as constrained,
  tool-free Agent SDK turns, preventing repository inspection and agent-style
  responses from leaking into generated session titles.
- **Stable model catalog**: Claude models are available independently of the
  CLI login snapshot, so signing in no longer requires an OpenCode restart to
  replace placeholder models.

## 0.11.1

- **Accurate usage for parallel tools**: Claude Agent SDK replays the same
  assistant message while parallel MCP tool results arrive. The plugin now
  counts each SDK assistant message ID once per parked turn, preventing token
  usage from alternating between the real value and an inflated multiple.

## 0.11.0

- **Retry on mid-run limits (both directions)**: the subscription-limit retry
  now fires not only when a new user request is captured (429 + `Retry-After`
  from the gate) but also when the limit lands mid-turn while the agent is
  already responding. A mid-run `error: "rate_limit"` synthetic assistant
  event, error result, or iterator throw records the reset into the shared
  store and surfaces a retryable OpenAI stream error (or a truthful 429 for
  buffered turns), so OpenCode's session retry policy re-runs the turn, reads
  the stored `Retry-After`, and resumes after the countdown — previously the
  run just died with the error as its last message.
- **Connection reset retries**: OpenCode's "Connection reset by server" on
  Claude turns was Bun.serve's default 10s `idleTimeout` killing the socket
  while the proxy probed for first content (no HTTP bytes yet) or while the
  model thought. The listener now disables idle timeout (same as OpenCode's
  own server) and SSE streams emit comment heartbeats during long pauses.
- **Mid-run limit countdown**: when an Agent SDK run exhausted the Claude
  subscription after earlier text or tool work, the synthetic assistant
  `error: "rate_limit"` event was treated as ordinary assistant content. The
  limit store was eventually updated, but OpenCode saw a successful stream and
  never entered its retry/countdown state. Synthetic rate-limit events now
  activate the shared gate immediately and emit a retryable OpenAI stream
  error; OpenCode's retry receives the stored 429 + `Retry-After`, so the reset
  timer starts even when no new user request is made.
- **Test isolation**: the proxy history-injection tests read the host's real
  `rate-limit.json`, so a live confirmed limit on the dev machine gated the
  mocked healthy turns into spurious 429s. The block now uses its own temp
  rate-limit store.

## 0.9.1

- **Fail-fast on dead turns**: a Claude turn that dies before producing any
  content (bad/revoked token, session limit, spawn failure) used to be
  streamed back as a fake-200 response whose only "assistant text" was the
  error message. Hosts retried those turns in a loop, and each retry
  re-sent the entire conversation context to Anthropic — burning quota for
  zero output (observed: ~4% of a weekly usage cap in one incident). The
  proxy now probes the turn before committing the response head and answers
  with a truthful HTTP status: 401 for auth failures, 429 + Retry-After for
  subscription limits (also activating the fast-fail gate), 500 otherwise.
  Errors after content is already streaming stay inline as before.
- **Pre-flight auth check**: with no credentials at all, the proxy returns
  401 immediately instead of spawning a doomed CLI turn.
- **Single-flight token refresh**: OpenCode fires the main turn and the
  title/summary request in parallel; both used to refresh the same OAuth
  token concurrently. Anthropic rotates the refresh token on every use, so
  the loser replayed a stale token — treated as token theft and the whole
  grant got revoked (invalid_grant → revoked chain). Refreshes are now
  deduped per refresh token, run with a 2-minute margin before expiry, and
  re-read the auth store after a rejection (a sibling process may already
  have rotated).
- **Chain ownership**: CLI-synced credentials are tagged (`cli-shared-` /
  `cli-sync-`) and never rotated through the token endpoint by the plugin —
  the CLI stays the sole owner of its chain. Expired CLI credentials are no
  longer synced (they shadowed healthy creds and blocked the CLI's own
  auto-refresh), and a newer `auth.json` entry is never clobbered by older
  CLI creds. The stock `anthropic` provider is no longer seeded with the
  plugin's tokens (two owners of one chain = revoked grant).
- **Model visibility decoupled from the CLI**: the model catalog collapsed
  to `login + sonnet` whenever the CLI was logged out, even with a valid
  plugin-owned OAuth token in `auth.json`. The plugin now reads its own
  `auth.json` entry directly (fallback when the host's auth store lags the
  file) and uses it for both model visibility and token resolution.
- **Wire-identical meta requests**: title/summary requests to the Messages
  API now mirror the real Claude CLI — Claude Code system-prompt preamble as
  the first system block (required for OAuth-gated inference), `claude-cli`
  user-agent, `x-app: cli`, and `anthropic-dangerous-direct-browser-access`
  — so they can never be flagged as non-CLI traffic.

## 0.9.0

- **Stale rate-limit fix**: a fresh `rate_limit_event` with status `allowed`
  but no `utilization` field used to resurrect the previous window's stale
  utilization from `rate-limit.json` — after a limit window reset, normal
  chats could print a bogus "[rate-limit] Claude · five hour · 99% of window
  used · resets in …" note. Utilization is now window-scoped: only what the
  current event reports is stored, and warning notes are driven by the
  triggering event's own status/utilization (never merged history), so a
  healthy `allowed` event is always quiet
- **Conversation-history transfer**: when no Claude session can be resumed
  (first claude-code turn of a chat, switching from another provider/model
  mid-conversation, lost session store), the proxy serialized nothing and
  Claude started blind — answering "no prior context" on long-running chats.
  The prior OpenCode messages are now serialized into the prompt
  (`<conversation_history>` block, newest-first within a 400k char budget,
  tool calls/results condensed, system prompts excluded). Configurable via
  `OPENCODE_CLAUDE_HISTORY_MAX_CHARS` (`0` disables)
- **Dead resume detection**: a stored foreign session id whose Claude
  transcript file is missing (`~/.claude/projects/*/<id>.jsonl`) is dropped
  before the turn instead of producing a context-free fresh session; SDK
  "no conversation found" errors clear the stored binding so the next turn
  self-heals via history transfer
- **Stable fallback conversation key**: `conversationKeyFromMessages` hashed
  the message count into the key, so it changed on every turn and resume
  never matched when the session header was absent; the key is now stable
  across turns of the same conversation

## 0.7.1

- **Rate-limit counter + gate**: structured SDK `rate_limit_event`s and hard
  session-limit errors are recorded to `~/.local/share/opencode-claude/rate-limit.json`
  with the parsed reset time (e.g. "resets 1:10am (Europe/Kyiv)"); new
  `GET /v1/rate-limit` endpoint (plus `/health.rateLimit`) exposes
  `limited / status / utilization / resetsAt / resetInSeconds` so UIs can show
  a live "limits are back" countdown; while a confirmed hard limit is active,
  new turns fail fast with HTTP 429 + `Retry-After` (+ `x-claude-rate-limit-reset`)
  instead of spawning a doomed Agent SDK turn — meta/title requests are never
  gated, and the block self-heals at reset time
  (`OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL=0` disables the gate)
- **Single error emission**: limit/turn failures were streamed twice (SDK
  `result` error event + iterator throw); duplicates are now normalized away,
  the streamed note includes the reset countdown, and token `usage` is
  forwarded even on error results
- **Plan persistence**: `TodoWrite`/`TodoRead` now alias to OpenCode's
  `todowrite`/`todoread` bridge tools, and the OpenCode system-prompt append
  requires writing multi-step plans via `mcp__opencode__todowrite` (text-only
  plans died with the turn) plus batching independent tool calls per turn
- Repo dev config `.opencode/opencode.json` pins the npm package again
  (was a sandbox-only `file:///workspace` path), so `scripts/update-plugin.sh`
  works
- Haiku live matrix: `/v1/rate-limit` shape + recorded-telemetry cases

## 0.7.0

- Proxy port is dynamic by default (ephemeral bind); live `baseURL` is published via config + auth loader. Optional pin: `OPENCODE_CLAUDE_PROXY_PORT`
- Fix file/PDF attachments: accept OpenAI `file.file_data` and seed `modalities.input` with `pdf` so OpenCode does not strip documents
- Fix image attachments: convert AI SDK `{ type: "image" }` parts (previously detected then dropped); tolerate data-URL name params
- Surface OpenAI-compatible `usage` (tokens + cost_usd + model_usage) from Agent SDK result events; richer compact notes with token counts
- Live Haiku matrix (`bun run test:haiku`): attachments, tools/MCP park-resume, session resume, context/usage, OpenCode CLI `--file`
- Logging: warn/error always on stderr; info gated by `OPENCODE_CLAUDE_DEBUG`; durable mirror at `~/.local/share/opencode-claude/debug.log`; config hook no longer dies on proxy bind errors
- README + package description aligned with opencode-cursor style (header, badges, effort docs)
- Effort variants `low`→`max` exposed as OpenCode model variants (disable generic `none`/`minimal`)
- Multimodal prompts: OpenAI `image_url` / file parts → Claude image & document blocks
- Auto-compact enabled; compact boundary events surfaced in the stream
- Static provider config seeds modalities + variants so attachments and effort survive OpenCode's config path

## 0.5.0

- See GitHub releases

## 0.1.0

- Initial `@openchamber/opencode-claude` plugin
- Claude Agent SDK proxy (OpenChamber harness approach)
- Claude CLI credential sync + Pro/Max browser OAuth
- Model catalog with effort variants (`low` → `max`)
- OpenCode tool parking via in-process MCP bridge
- Sticky Claude session resume
