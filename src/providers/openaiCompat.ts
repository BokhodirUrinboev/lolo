import type { ModelProfile } from "./modelProfiles";
import { ChatRequest, ChatResponse, CompletionRequest, LLMProvider, ProviderError, readLines, safeJson } from "./types";

/** OpenAI-compatible endpoint (llama.cpp server, LM Studio, vLLM). `baseUrl` ends in /v1. */
export class OpenAICompatProvider implements LLMProvider {
  constructor(private readonly baseUrl: string, readonly profile: ModelProfile, private readonly apiKey = "") {}

  get model() {
    return this.profile.id;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.profile.id,
      messages: req.messages,
      temperature: req.temperature ?? this.profile.temperature,
      max_tokens: req.maxTokens ?? this.profile.maxOutput,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.repeatPenalty) body.frequency_penalty = Math.min(2, (req.repeatPenalty - 1) * 4);
    if (req.schema) body.response_format = { type: "json_schema", json_schema: { name: "reply", schema: req.schema, strict: true } };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: "function", function: t }));
      body.tool_choice = "required";
    }

    let content = "";
    const calls: { name: string; args: string }[] = [];
    let promptTokens: number | undefined;
    let outputTokens: number | undefined;
    for await (const data of this.sse("/chat/completions", body, req.signal)) {
      const delta: string = data.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        content += delta;
        req.onToken?.(delta);
      }
      // Streamed tool calls arrive as fragments keyed by index.
      for (const tc of data.choices?.[0]?.delta?.tool_calls ?? []) {
        const i = tc.index ?? 0;
        calls[i] ??= { name: "", args: "" };
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
      if (data.usage) {
        promptTokens = data.usage.prompt_tokens;
        outputTokens = data.usage.completion_tokens;
      }
    }
    const toolCalls = calls.filter(Boolean).map((c) => ({ name: c.name, arguments: safeJson(c.args) }));
    return { content, toolCalls: toolCalls.length ? toolCalls : undefined, promptTokens, outputTokens };
  }

  async complete(req: CompletionRequest): Promise<string> {
    const body = {
      model: this.profile.id,
      prompt: req.prompt,
      temperature: req.temperature ?? this.profile.temperature,
      max_tokens: req.maxTokens ?? this.profile.maxOutput,
      stop: req.stop,
      stream: true,
    };
    let out = "";
    for await (const data of this.sse("/completions", body, req.signal)) out += data.choices?.[0]?.text ?? "";
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async *sse(path: string, body: object, signal?: AbortSignal): AsyncGenerator<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const res = await fetch(this.baseUrl.replace(/\/$/, "") + path, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) throw new ProviderError(`${path}: HTTP ${res.status} ${await res.text()}`, res.status);
    for await (const line of readLines(res.body)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      yield JSON.parse(payload);
    }
  }
}
