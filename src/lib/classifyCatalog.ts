import { createHash } from "crypto";
import { supabase } from "../supabase";

// tracks/questionnaire tables + the §7 view aren't in database.types.ts. Untyped bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// The classifier reads the track catalog ONLY through assembleCatalog(), so a later
// swap from "whole catalog" to a filtered candidate set is a one-function change.
// Track DESCRIPTIONS are load-bearing (§2j). Routing lives in questionnaire_response,
// read via the questionnaire_response_with_track_tag view (§7) — NOT the legacy
// lessons.*_questionnaire_score_range columns.

export type CatalogRoute = {
  questionnaire_id: string;
  questionnaire_name: string | null;
  questions: string[];
  score_range: { min: number | null; max: number | null };
};

export type CatalogTrack = {
  id: string;
  name: string | null;
  description: string | null;
  routes_via: CatalogRoute[];
};

export type Catalog = {
  catalog_version: string;   // content hash — provenance
  track_count: number;
  tracks: CatalogTrack[];
};

export async function assembleCatalog(): Promise<Catalog> {
  // 1. every track
  const { data: tracks, error: tErr } = await db
    .from("tracks").select("id, track_name, description").order("track_name");
  if (tErr) throw new Error(`Failed to load tracks: ${tErr.message}`);

  // 2. add-track routing rules (the §7 view)
  const { data: routes, error: rErr } = await db
    .from("questionnaire_response_with_track_tag")
    .select("track_id, questionnaire_id, score_min_range, score_max_range")
    .eq("add", true)
    .eq("item_type", "track");
  if (rErr) throw new Error(`Failed to load routing rules: ${rErr.message}`);

  const qIds = [...new Set((routes ?? []).map((r: any) => r.questionnaire_id).filter(Boolean))];

  // 3. questionnaire names + 4. their questions (only the referenced ones)
  const nameById = new Map<string, string | null>();
  const questionsById = new Map<string, string[]>();
  if (qIds.length > 0) {
    const [{ data: qs }, { data: questions }] = await Promise.all([
      db.from("questionnaire").select("id, questionnaire_name").in("id", qIds),
      db.from("questionnaire_questions").select("questionnaire_id, question_text").in("questionnaire_id", qIds),
    ]);
    for (const q of qs ?? []) nameById.set(q.id, q.questionnaire_name);
    for (const q of questions ?? []) {
      const arr = questionsById.get(q.questionnaire_id) ?? [];
      if (q.question_text) arr.push(q.question_text);
      questionsById.set(q.questionnaire_id, arr);
    }
  }

  const routesByTrack = new Map<string, CatalogRoute[]>();
  for (const r of routes ?? []) {
    const arr = routesByTrack.get(r.track_id) ?? [];
    arr.push({
      questionnaire_id:   r.questionnaire_id,
      questionnaire_name: nameById.get(r.questionnaire_id) ?? null,
      questions:          questionsById.get(r.questionnaire_id) ?? [],
      score_range:        { min: r.score_min_range ?? null, max: r.score_max_range ?? null },
    });
    routesByTrack.set(r.track_id, arr);
  }

  const catalogTracks: CatalogTrack[] = (tracks ?? []).map((t: any) => ({
    id:          t.id,
    name:        t.track_name,
    description: t.description,
    routes_via:  routesByTrack.get(t.id) ?? [],
  }));

  // content hash over the load-bearing fields (deterministic → stable version)
  const canonical = JSON.stringify(
    catalogTracks.map((t) => ({ id: t.id, name: t.name, description: t.description, routes: t.routes_via }))
  );
  const catalog_version = createHash("sha256").update(canonical).digest("hex").slice(0, 12);

  return { catalog_version, track_count: catalogTracks.length, tracks: catalogTracks };
}

// Compact rendering fed to the model: it may only pick track_id values from here.
export function renderCatalogForPrompt(catalog: Catalog): string {
  const lines = catalog.tracks.map((t) => {
    let block = `[${t.id}] ${t.name ?? "(unnamed)"} — ${t.description ?? "(no description)"}`;
    if (t.routes_via.length > 0) {
      const qs = t.routes_via.flatMap((r) => r.questions).map((q) => `"${q}"`).join(" | ");
      if (qs) block += `\n  routes via: ${qs}`;
    }
    return block;
  });
  return `TRACKS — you may propose ONLY track_id values from this list:\n\n${lines.join("\n")}`;
}
