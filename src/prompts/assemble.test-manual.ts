import { assembleImagePrompt, ImagePromptMetadata } from "./assemble";

const sampleMetadata: ImagePromptMetadata = {
  trackName: "Your Baby's First Year",
  trackDescription: "Evidence-based guidance for parents of newborns through 12 months.",
  lessonTitle: "Sleep Safety",
  lessonDescription: "How to create a safe sleep environment for your baby.",
  subSegmentHeading: "The bare crib rule",
  content:
    "A safe sleep space has a firm flat surface, a fitted sheet, and nothing else — no pillows, " +
    "bumpers, blankets, or toys. This reduces suffocation risk significantly.",
};

async function run() {
  console.log("=".repeat(60));
  console.log("TEST 1: topic with a real overlay (parent_mental)");
  console.log("=".repeat(60));
  const result1 = await assembleImagePrompt("parent_mental", sampleMetadata);
  console.log("overlayUsed:", result1.overlayUsed);
  console.log("versions:", result1.versions);
  console.log("\n--- instructions ---\n");
  console.log(result1.instructions);
  console.log("\n--- userPrompt ---\n");
  console.log(result1.userPrompt);

  console.log("\n" + "=".repeat(60));
  console.log("TEST 2: unknown topic — should fall back to _generic");
  console.log("=".repeat(60));
  const result2 = await assembleImagePrompt("nonexistent_topic", sampleMetadata);
  console.log("overlayUsed:", result2.overlayUsed);
  console.log("versions:", result2.versions);
  console.log("\n--- instructions ---\n");
  console.log(result2.instructions);

  console.log("\n" + "=".repeat(60));
  console.log("TEST 3: instructionsOverride — bypasses file loading entirely");
  console.log("=".repeat(60));
  const result3 = await assembleImagePrompt(
    "parent_mental",
    sampleMetadata,
    "OVERRIDDEN INSTRUCTIONS: warm scene, single parent, golden hour light."
  );
  console.log("overlayUsed:", result3.overlayUsed);
  console.log("versions:", result3.versions);
  console.log("\n--- instructions ---\n");
  console.log(result3.instructions);
  console.log("\n--- userPrompt ---\n");
  console.log(result3.userPrompt);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
