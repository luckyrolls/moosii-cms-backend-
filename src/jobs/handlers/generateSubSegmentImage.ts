import { supabase } from "../../supabase";
import { assembleImagePrompt } from "../../prompts/assemble";
import { getLLMClient } from "../../llm";
import { getImageGenerator } from "../../imagegen";
import { uploadImage } from "../../storage/upload";
import type { Job } from "../registry";

type Input = {
  sub_segment_id: string;
  auto_approve?: boolean;
  prompt_override?: string;
  instructions_override?: string;
};

type LLMProvider = "gemini" | "openai" | "anthropic";

// ---------------------------------------------------------------------------
// Context loader
// ---------------------------------------------------------------------------

async function loadContext(subSegmentId: string) {
  const { data: subSeg, error: ssErr } = await supabase
    .from("sub_segments")
    .select("id, title, content, seg_id")
    .eq("id", subSegmentId)
    .single();
  if (ssErr || !subSeg) throw new Error(`sub_segment not found: ${subSegmentId}`);

  if (!subSeg.seg_id) throw new Error(`sub_segment ${subSegmentId} has no seg_id`);

  const { data: segment, error: segErr } = await supabase
    .from("segments")
    .select("id, lesson_id")
    .eq("id", subSeg.seg_id)
    .single();
  if (segErr || !segment) throw new Error(`segment not found for sub_segment ${subSegmentId}`);

  if (!segment.lesson_id) throw new Error(`segment ${segment.id} has no lesson_id`);

  const { data: lesson, error: lessonErr } = await supabase
    .from("lessons")
    .select("id, lesson_name, description, track_id, topic_id")
    .eq("id", segment.lesson_id)
    .single();
  if (lessonErr || !lesson) throw new Error(`lesson not found for sub_segment ${subSegmentId}`);

  if (!lesson.track_id) throw new Error(`lesson ${lesson.id} has no track_id`);

  const [trackResult, topicResult] = await Promise.all([
    supabase.from("tracks").select("track_name, description").eq("id", lesson.track_id).single(),
    lesson.topic_id
      ? supabase.from("topics").select("name").eq("id", lesson.topic_id).single()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (trackResult.error || !trackResult.data) {
    throw new Error(`track not found for sub_segment ${subSegmentId}`);
  }

  return {
    subSeg,
    lesson,
    track: trackResult.data,
    topicName: (topicResult.data as { name: string } | null)?.name ?? "_generic",
  };
}

// ---------------------------------------------------------------------------
// Structured output schema — passed to the LLM client; NOT hardcoded there
// ---------------------------------------------------------------------------

const IMAGE_PROMPT_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string" },
    name:   { type: "string" },
    tags:   { type: "array", items: { type: "string" } },
  },
  required: ["prompt"],
};

// ---------------------------------------------------------------------------
// LLM response parser — structured output guarantees valid JSON, but we still
// fail loud if something unexpected slips through
// ---------------------------------------------------------------------------

