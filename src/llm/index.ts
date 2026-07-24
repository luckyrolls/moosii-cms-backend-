import type { LLMClient } from "./types";
import { createGeminiClient } from "./providers/gemini";
import { createOpenAIClient } from "./providers/openai";

export type LLMProvider = "gemini" | "openai" | "anthropic";

export function getLLMClient(provider: LLMProvider): LLMClient {
  switch (provider) {
    case "gemini":
      return createGeminiClient();
    case "openai":
      return createOpenAIClient();
    case "anthropic":
      throw new Error("Anthropic LLM client not yet implemented");
  }
}

// Map a model string to the provider that serves it, so a caller can select the client
// FROM the model (the prompts row) instead of a separate hardcode/env — keeping the row the
// single source of truth for BOTH the model and its provider. This is the fix for "a gemini-*
// model string reached the OpenAI client": derive the provider from the model, don't choose
// them independently. `fallback` covers a null/empty/unrecognized model (e.g. an env default).
// Prefixes: gemini* → gemini · gpt*/o1|o3|o4* → openai · claude* → anthropic.
export function providerForModel(
  model: string | null | undefined,
  fallback: LLMProvider,
): LLMProvider {
  const m = (model ?? "").trim().toLowerCase();
  if (!m) return fallback;
  if (m.startsWith("gemini")) return "gemini";
  if (m.startsWith("gpt") || /^o[134](-|$)/.test(m)) return "openai";
  if (m.startsWith("claude")) return "anthropic";
  return fallback; // unrecognized model string → the caller's configured fallback
}

export type { LLMClient, GenerateArgs, GenerateResult } from "./types";
