// Migration 129 — the approval image gate and its recompute-only trigger, against a REAL
// Postgres, plus a cross-check that the SQL and src/lib/approvalSafety.ts agree.
//
// Needs MOOSIE_TEST_DB_URL → the THROWAWAY LOCAL database from
// docs/drafts/129-approval-safety/README.md, with 127 + 128 + the 129 fixture + 129 applied.
// Without it every test SKIPS. Refuses any non-local host. Every test runs inside
// BEGIN … ROLLBACK, so nothing a test does survives it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { deriveSegStatus, type ReviewState } from "../approvalSafety";

const URL_ = process.env.MOOSIE_TEST_DB_URL;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const skip = !URL_ ? "MOOSIE_TEST_DB_URL not set (local 129 test DB)" : false;

const S1 = "e1292222-0000-4000-8000-000000000001";   // open lesson, 3 approved cards
const S2 = "e1292222-0000-4000-8000-000000000002";   // PUBLISHED lesson, 2 approved cards
const S5 = "e1292222-0000-4000-8000-000000000005";   // cardless
const C1 = "e1293333-0000-4000-8000-000000000001";   // approved image
const C2 = "e1293333-0000-4000-8000-000000000002";   // approved image + newer candidate
const C3 = "e1293333-0000-4000-8000-000000000003";   // no images (one rejected)
const C5 = "e1293333-0000-4000-8000-000000000005";   // under the published lesson
const L2 = "e1291111-0000-4000-8000-000000000002";   // the published lesson
const C5_APPROVED_IMG = "e1294444-0000-4000-8000-000000000005";
const LESSON_LEVEL_IMG = "e1294444-0000-4000-8000-000000000007";

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

const segStatus = async (db: Client, seg: string): Promise<string | null> =>
  (await db.query("SELECT seg_status FROM segments WHERE id = $1", [seg])).rows[0]?.seg_status ?? null;

const cardState = async (db: Client, card: string): Promise<string | null> =>
  (await db.query("SELECT review_state FROM sub_segments WHERE id = $1", [card])).rows[0]?.review_state ?? null;

// `source` must be 'uploaded': the column defaults to 'generated', which then demands
// final_prompt / image_prompt / image_generator_name (content_images_generated_has_provenance).
const addCandidate = (db: Client, card: string, id: string) =>
  db.query(
    "INSERT INTO content_images (id, sub_segment_id, storage_path, status, source) VALUES ($1, $2, $3, 'candidate', 'uploaded')",
    [id, card, `p/${id}.png`]
  );

const NEW1 = "e129aaaa-0000-4000-8000-000000000001";
const NEW2 = "e129aaaa-0000-4000-8000-000000000002";

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test("129 does not move a segment with nothing un-adjudicated", { skip }, async () => {
  await tx(async (db) => {
    // The fixture's S1 has: an approved-only card, an approved+candidate card, and a card whose
    // only image is REJECTED. None of those is un-adjudicated, so the new rule agrees with 056.
    const r = await db.query("SELECT recompute_seg_status($1) AS s", [S1]);
    assert.equal(r.rows[0].s, "complete");
    assert.equal(await segStatus(db, S1), "complete");
  });
});

test("a candidate on a card with NO approved image holds the gate — via the trigger alone", { skip }, async () => {
  await tx(async (db) => {
    assert.equal(await segStatus(db, S1), "complete");
    await addCandidate(db, C3, NEW1);
    // No explicit recompute: the content_images trigger is what must have done this.
    assert.equal(await segStatus(db, S1), "pending", "the trigger did not re-derive the gate");
    // and the card's review state is untouched — the gate holds it, not a demotion
    assert.equal(await cardState(db, C3), "clinically_approved");
  });
});

test("a replacement candidate BESIDE an approved image does NOT hold the gate", { skip }, async () => {
  await tx(async (db) => {
    await addCandidate(db, C2, NEW1);   // C2 already has an approved image AND a candidate
    assert.equal(await segStatus(db, S1), "complete", "a replacement candidate must not block");
    await addCandidate(db, C1, NEW2);   // C1 has an approved image, no candidate yet
    assert.equal(await segStatus(db, S1), "complete");
    assert.equal(await cardState(db, C1), "clinically_approved");
  });
});

test("rejecting the candidate re-opens the gate (the UPDATE OF status arm)", { skip }, async () => {
  await tx(async (db) => {
    await addCandidate(db, C3, NEW1);
    assert.equal(await segStatus(db, S1), "pending");
    await db.query("UPDATE content_images SET status = 'rejected' WHERE id = $1", [NEW1]);
    assert.equal(await segStatus(db, S1), "complete", "a rejected candidate must stop blocking");
  });
});

