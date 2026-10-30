/**
 * The OpenCode simulator: OpenCode's side of a chat with the plugin, the way
 * OpenCode 2.2.0 does it (the version OpenChamber 2.5.3 ships; read in its npm
 * packages `@opencode/core` and `@opencode/ai` 2.2.0). Where 2.0.32 (the
 * version before) differs in a way the plugin's branches react to, that
 * behaviour stays behind `state.version = "2.0.32"` (BEHAVIOR.md, "Versions").
 * Every request goes the whole way:
 * 1. the chat's messages become OpenCode's list (runner/to-llm-message.ts):
 *    content always parts; a user message's text, then its attachments
 *    ("Attached file: <path>" before a file from disk, a text file inlined);
 *    an answer, then one `tool` message per result; the checkpoint of a
 *    compaction as OpenCode writes it;
 * 2. the `context` hook (`compaction` for a summary) of every plugin, with
 *    `{ sessionID, model, system, messages, options, agent, tools }`; the
 *    request is built from what the hooks left;
 * 3. `unsupportedParts`, then `boundImages` (more than 25 MiB of images: the
 *    oldest replaced by OpenCode's note until 15 MiB are left);
 * 4. the `model.request` hook: the plugin's address and headers;
 * 5. the list lowered for an OpenAI-compatible provider (openai-chat.ts
 *    lowerMessages): text-only user messages as one string joined without a
 *    separator, a tool step's files as one user message after its results,
 *    a later system message as `<system-update>` text; `stream: true`;
 * 6. HTTP to the plugin, the event stream read back as it arrives; a failed
 *    request sent again by OpenCode's retry rules, each time through the
 *    hooks.
 * A message passes the `prompt` hook when OpenCode accepts it; the metadata
 * the hook leaves goes on the message, and a fork copies it. Compaction,
 * titles and generations go the same way (see BEHAVIOR.md for each, and what
 * is not yet as in OpenCode).
 *
 * On a plugin that registers no `prompt`/`context`/`compaction` hook (main)
 * those steps do nothing, as in OpenCode. A plugin instance runs per
 * directory (`startPlugin(options, { directory })`).
 *
 * Nothing here imports the plugin: `startPlugin` takes its setup.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

/**
 * The OpenCode release the simulator behaves as: 2.2.0, the earlier 2.0.32 where the two differ, or 2.2.1, which is
 * 2.2.0 with the Code Mode section's new wording and heading.
 */
export type OpenCodeVersion = "2.2.0" | "2.2.1" | "2.0.32";
export const DEFAULT_VERSION: OpenCodeVersion = "2.2.0";

// ---- OpenCode's list (to-llm-message.ts) ----

export type ForkBoundary = { type: "before" | "through"; messageID: string };
export type ToolCall = { id: string; name: string; input: Record<string, unknown> };
/** A file a tool returned (Tool.FileContent): base64 or a data URL in `data`. */
export type ToolFile = { mime: string; data: string; name?: string };
/** A file the user attached: base64 `data`; `path` for a file from disk (OpenCode then names it in the text). */
export type Attachment = { mediaType: string; data: string; name?: string; path?: string };
export type Msg = {
  /**
   * `location`: the chat moved to another directory (`text` is the
   * directory); `system`: an instruction update; `shell`: a command the user
   * ran (`text` is the command).
   */
  type: "user" | "assistant" | "synthetic" | "compaction" | "shell" | "skill" | "location" | "system";
  id: string;
  seq: number;
  text: string;
  /** Files the user attached (a user message). */
  files?: Attachment[];
  /** Skills the user attached to the message, loaded (a user message; session-message.ts `skills`). */
  skills?: Array<{ name: string; text?: string }>;
  /** A skill message's skill (`text` is its text). */
  skillName?: string;
  /** What the prompt hook left on the message; a fork copies it. */
  metadata?: Record<string, unknown>;
  /** An answer still being written: not in a request, not copied into a fork. */
  pending?: boolean;
  /** Accepted (the prompt hook ran) but not delivered yet. */
  queued?: boolean;
  /** An answer's reasoning, as the plugin streamed it. */
  reasoning?: string;
  /** An answer's tool step: the calls, their results, and how the step ended. */
  toolCalls?: ToolCall[];
  toolResults?: Array<{ id: string; output: string; files?: ToolFile[]; error?: boolean }>;
  finish?: "stop" | "tool-calls" | "length";
  /** An answer whose stream broke or was stopped: what was shown stays, with this error. */
  error?: string;
  /** An answer's tokens as the provider reported them (SessionUsage.tokens). */
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  /** An answer of another provider (another model): its tokens are not this provider's measure. */
  otherProvider?: boolean;
  /** A compaction: the summary and the verbatim tail (recent). */
  summary?: string;
  recent?: string;
};
/** An LLM.Message of OpenCode's list, as the hooks get it. */
export type ListMessage = { id?: string; role: "user" | "assistant" | "tool" | "system"; content: Array<Record<string, any>>; metadata?: Record<string, unknown> };

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// ---- attachments as OpenCode takes them (session/prompt.ts 93–220, mime.ts) ----

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** OpenCode's Mime.detect: the type from the bytes; a declared type is not used. */
export function detectMime(bytes: Uint8Array): string {
  const startsWith = (at: Uint8Array, prefix: number[]) => prefix.every((value, index) => at[index] === value);
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  if (startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70]) && (startsWith(bytes.subarray(8), [0x61, 0x76, 0x69, 0x66]) || startsWith(bytes.subarray(8), [0x61, 0x76, 0x69, 0x73]))) return "image/avif";
  if (bytes.length === 0) return "text/plain";
  if (bytes.includes(0)) return "application/octet-stream";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return "application/octet-stream";
  }
  const controls = bytes.reduce((count, byte) => count + Number(byte < 9 || (byte > 13 && byte < 32)), 0);
  return controls / bytes.length <= 0.3 ? "text/plain" : "application/octet-stream";
}

/** The width and height of a PNG (its IHDR); undefined for other bytes. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (detectMime(bytes) !== "image/png" || bytes.length < 24) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/**
 * A real PNG for a test, base64: `width` × `height` pixels of noise seeded by
 * `label` (so two labels make two different images), the label in a tEXt
 * chunk. OpenCode detects it as image/png from its bytes.
 */
export function testPng(label: string, width = 1, height = 1): string {
  let seed = [...label].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 3; x++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      raw[y * (1 + width * 3) + 1 + x] = seed >>> 24;
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.from(`label\0${label}`, "latin1")),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]).toString("base64");
}

/**
 * One attachment as OpenCode takes it: the bytes of a data URL or of the file,
 * at most 20 MiB, the type from the bytes. An image OpenCode would resize
 * (over 2000 × 2000 pixels or 5 MiB of base64; image.ts) is refused here: the
 * simulator has no resizer, and a test must not pass it on unchanged.
 */
