// The "## Context" lines a segment-content prompt shows the model — PURE (no DB, no env), so the wording
// is unit-tested. "Segment" / "sub-segment" are internal names: the model must never see them as labels,
// because it echoes labels back ("According to the segment…"). Readers see "lesson", "activity" or nothing.

export type ContentKind = "lesson" | "activity";

export function kindLine(kind: string | null | undefined): string {
  return kind === "activity"
    ? 'This is an activity: the reader will DO it. Refer to it as "this activity", never as a lesson or segment.'
    : 'This is a lesson. Refer to it as "this lesson", never as a segment.';
}

export function contentContextLines(opts: {
  lessonTitle: string;
  ageLine?: string | null;
  kind?: string | null;
  segmentName: string;            // internal: the segment row's name (usually the lesson name)
  segmentDescription: string | null;
}): string[] {
  const ctx = [`Lesson title: ${opts.lessonTitle}`];
  if (opts.ageLine) ctx.push(opts.ageLine);
  ctx.push(kindLine(opts.kind));
  // The segment's name is only worth showing when it differs from the lesson title — and then as
  // "Lesson part", never the internal word.
  const name = opts.segmentName.trim();
  if (name && name !== opts.lessonTitle.trim()) ctx.push(`Lesson part: ${name}`);
  if (opts.segmentDescription) ctx.push(`Description: ${opts.segmentDescription}`);
  return ctx;
}
