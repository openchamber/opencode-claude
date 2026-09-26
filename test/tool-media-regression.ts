/**
 * Regression: images and PDFs from OpenCode tool results reach Claude as MCP
 * image / resource blocks when a parked turn resumes, including media that
 * OpenCode promoted into its synthetic "Attached media from tool result:"
 * user message. (Ported from the fork's 906cb03 + 62a8f7c.)
 *
 * Run: bun test/tool-media-regression.ts
 */
import {
  assert,
  bashTool,
  callTool,
  mockHandle,
  startMockedProxy,
  textDelta,
} from "./helpers.ts";

const png = "iVBORw0KGgo=";
const pdf = "JVBERi0xLjQK";

async function main() {
  const {
    openaiToolResultToMcpContent,
    SYNTHETIC_TOOL_MEDIA_PROMPT,
    isSyntheticToolMediaMessage,
    collectSteering,
    latestUserPrompt,
  } = await import("../src/prompt.ts");

  // OpenCode 2.x promotes tool media as a text-less user message right after
  // the tool results. It is tool output, not a message from the user: no
  // steering, and the prompt stays the user's real request.
  {
    const messages = [
      { role: "user", content: "Take a screenshot of the page" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "Image read successfully" },
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] },
    ];
    assert.equal(isSyntheticToolMediaMessage(messages[3]!, messages[2]!), true);
    assert.deepEqual(collectSteering(messages as any), []);
    assert.equal(latestUserPrompt(messages as any), "Take a screenshot of the page");
    // A text-less image the user sends outside a tool step is still theirs.
    assert.equal(isSyntheticToolMediaMessage(messages[3]!, messages[0]!), false);
  }

  // The MCP result shape uses { data, mimeType }, not Anthropic's { source }.
  assert.deepEqual(
    openaiToolResultToMcpContent([
      { type: "text", text: "Image read successfully" },
      { type: "file", file: { filename: "pixel.png", file_data: `data:image/png;base64,${png}` } },
    ]),
    [
      { type: "text", text: "Image read successfully" },
      { type: "image", data: png, mimeType: "image/png" },
    ],
  );
  // PDFs become embedded resource blobs; URL media degrades to a text note.
  assert.deepEqual(
    openaiToolResultToMcpContent([
      { type: "file", file: { filename: "doc.pdf", file_data: `data:application/pdf;base64,${pdf}` } },
      { type: "image_url", image_url: { url: "https://example.com/a.png" } },
    ]),
    [
      {
        type: "resource",
        resource: { uri: "opencode://tool-result/attachment-1.pdf", mimeType: "application/pdf", blob: pdf },
      },
      {
        type: "text",
        text: "[Image attachment could not be relayed inline; source URL: https://example.com/a.png]",
      },
    ],
  );
  assert.deepEqual(openaiToolResultToMcpContent("plain"), [{ type: "text", text: "plain" }]);

  const { post, proxy } = await startMockedProxy("media");

  // Mock turn: call bash, capture the MCP result Claude receives, finish.
  async function run(session: string, toolContent: unknown, after: unknown[]) {
    let received: Array<Record<string, any>> | null = null;
    proxy.setClaudeQueryStarter(async (params) =>
      mockHandle(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: `${session}-sess` };
          const res = await callTool(params, "bash", { command: "cat" });
          received = res.content;
          yield { type: "user", message: { role: "user", content: [] } };
          yield textDelta("DONE");
          yield { type: "result", is_error: false, usage: {} };
        })(),
      ),
    );
    const first = (await (await post(session, {
      tools: [bashTool],
      messages: [{ role: "user", content: "read it" }],
    })).json()) as any;
    const call = first.choices[0].message.tool_calls[0];
    const resume = (await (await post(session, {
      tools: [bashTool],
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: toolContent },
        ...after,
      ],
    })).json()) as any;
    assert.match(String(resume.choices[0].message.content), /DONE/);
    return received as Array<Record<string, any>> | null;
  }

  try {
    const inline = await run(
      "media-inline",
      [
        { type: "text", text: "PDF read" },
        { type: "file", file: { filename: "doc.pdf", file_data: `data:application/pdf;base64,${pdf}` } },
      ],
      [],
    );
    assert.deepEqual(inline?.map((b) => b.type), ["text", "resource"]);
    assert.equal(inline?.[1]?.resource.blob, pdf);

    const promoted = await run("media-promoted", "Image read successfully", [
      {
        role: "user",
        content: [
          { type: "text", text: SYNTHETIC_TOOL_MEDIA_PROMPT },
          { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
        ],
      },
    ]);
    assert.deepEqual(promoted, [
      { type: "text", text: "Image read successfully" },
      { type: "image", data: png, mimeType: "image/png" },
    ]);

    const plain = await run("media-none", "exit 0", []);
    assert.deepEqual(plain, [{ type: "text", text: "exit 0" }]);
  } finally {
    proxy.setClaudeQueryStarter(null);
    await proxy.stopProxy();
  }
  console.log("ok — tool media regression passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
