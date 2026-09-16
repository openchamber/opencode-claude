import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const summaryPrompt = [
  "Here is the conversation so far:",
  "<conversation>old work</conversation>",
  "Here is the summary of the conversation before the <conversation> above:",
  "<prior-summary>compacted work</prior-summary>",
  "The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both.",
  "Output exactly the Markdown structure shown inside <template>",
].join("\n");

const dataHome = mkdtempSync(join(homedir(), "opencode-claude-data-"));
const claudeConfigDir = mkdtempSync(join(homedir(), "opencode-claude-config-"));
const oldSessionId = "old-claude-session";
const sessionKey = "compaction-boundary-regression";
mkdirSync(join(claudeConfigDir, "projects", "fixture"), { recursive: true });
writeFileSync(
  join(claudeConfigDir, "projects", "fixture", `${oldSessionId}.jsonl`),
  "",
  "utf8",
);

const previousDataHome = process.env.XDG_DATA_HOME;
const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.XDG_DATA_HOME = dataHome;
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

const { clearForeignSessionId, getForeignSessionId, setForeignSessionId } =
  await import("../src/session-store.ts");
const {
  getClaudeProxyBaseUrl,
  setClaudeQueryStarter,
  startProxy,
  stopProxy,
} = await import("../src/proxy.ts");

const resumes: Array<string | undefined> = [];
const prompts: Array<string | AsyncIterable<unknown>> = [];
setForeignSessionId(sessionKey, oldSessionId);
setClaudeQueryStarter(async (params) => {
  resumes.push(params.resume);
  prompts.push(params.prompt);
  return {
    stream: (async function* (): AsyncGenerator<unknown, void, unknown> {
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "ok" },
        },
      };
    })(),
    interrupt: async () => {},
    close: () => {},
    getPid: () => null,
  };
});

await startProxy();
try {
  const post = async (
    messages: Array<{ role: string; content: string }>,
  ): Promise<Response> =>
    fetch(`${getClaudeProxyBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": sessionKey,
      },
      body: JSON.stringify({ model: "sonnet", stream: false, messages }),
    });

  const summaryResponse = await post([{ role: "user", content: summaryPrompt }]);
  assert.equal(summaryResponse.status, 200);
  assert.equal(
    getForeignSessionId(sessionKey),
    undefined,
    "summary boundary must retire the old Claude session binding",
  );
  assert.deepEqual(resumes, [undefined]);

  const continuationResponse = await post([
    { role: "assistant", content: "compacted work" },
    { role: "user", content: "continue after compaction" },
  ]);
  assert.equal(continuationResponse.status, 200);
  assert.deepEqual(resumes, [undefined, undefined]);
  const continuationPrompt = await firstPromptText(prompts[1]);
  assert.match(
    continuationPrompt,
    /<conversation_history>[\s\S]*compacted work[\s\S]*<\/conversation_history>/,
  );
} finally {
  setClaudeQueryStarter(null);
  await stopProxy();
  clearForeignSessionId(sessionKey);
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
}

async function firstPromptText(prompt: string | AsyncIterable<unknown>): Promise<string> {
  if (typeof prompt === "string") return prompt;
  const next = await prompt[Symbol.asyncIterator]().next();
  return JSON.stringify(next.value);
}
