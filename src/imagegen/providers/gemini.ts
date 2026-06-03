import { GoogleGenAI } from "@google/genai";
import type { ImageGenerator, ImageResult } from "../types";
import { withRetry } from "../../lib/retry";

const IMAGE_MODEL = "gemini-3.1-flash-image";

export function createGeminiImageGenerator(): ImageGenerator {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey });

  return {
    name: "gemini",

    async generate(prompt: string): Promise<ImageResult> {
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: IMAGE_MODEL,
          contents: prompt,
          config: { responseModalities: ["TEXT", "IMAGE"] },
        })
      );

      const parts = response.candidates?.[0]?.content?.parts ?? [];

      const imagePart = parts.find((p) => p.inlineData?.data);
      if (!imagePart?.inlineData?.data) {
        const modelText = parts
          .filter((p) => p.text)
          .map((p) => p.text)
          .join("\n");
        throw new Error(
          `No image part in response. Model text: ${modelText || "(none)"}`
        );
      }

      const { data, mimeType } = imagePart.inlineData;

      return {
        bytes: Buffer.from(data, "base64"),
        mimeType: mimeType ?? "image/png",
        model: IMAGE_MODEL,
        version: response.modelVersion ?? IMAGE_MODEL,
        raw: response,
      };
    },
  };
}