function materialize(file: { uri: string; name?: string }, onDisk: Map<string, string>): Attachment {
  const label = file.name ?? (file.uri.startsWith("data:") ? "inline attachment" : file.uri);
  const base64 = file.uri.startsWith("data:") ? file.uri.slice(file.uri.indexOf(",") + 1) : onDisk.get(file.uri);
  if (base64 === undefined) throw new Error(`Unable to read attachment: ${file.uri}`);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit: ${label}`);
  const mediaType = detectMime(bytes);
  if (mediaType.startsWith("image/")) {
    const size = pngSize(bytes);
    if (base64.length > 5 * 1024 * 1024 || (size && (size.width > 2000 || size.height > 2000))) {
      throw new Error(`the simulator cannot resize ${label} as OpenCode would (over 2000 px or 5 MiB): use a smaller image`);
    }
  }
  const path = file.uri.startsWith("file:") ? fileURLToPath(file.uri) : undefined;
  return { mediaType, data: base64, ...(file.name ?? path ? { name: file.name ?? basename(path!) } : {}), ...(path ? { path } : {}) };
}

/** OpenCode's media part of a base64 file (Media.base64). */
export const mediaPart = (data: string, mediaType: string, filename?: string) => ({
  type: "media",
  media: { source: { type: "base64", data, mediaType }, mediaType, kind: mediaType.startsWith("image/") ? "image" : "document" },
  ...(filename !== undefined ? { filename } : {}),
});

const textPart = (text: string) => ({ type: "text", text });

/** The checkpoint a compaction leaves at the start of the context (to-llm-message.ts, `compaction`). */
export function checkpointText(summary: string, recent?: string): string {
  return [
    "<conversation-checkpoint>",
    "The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.",
    "",
    `<summary>\n${summary}\n</summary>`,
    ...(recent ? ["", `<recent-context>\n${recent}\n</recent-context>`] : []),
    "</conversation-checkpoint>",
  ].join("\n");
}

/** The parts of one attachment (attachmentContent). */
function attachmentParts(file: Attachment): Array<Record<string, any>> {
  if (file.mediaType === "text/plain") {
    const lines = [`Attached file: ${file.name ?? file.path ?? "inline attachment"}`, "", Buffer.from(file.data, "base64").toString("utf8")];
    return [textPart(`\n\n${lines.join("\n")}`)];
  }
  if (IMAGE_MIMES.has(file.mediaType) || file.mediaType === "application/pdf") {
    return [...(file.path !== undefined ? [textPart(`Attached file: ${file.path}`)] : []), mediaPart(file.data, file.mediaType, file.name)];
  }
  return [];
}

/** A tool result part (toolResult): one text alone stays text, files make `content`, an error `error`. */
function toolResultPart(call: ToolCall, result: NonNullable<Msg["toolResults"]>[number]) {
  if (result.error) return { type: "tool-result", id: call.id, name: call.name, result: { type: "error", value: { error: result.output, content: [] } } };
  const content = [...(result.output !== "" || !result.files?.length ? [textPart(result.output)] : []), ...(result.files ?? []).map((f) => ({ type: "file", uri: f.data, mime: f.mime, ...(f.name ? { name: f.name } : {}) }))];
  const single = content.length === 1 && content[0]!.type === "text" ? content[0] : undefined;
  return {
    type: "tool-result",
    id: call.id,
    name: call.name,
    result: single ? { type: "text", value: (single as { text: string }).text } : { type: "content", value: content },
  };
}

/** OpenCode's list of these messages: what the hooks get. Answers still being written and queued messages are left out. */
export function toList(messages: Msg[]): ListMessage[] {
  const list: ListMessage[] = [];
  for (const m of messages) {
    if (m.pending || m.queued) continue;
    if (m.type === "compaction") {
      // 2.2.0 loads the kept tail into the checkpoint's metadata (`recent`, beside `keepID`).
      const metadata = typeof m.metadata?.keepID === "string" ? { ...structuredClone(m.metadata), recent: m.recent ?? "" } : m.metadata ? structuredClone(m.metadata) : undefined;
      list.push({ id: m.id, role: "user", content: [textPart(checkpointText(m.summary ?? "", m.recent))], ...(metadata ? { metadata } : {}) });
      continue;
    }
    if (m.type === "assistant") {
      // Parts in the order they streamed (reasoning first); an answer that
      // failed gives its reasoning as text (to-llm-message.ts 153–232).
      const content: Array<Record<string, any>> = [];
      if (m.reasoning) content.push(m.error === undefined ? { type: "reasoning", text: m.reasoning } : textPart(m.reasoning));
      if (m.text) content.push(textPart(m.text));
      for (const call of m.toolCalls ?? []) content.push({ type: "tool-call", id: call.id, name: call.name, input: call.input });
      if (content.length > 0) list.push({ id: m.id, role: "assistant", content, ...(m.metadata ? { metadata: structuredClone(m.metadata) } : {}) });
      for (const call of m.toolCalls ?? []) {
        const result = m.toolResults?.find((r) => r.id === call.id);
        if (result) list.push({ role: "tool", content: [toolResultPart(call, result)] });
      }
      continue;
    }
    if (m.type === "location") {
      list.push({ id: m.id, role: "user", content: [textPart(`The working directory has been changed to ${m.text}.`)], ...(m.metadata ? { metadata: structuredClone(m.metadata) } : {}) });
      continue;
    }
    if (m.type === "synthetic") {
      list.push({ id: m.id, role: "user", content: [textPart(m.text)] });
      continue;
    }
    if (m.type === "system") {
      list.push({ role: "system", content: [textPart(m.text)] });
      continue;
    }
    if (m.type === "shell") {
      const text = `The following shell command was executed by the user:\n\nCommand:\n${m.text}\n\nOutput:\n`;
      list.push({ id: m.id, role: "user", content: [textPart(text)], ...(m.metadata ? { metadata: structuredClone(m.metadata) } : {}) });
      continue;
    }
    if (m.type === "skill") {
      list.push({ id: m.id, role: "user", content: [textPart(m.text)], ...(m.metadata ? { metadata: structuredClone(m.metadata) } : {}) });
      continue;
    }
    // A user message: its skills' texts, its text unless empty, then its attachments; none: no message
    // (to-llm-message.ts; core 2.0.32 chunks/instance-xt4njr3s.js 215).
    const content = [
      ...(m.skills ?? []).flatMap((skill) => (skill.text === undefined ? [] : [textPart(skill.text)])),
      ...(m.text === "" ? [] : [textPart(m.text)]),
      ...(m.files ?? []).flatMap(attachmentParts),
    ];
    if (content.length === 0) continue;
    list.push({ id: m.id, role: "user", content, metadata: structuredClone(m.metadata ?? {}) });
  }
  return list;
}

// ---- after the hooks (model-request.ts unsupportedParts, boundImages) ----

const IMAGE_BYTES_TRIGGER = 25 * 1024 * 1024;
const IMAGE_BYTES_TARGET = 15 * 1024 * 1024;
export const IMAGE_REMOVED =
  "[This image was removed to reduce the request size and is no longer visible. Do not make claims about its contents from memory. If needed, retrieve it again with an available tool or ask the user to attach it again.]";

/** Replaces media with the returned text; messages without replacements are returned unchanged. */
function replaceMedia(messages: ListMessage[], replace: (media: { mime: string; name?: string; bytes: () => number }) => string | undefined): ListMessage[] {
  return messages.map((message) => {
    const content = message.content.map((part) => {
      if (part.type === "media") {
        const data = String(part.media?.source?.data ?? "");
        const text = replace({ mime: String(part.media?.mediaType ?? ""), name: part.filename, bytes: () => Buffer.byteLength(data) });
        return text === undefined ? part : textPart(text);
      }
      if (part.type !== "tool-result" || part.result?.type !== "content") return part;
      const value = (part.result.value as Array<Record<string, any>>).map((item) => {
        if (item.type !== "file") return item;
        const text = replace({ mime: String(item.mime), name: item.name, bytes: () => Buffer.byteLength(String(item.uri)) });
        return text === undefined ? item : textPart(text);
      });
      return value.every((item, index) => item === part.result.value[index]) ? part : { ...part, result: { ...part.result, value } };
    });
    return content.every((part, index) => part === message.content[index]) ? message : { ...message, content };
  });
}

const modalityOf = (mime: string) =>
  mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : mime === "application/pdf" ? "pdf" : undefined;

/** Media the model cannot read becomes an error note (unsupportedParts; the plugin's models take text, image, pdf). */
export function unsupportedParts(messages: ListMessage[], input: string[] = ["text", "image", "pdf"]): ListMessage[] {
  return replaceMedia(messages, (media) => {
    const modality = modalityOf(media.mime);
    if (!modality || input.some((item) => item.startsWith(modality))) return undefined;
    return `ERROR: Cannot read ${media.name ? `"${media.name}"` : modality} (this model does not support ${modality} input). Inform the user.`;
  });
}

/**
 * More than 25 MiB of images: the oldest are replaced by OpenCode's note (boundImages). 2.2.0 counts the images
 * in order and, whenever the running total passes 25 MiB, drops the oldest until 15 MiB are left
 * (model-request.ts boundImages); 2.0.32 dropped the oldest until the whole total was at most 15 MiB.
 */
export function boundImages(messages: ListMessage[], version: OpenCodeVersion = DEFAULT_VERSION): ListMessage[] {
  const isImage = (mime: string) => mime.toLowerCase().startsWith("image/");
  if (version !== "2.0.32") {
    const sizes = messages.flatMap((message) =>
      message.content.flatMap((part) => {
        if (part.type === "media") return isImage(String(part.media?.mediaType ?? "")) ? [String(part.media?.source?.data ?? "").length] : [];
        if (part.type !== "tool-result" || part.result?.type !== "content") return [];
        return (part.result.value as Array<Record<string, any>>).flatMap((item) => (item.type === "file" && isImage(String(item.mime)) ? [String(item.uri).length] : []));
      }),
    );
    let cut = 0;
    let kept = 0;
    for (const size of sizes) {
      kept += size;
      if (kept <= IMAGE_BYTES_TRIGGER) continue;
      while (kept > IMAGE_BYTES_TARGET) kept -= sizes[cut++]!;
    }
    if (cut === 0) return messages;
    let index = 0;
    return replaceMedia(messages, (media) => (!isImage(media.mime) ? undefined : index++ < cut ? IMAGE_REMOVED : undefined));
  }
  let imageBytes = 0;
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "media" && isImage(String(part.media?.mediaType ?? ""))) imageBytes += Buffer.byteLength(String(part.media?.source?.data ?? ""));
      if (part.type === "tool-result" && part.result?.type === "content") {
        for (const item of part.result.value as Array<Record<string, any>>) {
          if (item.type === "file" && isImage(String(item.mime))) imageBytes += Buffer.byteLength(String(item.uri));
        }
      }
    }
  }
  if (imageBytes <= IMAGE_BYTES_TRIGGER) return messages;
  let removed = 0;
  return replaceMedia(messages, (media) => {
    if (!isImage(media.mime) || imageBytes - removed <= IMAGE_BYTES_TARGET) return undefined;
    removed += media.bytes();
    return IMAGE_REMOVED;
  });
}

// ---- lowering for an OpenAI-compatible provider (ai/protocols/openai-chat.ts) ----

const escapeSystemUpdate = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A request OpenCode cannot build for OpenAI Chat: it fails before any HTTP (an invalid request, not retried). */
export class LoweringError extends Error {}

/**
 * A media part as OpenAI Chat takes it (openai-chat.js lowerMedia 237–251,
 * shared.js toolFileMedia 165–173): the data is base64, a data URL (its
 * declared type gives way to `mediaType`) or an http(s) URL. A PDF goes
 * inline as `file` (a PDF by URL cannot); an image as `image_url`, a URL as
 * it is; any other type cannot be sent.
 */
function lowerMedia(data: string, mediaType: string, filename?: string): Record<string, unknown> {
  const mime = mediaType.toLowerCase();
  const isUrl = !data.startsWith("data:") && /^https?:\/\//.test(data);
  const inline = isUrl ? undefined : `data:${mime};base64,${data.replace(/^data:[^,]*,/, "")}`;
  if (mime === "application/pdf") {
    if (!inline) throw new LoweringError("OpenAI Chat requires inline media (bytes or base64); url sources must be materialized first");
    return { type: "file", file: { filename: filename ?? "document.pdf", file_data: inline } };
  }
  if (!mime.startsWith("image/")) throw new LoweringError(`OpenAI Chat does not support media type ${mediaType}`);
  return { type: "image_url", image_url: { url: isUrl ? data : inline } };
}

/** The text of a non-content tool result (shared.ts toolResultText). */
function toolResultText(result: { type: string; value: unknown }): string {
  if (result.type === "text") return String(result.value);
  return JSON.stringify(result.value);
}

/** The body's messages, from the system parts and the list after the hooks (lowerMessages). */
export function lowerMessages(system: Array<{ text: string }>, messages: ListMessage[], modelID: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = system.length === 0 ? [] : [{ role: "system", content: system.map((part) => part.text).join("\n") }];
  const toolCallID = (id: string) => (modelID.toLowerCase().includes("claude") ? id.replace(/[^a-zA-Z0-9_-]/g, "_") : id);
  const pending: Array<Record<string, unknown>> = [];
  const flush = () => {
    if (pending.length > 0) out.push({ role: "user", content: pending.splice(0) });
  };
  for (const message of messages) {
    if (message.role === "system") {
      const text = `<system-update>\n${escapeSystemUpdate(message.content.map((p) => String(p.text ?? "")).join("\n"))}\n</system-update>`;
      if (pending.length > 0) {
        out.push({ role: "user", content: [...pending.splice(0), textPart(text)] });
        continue;
      }
      const previous = out.at(-1);
      if (previous?.role === "user" && typeof previous.content === "string") previous.content = `${previous.content}\n${text}`;
      else if (previous?.role === "user" && Array.isArray(previous.content)) previous.content = [...previous.content, textPart(text)];
      else out.push({ role: "user", content: text });
      continue;
    }
    if (message.role === "assistant" && message.content.every((p) => p.type === "text" && String(p.text).trim() === "")) continue;
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.result?.type !== "content") {
          out.push({ role: "tool", tool_call_id: toolCallID(part.id), content: toolResultText(part.result) });
          continue;
        }
        const value = part.result.value as Array<Record<string, any>>;
        out.push({ role: "tool", tool_call_id: toolCallID(part.id), content: value.filter((v) => v.type === "text").map((v) => v.text).join("\n") });
        for (const file of value.filter((v) => v.type === "file")) pending.push(lowerMedia(String(file.uri), String(file.mime), file.name));
      }
      continue;
    }
    flush();
    if (message.role === "user") {
      const content = message.content.map((p) => (p.type === "media" ? lowerMedia(String(p.media?.source?.data ?? ""), String(p.media?.mediaType ?? ""), p.filename) : textPart(String(p.text ?? ""))));
      out.push({ role: "user", content: content.every((p) => p.type === "text") ? content.map((p) => (p as { text: string }).text).join("") : content });
      continue;
    }
    const texts = message.content.filter((p) => p.type === "text").map((p) => String(p.text));
    const reasoning = message.content.filter((p) => p.type === "reasoning").map((p) => String(p.text));
    const calls = message.content.filter((p) => p.type === "tool-call");
    out.push({
      role: "assistant",
      content: texts.length === 0 && calls.length > 0 ? null : texts.join(""),
      ...(calls.length > 0
        ? { tool_calls: calls.map((c) => ({ id: toolCallID(c.id), type: "function", function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) } })) }
        : {}),
      ...(reasoning.length > 0 ? { reasoning_content: reasoning.join("") } : {}),
    });
  }
  flush();
  return out;
}

/** OpenAI-form tools of the request (lowerTool): the plugin's provider takes `strict: false`. */
export type ToolDefinitions = Record<string, { description: string; input: Record<string, unknown> }>;
const lowerTools = (tools: ToolDefinitions) =>
  Object.entries(tools).map(([name, t]) => ({ type: "function", function: { name, description: t.description, parameters: t.input, strict: false } }));

/** The generation options a hook may set (ai schema/options.js GenerationOptions); other keys are the provider's. */
export type Generation = { maxTokens?: number; temperature?: number; topP?: number; topK?: number; frequencyPenalty?: number; presencePenalty?: number; seed?: number; stop?: string[] };
const GENERATION_KEYS = new Set(["maxTokens", "temperature", "topP", "topK", "frequencyPenalty", "presencePenalty", "seed", "stop"]);
/** The generation part of a hook's `options` (model-request.ts 277–279). */
export const generationOf = (options: Record<string, unknown>): Generation =>
  Object.fromEntries(Object.entries(options).filter(([key]) => GENERATION_KEYS.has(key))) as Generation;

/**
 * The HTTP body (openai-chat.js fromRequest), for the plugin's provider at a local address. `store: false` only on
 * 2.0.32: 2.2.0 sends `store` to OpenAI and Azure alone (detectSupportsStore). `parallel_tool_calls` is not sent: the
 * plugin's model options set none (resolveParallelToolCalls).
 */
export function requestBody(input: { modelID: string; system: Array<{ text: string }>; messages: ListMessage[]; tools: ToolDefinitions; generation?: Generation; version?: OpenCodeVersion }) {
  const hasToolHistory = input.messages.some((m) => m.role === "tool" || (m.role === "assistant" && m.content.some((p) => p.type === "tool-call")));
  const tools = lowerTools(input.tools);
  const generation = input.generation ?? {};
  return {
    model: input.modelID,
    messages: lowerMessages(input.system, input.messages, input.modelID),
    tools: tools.length === 0 ? (hasToolHistory ? [] : undefined) : tools,
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: generation.maxTokens,
    temperature: generation.temperature,
    top_p: generation.topP,
    frequency_penalty: generation.frequencyPenalty,
    presence_penalty: generation.presencePenalty,
    seed: generation.seed,
    stop: generation.stop,
    ...(input.version === "2.0.32" ? { store: false } : {}),
  };
}

// The default output limit (model-request.ts outputLimit).
const OUTPUT_TOKEN_FALLBACK = 32_000;
const OUTPUT_TOKEN_MAX = 256_000;
const SUMMARY_OUTPUT_MAX = 32_000;
const ESTIMATE_ERROR = 0.15;
const OUTPUT_TOKEN_MIN = 1_024;
/**
 * The catalog's output limit fitted to the room the prompt leaves in the window (`inputTokens`: measured by the
 * provider, estimated). 2.0.32 capped a summary's at 32 000 (SUMMARY_OUTPUT_MAX); 2.2.0 does not.
 */
export function outputLimit(
  limit: { output?: number; context?: number } | undefined,
  kind: "primary" | "compaction",
  inputTokens?: { measured: number; estimated: number },
  version: OpenCodeVersion = DEFAULT_VERSION,
): number {
  const output = limit?.output ?? 0;
  const context = limit?.context ?? 0;
  const model = Math.min(output > 0 ? output : OUTPUT_TOKEN_FALLBACK, OUTPUT_TOKEN_MAX);
  const requested = kind === "compaction" && version === "2.0.32" ? Math.min(model, SUMMARY_OUTPUT_MAX) : model;
  if (inputTokens === undefined || context <= 0) return requested;
  const room = context - inputTokens.measured - Math.ceil(inputTokens.estimated * (1 + ESTIMATE_ERROR));
  return Math.min(requested, Math.max(OUTPUT_TOKEN_MIN, room));
}

/**
 * The tools after the hooks (model-request.ts 268–276): a definition the hook
 * kept (by identity, even under a new name) or one under a real tool's name
 * stays, with the hook's description and schema; a tool the hook invented is
 * dropped.
 */
export function toolsAfterHooks(given: ToolDefinitions, hooked: ToolDefinitions): ToolDefinitions {
  const byDefinition = new Map(Object.entries(given).map(([name, definition]) => [definition, name] as const));
  return Object.fromEntries(
    Object.entries(hooked ?? {}).filter(([name, definition]) => byDefinition.has(definition) || name in given),
  );
}

/** What came back from the plugin: the answer as OpenCode reads it from the event stream (or a JSON body). */
export type Reply = {
  status: number;
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finish?: string;
  /** An error in the stream or the body. */
  error?: unknown;
  usage?: unknown;
  /** The raw body of a failed request. */
  raw?: string;
  headers: Headers;
  /** The stream broke (or the user stopped it) before it ended: what came until then is in the reply. */
  streamError?: unknown;
};

/** Whether the plugin's answer had started when its stream ended (publisher.record().outputStarted). */
export const outputStarted = (reply: Reply) => reply.text !== "" || reply.reasoning !== "" || reply.toolCalls.length > 0;

/**
 * Reads the plugin's answer as OpenCode does: an SSE stream of
 * chat.completion.chunk read as it arrives (what came before a break or a
 * stop is kept, `streamError` says why it ended), or a JSON body (a failure).
 */
/**
 * A request that timed out (`@opencode/ai` route/transport/http.js 58–81): an
 * AIError TransportError with code "Timeout", retryable; the request is aborted.
 */
export class TransportTimeout extends Error {
  readonly code = "Timeout";
  constructor(readonly phase: "headers" | "data") {
    super(phase === "headers" ? "Timed out waiting for response headers" : "Timed out waiting for response data");
  }
}

/**
 * `onText`: the answer's text so far, after each piece (OpenCode publishes each part as it arrives).
 * `timing.chunkTimeoutMs`: each piece of the stream within this many ms of the one before, else the stream
 * ends with a `TransportTimeout` and `timing.onTimeout` aborts the request.
 */
export async function readReply(res: Response, onText?: (text: string) => void, timing: { chunkTimeoutMs?: number; onTimeout?: () => void } = {}): Promise<Reply> {
  const reply: Reply = { status: res.status, text: "", reasoning: "", toolCalls: [], headers: res.headers };
  if (res.status !== 200 || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const body = await res.text();
    reply.raw = body;
    try {
      const json = JSON.parse(body);
      if (json.error) reply.error = json.error;
      const message = json.choices?.[0]?.message;
      if (message) {
        reply.text = message.content ?? "";
        reply.reasoning = message.reasoning_content ?? "";
        reply.toolCalls = (message.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function.name, input: JSON.parse(c.function.arguments || "{}") }));
        reply.finish = json.choices[0].finish_reason;
      }
    } catch {}
    return reply;
  }
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  /** A piece of the stream, or a timeout when none came within `chunkTimeoutMs`. */
  const read = async () => {
    if (timing.chunkTimeoutMs === undefined) return reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // The timeout settles first, then the abort ends the pending read.
        reject(new TransportTimeout("data"));
        timing.onTimeout?.();
      }, timing.chunkTimeoutMs);
    });
    try {
      return await Promise.race([reader.read(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
  const lines = async function* () {
    for (;;) {
      const { done, value } = await read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        yield buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
      }
    }
    if (buffered) yield buffered;
  };
  try {
    for await (const line of lines()) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") break;
      readChunk(JSON.parse(data));
    }
  } catch (error) {
    reply.streamError = error;
  }
  reader.releaseLock();
  reply.toolCalls = [...calls.values()].map((c) => ({ id: c.id, name: c.name, input: JSON.parse(c.args || "{}") }));
  return reply;

  function readChunk(chunk: any) {
    if (chunk.error) reply.error = chunk.error;
    if (chunk.usage) reply.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (typeof choice.delta?.content === "string") {
      reply.text += choice.delta.content;
      onText?.(reply.text);
    }
    if (typeof choice.delta?.reasoning_content === "string") reply.reasoning += choice.delta.reasoning_content;
    for (const call of choice.delta?.tool_calls ?? []) {
      const at = calls.get(call.index) ?? { id: "", name: "", args: "" };
      if (call.id) at.id = call.id;
      if (call.function?.name) at.name = call.function.name;
      if (call.function?.arguments) at.args += call.function.arguments;
      calls.set(call.index, at);
    }
    // The first finish reason stays (openai-chat.js step: `state.finishReason ?? finishReason`).
    if (choice.finish_reason) reply.finish ??= choice.finish_reason;
  }
}

// ---- provider failures (ai 2.2.0 provider-error.js, route/executor.js, protocols/openai-chat.js) ----

/** The kind OpenCode gives a failed request (the AIError reason, with its classification). */
export type FailureKind =
  | "context-overflow"
  | "payload-too-large"
  | "content-policy"
  | "quota"
  | "authentication"
  | "rate-limit"
  | "provider-internal"
  | "invalid-request"
  | "unknown"
  | "transport"
  | "incomplete-stream";

const OVERFLOW_PATTERNS = [
  /prompt is too long/i, /input is too long for (?:the )?(?:requested|selected) model/i, /too large for the model'?s configured input limit/i,
  /exceeded this model context window limit/i, /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, /input token count.*exceeds the maximum/i,
  /number of input tokens exceeds maximum length/i, /tokens in request more than max tokens allowed/i, /maximum prompt length is \d+/i,
  /reduce the length of the messages/i, /requested input length \d+ exceeds maximum input length/i, /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, /input(?: \(\d+ tokens\))? is longer than the model'?s context length/i,
  /exceeds the limit of \d+/i, /exceeds the available context size/i, /greater than the context length/i, /`inputs` tokens \+ `max_new_tokens` must be <= \d+/i,
  /context window exceeds limit/i, /exceeded model token limit/i, /context[_ ]length[_ ]exceeded/i, /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i, /prompt (?:too long|exceeds max length|超长)/i, /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, /model_context_window_exceeded/i, /range of input length should be/i,
  /too many tokens/i, /token limit exceeded/i, /request_too_large/i,
];
const PAYLOAD_PATTERNS = [/request entity too large/i, /payload too large/i, /request too large/i];
const OVERFLOW_EXCLUSIONS = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i, /max[_ ]tokens must be less than/i, /too many tokens(?: per day)?, please wait/i];
const isContextOverflow = (message: string) =>
  !OVERFLOW_EXCLUSIONS.some((p) => p.test(message)) && (OVERFLOW_PATTERNS.some((p) => p.test(message)) || /^4(?:00|13)\s*(status code)?\s*\(no body\)/i.test(message));
const QUOTA_CODES = new Set(["insufficient_quota", "usage_not_included", "billing_error", "gousagelimiterror", "budgetlimiterror", "freeusagelimiterror", "creditlimitexceeded"]);
const AUTH_CODES = new Set(["authentication_error", "permission_error", "permission_denied", "api_key_invalid"]);
const SERVER_CODES = new Set(["api_error", "internal_error", "internalserverexception", "modelstreamerrorexception", "overloaded_error", "server_error", "server_is_overloaded", "slow_down", "serviceunavailableexception"]);
const INVALID_REQUEST_CODES = new Set(["model_not_found", "invalid_prompt", "invalid_request", "invalid_request_error", "validationexception"]);
const CONTENT_POLICY_CODES = new Set(["content_filter", "content_moderation", "responsibleaipolicyviolation", "content_policy_violation", "image_content_policy_violation", "refusal", "datainspectionfailed", "moderation_blocked"]);
const GATEWAY_CODE_LABEL = /^[^:\n]+: \[([A-Za-z0-9_.-]+)\]/;
const AUTH_TEXT = /incorrect api key provided/i;
const RATE_LIMIT_TEXT = /rate increased too quickly|rate[-_\s]?limit|too[_\s]?many[_\s]?requests/i;
const QUOTA_TEXT = /insufficient[-_\s]?(?:quota|balance)|quota[-_\s]?exceeded|budget exceeded|usage limit|limit exhausted|package has expired|plan does not yet include/i;
const CONTENT_POLICY_TEXT = /violating our usage policy|blocked by content filtering policy|content[-_\s]?policy|rejected (?:as a result of our|by the) safety system|detected potentially unsafe or sensitive content/i;
const SERVER_ERROR_TEXT = /\b(?:try again|(?:please |you can )?retry (?:the |this |your )?request|try (?:the |this |your )?request again|(?:currently |temporarily )?at capacity|overloaded|temporarily unavailable|service[-_\s]?unavailable|(?:server|internal)[-_\s]?error|server (?:is )?busy|provider returned (?:an )?error|resource[-_\s]?exhausted|upstream (?:connect|connection|request)|request buffer limit while retrying upstream)\b/i;

const isRecord = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null;
const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
/** The codes a failure body carries (providerCodes). */
function providerCodes(value: unknown): string[] {
  const decoded = typeof value === "string" ? parseJson(value) : value;
  if (!isRecord(decoded)) return [];
  const error = isRecord(decoded.error) ? decoded.error : undefined;
  const inner = error && isRecord(error.innererror) ? error.innererror : undefined;
  const metadata = error && isRecord(error.metadata) ? error.metadata : undefined;
  const response = isRecord(decoded.response) ? decoded.response : undefined;
  const responseError = response && isRecord(response.error) ? response.error : undefined;
  const exception = isRecord(decoded.exception) ? decoded.exception : undefined;
  return [
    decoded.code, ...awsErrorType(decoded.__type), ...awsErrorType(decoded.code), Array.isArray(decoded.errors) ? decoded.name : undefined, decoded.error_type,
    error?.code, error?.type, error?.status, error?.error_type,
    ...(Array.isArray(error?.details) ? error.details.map((d: unknown) => (isRecord(d) ? d.reason : undefined)) : []),
    inner?.code, metadata?.error_type, responseError?.code, response?.error_type, exception?.type,
  ].filter((v): v is string => typeof v === "string");
}
/** An AWS error type (`X-Amzn-Errortype`, `__type`, `code`) without its namespace or suffix (awsErrorType). */
const awsErrorType = (value: unknown) => (typeof value === "string" ? [value.replace(/:.*/s, "").replace(/^[^#]*#/, "")] : []);
/** The human-readable message of a failure body (providerErrorMessage), else OpenCode's fallback (route/executor.js 70–80). */
export function providerMessage(status: number, body: string | undefined): string {
  const text = body?.trim() ?? "";
  const json = parseJson(text);
  const nonBlank = (v: unknown) => (typeof v === "string" && /\S/.test(v) ? v : undefined);
  if (isRecord(json)) {
    const found =
      (isRecord(json.error) ? nonBlank(json.error.message) : undefined) ??
      nonBlank(json.error) ?? nonBlank(json.message) ?? nonBlank(json.Message) ?? nonBlank(json.detail) ??
      (Array.isArray(json.errors) && json.errors.length > 0 && isRecord(json.errors[0]) ? nonBlank(json.errors[0].message) : undefined);
    if (found) return found;
  }
  const fallback = `Provider request failed with HTTP ${status}`;
  if (!text || /^<(?:!doctype|html)/i.test(text)) return fallback;
  return `${fallback}: ${text.length > 2000 ? `${text.slice(0, 2000)}:` : text}`;
}
/** OpenCode's classification of a failed request (classifyProviderFailure). */
export function classifyFailure(input: { message: string; status?: number; body?: string; data?: unknown; headers?: Headers }): FailureKind {
  const body = input.body ?? "";
  const codes = [
    ...providerCodes(input.data), ...providerCodes(body), ...providerCodes(input.message), ...(GATEWAY_CODE_LABEL.exec(input.message)?.slice(1) ?? []),
    ...awsErrorType(input.headers?.get("x-amzn-errortype") ?? undefined),
  ].map((c) => c.toLowerCase());
  const text = [input.message, body].filter((v) => v.length > 0).join("\n");
  const clientScoped = input.status === undefined || (input.status >= 400 && input.status < 500);
  if (clientScoped && (codes.includes("context_length_exceeded") || codes.includes("model_context_window_exceeded") || codes.includes("request_too_large") || (!codes.includes("throttlingexception") && isContextOverflow(text)))) return "context-overflow";
  if (input.status === 413 || PAYLOAD_PATTERNS.some((p) => p.test(text))) return "payload-too-large";
  if (codes.some((c) => CONTENT_POLICY_CODES.has(c)) || (clientScoped && CONTENT_POLICY_TEXT.test(input.message))) return "content-policy";
  if (input.status === 402 || codes.some((c) => QUOTA_CODES.has(c)) || (input.status === 429 && QUOTA_TEXT.test(text))) return "quota";
  if (input.status === 401 || input.status === 403 || codes.some((c) => AUTH_CODES.has(c)) || (input.status === 400 && AUTH_TEXT.test(text))) return "authentication";
  if (input.status === 429 || codes.some((c) => c.includes("rate_limit") || c === "too_many_requests" || c === "throttlingexception") || RATE_LIMIT_TEXT.test(text)) return "rate-limit";
  if (
    input.status === 408 || input.status === 409 || (input.status !== undefined && input.status >= 500) ||
    ((input.status === undefined || input.status < 400) &&
      ((!codes.some((c) => INVALID_REQUEST_CODES.has(c)) && SERVER_ERROR_TEXT.test(text)) || codes.some((c) => SERVER_CODES.has(c) || c.includes("exhausted") || c.includes("unavailable"))))
  ) return "provider-internal";
  if (codes.some((c) => INVALID_REQUEST_CODES.has(c))) return "invalid-request";
  if (input.status !== undefined && input.status >= 400 && input.status < 500) return "invalid-request";
  return "unknown";
}
/** Whether OpenCode may send a failed request again (isRetryable; `x-should-retry` decides first). */
export function isRetryableFailure(kind: FailureKind, headers?: Headers): boolean {
  const override = headers?.get("x-should-retry");
  if (override === "true") return true;
  if (override === "false") return false;
  return kind === "rate-limit" || kind === "provider-internal" || kind === "transport" || kind === "incomplete-stream" || kind === "unknown";
}
/** The delay a provider asks for (route/executor.js retryAfterMs). */
export function retryAfterMs(headers: Headers): number | undefined {
  // 2.2.0 clamps to a whole number of ms (clampRetryAfterMs); 2.0.32 kept fractions.
  const clamp = (ms: number) => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.ceil(ms)));
  const millis = Number(headers.get("retry-after-ms") ?? NaN);
  if (Number.isFinite(millis)) return clamp(millis);
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : clamp(date - Date.now());
}

/** A failed request as OpenCode sees it, or undefined for an answer that ended well. */
export type Failure = { kind: FailureKind; message: string; retryable: boolean; retryAfterMs?: number; code?: "Timeout" };
/** A timeout as OpenCode reads it: a retryable transport failure, code "Timeout". */
export const timeoutFailure = (timeout: TransportTimeout): Failure => ({ kind: "transport", message: timeout.message, retryable: true, code: "Timeout" });
export function failureOf(reply: Reply, version: OpenCodeVersion = DEFAULT_VERSION): Failure | undefined {
  if (reply.status !== 200) {
    const message = providerMessage(reply.status, reply.raw);
    const kind = classifyFailure({ message, status: reply.status, body: reply.raw, headers: reply.headers });
    // A quota failure carries the provider's retry-after since 2.2.0 (provider-error.js QuotaExceededError); it is still not retried.
    const after = kind === "rate-limit" || kind === "provider-internal" || (kind === "quota" && version !== "2.0.32") ? retryAfterMs(reply.headers) : undefined;
    return { kind, message, retryable: isRetryableFailure(kind, reply.headers), ...(after !== undefined ? { retryAfterMs: after } : {}) };
  }
  if (reply.error) {
    // A failure chunk inside the stream (openai-chat.js 841–849): no HTTP status, its own code if a number.
    const error = reply.error as { message?: unknown; code?: unknown };
    const message = String(error.message ?? "");
    const kind = classifyFailure({ message, status: typeof error.code === "number" ? error.code : undefined, body: JSON.stringify({ error: reply.error }) });
    return { kind, message, retryable: isRetryableFailure(kind) };
  }
  if (reply.streamError instanceof TransportTimeout) return timeoutFailure(reply.streamError);
  if (reply.streamError) return { kind: "transport", message: "Connection lost while reading the response", retryable: true };
  if (reply.finish === "error") return { kind: "unknown", message: "Provider reported an error (finish_reason: error)", retryable: true };
  if (reply.finish === "network_error") return { kind: "provider-internal", message: "Provider reported a network error (finish_reason: network_error)", retryable: true };
  if (reply.finish === undefined) return { kind: "incomplete-stream", message: "OpenAI Chat stream ended without finish_reason", retryable: true };
  if (!["stop", "end", "length", "content_filter", "function_call", "tool_calls"].includes(reply.finish)) {
    // 2.2.0: the stream maps it to finish `unknown`, and the step fails as an incomplete stream (openai-chat.js
    // mapFinishReason, core runner/step.ts unknownFinish); 2.0.32 failed the stream as an unknown provider error.
    if (version === "2.0.32") return { kind: "unknown", message: `Provider finish_reason: ${reply.finish}`, retryable: true };
    return { kind: "incomplete-stream", message: "The provider response ended with an unknown finish reason.", retryable: true };
  }
  return undefined;
}

// ---- retries (core runner/retry.ts) ----

const RETRY_AFTER_MAX = 15 * 60_000;
const RETRIES_MAX = 10;
/** Of a step's retries, at most this many may follow a timeout (MAX_TIMEOUT_RETRIES): the 4th timeout is not retried. */
const TIMEOUT_RETRIES_MAX = 3;
/** The synthetic user message after a stream that broke once the answer had started (instance-71svxegq.js 302–309). */
export const CONTINUE_AFTER_INTERRUPTION = "The previous response was interrupted. Continue from where you left off without repeating completed content.";
/** The synthetic user message after an answer cut at the output limit, finish `length` (instance-71svxegq.js 112, 324). */
export const CONTINUE_AFTER_OUTPUT_LIMIT = "Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.";
/** The step's failure (type `output-limit`) when the answers stay cut (instance-71svxegq.js 315–321). */
export const OUTPUT_LIMIT_EXHAUSTED = "Response still truncated after two output token limit continuations";
/**
 * The three latest user and assistant messages of the session (synthetic ones
 * not counted) are all answers cut at the output limit: the step fails instead
 * of asking to continue once more (instance-71svxegq.js 312–315).
 */
export const outputLimitExhausted = (messages: Msg[]) => {
  const recent = messages.filter((m) => (m.type === "user" && !m.queued) || (m.type === "assistant" && !m.pending)).slice(-3);
  return recent.length === 3 && recent.every((m) => m.type === "assistant" && m.finish === "length");
};
/** The wait before retry `n` (1, 2, …): 2 s doubling, at most 10 s a gap; a provider's retry-after (at most 15 min) is the floor. No jitter here. */
export const retryDelay = (n: number, retryAfter?: number) => {
  const delay = Math.min(2_000 * 2 ** (n - 1), 10_000);
  return retryAfter === undefined ? delay : Math.max(delay, Math.min(retryAfter, RETRY_AFTER_MAX));
};

// ---- compaction (core 2.2.0 session/compaction.ts, session/recent-text.ts; Token.estimate) ----

/** The shares of a refused summary request tried next (SHRINK_STEPS; 2.0.32 had no 0.85). */
const shrinkSteps = (version: OpenCodeVersion) => (version === "2.0.32" ? [0.7, 0.5, 0.35] : [0.85, 0.7, 0.5, 0.35]);
const RESERVE_MIN = 16_000;
const RESERVE_SHARE = 0.15;
const SUMMARY_OUTPUT_FLOOR = 32_000;
// Background compaction (2.2.0 `precompute`): from 85% of the ceiling, an answer of at least 64 000 prompt tokens.
const PRECOMPUTE_RATIO = 0.85;
const PRECOMPUTE_MIN_TOKENS = 64_000;
const PRECOMPUTED_TAIL_MIN = 30_000;
const PRECOMPUTED_TAIL_SHARE = 0.25;
const PRECOMPUTE_MAX_FAILURES = 2;
// The levels a summary request as text drops detail at (TRANSCRIPT_LEVELS, 2.2.0).
const OUTPUTS_CLIPPED = 1;
const OUTPUTS_REMOVED = 2;
const USER_ONLY = 3;
const OMITTED = 4;
const TRANSCRIPT_LEVELS = [0, OUTPUTS_CLIPPED, OUTPUTS_REMOVED, USER_ONLY, OMITTED];
const TRANSCRIPT_CLIP = 2000;
const UNKNOWN_WINDOW = 200_000;
const TOOL_OUTPUT_MAX_CHARS = 1250;
const IMAGE_TOKEN_ESTIMATE = 1500;
const PDF_TOKEN_ESTIMATE = 2000;
/** Tokens of the newest messages a summary keeps verbatim (settings.keep). */
export const COMPACTION_KEEP = 15_000;
export const SUMMARY_TEMPLATE = `You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>`;
const SUMMARY_RULES = `Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not mention the summary process or that context was compacted.`;
/** The summary prompt: a first summary, or an update of the previous checkpoint (buildPrompt). */
export function buildSummaryPrompt(update: boolean, legacy = false): string {
  const shared = [
    "Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.",
    SUMMARY_TEMPLATE,
    SUMMARY_RULES,
    "Do not continue the task or call tools.",
    "Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.",
  ];
  if (!update) return ["You MUST summarize the conversation above into a structured summary that will be given to another agent to resume the work.", ...shared].join("\n\n");
  return [
    "Update the existing checkpoint in the conversation above into one consolidated summary.",
    ...(legacy
      ? ["The existing checkpoint was written with an earlier format that recorded far more detail than this one asks for. Rewrite it at the level of detail described below rather than carrying its detail forward. Keep its requirements, decisions, and open questions; they came from earlier conversation with the user."]
      : []),
    "Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer history clearly contradicts, supersedes, resolves, or makes it stale. If something is no longer relevant to continuing the work, you may remove it.",
    "Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or pending work.",
    "Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>`, `<summary>`, or `<recent-context>` wrapper tags from the previous checkpoint.",
    ...shared,
  ].join("\n\n");
}
export const SUMMARY_NUDGE = "The previous response did not fill in the required summary template. Do not call tools. Return the summary as text using the exact section headings from the template.";
const LEGACY_HEADING = "## Additional Context";
const SUMMARY_HEADINGS = SUMMARY_TEMPLATE.split("\n").filter((line) => line.startsWith("##"));
/** Whether a reply fills the summary template (one of its headings on a line). */
export const summaryFilled = (text: string) => text.split("\n").some((line) => SUMMARY_HEADINGS.includes(line.trim()));

