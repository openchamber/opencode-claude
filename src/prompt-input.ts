import type { SdkUserPrompt } from "./prompt.js";

type PromptResult = IteratorResult<SdkUserPrompt>;

class PromptQueue implements AsyncIterable<SdkUserPrompt>, AsyncIterator<SdkUserPrompt> {
  private readonly values: SdkUserPrompt[] = [];
  private readonly waiters: Array<(result: PromptResult) => void> = [];
  private closed = false;

  push(prompt: SdkUserPrompt): void {
    if (this.closed) {
      throw new Error("Claude prompt stream is closed");
    }
    const resolve = this.waiters.shift();
    if (resolve) {
      resolve({ done: false, value: prompt });
    } else {
      this.values.push(prompt);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!({ done: true, value: undefined as never });
    }
  }

  async next(): Promise<PromptResult> {
    const value = this.values.shift();
    if (value) return { done: false, value };
    if (this.closed) return { done: true, value: undefined as never };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async return(): Promise<PromptResult> {
    this.close();
    return { done: true, value: undefined as never };
  }

  [Symbol.asyncIterator](): AsyncIterator<SdkUserPrompt> {
    return this;
  }
}

export type ClaudePromptInput = {
  stream: AsyncIterable<SdkUserPrompt>;
  push: (prompt: SdkUserPrompt) => void;
  close: () => void;
};

export function createClaudePromptInput(initial: SdkUserPrompt): ClaudePromptInput {
  const queue = new PromptQueue();
  queue.push(initial);
  return {
    stream: queue,
    push: (prompt) => queue.push(prompt),
    close: () => queue.close(),
  };
}
