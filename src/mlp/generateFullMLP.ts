// ============================================================================
// Faithful port of the BuildShip "weightedRR" node (generateFullMLP).
// Logic is kept IDENTICAL to the original except two deliberate changes:
//   CHANGE 1 (pool): only published items — enforced in the handler's query
//                    (mlp_item_pool WHERE is_published = true), so the pool
//                    handed to this function is already published-only.
//   CHANGE 2 (age filter): after completed-items are removed, also drop lessons
//                    whose [min_child_age, max_child_age] range does not overlap
//                    the youngest child's age (NULL bounds = open-ended, so
//                    questionnaires always pass). NEW behavior; see below.
// Pure/standalone and side-effect free so it can be unit-tested in isolation.
// ============================================================================

export type MlpTrack = {
  track_id: string;
  track_name?: string | null;
  priority?: number | null;
  weight?: number | null;
  track_type?: string | null; // enriched from `tracks` (not on user_active_tracks view)
};

export type MlpPoolItem = {
  item_id: string;
  item_type: string;
  track_id: string;
  priority?: number | null;
  item_name?: string | null;
  item_description?: string | null;
  with_quiz?: boolean | null;
  min_child_age?: number | null;
  max_child_age?: number | null;
};

export type CompletedItem = { item_id: string; item_type: string };

export type MlpRecord = {
  item_id: string;
  item_type: string;
  track_id: string;
  track_name: string;
  item_priority: number | null;
  track_weight: number;
  position: number;
  item_name: string;
  item_description: string;
  with_quiz: boolean | null;
  track_priority: number | null;
};

export type GenerateFullMLPInput = {
  pool: MlpPoolItem[];
  tracks: MlpTrack[];
  completedItems?: CompletedItem[];
  ages?: (number | string)[]; // bracket weighting; v1 passes [youngest_age_in_months]
  youngestAgeMonths?: number | null; // CHANGE 2 pool age filter (v1 = youngest child)
  // CHANGE 3 (slice 3) — milestone suppression. `item_type:item_id` keys the
  // handler resolved as redundant (a questionnaire whose mapped milestone is a
  // recorded fact for this user's child). Excluded exactly like completed items.
  // Computed per-user, default-to-surface: the handler passes [] on any doubt.
  suppressedItemKeys?: string[];
};

export type GenerateFullMLPOutput = {
  finalMLP: MlpRecord[];
  debug: {
    itemsSelected: number;
    trackWeights: Record<string, number>;
    poolSize: number;
    filteredPoolSize: number;
    completedItems: number;
    selectedCountByTrack: Record<string, number>;
    weightedSequence: string[];
    ageBracketDebug: {
      inputAges: (number | string)[];
      matchedBrackets: string[];
      bracketWeights: Record<string, number>;
      totalAgeWeight: number;
    };
    ageFilter: { youngestAgeMonths: number | null; removedByAge: number }; // CHANGE 2
    milestoneSuppression: { removed: number; keys: string[] }; // CHANGE 3 (slice 3)
  };
};

type BucketItem = MlpPoolItem & { track_name: string };

// Age-overlap predicate — the SINGLE source of truth for "is an item with these age
// bounds eligible for a child of this age". Shared by generateFullMLP's pool filter AND
// the questionnaire-status inspector (do NOT copy this logic). NULL/undefined bounds are
// open-ended; a NULL/undefined youngest age means we can't gate, so everything is eligible
// (matches the filter below, which only runs once a youngest age is known).
export function isAgeEligible(
  youngestAgeMonths: number | null | undefined,
  minChildAge: number | null | undefined,
  maxChildAge: number | null | undefined
): boolean {
  if (youngestAgeMonths === null || youngestAgeMonths === undefined) return true;
  const y = youngestAgeMonths;
  const minOk = minChildAge === null || minChildAge === undefined || y >= minChildAge;
  const maxOk = maxChildAge === null || maxChildAge === undefined || y <= maxChildAge;
  return minOk && maxOk;
}