/** The title agent's prompt (core 2.0.32 chunks/instance-jxa04fe5.js, plugin/agent.ts PROMPT_TITLE). */
export const TITLE_SYSTEM = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/credential.ts can you add refresh token support" -> Credential refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`;

/** Token.estimate: four characters a token. */
export const estimateTokens = (text: string) => Math.max(0, Math.round(text.length / 4));
const estimateMedia = (mime: string) => (mime.toLowerCase().startsWith("image/") ? IMAGE_TOKEN_ESTIMATE : mime.toLowerCase() === "application/pdf" ? PDF_TOKEN_ESTIMATE : 0);
const estimatePart = (part: Record<string, any>): number => {
  if (part.type === "effort") return 0;
  if (part.type === "text" || part.type === "reasoning") return estimateTokens(String(part.text ?? ""));
  if (part.type === "media") return estimateMedia(String(part.media?.mediaType ?? ""));
  if (part.type === "tool-call") return estimateTokens(part.name + (JSON.stringify(part.input) ?? ""));
  if (part.result?.type === "content") {
    return (part.result.value as Array<Record<string, any>>).reduce((sum, c) => sum + (c.type === "text" ? estimateTokens(String(c.text)) : estimateMedia(String(c.mime))), 0);
  }
  const value = part.result?.value;
  return estimateTokens(typeof value === "string" ? value : (JSON.stringify(value) ?? ""));
};
export const estimateMessage = (message: ListMessage) => message.content.reduce((sum, part) => sum + estimatePart(part), 0);
export const estimateRequest = (system: Array<{ text: string }>, tools: ToolDefinitions, messages: ListMessage[]) =>
  system.reduce((sum, part) => sum + estimateTokens(part.text), 0) +
  Object.entries(tools).reduce((sum, [name, t]) => sum + estimateTokens(name + t.description + JSON.stringify(t.input)), 0) +
  messages.reduce((sum, message) => sum + estimateMessage(message), 0);

/**
 * The largest request the model takes while leaving room for its reply (calculateCeiling): the window minus the
 * buffer, else minus 15% (2.2.0 RESERVE_SHARE; 2.0.32: 10%), at least 16 000. 2.2.0 ignores a buffer as large as the
 * window.
 */
export function calculateCeiling(limit: { input?: number; context?: number } | undefined, buffer?: number, version: OpenCodeVersion = DEFAULT_VERSION): number {
  const window = limit?.input || limit?.context || 0;
  if (window <= 0) return Number.POSITIVE_INFINITY;
  if (buffer !== undefined && (version === "2.0.32" || buffer < window)) return window - buffer;
  return window - Math.max(Math.floor(window * (version === "2.0.32" ? 0.1 : RESERVE_SHARE)), window >= 2 * RESERVE_MIN ? RESERVE_MIN : 0);
}
/** The room a summary may take when it reuses the chat's own request (summaryRoom, 2.2.0). */
const summaryRoom = (limit: { input?: number; context?: number } | undefined, output = RESERVE_MIN) =>
  Math.max(0, (limit?.input || limit?.context || 0) - Math.min(RESERVE_MIN, output));

const truncateToolOutput = (value: string) => {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value;
  const chars = [...value];
  if (chars.length <= TOOL_OUTPUT_MAX_CHARS) return value;
  return `${chars.slice(0, TOOL_OUTPUT_MAX_CHARS).join("")}\n[truncated]`;
};
/** A message as the text a summary keeps of it (recent-text.ts messageToText; 2.0.32 kept reasoning too). */
export function messageToText(message: Msg, version: OpenCodeVersion = DEFAULT_VERSION): string {
  switch (message.type) {
    case "compaction":
    case "system":
      return "";
    case "user": {
      const skills = (message.skills ?? []).flatMap((skill) => (skill.text === undefined ? [] : [`[Skill activated: ${skill.name}]\n${skill.text}`]));
      const files = (message.files ?? []).map((file) => `[Attached ${file.mediaType}: ${file.name ?? file.path ?? "inline attachment"}]`);
      return [...skills, `[User]: ${message.text}`, ...files].join("\n");
    }
    case "location":
      return `[User]: The working directory has been changed to ${message.text}.`;
    case "assistant": {
      const parts: string[] = [];
      if (message.reasoning && version === "2.0.32") parts.push(`[Assistant reasoning]: ${message.reasoning}`);
      if (message.text) parts.push(`[Assistant]: ${message.text}`);
      for (const call of message.toolCalls ?? []) {
        parts.push(`[Assistant tool call]: ${call.name}(${JSON.stringify(call.input)})`);
        const result = message.toolResults?.find((r) => r.id === call.id);
        if (result?.error) parts.push(`[Tool error]: ${result.output}`);
        else if (result) {
          const files = (result.files ?? []).map((f) => `[Attached ${f.mime}${f.name === undefined ? "" : `: ${f.name}`}]`);
          parts.push(`[Tool result]: ${truncateToolOutput([...(result.output !== "" || files.length === 0 ? [result.output] : []), ...files].join("\n"))}`);
        }
      }
      return parts.join("\n");
    }
    case "synthetic":
      return `[Synthetic context]: ${message.text}`;
    case "skill":
      // instance-1kn978n9.js 535–581: the skill's name, then its text.
      return `[Skill activated: ${message.skillName ?? "skill"}]\n${message.text}`;
    case "shell":
      return `[Shell]: ${message.text}\n`;
  }
}
const previousCompaction = (messages: Msg[]) => (messages[0]?.type === "compaction" ? messages[0] : undefined);
/** How many of the oldest items to drop so the rest fit `budget` (oldestToDrop). */
const oldestToDrop = <T>(items: T[], size: (item: T) => number, budget: number) => {
  let total = 0;
  let start = items.length;
  while (start > 0) {
    const next = total + size(items[start - 1]!);
    if (next > budget) break;
    total = next;
    start--;
  }
  return start;
};
/**
 * The older part a summary covers and the newest messages kept verbatim as text (splitConversation, recentStart).
 * `keepID`: the first kept message (2.2.0 keeps its id on the checkpoint and reads the tail from it).
 */
export function splitConversation(messages: Msg[], keep = COMPACTION_KEEP, version: OpenCodeVersion = DEFAULT_VERSION): { older: Msg[]; recent: string; keepID?: string } | undefined {
  const entries = messages.flatMap((message, index) => {
    const text = messageToText(message, version);
    return text ? [{ message, text, index }] : [];
  });
  if (entries.length === 0) return undefined;
  const previous = previousCompaction(messages);
  const dropped = Math.min(oldestToDrop(entries, (entry) => estimateTokens(entry.text), keep), entries.length - 1);
  const userBoundary = entries.findLastIndex((entry, index) => index <= dropped && entry.message.type === "user");
  const latestUser = entries.findLastIndex((entry) => entry.message.type === "user");
  const start = userBoundary > 0 ? userBoundary : latestUser > 0 ? latestUser : previous?.recent ? 0 : entries.length;
  const recent = entries.slice(start);
  return {
    older: messages.slice(0, recent[0]?.index ?? messages.length),
    recent: recent.map((entry) => entry.text).join("\n\n"),
    ...(recent[0] ? { keepID: recent[0].message.id } : {}),
  };
}
/** The tail kept verbatim from `keepID` on, as 2.2.0 reads it when it loads the checkpoint (history.ts withRecentText). */
export const recentFrom = (messages: Msg[], keepID: string, version: OpenCodeVersion = DEFAULT_VERSION) => {
  const at = messages.findIndex((m) => m.id === keepID);
  return at < 0 ? "" : messages.slice(at).map((m) => messageToText(m, version)).filter(Boolean).join("\n\n");
};
/** A value over 2000 characters as its first and last 1000 (clip, 2.2.0). */
const clip = (value: string) => {
  if (value.length <= TRANSCRIPT_CLIP) return value;
  const chars = Array.from(value);
  if (chars.length <= TRANSCRIPT_CLIP) return value;
  const half = TRANSCRIPT_CLIP / 2;
  return `${chars.slice(0, half).join("")}\n[… ${chars.length - TRANSCRIPT_CLIP} characters omitted …]\n${chars.slice(-half).join("")}`;
};
const serializeToolContent = (content: Array<Record<string, any>>) =>
  content.map((item) => (item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`)).join("\n");
/** A list message as text, its media omitted (flattenMessage). */
const flattenMessage = (message: ListMessage) => {
  if (message.role === "system") return "";
  return message.content
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[${message.role === "user" ? "User" : "Assistant"}]: ${part.text}`] : [];
      if (part.type === "media") return [`[${part.media?.mediaType} omitted]`];
      if (part.type === "tool-call") return [`[Assistant tool call]: ${part.name}(${JSON.stringify(part.input) ?? ""})`];
      if (part.type !== "tool-result") return [];
      const result = part.result;
      const output = result.type === "content" ? serializeToolContent(result.value) : typeof result.value === "string" ? result.value : (JSON.stringify(result.value) ?? "");
      return [`[${result.type === "error" ? "Tool error" : "Tool result"}]: ${truncateToolOutput(output)}`];
    })
    .join("\n");
};
/**
 * The summary request as text, its oldest exchanges dropped to fit `target`
 * (flattenAndDropOldest): the previous checkpoint stays, the rest one user
 * message; undefined when nothing fits.
 */
function flattenAndDropOldest(messages: ListMessage[], previous: Msg | undefined, system: Array<{ text: string }>, tools: ToolDefinitions, target: number): ListMessage[] | undefined {
  const end = messages.findLastIndex((m) => previous !== undefined && m.id === previous.id) + 1;
  const lead = previous !== undefined ? [{ id: previous.id, role: "user" as const, content: [textPart(checkpointText(previous.summary ?? ""))] }] : messages.slice(0, end);
  const exchanges = messages.slice(end).reduce<string[]>((groups, message) => {
    const text = flattenMessage(message);
    if (!text) return groups;
    if (message.role === "user" || groups.length === 0) groups.push(text);
    else groups[groups.length - 1] += `\n${text}`;
    return groups;
  }, previous?.recent ? [previous.recent] : []);
  const note = (omitted: number) => (omitted ? `[${omitted} older ${omitted === 1 ? "exchange" : "exchanges"} omitted]\n\n` : "");
  const room = target - estimateRequest(system, tools, lead) - estimateTokens(note(exchanges.length));
  const kept = exchanges.slice(oldestToDrop(exchanges, (text) => estimateTokens(text) + 1, room));
  if (kept.length === 0) return undefined;
  return [...lead, { role: "user", content: [textPart(note(exchanges.length - kept.length) + kept.join("\n\n"))] }];
}
/** A list message as text at a level of detail (flattenMessage, 2.2.0): outputs clipped, then removed, then the user's words alone. */
const flattenAtLevel = (message: ListMessage, level: number) => {
  if (message.role === "system" || level === OMITTED) return "";
  if (level >= USER_ONLY && message.role !== "user") return "";
  return message.content
    .flatMap((part) => {
      if (part.type === "text") return part.text ? [`[${message.role === "user" ? "User" : "Assistant"}]: ${level >= USER_ONLY ? clip(String(part.text)) : part.text}`] : [];
      if (level >= USER_ONLY) return [];
      if (part.type === "media") return [`[${part.media?.mediaType} omitted]`];
      if (part.type === "tool-call") {
        const input = JSON.stringify(part.input) ?? "";
        return [`[Assistant tool call]: ${part.name}(${level >= OUTPUTS_REMOVED ? clip(input) : input})`];
      }
      if (part.type !== "tool-result") return [];
      const result = part.result;
      const label = result.type === "error" ? "Tool error" : "Tool result";
      if (level >= OUTPUTS_REMOVED) return [`[${label} omitted]`];
      const output = result.type === "content" ? serializeToolContent(result.value) : typeof result.value === "string" ? result.value : (JSON.stringify(result.value) ?? "");
      return [`[${label}]: ${level >= OUTPUTS_CLIPPED ? clip(output) : output}`];
    })
    .join("\n");
};
/**
 * The summary request as text (flattenAndDropOldest, 2.2.0): the previous checkpoint stays, the rest one user message
 * whose exchanges, oldest first, lose detail level by level (outputs clipped, removed, the user's words alone, left out)
 * until it fits `target`; no tools. Undefined when nothing fits.
 */
function flattenToFit(messages: ListMessage[], previous: Msg | undefined, system: Array<{ text: string }>, target: number): ListMessage[] | undefined {
  const end = messages.findLastIndex((m) => previous !== undefined && m.id === previous.id) + 1;
  const lead = previous !== undefined ? [{ id: previous.id, role: "user" as const, content: [textPart(checkpointText(previous.summary ?? ""))], ...(previous.metadata ? { metadata: structuredClone(previous.metadata) } : {}) }] : messages.slice(0, end);
  const recent = previous?.recent ?? "";
  const groups = messages.slice(end).reduce<ListMessage[][]>((all, message) => {
    if (message.role === "user" || all.length === 0) all.push([message]);
    else all.at(-1)!.push(message);
    return all;
  }, []);
  const exchanges = [
    ...(recent ? [TRANSCRIPT_LEVELS.map((level) => (level === OMITTED ? "" : recent))] : []),
    ...groups.map((group) => TRANSCRIPT_LEVELS.map((level) => group.map((m) => flattenAtLevel(m, level)).filter(Boolean).join("\n"))).filter((renders) => renders[0]),
  ];
  if (exchanges.length === 0) return undefined;
  const note = (omitted: number) => (omitted ? `[${omitted} older ${omitted === 1 ? "exchange" : "exchanges"} omitted]\n\n` : "");
  const size = (text: string | undefined) => (text ? estimateTokens(text) + 1 : 0);
  const room = target - estimateRequest(system, {}, lead) - estimateTokens(note(exchanges.length));
  const levels = exchanges.map(() => 0);
  let total = exchanges.reduce((sum, renders) => sum + size(renders[0]), 0);
  const newest = exchanges.length - 1;
  for (const level of TRANSCRIPT_LEVELS.slice(1)) {
    for (let index = 0; index < exchanges.length && total > room; index++) {
      if (index === newest && !exchanges[index]![level]) continue;
      total += size(exchanges[index]![level]) - size(exchanges[index]![levels[index]!]);
      levels[index] = level;
    }
  }
  if (total > room) return undefined;
  const omitted = levels.filter((level, index) => !exchanges[index]![level]).length;
  const text = exchanges.map((renders, index) => renders[levels[index]!]).filter(Boolean).join("\n\n");
  return [...lead, { role: "user", content: [textPart(note(omitted) + text)] }];
}

// ---- the plugin's host (Plugin.Context) ----

/**
 * A queue the plugin reads as OpenCode's event stream (`ctx.event.subscribe`).
 * `push` resolves once the plugin has handled the event: an async generator
 * resumes after `yield` only when the reader asks for the next event, which
 * the plugin does after its handler for the previous one returned.
 */
export function eventQueue() {
  const queue: Array<{ event: unknown; handled: () => void }> = [];
  let wake: (() => void) | undefined;
  async function* subscribe({ signal }: { signal: AbortSignal }) {
    while (!signal.aborted) {
      const next = queue.shift();
      if (!next) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        continue;
      }
      yield next.event;
      next.handled();
    }
  }
  const push = (event: unknown) =>
    new Promise<void>((handled) => {
      queue.push({ event, handled });
      wake?.();
      wake = undefined;
    });
  return { subscribe, push };
}

/**
 * The context OpenCode gives a plugin's `setup`: the hooks it registers are
 * kept by name (with their scope); the provider it adds is kept (its models
 * are the catalog); `session.get` and `session.context` answer from the
 * host's sessions; events come from an `eventQueue`. The plugin's options
 * turn off the update of the machine's Claude Code.
 */
export function pluginContext(input: {
  directory: string;
  get: (input: { sessionID: string }) => Promise<unknown>;
  context: (input: { sessionID: string }) => Promise<unknown>;
  options?: Record<string, unknown>;
}) {
  const events = eventQueue();
  const hooks: Record<string, (payload: any) => Promise<void>> = {};
  const scopes: Record<string, { providerID?: string } | undefined> = {};
  const provider = { info: undefined as any, models: [] as any[] };
  let transform: ((p: { add: (x: any) => void }) => void | Promise<void>) | undefined;
  const runTransform = async () =>
    transform?.({
      add: (x: any) => {
        provider.info = x.info;
        provider.models = x.models;
      },
    });
  const switched: Array<{ sessionID: string; model: unknown }> = [];
  /** The plugin's `provider.reload()` calls (`count`); `fails`: the next reloads reject with this message (a location being disposed). */
  const reloads = { count: 0, fails: undefined as string | undefined };
  const ctx = {
    options: { cliAutoUpdate: false, ...input.options },
    location: { directory: input.directory },
    provider: {
      transform: async (fn: typeof transform) => {
        transform = fn;
        await runTransform();
      },
      reload: async () => {
        reloads.count++;
        if (reloads.fails !== undefined) throw new Error(reloads.fails);
        await runTransform();
      },
    },
    session: {
      hook: async (name: string, handler: (payload: any) => Promise<void>, options?: { providerID?: string }) => {
        hooks[name] = handler;
        scopes[name] = options;
      },
      switchModel: async (request: { sessionID: string; model: unknown }) => {
        switched.push(request);
      },
      get: input.get,
      context: input.context,
    },
    integration: {
      transform: async (fn: (i: unknown) => void) => fn({ method: { update: () => {} }, update: () => {} }),
    },
    event: { subscribe: events.subscribe },
  };
  return { ctx: ctx as any, hooks, scopes, provider, events, switched, reloads };
}

// ---- the system prompt (session/model-request.ts baseTranscript, session/context.ts select) ----

/** The stock prompt of an agent without its own (session/runner/prompt/system.txt, instance-57b9ws8p.js). */
const STOCK_PROMPT = `You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.

# Harness
- Responses are rendered as GitHub-flavored Markdown.
- \`<system-reminder>\` blocks are harness instructions, not user-authored content. Read and follow them.
- Prefer parallelizing independent tool calls.
\${OPENCODE_TOOL_GUIDANCE}

# Communication
- Use clear file paths when referring to files.
- Keep responses clear and concise, and avoid unnecessary technical jargon.

# Working in codebases
- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.
- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.
`;

