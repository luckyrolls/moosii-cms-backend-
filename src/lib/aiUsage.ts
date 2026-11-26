// ---------------------------------------------------------------------------
// Token usage out of an `ai_generation_log.response` payload. PURE.
//
// TWO shapes exist in the live table (measured on Moosii, 2026-11-26, all 1 210 rows):
//
//   OpenAI  response.usage         = { prompt_tokens, completion_tokens, total_tokens, … }
//   Gemini  response.usageMetadata = { promptTokenCount, candidatesTokenCount, totalTokenCount, … }
//
// Both are present in the table and BOTH must be read, or a batch's token total silently
// under-reports whichever provider it happened to use. Per operation:
//   segment_content / segment_content_regen / quiz / image_prompt_generate → usage (OpenAI)
//   image_generate (gemini-3.1-flash-image)                                → usageMetadata
//
// ⚠ Correction to FINDINGS-track-buildout.md §6, which says image generation "records no
// usage": that is true of the `usage` key only. Gemini image calls DO report
// `usageMetadata` (391 of 391 rows), ~1 550 total tokens each, of which the candidate side is
// an IMAGE-modality count rather than text. They are real tokens and are counted here; what
// is still unavailable is a PRICE, which is why no money appears anywhere in this slice.
// ---------------------------------------------------------------------------

export type Usage = { tokens_in: number; tokens_out: number; tokens_total: number };

const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * Read the usage block of one logged call, or null when the provider reported none.
 * `tokens_total` falls back to in+out when the provider omits a total, so a partial payload
 * still contributes rather than vanishing.
 */
export function extractUsage(response: unknown): Usage | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;

  const openai = r.usage as Record<string, unknown> | undefined;
  if (openai && typeof openai === "object") {
    const i = num(openai.prompt_tokens);
    const o = num(openai.completion_tokens);
    const t = num(openai.total_tokens);
    if (i !== null || o !== null || t !== null) {
      return { tokens_in: i ?? 0, tokens_out: o ?? 0, tokens_total: t ?? (i ?? 0) + (o ?? 0) };
    }
  }

  const gemini = r.usageMetadata as Record<string, unknown> | undefined;
  if (gemini && typeof gemini === "object") {
    const i = num(gemini.promptTokenCount);
    const o = num(gemini.candidatesTokenCount);
    const t = num(gemini.totalTokenCount);
    if (i !== null || o !== null || t !== null) {
      return { tokens_in: i ?? 0, tokens_out: o ?? 0, tokens_total: t ?? (i ?? 0) + (o ?? 0) };
    }
  }

  return null;
}

export const ZERO_USAGE: Usage = { tokens_in: 0, tokens_out: 0, tokens_total: 0 };

export function addUsage(a: Usage, b: Usage | null): Usage {
  if (!b) return a;
  return {
    tokens_in: a.tokens_in + b.tokens_in,
    tokens_out: a.tokens_out + b.tokens_out,
    tokens_total: a.tokens_total + b.tokens_total,
  };
}

export function sumUsage(responses: unknown[]): Usage {
  return responses.reduce<Usage>((acc, r) => addUsage(acc, extractUsage(r)), ZERO_USAGE);
}
