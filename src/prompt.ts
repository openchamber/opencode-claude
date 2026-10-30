/**
 * Build Claude Agent SDK prompts from a request's messages, including text,
 * images, and PDF/document attachments.
 *
 * Every builder reads the messages in the form of OpenCode's message list
 * (LLM.Message: `text`, `media`, `tool-call`, `tool-result` parts), the
 * form the `context` hook hands the plugin. A chat
 * turn's messages are that list; a summary, title or generate request is
 * read from its OpenAI body, put into the same form first (list-content.ts).
 */
import { currentHost } from "./host.js";
import { ORIGINAL_ID_KEY } from "./names.js";

/** A content part of a list message: `text`, `media`, `tool-call`, `tool-result`, `reasoning`. */
export type ListPart = { type: string } & Record<string, any>;

/** A message in the form of OpenCode's list (LLM.Message), the form every builder reads. */
export type ConversationMessage = {
  id?: string;
  role: string;
  content: ListPart[];
  metadata?: Record<string, unknown>;
};

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    }
  | {
      type: "document";
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    };

export type SdkUserPrompt = {
  type: "user";
  message: { role: "user"; content: string | AnthropicContentBlock[] };
  parent_tool_use_id: null;
  /** The transcript record's uuid, named by the plugin (names.ts). */
  uuid?: string;
  /**
   * A record without a turn: the CLI writes it to the transcript and the
   * next record of the stream carries the turn (probes 5, 6, 23).
   */
  shouldQuery?: false;
};

/** The prompt as a record with this uuid; an empty text prompt still needs some content. */
export function withUuid(prompt: string | SdkUserPrompt, uuid: string): SdkUserPrompt {
  if (typeof prompt === "string") {
    return { type: "user", message: { role: "user", content: prompt || " " }, parent_tool_use_id: null, uuid };
  }
  return { ...prompt, uuid };
}

function parseDataUrl(url: string): {
  mediaType: string;
  data: string;
} | null {
  // OpenCode 2.0.32 writes `data:<mime>;base64,...` and no other parameter.
  const match = /^data:([^;,]+)?;base64,(.+)$/i.exec(url.trim());
  if (!match) return null;
  return {
    mediaType: (match[1] || "application/octet-stream").toLowerCase(),
    data: match[2],
  };
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function mediaLooksLikePdf(mediaType: string, urlHint = ""): boolean {
  return (
    mediaType.includes("pdf") ||
    /\.pdf(\?|#|$)/i.test(urlHint) ||
    mediaType === "application/octet-stream" && /\.pdf(\?|#|$)/i.test(urlHint)
  );
}

function mediaLooksLikeImage(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

function pushText(blocks: AnthropicContentBlock[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = blocks[blocks.length - 1];
  if (last?.type === "text") {
    last.text = `${last.text}\n${trimmed}`;
    return;
  }
  blocks.push({ type: "text", text: trimmed });
}

function pushDataUrl(
  blocks: AnthropicContentBlock[],
  url: string,
): boolean {
  const parsed = parseDataUrl(url);
  if (!parsed) return false;
  if (mediaLooksLikeImage(parsed.mediaType)) {
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: parsed.mediaType,
        data: parsed.data,
      },
    });
    return true;
  }
  if (mediaLooksLikePdf(parsed.mediaType)) {
    blocks.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: parsed.data,
      },
    });
    return true;
  }
  // Unknown binary — still try as document so Claude can reject clearly.
  blocks.push({
    type: "document",
    source: {
      type: "base64",
      media_type: parsed.mediaType,
      data: parsed.data,
    },
  });
  return true;
}

function pushRemoteUrl(
  blocks: AnthropicContentBlock[],
  url: string,
  mediaTypeHint?: string,
): void {
  const mediaType = (mediaTypeHint || "").toLowerCase();
  if (mediaLooksLikePdf(mediaType, url)) {
    blocks.push({
      type: "document",
      source: { type: "url", url },
    });
    return;
  }
  blocks.push({
    type: "image",
    source: { type: "url", url },
  });
}

