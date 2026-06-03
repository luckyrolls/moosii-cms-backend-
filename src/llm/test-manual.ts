import "dotenv/config";
import { getLLMClient } from "./index";
import { assembleImagePrompt } from "../prompts/assemble";

// The real base.md is still placeholder text, so we use instructionsOverride
// to inject realistic JSON-requesting instructions for this test. This also
// exercises the override path in assembleImagePrompt.
const JSON_INSTRUCTIONS = `\
You are an expert image prompt writer for a parenting education mobile app called Moosii.

Your job is to write a photorealistic image generation prompt based on the sub-segment content provided.

Brand aesthetic: warm, human, story-driven. Color palette: #441C44 purple, #FC570D orange, \
#BEB400 yellow on white/cream backgrounds. No text in the image. No iconography or symbols — \
depict a real moment with people, not an abstract concept. One clear focal subject; \
use negative space; avoid busy compositions.

Return ONLY valid JSON, no markdown fences, no preamble, no explanation:
{"prompt": "<full image generation prompt>", "name": "<3-5 word descriptive name>", "tags": ["<tag1>", "<tag2>", "<tag3>"]}\
`;

const SAMPLE_METADATA = {
  trackName: "Your Baby's First Year",
  trackDescription: "Evidence-based guidance for parents of newborns through 12 months.",
  lessonTitle: "Sleep Safety",
  lessonDescription: "How to create a safe sleep environment for your baby.",
  subSegmentHeading: "The bare crib rule",
  content:
    "A safe sleep space has a firm flat surface, a fitted sheet, and nothing else — " +
    "no pillows, bumpers, blankets, or toys. This reduces suffocation risk significantly.",
};

async function run() {
  // Step 1: assemble prompt — exercises src/prompts/assemble.ts
  const assembled = await assembleImagePrompt("parent_mental", SAMPLE_METADATA, JSON_INSTRUCTIONS);
  console.log("=== Prompt assembly ===");
  console.log("overlayUsed:", assembled.overlayUsed);
  console.log("versions:   ", assembled.versions);
  console.log("\n--- userPrompt ---");
  console.log(assembled.userPrompt);

  // Step 2: call Gemini — exercises src/llm
  console.log("\n=== Calling Gemini ===");
  const client = getLLMClient("gemini");
  const result = await client.generate({
    instructions: assembled.instructions,
    userPrompt: assembled.userPrompt,
  });

  console.log("model:  ", result.model);
  console.log("version:", result.version);
  console.log("\n--- result.text (raw from model) ---");
  console.log(result.text);

  // Parse in the test script only — the client never does this
  console.log("\n--- parsed (test only) ---");
  try {
    const parsed = JSON.parse(result.text.trim());
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log("(not valid JSON — inspect result.text above)");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
