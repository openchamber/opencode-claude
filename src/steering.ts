import { extractTextContent } from "./prompt.js";

type MessageLike = { role?: string; content?: unknown };

/**
 * Steering: a user message OpenCode queued while a tool was running arrives
 * after the tool results in the resume request. A parked bridge only
 * consumes tool results, so without this the message was silently dropped
 * (and OpenCode then treats it as answered). Returns the text of user
 * messages that follow the last tool result, or "" when there are none.
 */
export function collectSteeringText(messages: MessageLike[]): string {
  let lastTool = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "tool") lastTool = i;
  }
  if (lastTool < 0) return "";
  const texts: string[] = [];
  for (const msg of messages.slice(lastTool + 1)) {
    if (msg?.role !== "user") continue;
    const text = extractTextContent(msg.content).trim();
    if (text) texts.push(text);
  }
  return texts.join("\n\n");
}

/** Append steering text to a tool result so Claude reads it on resume. */
export function withSteering(result: string, steering: string): string {
  return [
    result,
    "",
    "<system-reminder>",
    "While this tool was running, the user sent the following message(s). Read them now and adjust your current work accordingly; they take priority over earlier instructions where they conflict:",
    "",
    steering,
    "</system-reminder>",
  ].join("\n");
}
