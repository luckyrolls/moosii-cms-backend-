import { supabase } from "../supabase";
import type { Database } from "../types/database.types";
import { ActivityDbError, type ActivitiesDeps } from "./router";
import type { RecentRaw } from "./recent";

// Real deps for the activity follow-up routes and the recordFacts hook: the service-role client calling migration 113's
// SQL functions (EXECUTE service_role only). Each call is one transaction inside Postgres.

type Fn = "activity_finish" | "activity_followup_answer" | "resolve_activity_followups";

async function rpc<F extends Fn>(fn: F, args: Database["public"]["Functions"][F]["Args"]): Promise<unknown> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new ActivityDbError(error.code, error.message);
  return data;
}

export const activitiesDbDeps: ActivitiesDeps = {
  finish: (userId, lessonId, choice) => rpc("activity_finish", { p_user: userId, p_lesson: lessonId, p_choice: choice }),
  answer: (userId, followupId, answer) => rpc("activity_followup_answer", { p_user: userId, p_followup: followupId, p_answer: answer }),
  async listDue(userId) {
    const { data, error } = await supabase
      .from("user_activity_followups_due")
      .select("id, lesson_id, lesson_name, lesson_description, asks, max_asks, due_at, committed_at, lapses_at")
      .eq("user_id", userId)
      .order("due_at", { ascending: true });
    if (error) throw new ActivityDbError(error.code, error.message);
    return data ?? [];
  },
  async listRecent(userId, sinceIso) {
    const { data, error } = await supabase
      .from("user_activity_followups")
      .select("id, lesson_id, status, asks, due_at, committed_at, resolved_at, resolved_by, verified_at, created_at, " +
              "lesson:lessons!user_activity_followups_lesson_id_fkey(lesson_name), " +
              "fact:user_facts!user_activity_followups_verified_fact_id_fkey(source, source_ref)")
      .eq("user_id", userId)
      .or(`status.eq.committed,resolved_at.gte.${sinceIso}`);
    if (error) throw new ActivityDbError(error.code, error.message);
    return (data ?? []) as unknown as RecentRaw[];
  },
};

// recordFacts hook: verify the user's follow-ups against the facts just written.
export async function resolveActivityFollowups(userId: string): Promise<{ resolved: number }> {
  const out = await rpc("resolve_activity_followups", { p_user: userId });
  return { resolved: Array.isArray(out) ? out.length : 0 };
}
