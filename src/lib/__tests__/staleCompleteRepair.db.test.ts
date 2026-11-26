// Migrations 130 (the stale-`complete` repair) and 131 (the derived-value guard), against a REAL
// Postgres.
//
// Needs MOOSIE_TEST_DB_URL → the THROWAWAY LOCAL database from
// docs/drafts/130-stale-complete/README.md, with 129 + the fixture + 130 + 131 applied (run.sh
// gets there). Without it every test SKIPS. Refuses any non-local host. Every test runs inside
// BEGIN … ROLLBACK, so nothing a test does survives it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { deriveSegStatus, type ReviewState } from "../approvalSafety";

const URL_ = process.env.MOOSIE_TEST_DB_URL;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const skip = !URL_ ? "MOOSIE_TEST_DB_URL not set (local 130/131 test DB)" : false;

const S1 = "e1302222-0000-4000-8000-000000000001";   // L1, was stale complete
const S2 = "e1302222-0000-4000-8000-000000000002";   // L2 (archived track), was stale complete
const S3 = "e1302222-0000-4000-8000-000000000003";   // L3 unpublished, was stale complete
const S4 = "e1302222-0000-4000-8000-000000000004";   // L4, GENUINELY complete
const S5 = "e1302222-0000-4000-8000-000000000005";   // the orphan
const S6 = "e1302222-0000-4000-8000-000000000006";   // cardless
const L1 = "e1301111-0000-4000-8000-000000000001";   // published + reachable → unpublished by 130
const L2 = "e1301111-0000-4000-8000-000000000002";   // published, archived track → left alone
const L4 = "e1301111-0000-4000-8000-000000000004";   // published, genuinely complete → untouched
const C41 = "e1303333-0000-4000-8000-000000000041";  // one of L4's approved cards

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

const one = async <T = Record<string, unknown>>(db: Client, sql: string, p: unknown[] = []): Promise<T> =>
  (await db.query(sql, p)).rows[0] as T;

const segStatus = async (db: Client, seg: string): Promise<string | null> =>
  (await one<{ seg_status: string | null }>(db, "SELECT seg_status FROM segments WHERE id = $1", [seg]))
    ?.seg_status ?? null;

// ---------------------------------------------------------------------------
// 130 — the repair landed and is the truth
// ---------------------------------------------------------------------------

test("130: every stale segment is pending, including the orphan and the cardless one", { skip }, async () => {
  await tx(async (db) => {
    for (const seg of [S1, S2, S3, S5, S6]) {
      assert.equal(await segStatus(db, seg), "pending", `${seg} should have been re-derived`);
    }
  });
});

test("130: the GENUINELY complete segment was left exactly as it was", { skip }, async () => {
  await tx(async (db) => {
    assert.equal(await segStatus(db, S4), "complete");
    const l4 = await one<{ is_published: boolean }>(db, "SELECT is_published FROM lessons WHERE id = $1", [L4]);
    assert.equal(l4.is_published, true, "a correctly-complete published lesson must stay published");
  });
});

test("130: NOTHING disagrees with the derivation any more", { skip }, async () => {
  await tx(async (db) => {
    const r = await one<{ n: string }>(
      db,
      `SELECT count(*)::text AS n FROM segments s
        WHERE s.seg_status IS DISTINCT FROM public.seg_status_derived(s.id)`
    );
    assert.equal(r.n, "0");
  });
});

test("130: the REACHABLE published lesson was unpublished, with an anonymous audit row", { skip }, async () => {
  await tx(async (db) => {
    const l1 = await one<{ is_published: boolean; published_by: string | null }>(
      db, "SELECT is_published, published_by FROM lessons WHERE id = $1", [L1]
    );
    assert.equal(l1.is_published, false);
    assert.equal(l1.published_by, null, "published_by must be cleared, as set_lesson_published does");

    const audit = await one<{ action: string; actor_id: string | null; actor_role: string; reason: string }>(
      db, "SELECT action, actor_id, actor_role, reason FROM content_approvals WHERE entity_id = $1 AND action = 'unpublish'", [L1]
    );
    assert.equal(audit.action, "unpublish");
    assert.equal(audit.actor_id, null, "no person did this; a fabricated actor would be worse than none");
    assert.equal(audit.actor_role, "migration");
    assert.match(audit.reason, /migration 130/);
  });
});