function convertPart(part: unknown, blocks: AnthropicContentBlock[]): void {
  if (!part || typeof part !== "object") return;
  const p = part as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : "";

  if (type === "text" && typeof p.text === "string") {
    pushText(blocks, p.text);
    return;
  }

  if (type === "image_url") {
    const imageUrl = p.image_url;
    const url =
      typeof imageUrl === "string"
        ? imageUrl
        : imageUrl &&
            typeof imageUrl === "object" &&
            typeof (imageUrl as { url?: unknown }).url === "string"
          ? (imageUrl as { url: string }).url
          : null;
    if (!url) return;
    if (pushDataUrl(blocks, url)) return;
    if (isHttpUrl(url)) pushRemoteUrl(blocks, url);
    return;
  }

  // Anthropic-shaped image parts (not OpenAI image_url).
  // contentHasAttachments treats these as attachments — must convert or
  // the image is detected then silently dropped.
  if (type === "image") {
    const mediaType =
      typeof p.media_type === "string"
        ? p.media_type
        : typeof p.mimeType === "string"
          ? p.mimeType
          : typeof p.mime === "string"
            ? p.mime
            : "image/png";
    const source = p.source;
    if (source && typeof source === "object") {
      const s = source as Record<string, unknown>;
      if (s.type === "base64" && typeof s.data === "string") {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type:
              typeof s.media_type === "string" ? s.media_type : mediaType,
            data: s.data,
          },
        });
        return;
      }
      if (s.type === "url" && typeof s.url === "string") {
        if (pushDataUrl(blocks, s.url)) return;
        if (isHttpUrl(s.url)) pushRemoteUrl(blocks, s.url, mediaType);
        return;
      }
    }
    return;
  }

  if (type === "document") {
    const mediaType =
      typeof p.media_type === "string"
        ? p.media_type
        : typeof p.mimeType === "string"
          ? p.mimeType
          : "application/pdf";
    const source = p.source;
    if (source && typeof source === "object") {
      const s = source as Record<string, unknown>;
      if (s.type === "base64" && typeof s.data === "string") {
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type:
              typeof s.media_type === "string" ? s.media_type : mediaType,
            data: s.data,
          },
        });
        return;
      }
      if (s.type === "url" && typeof s.url === "string") {
        if (pushDataUrl(blocks, s.url)) return;
        if (isHttpUrl(s.url)) pushRemoteUrl(blocks, s.url, mediaType);
        return;
      }
    }
    const data = typeof p.data === "string" ? p.data : null;
    if (data) {
      if (/^data:/i.test(data)) {
        pushDataUrl(blocks, data);
        return;
      }
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: mediaLooksLikePdf(mediaType) ? "application/pdf" : mediaType,
          data,
        },
      });
    }
    return;
  }

  if (type === "input_image") {
    const url = typeof p.image_url === "string" ? p.image_url : null;
    const b64 = typeof p.data === "string" ? p.data : null;
    const mediaType =
      typeof p.media_type === "string" ? p.media_type : "image/png";
    if (url) {
      if (pushDataUrl(blocks, url)) return;
      if (isHttpUrl(url)) pushRemoteUrl(blocks, url, mediaType);
      return;
    }
    if (b64) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: b64 },
      });
    }
    return;
  }

  if (type === "file" || type === "input_file") {
    const file = (p.file && typeof p.file === "object" ? p.file : p) as Record<
      string,
      unknown
    >;
    // OpenAI / @ai-sdk/openai-compatible emit `file_data` (often a data URL).
    // Older / alternate shapes use `url` or raw base64 `data`.
    const fileData =
      typeof file.file_data === "string" ? file.file_data : null;
    // OpenCode 2.x tool output parts carry the source as `uri`.
    const url =
      typeof file.url === "string"
        ? file.url
        : typeof file.uri === "string"
          ? file.uri
          : fileData && /^data:/i.test(fileData)
            ? fileData
            : null;
    const data =
      typeof file.data === "string"
        ? file.data
        : fileData && !/^data:/i.test(fileData)
          ? fileData
          : null;
    const name =
      typeof file.filename === "string"
        ? file.filename
        : typeof p.filename === "string"
          ? p.filename
          : "";
    const mediaType =
      typeof file.media_type === "string"
        ? file.media_type
        : typeof file.mime_type === "string"
          ? file.mime_type
          : typeof file.mime === "string"
            ? file.mime
            : mediaLooksLikePdf("", name)
              ? "application/pdf"
              : "application/octet-stream";

    if (url) {
      if (pushDataUrl(blocks, url)) return;
      if (isHttpUrl(url)) {
        pushRemoteUrl(blocks, url, mediaType || name);
        return;
      }
      pushText(blocks, `[Attachment ${name || url} could not be relayed inline]`);
      return;
    }
    if (data) {
      // data may still be a bare data-URL string without the file_data key
      if (/^data:/i.test(data)) {
        pushDataUrl(blocks, data);
        return;
      }
      if (mediaLooksLikeImage(mediaType)) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data },
        });
      } else {
        blocks.push({
          type: "document",
          source: {
            type: "base64",
            media_type: mediaLooksLikePdf(mediaType, name)
              ? "application/pdf"
              : mediaType,
            data,
          },
        });
      }
    }
  }
}

/**
 * Marker text of the synthetic user message OpenCode emits when it promotes
 * tool-result media for providers that cannot carry media in tool results
 * (every openai-compatible provider, including this one).
 */
export const SYNTHETIC_TOOL_MEDIA_PROMPT = "Attached media from tool result:";

/**
 * OpenCode 1.x labels promoted tool media with SYNTHETIC_TOOL_MEDIA_PROMPT.
 * OpenCode 2.x sends the media alone: a user message with no text right
 * after the tool results (openai-chat `flushAttachments`). Pass the previous
 * message so that shape is recognised too; a real user message always
 * carries text or follows something other than a tool result.
 */
