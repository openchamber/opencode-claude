# opencode-claude

[![npm](https://img.shields.io/npm/v/%40openchamber%2Fopencode-claude?style=flat&labelColor=100F0F&color=24837B)](https://www.npmjs.com/package/@openchamber/opencode-claude)
[![GitHub release](https://img.shields.io/github/v/release/openchamber/opencode-claude?style=flat&labelColor=100F0F&color=205EA6)](https://github.com/openchamber/opencode-claude/releases/latest)
[![Discord](https://img.shields.io/badge/Discord-join.svg?style=flat&labelColor=100F0F&color=8B7EC8&logo=discord&logoColor=FFFCF0)](https://discord.gg/ZYRSdnwwKA)
[![License](https://img.shields.io/badge/license-MIT-black?style=flat&labelColor=100F0F&color=EC8B49)](LICENSE)

Use your Claude Pro or Max plan in [OpenCode](https://opencode.ai) and [OpenChamber](https://github.com/openchamber/openchamber).

The plugin adds a **Claude Code** provider. Pick Opus, Fable, Sonnet or Haiku in OpenCode like any other model, and every request runs through the official [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) on top of the `claude` CLI installed on your machine. No API key, and the plugin never touches your Claude credentials.

This is an independent community project. It isn't affiliated with, endorsed by, or supported by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Terms of use: read this first

Anthropic lets third-party apps use your Claude plan through the Agent SDK. Their guide, [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), says how that usage is counted: it draws from your plan's usage limits, the same as `claude -p`. Anthropic has said the billing for third-party apps may change and that they'll announce it first, so check that page now and then.

The plugin is built to stay inside those rules:

- **Claude Code does all the talking to Anthropic.** The plugin calls the Agent SDK, the SDK runs your local `claude` CLI, and the CLI sends the requests. The plugin makes no calls to Anthropic itself.
- **Your login stays with Claude Code.** Sign-in is `claude auth login`, run by the CLI. The plugin never reads, copies, stores or sends tokens.
- **No disguise.** Claude is told plainly that it runs in OpenChamber (or OpenCode, when OpenChamber didn't start it) through the Claude Code harness, and its tools are named after that app. The plugin doesn't fake headers, rewrite Claude Code's system prompt, or hide that it's a third-party app.
- **One person, one machine.** The proxy the plugin starts listens on `127.0.0.1` only and refuses requests from web pages. Don't expose it or share your plan with other people.
- **Limits are respected.** When your plan hits a limit, you see the real error and the reset time. The plugin doesn't retry into a limit or route around it.
- **Plans only.** If `claude` is signed in with a Console API key, or set up for Bedrock or Vertex, the plugin refuses. For API keys, use OpenCode's built-in Anthropic provider instead.

You're responsible for how you use your own account. If you're unsure whether something is allowed, ask Anthropic.

## How it works

```text
OpenCode / OpenChamber
  │  OpenAI-style chat request
  ▼
opencode-claude  (local proxy on 127.0.0.1)
  │  Claude Agent SDK query()
  ▼
claude CLI  (your login, your plan)
  │
  ▼
Anthropic
```

OpenCode sends the plugin an ordinary chat request. The plugin turns it into an Agent SDK call. Claude Code runs the turn with its own system prompt, and the plugin streams the answer, thinking and tool calls back to OpenCode.

Tools stay OpenCode's. Claude Code's built-in tools (its own Bash, Edit and so on) are switched off. OpenCode's tools are handed to Claude instead, so every file edit and shell command goes through OpenCode and its permissions. When Claude asks for several read-only tools at once, like reads, greps or subagents, they run in parallel.

Each OpenCode chat maps to one Claude Code session and resumes it on every message. That keeps Anthropic's prompt cache warm, which is what makes long sessions affordable on a plan.

## Install

You need [OpenCode](https://opencode.ai) 2.x and the [Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) signed in to a Claude plan. OpenCode 1.x users stay on `@openchamber/opencode-claude@0.14`.

1. Add the plugin:

   ```bash
   opencode plugin add @openchamber/opencode-claude
   ```

   Or add it to `~/.config/opencode/opencode.json` yourself:

   ```json
   { "plugins": ["@openchamber/opencode-claude"] }
   ```

2. Sign in. If you already use Claude Code in a terminal, you're probably signed in. Check with `claude auth status`. Otherwise:

   ```bash
   claude auth login --claudeai
   ```

   You can also sign in from OpenCode or OpenChamber: choose **Claude Code**, then **Sign in with Claude Code CLI**. It opens the same Claude sign-in page and passes the code you paste to the CLI. If `claude` isn't installed, the same menu offers to install it.

3. Restart OpenCode and pick a model under **Claude Code**:

   ```bash
   opencode run "Summarise this repository in five bullets." --model claude-code/claude-sonnet-5
   ```

## Using it

**Models.** The list comes from your own `claude` CLI, so you see what your account can use and it updates when Claude Code does. Opus, Fable and some Sonnet models come in 1M-context versions. Context limits and effort levels show up in OpenCode's model details.

**Keeping the CLI current.** Claude Code only updates itself from its interactive screen, so a CLI used from OpenCode alone would stay on the version it was installed with, and new models would never appear. The plugin runs `claude update` for you, in the background, about once an hour; a new version is picked up by the next chat turn, and its models by the next refresh of the model list. The outcome of the last run is in `~/.local/share/opencode-claude/cli-update.json`. To turn it off, pass `cliAutoUpdate: false` in the plugin options (`{ "package": "@openchamber/opencode-claude", "options": { "cliAutoUpdate": false } }`); Claude Code's own `DISABLE_UPDATES`, `DISABLE_AUTOUPDATER` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` in the server's environment are honoured too. Installs owned by winget, Homebrew or a Linux package manager are left to them.

**Effort.** Pick an effort variant (low, medium, high, xhigh, max) where the model supports it. While Claude thinks, a summary of its reasoning streams into the reasoning block.

**Plan mode.** OpenCode's Plan agent works as usual: Claude is told it's in plan mode, and OpenCode blocks file edits.

**Project instructions.** Claude Code reads `CLAUDE.md` itself, and a project's `AGENTS.md` where there is no `CLAUDE.md` (its `instructionFiles` setting). OpenCode-only instruction files, like `~/.config/opencode/AGENTS.md` or files in `instructions`, are passed on unless Claude Code already reads the same text.

**Skills and agents.** OpenCode's skills (from `.claude`, `.agents` and `.opencode`) are listed for Claude and load through OpenCode's skill tool. A custom agent's own prompt, like a `writer` subagent's, is passed on as that agent's role.

**Titles and summaries.** Session titles run as small one-off requests on Haiku, so they barely touch your limits. Compaction summaries are written by the chat's own model from its Claude session, so they cover the whole conversation with full tool results; most of it comes from the prompt cache. The session itself isn't changed.

**Model fallback.** If Claude Code declines a request on one model and retries on another (for example Fable to Opus), you'll see a note in the reasoning, and the session switches to the model that's actually answering.

## Keeping usage down

Your plan's limits go mostly to context: each step of an agent loop re-reads the whole conversation from cache. A few habits help:

- Start a new session for a new task instead of stretching one session over a day's work.
- Coming back to a long session after a break costs more, because the cache has expired and the whole context is written again.
- Plugins that rewrite OpenCode's history on every turn (context pruning and the like) break the cache and make every turn much more expensive with Claude.
- 1M models compact around 90% of the window. If you don't need the room, the regular versions stay smaller.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| No Claude Code provider in OpenCode | Check that `plugins` in `opencode.json` includes `@openchamber/opencode-claude`, then restart OpenCode |
| Authentication error | Run `claude auth status`. If you're signed out or on an API key, run `claude auth login --claudeai` |
| `claude` works with my company API key in the terminal but not in OpenCode | The plugin only runs on a Claude plan. With an API key or a company gateway you don't need this plugin at all: use OpenCode's built-in Anthropic provider |
| "Model unavailable" on an old session | The model ids changed in 1.1. Pick the model again in that session |
| A rate-limit error with a reset time | Your plan's limit was reached. It clears at the reset time, or on your next message if you reset your limits early |
| Something else | Turn on the debug log (below) and share it in an issue or on Discord |

**Debug log.** Add `"options": { "debug": true }` to the plugin entry:

```json
{ "plugins": [{ "package": "@openchamber/opencode-claude", "options": { "debug": true } }] }
```

The log goes to `~/.local/share/opencode-claude/debug.log`. It records one line per turn with token usage (steps, context per step, cache reads and writes), which is the quickest way to see where your limits go.

## Settings

Most people won't need these. Set them in the environment of the OpenCode server.

| Variable | What it does |
| --- | --- |
| `OPENCODE_CLAUDE_DEBUG=1` | Same as the `debug` option above |
| `OPENCODE_CLAUDE_PROXY_PORT` | Fixed port for the local proxy (default: any free port) |
| `OPENCODE_CLAUDE_CWD` | Working directory for Claude Code, if you need to override the project folder |
| `OPENCODE_CLAUDE_HISTORY_MAX_CHARS` | How much history to replay when a Claude session can't be resumed (default 400000, `0` turns it off) |
| `OPENCODE_CLAUDE_TURN_STALL_MS` | End a turn when Claude Code goes silent this long (default 10 minutes) |
| `OPENCODE_CLAUDE_PARKED_TURN_TTL_MS` | Close a turn waiting on tool results after this long (default 1 hour, `0` never) |
| `OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL=0` | Always send turns to Claude, even when a limit is known to be active |
| `OPENCODE_CLAUDE_DYNAMIC_SECTIONS=keep` | Keep the working directory, memory path and git status in Claude Code's system prompt. By default they go in the first message instead, so every session shares the prompt and a new one reads it from the cache |

## Development

```bash
bun install
bun run build
bun run test
```

To try a local build, point `plugins` at the checkout folder: `{ "plugins": ["/path/to/opencode-claude"] }`.

Releases are cut with the **Release** workflow in GitHub Actions. It bumps the version, runs the tests, tags, and publishes to npm.

Issues and pull requests are welcome at [openchamber/opencode-claude](https://github.com/openchamber/opencode-claude). Sibling plugins: [opencode-cursor](https://github.com/openchamber/opencode-cursor) and [opencode-commandcode](https://github.com/openchamber/opencode-commandcode).

## License

[MIT](LICENSE)
