// Migration 128 — catalog modes: the backfill shape, switch_catalog_mode, set_track_group, the
// insert/manual-archive triggers and the same-group rule, against a REAL Postgres.
//
// Needs MOOSIE_TEST_DB_URL → the THROWAWAY LOCAL database from
// docs/drafts/128-catalog-modes/README.md, with 127 + fixture + 128 applied. Without it every
// test SKIPS. Refuses any non-local host. Every test runs inside BEGIN … ROLLBACK, so nothing a
// test does survives it — including the mode switches, which rewrite the whole catalog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const URL_ = process.env.MOOSIE_TEST_DB_URL;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const skip = !URL_ ? "MOOSIE_TEST_DB_URL not set (local 128 test DB)" : false;

const MEM_TRACK = "2076eb8c-4d5b-4b52-86c9-6b22ecc47192";
const LIVE = [1, 2, 3, 4].map((n) => `aaaa0001-0000-4000-8000-00000000000${n}`);
const WAS_ACTIVE = [1, 2, 3].map((n) => `bbbb0002-0000-4000-8000-00000000000${n}`);
const WAS_ARCHIVED = ["cccc0003-0000-4000-8000-000000000002"];
// The join-in: by the id 128 hardcodes. Archived legacy-era content that the backfill pulls into
// mem AND unarchives, because a mem questionnaire points at it (Mark, 2026-11-19, option a).
const JOIN_IN = "056884c8-9fd8-4919-b0a1-4b4126b6979c";
const VISIBLE_IN_MEM = [MEM_TRACK, JOIN_IN].sort();
const MEM_TAG = "dddd0004-0000-4000-8000-000000000001";
const QUESTIONNAIRE = "eeee0005-0000-4000-8000-000000000001";
const RESPONSE = "eeee0005-0000-4000-8000-0000000000a1";
const ACTION = "ffff0006-0000-4000-8000-0000000000b1";

async function tx(fn: (db: Client) => Promise<void>): Promise<void> {
  const host = new URL(URL_!).hostname;
  if (!LOCAL_HOSTS.has(host))
    throw new Error(`MOOSIE_TEST_DB_URL must point at a local throwaway database, not ${host}`);
  const db = new Client({ connectionString: URL_ });
  await db.connect();
  try {
    await db.query("BEGIN");
    await fn(db);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    await db.end();
  }
}

// A raised exception ABORTS the enclosing transaction, so every expected failure runs inside its
// own SAVEPOINT. Without it the next statement fails with 25P02 — an error carrying no HINT,
// which makes a correct refusal look like a missing one. (The 127 harness learned this the hard
// way; same helper.)
async function expectRaise(
  db: Client,
  sql: string,
  params: unknown[],
  want: { code?: string; hint?: string },
  label: string
): Promise<void> {
  const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
  await db.query(`SAVEPOINT ${sp}`);
  let err: any = null;
  try {
    await db.query(sql, params);
  } catch (e) {
    err = e;
  } finally {
    await db.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  }
  assert.ok(err, `${label}: expected a refusal, but the statement succeeded`);
  if (want.code) assert.equal(err.code, want.code, `${label}: wrong SQLSTATE (${err.message})`);
  if (want.hint) assert.equal(err.hint, want.hint, `${label}: wrong HINT (${err.message})`);
}

async function actors(db: Client): Promise<{ superAdmin: string; plainAdmin: string }> {
  const superAdmin = randomUUID();
  const plainAdmin = randomUUID();
  for (const id of [superAdmin, plainAdmin]) {
    await db.query(`INSERT INTO auth.users (id) VALUES ($1)`, [id]);
  }
  await db.query(
    `INSERT INTO public."user" (id, role, daily_reminder_time, moosies, onboarding_complete)
     VALUES ($1, 'super_admin', '09:00', 0, true), ($2, 'admin', '09:00', 0, true)`,
    [superAdmin, plainAdmin]
  );
  return { superAdmin, plainAdmin };
}

type TrackRow = { id: string; test_group: string; archived: boolean; mode_archived: boolean };

async function tracks(db: Client): Promise<Map<string, TrackRow>> {
  const { rows } = await db.query(
    `SELECT id, test_group, (archived_at IS NOT NULL) AS archived, mode_archived FROM public.tracks`
  );
  return new Map(rows.map((r: TrackRow) => [r.id, r]));
}

async function mode(db: Client): Promise<string> {
  const { rows } = await db.query(`SELECT public.current_catalog_mode() AS m`);
  return rows[0].m;
}

const activeIds = (m: Map<string, TrackRow>): string[] =>
  [...m.values()].filter((t) => !t.archived).map((t) => t.id).sort();