export function isSyntheticToolMediaMessage(
  msg: { role?: string; content?: unknown },
  previous?: { role?: string; content?: unknown },
): boolean {
  if (msg?.role !== "user") return false;
  const text = extractTextContent(msg.content).trim();
  if (text === SYNTHETIC_TOOL_MEDIA_PROMPT) return true;
  return (
    !text &&
    previous?.role === "tool" &&
    contentHasAttachments(msg.content)
  );
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: string; text?: string };
      if (p.type === "text" && typeof p.text === "string") return p.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/**
 * A system update OpenCode lowers into user text for an OpenAI-form
 * provider (ai/src/protocols/shared.ts wrapSystemUpdate): appended to the
 * previous user message's text, or a user message of its own.
 */
const SYSTEM_UPDATE_BLOCK = /<system-update>[\s\S]*?<\/system-update>/g;

/**
 * The user's own text of a message: without <system-reminder> blocks and
 * the <system-update> blocks OpenCode appends, with collapsed whitespace.
 * Empty for a message made of reminders or updates alone.
 */
export function userTextIdentity(text: string): string {
  return text.replace(SYSTEM_REMINDER_BLOCK, " ").replace(SYSTEM_UPDATE_BLOCK, " ").replace(/\s+/g, " ").trim();
}

/**
 * Whether a user message starts a turn of its own: it has the user's own
 * text or an attachment. A message of <system-reminder> blocks alone (Plan
 * mode stores its reminder after the prompt it was sent before) belongs to
 * the turn it sits in.
 */
export function startsTurn(message: { role?: string; content?: unknown }): boolean {
  if (message?.role !== "user") return false;
  return !!userTextIdentity(extractTextContent(message.content)) || contentHasAttachments(message.content);
}

export function contentHasAttachments(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const type = (part as { type?: unknown }).type;
    return (
      type === "media" ||
      type === "image_url" ||
      type === "input_image" ||
      type === "file" ||
      type === "input_file" ||
      type === "image" ||
      type === "document"
    );
  });
}

export function openaiContentToAnthropicBlocks(
  content: unknown,
): AnthropicContentBlock[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) convertPart(part, blocks);
  return blocks;
}

export type McpToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType: string; blob: string };
    };

/**
 * Media of a list part (OpenCode's Media.Asset: `source` base64, bytes or
 * url, and `mediaType`) as a content block. Text files never get here: the
 * list carries them as text parts.
 */
function pushMedia(blocks: AnthropicContentBlock[], media: unknown): void {
  if (!media || typeof media !== "object") return;
  const m = media as { source?: Record<string, unknown>; mediaType?: unknown };
  const source = m.source ?? {};
  const mediaType = String(m.mediaType ?? source.mediaType ?? "application/octet-stream").toLowerCase();
  if (source.type === "base64" && typeof source.data === "string") {
    pushDataUrl(blocks, `data:${mediaType};base64,${source.data}`);
    return;
  }
  if (source.type === "bytes" && source.data instanceof Uint8Array) {
    pushDataUrl(blocks, `data:${mediaType};base64,${Buffer.from(source.data).toString("base64")}`);
    return;
  }
  if (source.type === "url" && typeof source.url === "string") {
    if (pushDataUrl(blocks, source.url)) return;
    if (isHttpUrl(source.url)) pushRemoteUrl(blocks, source.url, mediaType);
  }
}

/** A file a tool returned (Tool.FileContent): a data URL, an http(s) URL, or bare base64 in `uri`. */
function pushToolFile(blocks: AnthropicContentBlock[], file: Record<string, unknown>): void {
  const uri = typeof file.uri === "string" ? file.uri : "";
  const mime = typeof file.mime === "string" ? file.mime : "application/octet-stream";
  if (!uri) return;
  if (/^data:/i.test(uri)) {
    const parsed = parseDataUrl(uri);
    if (parsed) pushDataUrl(blocks, `data:${mime};base64,${parsed.data}`);
    return;
  }
  if (isHttpUrl(uri)) {
    pushRemoteUrl(blocks, uri, mime);
    return;
  }
  pushDataUrl(blocks, `data:${mime};base64,${uri}`);
}

/** The content of a list message as Claude content blocks: its text and its media. */
export function listContentToBlocks(content: unknown): AnthropicContentBlock[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as ListPart;
    if (p.type === "text" && typeof p.text === "string") pushText(blocks, p.text);
    else if (p.type === "media") pushMedia(blocks, p.media);
  }
  return blocks;
}

/** The text of a tool result the way OpenCode sends it (protocols/shared.ts toolResultText). */
function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as { type?: unknown; value?: unknown };
  if (r.type === "text") return String(r.value ?? "");
  if (r.type === "content" && Array.isArray(r.value)) {
    return r.value
      .filter((item) => (item as { type?: unknown } | null)?.type === "text")
      .map((item) => String((item as { text?: unknown }).text ?? ""))
      .join("\n");
  }
  if (typeof r.value === "string") return r.value;
  try {
    return JSON.stringify(r.value) ?? String(r.value);
  } catch {
    return String(r.value);
  }
}

