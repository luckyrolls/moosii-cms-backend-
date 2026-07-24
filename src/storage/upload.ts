import sharp from "sharp";
import { supabase } from "../supabase";

const BUCKET = "lessons";

// Every generated card image is normalized HERE — at the storage chokepoint, not in a
// provider — so it is provider-INDEPENDENT: whatever bytes/format the image model returns
// (JPEG today from gemini-3.1-flash-image, PNG/other tomorrow), what we STORE is optimized
// WebP. Flat vector-style illustration compresses ~90%+ vs the provider's JPEG with no
// visible difference on a phone.
//
// Transform: resize to fit within MAX_EDGE on the LONG edge (aspect preserved; never
// upscaled) + WebP q80. The long edge is the ONLY constraint — we store the FULL generated
// frame, NO crop. Display cropping (if the app renders a non-16:9 card) is the app's call;
// the destructive fix, if ever wanted, is generating at the display ratio (both providers
// accept an aspect config, currently unset), not cropping at upload.
const MAX_EDGE = 1200;
const WEBP_QUALITY = 80;

export async function uploadImage(args: {
  bytes: Buffer;
  mimeType: string; // the provider's format — informational; the stored object is ALWAYS WebP
  subSegmentId: string;
  imageId: string;
}): Promise<{ path: string; publicUrl: string; bytes: number; width: number | null; height: number | null }> {
  const { bytes, subSegmentId, imageId } = args;

  // Re-encode to WebP at <=1200px long edge. resolveWithObject gives us the output dims.
  const out = await sharp(bytes)
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });

  const storagePath = `illustrations/sub-segment-${subSegmentId}/${imageId}.webp`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, out.data, { contentType: "image/webp", upsert: false });

  if (error) {
    throw new Error(`Storage upload failed for "${storagePath}": ${error.message}`);
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

  return {
    path: storagePath,
    publicUrl: data.publicUrl,
    bytes: out.data.length,
    width: out.info.width ?? null,
    height: out.info.height ?? null,
  };
}
