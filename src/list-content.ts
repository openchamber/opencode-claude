/**
 * What a request says, in one form: OpenCode's message list (LLM.Message,
 * see prompt.ts), with the system prompt and the tools beside it.
 *
 * A chat turn reads all of it from the `context` hook's event (context-list.ts),
 * the same list, system parts and tools OpenCode then lowers into the HTTP
 * body: the ids that name the transcript's records and the content travel
 * together, and nothing has to be matched between two forms. A summary is read
 * from its body: OpenCode adds the summary prompt after its hook and may
 * shrink the history before a retry, so only the body is what it asks. A
 * title or a generate request has no hook of ours: its body too. A body is
 * put into the list form here, without ids, so the prompt builders read one
 * form only.
 */
import type { ContextEvent } from "./context-list.js";
import { asSentInBody } from "./removed-images.js";
import {
  SYNTHETIC_TOOL_MEDIA_PROMPT,
  decodeToolMessageContent,
  extractTextContent,
  isSyntheticToolMediaMessage,
  openaiContentToAnthropicBlocks,
  type AnthropicContentBlock,
  type ConversationMessage,
  type ListPart,
} from "./prompt.js";

/** A request's content: the leading system prompt, then the conversation. */
export type RequestContent = {
  /** The system prompt as system messages (OpenCode's own prompt, instructions, context). */
  system: ConversationMessage[];
  messages: ConversationMessage[];
};

/** A message of an OpenAI-compatible request body. */
export type BodyMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
  name?: string;
};

/** An OpenAI-compatible tool definition, as the proxy builds Claude's tool bridge from. */
export type BodyTool = {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
};

/**
 * A system update mid-conversation, the way OpenCode lowers it for an
 * OpenAI-compatible provider (protocols/shared.ts wrapSystemUpdate): user
 * text in a `<system-update>` wrapper, escaped.
 */
