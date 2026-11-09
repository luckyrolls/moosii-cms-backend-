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
      .select("item_id, item_type, position, item_name, item_description, with_quiz, track_id, track_name, updated_at, created_at")
      .eq("user_id", userId)
      .order("position", { ascending: true, nullsFirst: false });
    if (error) throw new Error(`user_mlp query failed: ${error.message}`);
    return (data ?? []) as unknown as PlanItemRaw[];
  },

  async listReasons(userId: string): Promise<ReasonRaw[]> {
    // Typed from the Moosii schema once 119 was applied (no `(supabase as any)` bridge). The generator cannot know
    // which OUT columns are nullable, so the row type is narrowed here — label, fact_key, source and the rest are
    // NULL for the reason kinds that do not carry them (api-contract §11).
    const { data, error } = await supabase.rpc("user_track_reasons_for_user", { p_user_id: userId });
    if (error) throw new Error(`user_track_reasons_for_user rpc failed: ${error.message}`);
    return (data ?? []) as unknown as ReasonRaw[];
  },
};
