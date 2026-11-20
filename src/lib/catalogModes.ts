// Pure helpers for the catalog-mode routes (migration 128). Everything here is decidable without
// a database, so it is unit-tested on its own; the routes only orchestrate.

export const CATALOG_MODES = ["live", "mem", "mdm"] as const;
export type CatalogMode = (typeof CATALOG_MODES)[number];

// 'legacy' is a GROUP but never a MODE: it is the group a mode switch must never touch.
export const TRACK_GROUPS = [...CATALOG_MODES, "legacy"] as const;
export type TrackGroup = (typeof TRACK_GROUPS)[number];

// 128's HINTs -> HTTP. Anything not listed is not a refusal we recognise and must surface as a
// 500, not be silently flattened into a 4xx.
export const CATALOG_REFUSALS: Record<string, { status: number; code: string }> = {
  cross_group_link: { status: 409, code: "cross_group_link" },
  catalog_mode_not_permitted: { status: 403, code: "catalog_mode_not_permitted" },
  bad_mode: { status: 400, code: "bad_mode" },
  bad_group: { status: 400, code: "bad_group" },
};

export function mapCatalogError(error: unknown): { status: number; code: string; message: string } | null {
  const hint = (error as { hint?: unknown } | null)?.hint;
  if (typeof hint !== "string") return null;
  const mapped = CATALOG_REFUSALS[hint];
  if (!mapped) return null;
  const message = (error as { message?: unknown }).message;
  return { ...mapped, message: typeof message === "string" ? message : mapped.code };
}

// The pre-apply window: 128 is pushed before it is applied (migration first, then code — but a
// deploy can land either side of an apply), so the routes must say "not yet" rather than 500.
const MIGRATION_PENDING_CODES = new Set(["PGRST202", "42883", "PGRST204", "42703", "42P01"]);

export function isMigrationPendingError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (typeof e?.code === "string" && MIGRATION_PENDING_CODES.has(e.code)) return true;
  const msg = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  return (
    msg.includes("switch_catalog_mode") ||
    msg.includes("set_track_group") ||
    msg.includes("current_catalog_mode") ||
    msg.includes("catalog_mode_switches") ||
    msg.includes("test_group")
  );
}

export function isSuperAdmin(user: { role?: string | null } | undefined | null): boolean {
  return user?.role === "super_admin";
}

export function parseMode(value: unknown): CatalogMode | null {
  return typeof value === "string" && (CATALOG_MODES as readonly string[]).includes(value)
    ? (value as CatalogMode)
    : null;
}

export function parseGroup(value: unknown): TrackGroup | null {
  return typeof value === "string" && (TRACK_GROUPS as readonly string[]).includes(value)
    ? (value as TrackGroup)
    : null;
}

export type SwitchResult = {
  mode: CatalogMode;
  previous_mode: CatalogMode | null;
  changed: boolean;
  tracks_archived: number;
  tracks_unarchived: number;
};

// switch_catalog_mode's jsonb, validated. Anything malformed is treated as a failure rather than
// coerced, because the caller uses `changed` to decide whether to trigger a rebuild of every plan.
export function interpretSwitchResult(data: unknown): SwitchResult | null {
  const d = data as Record<string, unknown> | null;
  const mode = parseMode(d?.mode);
  if (!mode || typeof d?.changed !== "boolean") return null;
  const prev = d.previous_mode === null ? null : parseMode(d.previous_mode);
  if (d.previous_mode !== null && !prev) return null;
  const archived = d.tracks_archived;
  const unarchived = d.tracks_unarchived;
  if (typeof archived !== "number" || typeof unarchived !== "number") return null;
  return { mode, previous_mode: prev, changed: d.changed, tracks_archived: archived, tracks_unarchived: unarchived };
}

export type RetagResult = {
  found: boolean;
  track_id?: string;
  test_group?: TrackGroup;
  previous_group?: TrackGroup;
  changed?: boolean;
  archived?: boolean;
  mode_archived?: boolean;
};

export function interpretRetagResult(data: unknown): RetagResult | null {
  const d = data as Record<string, unknown> | null;
  if (typeof d?.found !== "boolean") return null;
  if (!d.found) return { found: false };
  const group = parseGroup(d.test_group);
  if (!group || typeof d.archived !== "boolean" || typeof d.mode_archived !== "boolean") return null;
  return {
    found: true,
    track_id: typeof d.track_id === "string" ? d.track_id : undefined,
    test_group: group,
    previous_group: parseGroup(d.previous_group) ?? undefined,
    changed: typeof d.changed === "boolean" ? d.changed : undefined,
    archived: d.archived,
    mode_archived: d.mode_archived,
  };
}

// A mode switch rewrites which tracks are visible, so EVERY plan is stale until the rebuild runs.
// A no-op switch changes nothing and must not trigger one — an unnecessary scope:all rebuild
// would also coalesce a real one that happened to be queued behind it.
export function shouldRebuildAfterSwitch(result: SwitchResult): boolean {
  return result.changed;
}

// A retag only matters to plans if it changed the group — and therefore possibly the archival.
export function shouldRebuildAfterRetag(result: RetagResult): boolean {
  return result.found === true && result.changed === true;
}
