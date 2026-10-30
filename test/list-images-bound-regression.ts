/**
 * Regression: a chat turn's content, read from the context hook's list,
 * holds the images OpenCode sends any other model and no more. Over its
 * budget OpenCode replaces images with a note after the hooks
 * (model-request.ts boundImages); the list still has them. The plugin
 * replaces with the same note the images the body has a note for, where it
 * stands:
 * - no note in the body — the list as it is;
 * - a user's image (a message left with text alone is one string in the
 *   body: all its images went) and a tool's image (a note in its result's
 *   text, the result's own text kept);
 * - a PDF stays: OpenCode leaves it.
 *
 * On the simulators (test/simulators/): OpenCode 2.2.0's bound
 * (`boundImages`: counting the images in order, whenever 25 MiB are passed
 * the oldest become its note until 15 MiB are left; 2.0.32 cut the whole
 * total to 15 MiB; BEHAVIOR.md "Media limits after the hooks"; each case's
 * sizes give the same notes on both). The chat's
 * earlier turns were answered by another model (`otherModelAnswer`, a tool
 * step among them), so the chat has no transcript and Claude's turn carries
 * the whole history: what Claude got is the plugin's content of the turn
 * (`claude.queries[i].input`). A user's image is at most 5 MiB of base64
 * (OpenCode resizes a larger one; the simulator refuses it; a large one here
 * is a small PNG with bytes after its end), so the first
 * message holds two images: the bound then takes every image of the user's
 * and leaves the tool's, or takes the tool's too. Each case is a chat of its
 * own.
 *
 * Run: bun test/list-images-bound-regression.ts
 */
import assert from "node:assert/strict";

import { testCases } from "./simulators/cases.ts";
import { IMAGE_REMOVED, testPng, type Attachment } from "./simulators/opencode.ts";
import { createWorld } from "./simulators/world.ts";

const PDF = Buffer.from("%PDF-1.4\n%simulated\n").toString("base64");
const MiB = 1024 * 1024;