/** The stock prompt with the guidance for the tools the request offers (system-prompt.ts render). */
export function stockPrompt(tools: string[]): string {
  const guidance: string[] = [];
  if (tools.includes("shell")) {
    guidance.push(
      "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.",
      '- Do not chain shell commands with separators like `echo "====";` or `printf \'---\'`; the output becomes noisy in a way that makes the user\'s side of the conversation worse.',
    );
  }
  if (tools.includes("write")) guidance.push("- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.");
  if (tools.includes("edit")) {
    guidance.push(
      "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
    );
  }
  return STOCK_PROMPT.replace("${OPENCODE_TOOL_GUIDANCE}", guidance.join("\n"));
}

/** What the `opencode.prompt.anthropic` plugin appends to the stock prompt of a model whose id holds "claude" (plugin/optimize.ts). */
const ANTHROPIC_APPEND = `# Code comments
By default, match the surrounding comment density: where the code has none, add none. Use comments sparingly, only where they are appropriate, such as for behavior that is not obvious from the code itself. Instructions from the user or the project take precedence over this guidance.
`;

/** The `opencode.tools` plugin's part at the end (tool/plugin/opencode.ts). */
const WORKTREE_NOTE =
  "When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.";

/** The `opencode.prompt.identity` plugin's part, second (plugin/identity.ts). */
export const modelIdentity = (name: string, ref: { providerID: string; id: string }) =>
  ["# Your Model", `- Name: ${name}`, `- Provider ID: ${ref.providerID}`, `- Model ID: ${ref.id}`].join("\n");

/** A JSON Schema as `@opencode/codemode` 2.0.32 renders it into a signature (tool-schema.js `renderSchema`, pretty). */
type JsonSchemaLike = Record<string, any>;
const identifierSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const renderKey = (name: string) => (identifierSegment.test(name) ? name : JSON.stringify(name));
const renderLiteral = (value: unknown) => JSON.stringify(value) ?? "unknown";
const definitionName = (ref: string) => {
  if (!ref.startsWith("#/")) return undefined;
  const tokens = ref.slice(2).split("/").map((token) => decodeURIComponent(token).replaceAll("~1", "/").replaceAll("~0", "~"));
  return tokens.length === 2 && (tokens[0] === "$defs" || tokens[0] === "definitions") ? tokens[1] : undefined;
};
const effectNumberSentinel = (schema: JsonSchemaLike) =>
  schema.type === "string" && Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((value: unknown) => value === "NaN" || value === "Infinity" || value === "-Infinity");
const annotationKeywords = new Set(["title", "description", "default", "examples", "readOnly", "writeOnly"]);
const isEffectEmptyStruct = (schema: JsonSchemaLike) =>
  schema.not?.type === "null" && Object.keys(schema.not).length === 1 && Object.keys(schema).every((key) => key === "not" || annotationKeywords.has(key));
const intersection = (members: string[]) => {
  const concrete = members.filter((member) => member !== "unknown");
  if (concrete.length === 0) return "unknown";
  if (concrete.length === 1) return concrete[0]!;
  return concrete.map((member) => (member.includes(" | ") ? `(${member})` : member)).join(" & ");
};
const MAX_RENDER_DEPTH = 8;
const hasUnresolvedRef = (schema: JsonSchemaLike, definitions: Record<string, JsonSchemaLike>, seen = new Set<string>(), visited = new Set<JsonSchemaLike>()): boolean => {
  if (visited.has(schema)) return false;
  const nextVisited = new Set([...visited, schema]);
  if (schema.$ref !== undefined) {
    const name = definitionName(schema.$ref);
    if (name === undefined || definitions[name] === undefined || seen.has(name)) return true;
    if (hasUnresolvedRef(definitions[name]!, definitions, new Set([...seen, name]), nextVisited)) return true;
  }
  return [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
    ...Object.values(schema.properties ?? {}),
    ...(schema.items === undefined ? [] : [schema.items]),
    ...(typeof schema.additionalProperties === "object" ? [schema.additionalProperties] : []),
  ].some((item: JsonSchemaLike) => hasUnresolvedRef(item, definitions, seen, nextVisited));
};
const docTags = (schema: JsonSchemaLike) => {
  const tags: string[] = [];
  if (schema.deprecated === true) tags.push("@deprecated");
  if (schema.default !== undefined) {
    try {
      const rendered = JSON.stringify(schema.default);
      if (rendered !== undefined) tags.push(`@default ${rendered}`);
    } catch {}
  }
  if (typeof schema.format === "string") tags.push(`@format ${schema.format}`);
  if (schema.type === "integer") tags.push("@integer");
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength"]) {
    if (typeof schema[key] === "number") tags.push(`@${key} ${schema[key]}`);
  }
  if (typeof schema.pattern === "string") tags.push(`@pattern ${schema.pattern}`);
  if (typeof schema.minItems === "number") tags.push(`@minItems ${schema.minItems}`);
  if (typeof schema.maxItems === "number") tags.push(`@maxItems ${schema.maxItems}`);
  if (schema.uniqueItems === true) tags.push("@uniqueItems true");
  return tags;
};
const docLines = (schema: JsonSchemaLike, width: number) => {
  const summary = docTags(schema).join(" ");
  const lines = String(schema.description ?? "").split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const inline = lines.length === 1 ? `${lines[0]}${lines[0]!.endsWith(".") ? "" : "."} ${summary}` : summary;
  return summary && lines.length === 1 && !summary.includes("\n") && width + inline.length + 7 <= 120 ? [inline] : [...lines, ...(summary ? summary.split("\n") : [])];
};
const jsdoc = (schema: JsonSchemaLike, pad: string) => {
  const content = docLines(schema, pad.length);
  const types = typeof schema.type === "string" ? [schema.type] : (schema.type ?? []);
  const append = (label: string, child: JsonSchemaLike) => {
    docLines(child, pad.length + label.length + 2).forEach((line, index) => {
      if (index === 0) {
        content.push(`${label}: ${line}`);
        return;
      }
      content.push(line ? `  ${line}` : "");
    });
  };
  if (types.includes("array") && schema.items) append("Each item", schema.items);
  if ((types.includes("object") || schema.properties) && typeof schema.additionalProperties === "object") {
    append(Object.keys(schema.properties ?? {}).length > 0 ? "Each additional value" : "Each value", schema.additionalProperties);
  }
  if (content.length === 0) return "";
  const escaped = content.map((line) => line.replaceAll("*/", "* /"));
  if (escaped.length === 1 && pad.length + escaped[0]!.length + 7 <= 120) return `${pad}/** ${escaped[0]} */\n`;
  const body = escaped.map((line) => `${pad} *${line === "" ? "" : ` ${line}`}`).join("\n");
  return `${pad}/**\n${body}\n${pad} */\n`;
};
type RenderContext = { definitions: Record<string, JsonSchemaLike>; pretty: boolean };
const renderSchema = (schema: JsonSchemaLike, ctx: RenderContext, depth = 0, seen = new Set<string>()): string => {
  if (depth > MAX_RENDER_DEPTH) return "unknown";
  const nested = schema.definitions === undefined && schema.$defs === undefined ? ctx : { ...ctx, definitions: { ...ctx.definitions, ...(schema.definitions ?? {}), ...(schema.$defs ?? {}) } };
  if (schema.$ref) {
    const name = definitionName(schema.$ref);
    if (!name || !nested.definitions[name] || seen.has(name)) return "unknown";
    return intersection([renderSchema(nested.definitions[name]!, nested, depth, new Set([...seen, name])), renderSchema({ ...schema, $ref: undefined }, nested, depth + 1, seen)]);
  }
  if (schema.const !== undefined) return renderLiteral(schema.const);
  if (schema.enum) return schema.enum.map(renderLiteral).join(" | ");
  const alternatives: JsonSchemaLike[] | undefined = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    if (alternatives.some((item) => item.type === "number") && alternatives.every((item) => item.type === "number" || effectNumberSentinel(item))) return "number";
    if (alternatives.length === 2 && alternatives[0]?.type === "object" && alternatives[0].properties === undefined && alternatives[1]?.type === "array" && alternatives[1].items === undefined) return "{}";
    const members = alternatives.map((item) => renderSchema(item, nested, depth + 1, seen));
    if (members.some((member) => member === "unknown")) return "unknown";
    return intersection([members.join(" | "), renderSchema({ ...schema, anyOf: undefined, oneOf: undefined }, nested, depth + 1, seen)]);
  }
  if (schema.allOf) {
    if (schema.allOf.some((item: JsonSchemaLike) => hasUnresolvedRef(item, nested.definitions))) return "unknown";
    const members = schema.allOf.map((item: JsonSchemaLike) => renderSchema(item, nested, depth + 1, seen));
    return intersection([renderSchema({ ...schema, allOf: undefined }, nested, depth + 1, seen), ...members]);
  }
  if (Array.isArray(schema.type)) return schema.type.map((item: string) => renderSchema({ ...schema, type: item }, nested, depth + 1, seen)).join(" | ");
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "null") return "null";
  if (schema.type === "array") return `Array<${renderSchema(schema.items ?? {}, nested, depth + 1, seen)}>`;
  if (schema.type === "object" || schema.properties) {
    const required = new Set<string>(schema.required ?? []);
    const properties = Object.entries<JsonSchemaLike>(schema.properties ?? {});
    const additional = schema.additionalProperties;
    const indexType = additional && typeof additional === "object" ? renderSchema(additional, nested, depth + 1, seen) : undefined;
    const field = ([name, value]: [string, JsonSchemaLike]) => `${renderKey(name)}${required.has(name) ? "" : "?"}: ${renderSchema(value, nested, depth + 1, seen)}`;
    if (!ctx.pretty) {
      const fields = properties.map(field);
      if (indexType !== undefined) fields.push(`[key: string]: ${indexType}`);
      return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
    }
    if (properties.length === 0 && indexType === undefined) return "{}";
    const pad = "  ".repeat(depth + 1);
    const lines = properties.map((entry) => `${jsdoc(entry[1], pad)}${pad}${field(entry)},`);
    if (indexType !== undefined) lines.push(`${pad}[key: string]: ${indexType},`);
    return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
  }
  if (isEffectEmptyStruct(schema)) return "{}";
  return "unknown";
};
const typeScriptOf = (schema: JsonSchemaLike, pretty = true) => {
  try {
    return renderSchema(schema, { definitions: {}, pretty });
  } catch {
    return "unknown";
  }
};
/** A tool's path as code calls it (tool-runtime.js `toolExpression`): `tools.a.b`, a segment that is no identifier in brackets. */
export const toolExpression = (path: string) =>
  "tools" + path.split(".").map((segment) => (identifierSegment.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`)).join("");
/** A tool of Code Mode, as OpenCode registers it: its namespace, name, description and JSON Schemas (an MCP tool's input; its output `{}` when the server names none). */
export type CodeModeTool = { namespace: string; name: string; description: string; input?: JsonSchemaLike; output?: JsonSchemaLike; pinned?: boolean };
/** The signature a tool is listed with (tool-runtime.js `describeTool`). */
export function codeModeSignature(tool: CodeModeTool): string {
  const input = tool.input ?? { type: "object", properties: {} };
  const empty = typeScriptOf(input, false) === "{}";
  return `${toolExpression(`${tool.namespace}.${tool.name}`)}${empty ? "()" : `(${typeScriptOf(input)})`}: Promise<${typeScriptOf(tool.output ?? {})}>`;
}
/** The built-in `search` function's signature (tool-runtime.js `searchSignature`, rendered by the package from its Effect schemas). */
export const SEARCH_SIGNATURE = `search({
  query?: string,
  namespace?: string,
  /** @integer @exclusiveMinimum 0 */
  limit?: number,
  /** @integer @minimum 0 */
  offset?: number,
}): {
  items: Array<{
      path: string,
      description: string,
      signature: string,
    }>,
  /** @integer @minimum 0 */
  remaining: number,
  next: {
      /** @integer @minimum 0 */
      offset: number,
    } | null,
}`;
/** The `execute` tool's description (codemode/tool.ts). */
const EXECUTE_DESCRIPTION = [
  "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.",
  "`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable; all other external access goes through `tools`.",
  "Within `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.",
  'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
  "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
  "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.",
].join("\n");
export const EXECUTE_TOOL: ToolDefinitions = {
  execute: { description: EXECUTE_DESCRIPTION, input: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } },
};
/**
 * OpenCode's own Code Mode namespace, there whatever MCP servers and plugins are configured: `opencode.tools`
 * (tool/plugin/opencode.ts: the sessions, the worktrees, the models) and `opencode.tools.mcp-resources`
 * (tool/plugin/mcp-resource.ts), both registered unconditionally. Their Effect schemas as JSON Schemas that render the
 * signatures OpenCode 2.0.32 itself lists (its live system prompt on this machine).
 */
const SESSION_ID = { type: "string", pattern: "^ses" };
const mcpResourceEntry = (address: "uri" | "uriTemplate") => ({
  type: "object",
  properties: { server: { type: "string" }, name: { type: "string" }, [address]: { type: "string" }, description: { type: "string" }, mimeType: { type: "string" } },
  required: ["server", "name", address],
});
const mcpResourceContent = (kind: "text" | "blob") => ({
  type: "object",
  properties: { type: { const: kind }, uri: { type: "string" }, [kind]: { type: "string" }, mimeType: { type: "string" } },
  required: ["type", "uri", kind],
});
export const OPENCODE_NAMESPACE = {
  name: "opencode",
  description: "Tools for managing OpenCode itself, such as working with sessions and worktrees, searching the available models, and reading MCP resources.",
};
export const OPENCODE_TOOLS: CodeModeTool[] = [
  {
    namespace: "opencode",
    name: "session_rename",
    description: "Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the work being done.",
    input: {
      type: "object",
      properties: { sessionID: { ...SESSION_ID, description: "Omit to rename the current session." }, title: { type: "string", minLength: 1, description: "New session title." } },
      required: ["title"],
    },
    output: { type: "object", properties: { sessionID: SESSION_ID, title: { type: "string" } }, required: ["sessionID", "title"] },
  },
  {
    namespace: "opencode",
    name: "session_move",
    description: "Move a session to another directory, or omit sessionID to move the current session. The current session moves at the next safe boundary; do not run destination-dependent tools in the same execute call.",
    input: {
      type: "object",
      properties: {
        sessionID: { ...SESSION_ID, description: "Omit to move the current session." },
        directory: { type: "string", minLength: 1, description: "Destination directory, relative to the target session's directory or absolute. Supports ~." },
      },
      required: ["directory"],
    },
    output: { type: "object", properties: { sessionID: SESSION_ID, directory: { type: "string" } }, required: ["sessionID", "directory"] },
    pinned: true,
  },
  {
    namespace: "opencode",
    name: "worktree_create",
    description: "Create a named worktree. Returns its directory.",
    input: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    output: { type: "object", properties: { directory: { type: "string" } }, required: ["directory"] },
    pinned: true,
  },
  {
    namespace: "opencode",
    name: "worktree_list",
    description: "List a repository's worktrees.",
    input: { type: "object", properties: {} },
    output: {
      type: "object",
      properties: { worktrees: { type: "array", items: { type: "object", properties: { directory: { type: "string" }, strategy: { type: "string" } }, required: ["directory"] } } },
      required: ["worktrees"],
    },
    pinned: true,
  },
  {
    namespace: "opencode",
    name: "worktree_remove",
    description: "Remove a worktree. The repository location selects configuration; directory identifies the worktree to remove.",
    input: {
      type: "object",
      properties: {
        directory: { type: "string", minLength: 1, description: "Absolute path of the worktree to remove." },
        force: { type: "boolean", description: "Discard modified and untracked files. Only set this when the user has confirmed forced removal." },
      },
      required: ["directory"],
    },
    output: { type: "object", properties: { directory: { type: "string" }, removed: { type: "boolean" } }, required: ["directory", "removed"] },
    pinned: true,
  },
  {
    namespace: "opencode",
    name: "models",
    description: "Search the models available to use. Use this to turn a model name the user mentions into an exact reference before running a subagent on it. Check your own provider first.",
    input: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for in model names and IDs." },
        provider: { type: "string", description: "Provider ID or name to filter by. Try your own provider first." },
        all: { type: "boolean", description: "Include older versions of each model family. By default only the newest version is listed." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum number of models to return. Defaults to 20." },
        offset: { type: "integer", minimum: 0, description: "Number of models to skip, for paging through results." },
      },
    },
    output: {
      type: "object",
      properties: {
        providers: {
          type: "array",
          description: "Matching models grouped by provider. Your own provider comes first.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              models: {
                type: "array",
                description: "Newest first.",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "providerID/modelID" },
                    name: { type: "string" },
                    released: { type: "number", description: "Release date as a Unix timestamp in milliseconds, or 0 when unknown." },
                    variants: { type: "array", items: { type: "string" } },
                    cost: {
                      type: "array",
                      description: "Pricing in USD per million tokens.",
                      items: {
                        type: "object",
                        properties: {
                          tier: { type: "object", properties: { type: { const: "context" }, size: { type: "integer" } }, required: ["type", "size"] },
                          input: { type: "number" },
                          output: { type: "number" },
                          cache: { type: "object", properties: { read: { type: "number" }, write: { type: "number" } }, required: ["read", "write"] },
                        },
                        required: ["input", "output", "cache"],
                      },
                    },
                    status: { enum: ["alpha", "beta", "deprecated", "active"] },
                  },
                  required: ["id", "name", "released", "variants", "cost", "status"],
                },
              },
            },
            required: ["id", "name", "models"],
          },
        },
        total: { type: "integer", description: "Number of matching models across all pages." },
        next: { anyOf: [{ type: "integer" }, { type: "null" }], description: "Offset of the next page, or null on the last page." },
      },
      required: ["providers", "total", "next"],
    },
  },
  {
    namespace: "opencode",
    name: "list_mcp_resources",
    description:
      "List documents, records, and other data exposed by MCP servers. Use this when the user refers to something that is not a local file, such as a URI with a custom scheme, then load a match with read_mcp_resource. Each entry names the server to read it from. Templates are resources addressed by a parameter such as a record ID; fill in the uriTemplate placeholders before reading.",
    input: { type: "object", properties: { server: { type: "string", description: "MCP server name as configured. Omit to list every server." } } },
    output: {
      type: "object",
      properties: { resources: { type: "array", items: mcpResourceEntry("uri") }, templates: { type: "array", items: mcpResourceEntry("uriTemplate") } },
      required: ["resources", "templates"],
    },
  },
  {
    namespace: "opencode",
    name: "read_mcp_resource",
    description:
      "Read one MCP resource by server and URI. Not for local files. Always return the full contents rather than slicing or filtering them; oversized output is truncated automatically and the full content is saved to a file you can read. Images and PDFs are shown to you directly.",
    input: {
      type: "object",
      properties: {
        server: { type: "string", description: "The server field of the discovered resource." },
        uri: { type: "string", description: "Exact resource URI from discovery, an expanded uriTemplate, or the user." },
      },
      required: ["server", "uri"],
    },
    output: {
      type: "object",
      properties: { server: { type: "string" }, uri: { type: "string" }, contents: { type: "array", items: { anyOf: [mcpResourceContent("text"), mcpResourceContent("blob")] } } },
      required: ["server", "uri", "contents"],
    },
  },
];
/** Code Mode as OpenCode 2.0.32 has it with no MCP server and no plugin of the user's: its own namespace alone. */
export const openCodeCodeMode = () => ({ namespaces: [{ ...OPENCODE_NAMESPACE }], tools: OPENCODE_TOOLS.map((tool) => ({ ...tool })) });
/** The skill tool (tool/plugin/skill.ts), a direct tool. */
export const SKILL_TOOL: ToolDefinitions = {
  skill: {
    description: [
      "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.",
      "",
      "The skill ID must match an available skill or a skill explicitly referenced by the user.",
    ].join("\n"),
    input: { type: "object", properties: { id: { type: "string", description: "The ID of an available skill or a skill explicitly referenced by the user" } }, required: ["id"], additionalProperties: false },
  },
};

