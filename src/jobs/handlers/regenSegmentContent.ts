import { randomUUID } from "crypto";
import { supabase } from "../../supabase";
import {
  loadSegmentPromptRowById,
  loadBlock,
  resolveLengthContent,
  composeUserMessage,
  callAndParseCards,
} from "./generateSegmentContent";
import { generateQuiz } from "./generateQuiz";
import { purgeImagesForSubSegments } from "../../storage/purgeImages";
import { loadPromptBanInstruction } from "../../lib/voiceLint";
import type { SizeNumbers } from "../../lib/sizeProfile";
import type { Job } from "../registry";

type Scope = "whole_segment" | "single_card";

type Input = {
  seg_id: string;
  tone_id: string;  // prompts.id of the segment tone (stable; not the display name)
  scope: Scope;
  card_id?: string; // required when scope = "single_card"
  generate_quiz?: boolean; // if true, also regenerate the quiz (replaces existing)
  guidance?: string; // author feedback (e.g. from a rejection) — injected into the
                     // prompt to STEER this regen (content, and the quiz if regenerated)
  // Per-run prompt overrides (this regeneration only — the prompts row and
  // prompt_blocks are NEVER written). Each layer falls back to the DB default
  // when absent or empty/whitespace. system_message is intentionally NOT
  // overridable; output_schema is never touched (the card contract).
  overrides?: {
    scope?: string;
    tone?: string;
    structure?: string;          // explicit prose for ## Structure; wins over block swap
    structure_block_id?: string; // swap to a different structure block for this run
    length?: string;            // explicit prose for ## Length; wins over size if set
    size_profile_id?: string;   // swap to a different size profile for this run
    size?: SizeNumbers;         // inline numeric tweaks merged over the base profile
  };
};

