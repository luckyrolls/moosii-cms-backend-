import { Router, type Request, type Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { DOMAIN } from "../lib/domain";
import { supabase } from "../supabase";
import { apiError } from "../lib/errors";
import { createDemoSession, FixedWindowLimiter, type DemoDeps } from "../demo/session";
import { getDemoOutcomes, pickDemoCode, type OutcomesDeps } from "../demo/outcomes";
import {
  demoGate, isRefusal, summarizeSpending, spendingWindowStart, insightsFromFacts, allowedWidgetType,
  WIDGET_ALLOWLIST, type GateDeps, type CurrentFact,
} from "../demo/partner";
import { MxProvider, MxError } from "../facts/derive/mxProvider";

// POST /demo/session — demo persona sign-in for the financial reader (api-contract §9).
// GET  /demo/outcomes — Beat 6 outcome history, real + seeded points (api-contract §9b).
// GET  /demo/partner-data, /demo/mx-widget-url — partner page data (api-contract §9c); authed by the DEMO SESSION.
// Mounted bare in index.ts: the access code / demo session is the gate, not the admin JWT gate.
// CORS: the reader origin must be in ALLOWED_ORIGINS.

const limiter = new FixedWindowLimiter(10, 60_000);           // 10 sign-ins per IP per minute
const outcomesLimiter = new FixedWindowLimiter(10, 60_000);   // 10 outcome reads per IP per minute
const partnerLimiter = new FixedWindowLimiter(30, 60_000);    // 30 partner-data reads per IP per minute
const widgetLimiter = new FixedWindowLimiter(10, 60_000);     // 10 widget URLs per IP per minute

// Every auth user flagged with app_metadata.demo_persona (service role; users can't set it).
async function listDemoUsers(): Promise<{ id: string; email: string | undefined; persona: string }[]> {
  const out: { id: string; email: string | undefined; persona: string }[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    for (const u of data.users) {
      const persona = (u.app_metadata as Record<string, unknown> | undefined)?.demo_persona;
      if (typeof persona === "string" && persona) out.push({ id: u.id, email: u.email, persona });
    }
    if (data.users.length < 1000) break;
  }
  return out;
}

const deps: DemoDeps = {
  domain: DOMAIN,
  get accessCode() { return process.env.DEMO_ACCESS_CODE; },
  limiter,
  async findByPersona(persona) {
    return (await listDemoUsers())
      .filter((u) => u.persona === persona && u.email)
      .map((u) => ({ id: u.id, email: u.email as string }));
  },
  async mintSession(email) {
    const { data, error } = await supabase.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = data?.properties?.hashed_token;
    if (error || !tokenHash) throw new Error(`generateLink failed: ${error?.message ?? "no hashed_token"}`);
    // verifyOtp stores the session ON THE CLIENT THAT CALLS IT. The shared `supabase` client serves every
    // route with the service role, so the session is minted on a THROWAWAY client that is never reused.
    const throwaway = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const v = await throwaway.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
    const s = v.data?.session;
    if (v.error || !s) throw new Error(`verifyOtp failed: ${v.error?.message ?? "no session"}`);
    return { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at ?? 0 };
  },
};

// demo_outcome_series / demo_outcome_aggregate are financial-only (106), so not in database.types.ts (Moosii).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const outcomesDeps: OutcomesDeps = {
  domain: DOMAIN,
  get accessCode() { return process.env.DEMO_ACCESS_CODE; },
  limiter: outcomesLimiter,
  async listPersonas() {
    return (await listDemoUsers()).map((u) => ({ persona: u.persona, user_id: u.id }));
  },
  async loadFacts(userIds) {
    const { data, error } = await db.from("user_facts")
      .select("user_id, fact_key, value, observed_at, source").in("user_id", userIds);
    if (error) throw new Error(`user_facts read failed: ${error.message}`);
    return data ?? [];
  },
  async loadSeries(userIds) {
    const { data, error } = await db.from("demo_outcome_series")
      .select("user_id, fact_key, value, observed_at, label").in("user_id", userIds);
    if (error) throw new Error(`demo_outcome_series read failed: ${error.message}`);
    return data ?? [];
  },
  async loadAggregate() {
    const { data, error } = await db.from("demo_outcome_aggregate").select("metric, value, label");
    if (error) throw new Error(`demo_outcome_aggregate read failed: ${error.message}`);
    return data ?? [];
  },
};

function clientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.ip || "unknown";
}

const router = Router();

router.post("/session", async (req: Request, res: Response): Promise<void> => {
  const ip = clientIp(req);
  const ipTag = createHash("sha256").update(ip).digest("hex").slice(0, 6);
  try {
    const out = await createDemoSession(req.body, ip, deps);
    if (out.status !== 200) {
      console.warn(`[demo] session refused ${out.status} ${out.code} ip=${ipTag}`);
      apiError(res, out.status, out.code, out.message);
      return;
    }
    console.log(`[demo] session minted persona=${out.body.persona} user=${out.body.user_id} ip=${ipTag}`);
    res.status(200).json(out.body);
  } catch (e) {
    console.error(`[demo] session failed ip=${ipTag}: ${e instanceof Error ? e.message : String(e)}`);
    apiError(res, 500, "demo_session_failed", "could not create a demo session");
  }
});