async function main() {
  const world = await createWorld("list-images-bound");
  const { opencode, claude } = world;
  const cases = testCases();
  // The images are megabytes each: what Claude saw keeps them as `[image]`.
  claude.state.viewWithoutImageData = true;
  // A user's image near the size OpenCode passes on unresized: a 1 × 1 PNG
  // with 3.5 MiB after its end (about 4.7 MiB of base64). OpenCode takes its
  // type from the signature and its size from the header; the bound counts
  // the base64.
  const big = (label: string) => Buffer.concat([Buffer.from(testPng(label), "base64"), Buffer.alloc(3.5 * MiB, label)]).toString("base64");
  const small = (label: string) => testPng(label, 1, 1);
  const png = (data: string): Attachment => ({ mediaType: "image/png", data });

  /**
   * The chat: the user's "first" with two images, another model's answer, the
   * user's image and a PDF without text, another model's tool step whose
   * `read` returned "read" and an image, its answer, then the user's "latest"
   * with an image; Claude's turn. Returns the images, documents and notes
   * Claude got, in order, each named by `names` (a note as "note"), and the
   * prompt's text.
   */
  async function turnOf(images: { u1a: string; u1b: string; u2: string; t1: string; u3: string }) {
    const names = new Map<string, string>([
      [images.u1a, "U1a"],
      [images.u1b, "U1b"],
      [images.u2, "U2"],
      [images.t1, "T1"],
      [images.u3, "U3"],
      [PDF, "PDF1"],
    ]);
    const chat = opencode.newChat();
    await opencode.say(chat, "first", [png(images.u1a), png(images.u1b)]);
    opencode.otherModelAnswer(chat, "A1");
    await opencode.say(chat, "", [png(images.u2), { mediaType: "application/pdf", data: PDF, name: "spec.pdf" }]);
    opencode.otherModelAnswer(chat, "", {
      toolCalls: [{ id: "c1", name: "read", input: {} }],
      toolResults: [{ id: "c1", output: "read", files: [{ mime: "image/png", data: images.t1 }] }],
      finish: "tool-calls",
    });
    opencode.otherModelAnswer(chat, "A2");
    await opencode.say(chat, "latest", [png(images.u3)]);
    const from = claude.queries.length;
    const turn = await opencode.turn(chat);
    assert.ok(turn.ok, `the turn answered: ${turn.requests.map((r) => r.status).join(",")}`);
    assert.equal(turn.requests.length, 1, "one request");
    assert.equal(claude.queries.length - from, 1, "one query");
    assert.doesNotMatch(turn.requests[0]!.reply?.reasoning ?? "", /did not match this request/, "the list fits the request");
    const ofChat = world.journal().filter((line) => line.includes(`"conversationKey":"${chat}"`));
    // A journal line names the transfer: a new transcript's history, or the history put before the prompt.
    assert.ok(ofChat.some((line) => /transferring history|injecting transferred conversation history/.test(line)), "the journal names the history transfer");
    const prompts = claude.queries[from]!.input.filter((message) => !message.noTurn);
    assert.equal(prompts.length, 1, "one prompt");
    const blocks = prompts[0]!.content as Array<{ type: string; text?: string; source?: { data?: string } }>;
    assert.ok(Array.isArray(blocks), "a prompt of blocks");
    const seen: string[] = [];
    let text = "";
    for (const block of blocks) {
      if (block.type === "image" || block.type === "document") seen.push(names.get(String(block.source?.data)) ?? "unknown");
      if (block.type === "text") {
        seen.push(...Array.from({ length: block.text!.split(IMAGE_REMOVED).length - 1 }, () => "note"));
        text += block.text;
      }
    }
    return { seen, text, request: turn.requests[0]! };
  }

  try {
    await opencode.startPlugin();

    await cases.run("no image missing from the body: the content is the list", async () => {
      const { seen, request } = await turnOf({ u1a: small("U1a"), u1b: small("U1b"), u2: small("U2"), t1: small("T1"), u3: small("U3") });
      assert.ok(!JSON.stringify(request.body.messages).includes(IMAGE_REMOVED), "OpenCode removed nothing");
      assert.deepEqual(seen, ["U1a", "U1b", "U2", "PDF1", "T1", "U3"], "the images and documents Claude got, in order");
    });

    await cases.run("the user's oldest images gone from the body: notes where they stood, the PDF left", async () => {
      // 26 MiB: the three large ones go, 12 MiB of the tool's image are left;
      // the first message is text alone in the body.
      const tool = "A".repeat(12 * MiB);
      const { seen, request } = await turnOf({ u1a: big("U1a"), u1b: big("U1b"), u2: big("U2"), t1: tool, u3: small("U3") });
      const users = request.body.messages.filter((m) => m.role === "user");
      assert.equal(typeof users[0]!.content, "string", "the first message is one string in the body: all its images went");
      assert.equal(request.list.filter((m) => m.role === "user")[0]!.content.filter((p) => p.type === "media").length, 2, "the list still holds them");
      assert.deepEqual(seen, ["note", "note", "note", "PDF1", "T1", "U3"], "the images, documents and notes Claude got, in order");
    });

    await cases.run("a tool's image gone from the body too: replaced inside its result, the result's text kept", async () => {
      // The tool's image is larger: 2.2.0, passing 25 MiB at it, drops the three before it and then it, as 15 MiB
      // are still exceeded; 2.0.32 drops the same four from the whole 35 MiB. The latest image is large too.
      const tool = "B".repeat(16 * MiB);
      const { seen, text } = await turnOf({ u1a: big("U1a"), u1b: big("U1b"), u2: big("U2"), t1: tool, u3: big("U3") });
      assert.deepEqual(seen, ["note", "note", "note", "PDF1", "note", "U3"], "the images, documents and notes Claude got, in order");
      // The result's own text after its label, in either form a history takes as text.
      assert.match(text, /(Tool result \(read\):\nread|\[Tool result\]: read)/, "the tool's own text stays");
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