test("130: the published lesson under an ARCHIVED track was left published", { skip }, async () => {
  await tx(async (db) => {
    const l2 = await one<{ is_published: boolean }>(db, "SELECT is_published FROM lessons WHERE id = $1", [L2]);
    assert.equal(l2.is_published, true, "no parent can reach it, so unpublishing is an editorial call, not a repair");
    // …and it now reports itself honestly rather than as published_reviewed.
    const v = await one<{ content_state: string; cards_awaiting_editorial: string }>(
      db, "SELECT content_state, cards_awaiting_editorial::text FROM lessons_review_status WHERE lesson_id = $1", [L2]
    );
    assert.equal(v.content_state, "published_unreviewed");
    assert.equal(v.cards_awaiting_editorial, "1");
  });
});

test("130: with_quiz re-derived itself when the segment stopped being complete", { skip }, async () => {
  await tx(async (db) => {
    const l1 = await one<{ with_quiz: boolean }>(db, "SELECT with_quiz FROM lessons WHERE id = $1", [L1]);
    assert.equal(l1.with_quiz, false, "invariant 10: with_quiz is DERIVED from the first complete segment (063)");
    // The approved question is still there — the repair withdraws an approval, it deletes nothing.
    const q = await one<{ n: string }>(
      db, "SELECT count(*)::text AS n FROM quiz_questions WHERE segment_id = $1 AND answer_status = 'approved'", [S1]
    );
    assert.equal(q.n, "1");
  });
});

test("130: the snapshot covers every segment and names what it changed", { skip }, async () => {
  await tx(async (db) => {
    const r = await one<{ snap: string; segs: string }>(
      db,
      `SELECT (SELECT count(*)::text FROM repair_130_snapshot WHERE kind='segment') AS snap,
              (SELECT count(*)::text FROM segments) AS segs`
    );
    assert.equal(r.snap, r.segs, "an exact undo must not depend on the forecast having been right");

    const moved = await one<{ n: string }>(
      db,
      `SELECT count(*)::text AS n FROM segments s JOIN repair_130_snapshot k
         ON k.kind='segment' AND k.entity_id = s.id
        WHERE s.seg_status IS DISTINCT FROM k.seg_status_before`
    );
    assert.equal(moved.n, "5", "the five fixture stale segments");

    const lessons = await one<{ n: string }>(
      db, "SELECT count(*)::text AS n FROM repair_130_snapshot WHERE kind='lesson'"
    );
    assert.equal(lessons.n, "1", "only L1 was unpublished");
  });
});

test("130: a stale approved_by was cleared with the status", { skip }, async () => {
  await tx(async (db) => {
    // recompute_seg_status NULLs approved_by whenever it writes 'pending'.
    await db.query("UPDATE repair_130_snapshot SET approved_by_before = 'someone' WHERE kind='segment' AND entity_id=$1", [S1]);
    const r = await one<{ approved_by: string | null }>(db, "SELECT approved_by FROM segments WHERE id=$1", [S1]);
    assert.equal(r.approved_by, null);
  });
});

// ---------------------------------------------------------------------------
// 131 — the guard
// ---------------------------------------------------------------------------

test("131: a hand-written UPDATE to 'complete' is REFUSED on a pending segment", { skip }, async () => {
  await tx(async (db) => {
    await assert.rejects(
      () => db.query("UPDATE segments SET seg_status = 'complete' WHERE id = $1", [S1]),
      (e: { code?: string; hint?: string }) => e.code === "23514" && e.hint === "seg_status_not_derived"
    );
    await db.query("ROLLBACK");
    await db.query("BEGIN");
    assert.equal(await segStatus(db, S1), "pending", "the refused write changed nothing");
  });
});

test("131: a hand-written UPDATE to 'pending' is ALSO refused on a complete segment", { skip }, async () => {
  // "Wrong in the safe direction" is still wrong: the column is derived, and a silent demotion
  // would hide from the audit that the reset-audit slice is about to add.
  await tx(async (db) => {
    await assert.rejects(
      () => db.query("UPDATE segments SET seg_status = 'pending' WHERE id = $1", [S4]),
      (e: { code?: string; hint?: string }) => e.code === "23514" && e.hint === "seg_status_not_derived"
    );
  });
});

test("131: the SANCTIONED writer passes its own guard, on every segment", { skip }, async () => {
  // The trap FINDINGS §6.1 warned about: recompute_seg_status writes seg_status in the same
  // statement the guard inspects, so it must be proven on that path, not only against a
  // hand-written UPDATE.
  await tx(async (db) => {
    const { rows } = await db.query<{ id: string }>("SELECT id FROM segments ORDER BY id");
    for (const r of rows) {
      await db.query("SELECT public.recompute_seg_status($1)", [r.id]);
    }
    assert.ok(rows.length > 0);
  });
});

