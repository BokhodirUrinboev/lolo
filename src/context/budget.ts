import type { ModelProfile } from "../providers/modelProfiles";

/** Rough token estimate; good enough for budgeting (code averages ~3.5 chars/token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Share of the context window per prompt section. */
/** `instructions` (CLAUDE.md/AGENTS.md) comes on top: the history budget shrinks by whatever the prefix really uses. */
export const QUOTAS = { rules: 0.05, instructions: 0.1, map: 0.12, files: 0.45, history: 0.25, output: 0.13 } as const;
export type Section = keyof typeof QUOTAS;

export class Budget {
  constructor(readonly ctx: number) {}

  static for(profile: ModelProfile) {
    return new Budget(profile.ctx);
  }

  tokens(section: Section): number {
    return Math.floor(this.ctx * QUOTAS[section]);
  }

  /** Conversation (tool observations incl. file contents + history) may use the files and history quotas. */
  get conversation(): number {
    return this.tokens("files") + this.tokens("history");
  }

  /** Trims `text` to the section quota, cutting at a line boundary. */
  fit(section: Section, text: string, tokens = this.tokens(section)): string {
    return fitTokens(text, tokens);
  }
}

export function fitTokens(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text;
  const maxChars = Math.floor(tokens * 3.5);
  const cut = text.lastIndexOf("\n", maxChars);
  return text.slice(0, cut > 0 ? cut : maxChars) + "\n[... truncated to fit context budget]";
}
