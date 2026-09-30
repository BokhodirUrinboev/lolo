export interface FimTokens {
  prefix: string;
  suffix: string;
  middle: string;
  /** Extra stop sequences for FIM output. */
  stop?: string[];
  /** Repo-level FIM: other files are passed as `<file_sep>path\ncontent` before the current one. */
  fileSep?: string;
}

export interface ModelProfile {
  id: string;
  ctx: number;
  /**
   * How tool calls are obtained: "schema" = JSON-schema constrained decoding (best for
   * small models), "native" = the endpoint's function calling, "xml" = tagged text for
   * endpoints with neither.
   */
  toolMode: "schema" | "native" | "xml";
  editFormat: "whole" | "search-replace" | "line-range" | "auto";
  wholeFileMaxLines: number;
  fim?: FimTokens;
  temperature: number;
  maxOutput: number;
  /**
   * Reasoning ("thinking") for hybrid models such as Qwen3.5: false turns it off.
   * One short JSON action per step doesn't need it, and it multiplies step time.
   */
  think?: boolean;
  /** Extra sampling options passed to Ollama, overriding the model's Modelfile defaults. */
  ollamaOptions?: Record<string, number>;
}

/** A profile override from settings; `match` is a model-id prefix. */
export type ProfileOverride = Partial<ModelProfile> & { match: string };

const QWEN_FIM: FimTokens = {
  prefix: "<|fim_prefix|>",
  suffix: "<|fim_suffix|>",
  middle: "<|fim_middle|>",
  stop: ["<|endoftext|>", "<|fim_pad|>", "<|repo_name|>", "<|file_sep|>", "<|im_end|>"],
  fileSep: "<|file_sep|>",
};

const DEEPSEEK_FIM: FimTokens = { prefix: "<｜fim▁begin｜>", suffix: "<｜fim▁hole｜>", middle: "<｜fim▁end｜>", stop: ["<｜end▁of▁sentence｜>", "<｜EOT｜>"] };
const STARCODER_FIM: FimTokens = { prefix: "<fim_prefix>", suffix: "<fim_suffix>", middle: "<fim_middle>", stop: ["<|endoftext|>", "<file_sep>"] };
const CODELLAMA_FIM: FimTokens = { prefix: "<PRE> ", suffix: " <SUF>", middle: " <MID>", stop: ["<EOT>"] };

/** General (not coder) instruct models: schema tool calls, no FIM (autocomplete falls back to an installed coder model). */
const general = (match: string, ctx: number, extra: Partial<ModelProfile> = {}): ProfileOverride => ({
  match,
  ctx,
  toolMode: "schema",
  editFormat: "auto",
  wholeFileMaxLines: 150,
  temperature: 0.2,
  maxOutput: 4096,
  ...extra,
});

const BUILTIN: ProfileOverride[] = [
  { match: "qwen2.5-coder", ctx: 32768, toolMode: "schema", editFormat: "auto", wholeFileMaxLines: 150, fim: QWEN_FIM, temperature: 0.2, maxOutput: 4096 },
  // Other families, at a context that fits ~8-12 GB of VRAM; raise `ctx` in localAgent.profiles when you have more.
  general("qwen2.5", 32768),
  general("qwen3", 32768, { think: false }),
  general("llama3", 32768),
  general("gemma3", 32768),
  general("mistral", 32768),
  { match: "deepseek-coder-v2", ctx: 32768, toolMode: "schema", editFormat: "auto", wholeFileMaxLines: 150, fim: DEEPSEEK_FIM, temperature: 0.2, maxOutput: 4096 },
  // Base models for autocomplete (localAgent.autocomplete.model).
  { match: "starcoder2", ctx: 16384, toolMode: "schema", editFormat: "auto", wholeFileMaxLines: 100, fim: STARCODER_FIM, temperature: 0.2, maxOutput: 2048 },
  { match: "codellama", ctx: 16384, toolMode: "schema", editFormat: "auto", wholeFileMaxLines: 100, fim: CODELLAMA_FIM, temperature: 0.2, maxOutput: 2048 },
  // qwen2.5-coder fine-tuned on Lolo trajectories (scripts/finetune).
  { match: "lolo-coder", ctx: 32768, toolMode: "schema", editFormat: "auto", wholeFileMaxLines: 150, fim: QWEN_FIM, temperature: 0.2, maxOutput: 4096 },
  { match: "qwen3-coder", ctx: 65536, toolMode: "schema", editFormat: "auto", wholeFileMaxLines: 300, fim: QWEN_FIM, temperature: 0.3, maxOutput: 8192 },
  // General (not coder) model: no FIM tokens, so autocomplete falls back to an installed coder model.
  // Hybrid attention (only 1 in 4 layers keeps a KV cache): 64k costs ~1.3 GB more than 32k.
  // Its Modelfile sets presence_penalty 1.5, which distorts code that repeats identifiers.
  {
    match: "qwen3.5",
    ctx: 65536,
    toolMode: "schema",
    editFormat: "auto",
    wholeFileMaxLines: 200,
    temperature: 0.2,
    maxOutput: 4096,
    think: false,
    ollamaOptions: { presence_penalty: 0 },
  },
];

const FALLBACK: Omit<ModelProfile, "id"> = {
  ctx: 8192,
  toolMode: "schema",
  editFormat: "auto",
  wholeFileMaxLines: 100,
  temperature: 0.2,
  maxOutput: 2048,
};

/**
 * Resolves the profile for a model id. User overrides win over built-ins; among
 * matches the longest prefix wins. Built-ins also match without a registry
 * namespace ("huihui_ai/qwen3.5-abliterated:9b" → "qwen3.5").
 */
export function resolveProfile(modelId: string, overrides: ProfileOverride[] = []): ModelProfile {
  const bare = modelId.slice(modelId.lastIndexOf("/") + 1);
  const byLength = (list: ProfileOverride[]) =>
    list.filter((p) => modelId.startsWith(p.match) || bare.startsWith(p.match)).sort((a, b) => b.match.length - a.match.length)[0];
  const builtin = byLength(BUILTIN);
  const user = byLength(overrides);
  const { match: _b, ...b } = builtin ?? { match: "" };
  const { match: _u, ...u } = user ?? { match: "" };
  return { ...FALLBACK, ...b, ...u, id: modelId };
}
