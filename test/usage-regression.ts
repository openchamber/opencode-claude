import assert from "node:assert/strict";
import {
  addUniqueAssistantUsageState,
  resolveOpenCodeUsage,
  usageFromSdkResult,
  usageFromSdkTurnResult,
} from "../src/usage.ts";

const firstContext = {
  prompt_tokens: 899_900,
  completion_tokens: 100,
  total_tokens: 900_000,
  prompt_tokens_details: { cached_tokens: 899_000 },
};
const secondContext = {
  prompt_tokens: 949_900,
  completion_tokens: 100,
  total_tokens: 950_000,
  prompt_tokens_details: { cached_tokens: 949_000 },
};
const seen = new Set<string>();
const firstState = addUniqueAssistantUsageState(
  { aggregate: null, latest: null },
  firstContext,
  "sdk-context-1",
  seen,
);
const secondState = addUniqueAssistantUsageState(
  firstState,
  secondContext,
  "sdk-context-2",
  seen,
);
const contextUsage = resolveOpenCodeUsage(secondState, null);

assert.equal(contextUsage?.total_tokens, secondContext.total_tokens);
assert.equal(
  contextUsage?.aggregate_usage?.total_tokens,
  firstContext.total_tokens + secondContext.total_tokens,
);
const replayOnlyUsage = resolveOpenCodeUsage(
  { aggregate: null, latest: firstContext },
  {
    prompt_tokens: 1_850_000,
    completion_tokens: 200,
    total_tokens: 1_850_200,
  },
);
assert.equal(replayOnlyUsage?.total_tokens, firstContext.total_tokens);
assert.deepEqual(
  addUniqueAssistantUsageState(
    secondState,
    firstContext,
    "sdk-context-1",
    seen,
  ),
  secondState,
);
const continuationSeen = new Set(["sdk-context-1"]);
const replayedContinuation = addUniqueAssistantUsageState(
  { aggregate: null, latest: firstContext },
  firstContext,
  "sdk-context-1",
  continuationSeen,
);
const continuedState = addUniqueAssistantUsageState(
  replayedContinuation,
  secondContext,
  "sdk-context-2",
  continuationSeen,
);
assert.equal(continuedState.latest?.total_tokens, secondContext.total_tokens);
assert.equal(
  continuedState.aggregate?.total_tokens,
  secondContext.total_tokens,
);

const singleState = addUniqueAssistantUsageState(
  { aggregate: null, latest: null },
  firstContext,
  "sdk-single",
  new Set<string>(),
);
assert.equal(
  resolveOpenCodeUsage(singleState, null)?.aggregate_usage,
  undefined,
);

const resultEvent = {
  type: "result",
  usage: {
    input_tokens: 900,
    output_tokens: 100,
    cache_read_input_tokens: 949_000,
  },
  modelUsage: {
    sonnet: {
      inputTokens: 1_800,
      outputTokens: 200,
      cacheReadInputTokens: 1_848_000,
      cacheCreationInputTokens: 0,
      costUSD: 0.42,
    },
  },
};
assert.equal(usageFromSdkResult(resultEvent)?.total_tokens, 1_850_000);
assert.equal(usageFromSdkTurnResult(resultEvent)?.total_tokens, 950_000);

const {
  getClaudeProxyBaseUrl,
  setClaudeQueryStarter,
  startProxy,
  stopProxy,
} = await import("../src/proxy.ts");
const proxyEvents = [
  {
    type: "assistant",
    message: {
      id: "sdk-proxy-1",
      usage: {
        input_tokens: 900,
        output_tokens: 100,
        cache_read_input_tokens: 899_000,
      },
    },
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "ok" },
    },
  },
  {
    type: "assistant",
    message: {
      id: "sdk-proxy-2",
      usage: {
        input_tokens: 900,
        output_tokens: 100,
        cache_read_input_tokens: 949_000,
      },
    },
  },
  { type: "result", is_error: false, usage: {} },
];
setClaudeQueryStarter(async () => ({
  stream: (async function* () {
    for (const event of proxyEvents) yield event;
  })(),
  interrupt: async () => {},
  close: () => {},
  getPid: () => null,
}));
await startProxy();
try {
  const request = async (stream: boolean, suffix: string): Promise<Response> =>
    fetch(`${getClaudeProxyBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-claude-session": `usage-regression-${suffix}`,
      },
      body: JSON.stringify({
        model: "sonnet",
        stream,
        messages: [{ role: "user", content: "measure usage" }],
      }),
    });

  const bufferedResponse = await request(false, "buffered");
  assert.equal(bufferedResponse.status, 200);
  const bufferedUsage = (await bufferedResponse.json()) as {
    usage?: {
      total_tokens?: number;
      aggregate_usage?: { total_tokens?: number };
    };
  };
  assert.equal(bufferedUsage.usage?.total_tokens, 950_000);
  assert.equal(bufferedUsage.usage?.aggregate_usage?.total_tokens, 1_850_000);

  const streamingResponse = await request(true, "streaming");
  assert.equal(streamingResponse.status, 200);
  const payloads = (await streamingResponse.text())
    .split("\n\n")
    .flatMap((block) => {
      const line = block
        .split("\n")
        .find((candidate) => candidate.startsWith("data: "));
      return line && line !== "data: [DONE]"
        ? [
            JSON.parse(line.slice("data: ".length)) as {
              usage?: {
                total_tokens?: number;
                aggregate_usage?: { total_tokens?: number };
              };
            },
          ]
        : [];
    });
  const usage = payloads.find((payload) => payload.usage)?.usage;
  assert.equal(usage?.total_tokens, 950_000);
  assert.equal(usage?.aggregate_usage?.total_tokens, 1_850_000);

  setClaudeQueryStarter(async () => ({
    stream: (async function* () {
      yield {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "fallback" },
        },
      };
      yield resultEvent;
    })(),
    interrupt: async () => {},
    close: () => {},
    getPid: () => null,
  }));
  const fallbackResponse = await request(true, "result-fallback");
  assert.equal(fallbackResponse.status, 200);
  const fallbackPayloads = (await fallbackResponse.text())
    .split("\n\n")
    .flatMap((block) => {
      const line = block
        .split("\n")
        .find((candidate) => candidate.startsWith("data: "));
      return line && line !== "data: [DONE]"
        ? [
            JSON.parse(line.slice("data: ".length)) as {
              usage?: { total_tokens?: number };
            },
          ]
        : [];
    });
  assert.equal(
    fallbackPayloads.find((payload) => payload.usage)?.usage?.total_tokens,
    950_000,
  );
} finally {
  setClaudeQueryStarter(null);
  await stopProxy();
}