test("deleting the candidate re-opens the gate (the DELETE arm)", { skip }, async () => {
  await tx(async (db) => {
    await addCandidate(db, C3, NEW1);
    assert.equal(await segStatus(db, S1), "pending");
    await db.query("DELETE FROM content_images WHERE id = $1", [NEW1]);
    assert.equal(await segStatus(db, S1), "complete");
  });
});

test("approving the candidate re-opens the gate", { skip }, async () => {
  await tx(async (db) => {
    await addCandidate(db, C3, NEW1);
    assert.equal(await segStatus(db, S1), "pending");
    await db.query("UPDATE content_images SET status = 'approved' WHERE id = $1", [NEW1]);
    assert.equal(await segStatus(db, S1), "complete", "an approved image must satisfy the gate");
  });
});

test("a cardless segment is still pending (056's >=1 card guard survives)", { skip }, async () => {
  await tx(async (db) => {
    const r = await db.query("SELECT recompute_seg_status($1) AS s", [S5]);
    assert.equal(r.rows[0].s, "pending");
  });
});

// ---------------------------------------------------------------------------
// The published lesson must not change visibility
// ---------------------------------------------------------------------------

test("a published lesson stays visible when a replacement candidate lands", { skip }, async () => {
  await tx(async (db) => {
    assert.equal(await segStatus(db, S2), "complete");
    await addCandidate(db, C5, NEW1);   // C5 HAS an approved image
    assert.equal(await segStatus(db, S2), "complete", "a published lesson must not go pending");
    const l = await db.query("SELECT is_published FROM lessons WHERE id = $1", [L2]);
    assert.equal(l.rows[0].is_published, true);
    const v = await db.query("SELECT content_state FROM lessons_review_status WHERE lesson_id = $1", [L2]);
    assert.equal(v.rows[0].content_state, "published_reviewed", "065 must still read it as reviewed");
  });
});

test("a published lesson DOES go unreviewed when a card has no approved image to fall back on", { skip }, async () => {
  await tx(async (db) => {
    // Remove C5's approved image first (that alone leaves it imageless, which does not block)…
    await db.query("DELETE FROM content_images WHERE id = $1", [C5_APPROVED_IMG]);
    assert.equal(await segStatus(db, S2), "complete", "an imageless card does not block by itself");
    // …then a candidate on it is genuinely un-adjudicated.
    await addCandidate(db, C5, NEW1);
    assert.equal(await segStatus(db, S2), "pending");
    const v = await db.query("SELECT content_state FROM lessons_review_status WHERE lesson_id = $1", [L2]);
    assert.equal(v.rows[0].content_state, "published_unreviewed");
  });
});

// ---------------------------------------------------------------------------
// The trigger's scope
// ---------------------------------------------------------------------------

test("a non-status UPDATE on content_images does NOT recompute", { skip }, async () => {
  await tx(async (db) => {
    const before = (await db.query("SELECT updated_at FROM segments WHERE id = $1", [S1])).rows[0].updated_at;
    // The generate job rewrites storage_path moments after inserting the candidate; that write
    // must not cost a second recompute (the trigger is scoped UPDATE OF status).
    await db.query("UPDATE content_images SET storage_path = 'p/moved.png' WHERE sub_segment_id = $1", [C1]);
    const after = (await db.query("SELECT updated_at FROM segments WHERE id = $1", [S1])).rows[0].updated_at;
    assert.deepEqual(after, before, "a storage_path rewrite must not touch the segment");
  });
});

test("a lesson-level image (sub_segment_id NULL) is ignored, not an error", { skip }, async () => {
  await tx(async (db) => {
    await db.query("UPDATE content_images SET status = 'approved' WHERE id = $1", [LESSON_LEVEL_IMG]);
    assert.equal(await segStatus(db, S1), "complete");
    await db.query("DELETE FROM content_images WHERE id = $1", [LESSON_LEVEL_IMG]);
    assert.equal(await segStatus(db, S1), "complete");
  });
});

test("deleting a CARD does not break the trigger (the cascade case)", { skip }, async () => {
  await tx(async (db) => {
    // The card's images cascade; by the time the trigger runs the sub_segment is gone, so it must
    // return early rather than fail. 066's own trigger does the recompute.
    await db.query("DELETE FROM sub_segments WHERE id = $1", [C1]);
    assert.equal(await segStatus(db, S1), "pending", "066 re-gates the whole segment on a delete");
  });
});

// ---------------------------------------------------------------------------
// 092/093 unchanged
// ---------------------------------------------------------------------------

