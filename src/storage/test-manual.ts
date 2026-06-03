import "dotenv/config";
import { getImageGenerator } from "../imagegen";
import { uploadImage } from "./upload";

const TEST_SUB_SEGMENT_ID = "test-sub-segment";
const IMAGE_ID = crypto.randomUUID();

const PROMPT =
  "A warm minimalist flat-vector illustration of a parent and baby in a sunny room, " +
  "soft rounded shapes, cream background.";

async function run() {
  console.log("Step 1: Generating image with Gemini...");
  const generator = getImageGenerator("gemini");
  const image = await generator.generate(PROMPT);
  console.log(`  mimeType: ${image.mimeType}`);
  console.log(`  size:     ${image.bytes.length.toLocaleString()} bytes\n`);

  console.log("Step 2: Uploading to Supabase Storage (lessons bucket)...");
  const { path, publicUrl } = await uploadImage({
    bytes: image.bytes,
    mimeType: image.mimeType,
    subSegmentId: TEST_SUB_SEGMENT_ID,
    imageId: IMAGE_ID,
  });

  console.log(`  path:      ${path}`);
  console.log(`  publicUrl: ${publicUrl}`);
  console.log("\nOpen the publicUrl in a browser to confirm the image is viewable.");
  console.log(
    "Note: this wrote a real object to the lessons bucket under\n" +
    `  illustrations/sub-segment-${TEST_SUB_SEGMENT_ID}/\n` +
    "You may want to delete it from the Supabase Storage dashboard afterward."
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
