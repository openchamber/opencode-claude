/**
 * Regression: when the plugin hands Claude the chat's history as text (a
 * fork's first turn, a revert the record file does not match, the turns
 * another model answered), the history goes whole, as OpenCode sends it to
 * any model:
 * - the user's images and documents as blocks, in their places;
 * - the files of a step's tool results (OpenCode sends them as one user
 *   message after the results, without saying which result each came
 *   from) as one group after those results;
 * - every tool output whole, and no message dropped for length.
 *
 * On the simulators (test/simulators/): a chat whose answers another model
 * gave (`otherModelAnswer`, one of them a tool step whose read result returned
 * an image), so Claude has no session of it; the user's image and PDF are
 * attachments OpenCode takes from the bytes (`testPng`, a PDF's magic). The
 * next turn goes to the plugin; what Claude got is the query's prompt
 * (`claude.queries`; records without a turn a new transcript may start with,
 * `noTurn`, are not the prompt). The history goes as `<conversation_history>`
 * text ahead of "Latest user message:", the step's files after both results
 * (the form of fix/whole-history-transfer, read from the HTTP body; read
 * from the list, each file right after its own result, in OpenCode's
 * serialized form: whole-history-transfer-regression.ts).
 *
 * Run: bun test/whole-history-transfer-main-regression.ts
 */
import assert from "node:assert/strict";

import { testPng } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

type Block = { type: string; text?: string; source?: { data?: string; media_type?: string } };

const PDF = Buffer.from("%PDF-1.4\n%simulated spec\n").toString("base64");

async function main() {
  const world = await createWorld("whole-history");
  const { opencode, claude } = world;
  const imageUser = testPng("IMAGE-USER");
  const imageTool = testPng("IMAGE-TOOL");
  try {
    await opencode.startPlugin();
    const longOutput = "L".repeat(1_500) + "END-OF-OUTPUT";
    const longQuestion = "Q".repeat(400_000) + " OLDEST-QUESTION";
    // A chat Claude never saw: another model answered every turn, so the history goes as text.
    const chat = opencode.newChat();
    await opencode.say(chat, longQuestion);
    opencode.otherModelAnswer(chat, "noted");
    await opencode.say(chat, "what is on this screenshot?", [{ mediaType: "image/png", data: imageUser, name: "screen.png" }]);
    opencode.otherModelAnswer(chat, "let me look", {
      finish: "tool-calls",
      toolCalls: [
        { id: "c1", name: "read", input: { filePath: "square.png" } },
        { id: "c2", name: "bash", input: { command: "make" } },
      ],
      // OpenCode 2.x sends the step's files, alone, in a user message after the results.
      toolResults: [
        { id: "c1", output: "Image read successfully", files: [{ mime: "image/png", data: imageTool, name: "square.png" }] },
        { id: "c2", output: longOutput },
      ],
    });
    opencode.otherModelAnswer(chat, "a red square");
    await opencode.say(chat, "and this document?", [{ mediaType: "application/pdf", data: PDF, name: "spec.pdf" }]);
    opencode.otherModelAnswer(chat, "a spec");
    await opencode.say(chat, "and now?");
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `the turn answered: ${turn.requests.at(-1)?.status} ${turn.requests.at(-1)?.reply?.raw ?? ""}`.slice(0, 400));

    const query = claude.queries.at(-1)!;
    assert.equal(query.kind, "chat");
    assert.equal(query.params.resume, undefined, "no Claude session to resume");
    // A record without a turn (the start of a new transcript) is not the turn's prompt.
    const input = query.input.filter((m) => !m.noTurn);
    assert.equal(input.length, 1, "one prompt message");
    const content = input[0]!.content;
    const seen: Block[] = typeof content === "string" ? [{ type: "text", text: content }] : (content as Block[]);
    const kinds = seen.map((b) => (b.type === "text" ? "text" : `${b.type}:${b.source?.data}`));
    assert.deepEqual(
      kinds,
      ["text", `image:${imageUser}`, "text", `image:${imageTool}`, "text", `document:${PDF}`, "text"],
      "the files in the order of the chat",
    );
    const texts = seen.filter((b) => b.type === "text").map((b) => b.text!);
    // Checked by pattern, reported by the tail: the history is 400 000 characters long.
    const holds = (text: string, pattern: RegExp, what: string) =>
      assert.ok(pattern.test(text), `${what}; the text ends with: ${JSON.stringify(text.slice(-300))}`);
    holds(texts[0]!, /^<conversation_history>/, "the history opens the prompt");
    holds(texts[0]!, /OLDEST-QUESTION/, "no message dropped for length");
    holds(texts[0]!, /User:\nwhat is on this screenshot\?\n$/, "the user's image right after the user's text");
    holds(texts[1]!, /Tool result \(read\):\nImage read successfully/, "the read result");
    assert.ok(texts[1]!.includes(longOutput), "the tool output goes whole");
    holds(texts[1]!, /Files the tools above returned:\n$/, "the tools' files as one group after both results");
    holds(texts[2]!, /a red square[\s\S]*User:\nand this document\?\n$/, "the document after its question");
    holds(texts[3]!, /a spec\n<\/conversation_history>\n\nLatest user message:\nand now\?$/, "the latest message last");
    assert.ok(!/omitted/.test(texts.join("")), "no note in place of a file or of text");

    assert.ok(query.view.includes(imageUser) && query.view.includes(imageTool), "Claude saw both images");
    assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
  } finally {
    await world.dispose();
  }
  console.log("ok — whole history transfer regression passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