type SubSegmentRow = {
  id: string;
  title: string;
  content: string;
  sequence: number;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function regenSegmentContentHandler(job: Job): Promise<unknown> {
  const { seg_id, tone_id, scope, card_id, overrides, guidance, generate_quiz: alsoGenerateQuiz = false } = job.input as Input;
  if (!seg_id)  throw new Error("input.seg_id is required");
  if (!tone_id) throw new Error("input.tone_id is required");
  if (!scope)   throw new Error("input.scope is required (whole_segment | single_card)");
  if (scope === "single_card" && !card_id) {
    throw new Error("input.card_id is required for scope=single_card");
  }

  const correlationId = randomUUID();

  // Step 1 — load segment + lesson; check publish gate
  const { data: segment, error: segErr } = await supabase
    .from("segments")
    .select("id, segment_name, description, lesson_id, seg_status, approved_by")
    .eq("id", seg_id)
    .single();
  if (segErr || !segment) throw new Error(`Segment not found: ${seg_id}`);
  if (!segment.lesson_id) throw new Error(`Segment ${seg_id} has no lesson_id`);

  const { data: lesson, error: lessonErr } = await supabase
    .from("lessons")
    .select("id, lesson_name, is_published")
    .eq("id", segment.lesson_id)
    .single();
  if (lessonErr || !lesson) throw new Error(`Lesson not found for segment ${seg_id}`);

  // Hard block: never regen a published lesson's content
  if (lesson.is_published) {
    throw new Error(
      `Cannot regenerate content for a published lesson ("${lesson.lesson_name}"). ` +
      `Unpublish the lesson first, then retry.`
    );
  }

  // Step 2 — load all current sub_segments (needed for neighbor context + delete targets)
  const { data: allCards, error: cardsErr } = await supabase
    .from("sub_segments")
    .select("id, title, content, sequence")
    .eq("seg_id", seg_id)
    .order("sequence", { ascending: true });
  if (cardsErr) throw new Error(`Failed to load sub_segments for seg ${seg_id}: ${cardsErr.message}`);

  const existingCards = (allCards ?? []) as SubSegmentRow[];

  // For single_card: locate target and resolve neighbors
  let targetCard: SubSegmentRow | undefined;
  if (scope === "single_card") {
    targetCard = existingCards.find((c) => c.id === card_id);
    if (!targetCard) {
      throw new Error(`card_id ${card_id} not found in segment ${seg_id}`);
    }
  }

  // Step 3 — load prompt row + blocks, then apply any per-run overrides.
  // An override applies only when non-empty (empty/whitespace falls back to the
  // DB default). system_message is never overridable; output_schema is untouched.
  const promptRow = await loadSegmentPromptRowById(tone_id);
  const ov = (v?: string): string | undefined => (v && v.trim() ? v : undefined);

  const systemMessage    = promptRow.system_message;
  const scopeText        = ov(overrides?.scope)     ?? promptRow.scope;
  const toneContent      = ov(overrides?.tone)      ?? await loadBlock(promptRow.tone_block_id, "tone");
  // Structure precedence: explicit prose override > block swap > tone's default block.
  const structureContent = ov(overrides?.structure)
    ?? await loadBlock(ov(overrides?.structure_block_id) ?? promptRow.structure_block_id, "structure");
  // Length precedence: explicit prose override > size override (profile/inline) >
  // tone's default size profile > legacy length block.
  const lengthContent    = ov(overrides?.length)
    ?? await resolveLengthContent(promptRow, {
         profileId: ov(overrides?.size_profile_id),
         inline: overrides?.size,
       });

  const overridesApplied: string[] = (["scope", "tone", "structure", "length"] as const)
    .filter((k) => ov(overrides?.[k]));
  if (ov(overrides?.structure_block_id)) overridesApplied.push("structure_block_id");
  if (ov(overrides?.size_profile_id)) overridesApplied.push("size_profile_id");
  if (overrides?.size && Object.keys(overrides.size).length > 0) overridesApplied.push("size");

  // Step 4 — compose prompts (single_card adds neighbor context)
  const userMessage = composeUserMessage({
    scope:              scopeText,
    toneContent,
    structureContent,
    lengthContent,
    lessonTitle:        lesson.lesson_name ?? "",
    segmentName:        segment.segment_name ?? "",
    segmentDescription: segment.description ?? null,
    avoid:              await loadPromptBanInstruction(),
    guidance,
    regenTarget: scope === "single_card" && targetCard ? {
      sequence:   targetCard.sequence,
      totalCards: existingCards.length,
      oldTitle:   targetCard.title,
      prevCard:   existingCards.find((c) => c.sequence === targetCard!.sequence - 1) ?? null,
      nextCard:   existingCards.find((c) => c.sequence === targetCard!.sequence + 1) ?? null,
    } : undefined,
  });

  // Step 5 — GENERATE FIRST. Only destroy after holding a valid result.
  const logEntityType = scope === "single_card" ? "sub_segment" as const : "segment" as const;
  const logEntityId   = scope === "single_card" ? card_id! : seg_id;

  const { cards, model, finishReason, lint } = await callAndParseCards({
    systemMessage,
    userMessage,
    promptRow,
    correlationId,
    operation:         "segment_content_regen",
    relatedEntityType: logEntityType,
    relatedEntityId:   logEntityId,
    notes:             `scope: ${scope}, tone: ${promptRow.tone ?? tone_id} (${tone_id}), overrides: [${overridesApplied.join(", ") || "none"}]`,
  });

  // Post-parse validation: single_card must produce exactly 1 card
  if (scope === "single_card" && cards.length !== 1) {
    throw new Error(
      `single_card regen expected exactly 1 card, got ${cards.length}. ` +
      `Existing content is intact. Retry the job.`
    );
  }

  // -------------------------------------------------------------------------
  // Valid replacement is in hand. Safe to destroy old content now.
  // content_images.sub_segment_id is ON DELETE CASCADE — images die with cards.
  // -------------------------------------------------------------------------

  if (scope === "whole_segment") {
    // Purge the old cards' images (storage + image_assets + content_images) before the
    // cascade drops the rows — otherwise the files orphan as bloat.
    await purgeImagesForSubSegments(existingCards.map((c) => c.id));
    // Delete all sub_segments for this segment
    const { error: deleteErr } = await supabase
      .from("sub_segments")
      .delete()
      .eq("seg_id", seg_id);
    if (deleteErr) {
      throw new Error(`Failed to delete sub_segments for seg ${seg_id}: ${deleteErr.message}`);
    }

    const rowsToInsert = cards.map((card, i) => ({
      seg_id,
      title:    card.title,
      content:  card.content,
      sequence: i + 1,
    }));

    const { data: inserted, error: insertErr } = await supabase
      .from("sub_segments")
      .insert(rowsToInsert)
      .select("id, title, sequence");
    if (insertErr || !inserted) {
      throw new Error(`Failed to insert new sub_segments for seg ${seg_id}: ${insertErr?.message}`);
    }

    // Reset content-approval: the new content is un-reviewed
    await supabase
      .from("segments")
      .update({ seg_status: "pending", approved_by: null })
      .eq("id", seg_id);

    // Optional: regenerate the quiz (replaces existing), sharing the correlationId.
    const quizResult = alsoGenerateQuiz
      ? await generateQuiz({ seg_id, correlationId, isRegen: true, guidance })
      : null;

    return {
      scope,
      seg_id,
      sub_segments_inserted: inserted.length,
      sub_segment_ids:       inserted.map((r) => r.id),
      approval_reset:        true,
      overrides_applied:     overridesApplied,
      lint,
      model,
      finish_reason:         finishReason,
      ...(quizResult && { quiz: quizResult }),
    };
  }

  // scope === "single_card"
  // Replace the target card in-place; sequence and all other cards untouched.
  const newCard = cards[0];

  // Cascade only fires on DELETE, not UPDATE — this card is UPDATED in place, so purge
  // its images explicitly (storage + image_assets + content_images + clears the live
  // pointer). The card's new content won't match the old image.
  await purgeImagesForSubSegments([card_id!]);

  const { error: updateErr } = await supabase
    .from("sub_segments")
    .update({ title: newCard.title, content: newCard.content })
    .eq("id", card_id!);
  if (updateErr) {
    throw new Error(`Failed to update sub_segment ${card_id}: ${updateErr.message}`);
  }

  // Reset content-approval for the segment
  await supabase
    .from("segments")
    .update({ seg_status: "pending", approved_by: null })
    .eq("id", seg_id);

  // Optional: regenerate the quiz (replaces existing), sharing the correlationId.
  const quizResult = alsoGenerateQuiz
    ? await generateQuiz({ seg_id, correlationId, isRegen: true, guidance })
    : null;

  return {
    scope,
    seg_id,
    card_id,
    card_sequence:     targetCard!.sequence,
    approval_reset:    true,
    overrides_applied: overridesApplied,
    lint,
    model,
    finish_reason:     finishReason,
    ...(quizResult && { quiz: quizResult }),
  };
}
