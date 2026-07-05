import { supabase } from "../supabase";

const BUCKET = "lessons";

// When content is regenerated, a card's image no longer fits the new text and its
// content_images row is removed (cascade on card delete, or explicit on single-card
// regen). Without cleanup the underlying STORAGE FILE (and its image_assets row) is
// orphaned — pure bloat, with no reuse path. This purges all three for the given
// sub_segments.
//
// ORDER MATTERS: a DB trigger on storage.objects owns image_assets (auto-INSERT on
// upload, auto-DELETE on remove). So we must NOT delete image_assets before removing
// the file — the storage-delete trigger raises (P0001) on the missing row. Instead:
//   1. clear the live pointer (sub_segments.image → image_assets.url FK) so the trigger
//      can drop image_assets without an FK violation
//   2. delete the content_images rows
//   3. remove the storage objects WHILE image_assets still exists — the trigger drops it
//   4. safety-net: delete any image_assets left (a no-op where the trigger ran; covers a
//      no-trigger environment). Only when the file removal succeeded (else keep them
//      consistent with the still-present file).
// Storage removal is best-effort — a failure must never block a regen (the file just
// leaks). Call BEFORE deleting/replacing the cards, after a valid new result is in hand.
// Idempotent; a no-op on [].
export async function purgeImagesForSubSegments(
  subSegmentIds: string[]
): Promise<{ files: number; image_assets: number; content_images: number }> {
  if (subSegmentIds.length === 0) return { files: 0, image_assets: 0, content_images: 0 };

  const { data: imgs } = await supabase
    .from("content_images")
    .select("id, storage_path")
    .in("sub_segment_id", subSegmentIds);
  const rows = (imgs ?? []) as { id: string; storage_path: string | null }[];
  const paths = [
    ...new Set(rows.map((r) => r.storage_path).filter((p): p is string => !!p && p !== "pending")),
  ];

  // 1. Drop the live pointer so image_assets is no longer FK-referenced.
  await supabase.from("sub_segments").update({ image: null, image_path: null }).in("id", subSegmentIds);

  // 2. content_images (also cascade-removed when a card is deleted; explicit here so
  //    single-card regen and delete-timing are both covered).
  await supabase.from("content_images").delete().in("sub_segment_id", subSegmentIds);

  let filesRemoved = 0;
  let assetsDeleted = 0;
  if (paths.length > 0) {
    // 3. Remove the files WHILE image_assets still exists (trigger drops image_assets).
    const { data: removed, error } = await supabase.storage.from(BUCKET).remove(paths);
    if (error) {
      console.warn(`[purgeImages] storage remove failed for ${paths.length} file(s): ${error.message}`);
    } else {
      filesRemoved = (removed ?? []).length;
      // 4. Safety-net (no-trigger environments) — a no-op when the trigger already ran.
      const { data: del } = await supabase.from("image_assets").delete().in("path", paths).select("id");
      assetsDeleted = (del ?? []).length;
    }
  }

  return { files: filesRemoved, image_assets: assetsDeleted, content_images: rows.length };
}