/** The catalog's inline budget in tokens of 4 characters (codemode/catalog.ts `summarize`). */
const CATALOG_BUDGET = 2000;
const catalogCost = (text: string) => Math.round(text.length / 4);
type CatalogNamespace = { name: string; description?: string; count: number; entries: Array<{ path: string; line: string }> };
const namespaceLine = (namespace: CatalogNamespace) => {
  const count = namespace.count === 1 ? "1 tool" : `${namespace.count} tools`;
  const label = namespace.entries.length === namespace.count ? count : namespace.entries.length === 0 ? `${count}, none shown` : `${count}, ${namespace.entries.length} shown`;
  return `- ${namespace.name} (${label})${namespace.description === undefined ? "" : ` // ${namespace.description}`}`;
};
const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
/** Which listings fit the inline budget (catalog.ts `summarize`): the cheapest first, a namespace at a time. */
function summarizeCatalog(tools: CodeModeTool[], descriptions: Map<string, string>) {
  const namespaces = [...Map.groupBy(tools, (tool) => tool.namespace)].sort(([left], [right]) => byText(left, right)).map(([name, entries]) => {
    const listings = entries
      .map((tool) => {
        const firstLine = tool.description.split("\n", 1)[0]?.trim() ?? "";
        const description = firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;
        return { path: `${tool.namespace}.${tool.name}`, line: `  - ${codeModeSignature(tool)}${description.length === 0 ? "" : ` // ${description}`}`, pinned: tool.pinned === true };
      })
      .toSorted((left, right) => byText(left.path, right.path));
    const ranked = listings.map((listing) => ({ listing, cost: catalogCost(listing.line) })).toSorted((left, right) => left.cost - right.cost || byText(left.listing.path, right.listing.path));
    const selected = new Set(listings.filter((listing) => listing.pinned));
    return { name, description: descriptions.get(name), listings, order: ranked.filter((candidate) => !selected.has(candidate.listing)), selected, index: 0 };
  });
  let remaining =
    CATALOG_BUDGET -
    namespaces.reduce((total, namespace) => total + catalogCost(namespaceLine({ name: namespace.name, description: namespace.description, count: namespace.listings.length, entries: [] })), 0) -
    namespaces.flatMap((namespace) => [...namespace.selected]).reduce((total, listing) => total + catalogCost(listing.line), 0);
  const active = new Set(namespaces);
  while (active.size > 0) {
    for (const namespace of active) {
      const candidate = namespace.order[namespace.index];
      if (!candidate || candidate.cost > remaining) {
        active.delete(namespace);
        continue;
      }
      namespace.selected.add(candidate.listing);
      namespace.index += 1;
      remaining -= candidate.cost;
      if (namespace.index === namespace.order.length) active.delete(namespace);
    }
  }
  const summaries: CatalogNamespace[] = namespaces.map((namespace) => ({
    name: namespace.name,
    ...(namespace.description === undefined ? {} : { description: namespace.description }),
    count: namespace.listings.length,
    entries: namespace.listings.filter((listing) => namespace.selected.has(listing)).map(({ path, line }) => ({ path, line })),
  }));
  return { total: tools.length, shown: summaries.reduce((total, namespace) => total + namespace.entries.length, 0), namespaces: summaries };
}
/**
 * The Code Mode section (codemode/instructions.ts `render`): complete, partial with `search`, or no tools at all.
 * 2.2.1 reworded its opening and renamed the listing's heading (source of the tag v2.2.1,
 * packages/core/src/codemode/instructions.ts; its catalog.ts is 2.2.0's).
 */
export function codeModeInstructions(tools: CodeModeTool[], namespaces: Array<{ name: string; description?: string }> = [], version: OpenCodeVersion = DEFAULT_VERSION): string {
  const catalog = summarizeCatalog(tools, new Map(namespaces.flatMap((namespace) => (namespace.description === undefined ? [] : [[namespace.name, namespace.description] as [string, string]]))));
  if (catalog.total === 0) return "No Code Mode tools are currently available. Later Code Mode catalog updates may add or remove tools. Do not call `execute` unless there is at least one available Code Mode tool.";
  const partial = catalog.shown < catalog.total;
  const listing = catalog.namespaces.flatMap((namespace) => [namespaceLine(namespace), ...namespace.entries.map((entry) => entry.line)]).join("\n");
  if (version === "2.2.1") {
    const head221 = `# Code Mode

The tools listed below${partial ? ", and `search`," : ""} cannot be called directly: they only work as JavaScript inside the \`execute\` tool. Every other tool you have is a normal tool call: call it directly, never inside \`execute\`.

${partial ? `The catalog is partial. Before calling a tool that is not listed below, find it with the global \`search(...)\` function. Do not guess tool names. Each result's \`path\` is the complete call expression: write it out as code, for example \`await tools.ns.tool_name({ ... })\`. Do not use it as a key such as \`tools[path]\`.

- ${SEARCH_SIGNATURE}` : "The catalog is complete. Do not guess tool names."}

## Code Mode tools (call only inside \`execute\`)`;
    return `${head221}\n\n${listing}`;
  }
  const head = `# Code Mode

Use the \`execute\` tool to call the tools listed below. They cannot be called directly${partial ? ", and neither can `search`. Both" : ". They"} only work inside code you pass to \`execute\`.

${partial ? `The catalog is partial. Inside \`execute\`, use \`search(...)\` to find a tool, then call it by the \`path\` in the result. \`search\` is synchronous. Call it without \`await\`; it does not return a Promise. Do not guess tool names.

- ${SEARCH_SIGNATURE}` : "The catalog is complete. Do not guess tool names."}

## Available tools`;
  return `${head}\n\n${listing}`;
}

/** An MCP server as OpenCode lists it: its tools, its instructions, and whether its tools go through Code Mode. */
export type McpServer = { server: string; instructions?: string; tools: Array<{ name: string; description?: string; input?: JsonSchemaLike; output?: JsonSchemaLike }>; codemode?: false };
/** A server's name as a namespace (tool/mcp.ts `namespace`). */
export const mcpNamespace = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, "_");
/** The MCP servers' instructions (mcp/instructions.ts `render`), sorted by server. */
export function mcpInstructionsBlock(servers: McpServer[]): string {
  const entries = servers.toSorted((a, b) => a.server.localeCompare(b.server)).flatMap((server) => [
    `  <server name="${server.server}">`,
    ...(server.codemode !== false ? [`    Use tools from this server through \`execute\` under \`tools[${JSON.stringify(mcpNamespace(server.server))}]\`.`] : []),
    ...server.instructions!.split("\n").map((line) => `    ${line}`),
    "  </server>",
  ]);
  return ["<mcp_instructions>", ...entries, "</mcp_instructions>"].join("\n");
}
/** A skill OpenCode lists (skill/instructions.ts): one with a description that is not `autoinvoke: false`. */
export type Skill = { id: string; name: string; description: string };
/** The skills section (skill/instructions.ts `render`), sorted by id; no skill at all: no section. */
export function skillsInstructions(skills: Skill[]): string {
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    "The user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.",
    "<available_skills>",
    ...skills.toSorted((a, b) => a.id.localeCompare(b.id)).flatMap((skill) => ["  <skill>", `    <id>${skill.id}</id>`, `    <name>${skill.name}</name>`, `    <description>${skill.description}</description>`, "  </skill>"]),
    "</available_skills>",
  ].join("\n");
}
/** A path as OpenCode resolves it (FSUtil.resolve): absolute, through links. */
const resolvedPath = (path: string) => {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
};
const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
/** The directories from `start` up to `stop` (or the root), nearest first (FSUtil.up). */
const upFrom = (start: string, stop?: string) => {
  const out: string[] = [];
  for (let current = start; ; current = dirname(current)) {
    out.push(current);
    if ((stop && resolve(stop).toLowerCase() === resolve(current).toLowerCase()) || dirname(current) === current) return out;
  }
};
/** OpenCode's own configuration folder (util/global-roots.ts): OPENCODE_CONFIG_DIR, else XDG_CONFIG_HOME or ~/.config, `opencode`. */
export const openCodeConfigDir = () => process.env.OPENCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
/** The project's folder (project/project.ts resolve): the work tree of the nearest `.git`, else the directory itself. */
const projectRoot = (directory: string) => upFrom(directory).find((dir) => existsSync(join(dir, ".git")) || existsSync(join(dir, ".hg"))) ?? directory;
/**
 * The instruction files OpenCode loads for a directory (config/plugin/instruction.ts): the global AGENTS.md of its
 * configuration folder, the project's AGENTS.md from the directory up to the project's folder (the home folder when
 * the directory is inside it), nearest first, then the files the configuration's `instructions` name — an absolute
 * path or pattern in its folder, a relative one in each folder from the directory up to the project's, sorted; a file
 * once, where it first came; read as it is.
 */
export function instructionFiles(directory: string, configured: string[] = []): Array<{ path: string; content: string }> {
  const start = resolvedPath(directory);
  const root = resolvedPath(projectRoot(directory));
  const home = resolvedPath(homedir());
  const contains = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const project = contains(root, start);
  const stop = contains(home, start) ? home : root;
  const globalFile = resolvedPath(join(openCodeConfigDir(), "AGENTS.md"));
  const read = (path: string) => {
    try {
      return { path, content: readFileSync(path, "utf8") };
    } catch {
      return undefined;
    }
  };
  const global = isFile(globalFile) ? [globalFile] : [];
  const walked = project ? [...new Set(upFrom(start, stop).map((dir) => join(dir, "AGENTS.md")).filter(isFile).map(resolvedPath))] : [];
  const scan = (pattern: string, cwd: string) => {
    try {
      return [...new Bun.Glob(pattern).scanSync({ cwd, absolute: true, dot: true, onlyFiles: true })];
    } catch {
      return [];
    }
  };
  const matches = (source: string) => {
    const expanded = source.startsWith("~/") ? join(homedir(), source.slice(2)) : source;
    if (isAbsolute(expanded)) return scan(basename(expanded), dirname(expanded));
    if (project) return upFrom(start, root).flatMap((dir) => scan(expanded, dir));
    return scan(expanded, openCodeConfigDir());
  };
  const seen = new Set<string>();
  const fromConfig = [...new Set(configured)].flatMap((source) =>
    matches(source)
      .toSorted()
      .flatMap((item) => {
        const path = resolvedPath(item);
        if (seen.has(path)) return [];
        seen.add(path);
        return [path];
      }),
  );
  // The discovery keeps a file per path, where it first came (instruction-discovery.ts `editor.files`, a Map).
  return [...new Set([...global, ...walked, ...fromConfig])].flatMap((path) => read(path) ?? []);
}
/** The instruction files' section (instruction-discovery.ts `render`). */
export const instructionFilesBlock = (files: Array<{ path: string; content: string }>) => files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n");
/** The environment section (instructions/builtins.ts): the chat's directory, the project's folder, git, the platform, OpenCode's temp folder. */
export function environmentBlock(directory: string): string {
  const root = projectRoot(directory);
  return [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${resolvedPath(root)}`,
    `  Is directory a git repo: ${existsSync(join(root, ".git")) ? "yes" : "no"}`,
    `  Platform: ${process.platform}`,
    `  Prefer ${resolvedPath(join(tmpdir(), "opencode"))} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    "</env>",
  ].join("\n");
}
/** A value a host attached through the session instructions API (session/instruction-entry.ts `renderBlock`). */
export const contextBlock = (key: string, value: unknown) => [`<context key="${key}">`, typeof value === "string" ? value : JSON.stringify(value, null, 2), "</context>"].join("\n");

// ---- the host: sessions, turns, compactions, forks ----

/** OpenCode's prompt of a first summary (an update of a checkpoint: `buildSummaryPrompt(true)`). */
export const SUMMARY_PROMPT = buildSummaryPrompt(false);
export const BASH_TOOL: ToolDefinitions = {
  bash: { description: "Run a command", input: { type: "object", properties: { command: { type: "string" } } } },
};

// OpenCode message ids: `msg_` + 12 hex digits of time + 14 random chars,
// so fresh ids order by time as strings. A fork copies messages under
// `<id of the fork event>_<seq>`, seq unpadded.
// A second process on the machine starts later in this order (OPENCODE_CLAUDE_WORLD_ID_BASE, world.secondProcess):
// its ids never meet the first one's, as OpenCode's ids of two servers on one database.
let clock = 0x100000 + (Number(process.env.OPENCODE_CLAUDE_WORLD_ID_BASE) || 0);
const stamp = () => (clock++).toString(16).padStart(12, "0");
export const newId = () => `msg_${stamp()}aaaaaaaaaaaaaa`;
export const newEventId = () => `msg_${stamp()}eeeeeeeeeeeeee`;

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms))),
  ]);
}

export type Session = {
  id: string;
  /** The directory the chat runs in (a location switch changes it); unset: the world's. */
  directory?: string;
  /** The title OpenCode gave the chat (session.renamed). */
  title?: string;
  fork?: { sessionID: string; boundary: ForkBoundary };
  messages: Msg[];
  /** The last seq given out: OpenCode never reuses the seq of a reverted message. */
  lastSeq?: number;
  /** The instruction sections as observed at the session's first request (or its latest compaction): instruction-state.ts. */
  instructions?: string;
};

/**
 * One request of a turn, as it went: the list the hooks left, the body sent,
 * the reply (none for a request the user stopped: status 0), and the range
 * of `count` around it (the world counts Claude's queries: the ones this
 * request started).
 */
export type SentRequest = {
  list: ListMessage[];
  body: ReturnType<typeof requestBody>;
  status: number;
  reply?: Reply;
  counted: [number, number];
  /** performance.now when the request was sent and when its reply was read (load stands). */
  sentAt: number;
  doneAt: number;
  /** The model the request named, with its variant (a title's). */
  model?: { providerID: string; id: string; variant?: string };
};

/** The variants a title's model takes by default, the first it offers (MINIMAL_REASONING_VARIANTS, instance-egzk2yjk.js 193). */
const TITLE_VARIANTS = ["none", "minimal", "low"];
/** The title request's user message in 2.2.0 (session/title.ts messagePrompt). */
export const titleMessagePrompt = (text: string) => `Here is the first message of the conversation:\n\n<message>\n${text}\n</message>\n\nReply with only the title.`;
/** The warming plugin's defaults (plugin/warming.ts): the keep-alive prompt, a ping every 4 minutes, for 30 minutes. */
export const WARMING_DEFAULTS = {
  prompt: "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK",
  interval: 4 * 60_000,
  duration: 30 * 60_000,
};

/** The event of the `context` and `compaction` hooks (model-request.ts 255–267). */
export type ContextEvent = {
  sessionID: string;
  model: { providerID: string; id: string };
  system: Array<{ type: string; text: string }>;
  messages: ListMessage[];
  options: Record<string, unknown>;
  agent: string;
  tools: ToolDefinitions;
};