// ─────────────────────────────────────────────────────────────── the backfill

test("backfill (moosii): mooselist -> live + mode_archived, the seed -> mem, everything else legacy", { skip }, async () => {
  await tx(async (db) => {
    const t = await tracks(db);

    for (const id of LIVE) {
      assert.equal(t.get(id)!.test_group, "live", `${id} should be live`);
      assert.equal(t.get(id)!.archived, true, "mooselist rows were already archived");
      assert.equal(t.get(id)!.mode_archived, true, "and the switcher now owns that archival");
    }
    assert.equal(t.get(MEM_TRACK)!.test_group, "mem");
    assert.equal(t.get(MEM_TRACK)!.archived, false, "the mem seed stays visible — it is the active mode");
    assert.equal(t.get(MEM_TRACK)!.mode_archived, false);

    for (const id of [...WAS_ACTIVE, ...WAS_ARCHIVED]) {
      assert.equal(t.get(id)!.test_group, "legacy", `${id} should be legacy`);
      assert.equal(t.get(id)!.archived, true, "legacy is always archived");
      assert.equal(t.get(id)!.mode_archived, false, "legacy is NEVER switcher-archived");
    }

    // the join-in: pulled into mem and UNARCHIVED, but NOT switcher-owned — no switch put it
    // away, so no switch may claim it
    assert.equal(t.get(JOIN_IN)!.test_group, "mem", "the join-in joins the group of the questionnaire that points at it");
    assert.equal(t.get(JOIN_IN)!.archived, false, "mem is the active mode, so it is visible");
    assert.equal(t.get(JOIN_IN)!.mode_archived, false);

    assert.equal(await mode(db), "mem");
    assert.deepEqual(activeIds(t), VISIBLE_IN_MEM, "the mem catalog, and nothing else, is visible");
  });
});

