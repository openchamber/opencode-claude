/**
 * The images OpenCode took out of a request after the hooks. Over its
 * budget (packages/core/src/session/model-request.ts boundImages: more than
 * 25 MiB of images) it puts its note in place of an image in the body it
 * sends; the hook's list still holds the image. Which images went is read
 * from the body, where the notes stand: no rule of OpenCode's is assumed.
 */
import { extractTextContent, isSyntheticToolMediaMessage, userTextIdentity } from "./prompt.js";

/** The text OpenCode puts in place of an image it removed (model-request.ts IMAGE_REMOVED). */
export const OPENCODE_IMAGE_REMOVED =
  "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]";

type Part = { type?: unknown } & Record<string, any>;
type Message = { role?: string; content?: unknown; tool_call_id?: string };

const isImageType = (mime: unknown) => typeof mime === "string" && mime.toLowerCase().startsWith("image/");

/** A list part that is an image: a user's media, or a file a tool returned. */
function isListImage(part: Part): boolean {
  if (part?.type === "media") return isImageType(part.media?.mediaType ?? part.media?.source?.mediaType);
  return part?.type === "file" && isImageType(part.mime);
}

const note = (): Part => ({ type: "text", text: OPENCODE_IMAGE_REMOVED });

/** How many of OpenCode's notes a text holds. */
function notesIn(text: string): number {
  return text.split(OPENCODE_IMAGE_REMOVED).length - 1;
}

/**
 * The body's user messages that stand for the list's: without the message
 * of a tool's files (the list keeps them on the result) and without a
 * message of a system update alone (the list's `system` entry).
 */
function userMessagesOf(body: readonly Message[]): Message[] {
  return body.filter((message, index) => {
    if (message.role !== "user" || isSyntheticToolMediaMessage(message, body[index - 1])) return false;
    return userTextIdentity(extractTextContent(message.content)) !== "" || Array.isArray(message.content);
  });
}

/**
 * A list user message with the images OpenCode replaced in its body
 * counterpart replaced by its note. The body keeps the message's parts in
 * order, a note in place of a removed image; a message left with text parts
 * alone is one string there: every image of it went.
 */
function userMessageAsSent(message: Message, sent: Message | undefined): Message {
  if (!sent || !Array.isArray(message.content)) return message;
  const parts = message.content as Part[];
  if (typeof sent.content === "string") {
    if (notesIn(sent.content) === 0) return message;
    return { ...message, content: parts.map((part) => (isListImage(part) ? note() : part)) };
  }
  if (!Array.isArray(sent.content)) return message;
  const sentParts = sent.content as Part[];
  let changed = false;
  const content = parts.map((part, index) => {
    const there = sentParts[index];
    if (!isListImage(part) || there?.type !== "text" || there.text !== OPENCODE_IMAGE_REMOVED) return part;
    changed = true;
    return note();
  });
  return changed ? { ...message, content } : message;
}

/**
 * A list tool message with the files OpenCode replaced in each result
 * replaced by its note: the body's tool message of that result (by call id)
 * carries one note per removed file among its texts.
 */
function toolMessageAsSent(message: Message, toolTexts: ReadonlyMap<string, string>): Message {
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const content = (message.content as Part[]).map((part) => {
    const result = part.result as { type?: unknown; value?: unknown } | undefined;
    if (part.type !== "tool-result" || result?.type !== "content" || !Array.isArray(result.value)) return part;
    let left = notesIn(toolTexts.get(String(part.id)) ?? "");
    if (left === 0) return part;
    const value = (result.value as Part[]).map((item) => {
      if (left === 0 || !isListImage(item)) return item;
      left--;
      return note();
    });
    changed = true;
    return { ...part, result: { ...result, value } };
  });
  return changed ? { ...message, content } : message;
}

/**
 * The list as OpenCode sent it in this body: every image the body has a
 * note for, replaced by that note where the body put it.
 */
export function asSentInBody<M extends Message>(list: readonly M[], body: readonly Message[]): M[] {
  const sentUsers = userMessagesOf(body);
  const toolTexts = new Map<string, string>();
  for (const message of body) {
    if (message.role === "tool" && typeof message.tool_call_id === "string") toolTexts.set(message.tool_call_id, extractTextContent(message.content));
  }
  let userIndex = 0;
  return list.map((message) => {
    if (message.role === "user") return userMessageAsSent(message, sentUsers[userIndex++]) as M;
    if (message.role === "tool") return toolMessageAsSent(message, toolTexts) as M;
    return message;
  });
}
