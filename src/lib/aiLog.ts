import { supabase } from "../supabase";

export type AiLogInput = {
  correlationId: string;
  operation: string;
  prompt: string;
  response: unknown;
  model?: string;
  latencyMs?: number;
  relatedEntityType?: "lesson" | "segment" | "sub_segment" | "content_image" | "questionnaire" | null;
  relatedEntityId?: string | null;
  notes?: string | null;
  // Resolved prompt_block IDs used in composition (IDs only), e.g.
  // { tone, structure, length, card_positions } → stored in the ai_generation_log.blocks
  // jsonb column.
  blocks?: Record<string, string | null>;
};

// Never throws — logging failure must not break generation.
export async function logAiCall(input: AiLogInput): Promise<void> {
  try {
    // `blocks` jsonb column postdates database.types.ts — untyped bridge for this insert.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("ai_generation_log").insert({
      correlation_id:      input.correlationId,
      operation:           input.operation,
      prompt:              input.prompt,
      response:            input.response,
      model:               input.model ?? null,
      latency_ms:          input.latencyMs ?? null,
      related_entity_type: input.relatedEntityType ?? null,
      related_entity_id:   input.relatedEntityId ?? null,
      notes:               input.notes ?? null,
      blocks:              input.blocks ?? null,
    });
    if (error) console.error("[aiLog] Failed to log AI call:", error.message);
  } catch (err) {
    console.error("[aiLog] Unexpected error logging AI call:", err);
  }
}

// Formats the two-part LLM prompt (instructions + userPrompt) into a single
// text field that accurately reflects what the model received.
export function formatLlmPrompt(instructions: string, userPrompt: string): string {
  return `[SYSTEM]\n${instructions}\n\n[USER]\n${userPrompt}`;
}