function parseLLMResponse(raw: string): { prompt: string; name?: string; tags?: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error(`LLM response was not valid JSON.\nRaw text:\n${raw}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).prompt !== "string"
  ) {
    throw new Error(`LLM response JSON is missing a 'prompt' string.\nRaw text:\n${raw}`);
  }

  return parsed as { prompt: string; name?: string; tags?: string[] };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function generateSubSegmentImageHandler(job: Job): Promise<unknown> {
  const {
    sub_segment_id,
    auto_approve = false,
    prompt_override,
    instructions_override,
  } = job.input as Input;

  if (!sub_segment_id) throw new Error("input.sub_segment_id is required");

  // Step 1 — load context
  const { subSeg, lesson, track, topicName } = await loadContext(sub_segment_id);

  // Step 2 — assemble prompt (always; gives us userPrompt + versions + overlayUsed)
  const metadata = {
    trackName: track.track_name ?? "",
    trackDescription: track.description ?? "",
    lessonTitle: lesson.lesson_name ?? "",
    lessonDescription: lesson.description ?? "",
    subSegmentHeading: subSeg.title ?? "",
    content: subSeg.content ?? "",
  };
  const assembled = await assembleImagePrompt(topicName, metadata, instructions_override);

  // Step 3 — get the image prompt (LLM or override)
  let imagePrompt: string;
  let imageName: string | null = null;
  let imageTags: string[] = [];
  let promptWriterName: string | null = null;
  let promptWriterVersion: string | null = null;
  let instructionVersionBase = assembled.versions.base;
  let instructionVersionOverlay = assembled.versions.overlay;

  if (prompt_override) {
    imagePrompt = prompt_override;
    instructionVersionBase = "override";
    instructionVersionOverlay = "override";
  } else {
    const llmProvider = (process.env.PROMPT_WRITER ?? "gemini") as LLMProvider;
    const llmClient = getLLMClient(llmProvider);
    const llmResult = await llmClient.generate({
      instructions: assembled.instructions,
      userPrompt: assembled.userPrompt,
      responseSchema: IMAGE_PROMPT_SCHEMA,
    });
    const parsed = parseLLMResponse(llmResult.text);
    imagePrompt = parsed.prompt;
    imageName = parsed.name ?? null;
    imageTags = parsed.tags ?? [];
    promptWriterName = llmClient.name;
    promptWriterVersion = llmResult.version;
  }

  // Step 4 — generate the image
  const imageGenProvider = (process.env.IMAGE_GENERATOR ?? "imagen") as "gemini" | "imagen";
  const imageGenerator = getImageGenerator(imageGenProvider);
  const imageResult = await imageGenerator.generate(imagePrompt);

  // Step 5 — insert content_images row (storage_path placeholder; updated after upload)
  const { data: contentImage, error: insertErr } = await supabase
    .from("content_images")
    .insert({
      sub_segment_id,
      image_prompt: imagePrompt,
      final_prompt: imagePrompt,
      name: imageName,
      tags: imageTags,
      prompt_writer_name: promptWriterName,
      prompt_writer_version: promptWriterVersion,
      image_generator_name: imageResult.model,
      image_generator_version: imageResult.version,
      instruction_version_base: instructionVersionBase,
      instruction_version_overlay: instructionVersionOverlay,
      topic_name: topicName === "_generic" ? null : topicName,
      job_id: job.id,
      status: "candidate",
      storage_path: "pending",
    })
    .select("id")
    .single();

  if (insertErr || !contentImage) {
    throw new Error(`Failed to insert content_images row: ${insertErr?.message}`);
  }

  // Step 6 — upload bytes; use content_images.id as the stable imageId
  const { path, publicUrl } = await uploadImage({
    bytes: imageResult.bytes,
    mimeType: imageResult.mimeType,
    subSegmentId: sub_segment_id,
    imageId: contentImage.id,
  });

  // Step 7 — write the real storage path back
  await supabase
    .from("content_images")
    .update({ storage_path: path })
    .eq("id", contentImage.id);

  // Step 8 — auto-approve if requested
  let finalStatus = "candidate";
  if (auto_approve) {
    // Supersede any existing approved image for this sub_segment
    await supabase
      .from("content_images")
      .update({ status: "superseded" })
      .eq("sub_segment_id", sub_segment_id)
      .eq("status", "approved")
      .neq("id", contentImage.id);

    await supabase
      .from("content_images")
      .update({ status: "approved", approved_at: new Date().toISOString() })
      .eq("id", contentImage.id);

    await supabase
      .from("sub_segments")
      .update({ image: publicUrl })
      .eq("id", sub_segment_id);

    finalStatus = "approved";
  }

  return {
    content_image_id: contentImage.id,
    path,
    publicUrl,
    status: finalStatus,
    overlayUsed: assembled.overlayUsed,
  };
}
