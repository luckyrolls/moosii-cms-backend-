import { GoogleGenAI } from "@google/genai";
import type { ImageGenerator, ImageResult } from "../types";
import { withRetry } from "../../lib/retry";

const IMAGE_MODEL = "imagen-4.0-generate-001";

export function createImagenGenerator(): ImageGenerator {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  const ai = new GoogleGenAI({ apiKey });

  return {
    name: "imagen",

    async generate(prompt: string): Promise<ImageResult> {
      const response = await withRetry(() =>
        ai.models.generateImages({
          model: IMAGE_MODEL,
          prompt,
          config: { numberOfImages: 1 },
        })
      );

      const generated = response.generatedImages?.[0];
      if (!generated?.image?.imageBytes) {
        const reason = generated?.raiFilteredReason ?? "(none)";
        throw new Error(`No image returned from Imagen. RAI filter reason: ${reason}`);
      }

      return {
        bytes: Buffer.from(generated.image.imageBytes, "base64"),
        mimeType: generated.image.mimeType ?? "image/png",
        model: IMAGE_MODEL,
        version: IMAGE_MODEL,
        raw: response,
      };
    },
  };
}