// sub_segments.image is an FK to image_assets(url) (sub_segments_image_fkey), so a pointer write
// needs the asset row first — the same reason POST /lessons/:id/approve pre-checks linkability
// and 409s image_not_linkable (lessons.ts:120-140).
async function linkable(db: Client, url: string): Promise<string> {
  await db.query(
    "INSERT INTO image_assets (bucket, path, name, url) VALUES ('lessons', $1, $1, $2)",
    [url.replace(/^https:\/\//, ""), url]
  );
  return url;
}

test("093 still demotes clinical when a different image is written onto an approved card", { skip }, async () => {
  await tx(async (db) => {
    assert.equal(await cardState(db, C1), "clinically_approved");
    const url = await linkable(db, "https://x/new.png");
    await db.query("UPDATE sub_segments SET image = $2 WHERE id = $1", [C1, url]);
    assert.equal(await cardState(db, C1), "editorial_reviewed", "093 must still fire");
    assert.equal(await segStatus(db, S1), "pending");
  });
});

test("092 still holds: re-writing the SAME image moves nothing", { skip }, async () => {
  await tx(async (db) => {
    const url = await linkable(db, "https://x/same.png");
    await db.query("UPDATE sub_segments SET image = $2 WHERE id = $1", [C1, url]);
    // the first write demoted it (093); from editorial_reviewed, writing the same value again is
    // a no-op — 093's WHEN clause requires OLD.review_state = 'clinically_approved'
    assert.equal(await cardState(db, C1), "editorial_reviewed");
    await db.query("UPDATE sub_segments SET image = $2 WHERE id = $1", [C1, url]);
    assert.equal(await cardState(db, C1), "editorial_reviewed");
  });
});

// ---------------------------------------------------------------------------
// The SQL and the TypeScript must agree
// ---------------------------------------------------------------------------

test("deriveSegStatus (TS) matches recompute_seg_status (SQL) on every fixture segment", { skip }, async () => {
  await tx(async (db) => {
    const segs = (await db.query("SELECT id FROM segments WHERE id::text LIKE 'e1292222%' ORDER BY id")).rows;
    assert.ok(segs.length >= 5, "the fixture's segments are missing");
    for (const { id } of segs) {
      const cards = (
        await db.query(
          `SELECT ss.review_state,
                  EXISTS (SELECT 1 FROM content_images ci WHERE ci.sub_segment_id = ss.id AND ci.status = 'approved')  AS has_approved,
                  EXISTS (SELECT 1 FROM content_images ci WHERE ci.sub_segment_id = ss.id AND ci.status = 'candidate') AS has_candidate
             FROM sub_segments ss WHERE ss.seg_id = $1`,
          [id]
        )
      ).rows as { review_state: ReviewState; has_approved: boolean; has_candidate: boolean }[];
      const ts = deriveSegStatus(
        cards.map((c) => ({
          review_state: c.review_state,
          images: { has_approved: c.has_approved, has_candidate: c.has_candidate },
        }))
      );
      const sql = (await db.query("SELECT recompute_seg_status($1) AS s", [id])).rows[0].s;
      assert.equal(ts, sql, `segment ${id}: TS said ${ts}, SQL said ${sql}`);
    }
  });
});

test("the agreement holds after a candidate lands on an imageless card", { skip }, async () => {
  await tx(async (db) => {
    await addCandidate(db, C3, NEW1);
    const cards = (
      await db.query(
        `SELECT ss.review_state,
                EXISTS (SELECT 1 FROM content_images ci WHERE ci.sub_segment_id = ss.id AND ci.status = 'approved')  AS has_approved,
                EXISTS (SELECT 1 FROM content_images ci WHERE ci.sub_segment_id = ss.id AND ci.status = 'candidate') AS has_candidate
           FROM sub_segments ss WHERE ss.seg_id = $1`,
        [S1]
      )
    ).rows as { review_state: ReviewState; has_approved: boolean; has_candidate: boolean }[];
    const ts = deriveSegStatus(
      cards.map((c) => ({ review_state: c.review_state, images: { has_approved: c.has_approved, has_candidate: c.has_candidate } }))
    );
    assert.equal(ts, "pending");
    assert.equal((await db.query("SELECT recompute_seg_status($1) AS s", [S1])).rows[0].s, "pending");
  });
});

// ---------------------------------------------------------------------------
// 094 grants
// ---------------------------------------------------------------------------

test("neither function is EXECUTE-able by anon or authenticated (094)", { skip }, async () => {
  await tx(async (db) => {
    const r = await db.query(
      `SELECT has_function_privilege('anon', 'public.recompute_seg_status(uuid)', 'EXECUTE')   AS a1,
              has_function_privilege('authenticated', 'public.recompute_seg_status(uuid)', 'EXECUTE') AS a2,
              has_function_privilege('anon', 'public.content_images_recompute()', 'EXECUTE')   AS b1,
              has_function_privilege('authenticated', 'public.content_images_recompute()', 'EXECUTE') AS b2,
              has_function_privilege('service_role', 'public.recompute_seg_status(uuid)', 'EXECUTE')  AS s1`
    );
    const g = r.rows[0];
    assert.equal(g.a1, false); assert.equal(g.a2, false);
    assert.equal(g.b1, false); assert.equal(g.b2, false);
    assert.equal(g.s1, true, "service_role must keep EXECUTE");
  });
});
