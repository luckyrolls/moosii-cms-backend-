import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blocksGate,
  deriveSegStatus,
  candidateArrivalTarget,
  contentSkipReason,
  quizSkipReason,
  imageSkipReason,
  tallySkips,
  regenApprovedImageBlock,
  trackExcludedFromBatch,
  lessonGateFor,
  type ReviewState,
} from "../approvalSafety";

const OPEN = { published: false, archived: false };

// ---------------------------------------------------------------------------
// 1. The gate
// ---------------------------------------------------------------------------

test("blocksGate: a candidate with no approved image holds the gate", () => {
  assert.equal(blocksGate({ has_approved: false, has_candidate: true }), true);
});

test("blocksGate: a replacement candidate BESIDE an approved image does NOT block", () => {
  // The live picture is still the approved one — this is the case that must not drop a
  // published lesson to published_unreviewed.
  assert.equal(blocksGate({ has_approved: true, has_candidate: true }), false);
});

test("blocksGate: no images at all does not block, and an approved image alone does not", () => {
  assert.equal(blocksGate({ has_approved: false, has_candidate: false }), false);
  assert.equal(blocksGate({ has_approved: true, has_candidate: false }), false);
});

test("deriveSegStatus: cardless is pending (056's >=1 card guard)", () => {
  assert.equal(deriveSegStatus([]), "pending");
});

test("deriveSegStatus: all clinically approved, no blocking image → complete", () => {
  const cards = [
    { review_state: "clinically_approved" as ReviewState, images: { has_approved: true, has_candidate: false } },
    { review_state: "clinically_approved" as ReviewState, images: { has_approved: true, has_candidate: true } },
    { review_state: "clinically_approved" as ReviewState, images: { has_approved: false, has_candidate: false } },
  ];
  assert.equal(deriveSegStatus(cards), "complete");
});

test("deriveSegStatus: one unapproved card → pending", () => {
  assert.equal(
    deriveSegStatus([
      { review_state: "clinically_approved", images: { has_approved: true, has_candidate: false } },
      { review_state: "editorial_reviewed", images: { has_approved: true, has_candidate: false } },
    ]),
    "pending"
  );
});

test("deriveSegStatus: approved cards but one un-adjudicated candidate → pending (the new gate)", () => {
  assert.equal(
    deriveSegStatus([
      { review_state: "clinically_approved", images: { has_approved: true, has_candidate: false } },
      { review_state: "clinically_approved", images: { has_approved: false, has_candidate: true } },
    ]),
    "pending"
  );
});

// ---------------------------------------------------------------------------
// 2. What a new candidate costs the card
// ---------------------------------------------------------------------------

test("candidate on a clinically approved card with NO approved image → editorial_reviewed", () => {
  assert.equal(candidateArrivalTarget("clinically_approved", { has_approved: false }), "editorial_reviewed");
});

test("candidate on a clinically approved card that ALREADY has an approved image → no change", () => {
  assert.equal(candidateArrivalTarget("clinically_approved", { has_approved: true }), null);
});

test("candidate never touches a draft or editorial card (no-op on unapproved)", () => {
  for (const s of ["draft", "editorial_reviewed"] as ReviewState[]) {
    assert.equal(candidateArrivalTarget(s, { has_approved: false }), null);
    assert.equal(candidateArrivalTarget(s, { has_approved: true }), null);
  }
});

