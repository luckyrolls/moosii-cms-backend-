import type { Request } from "express";
import { supabase } from "../supabase";

export type ApprovalEntityType = "segment" | "image" | "quiz" | "questionnaire" | "lesson";
export type ApprovalAction = "approve" | "unapprove" | "publish" | "unpublish";

// Append ONE content_approvals row (migration 043) for an approve/unapprove/publish/
// unpublish transition. The actor is ALWAYS taken from the verified JWT (req.user) —
// this signature has NO approver parameter, so a client-supplied approver in the request
// body CANNOT reach the audit (the point: the CMS historically even sent an email into a
// uuid column). Append-only: only ever INSERTs. Logging failure must NOT break the approve
// action, so every error is caught here (mirrors logAiCall). Callers AWAIT it so the row
// is durable before the response returns.
export async function logApproval(
  entityType: ApprovalEntityType,
  entityId: string,
  action: ApprovalAction,
  req: Request
): Promise<void> {
  try {
    const actorId = req.user?.id;
    if (!actorId) {
      // Should never happen behind jwtAuthMiddleware; fail loud in logs, never block.
      console.warn(`[approval-log] no JWT actor on ${action} ${entityType}:${entityId}; row skipped`);
      return;
    }
    // content_approvals postdates database.types.ts — untyped bridge for this insert.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("content_approvals").insert({
      entity_type: entityType,
      entity_id: entityId,
      action,
      actor_id: actorId,
      actor_role: req.user?.role ?? null,
    });
    if (error) {
      console.error(`[approval-log] insert failed (${action} ${entityType}:${entityId}): ${error.message}`);
    }
  } catch (e) {
    console.error(`[approval-log] unexpected error: ${e instanceof Error ? e.message : String(e)}`);
  }
}