test("the backfill archived the formerly-active tracks THROUGH 126's guard, so each is audited", { skip }, async () => {
  await tx(async (db) => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM public.content_approvals
        WHERE entity_type = 'track' AND action = 'archive' AND actor_id IS NULL
          AND actor_role = 'service' AND entity_id = ANY($1)`,
      [WAS_ACTIVE]
    );
    assert.equal(rows[0].n, WAS_ACTIVE.length, "one content_approvals row per newly archived track");

    const { rows: none } = await db.query(
      `SELECT count(*)::int AS n FROM public.content_approvals
        WHERE entity_type = 'track' AND entity_id = ANY($1)`,
      [LIVE]
    );
    assert.equal(rows[0].n > 0 && none[0].n, 0, "mooselist rows kept their archived_at, so no audit row was written");

    // and the join-in's UNARCHIVE is audited by the same guard, as the other direction
    const { rows: un } = await db.query(
      `SELECT count(*)::int AS n FROM public.content_approvals
        WHERE entity_type = 'track' AND action = 'unarchive' AND actor_id IS NULL
          AND actor_role = 'service' AND entity_id = $1`,
      [JOIN_IN]
    );
    assert.equal(un[0].n, 1, "exactly one unarchive row for the join-in");
  });
});

test("the seed switch row records the mode and what it archived", { skip }, async () => {
  await tx(async (db) => {
    const { rows } = await db.query(
      `SELECT mode, previous_mode, actor_id, actor_role, tracks_archived, tracks_unarchived,
              backfill_archived_ids, backfill_unarchived_ids
         FROM public.catalog_mode_switches ORDER BY seq`
    );
    assert.equal(rows.length, 1, "exactly one seed row, even after a re-apply");
    assert.equal(rows[0].mode, "mem");
    assert.equal(rows[0].previous_mode, null);
    assert.equal(rows[0].actor_id, null);
    assert.equal(rows[0].actor_role, "migration");
    assert.equal(rows[0].tracks_archived, WAS_ACTIVE.length);
    assert.equal(rows[0].tracks_unarchived, 1, "the join-in");

    // The ids, not just the counts: this is what the UNDO in 128's header reads, so an empty or
    // approximate list would make the migration irreversible in practice.
    assert.deepEqual([...rows[0].backfill_archived_ids].sort(), [...WAS_ACTIVE].sort());
    assert.deepEqual(rows[0].backfill_unarchived_ids, [JOIN_IN]);
  });
});

// ─────────────────────────────────────────────────────────────── switching

test("switch mem -> live unarchives the live group, archives mem, and leaves legacy alone", { skip }, async () => {
  await tx(async (db) => {
    const { superAdmin } = await actors(db);
    const { rows } = await db.query(`SELECT public.switch_catalog_mode('live', $1) AS r`, [superAdmin]);
    const r = rows[0].r;
    assert.equal(r.changed, true);
    assert.equal(r.previous_mode, "mem");
    assert.equal(r.tracks_unarchived, LIVE.length);
    assert.equal(r.tracks_archived, 2, "the two visible mem tracks had to be put away");

    const t = await tracks(db);
    assert.deepEqual(activeIds(t), [...LIVE].sort(), "the live catalog, and nothing else, is visible");
    assert.equal(t.get(MEM_TRACK)!.mode_archived, true, "the switcher owns the mem track's archival");
    for (const id of [...WAS_ACTIVE, ...WAS_ARCHIVED]) {
      assert.equal(t.get(id)!.archived, true, "legacy is untouched by a switch");
      assert.equal(t.get(id)!.mode_archived, false);
    }
    assert.equal(await mode(db), "live");
  });
});

test("round trip live -> mem -> mdm -> live restores exactly the original visible set", { skip }, async () => {
  await tx(async (db) => {
    const { superAdmin } = await actors(db);
    await db.query(`SELECT public.switch_catalog_mode('live', $1)`, [superAdmin]);
    const before = activeIds(await tracks(db));

    await db.query(`SELECT public.switch_catalog_mode('mem', $1)`, [superAdmin]);
    assert.deepEqual(activeIds(await tracks(db)), VISIBLE_IN_MEM);

    // mdm owns no tracks, so the catalog is legitimately EMPTY in that mode.
    const { rows } = await db.query(`SELECT public.switch_catalog_mode('mdm', $1) AS r`, [superAdmin]);
    assert.equal(rows[0].r.tracks_unarchived, 0);
    assert.deepEqual(activeIds(await tracks(db)), [], "mdm has no tracks yet — an empty catalog, not an error");

    await db.query(`SELECT public.switch_catalog_mode('live', $1)`, [superAdmin]);
    assert.deepEqual(activeIds(await tracks(db)), before, "back to exactly where we started");
  });
});

test("switching to the mode you are already in is a no-op and appends no row", { skip }, async () => {
  await tx(async (db) => {
    const { superAdmin } = await actors(db);
    const { rows } = await db.query(`SELECT public.switch_catalog_mode('mem', $1) AS r`, [superAdmin]);
    assert.equal(rows[0].r.changed, false);
    assert.equal(rows[0].r.mode, "mem");
    const { rows: log } = await db.query(`SELECT count(*)::int AS n FROM public.catalog_mode_switches`);
    assert.equal(log[0].n, 1, "the log records real changes only");
  });
});

test("a MANUAL archive survives a round trip; the switcher never revives it", { skip }, async () => {
  await tx(async (db) => {
    const { superAdmin } = await actors(db);
    await db.query(`SELECT public.switch_catalog_mode('live', $1)`, [superAdmin]);

    // A human archives one live track, touching archived_at only — exactly what a CMS-direct
    // write looks like. The sync trigger must mark it manual.
    await db.query(`UPDATE public.tracks SET archived_at = now() WHERE id = $1`, [LIVE[0]]);
    const t1 = await tracks(db);
    assert.equal(t1.get(LIVE[0])!.mode_archived, false, "archived_at changed, mode_archived did not -> manual");

    await db.query(`SELECT public.switch_catalog_mode('mem', $1)`, [superAdmin]);
    await db.query(`SELECT public.switch_catalog_mode('live', $1)`, [superAdmin]);

    const t2 = await tracks(db);
    assert.equal(t2.get(LIVE[0])!.archived, true, "the human's decision outlives the round trip");
    assert.deepEqual(activeIds(t2), LIVE.slice(1).sort());
  });
});

test("switch_catalog_mode: bad mode, and a non-super_admin actor", { skip }, async () => {
  await tx(async (db) => {
    const { plainAdmin, superAdmin } = await actors(db);
    await expectRaise(db, `SELECT public.switch_catalog_mode('legacy', $1)`, [superAdmin],
      { code: "23514", hint: "bad_mode" }, "legacy is not a mode");
    await expectRaise(db, `SELECT public.switch_catalog_mode(NULL, $1)`, [superAdmin],
      { code: "23514", hint: "bad_mode" }, "null mode");
    await expectRaise(db, `SELECT public.switch_catalog_mode('live', $1)`, [plainAdmin],
      { code: "23514", hint: "catalog_mode_not_permitted" }, "a plain admin cannot switch");
  });
});

// ─────────────────────────────────────────────────────────────── new tracks

test("a new track joins the CURRENT mode and is visible; naming another group makes it born archived", { skip }, async () => {
  await tx(async (db) => {
    const a = randomUUID();
    await db.query(`INSERT INTO public.tracks (id, track_name) VALUES ($1, 'fresh')`, [a]);
    const t1 = (await tracks(db)).get(a)!;
    assert.equal(t1.test_group, "mem", "defaults to the active mode, never legacy");
    assert.equal(t1.archived, false);

    const b = randomUUID();
    await db.query(`INSERT INTO public.tracks (id, track_name, test_group) VALUES ($1, 'for live', 'live')`, [b]);
    const t2 = (await tracks(db)).get(b)!;
    assert.equal(t2.test_group, "live");
    assert.equal(t2.archived, true, "created into a group that is not the active mode -> born archived");
    assert.equal(t2.mode_archived, true, "and the switcher owns it, so switching to live reveals it");

    const c = randomUUID();
    await db.query(`INSERT INTO public.tracks (id, track_name, test_group) VALUES ($1, 'shelved', 'legacy')`, [c]);
    const t3 = (await tracks(db)).get(c)!;
    assert.equal(t3.test_group, "legacy");
    assert.equal(t3.mode_archived, false, "legacy is never switcher-archived, even on insert");
  });
});

// ─────────────────────────────────────────────────────────────── retagging

test("set_track_group: into the active mode reveals, into another group shelves, into legacy retires", { skip }, async () => {
  await tx(async (db) => {
    const { superAdmin } = await actors(db);

    // legacy -> mem (the active mode): comes back into view
    const { rows: r1 } = await db.query(`SELECT public.set_track_group($1, 'mem', $2) AS r`, [WAS_ACTIVE[0], superAdmin]);
    assert.equal(r1[0].r.found, true);
    assert.equal(r1[0].r.archived, false, "a legacy-archived track retagged into the active mode is revealed");
    assert.equal(r1[0].r.previous_group, "legacy");

    // mem -> mdm (not the active mode): shelved, switcher-owned
    const { rows: r2 } = await db.query(`SELECT public.set_track_group($1, 'mdm', $2) AS r`, [WAS_ACTIVE[0], superAdmin]);
    assert.equal(r2[0].r.archived, true);
    assert.equal(r2[0].r.mode_archived, true, "so switching to mdm brings it back");

    // -> legacy: retired, and NOT switcher-owned
    const { rows: r3 } = await db.query(`SELECT public.set_track_group($1, 'legacy', $2) AS r`, [WAS_ACTIVE[0], superAdmin]);
    assert.equal(r3[0].r.archived, true);
    assert.equal(r3[0].r.mode_archived, false, "no switch may ever revive it");

    // a track a HUMAN archived inside the active group stays archived when retagged into it
    await db.query(`UPDATE public.tracks SET archived_at = now() WHERE id = $1`, [MEM_TRACK]);
    const { rows: r4 } = await db.query(`SELECT public.set_track_group($1, 'mem', $2) AS r`, [MEM_TRACK, superAdmin]);
    assert.equal(r4[0].r.archived, true, "a manual archival is not undone by a retag either");
  });
});

test("set_track_group: unknown track, bad group, non-super_admin actor", { skip }, async () => {
  await tx(async (db) => {
    const { superAdmin, plainAdmin } = await actors(db);
    const { rows } = await db.query(`SELECT public.set_track_group($1, 'mem', $2) AS r`, [randomUUID(), superAdmin]);
    assert.deepEqual(rows[0].r, { found: false });
    await expectRaise(db, `SELECT public.set_track_group($1, 'nope', $2)`, [MEM_TRACK, superAdmin],
      { code: "23514", hint: "bad_group" }, "unknown group");
    await expectRaise(db, `SELECT public.set_track_group($1, 'live', $2)`, [MEM_TRACK, plainAdmin],
      { code: "23514", hint: "catalog_mode_not_permitted" }, "a plain admin cannot retag");
  });
});

// ─────────────────────────────────────────────────────────── the same-group rule

test("same-group rule: every path from a questionnaire to a track is refused across groups", { skip }, async () => {
  await tx(async (db) => {
    const legacyTrack = WAS_ACTIVE[0];   // legacy; the host questionnaire is on the mem seed
    const R = { code: "23514", hint: "cross_group_link" };

    await expectRaise(db, `UPDATE public.questionnaire_response SET track_id = $1 WHERE id = $2`,
      [legacyTrack, RESPONSE], R, "response.track_id");

    await expectRaise(db, `UPDATE public.questionnaire SET defer_topic = $1 WHERE id = $2`,
      [legacyTrack, QUESTIONNAIRE], R, "questionnaire.defer_topic");

    await expectRaise(db, `UPDATE public.questionnaire_answer_actions SET track_id = $1 WHERE id = $2`,
      [legacyTrack, ACTION], R, "answer_actions.track_id");

    // via a TAG. The fixture's response points at a track, so the tag reaches nothing yet: make
    // the response use the tag first (same group, allowed), and only THEN retarget the map. That
    // is the case scoped triggers would miss — the offending row never mentions the questionnaire.
    await db.query(
      `UPDATE public.questionnaire_response SET tag_id = $1, track_id = NULL WHERE id = $2`,
      [MEM_TAG, RESPONSE]
    );
    await expectRaise(db, `UPDATE public.track_tag_map SET track_id = $1 WHERE tag_id = $2`,
      [legacyTrack, MEM_TAG], R, "response.tag_id -> map retargeted out of the group");

    // the same shape from the ACTION side. (One statement per query: a parameterised query
    // cannot carry two.) Pointing the action at the tag is same-group and allowed; retargeting
    // the map is what breaks it.
    // qaa_payload_matches_type ties the payload to action_type: add_track needs track_id and no
    // tag, add_tag the reverse. So the switch is action_type + payload together.
    await db.query(
      `UPDATE public.questionnaire_answer_actions
          SET action_type = 'add_tag', track_id = NULL, tag_id = $1 WHERE id = $2`,
      [MEM_TAG, ACTION]
    );
    await expectRaise(db, `UPDATE public.track_tag_map SET track_id = $1 WHERE tag_id = $2`,
      [legacyTrack, MEM_TAG], R, "answer_actions.tag_id -> map retargeted");

    // And from the TRACKS side. This needs a target DISTINCT from the host: the fixture's host
    // questionnaire sits on MEM_TRACK itself, so moving MEM_TRACK moves host and target together
    // and is legitimately allowed.
    const sibling = randomUUID();
    await db.query(`INSERT INTO public.tracks (id, track_name, test_group) VALUES ($1, 'mem sibling', 'mem')`, [sibling]);
    await db.query(`UPDATE public.questionnaire_response SET tag_id = NULL, track_id = $1 WHERE id = $2`,
      [sibling, RESPONSE]);
    await expectRaise(db, `UPDATE public.tracks SET test_group = 'live' WHERE id = $1`,
      [sibling], R, "tracks.test_group moved out from under a questionnaire");
  });
});

test("same-group rule: a link INSIDE one group is fine, and set_track_group cannot sneak past it", { skip }, async () => {
  await tx(async (db) => {
    const { superAdmin } = await actors(db);
    const sibling = randomUUID();
    await db.query(`INSERT INTO public.tracks (id, track_name, test_group) VALUES ($1, 'mem sibling', 'mem')`, [sibling]);

    await db.query(`UPDATE public.questionnaire_response SET track_id = $1 WHERE id = $2`, [sibling, RESPONSE]);
    const { rows } = await db.query(`SELECT track_id FROM public.questionnaire_response WHERE id = $1`, [RESPONSE]);
    assert.equal(rows[0].track_id, sibling, "same group: allowed");

    await expectRaise(db, `SELECT public.set_track_group($1, 'live', $2)`, [sibling, superAdmin],
      { code: "23514", hint: "cross_group_link" }, "retagging a linked track out of its group");
  });
});

// ─────────────────────────────────────────────────────────── grants (094)

test("the RPCs are service_role only, and the switch log is read-only to clients", { skip }, async () => {
  await tx(async (db) => {
    const { rows } = await db.query(
      `SELECT p.proname,
              has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
              has_function_privilege('service_role', p.oid, 'EXECUTE')  AS svc,
              p.prosecdef, p.proconfig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('switch_catalog_mode','set_track_group','current_catalog_mode',
                            'assert_no_cross_group_links')`
    );
    assert.equal(rows.length, 4);
    for (const r of rows) {
      assert.equal(r.anon, false, `${r.proname} must not be callable by anon`);
      assert.equal(r.auth, false, `${r.proname} must not be callable by authenticated`);
      assert.equal(r.svc, true, `${r.proname} must be callable by service_role`);
      assert.equal(r.prosecdef, true, `${r.proname} must be SECURITY DEFINER`);
      assert.ok((r.proconfig ?? []).includes("search_path=public, pg_temp"), `${r.proname} needs a pinned search_path`);
    }

    const { rows: g } = await db.query(
      `SELECT count(*)::int AS n FROM information_schema.role_table_grants
        WHERE table_schema='public' AND table_name='catalog_mode_switches'
          AND grantee IN ('anon','authenticated')
          AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')`
    );
    assert.equal(g[0].n, 0, "no client may write the switch log");
  });
});
