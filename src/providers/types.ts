import type { ModelProfile } from "./modelProfiles";

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** JSON Schema the reply must satisfy (constrained decoding). */
  schema?: object;
  /** Native function calling (toolMode "native"). */
  tools?: ToolSpec[];
  temperature?: number;
  /** Penalty for repeated tokens (raised on retries after degenerate output). */
  repeatPenalty?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Streaming callback; receives raw content deltas. */
  onToken?: (delta: string) => void;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: object;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatResponse {
  content: string;
  toolCalls?: ToolCall[];
  promptTokens?: number;
  outputTokens?: number;
}

export interface CompletionRequest {
  /** Fully formatted raw prompt (e.g. FIM tokens already applied). */
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly model: string;
  readonly profile: ModelProfile;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Raw completion without chat template; used for FIM autocomplete. */
  complete(req: CompletionRequest): Promise<string>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Yields each complete line of a streamed HTTP body. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

export function safeJson(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
