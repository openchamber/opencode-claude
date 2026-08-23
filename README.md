# opencode-claude

[![GitHub stars](https://img.shields.io/github/stars/openchamber/opencode-claude?style=flat&labelColor=100F0F&color=66800B)](https://github.com/openchamber/opencode-claude/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/openchamber/opencode-claude?style=flat&labelColor=100F0F&color=205EA6)](https://github.com/openchamber/opencode-claude/releases/latest)
[![npm](https://img.shields.io/npm/v/%40openchamber%2Fopencode-claude?style=flat&labelColor=100F0F&color=24837B)](https://www.npmjs.com/package/@openchamber/opencode-claude)
[![Discord](https://img.shields.io/badge/Discord-join.svg?style=flat&labelColor=100F0F&color=8B7EC8&logo=discord&logoColor=FFFCF0)](https://discord.gg/ZYRSdnwwKA)
[![License](https://img.shields.io/badge/license-MIT-black?style=flat&labelColor=100F0F&color=EC8B49)](LICENSE)

## Claude Code in OpenCode. Local CLI auth. Agent SDK.

**opencode-claude is the OpenCode plugin for running Claude models — Fable, Opus, Sonnet, and Haiku — from a Claude Pro/Max subscription, with effort variants, tools, attachments, and auto-compact.**

Use Claude from [OpenCode](https://opencode.ai) and [OpenChamber](https://github.com/openchamber/openchamber) without an Anthropic API key. The plugin runs the official Anthropic Agent SDK plus the local `claude` CLI and proxies an OpenAI-compatible `/v1/chat/completions` surface into OpenCode. Claude Code owns authentication; the plugin never reads, copies, refreshes, or sends your credentials itself.

### Official Claude runtime

**Built on Anthropic's official Agent SDK and Claude Code authentication flow. Designed for local, user-operated Claude Code usage.**

No OAuth tokens are extracted, copied, stored, injected, or sent by this plugin. All authentication and model access are performed internally by the official Claude Code runtime. The plugin does not call Anthropic inference endpoints directly and does not impersonate Anthropic API clients.

Sibling plugins: [@openchamber/opencode-cursor](https://github.com/openchamber/opencode-cursor) and [@openchamber/opencode-commandcode](https://github.com/openchamber/opencode-commandcode).

![opencode-claude — Claude Code in OpenCode, local CLI auth, Agent SDK](docs/header.svg)

## What you can do

### Use your local Claude Code login

The OpenCode/OpenChamber sign-in action launches `claude auth login --claudeai` and relays it: the CLI's own sign-in page opens from the host, and the code Claude shows is pasted back into the host, not a separate terminal. The official CLI performs the OAuth exchange and stores its own credentials. The plugin stores no credentials or connection markers in OpenCode; every inference request, including title and summary generation, runs through the Agent SDK.

### Pick models and thinking effort

Aliases `fable` / `opus` / `sonnet` / `haiku` plus pinned ids. Native OpenCode variants `low` → `max` map to Claude `--effort` and adaptive thinking.

### Keep agent loops moving

OpenCode tools bridge as in-process MCP. Calls park and resume instead of deadlocking or inventing output. Streaming, MCP, and sticky Claude session IDs keep follow-ups on the same Agent SDK turn.

### Attachments, compact, and history

Images and PDFs from OpenCode reach Claude (data URLs and remote URLs). Long sessions auto-compact like Claude Code. When a Claude session cannot be resumed, the prior conversation is serialized into the prompt so Claude does not start blind.

### Rate-limit counter

Subscription limit state is tracked with its reset time. `GET /v1/rate-limit` answers when limits return; doomed turns fail fast with 429 and `Retry-After`.

## Quick start

`claude-code` is **not** a built-in OpenCode provider. Install the plugin first, or `opencode auth login --provider claude-code` fails with `Unknown provider "claude-code"`.

### 1. Install the plugin

```bash
npm install -g @openchamber/opencode-claude
```

Or with OpenCode:

```bash
# global (recommended)
opencode plugin @openchamber/opencode-claude -g

# or project-local (writes .opencode/opencode.json)
opencode plugin @openchamber/opencode-claude
```

### 2. Register it in OpenCode

Add (or merge) this into `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@openchamber/opencode-claude"],
  "provider": {
    "claude-code": { "name": "Claude Code" }
  }
}
```

### 3. Authenticate

```bash
claude auth login
opencode auth login --provider claude-code
# pick "Sign in with Claude Code CLI"
```

### 4. Run a Claude model

```bash
opencode run "Summarise this repository in five bullets." --model claude-code/sonnet
```

In the TUI, pick provider **claude-code**, choose a model, and set the **effort** variant (`low` / `medium` / `high` / `xhigh` / `max`) when you want deeper thinking.

### From source (optional)

```bash
git clone https://github.com/openchamber/opencode-claude.git
cd opencode-claude
bun install && bun run build
opencode plugin file://$PWD
```

## Authenticate

| Step | What happens |
| --- | --- |
| **Sign in with Claude Code CLI** | Shown when the CLI is installed: launches the official CLI login and opens the sign-in page the CLI asked for |
| **Install Claude Code CLI and sign in** | Shown only when the CLI is missing: runs the official installer (`npm i -g @anthropic-ai/claude-code`, official install script as fallback), then continues with the sign-in relay |
| Paste the code from the Claude page | Goes straight to the CLI's stdin; the CLI does the token exchange and owns the result |
| `claude auth login --claudeai` | Terminal alternative, always called out in the instructions — also the offered fallback when the CLI is missing (with the install command alongside) |
| Successful verification | Completes without writing to OpenCode's auth store |
| Access expires | Claude Code refreshes its own credentials |

Signing in is either the link and its code or the terminal command — the sign-in page the CLI asks for is the only URL the plugin ever hands to the host.

The plugin does not implement OAuth, inspect Claude credential files, inject tokens, or call Anthropic inference endpoints directly.

## Architecture

```text
OpenCode
  └─ /v1/chat/completions
       └─ Bun.serve proxy (ephemeral port; configured by the plugin)
            └─ Claude Agent SDK query()
                 └─ claude CLI (subscription OAuth)
```

| Layer | Responsibility |
| --- | --- |
| **Plugin hooks** | Provider config, model catalog, effort headers |
| **Proxy** | OpenAI ↔ Agent SDK protocol, tool parking, compact, rate-limit gate |
| **CLI** | Subscription credentials and the Claude Code harness |

Model catalog: aliases `fable` / `opus` / `sonnet` / `haiku` plus pinned ids. Effort selection is encoded in `x-opencode-claude-effort` so the proxy passes the exact `effort` (and adaptive thinking) into the Agent SDK.

### Rate-limit counter

The proxy records Agent SDK `rate_limit_event` telemetry and hard session-limit errors (including the parsed reset time) to `~/.local/share/opencode-claude/rate-limit.json`.

- `GET /v1/rate-limit` → `{ limited, status, rateLimitType, utilization, resetsAt, resetsAtISO, resetInSeconds, message, updatedAt }` — poll this for a "limits reset in …" countdown. `utilization` is only present when the latest SDK event reported it — it is never carried over from an earlier limit window.
- `GET /health` includes a compact `rateLimit` summary.
- While a confirmed hard limit is active, new turns return HTTP **429** with `Retry-After` + `x-claude-rate-limit-reset` headers and an `error.type = "rate_limit_error"` body. The block lifts automatically at reset time; the next turn resumes the same Claude session.
- `OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL=0` disables the 429 gate (turns are attempted and error normally).

## Requirements

- [OpenCode V1](https://opencode.ai) (`@opencode-ai/plugin` 1.18.x). OpenCode V2 is not yet supported because it uses a different plugin API.
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — on `PATH` or installed via the provider's install action (npm is used, or the official install script); the plugin also checks `~/.local/bin` and the npm global bin for a CLI the server PATH cannot see
- Claude plan supported by Claude Code
- Bun (plugin runtime) · Node.js ≥ 18

## Development

```bash
bun install
bun run build
bun run test
```

Debug logging: `OPENCODE_CLAUDE_DEBUG=1`.

Optional knobs:

- `OPENCODE_CLAUDE_PROXY_PORT` — optional pinned proxy port (default: ephemeral / OS-assigned; live URL is published to OpenCode via plugin config)
- `OPENCODE_CLAUDE_CWD` — working directory passed to the Agent SDK
- `OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL` — `0` disables the 429 rate-limit gate
- `OPENCODE_CLAUDE_RATE_LIMIT_STORE` — override the rate-limit store path (tests)
- `OPENCODE_CLAUDE_HISTORY_MAX_CHARS` — budget for transferred conversation history when a Claude session cannot be resumed (default `400000`; newest messages are kept, `0` disables transfer)

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Unknown provider `claude-code` | Install `@openchamber/opencode-claude` and restart OpenCode |
| Claude Code missing from provider list | Confirm `plugin` includes `@openchamber/opencode-claude` and restart OpenCode |
| Authentication error | Run `claude auth login`, verify `claude auth status --json`, then restart OpenCode |
| 429 / rate-limit | Poll `GET /v1/rate-limit` or wait until `resetsAt`; the next turn resumes the same session |
| Tools hang or invent output | Update to the latest plugin — park/resume MCP bridging is required |
| Attachments ignored | Use a current build; image/PDF parts are converted to Claude blocks |

## Release

Publish via GitHub Actions → **Actions → Release → Run workflow**:

| Input | Purpose |
| --- | --- |
| `version` | Explicit semver (`0.6.0`). Empty → use bump |
| `bump` | `minor` (default) / `patch` / `major` |
| `dry_run` | Skip npm publish; create a draft GitHub release |

Requires repo secrets: `NPM_TOKEN`, optional `DISCORD_WEBHOOK_URL`.

Local pin refresh after a release:

```bash
./scripts/update-plugin.sh --dry-run
./scripts/update-plugin.sh
```

## Contributing

Issues and pull requests belong in this repository: [openchamber/opencode-claude](https://github.com/openchamber/opencode-claude).

```bash
bun install
bun run build
bun run test
```

## Acknowledgments

This plugin started as community work around Claude Code in OpenCode. Special thanks to:

- [OpenCode](https://opencode.ai) for the plugin API
- [OpenChamber](https://github.com/openchamber/openchamber) for the workspace that runs this plugin in production
- Anthropic for the Claude Agent SDK and Claude Code CLI
- Contributors who shaped OAuth, the proxy, tools, and compact

## License

[MIT](LICENSE)
