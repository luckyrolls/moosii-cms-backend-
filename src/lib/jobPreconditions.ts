import { supabase } from "../supabase";
import { regenApprovedImageBlock } from "./approvalSafety";

// ---------------------------------------------------------------------------
// Slice A1 — type-aware preconditions for POST /jobs.
//
// WHY HERE AND NOT IN THE HANDLER. A handler can only FAIL a job that already exists: the
// CMS gets a 202 and a job_id, then has to poll to discover its regenerate was refused. A
// precondition runs before `createJob`, so the refusal is the HTTP response — which is what
// the CMS can put in front of the editor. The handler keeps its own check as a second line of
// defence (a job row created any other way still refuses).
//
// Everything here is a READ. The pure decisions live in src/lib/approvalSafety.ts.
// ---------------------------------------------------------------------------

export type Precondition =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

type RegenInput = {
  seg_id?: string;
  scope?: "whole_segment" | "single_card";
  card_id?: string;
};

/** Card ids in this segment that hold an `approved` content_images row. */
export async function approvedImageCardIds(segId: string): Promise<string[]> {
  const { data: cards, error: cErr } = await supabase
    .from("sub_segments").select("id").eq("seg_id", segId);
  if (cErr) throw new Error(`Failed to load cards for segment ${segId}: ${cErr.message}`);
  const ids = (cards ?? []).map((c) => c.id);
  if (ids.length === 0) return [];

  const { data: imgs, error: iErr } = await supabase
    .from("content_images").select("sub_segment_id")
    .in("sub_segment_id", ids).eq("status", "approved");
  if (iErr) throw new Error(`Failed to load approved images for segment ${segId}: ${iErr.message}`);
  return [...new Set((imgs ?? []).map((i) => i.sub_segment_id).filter((x): x is string => !!x))];
}

/** Injected so the refusal is unit-testable without a database (the route test's stub origin
 *  cannot answer a query, so a DB-reading branch would only ever produce a 500 there). */
export type PreconditionDeps = { approvedImageCardIds: (segId: string) => Promise<string[]> };
const realDeps: PreconditionDeps = { approvedImageCardIds };

export async function checkJobPrecondition(
  type: string,
  input: Record<string, unknown>,
  deps: PreconditionDeps = realDeps
): Promise<Precondition> {
  // --- the batch: include_approved is gone -------------------------------------------
  if (type === "generate_track_content" && input.include_approved) {
    return {
      ok: false,
      status: 400,
      code: "include_approved_removed",
      message:
        "include_approved was removed: a batch never overwrites approved content or approved " +
        "images. Unapprove the segments you really mean to replace, then re-run.",
    };
  }

  // --- single-segment content (re)generation: never destroy an approved image ---------
  // BOTH job types, because both delete every card in scope and purge its images first:
  // generate_segment_content at generateSegmentContent.ts:314-318 and regen_segment_content
  // (whole_segment) at regenSegmentContent.ts:220-242 / (single_card) at :276.
  if (type === "regen_segment_content" || type === "generate_segment_content") {
    const { seg_id, scope, card_id } = input as RegenInput;
    if (!seg_id) return { ok: true };   // the handler validates required input; not our job

    // generate_segment_content has no scope: it always replaces the whole segment.
    const effectiveScope = type === "generate_segment_content" ? "whole_segment" : (scope ?? "whole_segment");

    const block = regenApprovedImageBlock({
      scope: effectiveScope,
      card_id: card_id ?? null,
      approvedImageCardIds: await deps.approvedImageCardIds(seg_id),
    });
    if (block) {
      const which = effectiveScope === "single_card" ? "this card" : `${block.count} card(s) in this segment`;
      return {
        ok: false,
        status: 409,
        code: "segment_has_approved_images",
        message:
          `Refused: ${which} carry an approved image, and regenerating content deletes the ` +
          `cards and purges their images — the approved picture would be destroyed and cannot ` +
          `be recovered. Unapprove or reject those images first. Cards: ${block.card_ids.join(", ")}.`,
      };
    }
  }

  return { ok: true };
}
