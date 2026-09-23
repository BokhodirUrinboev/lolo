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

const BUILTIN: ProfileOverride[] = [
  { match: "qwen2.5-coder", ctx: 32768, toolMode: "schema", editFormat: "auto", wholeFileMaxLines: 150, fim: QWEN_FIM, temperature: 0.2, maxOutput: 4096 },
  { match: "qwen3-coder", ctx: 65536, toolMode: "schema", editFormat: "auto", wholeFileMaxLines: 300, fim: QWEN_FIM, temperature: 0.3, maxOutput: 8192 },
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
 * Resolves the profile for a model id. User overrides win over built-ins;
 * among matches the longest prefix wins.
 */
export function resolveProfile(modelId: string, overrides: ProfileOverride[] = []): ModelProfile {
  const byLength = (list: ProfileOverride[]) =>
    list.filter((p) => modelId.startsWith(p.match)).sort((a, b) => b.match.length - a.match.length)[0];
  const builtin = byLength(BUILTIN);
  const user = byLength(overrides);
  const { match: _b, ...b } = builtin ?? { match: "" };
  const { match: _u, ...u } = user ?? { match: "" };
  return { ...FALLBACK, ...b, ...u, id: modelId };
}