/** A tool result part (`tool-result`) as content blocks: its text, then the files it returned. */
export function toolResultToBlocks(part: ListPart): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  pushText(blocks, toolResultText(part.result));
  const result = part.result as { type?: unknown; value?: unknown } | undefined;
  if (result?.type === "content" && Array.isArray(result.value)) {
    for (const item of result.value) {
      if ((item as { type?: unknown } | null)?.type === "file") pushToolFile(blocks, item as Record<string, unknown>);
    }
  }
  return blocks;
}

/** A tool result part as the content of the parked MCP call it answers. */
export function toolResultToMcpContent(part: ListPart): McpToolResultContent[] {
  return blocksToMcpContent(toolResultToBlocks(part));
}

/**
 * Content blocks as MCP result blocks. OpenCode's read tool returns images
 * and PDFs as files on the tool result; those must stay attached when the
 * parked Claude SDK tool call resumes. Base64 documents travel as MCP
 * embedded `resource` blobs (Claude Code saves them to disk and hands the
 * model the path); URL-sourced media cannot ride in an MCP result, so the
 * model gets the URL as text instead of a silent drop.
 */
export function blocksToMcpContent(blocks: AnthropicContentBlock[]): McpToolResultContent[] {
  const result: McpToolResultContent[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      result.push(block);
      continue;
    }
    if (block.source.type === "url") {
      result.push({
        type: "text",
        text: `[${block.type === "image" ? "Image" : "Document"} attachment could not be relayed inline; source URL: ${block.source.url}]`,
      });
      continue;
    }
    if (block.type === "image") {
      result.push({
        type: "image",
        data: block.source.data,
        mimeType: block.source.media_type,
      });
      continue;
    }
    const mimeType = block.source.media_type;
    const extension = mimeType === "application/pdf" ? ".pdf" : "";
    result.push({
      type: "resource",
      resource: {
        uri: `opencode://tool-result/attachment-${result.length + 1}${extension}`,
        mimeType,
        blob: block.source.data,
      },
    });
  }
  return result;
}

const TOOL_PART_TYPES = new Set([
  "text",
  "file",
  "image",
  "image_url",
  "input_file",
  "input_image",
  "document",
]);

/**
 * OpenCode 2.x returns tool output as content parts, and the openai-compatible
 * request carries a tool message's content as a string, so the parts arrive
 * JSON-encoded: `[{"type":"text",...},{"type":"file","uri":"data:image/png;base64,...",
 * "mime":"image/png"}]`. Relayed as text, an image becomes kilobytes of base64
 * the model cannot see. Decode exactly that shape; any other string stays
 * the string it was.
 */
export function decodeToolMessageContent(content: unknown): unknown {
  // With a cache breakpoint OpenCode wraps that string in one text part.
  if (Array.isArray(content) && content.length === 1) {
    const only = content[0] as { type?: unknown; text?: unknown } | null;
    if (only?.type === "text" && typeof only.text === "string") {
      const decoded = decodeToolMessageContent(only.text);
      return decoded === only.text ? content : decoded;
    }
  }
  if (typeof content !== "string") return content;
  const text = content.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return content;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return content;
  const isPart = (part: unknown): boolean => {
    if (!part || typeof part !== "object") return false;
    const p = part as Record<string, unknown>;
    if (typeof p.type !== "string" || !TOOL_PART_TYPES.has(p.type)) return false;
    return p.type !== "text" || typeof p.text === "string";
  };
  return parsed.every(isPart) ? parsed : content;
}

const UNRELAYABLE_USER_MESSAGE =
  "[The user's latest message contained an attachment that could not be relayed to Claude (unsupported format or location). Tell the user it could not be read.]";

/**
 * Indices of the latest user turn: every user message after the last
 * assistant message, in order. OpenCode queues messages the user sends while
 * no turn runs for them; they arrive together and all await one answer.
 * When the step after the last assistant message holds only tool output,
 * the newest user message stands in — never an older one, which would make
 * Claude redo an answered request. Empty without any user message.
 */
export function latestUserTurn(messages: readonly ConversationMessage[]): number[] {
  const turn: number[] = [];
  // An assistant message was passed before any user message.
  let toolStep = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      if (turn.length > 0) break;
      toolStep = true;
    } else if (msg?.role === "user") {
      turn.unshift(i);
      if (toolStep) break;
    }
  }
  return turn;
}

/**
 * One user message as prompt content: its blocks when it carries
 * attachments, else its text. When parts were sent but none converted (e.g.
 * a `file://` image), says so instead of going silent; a truly empty
 * message yields "".
 */
function userMessagePrompt(content: unknown): string | AnthropicContentBlock[] {
  const blocks = contentHasAttachments(content)
    ? listContentToBlocks(content)
    : [];
  if (blocks.length > 0) return blocks;
  const text = extractTextContent(content).trim();
  if (text) return text;
  const hasParts =
    Array.isArray(content) &&
    content.some(
      (part) =>
        !part ||
        typeof part !== "object" ||
        !("type" in part) ||
        part.type !== "text",
    );
  return hasParts ? UNRELAYABLE_USER_MESSAGE : "";
}

