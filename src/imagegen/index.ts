import type { ImageGenerator } from "./types";
import { createGeminiImageGenerator } from "./providers/gemini";
import { createImagenGenerator } from "./providers/imagen";

export function getImageGenerator(provider: "gemini" | "imagen"): ImageGenerator {
  switch (provider) {
    case "gemini":
      return createGeminiImageGenerator();
    case "imagen":
      return createImagenGenerator();
    default:
      throw new Error(
        `Image generator provider "${provider as string}" is not yet implemented`
      );
  }
}

export type { ImageGenerator, ImageResult } from "./types";