export function generateFullMLP(input: GenerateFullMLPInput): GenerateFullMLPOutput {
  const pool = input.pool ?? [];
  const tracks = input.tracks ?? [];
  const completedLessons = input.completedItems ?? [];
  const ages = input.ages ?? [];
  const youngestAgeMonths = input.youngestAgeMonths ?? null;

  // Age bracket definitions
  const ageBrackets = [
    { label: "newborn", min: 0, max: 3, weight: 4 },
    { label: "infant", min: 4, max: 11, weight: 2 },
    { label: "toddler", min: 12, max: 35, weight: 2 },
    { label: "older", min: 36, max: Infinity, weight: 1 },
  ];

  // Convert string ages to numbers and filter invalid ones
  const numericAges = (Array.isArray(ages) ? ages : [])
    .map((a) => parseInt(String(a), 10))
    .filter((a) => !isNaN(a));

  // Determine which age brackets are active
  const activeBrackets: typeof ageBrackets = [];
  const seen = new Set<string>();
  for (const age of numericAges) {
    for (const bracket of ageBrackets) {
      if (age >= bracket.min && age <= bracket.max && !seen.has(bracket.label)) {
        activeBrackets.push(bracket);
        seen.add(bracket.label);
      }
    }
  }

  const totalAgeWeight = activeBrackets.reduce((sum, b) => sum + b.weight, 0);

  // Track total weight across all tracks
  const totalTrackWeight = tracks.reduce((sum, t) => sum + (t.weight ?? 1), 0);
  const trackNameMap: Record<string, string> = {};
  for (const t of tracks) {
    trackNameMap[t.track_id] = t.track_name ?? "";
  }

  // Exclude already completed lessons/questionnaires
  const completedItemSet = new Set(
    completedLessons.map((l) => `${l.item_type}:${l.item_id}`)
  );

  let filteredPool = pool.filter((item) => {
    const key = `${item.item_type}:${item.item_id}`;
    return !completedItemSet.has(key);
  });

  // CHANGE 3 (slice 3) — milestone suppression. Drop questionnaires the handler
  // resolved as redundant (mapped milestone already a fact for this user's child).
  // Same key shape and mechanism as completed items; kept as a separate step so the
  // reason a questionnaire left the plan is legible in debug. Empty set = no-op.
  const suppressedSet = new Set(input.suppressedItemKeys ?? []);
  const poolBeforeSuppress = filteredPool.length;
  if (suppressedSet.size > 0) {
    filteredPool = filteredPool.filter(
      (item) => !suppressedSet.has(`${item.item_type}:${item.item_id}`)
    );
  }
  const removedBySuppression = poolBeforeSuppress - filteredPool.length;

  // CHANGE 2 — age filter (v1: youngest child only). Keep a lesson only if the
  // youngest child's age overlaps [min_child_age, max_child_age]; NULL bounds are
  // open-ended, so questionnaires (NULL min/max) always pass. NEW vs BuildShip,
  // which used age only for bracket weighting and never filtered the pool.
  const poolBeforeAge = filteredPool.length;
  if (youngestAgeMonths !== null && youngestAgeMonths !== undefined) {
    filteredPool = filteredPool.filter((item) =>
      isAgeEligible(youngestAgeMonths, item.min_child_age, item.max_child_age)
    );
  }
  const removedByAge = poolBeforeAge - filteredPool.length;

  // Adjust weights for age track(s)
  const adjustedTrackWeights: Record<string, number> = {};
  for (const t of tracks) {
    if (t.track_type === "Age") {
      // Proportional adjustment for each age bracket
      adjustedTrackWeights[t.track_id] = (t.weight ?? 1) * (totalAgeWeight / totalTrackWeight);
    } else {
      adjustedTrackWeights[t.track_id] = t.weight ?? 1;
    }
  }

  const trackBuckets: Record<string, { queue: BucketItem[]; weight: number }> = {};
  for (const track of tracks) {
    const bucketItems: BucketItem[] = filteredPool
      .filter((i) => i.track_id === track.track_id)
      .map((i) => ({ ...i, track_name: trackNameMap[track.track_id] || "" }))
      .sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));

    trackBuckets[track.track_id] = {
      queue: bucketItems,
      weight: adjustedTrackWeights[track.track_id] ?? 1,
    };
  }

  // Sort tracks by priority
  const sortedTracks = [...tracks].sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));

  const selectedCountByTrack: Record<string, number> = {};
  const finalMLP: MlpRecord[] = [];
  let position = 1;

  // Build weighted round-robin sequence
  const minWeight = Math.min(...Object.values(adjustedTrackWeights));
  const trackCycles: Record<string, number> = {};
  for (const track of sortedTracks) {
    trackCycles[track.track_id] = Math.round(
      (adjustedTrackWeights[track.track_id] ?? 1) / minWeight
    );
  }

  const weightedSequence: string[] = [];
  const maxCycles = Math.max(...Object.values(trackCycles));
  for (let cycle = 0; cycle < maxCycles; cycle++) {
    for (const track of sortedTracks) {
      if (cycle < trackCycles[track.track_id]) {
        weightedSequence.push(track.track_id);
      }
    }
  }

  // Phase 1: Weighted round-robin
  let hasItemsRemaining = true;
  while (hasItemsRemaining) {
    hasItemsRemaining = false;
    let addedInThisCycle = false;

    for (const trackId of weightedSequence) {
      const bucket = trackBuckets[trackId];
      if (bucket && bucket.queue.length > 0) {
        const next = bucket.queue.shift() as BucketItem;
        const currentCount = selectedCountByTrack[trackId] ?? 0;

        finalMLP.push({
          item_id: next.item_id,
          item_type: next.item_type,
          track_id: next.track_id,
          track_name: next.track_name || "",
          item_priority: next.priority ?? null,
          track_weight: bucket.weight,
          position: position++,
          item_name: next.item_name || "Untitled",
          item_description: next.item_description || "",
          with_quiz: "with_quiz" in next ? (next.with_quiz ?? false) : false,
          track_priority: sortedTracks.find((t) => t.track_id === trackId)?.priority ?? null,
        });

        selectedCountByTrack[trackId] = currentCount + 1;
        addedInThisCycle = true;
        hasItemsRemaining = true;
      }
    }

    if (!addedInThisCycle) {
      hasItemsRemaining = Object.values(trackBuckets).some((bucket) => bucket.queue.length > 0);
    }
  }

  // Phase 2: Add remaining items (fallback drain)
  for (const track of sortedTracks) {
    const bucket = trackBuckets[track.track_id];
    while (bucket && bucket.queue.length > 0) {
      const next = bucket.queue.shift() as BucketItem;
      finalMLP.push({
        item_id: next.item_id,
        item_type: next.item_type,
        track_id: next.track_id,
        track_name: next.track_name || "",
        item_priority: next.priority ?? null,
        track_weight: bucket.weight,
        position: position++,
        item_name: next.item_name || "Untitled",
        item_description: next.item_description || "",
        with_quiz: next.with_quiz ?? false,
        track_priority: track.priority ?? null,
      });
    }
  }

  const ageBracketDebug = {
    inputAges: ages,
    matchedBrackets: activeBrackets.map((b) => b.label),
    bracketWeights: Object.fromEntries(activeBrackets.map((b) => [b.label, b.weight])),
    totalAgeWeight,
  };

  return {
    finalMLP,
    debug: {
      itemsSelected: finalMLP.length,
      trackWeights: adjustedTrackWeights,
      poolSize: pool.length,
      filteredPoolSize: filteredPool.length,
      completedItems: completedItemSet.size,
      selectedCountByTrack,
      weightedSequence,
      ageBracketDebug,
      ageFilter: { youngestAgeMonths, removedByAge },
      milestoneSuppression: { removed: removedBySuppression, keys: [...suppressedSet] },
    },
  };
}
