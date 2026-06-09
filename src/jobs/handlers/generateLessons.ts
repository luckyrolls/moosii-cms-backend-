import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { supabase } from "../../supabase";
import { getLLMClient } from "../../llm";
import { logAiCall, formatLlmPrompt } from "../../lib/aiLog";
import type { Job } from "../registry";

type Input = {
  prompt: string;        // e.g. "generate 3 lessons for newborns about safe sleep"
  track_id: string;
  topic_id?: string;
  count?: number;
  created_by?: string;   // user email / id to stamp on inserted rows
};

const LESSONS_SCHEMA = {
  type: "object",
  properties: {
    classes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          lesson_name:    { type: "string" },
          description:    { type: "string" },
          min_child_age:  { type: "number" },
          max_child_age:  { type: "number" },
          priority:       { type: "number" },
          band_rationale: { type: "string" },
        },
        required: ["lesson_name", "description", "min_child_age", "max_child_age", "priority", "band_rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["classes"],
  additionalProperties: false,
};

async function loadSystemPrompt(): Promise<string> {
  const filePath = path.join(process.cwd(), "prompts", "lessons", "generate.md");
  const raw = await fs.readFile(filePath, "utf-8");
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

export async function generateLessonsHandler(job: Job): Promise<unknown> {
  const { prompt, track_id, topic_id, count = 3, created_by } = job.input as Input;

  if (!prompt) throw new Error("input.prompt is required");
  if (!track_id) throw new Error("input.track_id is required");

  // Step 1 — load existing lessons for this track (to avoid duplicates)
  const { data: existing, error: fetchErr } = await supabase
    .from("lessons")
    .select("lesson_name, description, min_child_age, priority")
    .eq("track_id", track_id);

  if (fetchErr) throw new Error(`Failed to load existing lessons: ${fetchErr.message}`);

  // Step 2 — assemble prompts
  const instructions = await loadSystemPrompt();

  const usedPriorities = (existing ?? []).map((l) => l.priority).filter(Boolean);

  const existingBlock = existing && existing.length > 0
    ? `\n\nExisting lessons in this track (do NOT duplicate these):\n${JSON.stringify(existing, null, 2)}\n\nExisting priority values already in use — do NOT assign these: ${usedPriorities.join(", ")}`
    : "\n\nNo lessons exist in this track yet.";

  const userPrompt = `${prompt}\n\nGenerate exactly ${count} lessons.${existingBlock}`;

  // Step 3 — generate with OpenAI
  const correlationId = randomUUID();
  const client = getLLMClient("openai");
  const llmStart = Date.now();
  const result = await client.generate({ instructions, userPrompt, responseSchema: LESSONS_SCHEMA });

  await logAiCall({
    correlationId,
    operation: "lesson_generate",
    prompt: formatLlmPrompt(instructions, userPrompt),
    response: result.raw,
    model: result.model,
    latencyMs: Date.now() - llmStart,
    relatedEntityType: null,
    relatedEntityId: null,
    notes: `batch of ${count} lessons for track_id: ${track_id}`,
  });

  let parsed: { classes: Record<string, unknown>[] };
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new Error(`OpenAI returned non-JSON.\nRaw: ${result.text}`);
  }

  const classes = parsed.classes ?? [];
  if (classes.length === 0) throw new Error("OpenAI returned no lessons");

  // Step 4 — inject track_id and topic_id, then insert lessons
  const lessonsToInsert = classes.map((c) => ({
    lesson_name:   c.lesson_name,
    description:   c.description,
    min_child_age: c.min_child_age,
    max_child_age: c.max_child_age,
    priority:      c.priority,
    track_id,
    ...(topic_id && { topic_id }),
    ...(created_by && { created_by }),
  }));

  const { data: createdLessons, error: lessonErr } = await supabase
    .from("lessons")
    .insert(lessonsToInsert)
    .select("id, lesson_name, description");

  if (lessonErr || !createdLessons) {
    throw new Error(`Lesson insert failed: ${lessonErr?.message}`);
  }

  // Step 5 — create one segment per lesson (matched by lesson_name, not array index)
  const segmentsToInsert = createdLessons.map((newLesson) => {
    const original = classes.find((c) => c.lesson_name === newLesson.lesson_name);
    return {
      lesson_id:    newLesson.id,
      segment_name: original?.lesson_name ?? newLesson.lesson_name,
      description:  original?.description ?? newLesson.description,
    };
  });

  const { error: segErr } = await supabase
    .from("segments")
    .insert(segmentsToInsert);

  if (segErr) throw new Error(`Segment insert failed: ${segErr.message}`);

  return {
    lessons_inserted:  createdLessons.length,
    segments_inserted: segmentsToInsert.length,
    lesson_ids:        createdLessons.map((l) => l.id),
    lessons:           createdLessons.map((l) => {
      const original = classes.find((c) => c.lesson_name === l.lesson_name);
      return { id: l.id, lesson_name: l.lesson_name, priority: original?.priority, band_rationale: original?.band_rationale };
    }),
    model:             result.model,
  };
}
