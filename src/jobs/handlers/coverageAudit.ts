import { randomUUID } from "crypto";
import { supabase } from "../../supabase";
import { getLLMClient } from "../../llm";
import { logAiCall, formatLlmPrompt } from "../../lib/aiLog";
import type { Job } from "../registry";

// Untyped alias for the prompts row (this prompt_type postdates database.types),
// matching generateLessons.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// Track coverage audit: analyze a track's EXISTING lessons (as stubs — pre-content)
// against its topic + age span, and PROPOSE gap-filler lesson stubs. Splits the comparative
// gap-fill that generate_lessons already does — but returns proposals and WRITES NOTHING;
// a human picks, and the sync accept endpoint inserts via the same atomic RPC. The track
// load (Step 1) and existing-lessons load (Step 3) are reused verbatim from generateLessons.

type Input = {
  track_id: string;
  // Required only when the track has ZERO existing lessons (nothing to derive the span from).
  min_child_age?: number;
  max_child_age?: number;
};

type CoverageAuditPromptRow = {
  id: string;
  system_message: string;
  output_schema: Record<string, unknown>;
  model: string;
  temperature: number | null;
  max_tokens: number | null;
};

// Each proposal carries the fields the accept tail needs (topic + priority included) PLUS
// display-only fills_gap/rationale — so accept lands identically to an ideation stub.
type Proposal = {
  lesson_name: string;
  description: string;
  min_child_age: number;
  max_child_age: number;
  topic: string;
  priority: number;
  fills_gap: string;
  rationale?: string;
};
type CoverageResult = {
  coverage_read: { summary: string; thin_areas?: Array<{ topic?: string; age_band?: string; note: string }> };
  proposals: Proposal[];
};

async function loadCoverageAuditPromptRow(): Promise<CoverageAuditPromptRow> {
  const { data, error } = await db
    .from("prompts")
    .select("id, system_message, output_schema, model, temperature, max_tokens")
    .eq("prompt_type", "coverage_audit")
    .eq("is_active", true)
    .single();
  if (error || !data) throw new Error(`No active coverage_audit prompt row found: ${error?.message}`);
  const row = data as CoverageAuditPromptRow;
  if (!row.system_message) throw new Error("coverage_audit prompt row has no system_message");
  if (!row.output_schema) throw new Error("coverage_audit prompt row has no output_schema");
  if (!row.model) throw new Error("coverage_audit prompt row has no model");
  return row;
}

// Bare section headers + data; all instructional content lives in system_message (the DB
// prompt row), same discipline as generateLessons.
function buildUserMessage(opts: {
  trackName: string;
  trackDescription: string;
  minAge: number;
  maxAge: number;
  topicNames: string[];
  existing: unknown[];
}): string {
  const parts: string[] = [];
  parts.push(
    `TRACK\n` +
    `Name: ${opts.trackName}\n` +
    `Description: ${opts.trackDescription}\n` +
    `Age span to cover: ${opts.minAge}–${opts.maxAge} months`
  );
  parts.push(`AVAILABLE TOPICS\n${opts.topicNames.join("\n")}`);
  if (opts.existing.length > 0) {
    parts.push(
      `EXISTING LESSONS IN THIS TRACK — map coverage across subtopic AND age band, then propose ` +
      `ONLY gap-fillers; do not duplicate or closely overlap these:\n${JSON.stringify(opts.existing, null, 2)}`
    );
  } else {
    parts.push(`EXISTING LESSONS IN THIS TRACK\nNone yet — the audit degenerates to full age-aware ideation across the span.`);
  }
  return parts.join("\n\n");
}