router.get("/outcomes", async (req: Request, res: Response): Promise<void> => {
  const ip = clientIp(req);
  const ipTag = createHash("sha256").update(ip).digest("hex").slice(0, 6);
  res.set("Cache-Control", "no-store");
  try {
    const out = await getDemoOutcomes(pickDemoCode(req.get("x-demo-code"), req.query.code), ip, outcomesDeps);
    if (out.status !== 200) {
      console.warn(`[demo] outcomes refused ${out.status} ${out.code} ip=${ipTag}`);
      apiError(res, out.status, out.code, out.message);
      return;
    }
    console.log(`[demo] outcomes served personas=${out.body.personas.map((p) => p.persona).join(",")} ip=${ipTag}`);
    res.status(200).json(out.body);
  } catch (e) {
    console.error(`[demo] outcomes failed ip=${ipTag}: ${e instanceof Error ? e.message : String(e)}`);
    apiError(res, 500, "demo_outcomes_failed", "could not load demo outcomes");
  }
});

// ---- partner page (api-contract §9c) ---------------------------------------------------------------------------

function gateDeps(limiter: { allow(key: string): boolean }): GateDeps {
  return {
    domain: DOMAIN,
    limiter,
    async verify(token) {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) return null;
      const persona = (data.user.app_metadata as Record<string, unknown> | undefined)?.demo_persona;
      return { user_id: data.user.id, persona: typeof persona === "string" && persona ? persona : null };
    },
  };
}

router.get("/partner-data", async (req: Request, res: Response): Promise<void> => {
  const ip = clientIp(req);
  const ipTag = createHash("sha256").update(ip).digest("hex").slice(0, 6);
  res.set("Cache-Control", "no-store");
  try {
    const who = await demoGate(req.headers.authorization, ip, gateDeps(partnerLimiter));
    if (isRefusal(who)) {
      console.warn(`[demo] partner-data refused ${who.status} ${who.code} ip=${ipTag}`);
      apiError(res, who.status, who.code, who.message);
      return;
    }

    // Spending: the persona's MX transactions (MX user id = auth uid). No MX user → null, not an error.
    const now = new Date();
    let spending: ReturnType<typeof summarizeSpending> | null = null;
    try {
      const txns = await new MxProvider().getTransactions(who.user_id, spendingWindowStart(now));
      spending = summarizeSpending(txns, now);
    } catch (e) {
      if (!(e instanceof MxError && e.code === "mx_user_not_found")) throw e;
    }

    // Insights: from the persona's CURRENT facts (latest-wins view), provenance per fact.
    const { data: facts, error } = await supabase
      .from("user_facts_latest" as never)
      .select("fact_key, value, source")
      .eq("user_id", who.user_id);
    if (error) throw new Error(`user_facts_latest read failed: ${(error as { message: string }).message}`);
    const insights = insightsFromFacts((facts ?? []) as unknown as CurrentFact[]);

    console.log(`[demo] partner-data persona=${who.persona} spending=${spending ? spending.categories.length + " categories" : "null"} insights=${insights.length} ip=${ipTag}`);
    res.status(200).json({ persona: who.persona, user_id: who.user_id, spending, insights });
  } catch (e) {
    console.error(`[demo] partner-data failed ip=${ipTag}: ${e instanceof Error ? e.message : String(e)}`);
    apiError(res, 500, "demo_partner_data_failed", "could not load partner data");
  }
});

router.get("/mx-widget-url", async (req: Request, res: Response): Promise<void> => {
  const ip = clientIp(req);
  const ipTag = createHash("sha256").update(ip).digest("hex").slice(0, 6);
  res.set("Cache-Control", "no-store");
  try {
    const who = await demoGate(req.headers.authorization, ip, gateDeps(widgetLimiter));
    if (isRefusal(who)) {
      console.warn(`[demo] mx-widget-url refused ${who.status} ${who.code} ip=${ipTag}`);
      apiError(res, who.status, who.code, who.message);
      return;
    }
    const type = allowedWidgetType(req.query.type);
    if (!type) {
      apiError(res, 400, "invalid_widget_type", `type must be one of: ${WIDGET_ALLOWLIST.join(", ")}`);
      return;
    }
    let url: string;
    try {
      url = await new MxProvider().createWidgetUrl(who.user_id, type);
    } catch (e) {
      if (e instanceof MxError && e.code === "mx_user_not_found") {
        console.warn(`[demo] mx-widget-url no MX user persona=${who.persona} ip=${ipTag}`);
        apiError(res, 404, "no_mx_user", "this persona has no MX user");
        return;
      }
      throw e;
    }
    // The URL is a one-time credential: returned, never logged, stored or cached.
    console.log(`[demo] mx-widget-url issued type=${type} persona=${who.persona} ip=${ipTag}`);
    res.status(200).json({ widget_type: type, url, single_use: true, expires_in_seconds: 600 });
  } catch (e) {
    console.error(`[demo] mx-widget-url failed ip=${ipTag}: ${e instanceof Error ? e.message : String(e)}`);
    apiError(res, 502, "mx_widget_url_failed", "could not get a widget URL from MX");
  }
});

export default router;
