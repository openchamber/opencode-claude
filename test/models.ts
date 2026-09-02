import assert from "node:assert/strict";
import { getClaudeModels } from "../src/models.js";

const models = getClaudeModels();

assert.deepEqual(
  models.find((model) => model.id === "claude-fable-5-1"),
  {
    id: "claude-fable-5-1",
    name: "Fable 5.1",
    reasoning: true,
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
);

console.log("ok — Claude model catalog tests passed");
