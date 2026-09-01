/**
 * Build Claude Agent SDK prompts from OpenAI-compatible chat messages,
 * including text, images, and PDF/document attachments.
 */
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
};

export type McpToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function parseDataUrl(url: string): {
  mediaType: string;
  data: string;
} | null {
  // Allow extra parameters between media type and base64
  // (e.g. data:image/png;name=photo.png;base64,...).
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i.exec(url.trim());
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

  // AI SDK / Anthropic-shaped image parts (not OpenAI image_url).
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
    const image = p.image;
    if (typeof image === "string") {
      if (pushDataUrl(blocks, image)) return;
      if (isHttpUrl(image)) {
        pushRemoteUrl(blocks, image, mediaType);
        return;
      }
      // Bare base64 payload
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: image },
      });
      return;
    }
    if (image instanceof URL) {
      const href = image.toString();
      if (pushDataUrl(blocks, href)) return;
      if (isHttpUrl(href)) pushRemoteUrl(blocks, href, mediaType);
      return;
    }
    if (image && typeof image === "object" && "url" in image) {
      const url = (image as { url?: unknown }).url;
      if (typeof url === "string") {
        if (pushDataUrl(blocks, url)) return;
        if (isHttpUrl(url)) pushRemoteUrl(blocks, url, mediaType);
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
    const url =
      typeof file.url === "string"
        ? file.url
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
      if (isHttpUrl(url)) pushRemoteUrl(blocks, url, mediaType || name);
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

export function contentHasAttachments(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const type = (part as { type?: unknown }).type;
    return (
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

/**
 * Convert OpenAI-compatible tool result content into MCP result blocks.
 * OpenCode's read tool returns images as file attachments on the tool result;
 * those must stay attached when the parked Claude SDK tool call resumes.
 */
export function openaiToolResultToMcpContent(
  content: unknown,
): McpToolResultContent[] {
  const result: McpToolResultContent[] = [];
  for (const block of openaiContentToAnthropicBlocks(content)) {
    if (block.type === "text") {
      result.push(block);
      continue;
    }
    if (block.type === "image" && block.source.type === "base64") {
      result.push({
        type: "image",
        data: block.source.data,
        mimeType: block.source.media_type,
      });
    }
  }
  return result;
}

/**
 * Latest user turn as a Claude Agent SDK prompt (string when text-only).
 */
export function latestUserPrompt(
  messages: Array<{ role?: string; content?: unknown }>,
): string | SdkUserPrompt {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    const content = msg.content;
    if (!contentHasAttachments(content)) {
      const text = extractTextContent(content).trim();
      if (text) return text;
      continue;
    }
    const blocks = openaiContentToAnthropicBlocks(content);
    if (blocks.length === 0) continue;
    return {
      type: "user",
      message: { role: "user", content: blocks },
      parent_tool_use_id: null,
    };
  }
  return "";
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
 * The Agent SDK turn only receives the latest user message; earlier context
 * comes from resuming the sticky Claude session. When no session can be
 * resumed (first claude-code turn after a model switch, lost store, deleted
 * session file), the proxy injects the serialized prior conversation instead
 * so Claude still sees the whole chat.
 */

export type ConversationHistoryMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

/** Default history budget — generous on purpose ("keep it big"). */
const DEFAULT_HISTORY_MAX_CHARS = 400_000;
const TOOL_RESULT_MAX_CHARS = 1_000;
const ATTACHMENT_NOTE = "[attachment(s) omitted from transferred history]";

export function historyMaxChars(): number {
  const raw = process.env.OPENCODE_CLAUDE_HISTORY_MAX_CHARS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_HISTORY_MAX_CHARS;
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max / 2));
  const tail = text.slice(text.length - Math.floor(max / 2));
  return `${head}\n… [${text.length - max} chars omitted] …\n${tail}`;
}

function serializeHistoryMessage(
  msg: ConversationHistoryMessage,
): string | null {
  if (!msg || typeof msg !== "object") return null;
  const role = msg.role;
  // System prompts are OpenCode-internal and huge; the Claude Code preset
  // supplies the agent system prompt instead.
  if (role === "system") return null;

  if (role === "user") {
    const text = extractTextContent(msg.content).trim();
    const hasAttach = contentHasAttachments(msg.content);
    if (!text && !hasAttach) return null;
    return `User:\n${text}${hasAttach ? `\n${ATTACHMENT_NOTE}` : ""}`.trim();
  }

  if (role === "assistant") {
    const parts: string[] = [];
    const text = extractTextContent(msg.content).trim();
    if (text) parts.push(text);
    for (const call of msg.tool_calls ?? []) {
      const name = call?.function?.name;
      if (name) parts.push(`[called tool: ${name}]`);
    }
    if (parts.length === 0) return null;
    return `Assistant:\n${parts.join("\n")}`;
  }

  if (role === "tool") {
    const text = extractTextContent(msg.content).trim();
    if (!text) return null;
    const label =
      (typeof msg.name === "string" && msg.name) ||
      (typeof msg.tool_call_id === "string" && msg.tool_call_id) ||
      "tool";
    return `Tool result (${label}):\n${truncateMiddle(text, TOOL_RESULT_MAX_CHARS)}`;
  }

  return null;
}

/** Messages before the latest user turn — the context Claude is missing. */
export function priorMessagesOf(
  messages: ConversationHistoryMessage[],
): ConversationHistoryMessage[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  return lastUser > 0 ? messages.slice(0, lastUser) : [];
}

/**
 * Serialize prior conversation into a compact transcript, keeping the NEWEST
 * messages within the char budget (older turns are dropped first).
 */
export function buildConversationTranscript(
  messages: ConversationHistoryMessage[],
  maxChars: number = historyMaxChars(),
): string {
  if (maxChars <= 0) return "";
  const serialized: string[] = [];
  for (const msg of messages) {
    const line = serializeHistoryMessage(msg);
    if (line) serialized.push(line);
  }
  if (serialized.length === 0) return "";

  const kept: string[] = [];
  let total = 0;
  let omitted = 0;
  for (let i = serialized.length - 1; i >= 0; i--) {
    const entry = serialized[i];
    if (total + entry.length > maxChars) {
      omitted = i + 1;
      break;
    }
    kept.unshift(entry);
    total += entry.length;
  }
  const header = omitted > 0 ? `[${omitted} earlier message(s) omitted]\n\n` : "";
  return header + kept.join("\n\n");
}

/**
 * Prepend a transferred-history block to a prompt. Text prompts get a plain
 * prefix; multimodal prompts get an extra leading text block so attachments
 * still reach Claude.
 */
export function withConversationContext(
  prompt: string | SdkUserPrompt,
  transcript: string,
): string | SdkUserPrompt {
  const body = transcript.trim();
  if (!body) return prompt;
  const prefix =
    "<conversation_history>\n" +
    "The earlier conversation of this chat is included below because the previous " +
    "Claude session could not be resumed. Treat it as established context — do not " +
    "re-do completed work — and respond to the user's latest message, which follows " +
    "the history.\n\n" +
    body +
    "\n</conversation_history>\n\nLatest user message:\n";
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