/**
 * Latest user turn (see `latestUserTurn`) as a Claude Agent SDK prompt,
 * string when text-only. Queued messages are combined in order: texts are
 * separated by a blank line, attachments keep their position. `after`: the
 * messages up to that index are in the transcript already and are left out.
 */
export function latestUserPrompt(
  messages: readonly ConversationMessage[],
  after = -1,
): string | SdkUserPrompt {
  const parts = latestUserTurn(messages)
    .filter((i) => i > after)
    .map((i) => userMessagePrompt(messages[i]!.content))
    .filter((part) => part.length > 0);
  if (parts.every((part) => typeof part === "string")) {
    return parts.join("\n\n");
  }
  return {
    type: "user",
    message: {
      role: "user",
      content: parts.flatMap((part) =>
        typeof part === "string" ? [{ type: "text" as const, text: part }] : part,
      ),
    },
    parent_tool_use_id: null,
  };
}

/**
 * Steering: user messages OpenCode queued while a bridged tool was running
 * arrive after the tool results in the resume request. A parked bridge only
 * consumes tool results, so without this they were silently dropped (and
 * OpenCode then treats them as answered). Returns the content of the real
 * user messages after the last tool result; empty when there are none.
 */
export function collectSteering(messages: readonly ConversationMessage[]): McpToolResultContent[] {
  return collectSteeringMessages(messages).flatMap((m) => m.blocks);
}

/**
 * Steering messages one by one. `id` is the OpenCode id the message is
 * named after (the original's, kept in its metadata, for a fork's copy);
 * `key` tells the message apart across resume requests: its id, or, for a
 * message without one, its content plus how many earlier user messages
 * carry the same content.
 */
export function collectSteeringMessages(messages: readonly ConversationMessage[]): Array<{
  key: string;
  id?: string;
  blocks: McpToolResultContent[];
  prompt: string | AnthropicContentBlock[];
}> {
  let lastTool = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "tool") lastTool = i;
  }
  if (lastTool < 0) return [];
  const out: ReturnType<typeof collectSteeringMessages> = [];
  const occurrences = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    const identity = JSON.stringify(msg.content ?? null);
    const nth = occurrences.get(identity) ?? 0;
    occurrences.set(identity, nth + 1);
    if (i <= lastTool) continue;
    const content = blocksToMcpContent(listContentToBlocks(msg.content));
    const hasText = content.some((b) => b.type === "text" && b.text.trim());
    if (!hasText && !content.some((b) => b.type !== "text")) continue;
    const original = msg.metadata?.[ORIGINAL_ID_KEY];
    const id = typeof original === "string" && original ? original : msg.id;
    out.push({ key: id ? `id:${id}` : `${nth}:${identity}`, id, blocks: content, prompt: userMessagePrompt(msg.content) });
  }
  return out;
}

/** The parts of a message of one type. */
function partsOf(message: ConversationMessage | undefined, type: string): ListPart[] {
  return Array.isArray(message?.content) ? message.content.filter((part) => part?.type === type) : [];
}

/** The tool results of a request: tool call id → the results as MCP content. */
export function collectToolResults(messages: readonly ConversationMessage[]): Map<string, McpToolResultContent[]> {
  const results = new Map<string, McpToolResultContent[]>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of partsOf(message, "tool-result")) {
      if (typeof part.id === "string") results.set(part.id, toolResultToMcpContent(part));
    }
  }
  return results;
}

/**
 * Index of the last assistant message when it called tools and at least one
 * of those calls has its result after it: a tool step OpenCode answered.
 * Null when the last assistant message is a plain reply (a normal new turn).
 */
export function answeredToolStepIndex(messages: readonly ConversationMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const ids = new Set(partsOf(msg, "tool-call").map((call) => call.id).filter(Boolean));
    if (ids.size === 0) return null;
    const answered = messages
      .slice(i + 1)
      .some((m) => m.role === "tool" && partsOf(m, "tool-result").some((part) => ids.has(part.id)));
    return answered ? i : null;
  }
  return null;
}

/**
 * Prompt for tool results no parked turn waits for (proxy restart, cancelled
 * or reaped park, superseded turn). The Claude process that made the calls
 * is gone, so the turn is rebuilt: the history before the step is transferred
 * as usual, and this prompt carries the step itself: the calls, their full
 * results with media, and any user messages sent after them.
 */