test("131: a normal card transition still recomputes through the guard", { skip }, async () => {
  await tx(async (db) => {
    // Approve L3's only card the sanctioned way; the segment must become complete BY ITSELF.
    await db.query("SELECT public.set_card_review_state($1, ARRAY[$2]::uuid[], 'editorial_reviewed', NULL, NULL)", [
      S3, "e1303333-0000-4000-8000-000000000031",
    ]);
    await db.query("SELECT public.set_card_review_state($1, ARRAY[$2]::uuid[], 'clinically_approved', NULL, NULL)", [
      S3, "e1303333-0000-4000-8000-000000000031",
    ]);
    assert.equal(await segStatus(db, S3), "complete", "the guard must not block the real workflow");
  });
});

test("131: a new candidate image still moves the segment through the guard (129's gate)", { skip }, async () => {
  await tx(async (db) => {
    // L4 is complete with no images. A candidate on one of its cards has nothing approved to fall
    // back on, so 129's gate holds the segment out of complete — written by the content_images
    // trigger, which must also satisfy 131.
    await db.query(
      `INSERT INTO content_images (id, sub_segment_id, storage_path, status, source)
       VALUES ('e1304444-0000-4000-8000-000000000001', $1, 'p/x.png', 'candidate', 'uploaded')`,
      [C41]
    );
    assert.equal(await segStatus(db, S4), "pending");

    await db.query("UPDATE content_images SET status = 'rejected' WHERE id = 'e1304444-0000-4000-8000-000000000001'");
    assert.equal(await segStatus(db, S4), "complete", "rejecting the candidate re-opens the gate");
  });
});

test("131: seg_status_derived and the TypeScript deriveSegStatus agree on every segment", { skip }, async () => {
  // The duplication is deliberate (the gate must hold against CMS-direct writes too); this is
  // what keeps it honest.
  await tx(async (db) => {
    const { rows } = await db.query<{
      seg_id: string; derived: string; review_state: ReviewState | null;
      has_approved: boolean | null; has_candidate: boolean | null;
    }>(
      `SELECT s.id AS seg_id, public.seg_status_derived(s.id) AS derived,
              ss.review_state,
              EXISTS (SELECT 1 FROM content_images ci WHERE ci.sub_segment_id = ss.id AND ci.status='approved')  AS has_approved,
              EXISTS (SELECT 1 FROM content_images ci WHERE ci.sub_segment_id = ss.id AND ci.status='candidate') AS has_candidate
         FROM segments s LEFT JOIN sub_segments ss ON ss.seg_id = s.id
        ORDER BY s.id`
    );
    const bySeg = new Map<string, { derived: string; cards: { review_state: ReviewState; images: { has_approved: boolean; has_candidate: boolean } }[] }>();
    for (const r of rows) {
      const e = bySeg.get(r.seg_id) ?? { derived: r.derived, cards: [] };
      if (r.review_state) {
        e.cards.push({
          review_state: r.review_state,
          images: { has_approved: !!r.has_approved, has_candidate: !!r.has_candidate },
        });
      }
      bySeg.set(r.seg_id, e);
    }
    assert.ok(bySeg.size > 0);
    for (const [seg, e] of bySeg) {
      assert.equal(deriveSegStatus(e.cards), e.derived, `TS and SQL disagree on ${seg}`);
    }
  });
});

test("131: 094 grants — neither new function is callable by anon or authenticated", { skip }, async () => {
  await tx(async (db) => {
    const r = await one<{ a1: boolean; a2: boolean; s1: boolean; a3: boolean; a4: boolean; s2: boolean }>(
      db,
      `SELECT has_function_privilege('anon','public.seg_status_derived(uuid)','EXECUTE') AS a1,
              has_function_privilege('authenticated','public.seg_status_derived(uuid)','EXECUTE') AS a2,
              has_function_privilege('service_role','public.seg_status_derived(uuid)','EXECUTE') AS s1,
              has_function_privilege('anon','public.segments_status_derived_guard()','EXECUTE') AS a3,
              has_function_privilege('authenticated','public.segments_status_derived_guard()','EXECUTE') AS a4,
              has_function_privilege('service_role','public.segments_status_derived_guard()','EXECUTE') AS s2`
    );
    assert.deepEqual(
      [r.a1, r.a2, r.s1, r.a3, r.a4, r.s2],
      [false, false, true, false, false, true]
    );
  });
});

test("131: the trigger is scoped to seg_status, so other segment edits are untouched", { skip }, async () => {
  await tx(async (db) => {
    // A title edit on a segment must not be refused — the guard only fires when seg_status is in
    // the UPDATE's column list.
    await db.query("UPDATE segments SET title = 'renamed by a test' WHERE id = $1", [S4]);
    assert.equal(await segStatus(db, S4), "complete");
  });
});
