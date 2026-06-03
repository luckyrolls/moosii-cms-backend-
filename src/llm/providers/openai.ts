import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { LLMClient, GenerateArgs, GenerateResult } from "../types";
import { withRetry } from "../../lib/retry";

const MODEL = "gpt-4o";

export function createOpenAIClient(): LLMClient {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const openai = new OpenAI({ apiKey });

  return {
    name: "openai",

    async generate({ instructions, userPrompt, responseSchema }: GenerateArgs): Promise<GenerateResult> {
      const params: ChatCompletionCreateParamsNonStreaming = {
        model: MODEL,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: userPrompt },
        ],
        ...(responseSchema && {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: "output",
              strict: true,
              schema: responseSchema as Record<string, unknown>,
            },
          },
        }),
      };

      const response = await withRetry(() =>
        openai.chat.completions.create(params)
      );

      return {
        text: response.choices[0]?.message?.content ?? "",
        model: response.model,
        version: response.model,
        raw: response,
      };
    },
  };
}
