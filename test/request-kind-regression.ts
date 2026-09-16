import assert from "node:assert/strict";
import { detectMetaRequestKind } from "../src/request-kind.ts";

const updateSummaryMessages = [
  {
    role: "user",
    content: [
      "Here is the conversation so far:",
      "",
      "<conversation>",
      "User: Continue the implementation.",
      "</conversation>",
      "",
      "Here is the summary of the conversation before the <conversation> above:",
      "",
      "<prior-summary>",
      "## Objective\n- Continue the implementation",
      "</prior-summary>",
      "",
      "The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both.",
      "",
      "Output exactly the Markdown structure shown inside <template> and keep the section order unchanged.",
    ].join("\n"),
  },
];

assert.equal(detectMetaRequestKind(updateSummaryMessages), "summary");
assert.equal(
  detectMetaRequestKind([{ role: "user", content: "<prior-summary>old</prior-summary>" }]),
  "summary",
);
assert.equal(
  detectMetaRequestKind([
    { role: "system", content: "You are a coding assistant." },
    { role: "user", content: "fix a bug" },
  ]),
  null,
);
