import type { LLMClient } from "./types";
import { createGeminiClient } from "./providers/gemini";
import { createOpenAIClient } from "./providers/openai";

export function getLLMClient(provider: "gemini" | "openai" | "anthropic"): LLMClient {
  switch (provider) {
    case "gemini":
      return createGeminiClient();
    case "openai":
      return createOpenAIClient();
    case "anthropic":
      throw new Error("Anthropic LLM client not yet implemented");
  }
}

export type { LLMClient, GenerateArgs, GenerateResult } from "./types";