test("candidate never sends anything to draft (the slice A1 regression guard)", () => {
  const states: ReviewState[] = ["draft", "editorial_reviewed", "clinically_approved"];
  for (const s of states) {
    for (const has_approved of [true, false]) {
      assert.notEqual(candidateArrivalTarget(s, { has_approved }), "draft");
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Track eligibility (the catalog-mode rule, 128)
// ---------------------------------------------------------------------------

const trk = (over: Partial<Parameters<typeof trackExcludedFromBatch>[0]> = {}) => ({
  archived_at: null,
  mode_archived: false,
  test_group: "live",
  ...over,
});

test("track: a MODE-HIDDEN track stays eligible (mode_archived — the whole point)", () => {
  // Every `live` track on Moosii looks like this while the catalog sits in `mem`. If this were
  // excluded, building the real curriculum would require switching the whole catalog to it.
  assert.equal(
    trackExcludedFromBatch(trk({ archived_at: "2026-11-19T00:00:00Z", mode_archived: true })),
    false
  );
});

test("track: a MANUALLY archived track is excluded", () => {
  assert.equal(
    trackExcludedFromBatch(trk({ archived_at: "2026-11-19T00:00:00Z", mode_archived: false })),
    true
  );
});

test("track: legacy is excluded, archived or not", () => {
  assert.equal(trackExcludedFromBatch(trk({ test_group: "legacy", archived_at: "2026-11-19T00:00:00Z" })), true);
  // A legacy row someone unarchived by hand: no mode switch will ever reveal it, so it is
  // still out. This is why legacy is tested by name and not left to archived_at.
  assert.equal(trackExcludedFromBatch(trk({ test_group: "legacy", archived_at: null })), true);
});

test("track: an active track in any managed group is eligible", () => {
  for (const g of ["live", "mem", "mdm"]) {
    assert.equal(trackExcludedFromBatch(trk({ test_group: g })), false);
  }
});

test("track: a missing row reads as eligible, not as archived", () => {
  // planTrackContent/planTrackImages coalesce a missing track to all-null; a null test_group
  // must not accidentally mean legacy, and null archived_at means not archived.
  assert.equal(trackExcludedFromBatch({ archived_at: null, mode_archived: null, test_group: null }), false);
});

test("lessonGateFor: the lesson's own archived_at is always manual", () => {
  assert.deepEqual(
    lessonGateFor({ is_published: false, archived_at: "2026-11-19T00:00:00Z" }, trk()),
    { published: false, archived: true }
  );
});

test("lessonGateFor: a mode-hidden track leaves its lessons buildable", () => {
  assert.deepEqual(
    lessonGateFor(
      { is_published: false, archived_at: null },
      trk({ archived_at: "2026-11-19T00:00:00Z", mode_archived: true })
    ),
    { published: false, archived: false }
  );
});

test("lessonGateFor: a manually archived track excludes its unarchived lessons", () => {
  assert.deepEqual(
    lessonGateFor(
      { is_published: true, archived_at: null },
      trk({ archived_at: "2026-11-19T00:00:00Z", mode_archived: false })
    ),
    { published: true, archived: true }
  );
});

// ---------------------------------------------------------------------------
// 4. Batch skips
// ---------------------------------------------------------------------------

const seg = (over: Partial<Parameters<typeof contentSkipReason>[0]> = {}) => ({
  seg_id: "s1",
  lesson: OPEN,
  has_content: false,
  content_approved: false,
  has_approved_image: false,
  regenerated_since_cutoff: false,
  ...over,
});

test("content: a published lesson is excluded in both modes", () => {
  for (const mode of ["fill_missing", "replace"] as const) {
    assert.deepEqual(
      contentSkipReason(seg({ lesson: { published: true, archived: false } }), mode),
      { plan: false, skip: "published" }
    );
  }
});

test("content: an archived lesson (or archived track) is excluded in both modes", () => {
  for (const mode of ["fill_missing", "replace"] as const) {
    assert.deepEqual(
      contentSkipReason(seg({ lesson: { published: false, archived: true } }), mode),
      { plan: false, skip: "archived" }
    );
  }
});

test("content: published outranks archived in the reason, when both hold", () => {
  assert.equal(
    contentSkipReason(seg({ lesson: { published: true, archived: true } }), "replace").skip,
    "published"
  );
});

test("content: an approved image blocks the segment in BOTH modes, and outranks approved_content", () => {
  for (const mode of ["fill_missing", "replace"] as const) {
    assert.deepEqual(
      contentSkipReason(seg({ has_approved_image: true, content_approved: true }), mode),
      { plan: false, skip: "approved_images" }
    );
  }
});

test("content fill_missing: plans an empty segment, silently skips one that has content", () => {
  assert.deepEqual(contentSkipReason(seg(), "fill_missing"), { plan: true, skip: null });
  assert.deepEqual(contentSkipReason(seg({ has_content: true }), "fill_missing"), { plan: false, skip: null });
});

test("content fill_missing: approved content does NOT block (it is skipped as present, not approved)", () => {
  assert.deepEqual(
    contentSkipReason(seg({ has_content: true, content_approved: true }), "fill_missing"),
    { plan: false, skip: null }
  );
});

test("content replace: approved content is skipped, with no include_approved escape", () => {
  assert.deepEqual(
    contentSkipReason(seg({ has_content: true, content_approved: true }), "replace"),
    { plan: false, skip: "approved_content" }
  );
});

test("content replace: a unit a dead run already redid is skipped as resume", () => {
  assert.deepEqual(
    contentSkipReason(seg({ has_content: true, regenerated_since_cutoff: true }), "replace"),
    { plan: false, skip: "resume" }
  );
});

test("content replace: an unapproved segment with content is planned", () => {
  assert.deepEqual(contentSkipReason(seg({ has_content: true }), "replace"), { plan: true, skip: null });
});

const qseg = (over: Partial<Parameters<typeof quizSkipReason>[0]> = {}) => ({
  seg_id: "s1",
  lesson: OPEN,
  question_count: 0,
  quiz_approved: false,
  regenerated_since_cutoff: false,
  ...over,
});

test("quiz: lesson gate applies; no image rule (generateQuiz touches no image)", () => {
  assert.equal(quizSkipReason(qseg({ lesson: { published: true, archived: false } }), "replace").skip, "published");
  assert.deepEqual(quizSkipReason(qseg(), "fill_missing"), { plan: true, skip: null });
  assert.deepEqual(quizSkipReason(qseg({ question_count: 3 }), "fill_missing"), { plan: false, skip: null });
  assert.deepEqual(
    quizSkipReason(qseg({ question_count: 3, quiz_approved: true }), "replace"),
    { plan: false, skip: "approved_content" }
  );
  assert.deepEqual(
    quizSkipReason(qseg({ question_count: 3, regenerated_since_cutoff: true }), "replace"),
    { plan: false, skip: "resume" }
  );
});

test("images: published and archived lessons are excluded", () => {
  assert.equal(
    imageSkipReason({ sub_segment_id: "c1", lesson: { published: true, archived: false }, has_image: false, segment_has_content: true }).skip,
    "published"
  );
  assert.equal(
    imageSkipReason({ sub_segment_id: "c1", lesson: { published: false, archived: true }, has_image: false, segment_has_content: true }).skip,
    "archived"
  );
});

test("images: existing image → silent skip; no content → no_content; otherwise planned", () => {
  assert.deepEqual(
    imageSkipReason({ sub_segment_id: "c1", lesson: OPEN, has_image: true, segment_has_content: true }),
    { plan: false, skip: null }
  );
  assert.deepEqual(
    imageSkipReason({ sub_segment_id: "c1", lesson: OPEN, has_image: false, segment_has_content: false }),
    { plan: false, skip: "no_content" }
  );
  assert.deepEqual(
    imageSkipReason({ sub_segment_id: "c1", lesson: OPEN, has_image: false, segment_has_content: true }),
    { plan: true, skip: null }
  );
});

test("images: the lesson gate outranks has_image, so an excluded lesson reports why", () => {
  assert.equal(
    imageSkipReason({ sub_segment_id: "c1", lesson: { published: true, archived: false }, has_image: true, segment_has_content: true }).skip,
    "published"
  );
});

test("tallySkips: every reason is present even at zero", () => {
  const t = tallySkips(["published", "published", "approved_images", null]);
  assert.deepEqual(t, {
    published: 2, archived: 0, approved_images: 1, approved_content: 0, resume: 0, no_content: 0,
  });
});

// ---------------------------------------------------------------------------
// 5. The single-segment refusal
// ---------------------------------------------------------------------------

test("regen block: whole_segment is blocked by ANY approved image in the segment", () => {
  assert.deepEqual(
    regenApprovedImageBlock({ scope: "whole_segment", approvedImageCardIds: ["c1", "c3"] }),
    { count: 2, card_ids: ["c1", "c3"] }
  );
});

test("regen block: whole_segment with no approved image passes", () => {
  assert.equal(regenApprovedImageBlock({ scope: "whole_segment", approvedImageCardIds: [] }), null);
});

test("regen block: single_card is blocked only by ITS OWN approved image", () => {
  assert.deepEqual(
    regenApprovedImageBlock({ scope: "single_card", card_id: "c1", approvedImageCardIds: ["c1", "c3"] }),
    { count: 1, card_ids: ["c1"] }
  );
  // a sibling's approved image is irrelevant — single_card purges only that card
  assert.equal(
    regenApprovedImageBlock({ scope: "single_card", card_id: "c2", approvedImageCardIds: ["c1", "c3"] }),
    null
  );
});

test("regen block: single_card with no card_id cannot match anything", () => {
  assert.equal(
    regenApprovedImageBlock({ scope: "single_card", card_id: null, approvedImageCardIds: ["c1"] }),
    null
  );
});
