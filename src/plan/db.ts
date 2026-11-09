import { supabase } from "../supabase";
import type { PlanDeps } from "./router";
import type { PlanItemRaw, ReasonRaw } from "./shape";

// Real deps for GET /plan: the persisted plan (user_mlp, as the rebuild left it) and the reason rows
// (user_track_reasons_for_user, migration 119 — service-role EXECUTE only, so it has to be called from here and
// cannot be assembled client-side: user_track_activations is RLS-on with no policy).

export const planDbDeps: PlanDeps = {
  async listPlan(userId: string): Promise<PlanItemRaw[]> {
    const { data, error } = await supabase
      .from("user_mlp")
      .select("item_id, item_type, position, item_name, item_description, with_quiz, track_id, track_name, updated_at")
      .eq("user_id", userId)
      .order("position", { ascending: true, nullsFirst: false });
    if (error) throw new Error(`user_mlp query failed: ${error.message}`);
    return (data ?? []) as unknown as PlanItemRaw[];
  },

  async listReasons(userId: string): Promise<ReasonRaw[]> {
    // The function is new in 119; until it is applied the call errors and the route 500s — hence the
    // migration-before-code rule for this slice (api-contract §11).
    const { data, error } = await (supabase as any).rpc("user_track_reasons_for_user", { p_user_id: userId });
    if (error) throw new Error(`user_track_reasons_for_user rpc failed: ${error.message}`);
    return (data ?? []) as ReasonRaw[];
  },
};
