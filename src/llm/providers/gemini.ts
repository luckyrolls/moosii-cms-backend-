import { GoogleGenAI } from "@google/genai";
import type { LLMClient, GenerateArgs, GenerateResult } from "../types";
import { withRetry } from "../../lib/retry";

const MODEL = "gemini-3.5-flash";

export function createGeminiClient(): LLMClient {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey });

  return {
    name: "gemini",

    async generate({ instructions, userPrompt, responseSchema }: GenerateArgs): Promise<GenerateResult> {
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL,
          contents: userPrompt,
          config: {
            systemInstruction: instructions,
            ...(responseSchema && {
              responseMimeType: "application/json",
              responseSchema,
            }),
          },
        })
      );

      return {
        text: response.text ?? "",
        model: MODEL,
        version: response.modelVersion ?? MODEL,
        raw: response,
      };
    },
  };
}
