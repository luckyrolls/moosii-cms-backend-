import { randomUUID } from "crypto";
import { supabase } from "../../supabase";
import { getLLMClient } from "../../llm";
import { logAiCall, formatLlmPrompt } from "../../lib/aiLog";
import type { Job } from "../registry";

// Untyped alias for prompts + RPC (database.types.ts predates 0001/0004/010/011),
// matching generateQuiz.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Input = {
  track_id: string;          // required — looked up in tracks for name + description
  min_child_age: number;     // required — developmental window lower bound (months)
  max_child_age: number;     // required — developmental window upper bound (months)
  max_lessons: number;       // required — CEILING (system_message treats as max, not target)
  additional_info?: string;  // optional — author instructions (authoritative override)
  created_by?: string;       // optional — stamped on inserted rows
};

type LessonPromptRow = {
  id: string;
  system_message: string;
  output_schema: Record<string, unknown>;
  model: string;
  temperature: number | null;
  max_tokens: number | null;
};

type GeneratedLesson = {
  lesson_name: string;
  description: string;
  topic: string;
  min_child_age: number;
  max_child_age: number;
  priority: number;
  band_rationale: string;
  safety_sensitive: boolean;
};

const normalizeTopic = (s: string): string => s.trim().toLowerCase();

async function loadLessonPromptRow(): Promise<LessonPromptRow> {
  const { data, error } = await db
    .from("prompts")
    .select("id, system_message, output_schema, model, temperature, max_tokens")
    .eq("prompt_type", "lesson")
    .eq("is_active", true)
    .single();
  if (error || !data) throw new Error(`No active lesson prompt row found: ${error?.message}`);
  const row = data as LessonPromptRow;
  if (!row.system_message) throw new Error("Lesson prompt row has no system_message");
  if (!row.output_schema)  throw new Error("Lesson prompt row has no output_schema");
  if (!row.model)          throw new Error("Lesson prompt row has no model");
  return row;
}

// Build the runtime user message: bare section headers (code literals) + data.
// All instructional content lives in system_message (the 0004 prompt row).
function buildUserMessage(opts: {
  trackName: string;
  trackDescription: string;
  minChildAge: number;
  maxChildAge: number;
  maxLessons: number;
  topicNames: string[];
  existing: unknown[];
  usedPriorities: number[];
  additionalInfo?: string;
}): string {
  const parts: string[] = [];

  parts.push(
    `TRACK\n` +
    `Name: ${opts.trackName}\n` +
    `Description: ${opts.trackDescription}\n` +
    `Developmental window: ${opts.minChildAge}–${opts.maxChildAge} months\n` +
    `Maximum lessons: ${opts.maxLessons}`
  );

  parts.push(`AVAILABLE TOPICS\n${opts.topicNames.join("\n")}`);

  if (opts.existing.length > 0) {
    parts.push(
      `EXISTING LESSONS IN THIS TRACK\n${JSON.stringify(opts.existing, null, 2)}\n` +
      `Priority values already in use: ${opts.usedPriorities.join(", ")}`
    );
  } else {
    parts.push(`EXISTING LESSONS IN THIS TRACK\nNone yet.`);
  }

  if (opts.additionalInfo && opts.additionalInfo.trim()) {
    parts.push(`AUTHOR INSTRUCTIONS\n${opts.additionalInfo.trim()}`);
  }

  return parts.join("\n\n");
}

