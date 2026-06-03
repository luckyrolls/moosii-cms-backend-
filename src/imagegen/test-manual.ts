import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { getImageGenerator } from "./index";

const PROMPT =
  "A warm minimalist flat-vector illustration of a parent and baby in a sunny room, " +
  "soft rounded shapes, cream background.";

function extensionFor(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  return map[mimeType] ?? ".bin";
}

async function run() {
  const generator = getImageGenerator("gemini");
  console.log(`Generator: ${generator.name}`);
  console.log(`Prompt: ${PROMPT}\n`);

  const result = await generator.generate(PROMPT);

  const outDir = path.join(process.cwd(), "test-output");
  await fs.mkdir(outDir, { recursive: true });

  const outPath = path.join(outDir, `imagegen-test${extensionFor(result.mimeType)}`);
  await fs.writeFile(outPath, result.bytes);

  console.log("mimeType:", result.mimeType);
  console.log("model:   ", result.model);
  console.log("version: ", result.version);
  console.log("bytes:   ", result.bytes.length.toLocaleString(), "bytes");
  console.log("file:    ", outPath);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
