import { GoogleGenAI } from "@google/genai";
import type { LLMClient, GenerateArgs, GenerateResult } from "../types";
import { withRetry } from "../../lib/retry";

// gemini-2.5-flash is the stable, reliably-available default. gemini-3.5-flash (newer)
// is frequently 503 "high demand" right now — callers can still opt into it per prompt
// (the provider honors `model`), but the default must be a model that answers.
const DEFAULT_MODEL = "gemini-2.5-flash";

export function createGeminiClient(): LLMClient {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey });

  return {
    name: "gemini",

    // Honors model / temperature / maxTokens from the caller (the prompt row), falling
    // back to the hardcoded default model when unset. Lets reviewers tune temperature.
    async generate({ instructions, userPrompt, responseSchema, model, temperature, maxTokens }: GenerateArgs): Promise<GenerateResult> {
      const useModel = model ?? DEFAULT_MODEL;
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: useModel,
          contents: userPrompt,
          config: {
            systemInstruction: instructions,
            ...(temperature !== undefined && { temperature }),
            ...(maxTokens !== undefined && { maxOutputTokens: maxTokens }),
            ...(responseSchema && {
              responseMimeType: "application/json",
              responseSchema,
            }),
          },
        })
      );

      return {
        text: response.text ?? "",
        model: useModel,
        version: response.modelVersion ?? useModel,
        raw: response,
      };
    },
  };
}