export async function generateLessonsHandler(job: Job): Promise<unknown> {
  const { track_id, min_child_age, max_child_age, max_lessons, additional_info, created_by } =
    job.input as Input;

  if (!track_id) throw new Error("input.track_id is required");
  if (typeof min_child_age !== "number" || typeof max_child_age !== "number")
    throw new Error("input.min_child_age and input.max_child_age are required (developmental window, months)");
  if (typeof max_lessons !== "number" || max_lessons < 1)
    throw new Error("input.max_lessons is required and must be >= 1");

  // Step 1 — track (name + description for the TRACK section)
  const { data: track, error: trackErr } = await supabase
    .from("tracks")
    .select("track_name, description")
    .eq("id", track_id)
    .single();
  if (trackErr || !track) throw new Error(`Track not found: ${track_id} (${trackErr?.message})`);

  // Step 2 — topics (allowed set, injected verbatim + used for resolution)
  const { data: topics, error: topicsErr } = await supabase
    .from("topics")
    .select("id, name")
    .order("sort_order", { ascending: true });
  if (topicsErr || !topics || topics.length === 0)
    throw new Error(`Failed to load topics: ${topicsErr?.message ?? "none found"}`);
  const topicIdByName = new Map(topics.map((t) => [normalizeTopic(t.name ?? ""), t.id]));
  const topicNameById = new Map(topics.map((t) => [t.id, t.name]));

  // Step 3 — existing lessons (dedup + arc/age/topic context)
  const { data: existing, error: fetchErr } = await supabase
    .from("lessons")
    .select("lesson_name, description, min_child_age, max_child_age, priority, topic_id")
    .eq("track_id", track_id);
  if (fetchErr) throw new Error(`Failed to load existing lessons: ${fetchErr.message}`);
  const existingForPrompt = (existing ?? []).map((l) => ({
    lesson_name: l.lesson_name,
    description: l.description,
    min_child_age: l.min_child_age,
    max_child_age: l.max_child_age,
    priority: l.priority,
    topic: l.topic_id ? topicNameById.get(l.topic_id) ?? null : null,
  }));
  const usedPriorities = (existing ?? []).map((l) => l.priority).filter(Boolean) as number[];

  // Step 4 — prompt row + messages
  const promptRow = await loadLessonPromptRow();
  const systemMessage = promptRow.system_message;
  const userMessage = buildUserMessage({
    trackName: track.track_name ?? "",
    trackDescription: track.description ?? "",
    minChildAge: min_child_age,
    maxChildAge: max_child_age,
    maxLessons: max_lessons,
    topicNames: topics.map((t) => t.name ?? "").filter(Boolean),
    existing: existingForPrompt,
    usedPriorities,
    additionalInfo: additional_info,
  });

  // Step 5 — generate (params + schema all from the DB row)
  const correlationId = randomUUID();
  const client = getLLMClient("openai");
  const llmStart = Date.now();
  const result = await client.generate({
    instructions:  systemMessage,
    userPrompt:    userMessage,
    rawJsonSchema: promptRow.output_schema,
    model:         promptRow.model,
    temperature:   promptRow.temperature ?? undefined,
    maxTokens:     promptRow.max_tokens  ?? undefined,
  });

  const usedAuthorInstructions = !!(additional_info && additional_info.trim());
  await logAiCall({
    correlationId,
    operation: "lesson_generate",
    prompt: formatLlmPrompt(systemMessage, userMessage),
    response: result.raw,
    model: result.model,
    latencyMs: Date.now() - llmStart,
    relatedEntityType: null,
    relatedEntityId: null,
    notes: `track_id: ${track_id}; max_lessons: ${max_lessons}; author_instructions: ${
      usedAuthorInstructions ? JSON.stringify(additional_info) : "none"
    }`,
  });

  // Step 6 — truncation/refusal guard (matches generateQuiz)
  if (result.finishReason === "length" || result.finishReason === "content_filter") {
    throw new Error(
      `OpenAI stopped with finish_reason="${result.finishReason}" for lesson_generate on track ${track_id} — not parseable. Retry the job.`
    );
  }

  // Step 7 — parse
  let classes: GeneratedLesson[];
  try {
    classes = (JSON.parse(result.text) as { classes: GeneratedLesson[] }).classes ?? [];
  } catch {
    throw new Error(`OpenAI returned non-JSON for lesson_generate.\nRaw: ${result.text}`);
  }
  if (classes.length === 0) throw new Error("OpenAI returned no lessons");

  // Step 8 — resolve topic name -> topic_id; FAIL LOUDLY on any miss (no insert)
  const unresolved: { lesson_name: string; topic: string }[] = [];
  const resolved = classes.map((c) => {
    const topic_id = topicIdByName.get(normalizeTopic(c.topic ?? ""));
    if (!topic_id) unresolved.push({ lesson_name: c.lesson_name, topic: c.topic });
    return { c, topic_id };
  });
  if (unresolved.length > 0) {
    const detail = unresolved.map((u) => `"${u.lesson_name}" → topic "${u.topic}"`).join("; ");
    throw new Error(
      `Lesson generation returned ${unresolved.length} lesson(s) with a topic outside the allowed set: ${detail}. ` +
      `Allowed: ${topics.map((t) => t.name).join(", ")}. No lessons inserted.`
    );
  }

  // Step 9 — full per-lesson rows (all eight contract fields)
  const lessonsToInsert = resolved.map(({ c, topic_id }) => ({
    lesson_name:      c.lesson_name,
    description:      c.description,
    min_child_age:    c.min_child_age,
    max_child_age:    c.max_child_age,
    priority:         c.priority,
    track_id,
    topic_id,
    band_rationale:   c.band_rationale,
    safety_sensitive: c.safety_sensitive,
    ...(created_by && { created_by }),
  }));

  // Step 10 — atomic lessons+segments insert (proven 010/011 function; not redefined)
  const { data: createdLessons, error: rpcErr } = (await db
    .rpc("create_lessons_with_segments", { p_lessons: lessonsToInsert })) as {
    data: { id: string; lesson_name: string | null; description: string | null }[] | null;
    error: { message: string } | null;
  };
  if (rpcErr || !createdLessons) throw new Error(`Lesson+segment insert failed: ${rpcErr?.message}`);

  return {
    lessons_inserted:  createdLessons.length,
    segments_inserted: createdLessons.length,
    lesson_ids:        createdLessons.map((l) => l.id),
    lessons:           createdLessons.map((l) => {
      const o = classes.find((c) => c.lesson_name === l.lesson_name);
      return {
        id: l.id, lesson_name: l.lesson_name, priority: o?.priority,
        topic: o?.topic, band_rationale: o?.band_rationale, safety_sensitive: o?.safety_sensitive,
      };
    }),
    author_instructions_used: usedAuthorInstructions,
    model: result.model,
  };
}
