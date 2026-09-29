import type { ModelProfile } from "./modelProfiles";
import { ChatRequest, ChatResponse, CompletionRequest, LLMProvider, ProviderError, readLines, safeJson, ToolCall } from "./types";

interface OllamaChunk {
  message?: { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[] };
  response?: string;
  done?: boolean;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements LLMProvider {
  constructor(private readonly baseUrl: string, readonly profile: ModelProfile) {}

  get model() {
    return this.profile.id;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: this.profile.id,
      messages: req.messages,
      stream: true,
      format: req.schema,
      tools: req.tools?.map((t) => ({ type: "function", function: t })),
      think: this.profile.think,
      options: { ...this.options(req.temperature, req.maxTokens), ...(req.repeatPenalty ? { repeat_penalty: req.repeatPenalty } : {}) },
    };
    let content = "";
    const toolCalls: ToolCall[] = [];
    let promptTokens: number | undefined;
    let outputTokens: number | undefined;
    for await (const chunk of this.stream("/api/chat", body, req.signal)) {
      const delta = chunk.message?.content ?? "";
      if (delta) {
        content += delta;
        req.onToken?.(delta);
      }
      for (const c of chunk.message?.tool_calls ?? []) {
        const args = typeof c.function.arguments === "string" ? safeJson(c.function.arguments) : c.function.arguments;
        toolCalls.push({ name: c.function.name, arguments: args });
      }
      if (chunk.done) {
        promptTokens = chunk.prompt_eval_count;
        outputTokens = chunk.eval_count;
      }
    }
    return { content, toolCalls: toolCalls.length ? toolCalls : undefined, promptTokens, outputTokens };
  }

  async complete(req: CompletionRequest): Promise<string> {
    const body = {
      model: this.profile.id,
      prompt: req.prompt,
      raw: true,
      stream: true,
      options: { ...this.options(req.temperature, req.maxTokens), stop: req.stop },
    };
    let out = "";
    for await (const chunk of this.stream("/api/generate", body, req.signal)) out += chunk.response ?? "";
    return out;
  }

  async supportsImages(): Promise<boolean | undefined> {
    try {
      const res = await fetch(this.baseUrl.replace(/\/$/, "") + "/api/show", { method: "POST", body: JSON.stringify({ model: this.profile.id }) });
      if (!res.ok) return undefined;
      const caps = ((await res.json()) as { capabilities?: string[] }).capabilities;
      return caps ? caps.includes("vision") : undefined;
    } catch {
      return undefined;
    }
  }

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<number[][]> {
    const res = await fetch(this.baseUrl.replace(/\/$/, "") + "/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: texts, truncate: true }),
      signal,
    });
    if (!res.ok) throw new ProviderError(`Ollama /api/embed: HTTP ${res.status} ${await res.text()}`, res.status);
    return ((await res.json()) as { embeddings: number[][] }).embeddings;
  }

  private options(temperature?: number, maxTokens?: number) {
    return {
      ...this.profile.ollamaOptions,
      num_ctx: this.profile.ctx,
      temperature: temperature ?? this.profile.temperature,
      num_predict: maxTokens ?? this.profile.maxOutput,
    };
  }

  private async *stream(path: string, body: object, signal?: AbortSignal): AsyncGenerator<OllamaChunk> {
    const res = await fetch(this.baseUrl.replace(/\/$/, "") + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) throw new ProviderError(`Ollama ${path}: HTTP ${res.status} ${await res.text()}`, res.status);
    for await (const line of readLines(res.body)) {
      const chunk = JSON.parse(line) as OllamaChunk;
      if (chunk.error) throw new ProviderError(`Ollama: ${chunk.error}`);
      yield chunk;
    }
  }
}
