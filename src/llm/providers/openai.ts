import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import type { LLMClient, GenerateArgs, GenerateResult } from "../types";
import { withRetry } from "../../lib/retry";

const DEFAULT_MODEL = "gpt-4o";

// Reasoning-class models (o1/o3/o4-*) reject non-default temperature.
function isReasoningModel(model: string): boolean {
  return /^o[134](-|$)/.test(model);
}

// GPT-5.x uses max_completion_tokens; older models use max_tokens.
function tokenParam(model: string, tokens: number): Record<string, number> {
  return model.startsWith("gpt-5") ? { max_completion_tokens: tokens } : { max_tokens: tokens };
}

export function createOpenAIClient(): LLMClient {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const openai = new OpenAI({ apiKey });

  return {
    name: "openai",

    async generate({
      instructions,
      userPrompt,
      responseSchema,
      rawJsonSchema,
      model: modelArg,
      temperature,
      maxTokens,
    }: GenerateArgs): Promise<GenerateResult> {
      if (responseSchema && rawJsonSchema) {
        throw new Error("GenerateArgs: responseSchema and rawJsonSchema are mutually exclusive");
      }

      const model = modelArg ?? DEFAULT_MODEL;

      let responseFormat: ChatCompletionCreateParamsNonStreaming["response_format"] | undefined;
      if (rawJsonSchema) {
        responseFormat = {
          type: "json_schema" as const,
          // DB-owned schema; name/strict/schema fields are present at runtime per migration contract.
          json_schema: rawJsonSchema as unknown as { name: string; strict?: boolean; schema?: Record<string, unknown> },
        };
      } else if (responseSchema) {
        responseFormat = {
          type: "json_schema" as const,
          json_schema: {
            name: "output",
            strict: true,
            schema: responseSchema as Record<string, unknown>,
          },
        };
      }

      const params: ChatCompletionCreateParamsNonStreaming = {
        model,
        messages: [
          { role: "system", content: instructions },
          { role: "user",   content: userPrompt },
        ],
        ...(responseFormat && { response_format: responseFormat }),
        ...(!isReasoningModel(model) && temperature !== undefined && { temperature }),
        ...(maxTokens !== undefined && tokenParam(model, maxTokens)),
      };

      const response = await withRetry(() =>
        openai.chat.completions.create(params)
      );

      const choice = response.choices[0];

      return {
        text:         choice?.message?.content ?? "",
        model:        response.model,
        version:      response.model,
        raw:          response,
        finishReason: choice?.finish_reason ?? undefined,
      };
    },
  };
}