export function createOpenCodeSimulator(options: { directory: string; setup: (ctx: any) => Promise<unknown>; count?: () => number }) {
  const count = options.count ?? (() => 0);
  const state = {
    /**
     * The OpenCode release: 2.2.0, 2.0.32 where the two differ, or 2.2.1 for its Code Mode section (BEHAVIOR.md
     * "Versions"). The default for a whole run: `OPENCODE_CLAUDE_SIMULATOR_OPENCODE=2.0.32` (or `2.2.1`).
     */
    version: (["2.0.32", "2.2.1"].includes(process.env.OPENCODE_CLAUDE_SIMULATOR_OPENCODE ?? "") ? process.env.OPENCODE_CLAUDE_SIMULATOR_OPENCODE : DEFAULT_VERSION) as OpenCodeVersion,
    /**
     * `experimental.background_compaction` (2.2.0; config/plugin/compaction.ts): near the ceiling OpenCode writes the
     * summary in the background while the chat goes on, and swaps it in when the compaction is due.
     */
    backgroundCompaction: false,
    /**
     * OpenCode's `warming` setting (plugin/warming.ts): `true` (a ping every 4 minutes for 30 minutes after the
     * chat's latest request) or the fields to change, in ms here; unset: no warming.
     */
    warming: undefined as undefined | true | { prompt?: string; interval?: number; duration?: number },
    /**
     * Another plugin's context/compaction hook after the plugin's own: it may
     * change any field of the event (messages, system, tools, options), and
     * the request is built from what it left.
     */
    foreignHook: undefined as undefined | ((event: ContextEvent) => void),
    /** Another plugin's `prompt` hook after the plugin's own: the message is what it leaves. */
    foreignPromptHook: undefined as undefined | ((event: { prompt: { text: string; files?: Array<{ uri: string; name?: string }> }; metadata?: Record<string, unknown>; delivery: string }) => void),
    /** OpenCode never answers this read of the plugin's (a hung server): session.get or session.context. */
    hangReads: false as false | "get" | "context",
    /** The model of the requests (the catalog id); default: the catalog's first Sonnet, else its first model. */
    modelID: undefined as string | undefined,
    /**
     * The title's model (the title agent's model, else the small model of the primary's provider), sent without
     * the user's variant; default: the session's primary model.
     */
    titleModelID: undefined as string | undefined,
    /**
     * The title agent's own variant (`agent.model.variant`); unset: the first of none / minimal / low the title's
     * model offers, else none (instance-egzk2yjk.js 128, 193).
     */
    titleVariant: undefined as string | undefined,
    /** The model's variant the user picked (an effort level the plugin's catalog offers), as OpenCode passes it in `model.request`. */
    variant: undefined as string | undefined,
    /** The tools a turn offers directly (besides `execute`, `skill` and an MCP server's own tools, below). */
    tools: BASH_TOOL,
    /** The session's agent: its name and its own prompt (a custom agent's `prompt`); none: OpenCode's stock prompt. */
    agent: { name: "build" } as { name: string; system?: string },
    /**
     * OpenCode's `execute` tool and the Code Mode tools besides the MCP servers' (OpenCode's own namespace, a host's):
     * namespaces with their descriptions, tools with their JSON Schemas. Default: OpenCode's own `opencode` namespace,
     * as 2.0.32 always has it. Unset: `execute` denied (an agent's permission) — no tool, no catalog, no Code Mode MCP
     * tools or their instructions.
     */
    codeMode: openCodeCodeMode() as undefined | { namespaces?: Array<{ name: string; description?: string }>; tools?: CodeModeTool[] },
    /** MCP servers: their tools (through Code Mode, else direct with `codemode: false`) and instructions. */
    mcpServers: [] as McpServer[],
    /**
     * The skills OpenCode lists, and its `skill` tool. Default: none — the tool offered, no skills section, as 2.0.32
     * with no skill. Unset: the skill tool denied (an agent's permission).
     */
    skills: [] as undefined | Skill[],
    /** The configuration's `instructions` (paths or patterns; absolute, `~/`, or relative to the chat's folders). */
    instructions: [] as string[],
    /** Values a host attached through the session instructions API (`<context key>` blocks), every session alike. */
    contextEntries: {} as Record<string, unknown>,
    /** OpenCode's compaction agent runs on another provider's model: compactions send the plugin nothing (`compactElsewhere` is the same without events). */
    compactionElsewhere: false,
    /** OpenCode compacts by itself when the context reaches the ceiling, and after an overflow (compaction.auto). */
    autoCompaction: true,
    /** Tokens kept free below the window before compacting (compaction.buffer); unset: 15% (2.0.32: 10%), at least 16 000. */
    compactionBuffer: undefined as number | undefined,
    /** OpenCode's clock for retry waits: by default no real wait (the waits are in `retries`). */
    sleep: (async (_ms: number) => {}) as (ms: number) => Promise<void>,
    /** A request's response headers within this many ms, else it times out (`@opencode/ai` headerTimeout). */
    headerTimeoutMs: 300_000,
    /** Each piece of a response's stream within this many ms of the one before, else it times out (chunkTimeout). */
    chunkTimeoutMs: 900_000,
  };
  const sessions = new Map<string, Session>();
  let chats = 0;
  /** A new chat; `id` names it (OpenCode's own ids are `ses_<n>` here); `directory`: where it runs (default: the world's). */
  const newChat = (id = `ses_${++chats}`, directory?: string) => {
    sessions.set(id, { id, messages: [], ...(directory ? { directory } : {}) });
    return id;
  };
  const session = (id: string) => {
    const found = sessions.get(id);
    if (!found) throw new Error(`no session ${id}`);
    return found;
  };
  const nextSeq = (s: Session) => {
    s.lastSeq = Math.max(s.lastSeq ?? 0, s.messages.at(-1)?.seq ?? 0) + 1;
    return s.lastSeq;
  };

  type Instance = ReturnType<typeof pluginContext> & { directory: string; dispose: () => Promise<void> };
  const instances: Instance[] = [];
  /**
   * The hook of the plugin instance of the chat's directory (OpenCode starts
   * an instance per directory); a chat in a directory with no instance of its
   * own is served by the first one.
   */
  const hookOf = (chat: string, name: string) => {
    const directory = sessions.get(chat)?.directory ?? options.directory;
    return (instances.find((instance) => instance.directory === directory) ?? instances[0])?.hooks[name];
  };
  const model = () => {
    const models = instances[0]?.provider.models ?? [];
    const id = state.modelID ?? models.find((m: any) => /sonnet/.test(m.id) && !m.fast && !/fast/.test(m.id))?.id ?? models[0]?.id ?? "sonnet";
    const info = models.find((m: any) => m.id === id);
    return { ref: { providerID: "claude-code", id, ...(state.variant ? { variant: state.variant } : {}) }, info };
  };

  /** The tools a request offers (tool/registry snapshot): the direct ones sorted by name — an MCP server's outside Code Mode, the skill tool —, then `execute`. */
  const offeredTools = (): ToolDefinitions => {
    const direct: ToolDefinitions = { ...state.tools, ...(state.skills ? SKILL_TOOL : {}) };
    // 2.2.0 with `execute` denied: the Code Mode tools are offered directly, under `<namespace>_<name>` (tool.ts
    // snapshot: `direct = codeModeEnabled ? … : active`); 2.0.32 dropped them.
    const directAll = state.codeMode === undefined && state.version !== "2.0.32";
    if (directAll) {
      for (const tool of OPENCODE_TOOLS) direct[`${tool.namespace.replaceAll(".", "_")}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`] = { description: tool.description, input: tool.input ?? { type: "object", properties: {} } };
    }
    for (const server of state.mcpServers.filter((s) => s.codemode === false || directAll)) {
      for (const tool of server.tools) direct[`${mcpNamespace(server.server)}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")}`] = { description: tool.description ?? "", input: tool.input ?? { type: "object", properties: {} } };
    }
    const sorted = Object.fromEntries(Object.entries(direct).toSorted(([a], [b]) => byText(a, b)));
    return { ...sorted, ...(state.codeMode ? EXECUTE_TOOL : {}) };
  };
  /**
   * The instruction sections of a session (session/context.ts `select`), joined by a blank line: the Code Mode
   * catalog, the MCP servers' instructions, the skills, the instruction files, the date, the environment, the host's
   * context entries. Observed at the session's first request and kept (instruction-state.ts); a compaction observes
   * them again. A section with nothing to say is left out.
   */
  const instructionsOf = (chat: string) => {
    const s = session(chat);
    if (s.instructions !== undefined) return s.instructions;
    const directory = s.directory ?? options.directory;
    const execute = state.codeMode !== undefined;
    const viaCodeMode = state.mcpServers.filter((server) => server.codemode !== false);
    const codeModeTools = [
      ...(state.codeMode?.tools ?? []),
      ...viaCodeMode.flatMap((server) => server.tools.map((tool) => ({ namespace: mcpNamespace(server.server), name: tool.name, description: tool.description ?? "", input: tool.input, output: tool.output ?? {} }))),
    ];
    // A server's instructions show when it has a tool the agent may use (mcp/instructions.ts); with `execute` denied a
    // Code Mode server's show as a direct one's in 2.2.0, and not at all in 2.0.32.
    const instructed = state.mcpServers
      .filter((server) => server.instructions !== undefined && server.tools.length > 0 && (server.codemode === false || execute || state.version !== "2.0.32"))
      .map((server) => (execute ? server : { ...server, codemode: false as const }));
    const files = instructionFiles(directory, state.instructions);
    const sections = [
      ...(execute ? [codeModeInstructions(codeModeTools, state.codeMode!.namespaces, state.version)] : []),
      ...(instructed.length > 0 ? [mcpInstructionsBlock(instructed)] : []),
      ...(state.skills?.length ? [skillsInstructions(state.skills)] : []),
      ...(files.length > 0 ? [instructionFilesBlock(files)] : []),
      `Today's date: ${new Date().toDateString()}`,
      environmentBlock(directory),
      ...Object.keys(state.contextEntries).toSorted().map((key) => contextBlock(key, state.contextEntries[key])),
    ];
    s.instructions = sections.join("\n\n");
    return s.instructions;
  };
  /** The system parts before any hook (model-request.ts `baseTranscript`): the agent's own prompt or the stock one, then the instructions. */
  const baseSystem = (chat: string, tools: ToolDefinitions) =>
    [state.agent.system ?? stockPrompt(Object.keys(tools)), instructionsOf(chat)].filter((text) => text.length > 0).map((text) => ({ type: "text", text }));
  /**
   * What OpenCode's own plugins do to the system parts of a turn, a summary and a generation before any other plugin
   * (plugin/internal.ts `pre`): `opencode.prompt.anthropic` appends its part to the stock prompt of a "claude" model,
   * `opencode.prompt.identity` puts "# Your Model" second, `opencode.tools` adds the worktree note at the end.
   */
  const builtInHooks = (system: Array<{ type: string; text: string }>, ref: { providerID: string; id: string }, info: any) => {
    if (state.agent.system === undefined && ref.id.toLowerCase().includes("claude") && system[0]) system[0] = { ...system[0], text: `${system[0].text}\n\n${ANTHROPIC_APPEND}` };
    system.splice(1, 0, { type: "text", text: modelIdentity(info?.name ?? ref.id, ref) });
    system.push({ type: "text", text: WORKTREE_NOTE });
  };
  /** The system text of `chat`'s next turn request as OpenCode sends it, before the plugin's hook (what the hooks get in `event.system`). */
  const systemOf = (chat: string) => {
    const { ref, info } = model();
    const system = baseSystem(chat, offeredTools());
    builtInHooks(system, ref, info);
    return system;
  };

  /**
   * OpenCode accepts a message (session/prompt.ts 40–91): the prompt hook gets
   * its text and files (a file from disk as a file:// URI, else a data URL),
   * its metadata and delivery; the message is what the hook left — its text,
   * its files taken as OpenCode takes them (`materialize`), its metadata.
   */
  const accept = async (chat: string, message: Msg) => {
    const onDisk = new Map<string, string>();
    const files = message.files?.map((f) => {
      if (f.path === undefined) return { uri: `data:${f.mediaType};base64,${f.data}`, ...(f.name ? { name: f.name } : {}) };
      const uri = pathToFileURL(f.path).href;
      onDisk.set(uri, f.data);
      return { uri, ...(f.name ? { name: f.name } : {}) };
    });
    const payload: { sessionID: string; messageID: string; prompt: { text: string; files?: Array<{ uri: string; name?: string }>; skills?: Array<{ id: string }> }; metadata?: Record<string, unknown>; delivery: string } = {
      sessionID: chat,
      messageID: message.id,
      prompt: { text: message.text, ...(files ? { files } : {}), ...(message.skills ? { skills: message.skills.map((skill) => ({ id: skill.name })) } : {}) },
      metadata: message.metadata ? structuredClone(message.metadata) : undefined,
      delivery: "steer",
    };
    await hookOf(chat, "prompt")?.(payload);
    state.foreignPromptHook?.(payload);
    message.text = payload.prompt.text;
    if (payload.prompt.files) message.files = payload.prompt.files.map((file) => materialize(file, onDisk));
    else delete message.files;
    if (payload.metadata) message.metadata = payload.metadata;
    else delete message.metadata;
  };
  /** What a client sends with a prompt besides its text and files. */
  type ClientInput = { metadata?: Record<string, unknown>; skills?: Array<{ name: string; text: string }> };
  const clientFields = (client: ClientInput): Partial<Msg> => ({
    ...(client.metadata ? { metadata: structuredClone(client.metadata) } : {}),
    ...(client.skills?.length ? { skills: client.skills.map((skill) => ({ ...skill })) } : {}),
  });
  const add = (chat: string, type: Msg["type"], text: string, extra: Partial<Msg> = {}) => {
    const s = session(chat);
    const message: Msg = { type, id: newId(), seq: nextSeq(s), text, ...extra };
    s.messages.push(message);
    return message;
  };
  /**
   * The user sends a message (with attachments: `files`); it is on the screen at once (delivered).
   * `client.metadata`: what the client sent with the prompt (session/prompt.ts `Input.metadata`), handed to
   * the prompt hook as a copy. `client.skills`: skills the user attached, as OpenCode loads them (the
   * message's `skills` with their text, session/prompt.ts 56-76).
   */
  const say = async (chat: string, text: string, files?: Msg["files"], client: ClientInput = {}) => {
    const message = add(chat, "user", text, { ...(files ? { files } : {}), ...clientFields(client) });
    await acceptOrDrop(chat, message);
    return message.id;
  };
  /** A message OpenCode refuses (an attachment it cannot take) never reaches the chat. */
  const acceptOrDrop = async (chat: string, message: Msg) => {
    try {
      await accept(chat, message);
    } catch (error) {
      const s = session(chat);
      s.messages.splice(s.messages.indexOf(message), 1);
      throw error;
    }
  };
  /** A turn another model answered: the plugin never saw it (the prompt hook did). */
  const otherModelAnswer = (chat: string, text: string, extra: Partial<Msg> = {}) => add(chat, "assistant", text, { finish: "stop", otherProvider: true, ...extra });
  /** Messages that do not pass the prompt hook. */
  const between = (chat: string, type: "synthetic" | "shell" | "skill" | "location" | "system", text: string, options: { skillName?: string } = {}) => {
    // A location switch moves the chat: its next requests go to the plugin instance of that directory.
    if (type === "location") session(chat).directory = text;
    return add(chat, type, text, type === "skill" ? { skillName: options.skillName ?? "skill" } : {});
  };
  /** The messages OpenCode puts in a request: since the latest compaction, the queue not yet. */
  const visible = (s: Session) => {
    const since = s.messages.findLastIndex((m) => m.type === "compaction");
    return s.messages.slice(Math.max(0, since)).filter((m) => !m.queued);
  };
  /** Keep the messages before `messageID`: the user edits it, or reverts to the answer before it. */
  const undoBefore = (chat: string, messageID: string) => {
    const s = session(chat);
    const at = s.messages.findIndex((m) => m.id === messageID);
    assert.ok(at >= 0, `undo: ${messageID} is in ${chat}`);
    s.messages = s.messages.slice(0, at);
  };
  const lastId = (chat: string) => session(chat).messages.at(-1)!.id;

  /**
   * One request as OpenCode makes it from a list: the hook (`context`, or
   * `compaction` for a summary) with the event, another plugin's hook, the
   * media limits, `model.request`, the lowered body (a summary's prompt
   * added after the hooks), HTTP.
   */
  /**
   * A request prepared as OpenCode prepares it (model-request.ts 243–318):
   * the hook (`context` for a turn, `compaction` for a summary) with the event
   * (`maxTokens` from `outputLimit` with the prompt's size), another plugin's
   * hook, the media limits, `model.request`. A summary's hook may answer by
   * itself (`event.result`).
   */
  const prepareRequest = async (
    chat: string,
    kind: "primary" | "compaction" | "generate" | "title",
    list: ListMessage[],
    options: {
      tools?: ToolDefinitions;
      inputTokens?: { measured: number; estimated: number };
      system?: Array<{ type: string; text: string }>;
      /** Another model than the primary one (a title's). */
      model?: { providerID: string; id: string; variant?: string };
    } = {},
  ) => {
    const primary = model();
    const ref = options.model ?? primary.ref;
    const info = options.model ? (instances[0]?.provider.models ?? []).find((m: any) => m.id === ref.id) : primary.info;
    const given = structuredClone(options.tools ?? (kind === "primary" || kind === "generate" ? offeredTools() : {}));
    // A title has its agent's prompt alone; a turn, a summary and a generation the session's (baseTranscript), then OpenCode's own hooks.
    const system = options.system ? structuredClone(options.system) : baseSystem(chat, kind === "compaction" ? offeredTools() : given);
    if (kind !== "title") builtInHooks(system, ref, info);
    // A turn and a summary get the default output limit; a title and a generation keep the provider's (model-request.ts 253–264).
    const event: ContextEvent & { result?: any } = {
      sessionID: chat,
      model: ref,
      system,
      messages: list,
      options: kind === "primary" || kind === "compaction" ? { maxTokens: outputLimit(info?.limit, kind, options.inputTokens, state.version) } : {},
      agent: "build",
      tools: { ...given },
    };
    // The title hook gets the draft alone, without the agent and tools (model-request.ts 423–431).
    if (kind === "title") {
      delete (event as Partial<ContextEvent>).agent;
      delete (event as Partial<ContextEvent>).tools;
    }
    // OpenCode's warming plugin hooks `context` (marking the chat as requesting), `compaction` and `generate`.
    if (kind === "primary" || kind === "compaction" || kind === "generate") warming.hook(chat, kind, event.messages);
    await hookOf(chat, kind === "primary" ? "context" : kind)?.(event);
    if (kind !== "title") state.foreignHook?.(event);
    event.tools ??= {};
    const messages = boundImages(unsupportedParts(event.messages, info?.capabilities?.input), state.version);
    const target = {
      sessionID: chat,
      agent: "build",
      model: ref,
      kind,
      baseURL: undefined as string | undefined,
      headers: {
        "x-opencode-session-id": chat,
        "x-session-affinity": chat,
        "X-Session-Id": chat,
        "User-Agent": `opencode/${state.version}`,
        "x-opencode-project": "proj",
        "x-opencode-session": chat,
        "x-opencode-client": "opencode",
      } as Record<string, string>,
    };
    await hookOf(chat, "model.request")?.(target);
    assert.ok(target.baseURL, "the plugin's model.request hook gives the address");
    return { event, messages, system: event.system, tools: toolsAfterHooks(given, event.tools), generation: generationOf(event.options), target, modelID: ref.id };
  };
  type Prepared = Awaited<ReturnType<typeof prepareRequest>>;
  /** Per chat, the text of the answer its latest turn request has streamed so far: what the screen shows now. */
  const shownNow = new Map<string, string>();
  const shown = (chat: string) => shownNow.get(chat) ?? "";
  /** Sends a prepared request with these messages and generation options; the reply read from the stream. */
  const sendRequest = async (prepared: Prepared, messages: ListMessage[], generation: Generation, signal?: AbortSignal, onText?: (text: string) => void, tools = prepared.tools) => {
    let body: ReturnType<typeof requestBody>;
    try {
      body = requestBody({ modelID: prepared.modelID, system: prepared.system, messages, tools, generation, version: state.version });
    } catch (error) {
      if (!(error instanceof LoweringError)) throw error;
      // OpenCode could not build the request: no HTTP, an invalid request.
      return { body: undefined as unknown as ReturnType<typeof requestBody>, invalid: error.message, counted: [count(), count()] as [number, number], sentAt: performance.now(), doneAt: performance.now() };
    }
    const from = count();
    const sentAt = performance.now();
    // The request is aborted by the user's stop or by a timeout (route/transport/http.js 58–81).
    const abort = new AbortController();
    const stop = () => abort.abort(signal?.reason);
    if (signal?.aborted) stop();
    else signal?.addEventListener("abort", stop, { once: true });
    let headersTimedOut = false;
    const headerTimer = setTimeout(() => {
      headersTimedOut = true;
      abort.abort();
    }, state.headerTimeoutMs);
    try {
      const res = await fetch(`${prepared.target.baseURL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer claude-code-proxy", ...prepared.target.headers },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      clearTimeout(headerTimer);
      // The stream is read here, so a stop while the answer is written aborts this request.
      const reply = await readReply(res, onText, { chunkTimeoutMs: state.chunkTimeoutMs, onTimeout: () => abort.abort() });
      return { body, reply, counted: [from, count()] as [number, number], sentAt, doneAt: performance.now() };
    } catch (error) {
      return { body, error: headersTimedOut ? new TransportTimeout("headers") : error, counted: [from, count()] as [number, number], sentAt, doneAt: performance.now() };
    } finally {
      clearTimeout(headerTimer);
      signal?.removeEventListener("abort", stop);
    }
  };
  /** A request that got no reply as OpenCode reads it: a timeout, or a transport failure. */
  const unansweredFailure = (error: unknown): Failure => (error instanceof TransportTimeout ? timeoutFailure(error) : { kind: "transport", message: String(error), retryable: true });
  /** A turn's request: prepared, then sent as the hooks left it. */
  const request = async (chat: string, list: ListMessage[], options: { signal?: AbortSignal; tools?: ToolDefinitions; inputTokens?: { measured: number; estimated: number } } = {}) => {
    const prepared = await prepareRequest(chat, "primary", list, options);
    shownNow.set(chat, "");
    try {
      return { event: prepared.event, ...(await sendRequest(prepared, prepared.messages, prepared.generation, options.signal, (text) => shownNow.set(chat, text))) };
    } finally {
      warming.settled(chat);
    }
  };
  /**
   * A retry as OpenCode schedules it (runner/retry.ts): the `retry` hook may
   * change the decision, `session.retry.scheduled` is published, then the
   * wait — on the simulator's clock (`state.sleep`), every wait in `retries`.
   */
  const scheduleRetry = async (chat: string, failure: Failure, attempt: number): Promise<boolean> => {
    const delay = retryDelay(attempt, failure.retryAfterMs);
    const event = {
      sessionID: chat,
      agent: "build",
      model: model().ref,
      error: { type: failure.kind, message: failure.message },
      attempt: attempt + 1,
      decision: { retry: true, delay } as { retry: boolean; delay?: number },
    };
    await hookOf(chat, "retry")?.(event);
    if (!event.decision.retry) return false;
    const wait = Number.isFinite(event.decision.delay) && event.decision.delay! >= 0 ? Math.ceil(event.decision.delay!) : delay;
    retries.push({ chat, attempt: attempt + 1, kind: failure.kind, delay: wait });
    await emit({ type: "session.retry.scheduled", data: { sessionID: chat, attempt: attempt + 1, at: Date.now() + wait, error: event.error } });
    await state.sleep(wait);
    return true;
  };
  /** Every retry OpenCode scheduled: the chat, its number, the failure's kind, the wait. */
  const retries: Array<{ chat: string; attempt: number; kind: FailureKind; delay: number }> = [];

  /**
   * A turn of `chat` as OpenCode runs it: the request (sent again on a
   * retryable failure), and while the answer calls tools, the tool results in
   * the next request of the turn. `toolOutput` (one text, or a text per
   * call), `toolFiles`: what the tools return. `steer`: a message the user sends while the tool runs, delivered
   * with the tool results — a text for the turn's first tool step, or a list, one entry per tool step in
   * order (an empty entry: nothing at that step; probe 26: each absorbed after its step's results). `stop`: the user stops the turn
   * (session.interrupt): the request aborted, the unwritten answer dropped,
   * `session.execution.interrupted`. `stopParked`: the user stops the turn
   * while its tool runs: the call ends as an error, the same event.
   */
  const turn = async (chat: string, options: { toolOutput?: string | ((call: ToolCall) => string | Promise<string>); toolFiles?: ToolFile[]; steer?: string | string[]; stop?: AbortSignal; stopParked?: boolean } = {}) => {
    const s = session(chat);
    const steers = typeof options.steer === "string" ? [options.steer] : [...(options.steer ?? [])];
    const requests: SentRequest[] = [];
    let answer: Msg = add(chat, "assistant", "", { pending: true });
    // One compaction after the provider refused a request as too long (runner/llm.ts 211, 262–289).
    let recoverOverflow = true;
    const compactions: Array<Awaited<ReturnType<typeof compact>>> = [];
    // The step's timeouts: a retry may follow at most three of them (runner/retry.ts 26–56).
    let timeouts = 0;
    const mayRetry = (failure: Failure, attempt: number) => attempt < RETRIES_MAX && (failure.code !== "Timeout" || ++timeouts <= TIMEOUT_RETRIES_MAX);
    for (let attempt = 0; ; attempt++) {
      if (attempt === 0) timeouts = 0;
      // Before every request of a step: compact when the context reached the ceiling (runner/llm.ts 217–222).
      const auto = await compact(chat, "auto");
      if (auto.status !== "skipped") compactions.push(auto);
      if (auto.status === "failed") {
        s.messages.splice(s.messages.indexOf(answer), 1);
        return { ok: false, requests, compactions, failure: { kind: "unknown" as FailureKind, message: auto.error.message, retryable: false } };
      }
      // No compaction due: 2.2.0 may start a summary in the background, then the step goes on (runner/llm.ts).
      if (auto.status === "skipped") precompute(chat);
      const messages = contextOf(chat);
      const sent = await request(chat, toList(messages), { signal: options.stop, inputTokens: estimatePrompt(chat, messages) });
      if (!sent.reply) {
        requests.push({ list: sent.event.messages, body: sent.body, status: 0, counted: sent.counted, sentAt: sent.sentAt, doneAt: sent.doneAt });
        if ("invalid" in sent && sent.invalid) {
          s.messages.splice(s.messages.indexOf(answer), 1);
          return { ok: false, requests, compactions, failure: { kind: "invalid-request" as FailureKind, message: sent.invalid, retryable: false } };
        }
        if (!options.stop?.aborted) {
          // The request never got an answer (the connection failed, or no headers in time): a transport failure, sent again.
          const failure = unansweredFailure(sent.error);
          if (mayRetry(failure, attempt) && (await scheduleRetry(chat, failure, attempt))) continue;
          s.messages.splice(s.messages.indexOf(answer), 1);
          return { ok: false, requests, failure };
        }
        s.messages.splice(s.messages.indexOf(answer), 1);
        await emit({ type: "session.execution.interrupted", data: { sessionID: chat, reason: "user" } });
        return { ok: false, requests, stopped: true };
      }
      const reply = sent.reply;
      const record: SentRequest = { list: sent.event.messages, body: sent.body, status: reply.status, reply, counted: sent.counted, sentAt: sent.sentAt, doneAt: sent.doneAt };
      requests.push(record);
      // What the stream showed before it broke stays on the message with the
      // error (instance-dy6575tn.js 101–160); an answer that never started is
      // not kept, and only such a request is sent again.
      const started = outputStarted(reply);
      const keepShown = (error: string) => {
        if (!started) {
          s.messages.splice(s.messages.indexOf(answer), 1);
          return;
        }
        answer.text = reply.text;
        if (reply.reasoning) answer.reasoning = reply.reasoning;
        answer.error = error;
        delete answer.pending;
      };
      if (options.stop?.aborted && reply.streamError) {
        keepShown("interrupted");
        await emit({ type: "session.execution.interrupted", data: { sessionID: chat, reason: "user" } });
        return { ok: false, requests, stopped: true };
      }
      const failure = failureOf(reply, state.version);
      if (failure) {
        // Too long before the answer started: compact, then the step again, once (instance-dy6575tn.js 116–123).
        if (!started && failure.kind === "context-overflow" && recoverOverflow) {
          const overflow = await compact(chat, "overflow");
          compactions.push(overflow);
          if (overflow.status === "completed") {
            recoverOverflow = false;
            attempt = -1;
            continue;
          }
        }
        // Sent again when the answer had not started and the kind allows it (retry.ts, instance-dy6575tn.js 137–141).
        if (!started && failure.retryable && failure.kind !== "context-overflow" && mayRetry(failure, attempt) && (await scheduleRetry(chat, failure, attempt))) continue;
        keepShown(failure.message);
        // Broken once the answer had started, with no tool call in it: the shown part stays with its error, then a
        // synthetic user message and the request again, within the step's limits (Outcome.Continue,
        // instance-dy6575tn.js 137–206, instance-71svxegq.js 302–309).
        if (started && failure.retryable && failure.kind !== "context-overflow" && reply.toolCalls.length === 0 && mayRetry(failure, attempt) && (await scheduleRetry(chat, failure, attempt))) {
          add(chat, "synthetic", CONTINUE_AFTER_INTERRUPTION);
          answer = add(chat, "assistant", "", { pending: true });
          continue;
        }
        return { ok: false, requests, compactions, failure };
      }
      // The answer's tokens as OpenCode records them (openai-chat.js mapUsage, session/usage.ts tokens).
      const usage = reply.usage as Record<string, any> | undefined;
      if (usage) {
        const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
        const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens ?? usage.cache_created_input_tokens ?? 0;
        const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
        answer.tokens = {
          input: Math.max(0, (usage.prompt_tokens ?? 0) - cacheRead - cacheWrite),
          output: Math.max(0, (usage.completion_tokens ?? 0) - reasoning),
          reasoning,
          cacheRead,
          cacheWrite,
        };
      }
      if (reply.reasoning) answer.reasoning = reply.reasoning;
      // An answer cut at the output limit (finish `length`, instance-dy6575tn.js 198–200) is kept with that finish;
      // when it and the two messages before it are all such answers the step fails (instance-71svxegq.js 311–321).
      const cut = reply.finish === "length";
      const outputLimitFailure = { kind: "unknown" as FailureKind, message: OUTPUT_LIMIT_EXHAUSTED, retryable: false };
      if (reply.toolCalls.length > 0) {
        answer.toolCalls = reply.toolCalls;
        answer.text = reply.text;
        answer.finish = cut ? "length" : "tool-calls";
        delete answer.pending;
        if (options.stopParked) {
          answer.toolResults = reply.toolCalls.map((c) => ({ id: c.id, output: "Tool execution aborted", error: true }));
          await emit({ type: "session.execution.interrupted", data: { sessionID: chat, reason: "user" } });
          return { ok: false, requests, stopped: true };
        }
        // OpenCode runs the tools; the step ends, the next request carries the results.
        // A tool may take time: OpenCode sends the results once every call of the step ended.
        const output = (call: ToolCall) => (typeof options.toolOutput === "function" ? options.toolOutput(call) : (options.toolOutput ?? "done"));
        const outputs = await Promise.all(reply.toolCalls.map((c) => output(c)));
        answer.toolResults = reply.toolCalls.map((c, k) => ({ id: c.id, output: outputs[k]!, ...(options.toolFiles ? { files: options.toolFiles } : {}) }));
        // A cut tool step goes on with its results, no synthetic text (instance-71svxegq.js 322–323), unless the step failed.
        if (cut && outputLimitExhausted(s.messages)) return { ok: false, requests, compactions, answer, failure: outputLimitFailure };
        // The user's message sent while this step's tool ran (one entry per tool step, in order).
        const steer = steers.shift();
        if (steer) await say(chat, steer);
        answer = add(chat, "assistant", "", { pending: true });
        attempt = -1;
        continue;
      }
      answer.text = reply.text;
      delete answer.pending;
      if (cut) {
        answer.finish = "length";
        if (outputLimitExhausted(s.messages)) return { ok: false, requests, compactions, answer, failure: outputLimitFailure };
        // The answer stays, a synthetic user message asks for the rest, the request again — not a retry
        // (Outcome.OutputLimit, instance-71svxegq.js 311–326).
        add(chat, "synthetic", CONTINUE_AFTER_OUTPUT_LIMIT);
        answer = add(chat, "assistant", "", { pending: true });
        attempt--;
        continue;
      }
      answer.finish = "stop";
      // A turn that needs no continuation: 2.2.0 may start a summary in the background from the chat as it now is.
      precompute(chat);
      return { ok: true, requests, compactions, answer };
    }
  };

  /** The messages a request of `chat` is built from: since the latest compaction, no answer still being written. */
  const contextOf = (chat: string) => visible(session(chat)).filter((m) => !m.pending);
  /** The prompt's size: what the provider measured at the latest answer, and an estimate of what came since (estimatePrompt). */
  const estimatePrompt = (chat: string, messages: Msg[]) => {
    const { info } = model();
    const measuredAt = messages.findLastIndex(
      (m) => m.type === "assistant" && !m.otherProvider && !m.error && m.tokens !== undefined && m.tokens.input + m.tokens.cacheRead + m.tokens.cacheWrite > 0,
    );
    const anchor = measuredAt >= 0 ? messages[measuredAt] : undefined;
    const sent = boundImages(unsupportedParts(toList(messages.slice(Math.max(0, measuredAt))), info?.capabilities?.input), state.version);
    const unmeasured = sent.filter((m) => m.role !== "assistant" || m.id !== anchor?.id);
    const tools = offeredTools();
    if (!anchor?.tokens) return { measured: 0, estimated: estimateRequest(baseSystem(chat, tools), tools, unmeasured) };
    const t = anchor.tokens;
    return { measured: t.input + t.cacheRead + t.cacheWrite + t.output + t.reasoning, estimated: unmeasured.reduce((sum, m) => sum + estimateMessage(m), 0) };
  };
  const estimateContext = (chat: string, messages: Msg[]) => {
    const prompt = estimatePrompt(chat, messages);
    return prompt.measured + prompt.estimated;
  };

  /** The share of the prompt the provider measured (2.2.0 measuredPrompt): only when the latest measured answer is there. */
  const measuredPrompt = (chat: string, messages: Msg[]) =>
    messages.some((m) => m.type === "assistant" && !m.otherProvider && !m.error && m.tokens !== undefined && m.tokens.input + m.tokens.cacheRead + m.tokens.cacheWrite > 0)
      ? estimatePrompt(chat, messages)
      : undefined;
  const total = (size: { measured: number; estimated: number }) => size.measured + size.estimated;
  type Summary = { text: string; metadata?: Record<string, unknown> } | { error: { type: string; message: string } };

  /**
   * One summary as OpenCode 2.2.0 writes it (compaction.ts `summarize`, `deliver`): the whole conversation goes to the
   * `compaction` hook, and the request reuses it with the summary prompt added after the hooks while the measured
   * prompt fits the room a summary may take (`summaryRoom`); else the older part alone (`withoutTail`, cut at the
   * first kept message), else the request as text losing detail level by level (no tools), shrunk to
   * 85/70/50/35% after an overflow; the output limit fitted with a floor of 32 000. A hook may answer by itself.
   * `background`: the summary of the messages before the latest measured answer, written while the chat goes on —
   * no tail cut, no events; its requests can be aborted.
   */
  const summarize = async (
    chat: string,
    messages: Msg[],
    reason: "manual" | "auto" | "overflow",
    budget: number,
    requests: SentRequest[],
    background?: { signal: AbortSignal },
  ): Promise<Summary> => {
    const { info } = model();
    const limit = info?.limit;
    const split = splitConversation(messages, COMPACTION_KEEP, state.version);
    if (!split) return { error: { type: "compaction.unavailable", message: "Nothing to compact yet" } };
    const keepID = background ? undefined : split.keepID;
    const withKeep = (metadata?: Record<string, unknown>) => (keepID ? { metadata: { keepID, ...metadata } } : metadata ? { metadata } : {});
    const previous = previousCompaction(messages);
    const prompt = buildSummaryPrompt(previous !== undefined, previous?.summary?.includes(LEGACY_HEADING) ?? false);
    const prepared = await prepareRequest(chat, "compaction", toList(messages), { inputTokens: { measured: budget, estimated: 0 } });
    if (prepared.event.result) return { text: prepared.event.result.summary, ...withKeep(prepared.event.result.metadata) };
    const measured = reason === "overflow" ? undefined : measuredPrompt(chat, messages);
    // The older part: the hooks' list up to the first kept message, found by its id (withoutTail).
    const cut = keepID === undefined ? -1 : prepared.messages.findIndex((m) => m.id === keepID);
    const history = cut < 0 ? prepared.messages : prepared.messages.slice(0, cut);

    /** The summary's output limit fitted to its request (fitOutput, 2.2.0): at least 32 000 when the window allows. */
    const fitted = (list: ListMessage[], tools: ToolDefinitions, size?: { measured: number; estimated: number }): Generation => {
      const current = prepared.generation.maxTokens;
      if (current === undefined) return prepared.generation;
      const input = size ?? { measured: 0, estimated: estimateRequest(prepared.system, tools, list) };
      const maxTokens = Math.min(current, Math.max(outputLimit(limit, "compaction", input, state.version), Math.min(SUMMARY_OUTPUT_FLOOR, outputLimit(limit, "compaction", { measured: total(input), estimated: 0 }, state.version))));
      return { ...prepared.generation, maxTokens };
    };
    /** One summary request and how it ended (compaction.ts `stream`). */
    const ask = async (list: ListMessage[], tools: ToolDefinitions, size?: { measured: number; estimated: number }): Promise<{ text: string } | { failure: Failure } | { error: { type: string; message: string } }> => {
      const sent = await sendRequest(prepared, list, fitted(list, tools, size), background?.signal, undefined, tools);
      requests.push({ list: prepared.event.messages, body: sent.body, status: sent.reply?.status ?? 0, reply: sent.reply, counted: sent.counted, sentAt: sent.sentAt, doneAt: sent.doneAt });
      if (background?.signal.aborted) return { error: { type: "compaction.interrupted", message: "Compaction was interrupted" } };
      if (!sent.reply) {
        if ("invalid" in sent && sent.invalid) return { error: { type: "invalid-request", message: sent.invalid } };
        return { failure: unansweredFailure((sent as { error?: unknown }).error) };
      }
      const reply = sent.reply;
      if (reply.finish === "length") return { error: { type: "compaction.failed", message: "Compaction summary reached the output token limit" } };
      if (reply.finish === "content_filter") return { error: { type: "provider.content-filter", message: "Compaction summary was blocked by the provider" } };
      if (reply.status === 200 && !reply.error && !reply.streamError && reply.finish === "error") return { failure: { kind: "unknown", message: "Compaction generation failed", retryable: true } };
      const failure = failureOf(reply, state.version);
      return failure ? { failure } : { text: reply.text };
    };
    const send = async (list: ListMessage[], tools: ToolDefinitions, size?: { measured: number; estimated: number }) => {
      const prompted: ListMessage[] = [...list, { role: "user", content: [textPart(prompt)] }];
      const first = await ask(prompted, tools, size && { ...size, estimated: size.estimated + estimateTokens(prompt) });
      if (!("text" in first)) return first;
      if (summaryFilled(first.text)) return first;
      const second = await ask([...prompted, { role: "user", content: [textPart(SUMMARY_NUDGE)] }], tools, size && { ...size, estimated: size.estimated + estimateTokens(prompt) + estimateTokens(SUMMARY_NUDGE) });
      if (!("text" in second)) return second;
      if (summaryFilled(second.text)) return second;
      return { error: { type: "compaction.failed", message: second.text.trim() ? "Compaction summary did not match the required template" : "Compaction produced no summary" } };
    };

    const overhead = estimateTokens(prompt) + estimateTokens(SUMMARY_NUDGE);
    let target = budget - overhead;
    let fit = (reason === "overflow" ? budget : Math.max(budget, summaryRoom(limit, prepared.generation.maxTokens))) - overhead;
    let rejections = 0;
    let rejected: number | undefined;
    let asText = false;
    let timeouts = 0;
    for (let attempt = 0; ; ) {
      const measuredNow = rejections === 0 ? measured : undefined;
      const unchanged = asText
        ? undefined
        : (measuredNow ? total(measuredNow) : estimateRequest(prepared.system, prepared.tools, prepared.messages)) <= fit
          ? prepared.messages
          : estimateRequest(prepared.system, prepared.tools, history) <= target
            ? history
            : undefined;
      const list =
        unchanged ??
        flattenToFit(history, previous, prepared.system, target) ??
        (rejections > 0 ? undefined : asText ? flattenToFit(history, previous, prepared.system, Number.POSITIVE_INFINITY) : history);
      if (!list) return { error: { type: "compaction.failed", message: "The compaction request cannot be reduced further without losing the latest exchange or checkpoint" } };
      const tools = list === prepared.messages || list === history ? prepared.tools : {};
      const size = list === prepared.messages ? measuredNow : undefined;
      const result = await send(list, tools, size);
      if ("text" in result) return { text: result.text, ...withKeep() };
      if ("error" in result) return result;
      const failure = result.failure;
      const tooLarge = failure.kind === "payload-too-large";
      if (tooLarge && (list === prepared.messages || list === history)) {
        asText = true;
        continue;
      }
      if (tooLarge || failure.kind === "context-overflow") {
        const step = shrinkSteps(state.version)[rejections];
        if (step === undefined) return { error: { type: failure.kind, message: failure.message } };
        rejected ??= size ? total(size) : estimateRequest(prepared.system, tools, list);
        if (size) asText = true;
        target = Math.floor(rejected * step);
        fit = target;
        rejections++;
        continue;
      }
      if (failure.code === "Timeout" && ++timeouts > TIMEOUT_RETRIES_MAX) return { error: { type: failure.kind, message: failure.message } };
      if (!failure.retryable || attempt >= RETRIES_MAX || !(await scheduleRetry(chat, failure, attempt++))) return { error: { type: failure.kind, message: failure.message } };
    }
  };

  /**
   * One summary as OpenCode 2.0.32 wrote it: the older part alone to the `compaction` hook, `session.compaction.started`
   * after the hooks, the request as text dropping whole exchanges, shrunk to 70/50/35% after an overflow.
   */
  const summarizeLegacy = async (chat: string, messages: Msg[], reason: "manual" | "auto" | "overflow", budget: number, requests: SentRequest[], started: (recent: string) => Promise<void>): Promise<Summary> => {
    const { info } = model();
    const limit = info?.limit;
    const split = splitConversation(messages, COMPACTION_KEEP, state.version);
    if (!split) return { error: { type: "compaction.unavailable", message: "Nothing to compact yet" } };
    const previous = previousCompaction(messages);
    const prompt = buildSummaryPrompt(previous !== undefined, previous?.summary?.includes(LEGACY_HEADING) ?? false);
    const prepared = await prepareRequest(chat, "compaction", toList(split.older), { inputTokens: { measured: budget, estimated: 0 } });
    await started(split.recent);
    if (prepared.event.result) return { text: prepared.event.result.summary, ...(prepared.event.result.metadata ? { metadata: prepared.event.result.metadata } : {}) };

    /** The summary's output limit fitted to the room its request leaves (fitOutput). */
    const fit = (list: ListMessage[]): Generation => {
      const current = prepared.generation.maxTokens;
      if (current === undefined) return prepared.generation;
      return { ...prepared.generation, maxTokens: Math.min(current, outputLimit(limit, "compaction", { measured: estimateRequest(prepared.system, prepared.tools, list), estimated: 0 }, state.version)) };
    };
    /** One summary request and how it ended (compaction.ts `stream`). */
    const ask = async (list: ListMessage[]): Promise<{ text: string } | { failure: Failure } | { error: { type: string; message: string } }> => {
      const sent = await sendRequest(prepared, list, fit(list));
      requests.push({ list: prepared.event.messages, body: sent.body, status: sent.reply?.status ?? 0, reply: sent.reply, counted: sent.counted, sentAt: sent.sentAt, doneAt: sent.doneAt });
      if (!sent.reply) {
        if ("invalid" in sent && sent.invalid) return { error: { type: "invalid-request", message: sent.invalid } };
        return { failure: unansweredFailure((sent as { error?: unknown }).error) };
      }
      const reply = sent.reply;
      if (reply.finish === "length") return { error: { type: "compaction.failed", message: "Compaction summary reached the output token limit" } };
      if (reply.finish === "content_filter") return { error: { type: "provider.content-filter", message: "Compaction summary was blocked by the provider" } };
      if (reply.status === 200 && !reply.error && !reply.streamError && reply.finish === "error") return { failure: { kind: "unknown", message: "Compaction generation failed", retryable: true } };
      const failure = failureOf(reply, state.version);
      return failure ? { failure } : { text: reply.text };
    };
    const send = async (list: ListMessage[]) => {
      const prompted: ListMessage[] = [...list, { role: "user", content: [textPart(prompt)] }];
      const first = await ask(prompted);
      if (!("text" in first)) return first;
      if (summaryFilled(first.text)) return first;
      const second = await ask([...prompted, { role: "user", content: [textPart(SUMMARY_NUDGE)] }]);
      if (!("text" in second)) return second;
      if (summaryFilled(second.text)) return second;
      return { error: { type: "compaction.failed", message: second.text.trim() ? "Compaction summary did not match the required template" : "Compaction produced no summary" } };
    };

    let target = budget - (estimateTokens(prompt) + estimateTokens(SUMMARY_NUDGE));
    let rejections = 0;
    let rejected: number | undefined;
    let asText = false;
    let timeouts = 0;
    for (let attempt = 0; ; ) {
      const fits = !asText && estimateRequest(prepared.system, prepared.tools, prepared.messages) <= target;
      const list = fits
        ? prepared.messages
        : (flattenAndDropOldest(prepared.messages, previous, prepared.system, prepared.tools, target) ??
          (rejections > 0 ? undefined : asText ? flattenAndDropOldest(prepared.messages, previous, prepared.system, prepared.tools, Number.POSITIVE_INFINITY) : prepared.messages));
      if (!list) return { error: { type: "compaction.failed", message: "The compaction request cannot be reduced further without losing the latest exchange or checkpoint" } };
      const result = await send(list);
      if ("text" in result) return { text: result.text };
      if ("error" in result) return result;
      const failure = result.failure;
      const tooLarge = failure.kind === "payload-too-large";
      if (tooLarge && list === prepared.messages) {
        asText = true;
        continue;
      }
      if (tooLarge || failure.kind === "context-overflow") {
        const step = shrinkSteps(state.version)[rejections];
        if (step === undefined) return { error: { type: failure.kind, message: failure.message } };
        rejected ??= estimateRequest(prepared.system, prepared.tools, list);
        target = Math.floor(rejected * step);
        rejections++;
        continue;
      }
      if (failure.code === "Timeout" && ++timeouts > TIMEOUT_RETRIES_MAX) return { error: { type: failure.kind, message: failure.message } };
      if (!failure.retryable || attempt >= RETRIES_MAX || !(await scheduleRetry(chat, failure, attempt++))) return { error: { type: failure.kind, message: failure.message } };
    }
  };

  /**
   * A summary written in the background (2.2.0 `precompute`, with `experimental.background_compaction`): per chat, the
   * first message it starts from, the first message it leaves out (the latest measured answer, `keepID`), the model,
   * the tail it may leave, the summary itself while it is written, and how many before it failed.
   */
  type Held = {
    firstID?: string;
    keepID: string;
    model: { providerID: string; id: string; variant?: string };
    tailLimit: number;
    failures: number;
    settled?: "done" | "failed";
    abort: AbortController;
    requests: SentRequest[];
    summary: Promise<Summary>;
  };
  const precomputed = new Map<string, Held>();
  /** Every summary written in the background, in order (requests, and how it ended). */
  const backgroundSummaries: Array<{ chat: string; keepID: string; requests: SentRequest[]; summary: Promise<Summary> }> = [];
  const tailTokens = (messages: Msg[], index: number) => estimateTokens(messages.slice(index).map((m) => messageToText(m, state.version)).filter(Boolean).join("\n\n"));
  const tailLimit = (keep: number, budget: number) => Math.min(Math.max(keep * 2, PRECOMPUTED_TAIL_MIN), Math.floor(budget * PRECOMPUTED_TAIL_SHARE));
  /** Where a held summary's kept part starts in the chat now, or -1 when it no longer fits the chat (heldIndex). */
  const heldIndex = (held: Held, messages: Msg[]) => {
    const { ref } = model();
    if (held.firstID !== messages[0]?.id) return -1;
    if (held.model.providerID !== ref.providerID || held.model.id !== ref.id || held.model.variant !== ref.variant) return -1;
    return messages.findIndex((m) => m.id === held.keepID);
  };
  const interruptHeld = (chat: string, held: Held) => {
    held.abort.abort();
    if (precomputed.get(chat) === held) precomputed.delete(chat);
  };
  /**
   * OpenCode 2.2.0 starts a summary in the background (compaction.ts `precompute`; runner/llm.ts: at a step's start
   * when no compaction is due, and after a turn that needs no continuation): with background compaction on, auto
   * compaction on, the context at 85% of the ceiling or more but not due, and the latest measured answer of this model
   * at 64 000 prompt tokens or more — a summary of the messages before that answer. A held one is kept while its tail
   * stays within the limit; one that failed is retried up to twice for the same answer.
   */
  const precompute = (chat: string, messages = contextOf(chat)) => {
    if (state.version === "2.0.32" || !state.backgroundCompaction || !state.autoCompaction || state.compactionElsewhere) return;
    const { info, ref } = model();
    const ceiling = calculateCeiling(info?.limit, state.compactionBuffer, state.version);
    if (!Number.isFinite(ceiling)) return;
    const estimate = total(estimatePrompt(chat, messages));
    if (estimate >= ceiling && messages.at(-1)?.type !== "compaction") return;
    if (estimate < ceiling * PRECOMPUTE_RATIO) return;
    const anchorIndex = messages.findLastIndex((m) => m.type === "assistant" && !m.otherProvider && !m.error && m.tokens !== undefined && m.tokens.input + m.tokens.cacheRead + m.tokens.cacheWrite > 0);
    const anchor = messages[anchorIndex];
    if (anchorIndex <= 0 || !anchor?.tokens) return;
    if (anchor.tokens.input + anchor.tokens.cacheRead + anchor.tokens.cacheWrite < PRECOMPUTE_MIN_TOKENS) return;
    const existing = precomputed.get(chat);
    const failed = existing?.settled === "failed";
    const failures = (existing?.failures ?? 0) + (failed ? 1 : 0);
    if (existing) {
      const index = heldIndex(existing, messages);
      if (index >= 0 && !failed && tailTokens(messages, index) <= existing.tailLimit) return;
      if (index >= 0 && (existing.keepID === anchor.id || failures >= PRECOMPUTE_MAX_FAILURES)) return;
      interruptHeld(chat, existing);
    }
    const cap = calculateCeiling(info?.limit, state.compactionBuffer, state.version);
    const abort = new AbortController();
    const requests: SentRequest[] = [];
    const held: Held = { firstID: messages[0]?.id, keepID: anchor.id, model: ref, tailLimit: tailLimit(COMPACTION_KEEP, cap), failures, abort, requests, summary: Promise.resolve({ error: { type: "pending", message: "" } }) };
    held.summary = summarize(chat, messages.slice(0, anchorIndex), "auto", cap, requests, { signal: abort.signal }).then(
      (result) => {
        held.settled = "error" in result ? "failed" : "done";
        return result;
      },
      (error: unknown) => {
        held.settled = "failed";
        return { error: { type: "unknown", message: String(error) } };
      },
    );
    precomputed.set(chat, held);
    backgroundSummaries.push({ chat, keepID: anchor.id, requests, summary: held.summary });
  };

  /**
   * OpenCode compacts `chat` (compaction.ts `compact`, `publish`): `auto` only when the context reached the ceiling,
   * `overflow` after the provider refused the request as too long, `manual` always. 2.2.0: `session.compaction.started`
   * first (not manual); a summary written in the background is swapped in when its tail still fits; else the summary
   * (`summarize`). The checkpoint keeps the first kept message's id (`metadata.keepID`) and OpenCode reads the tail
   * from it; 2.0.32 (`summarizeLegacy`) wrote the tail on the checkpoint. The outcome: the checkpoint and
   * `session.compaction.ended`, or `session.compaction.failed`.
   */
  const compact = async (chat: string, reason: "manual" | "auto" | "overflow" = "manual") => {
    const requests: SentRequest[] = [];
    const messages = contextOf(chat);
    const { info } = model();
    const limit = info?.limit;
    const legacy = state.version === "2.0.32";
    const published = reason === "manual" ? "manual" : "auto";
    const last = () => requests.at(-1);
    const outcome = <T extends object>(rest: T) => ({ ...rest, requests, list: requests[0]?.list ?? [], body: last()?.body, reply: last()?.reply, counted: [requests[0]?.counted[0] ?? count(), last()?.counted[1] ?? count()] as [number, number], sentAt: requests[0]?.sentAt ?? 0, doneAt: last()?.doneAt ?? 0 });
    if (reason !== "manual" && !state.autoCompaction) return outcome({ status: "skipped" as const });
    const ceiling = calculateCeiling(limit, state.compactionBuffer, state.version);
    if (reason === "auto") {
      const lastMessage = messages.at(-1);
      if (lastMessage?.type === "compaction" || estimateContext(chat, messages) < ceiling) return outcome({ status: "skipped" as const });
    }
    const held = legacy ? undefined : precomputed.get(chat);
    if (held) precomputed.delete(chat);
    const cap = Number.isFinite(ceiling) ? ceiling : calculateCeiling({ ...limit, context: UNKNOWN_WINDOW }, state.compactionBuffer, state.version);
    const budget = reason === "overflow" ? Math.min(cap, Math.floor(estimateContext(chat, messages) * shrinkSteps(state.version)[0]!)) : cap;
    const fail = async (error: { type: string; message: string }) => {
      await emit({ type: "session.compaction.failed", data: { sessionID: chat, reason: published, error } });
      return outcome({ status: "failed" as const, error });
    };
    const done = async (text: string, metadata?: Record<string, unknown>, legacyRecent?: string) => {
      // The checkpoint goes before an answer still being written: that answer is the step after the compaction.
      const s = session(chat);
      const pendingAt = s.messages.findIndex((m) => m.pending);
      const at = pendingAt >= 0 ? pendingAt : s.messages.length;
      // 2.2.0 reads the kept tail from `keepID` up to the checkpoint (history.ts withRecentText); 2.0.32 stored it.
      const keepID = typeof metadata?.keepID === "string" ? metadata.keepID : undefined;
      const recent = legacy ? legacyRecent : keepID ? recentFrom(s.messages.slice(0, at), keepID, state.version) : undefined;
      const checkpoint: Msg = { type: "compaction", id: newId(), seq: nextSeq(s), text: "", summary: text, ...(recent ? { recent } : {}), ...(metadata ? { metadata } : {}) };
      s.messages.splice(at, 0, checkpoint);
      // A new epoch: the instructions are observed again (instruction-state.ts advanceEpoch).
      delete s.instructions;
      await emit({ type: "session.compaction.ended", data: { sessionID: chat, reason: published, text, ...(legacy ? { recent: legacyRecent } : {}) } });
      return outcome({ status: "completed" as const, summary: text });
    };
    if (!legacy && reason !== "manual") await emit({ type: "session.compaction.started", data: { sessionID: chat, reason: "auto" } });
    if (state.compactionElsewhere) {
      // The compaction agent runs on another provider's model: no request and no hook of the plugin's
      // (its hooks are scoped to its provider), the same checkpoint and events as any compaction.
      const split = splitConversation(messages, COMPACTION_KEEP, state.version);
      if (!split) return fail({ type: "compaction.unavailable", message: "Nothing to compact yet" });
      if (legacy && reason !== "manual") await emit({ type: "session.compaction.started", data: { sessionID: chat, reason: "auto", recent: split.recent } });
      return done("another model's summary", legacy || !split.keepID ? undefined : { keepID: split.keepID }, split.recent);
    }
    if (held) {
      // The summary written in the background, when its tail still fits (usePrecomputed).
      const index = heldIndex(held, messages);
      const usable = state.backgroundCompaction && reason !== "overflow" && index >= 0 && tailTokens(messages, index) <= tailLimit(COMPACTION_KEEP, budget);
      if (!usable) interruptHeld(chat, held);
      else {
        const result = await held.summary;
        requests.push(...held.requests);
        if ("text" in result) return done(result.text, { keepID: held.keepID, ...result.metadata });
      }
    }
    let legacyRecent: string | undefined;
    const result = legacy
      ? await summarizeLegacy(chat, messages, reason, budget, requests, async (recent) => {
          legacyRecent = recent;
          if (reason !== "manual") await emit({ type: "session.compaction.started", data: { sessionID: chat, reason: "auto", recent } });
        })
      : await summarize(chat, messages, reason, budget, requests);
    if ("error" in result) return fail(result.error);
    return done(result.text, result.metadata, legacyRecent);
  };
  /**
   * OpenCode titles `chat` (session/title.ts): the title agent's prompt, the
   * first user message as one user message, the `title` hook (it may answer
   * itself: `event.result`), `model.request` with kind `title`, the answer's
   * first non-blank line, at most 100 characters, `session.renamed`. The
   * title's model (`state.titleModelID`) with its variant (`state.titleVariant`,
   * else the first of none / minimal / low it offers) first; when it failed or
   * answered no non-blank line, once more on the primary model if that is
   * another one, the variant included (title chunk 136). A failed request leaves
   * the title as it was.
   */
  const title = async (chat: string) => {
    const first = session(chat).messages.find((m) => m.type === "user");
    if (!first) return { requests: [] as SentRequest[] };
    const requests: SentRequest[] = [];
    // One attempt (SessionTitle.attempt): the hook's own result, else the request's first non-blank line; undefined when it failed.
    // 2.2.0 wraps the first message (title.ts messagePrompt); 2.0.32 sent it as it is.
    const asked = state.version === "2.0.32" ? first.text : titleMessagePrompt(first.text);
    const attempt = async (ref: { providerID: string; id: string; variant?: string }) => {
      const prepared = await prepareRequest(chat, "title", [{ role: "user", content: [textPart(asked)] }], { system: [{ type: "text", text: TITLE_SYSTEM }], model: ref });
      if (prepared.event.result !== undefined) return String(prepared.event.result);
      const sent = await sendRequest(prepared, prepared.messages, prepared.generation);
      requests.push({ list: prepared.event.messages, body: sent.body, status: sent.reply?.status ?? 0, reply: sent.reply, counted: sent.counted, sentAt: sent.sentAt, doneAt: sent.doneAt, model: ref });
      if (!sent.reply || failureOf(sent.reply, state.version)) return undefined;
      return sent.reply.text.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
    };
    const primary = model().ref;
    const id = state.titleModelID ?? primary.id;
    // The title's variant (SessionContext.selectTitle): the title agent's own, else the first of none / minimal / low
    // the model offers; a ref that differs in the variant alone is another model (title.ts isDeepStrictEqual).
    // 2.2.0 with neither a title agent's model nor a small model (`titleModelID` unset): the primary model with the
    // first of none / minimal / low it offers, "low" only when it ranks below the user's variant (lowerVariant); none
    // of them: the primary as the user picked it.
    const info = (instances[0]?.provider.models ?? []).find((m: any) => m.id === id);
    const offered: string[] = (info?.variants ?? []).map((item: { id: string }) => item.id);
    const lower = () => TITLE_VARIANTS.find((v) => offered.includes(v) && (v !== "low" || offered.indexOf(v) < offered.indexOf(primary.variant ?? "")));
    const variant = state.titleVariant ?? (state.titleModelID === undefined && state.version !== "2.0.32" ? lower() : TITLE_VARIANTS.find((v) => offered.includes(v)));
    const selected = state.titleModelID === undefined && state.version !== "2.0.32" && state.titleVariant === undefined && variant === undefined ? primary : { providerID: primary.providerID, id, ...(variant ? { variant } : {}) };
    const same = selected.id === primary.id && selected.variant === primary.variant;
    const text = (await attempt(selected)) ?? (same ? undefined : await attempt(primary));
    if (!text) return { requests };
    const named = text.length <= 100 ? text : `${text.slice(0, 97)}...`;
    session(chat).title = named;
    await emit({ type: "session.renamed", data: { sessionID: chat, title: named } });
    return { title: named, requests };
  };
  /**
   * A generation from `chat`'s context (session/generate.ts): the chat's
   * messages, then `prompt` as a user message, through the `generate` hook and
   * `model.request` with kind `generate`; the chat is not changed.
   */
  const generate = async (chat: string, prompt: string) => {
    const list = [...toList(contextOf(chat)), { role: "user" as const, content: [textPart(prompt)] }];
    const prepared = await prepareRequest(chat, "generate", list);
    // 2.2.0 sends a failed generation again by the model retry policy (session/generate.ts `.pipe(retry)`,
    // model-retry.ts: the same waits and limits as a turn, no `retry` hook, no event); 2.0.32 did not.
    let timeouts = 0;
    for (let attempt = 0; ; attempt++) {
      const sent = await sendRequest(prepared, prepared.messages, prepared.generation);
      const failure = sent.reply ? failureOf(sent.reply, state.version) : "invalid" in sent && sent.invalid ? undefined : unansweredFailure((sent as { error?: unknown }).error);
      const again =
        state.version !== "2.0.32" && failure?.retryable && attempt < RETRIES_MAX && (failure.code !== "Timeout" || ++timeouts <= TIMEOUT_RETRIES_MAX);
      if (again) {
        const delay = retryDelay(attempt + 1, failure!.retryAfterMs);
        retries.push({ chat, attempt: attempt + 2, kind: failure!.kind, delay });
        await state.sleep(delay);
        continue;
      }
      return { text: sent.reply?.text ?? "", reply: sent.reply, body: sent.body, failure };
    }
  };

  /**
   * OpenCode's cache warming (plugin/warming.ts, one of OpenCode's own plugins, run before the plugin's hooks): with
   * `warming` set, a chat's turn, summary or generation schedules pings — a generation with the keep-alive prompt
   * (`generate`, kind `generate`) once the chat has been idle `interval`, until `duration` after its latest request. A
   * ping is not a request that reschedules (its last message is the prompt alone). 2.2.0 waits while the chat's own
   * request runs (from its `context` hook to the step's end); 2.0.32 did not.
   */
  const warming = (() => {
    type Warmed = { last: number; expires: number; settings: typeof WARMING_DEFAULTS; timer?: ReturnType<typeof setTimeout> };
    const chats = new Map<string, Warmed>();
    const requesting = new Set<string>();
    const pings: Array<{ chat: string; at: number; text: string; failure?: Failure }> = [];
    const settings = () => {
      if (!state.warming) return undefined;
      const s = state.warming === true ? { ...WARMING_DEFAULTS } : { ...WARMING_DEFAULTS, ...state.warming };
      return Number.isFinite(s.interval) && s.interval > 0 && Number.isFinite(s.duration) && s.duration > 0 ? s : undefined;
    };
    const stop = (chat: string) => {
      clearTimeout(chats.get(chat)?.timer);
      chats.delete(chat);
    };
    const later = (chat: string, current: Warmed, ms: number) => {
      current.timer = setTimeout(() => void loop(chat), Math.max(0, ms));
      current.timer.unref?.();
    };
    const ping = async (chat: string, prompt = settings()?.prompt ?? WARMING_DEFAULTS.prompt) => {
      const result = await generate(chat, prompt).catch((error: unknown) => ({ text: "", failure: { kind: "unknown" as FailureKind, message: String(error), retryable: false } }));
      const entry = { chat, at: Date.now(), text: result.text, ...(result.failure ? { failure: result.failure } : {}) };
      pings.push(entry);
      return entry;
    };
    const loop = async (chat: string) => {
      const current = chats.get(chat);
      if (!current || !sessions.has(chat)) return stop(chat);
      const now = Date.now();
      const next = Math.min(current.last + current.settings.interval, current.expires);
      if (now < next) return later(chat, current, next - now);
      if (now >= current.expires) return stop(chat);
      if (requesting.has(chat)) return later(chat, current, current.settings.interval);
      const last = current.last;
      await ping(chat, current.settings.prompt);
      if (chats.get(chat) === current && current.last === last) current.last = Date.now();
      if (chats.get(chat) === current) await loop(chat);
    };
    return {
      pings,
      ping,
      /** The warming plugin's `context` / `compaction` / `generate` hook. */
      hook(chat: string, kind: string, messages: ListMessage[]) {
        if (kind === "primary" && state.version !== "2.0.32") requesting.add(chat);
        const s = settings();
        if (!s) return stop(chat);
        const active = chats.get(chat);
        const last = messages.at(-1);
        const only = last?.role === "user" && last.content.length === 1 && last.content[0]?.type === "text" ? String(last.content[0].text) : undefined;
        if (only !== undefined && (only === active?.settings.prompt || only === s.prompt)) {
          if (active) active.settings = s;
          return;
        }
        const now = Date.now();
        if (active) {
          Object.assign(active, { last: now, expires: now + s.duration, settings: s });
          return;
        }
        const added: Warmed = { last: now, expires: now + s.duration, settings: s };
        chats.set(chat, added);
        later(chat, added, s.interval);
      },
      /** A step of the chat ended (`session.step.streamed` / `.failed`, the execution's end): 2.2.0 resets its idle time. */
      settled(chat: string) {
        if (state.version === "2.0.32") return;
        requesting.delete(chat);
        const current = chats.get(chat);
        if (current) current.last = Date.now();
      },
      stopAll() {
        for (const chat of [...chats.keys()]) stop(chat);
      },
    };
  })();
  /**
   * A generation with no session (generate.ts `Generate.text`): the prompt as
   * one user message to the provider's own address, no hook of any kind, a
   * fresh session id in `x-opencode-session` (no session is stored).
   */
  const generateText = async (prompt: string) => {
    const settings = instances[0]?.provider.info?.settings ?? {};
    assert.ok(settings.baseURL, "the plugin registered its provider's address");
    const { ref } = model();
    const body = requestBody({ modelID: ref.id, system: [], messages: [{ role: "user", content: [textPart(prompt)] }], tools: {} });
    const res = await fetch(`${settings.baseURL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.apiKey}`, "x-opencode-session": `ses_${randomBytes(16).toString("hex")}` },
      body: JSON.stringify(body),
    });
    const reply = await readReply(res);
    return { text: reply.text, reply, body, failure: failureOf(reply, state.version) };
  };

  /** Another model compacts `chat`: no request reaches the plugin. */
  const compactElsewhere = (chat: string) => {
    const split = splitConversation(contextOf(chat), COMPACTION_KEEP, state.version);
    const keep = state.version !== "2.0.32" && split?.keepID ? { metadata: { keepID: split.keepID } } : {};
    add(chat, "compaction", "", { summary: "another model's summary", ...(split?.recent ? { recent: split.recent } : {}), ...keep });
  };

  const get = async ({ sessionID }: { sessionID: string }) => {
    if (state.hangReads === "get") return new Promise<never>(() => {});
    const s = session(sessionID);
    return s.fork ? { id: s.id, fork: s.fork } : { id: s.id };
  };
  /**
   * session.context: the messages since the latest compaction, in OpenCode's
   * Session.Message.Info form (schema/src/session-message.ts).
   */
  const context = async ({ sessionID }: { sessionID: string }) =>
    state.hangReads === "context"
      ? new Promise<never>(() => {})
      : visible(session(sessionID)).map((m): Record<string, unknown> => {
          const base = { id: m.id, ...(m.metadata ? { metadata: m.metadata } : {}) };
          if (m.type === "assistant") {
            const results = new Map((m.toolResults ?? []).map((r) => [r.id, r.output]));
            return {
              ...base,
              type: "assistant",
              content: [
                // Parts in the order they streamed: reasoning first (session-message.ts content `reasoning`).
                ...(m.reasoning ? [{ type: "reasoning", text: m.reasoning }] : []),
                ...(m.text ? [{ type: "text", text: m.text }] : []),
                ...(m.toolCalls ?? []).map((call) => ({
                  type: "tool",
                  id: call.id,
                  name: call.name,
                  state: results.has(call.id)
                    ? { status: "completed", input: call.input, content: [{ type: "text", text: results.get(call.id) }] }
                    : { status: "running", input: call.input },
                  time: { created: 1 },
                })),
              ],
              ...(m.finish ? { finish: m.finish } : {}),
              time: m.pending ? { created: 1 } : { created: 1, completed: 2 },
            };
          }
          if (m.type === "compaction") {
            // 2.2.0: no `recent` field; the tail read from `metadata.keepID` goes in `metadata.recent` (history.ts
            // withRecentText). 2.0.32 kept it in `recent`.
            if (state.version === "2.0.32") return { ...base, type: "compaction", status: "completed", reason: "manual", summary: m.summary, recent: m.recent ?? "", time: { created: 1 } };
            const keep = typeof m.metadata?.keepID === "string" ? { metadata: { ...m.metadata, recent: m.recent ?? "" } } : {};
            return { ...base, ...keep, type: "compaction", status: "completed", reason: "manual", summary: m.summary, time: { created: 1 } };
          }
          if (m.type === "shell") return { ...base, type: "shell", command: m.text, output: { output: "" }, time: { created: 1 } };
          if (m.type === "location") return { ...base, type: "location-switched", location: { directory: m.text }, time: { created: 1 } };
          if (m.type === "user") {
            // Files as far as the plugin and messageToText read them (mime, name, the source: a file from disk by
            // its URI, an inline one `{ type: "inline" }` — history.d.ts 80–96, instance-c01nkdt4.js 99–175).
            const files = m.files?.map((f) => ({ mime: f.mediaType, ...(f.name ? { name: f.name } : {}), source: f.path ? { type: "uri", uri: pathToFileURL(f.path).href } : { type: "inline" } }));
            return { ...base, type: "user", text: m.text, ...(m.skills ? { skills: m.skills } : {}), ...(files?.length ? { files } : {}), time: { created: 1 } };
          }
          return { ...base, type: m.type, text: m.text, time: { created: 1 } };
        });

  /**
   * OpenCode starts the plugin for a directory (an instance per directory;
   * default: the world's). What `setup` registers is live as soon as it is
   * registered: the instance serves while its setup still runs. `setup`:
   * another build of the plugin (an older release before an upgrade, a copy
   * OpenCode loaded afresh) instead of the one the simulator was made with.
   */
  const startPlugin = async (pluginOptions?: Record<string, unknown>, where: { directory?: string; setup?: (ctx: any) => Promise<unknown> } = {}) => {
    const directory = where.directory ?? options.directory;
    const host = pluginContext({ directory, get, context, options: pluginOptions });
    const instance: Instance = { ...host, directory, dispose: async () => {} };
    instances.push(instance);
    try {
      instance.dispose = ((await (where.setup ?? options.setup)(host.ctx)) as (() => Promise<void>) | undefined) ?? (async () => {});
    } catch (error) {
      instances.splice(instances.indexOf(instance), 1);
      throw error;
    }
    return instance;
  };
  const stopPlugin = async (instance: Instance) => {
    await instance.dispose();
    instances.splice(instances.indexOf(instance), 1);
  };

  /** An event to every running instance; resolves once each has taken it. */
  const emit = (event: unknown) => Promise.all(instances.map((instance) => withTimeout(instance.events.push(event), 5_000, "event taken")));

  /** OpenCode forks `parent` at `boundary`: settled messages up to it copied under new ids with their metadata; the event (unless `silent`). */
  const fork = async (parent: string, boundary: ForkBoundary, forkOptions: { silent?: boolean } = {}) => {
    const p = session(parent);
    const at = p.messages.findIndex((m) => m.id === boundary.messageID);
    assert.ok(at >= 0, `fork: ${boundary.messageID} is in ${parent}`);
    const copied = p.messages.slice(0, boundary.type === "before" ? at : at + 1).filter((m) => !m.pending && !m.queued);
    const event = newEventId();
    const child = `ses_${++chats}`;
    sessions.set(child, {
      id: child,
      ...(p.directory ? { directory: p.directory } : {}),
      fork: { sessionID: parent, boundary },
      // A checkpoint's `keepID` names the copy of the kept message (2.2.0 projector.ts projectFork).
      messages: copied.map((m) => {
        const copy = { ...structuredClone(m), id: `${event}_${m.seq}` };
        const kept = typeof m.metadata?.keepID === "string" ? p.messages.find((k) => k.id === m.metadata!.keepID) : undefined;
        if (m.type === "compaction" && kept) copy.metadata = { ...copy.metadata, keepID: `${event}_${kept.seq}` };
        return copy;
      }),
      lastSeq: p.lastSeq,
    });
    if (!forkOptions.silent) await emit(forkEvent(child));
    return child;
  };
  const forkEvent = (child: string) => {
    const s = session(child);
    return { type: "session.forked", data: { sessionID: child, parentID: s.fork!.sessionID, boundary: s.fork!.boundary } };
  };
  const through = (messageID: string): ForkBoundary => ({ type: "through", messageID });
  const before = (messageID: string): ForkBoundary => ({ type: "before", messageID });

  /** OpenCode accepts a message while a turn runs: the prompt hook now, delivery later. */
  const queue = async (chat: string, text: string, files?: Msg["files"], client: ClientInput = {}) => {
    const message = add(chat, "user", text, { queued: true, ...(files ? { files } : {}), ...clientFields(client) });
    await acceptOrDrop(chat, message);
    return message.id;
  };
  /** OpenCode delivers a queued message: it goes after everything on the screen. */
  const deliver = (chat: string, id: string) => {
    const s = session(chat);
    const message = s.messages.find((m) => m.id === id)!;
    delete message.queued;
    s.messages.splice(s.messages.indexOf(message), 1);
    s.messages.push(message);
  };
  /** The user deletes a chat: OpenCode no longer knows it (session.get fails); Claude's files stay. */
  const remove = async (chat: string) => {
    session(chat);
    sessions.delete(chat);
    await emit({ type: "session.deleted", data: { sessionID: chat } });
  };
  /** OpenCode imports a chat from an export: a new chat, no fork, the export's metadata. */
  const importChat = (from: string) => {
    const s = session(from);
    const id = newChat();
    const copy = session(id);
    copy.messages = s.messages.filter((m) => !m.pending && !m.queued).map((m) => ({ ...structuredClone(m), id: newId() }));
    copy.lastSeq = s.lastSeq;
    return id;
  };

  /**
   * OpenCode's database as it stands: every session and its messages, plain data. OpenCode writes each message
   * there as it is accepted and as its answer streams, so this is what a server killed now leaves, and what the
   * next server on the machine reads (`openDatabase`).
   */
  const database = (): Session[] => structuredClone([...sessions.values()]);
  /**
   * OpenCode starts on a database another server left (`database()` of that server, or of this one before it was
   * killed): its chats under their own ids, their messages as they were. New ids and chats come after them.
   */
  const openDatabase = (saved: Session[]) => {
    for (const s of saved) {
      sessions.set(s.id, structuredClone(s));
      const n = /^ses_(\d+)$/.exec(s.id);
      if (n) chats = Math.max(chats, Number(n[1]));
      for (const m of s.messages) {
        const stamped = /^msg_([0-9a-f]{12})/.exec(m.id);
        if (stamped) clock = Math.max(clock, parseInt(stamped[1]!, 16) + 1);
      }
    }
  };

  /** Timers and summaries OpenCode runs on its own (warming, background compaction) end with the world. */
  const stopBackground = () => {
    warming.stopAll();
    for (const [chat, held] of precomputed) interruptHeld(chat, held);
  };

  return {
    state, sessions, instances, retries,
    newChat, session, add, say, otherModelAnswer, between, visible, undoBefore, lastId,
    request, shown, turn, compact, compactElsewhere, title, generate, generateText, get, context, systemOf, offeredTools,
    /** Cache warming: the pings sent (`pings`), one ping now as the warming loop sends it (`ping(chat)`). */
    warming: { pings: warming.pings, ping: warming.ping },
    /** Summaries written in the background (2.2.0), in order; `precompute(chat)` as OpenCode calls it. */
    backgroundSummaries, precompute, stopBackground,
    startPlugin, stopPlugin, emit, fork, forkEvent, through, before, queue, deliver, remove, importChat,
    database, openDatabase,
  };
}

export type OpenCodeSimulator = ReturnType<typeof createOpenCodeSimulator>;