export async function coverageAuditHandler(job: Job): Promise<unknown> {
  const { track_id, min_child_age, max_child_age } = job.input as Input;
  if (!track_id) throw new Error("input.track_id is required");

  // Step 1 (VERBATIM from generate_lessons) — track name + description.
  const { data: track, error: trackErr } = await supabase
    .from("tracks").select("track_name, description").eq("id", track_id).single();
  if (trackErr || !track) throw new Error(`Track not found: ${track_id} (${trackErr?.message})`);

  // Topics allow-set — injected verbatim; the accept endpoint resolves against the same set.
  const { data: topics, error: topicsErr } = await supabase
    .from("topics").select("id, name").order("sort_order", { ascending: true });
  if (topicsErr || !topics || topics.length === 0)
    throw new Error(`Failed to load topics: ${topicsErr?.message ?? "none found"}`);
  const topicNameById = new Map(topics.map((t) => [t.id, t.name]));

  // Step 3 (VERBATIM from generate_lessons) — existing lessons for comparison.
  const { data: existing, error: fetchErr } = await supabase
    .from("lessons")
    .select("lesson_name, description, min_child_age, max_child_age, priority, topic_id")
    .eq("track_id", track_id);
  if (fetchErr) throw new Error(`Failed to load existing lessons: ${fetchErr.message}`);
  const existingRows = existing ?? [];
  const existingForPrompt = existingRows.map((l) => ({
    lesson_name: l.lesson_name,
    description: l.description,
    min_child_age: l.min_child_age,
    max_child_age: l.max_child_age,
    priority: l.priority,
    topic: l.topic_id ? topicNameById.get(l.topic_id) ?? null : null,
  }));

  // Age span: DERIVE [min,max] from existing lessons when present; REQUIRE it as input on a
  // zero-lesson track (tracks carry no age range column).
  let minAge: number, maxAge: number;
  const mins = existingRows.map((l) => l.min_child_age).filter((v): v is number => typeof v === "number");
  const maxs = existingRows.map((l) => l.max_child_age).filter((v): v is number => typeof v === "number");
  if (mins.length > 0 && maxs.length > 0) {
    minAge = Math.min(...mins);
    maxAge = Math.max(...maxs);
  } else {
    if (typeof min_child_age !== "number" || typeof max_child_age !== "number") {
      throw new Error(
        "No age span available: the track has no existing lessons with age bounds — supply min_child_age and max_child_age in the job input."
      );
    }
    minAge = min_child_age;
    maxAge = max_child_age;
  }

  // Prompt + LLM (params + schema from the DB row, like generate_lessons).
  const promptRow = await loadCoverageAuditPromptRow();
  const userMessage = buildUserMessage({
    trackName: track.track_name ?? "",
    trackDescription: track.description ?? "",
    minAge,
    maxAge,
    topicNames: topics.map((t) => t.name ?? "").filter(Boolean),
    existing: existingForPrompt,
  });

  const correlationId = randomUUID();
  const client = getLLMClient("openai");
  const llmStart = Date.now();
  const result = await client.generate({
    instructions: promptRow.system_message,
    userPrompt: userMessage,
    rawJsonSchema: promptRow.output_schema,
    model: promptRow.model,
    temperature: promptRow.temperature ?? undefined,
    maxTokens: promptRow.max_tokens ?? undefined,
  });
  await logAiCall({
    correlationId,
    operation: "coverage_audit",
    prompt: formatLlmPrompt(promptRow.system_message, userMessage),
    response: result.raw,
    model: result.model,
    latencyMs: Date.now() - llmStart,
    relatedEntityType: null,
    relatedEntityId: null,
    notes: `track_id: ${track_id}; age_span: ${minAge}-${maxAge}; existing_lessons: ${existingRows.length}`,
  });
  if (result.finishReason === "length" || result.finishReason === "content_filter") {
    throw new Error(
      `OpenAI stopped with finish_reason="${result.finishReason}" for coverage_audit on track ${track_id} — not parseable. Retry the job.`
    );
  }

  let parsed: CoverageResult;
  try {
    parsed = JSON.parse(result.text) as CoverageResult;
  } catch {
    throw new Error(`OpenAI returned non-JSON for coverage_audit.\nRaw: ${result.text}`);
  }

  // Everything the CMS needs for current-vs-proposed side-by-side. WRITES NOTHING — proposals
  // are ephemeral (this result payload) until the human accepts them.
  return {
    track: { id: track_id, name: track.track_name, description: track.description, min_age: minAge, max_age: maxAge },
    age_span_used: { min: minAge, max: maxAge },
    coverage_read: parsed.coverage_read,
    existing_lessons: existingForPrompt, // echoed for the CMS side-by-side
    proposals: parsed.proposals ?? [],
    model: result.model,
  };
}