function wrapSystemUpdate(text: string): string {
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<system-update>\n${escaped}\n</system-update>`;
}

/** The content parts of a list message; a bare string as one text part. */
function partsOf(content: unknown): ListPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as ListPart[]) : [];
}

/** The texts of system parts joined as OpenCode joins them (protocols/shared.ts joinText). */
function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((part) => (typeof part === "string" ? part : String((part as { text?: unknown })?.text ?? ""))).join("\n");
}

/**
 * A chat turn's content from the context hook's event, read now (another
 * plugin's hook may have replaced `messages` after ours). The list keeps its
 * positions: a system update mid-conversation becomes the user text OpenCode
 * makes of it, in its place. The images OpenCode took out of the body after
 * the hooks are taken out here too (removed-images.ts asSentInBody): Claude
 * gets what any other model gets.
 */
export function contentOfEvent(event: ContextEvent, body: BodyMessage[]): RequestContent {
  const text = systemText(event.system);
  const listed = (Array.isArray(event.messages) ? event.messages : []).map((message): ConversationMessage => {
    if (message.role === "system") {
      return { role: "user", content: [{ type: "text", text: wrapSystemUpdate(extractTextContent(partsOf(message.content))) }] };
    }
    return { ...message, role: String(message.role ?? ""), content: partsOf(message.content) };
  });
  return { system: text ? [{ role: "system", content: [{ type: "text", text }] }] : [], messages: asSentInBody(listed, body) };
}

/** OpenCode's tools of a chat turn (name → description and input schema) in OpenAI form. */
export function toolsOfEvent(event: ContextEvent): BodyTool[] {
  if (!event.tools || typeof event.tools !== "object") return [];
  return Object.entries(event.tools as Record<string, { description?: string; input?: unknown }>).map(([name, tool]) => ({
    type: "function",
    function: { name, description: tool?.description ?? "", parameters: tool?.input ?? { type: "object", properties: {} } },
  }));
}

/** Content blocks of a body message as list parts: text as text, images and documents as media. */
function blocksToParts(blocks: AnthropicContentBlock[]): ListPart[] {
  return blocks.map((block): ListPart => {
    if (block.type === "text") return { type: "text", text: block.text };
    const mediaType = block.source.type === "base64" ? block.source.media_type : block.type === "document" ? "application/pdf" : "image/png";
    const source = block.source.type === "base64"
      ? { type: "base64", data: block.source.data, mediaType }
      : { type: "url", url: block.source.url, mediaType };
    return { type: "media", media: { source, mediaType } };
  });
}

/** A body message's content as list parts; its texts exactly as sent. */
function bodyContentToParts(content: unknown): ListPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): ListPart[] => {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
      return [{ type: "text", text: String((part as { text?: unknown }).text ?? "") }];
    }
    return blocksToParts(openaiContentToAnthropicBlocks([part]));
  });
}

/** Media of a body message as the files of a tool result (Tool.FileContent). */
function blocksToToolFiles(blocks: AnthropicContentBlock[]): Array<Record<string, unknown>> {
  return blocks.flatMap((block) => {
    if (block.type === "text") return [];
    if (block.source.type === "url") return [{ type: "file", uri: block.source.url, mime: block.type === "document" ? "application/pdf" : "image/png" }];
    return [{ type: "file", uri: `data:${block.source.media_type};base64,${block.source.data}`, mime: block.source.media_type }];
  });
}

/**
 * A request body in the list form, without ids. The leading system messages
 * are the system prompt. A tool call's results become `tool-result` parts of
 * one tool message; the media OpenCode moves out of tool results into a user
 * message (openai-chat flushAttachments) go back onto the last result, where
 * the list keeps them.
 */
export function contentOfBody(body: BodyMessage[]): RequestContent {
  let start = 0;
  while (start < body.length && body[start]?.role === "system") start++;
  const system = body.slice(0, start).map((m): ConversationMessage => ({ role: "system", content: bodyContentToParts(m.content) }));
  const names = new Map<string, string>();
  const messages: ConversationMessage[] = [];
  for (let i = start; i < body.length; i++) {
    const m = body[i]!;
    if (m.role === "assistant") {
      const content: ListPart[] = [];
      const text = extractTextContent(m.content);
      if (text) content.push({ type: "text", text });
      for (const call of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call?.function?.arguments || "{}");
        } catch {
          input = call?.function?.arguments;
        }
        if (call?.id && call.function?.name) names.set(call.id, call.function.name);
        content.push({ type: "tool-call", id: call?.id ?? "", name: call?.function?.name ?? "tool", input });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    if (m.role === "tool") {
      // OpenCode 2.x sends a tool's content parts JSON-encoded in the body
      // (decodeToolMessageContent): decoded, they are the parts the list
      // keeps, its files included.
      const decoded = decodeToolMessageContent(m.content);
      const part: ListPart = {
        type: "tool-result",
        id: m.tool_call_id ?? "",
        name: m.name ?? names.get(m.tool_call_id ?? "") ?? "tool",
        result:
          Array.isArray(decoded) && decoded !== m.content
            ? { type: "content", value: decoded }
            : { type: "text", value: extractTextContent(m.content) },
      };
      const previous = messages.at(-1);
      if (previous?.role === "tool") previous.content.push(part);
      else messages.push({ role: "tool", content: [part] });
      continue;
    }
    if (m.role === "user" && isSyntheticToolMediaMessage(m, body[i - 1])) {
      const last = messages.at(-1)?.role === "tool" ? messages.at(-1)!.content.at(-1) : undefined;
      if (last) {
        const files = blocksToToolFiles(
          openaiContentToAnthropicBlocks(m.content).filter(
            (b) => !(b.type === "text" && b.text.trim() === SYNTHETIC_TOOL_MEDIA_PROMPT),
          ),
        );
        const result = last.result as { type?: unknown; value?: unknown } | undefined;
        if (result?.type === "content" && Array.isArray(result.value)) {
          last.result = { type: "content", value: [...result.value, ...files] };
          continue;
        }
        const text = String(result?.value ?? "");
        last.result = { type: "content", value: [...(text ? [{ type: "text", text }] : []), ...files] };
        continue;
      }
    }
    messages.push({ role: m.role === "system" ? "user" : String(m.role ?? "user"), content: bodyContentToParts(m.content) });
  }
  return { system, messages };
}
