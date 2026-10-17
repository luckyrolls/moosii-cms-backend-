import { supabase } from "../supabase";
import { ActivityDbError, type ActivitiesDeps } from "./router";

// Real deps for the activity follow-up routes and the recordFacts hook: the service-role client calling migration 113's
// SQL functions (EXECUTE service_role only). Each call is one transaction inside Postgres.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any; // 113's functions + view are not in database.types.ts until the Moosii regen

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new ActivityDbError(error.code, error.message);
  return data;
}

export const activitiesDbDeps: ActivitiesDeps = {
  finish: (userId, lessonId, choice) => rpc("activity_finish", { p_user: userId, p_lesson: lessonId, p_choice: choice }),
  answer: (userId, followupId, answer) => rpc("activity_followup_answer", { p_user: userId, p_followup: followupId, p_answer: answer }),
  async listDue(userId) {
    const { data, error } = await db
      .from("user_activity_followups_due")
      .select("id, lesson_id, lesson_name, lesson_description, asks, max_asks, due_at, committed_at, lapses_at")
      .eq("user_id", userId)
      .order("due_at", { ascending: true });
    if (error) throw new ActivityDbError(error.code, error.message);
    return data ?? [];
  },
};

// recordFacts hook: verify the user's follow-ups against the facts just written.
export async function resolveActivityFollowups(userId: string): Promise<{ resolved: number }> {
  const out = await rpc("resolve_activity_followups", { p_user: userId });
  return { resolved: Array.isArray(out) ? out.length : 0 };
}
