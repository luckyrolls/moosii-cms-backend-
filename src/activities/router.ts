import { Router, type Request, type Response } from "express";
import { apiError } from "../lib/errors";
import { isUuid } from "../facts/validate";
import { toRecent, recentSince, type RecentRaw } from "./recent";

// Activity follow-ups — app-facing routes (api-contract.md §10). Built by a FACTORY so tests mount them over real HTTP
// with fake deps + a fake token check; the real wiring is src/routes/activities.ts.
//
// Auth: the END-USER's Supabase JWT; the user id comes from the verified token, never the body (invariant 7), and every
// call is scoped to that user's own rows. Each write is ONE database transaction — a SQL function (migration 113):
// activity_finish / activity_followup_answer. Follow-ups are their own surface, never part of user_mlp.

export const FINISH_CHOICES = ["did_it", "later", "not_for_me"] as const;
export const ANSWERS = ["did_it", "not_yet"] as const;
export type FinishChoice = (typeof FINISH_CHOICES)[number];
export type Answer = (typeof ANSWERS)[number];

export type VerifyUser = (token: string) => Promise<
  { ok: true; userId: string } | { ok: false; status: number; code: string; message: string }
>;

export type ActivitiesDeps = {
  finish(userId: string, lessonId: string, choice: FinishChoice): Promise<unknown>;
  answer(userId: string, followupId: string, answer: Answer): Promise<unknown>;
  listDue(userId: string): Promise<unknown[]>;
  // The caller's committed follow-ups plus those resolved at or after `sinceIso` (shaped by toRecent).
  listRecent(userId: string, sinceIso: string): Promise<RecentRaw[]>;
};

// The SQL functions RAISE 'activity:<code>: <message>'; the code picks the status. A missing "user" profile surfaces as
// the completed_items user FK (23503). Anything else is a 500.
const STATUS: Record<string, number> = {
  invalid_choice: 400, invalid_answer: 400, not_activity: 400, no_followup_configured: 400,
  lesson_not_found: 404, followup_not_found: 404, not_committed: 409, followup_lapsed: 409,
};

export class ActivityDbError extends Error {
  constructor(public pgCode: string | undefined, message: string) {
    super(message);
    this.name = "ActivityDbError";
  }
}

export function mapActivityError(e: unknown): { status: number; code: string; message: string } {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /activity:([a-z_]+):\s*([\s\S]*)$/.exec(msg);
  if (m && STATUS[m[1]]) return { status: STATUS[m[1]], code: m[1], message: m[2].trim() };
  if (e instanceof ActivityDbError && e.pgCode === "23503") {
    return { status: 404, code: "unknown_user", message: "the signed-in user has no profile row" };
  }
  return { status: 500, code: "activity_failed", message: msg };
}

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

export function createActivitiesRouters(opts: { verifyUser: VerifyUser; deps: ActivitiesDeps; now?: () => Date }): { activities: Router; followups: Router } {
  const now = opts.now ?? (() => new Date());
  async function authed(req: Request, res: Response): Promise<string | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      apiError(res, 401, "unauthorized", "Missing or malformed Authorization header");
      return null;
    }
    const v = await opts.verifyUser(header.slice("Bearer ".length));
    if (!v.ok) {
      apiError(res, v.status, v.code, v.message);
      return null;
    }
    return v.userId;
  }

  const activities = Router();
  // POST /activities/:lessonId/finish { choice } — the end card.
  activities.post("/:lessonId/finish", async (req: Request, res: Response): Promise<void> => {
    const userId = await authed(req, res);
    if (!userId) return;
    const lessonId = req.params.lessonId;
    const choice: unknown = req.body?.choice;
    if (!isUuid(lessonId)) { apiError(res, 400, "invalid_request", "lessonId must be a uuid"); return; }
    if (!isOneOf(FINISH_CHOICES, choice)) {
      apiError(res, 400, "invalid_choice", `choice must be one of ${FINISH_CHOICES.join(", ")}`);
      return;
    }
    try {
      res.json(await opts.deps.finish(userId, lessonId, choice));
    } catch (e) {
      const m = mapActivityError(e);
      if (m.status === 500) console.error(`[activities] finish failed user=${userId} lesson=${lessonId}: ${m.message}`);
      apiError(res, m.status, m.code, m.message);
    }
  });

  const followups = Router();
  // GET /activity-followups/due — the caller's due follow-ups (the view; never user_mlp).
  followups.get("/due", async (req: Request, res: Response): Promise<void> => {
    const userId = await authed(req, res);
    if (!userId) return;
    try {
      res.json({ followups: await opts.deps.listDue(userId) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[activities] due failed user=${userId}: ${msg}`);
      apiError(res, 500, "activity_failed", msg);
    }
  });
  // GET /activity-followups/recent — committed rows (due or not) + rows resolved in the last 14 days, newest first,
  // with the resolving fact's provenance (verified_source). Own rows only.
  followups.get("/recent", async (req: Request, res: Response): Promise<void> => {
    const userId = await authed(req, res);
    if (!userId) return;
    try {
      const at = now();
      res.json({ followups: toRecent(await opts.deps.listRecent(userId, recentSince(at)), at) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[activities] recent failed user=${userId}: ${msg}`);
      apiError(res, 500, "activity_failed", msg);
    }
  });
  // POST /activity-followups/:id/answer { answer } — the follow-up prompt.
  followups.post("/:id/answer", async (req: Request, res: Response): Promise<void> => {
    const userId = await authed(req, res);
    if (!userId) return;
    const id = req.params.id;
    const answer: unknown = req.body?.answer;
    if (!isUuid(id)) { apiError(res, 400, "invalid_request", "id must be a uuid"); return; }
    if (!isOneOf(ANSWERS, answer)) {
      apiError(res, 400, "invalid_answer", `answer must be one of ${ANSWERS.join(", ")}`);
      return;
    }
    try {
      res.json(await opts.deps.answer(userId, id, answer));
    } catch (e) {
      const m = mapActivityError(e);
      if (m.status === 500) console.error(`[activities] answer failed user=${userId} followup=${id}: ${m.message}`);
      apiError(res, m.status, m.code, m.message);
    }
  });

  return { activities, followups };
}
