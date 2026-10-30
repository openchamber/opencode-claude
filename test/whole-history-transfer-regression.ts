/**
 * Regression: when the plugin hands Claude the chat's history as text (a
 * fork's first turn, a revert the record file does not match, the turns
 * another model answered), the history goes whole, as OpenCode sends it to
 * any model:
 * - the user's images and documents as blocks, in their places;
 * - the files a tool returned right after its result (the list the hooks
 *   get keeps them on the result they belong to), a file that is a result
 *   alone too;
 * - every tool output whole, and no message dropped for length;
 * - the history in OpenCode's form for a serialized part of a conversation
 *   ("The following is a serialized record of this conversation from its
 *   start…", `<recent-context>`), then the latest message as a text of its
 *   own, in the record of the turn's question.
 *
 * On the simulators (test/simulators/): a chat whose answers another model
 * gave (`otherModelAnswer`, one of them a tool step whose read result returned
 * an image), so Claude has no session of it; the user's image and PDF are
 * attachments OpenCode takes from the bytes (`testPng`, a PDF's magic). The
 * next turn goes to the plugin; what Claude got is the query's prompt
 * (`claude.queries`; records without a turn a new transcript may start with,
 * `noTurn`, are not the prompt). Each case is a chat of its own.
 *
 * Run: bun test/whole-history-transfer-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { testPng } from "./simulators/opencode.ts";
import { createWorld, pluginModule } from "./simulators/world.ts";

type Block = { type: string; text?: string; source?: { data?: string; media_type?: string } };

const PDF = Buffer.from("%PDF-1.4\n%simulated spec\n").toString("base64");

async function main() {
  const world = await createWorld("whole-history");
  const { opencode, claude } = world;
  const { userRecordName } = await pluginModule("names");
  const cases = testCases();
  try {
    await opencode.startPlugin();

    await cases.run("the history goes whole: files in their places, outputs whole, nothing dropped for length", async () => {
      const imageUser = testPng("IMAGE-USER");
      const imageTool = testPng("IMAGE-TOOL");
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
        // The list keeps the read's image on its result; the HTTP body sends it in a user message after both results.
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
        ["text", `image:${imageUser}`, "text", `image:${imageTool}`, "text", `document:${PDF}`, "text", "text"],
        "the files in the order of the chat, the latest message after the record",
      );
      const texts = seen.filter((b) => b.type === "text").map((b) => b.text!);
      // Checked by pattern, reported by the tail: the history is 400 000 characters long.
      const holds = (text: string, pattern: RegExp, what: string) =>
        assert.ok(pattern.test(text), `${what}; the text ends with: ${JSON.stringify(text.slice(-300))}`);
      holds(texts[0]!, /^The following is a serialized record of this conversation from its start/, "the record opens the prompt");
      holds(texts[0]!, /OLDEST-QUESTION/, "no message dropped for length");
      holds(texts[0]!, /\[User\]: what is on this screenshot\?\n\[User\]: \[Attached image\/png[^\]]*\]$/, "the user's image right after the user's text");
      holds(
        texts[1]!,
        /^\[Assistant\]: let me look\n\[Assistant tool call\]: read\(\{"filePath":"square\.png"\}\)\n\[Assistant tool call\]: bash\(\{"command":"make"\}\)\n\[Tool result\]: Image read successfully\n\[Attached image\/png[^\]]*\]$/,
        "the tool's image right after its result",
      );
      assert.ok(texts[2]!.includes(`[Tool result]: ${longOutput}`), "the tool output goes whole");
      holds(texts[2]!, /\[Assistant\]: a red square[\s\S]*\[User\]: and this document\?\n\[User\]: \[Attached application\/pdf: spec\.pdf\]$/, "the document after its question");
      holds(texts[3]!, /\[Assistant\]: a spec\n<\/recent-context>$/, "the record ends");
      assert.equal(texts[4], "and now?", "the latest message last");
      assert.ok(!/omitted/.test(texts.join("")), "no note in place of a file or of text");
      assert.ok(query.view.includes(imageUser) && query.view.includes(imageTool), "Claude saw both images");
    });

    await cases.run("a tool result that is a file alone goes as itself right after its result, the history rides the question's record", async () => {
      // Another model ran the tool step, so the chat has no transcript and
      // Claude's first turn carries the history.
      const chat = opencode.newChat();
      await opencode.say(chat, "Q1");
      const png = testPng("HISTORY-IMAGE");
      opencode.otherModelAnswer(chat, "", {
        toolCalls: [{ id: "call_1", name: "bash", input: { command: "cat" } }],
        toolResults: [{ id: "call_1", output: "", files: [{ mime: "image/png", data: png }] }],
        finish: "tool-calls",
      });
      opencode.otherModelAnswer(chat, "A1");
      const q2 = await opencode.say(chat, "Q2");
      const turn = await opencode.turn(chat);
      assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(", ")}`);
      for (const request of turn.requests) assert.doesNotMatch(request.reply?.reasoning ?? "", /did not match this request/, "the list fits the request");
      const query = claude.queries.at(-1)!;
      assert.equal(query.trigger, userRecordName(q2, 1));
      const journal = world.journal();
      assert.ok(journal.some((line) => line.includes("transferring history") && line.includes(chat)), "the journal names the transfer");
      assert.ok(journal.some((line) => line.includes("turn records") && line.includes(chat) && !line.includes('"historyChars":0')), "the history rides the turn's record");
      const [prompt, ...more] = query.input.filter((i) => !i.noTurn);
      assert.equal(more.length, 0, "one prompt");
      const blocks = prompt!.content as Block[];
      assert.ok(Array.isArray(blocks), "a history with a file is blocks");
      assert.deepEqual(blocks.map((b) => b.type), ["text", "image", "text", "text"]);
      assert.match(blocks[0]!.text!, /^The following is a serialized record of this conversation from its start[\s\S]*\[Tool result\]: \[Attached image\/png\]$/);
      assert.equal(blocks[1]!.source?.data, png);
      assert.match(blocks[2]!.text!, /\[Assistant\]: A1\n<\/recent-context>$/);
      assert.equal(blocks[3]!.text, "Q2", "the question after the record");
    });

    await cases.run("no error in the plugin's journal", () => {
      assert.deepEqual(world.journal().filter((line) => /level=error/.test(line)), [], "no error in the plugin's journal");
    });
  } finally {
    await world.dispose();
  }
  cases.done();
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
