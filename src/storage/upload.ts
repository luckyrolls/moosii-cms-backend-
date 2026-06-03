import { supabase } from "../supabase";

const BUCKET = "lessons";

function extFromMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
  };
  return map[mimeType] ?? "png";
}

export async function uploadImage(args: {
  bytes: Buffer;
  mimeType: string;
  subSegmentId: string;
  imageId: string;
}): Promise<{ path: string; publicUrl: string }> {
  const { bytes, mimeType, subSegmentId, imageId } = args;
  const ext = extFromMimeType(mimeType);
  const storagePath = `illustrations/sub-segment-${subSegmentId}/${imageId}.${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, { contentType: mimeType, upsert: false });

  if (error) {
    throw new Error(`Storage upload failed for "${storagePath}": ${error.message}`);
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

  return { path: storagePath, publicUrl: data.publicUrl };
}
