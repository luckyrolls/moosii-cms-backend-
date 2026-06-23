import { supabase } from "../supabase";

// content_size_profiles isn't in database.types.ts (migration 014). Untyped bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// Structured content-size config (decoupled from tone/voice). Rendered into the
// "## Length" instruction at generation time.
export type SizeProfile = {
  id: string;
  name: string;
  label: string | null;
  total_words_min: number | null;
  total_words_max: number | null;
  words_per_card_min: number | null;
  words_per_card_max: number | null;
  max_sentence_words: number | null;
  max_bullet_words: number | null;
  max_bullets_per_card: number | null;
};

// Just the numeric knobs — what a per-regen inline override may carry.
export type SizeNumbers = Partial<Omit<SizeProfile, "id" | "name" | "label">>;

const SIZE_SELECT =
  "id, name, label, total_words_min, total_words_max, words_per_card_min, words_per_card_max, max_sentence_words, max_bullet_words, max_bullets_per_card";

export async function loadSizeProfileById(id: string): Promise<SizeProfile | null> {
  const { data, error } = await db.from("content_size_profiles").select(SIZE_SELECT).eq("id", id).single();
  if (error || !data) return null;
  return data as SizeProfile;
}

const has = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

// Render a size profile's numbers into the "## Length" instruction prose. Emits a
// line only for fields that are set, so a partial profile/override still renders.
// Returns "" when nothing is set (composeUserMessage then omits the section).
export function renderLengthInstruction(p: Partial<SizeProfile>): string {
  const lines: string[] = [];

  if (has(p.total_words_min) && has(p.total_words_max))
    lines.push(`Target ~${p.total_words_min}-${p.total_words_max} words total across all cards.`);
  else if (has(p.total_words_max))
    lines.push(`Target up to ~${p.total_words_max} words total across all cards.`);

  if (has(p.words_per_card_min) && has(p.words_per_card_max))
    lines.push(`Keep each card to ~${p.words_per_card_min}-${p.words_per_card_max} words.`);
  else if (has(p.words_per_card_max))
    lines.push(`Keep each card under ~${p.words_per_card_max} words.`);

  if (has(p.max_sentence_words))   lines.push(`Sentences under ${p.max_sentence_words} words.`);
  if (has(p.max_bullet_words))     lines.push(`Bullets under ${p.max_bullet_words} words.`);
  if (has(p.max_bullets_per_card)) lines.push(`Maximum ${p.max_bullets_per_card} bullets or numbered items per card.`);

  return lines.join("\n");
}
