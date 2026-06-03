import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const PROMPT = "A warm minimalist illustration of a parent and baby in a sunny room, cream background.";

async function run() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  for (const model of ["imagen-4.0-generate-001", "imagen-4.0-flash-generate-001", "imagen-3.0-fast-generate-001"]) {
    console.log(`\nTrying ${model}...`);
    try {
      const response = await ai.models.generateImages({
        model,
        prompt: PROMPT,
        config: { numberOfImages: 1 },
      });
      const img = response.generatedImages?.[0];
      if (!img?.image?.imageBytes) {
        console.log("  No image. RAI filter:", img?.raiFilteredReason ?? "unknown");
      } else {
        console.log("  mimeType:", img.image.mimeType);
        console.log("  bytes:", Buffer.from(img.image.imageBytes, "base64").length.toLocaleString());
        console.log("  SUCCESS");
      }
    } catch (e: any) {
      console.log("  ERROR:", e.message?.slice(0, 200));
    }
  }
}

run();
