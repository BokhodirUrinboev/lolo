import { resolveProfile, type ProfileOverride } from "./modelProfiles";
import { OllamaProvider } from "./ollama";
import { OpenAICompatProvider } from "./openaiCompat";
import type { LLMProvider } from "./types";

export interface ProviderConfig {
  provider: "ollama" | "openai";
  endpoint: string;
  apiKey?: string;
  model: string;
  profiles?: ProfileOverride[];
}

export function createProvider(cfg: ProviderConfig): LLMProvider {
  const profile = resolveProfile(cfg.model, cfg.profiles);
  return cfg.provider === "openai" ? new OpenAICompatProvider(cfg.endpoint, profile, cfg.apiKey) : new OllamaProvider(cfg.endpoint, profile);
}