export function answeredToolStepPrompt(
  messages: readonly ConversationMessage[],
  assistantIndex: number,
  options: { otherModel?: boolean } = {},
): SdkUserPrompt {
  const { blocks, userBlocks } = toolStepBlocks(messages, assistantIndex);
  const content: AnthropicContentBlock[] = [
    {
      type: "text",
      text: options.otherModel
        ? "<tool_results>\nThe model that handled the turns above called the tools below as its last step. Their results are relayed here. Do not repeat a call unless its result requires it."
        : "<tool_results>\nYour previous step called the tools below, but the session that made those calls ended before OpenCode returned their results. They are relayed here. Do not repeat a call unless its result requires it.",
    },
    ...blocks,
    {
      type: "text",
      text:
        userBlocks.length > 0
          ? "</tool_results>\n\nThe user sent the following after those calls. Respond to it with the results in mind:"
          : options.otherModel
            ? "</tool_results>\n\nContinue the task from these results."
            : `</tool_results>\n\n${HOST_STOP_NOTE} Continue the task from these results.`,
    },
    ...userBlocks,
  ];
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

const HOST_STOP_NOTE =
  "If your session shows these calls as rejected, or the request as interrupted by the user, that came from the plugin (a reload, or a wait that timed out), not from the user: nobody asked you to stop.";

/**
 * A tool step as content blocks: the step's text, each call with its full
 * result and media. User messages sent after the calls come separately.
 */
function toolStepBlocks(
  messages: readonly ConversationMessage[],
  assistantIndex: number,
): { blocks: AnthropicContentBlock[]; userBlocks: AnthropicContentBlock[] } {
  const assistant = messages[assistantIndex]!;
  const blocks: AnthropicContentBlock[] = [];
  const stepText = extractTextContent(assistant.content).trim();
  if (stepText) {
    blocks.push({ type: "text", text: `Your message in that step:\n${stepText}` });
  }
  const calls = new Map(partsOf(assistant, "tool-call").map((call) => [call.id, call]));
  const userBlocks: AnthropicContentBlock[] = [];
  for (const msg of messages.slice(assistantIndex + 1)) {
    if (msg.role === "tool") {
      for (const part of partsOf(msg, "tool-result")) {
        const call = calls.get(part.id);
        const result = toolResultToBlocks(part);
        blocks.push(
          {
            type: "text",
            text: `Result of ${call?.name ?? part.name ?? "tool"} ${JSON.stringify(call?.input ?? {})} (${part.id}):`,
          },
          ...(result.length > 0 ? result : [{ type: "text" as const, text: "(no output)" }]),
        );
      }
    } else if (msg.role === "user") {
      userBlocks.push(...listContentToBlocks(msg.content));
    }
  }
  return { blocks, userBlocks };
}

export async function* promptAsStream(
  prompt: string | SdkUserPrompt,
): AsyncGenerator<SdkUserPrompt, void, unknown> {
  if (typeof prompt === "string") {
    yield {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    };
    return;
  }
  yield prompt;
}

/**
 * Conversation-history transfer.
 *
 * The Agent SDK turn only receives the latest user turn; earlier context
 * comes from resuming the sticky Claude session. When no session can be
 * resumed (first claude-code turn after a model switch, lost store, deleted
 * session file), the proxy injects the serialized prior conversation instead
 * so Claude still sees the whole chat.
 */

/**
 * The history as Claude gets it: text, or text with the images and
 * documents of the chat in their places. It goes whole: OpenCode already
 * fit the request to the model (and replaced old images over its budget),
 * and a history that still does not fit comes back as "Prompt is too long",
 * which OpenCode compacts on.
 */
export type ConversationTranscript = string | AnthropicContentBlock[];

/** A user message's attachment that could not be turned into a Claude block. */
const UNRELAYABLE_ATTACHMENT = "[an attachment that could not be passed on]";

/** One message of the history: its text lines, and its files as blocks where they stand. */
type HistoryPiece = string | AnthropicContentBlock;

function serializeHistoryMessage(msg: ConversationMessage): HistoryPiece[] | null {
  if (!msg || typeof msg !== "object") return null;
  const role = msg.role;
  // System prompts are OpenCode-internal and huge; the Claude Code preset
  // supplies the agent system prompt instead.
  if (role === "system") return null;

  if (role === "user") {
    const text = extractTextContent(msg.content).trim();
    const hasAttach = contentHasAttachments(msg.content);
    if (!text && !hasAttach) return null;
    if (!hasAttach) return [`User:\n${text}`];
    const blocks = listContentToBlocks(msg.content);
    const pieces: HistoryPiece[] = ["User:"];
    for (const block of blocks) pieces.push(block.type === "text" ? block.text : block);
    if (!blocks.some((block) => block.type !== "text")) pieces.push(UNRELAYABLE_ATTACHMENT);
    return pieces;
  }

  if (role === "assistant") {
    const parts: string[] = [];
    const text = extractTextContent(msg.content).trim();
    if (text) parts.push(text);
    for (const call of partsOf(msg, "tool-call")) {
      if (typeof call.name === "string" && call.name) parts.push(`[called tool: ${call.name}]`);
    }
    if (parts.length === 0) return null;
    return [`Assistant:\n${parts.join("\n")}`];
  }

  if (role === "tool") {
    // Each result with its own text, whole, and the files it returned: the
    // list keeps them on the result they belong to.
    const pieces: HistoryPiece[] = [];
    for (const part of partsOf(msg, "tool-result")) {
      const text = toolResultText(part.result).trim();
      const files = toolResultToBlocks(part).filter((block) => block.type !== "text");
      if (!text && files.length === 0) continue;
      const label = (typeof part.name === "string" && part.name) || part.id || "tool";
      // Results apart by a blank line, as messages are.
      pieces.push(`${pieces.length > 0 ? "\n" : ""}Tool result (${label}):${text ? `\n${text}` : ""}`, ...files);
    }
    return pieces.length > 0 ? pieces : null;
  }

  return null;
}

/**
 * Messages before the latest user turn — the context Claude is missing. Ends
 * before the FIRST message of that turn: queued messages travel in the
 * prompt and must not repeat in the transcript.
 *
 * When the turn is a stand-in (the newest user message, with assistant or
 * tool output after it), that output is context too and would otherwise land
 * in neither transcript nor prompt. The prompt only repeats the user message,
 * so the transcript keeps everything in order, that message included.
 */
export function priorMessagesOf(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const start = latestUserTurn(messages)[0] ?? 0;
  const answeredAfter = messages
    .slice(start + 1)
    .some((m) => m?.role === "assistant" || m?.role === "tool");
  return answeredAfter ? messages.slice() : messages.slice(0, start);
}

/**
 * Serialize prior conversation into a transcript, whole: messages apart by a
 * blank line, a message's lines by a newline, its files where they stand.
 * Text only while the history has no files.
 */
export function buildConversationTranscript(
  messages: readonly ConversationMessage[],
): ConversationTranscript {
  const blocks: AnthropicContentBlock[] = [];
  let text = "";
  // Whether the next line goes after a blank line (a new message) or a newline.
  let separator = "";
  messages.forEach((msg) => {
    const pieces = serializeHistoryMessage(msg);
    if (!pieces) return;
    if (blocks.length > 0 || text) separator = "\n\n";
    for (const piece of pieces) {
      if (typeof piece === "string") {
        text += separator + piece;
        separator = "\n";
        continue;
      }
      // No empty text block between two files: the API refuses one.
      if (text + separator) blocks.push({ type: "text", text: text + separator });
      blocks.push(piece);
      text = "";
      separator = "";
    }
  });
  if (blocks.length === 0) return text;
  if (text) blocks.push({ type: "text", text });
  return blocks;
}

/** The text of a transcript, files left out: for the journal's length. */
export function transcriptText(transcript: ConversationTranscript): string {
  if (typeof transcript === "string") return transcript;
  return transcript.map((block) => (block.type === "text" ? block.text : "")).join("");
}

/** How many images and documents a transcript carries. */
export function transcriptFiles(transcript: ConversationTranscript): number {
  return typeof transcript === "string" ? 0 : transcript.filter((block) => block.type !== "text").length;
}

function historyIntro(missed: boolean): string {
  return missed
    ? "These messages were added to this chat after your last turn, without you " +
      "(for example, the user switched to another model for them). Treat them as part " +
      "of the conversation — do not re-do completed work — and respond to the user's " +
      "latest message, which follows them.\n\n"
    : "The earlier conversation of this chat is included below because the previous " +
      "Claude session could not be resumed. Treat it as established context — do not " +
      "re-do completed work — and respond to the user's latest message, which follows " +
      "the history.\n\n";
}

const HISTORY_END = "\n</conversation_history>\n\nLatest user message:\n";

/**
 * withConversationContext for a history with files: one prompt of blocks,
 * the history's text and files in order, then the latest user message.
 */
function withFilesInContext(
  prompt: string | SdkUserPrompt,
  transcript: AnthropicContentBlock[],
  missed: boolean,
): SdkUserPrompt {
  let latest: AnthropicContentBlock[];
  if (typeof prompt === "string") latest = [{ type: "text", text: prompt }];
  else if (typeof prompt.message.content === "string") latest = [{ type: "text", text: prompt.message.content }];
  else latest = prompt.message.content;
  const content = joinTextBlocks([
    { type: "text", text: "<conversation_history>\n" + historyIntro(missed) },
    ...transcript,
    { type: "text", text: HISTORY_END },
    ...latest,
  ]);
  if (typeof prompt === "string") {
    return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
  }
  return { ...prompt, message: { role: "user", content } };
}

/** Adjacent text blocks as one, so the text reads as it does in a text prompt. */
function joinTextBlocks(blocks: AnthropicContentBlock[]): AnthropicContentBlock[] {
  const joined: AnthropicContentBlock[] = [];
  for (const block of blocks) {
    const last = joined[joined.length - 1];
    if (block.type === "text" && last?.type === "text") {
      joined[joined.length - 1] = { type: "text", text: last.text + block.text };
      continue;
    }
    joined.push(block);
  }
  return joined;
}

/**
 * Prepend a transferred-history block to a prompt. Text prompts get a plain
 * prefix; multimodal prompts get an extra leading text block so attachments
 * still reach Claude. A history with files makes one prompt of blocks.
 *
 * `missed` marks a transcript of only the turns a resumed session never saw
 * (another model answered them, or they failed before Claude ran).
 */
export function withConversationContext(
  prompt: string | SdkUserPrompt,
  transcript: ConversationTranscript,
  missed = false,
): string | SdkUserPrompt {
  if (typeof transcript !== "string") return withFilesInContext(prompt, transcript, missed);
  const body = transcript.trim();
  if (!body) return prompt;
  const prefix =
    "<conversation_history>\n" +
    historyIntro(missed) +
    body +
    HISTORY_END;
  if (typeof prompt === "string") {
    return prefix + prompt;
  }
  const content = Array.isArray(prompt.message.content)
    ? prompt.message.content
    : [];
  return {
    ...prompt,
    message: {
      role: "user",
      content: [{ type: "text", text: prefix }, ...content],
    },
  };
}

/** Put a text block ahead of the prompt, keeping any image/PDF blocks. */
export function withLeadingText(
  prompt: string | SdkUserPrompt,
  text: string,
): string | SdkUserPrompt {
  if (!text) return prompt;
  if (typeof prompt === "string") return `${text}\n\n${prompt}`;
  const content = Array.isArray(prompt.message.content)
    ? prompt.message.content
    : [{ type: "text" as const, text: prompt.message.content }];
  return {
    ...prompt,
    message: { role: "user", content: [{ type: "text", text }, ...content] },
  };
}

/**
 * What Claude is told about its host: stated plainly, once, in the appended
 * runtime note. The Claude Code system prompt itself is never replaced or
 * rewritten, and it already names the model.
 */
export function buildRuntimeInstructions(): string {
  return `<runtime_info>In case you're asked: you are running in ${currentHost().name} through the Claude Code harness. No need to mention this otherwise.</runtime_info>`;
}

/**
 * Input of a chat turn that stays open while the turn runs, so a message the
 * user sends mid-turn reaches Claude as a user message (`priority: "next"`:
 * the CLI adds it after the running tool's result, as Claude Code does with a
 * message typed while a tool runs). Ends with the turn.
 */
export type TurnInput = {
  stream: AsyncGenerator<SdkUserPrompt, void, unknown>;
  /**
   * Resolves once the SDK has taken the message for the CLI. `uuid` names
   * the message's record in the transcript (names.ts): the CLI keeps it as
   * the `source_uuid` of the attachment it absorbs the message into.
   */
  push(content: string | AnthropicContentBlock[], uuid?: string): Promise<void>;
  end(): void;
  ended(): boolean;
};

const TURN_INPUT_TAKE_MS = 2000;

export function createTurnInput(first: string | SdkUserPrompt): TurnInput {
  type Entry = { prompt: SdkUserPrompt; taken: () => void };
  const queue: Entry[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const notify = () => {
    wake?.();
    wake = null;
  };
  const firstPrompt: SdkUserPrompt =
    typeof first === "string"
      ? { type: "user", message: { role: "user", content: first }, parent_tool_use_id: null }
      : first;
  async function* stream(): AsyncGenerator<SdkUserPrompt, void, unknown> {
    try {
      yield firstPrompt;
      while (!done) {
        const entry = queue.shift();
        if (entry) {
          entry.taken();
          yield entry.prompt;
          continue;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    } finally {
      done = true;
      for (const entry of queue.splice(0)) entry.taken();
    }
  }
  return {
    stream: stream(),
    push(content, uuid) {
      if (done) return Promise.resolve();
      // A CLI that stops reading must not hold the tool results back.
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TURN_INPUT_TAKE_MS);
        timer.unref?.();
        const taken = () => {
          clearTimeout(timer);
          resolve();
        };
        queue.push({
          prompt: {
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
            priority: "next",
            ...(uuid ? { uuid } : {}),
          } as SdkUserPrompt,
          taken,
        });
        notify();
      });
    },
    end() {
      done = true;
      notify();
    },
    ended: () => done,
  };
}

/**
 * The prompt of a turn that starts a new transcript, after the record the
 * transcript starts with: blank, without a turn, named `uuid`
 * (names.ts TRANSCRIPT_START_NAME). It gives the chat's first message a
 * record to resume at: a retry of a first message that failed resumes there
 * in the same transcript, where it would otherwise need a new one (the CLI
 * starts no transcript without a record, and refuses a name in use). The
 * CLI sends the model nothing of a blank text (probe 47: an empty string
 * would reach it as "(no content)", an empty array writes no record).
 */
export async function* withTranscriptStart(
  prompt: string | AsyncIterable<SdkUserPrompt>,
  uuid: string,
): AsyncGenerator<SdkUserPrompt, void, unknown> {
  yield { type: "user", message: { role: "user", content: " " }, parent_tool_use_id: null, uuid, shouldQuery: false };
  yield* typeof prompt === "string" ? promptAsStream(prompt) : prompt;
}
