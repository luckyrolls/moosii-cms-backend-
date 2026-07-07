import { ApiError as GeminiApiError } from "@google/genai";
import OpenAI from "openai";

// HTTP statuses worth retrying — shared across providers. Everything else
// (400/401/403/404/422 → client/validation/permanent) fails fast.
const TRANSIENT_STATUSES = new Set([408, 409, 429, 500, 503]);

// ---------------------------------------------------------------------------
// Provider-agnostic transient classification.
//
// Each provider contributes exactly ONE classifier. A classifier answers only for
// errors it recognizes:
//     true  → transient (retry)
//     false → recognized-but-permanent (fail fast)
//     null  → "not my error type" (defer to the next classifier)
//
// TO ADD A PROVIDER (e.g. Anthropic): add its SDK's classifier to `classifiers`
// below — nowhere else. This is the single extension point on purpose. If you skip
// it, that provider's transient errors fall through to the unrecognized path
// (non-transient + a logged warning), so the gap is VISIBLE in logs, not silent.
// That silent gap is the exact bug this fixes: OpenAI errors were never classified,
// so `withRetry` re-threw them on the first attempt and only the SDK's 2 internal
// retries ever fired.
// ---------------------------------------------------------------------------
type TransientVerdict = boolean | null;
type TransientClassifier = (err: unknown) => TransientVerdict;

const classifiers: TransientClassifier[] = [
  // Gemini (@google/genai): HTTP-status-based.
  (err) => (err instanceof GeminiApiError ? TRANSIENT_STATUSES.has(err.status) : null),

  // OpenAI (openai): connection/timeout errors carry NO status → transient by type
  // (APIConnectionTimeoutError extends APIConnectionError); every other APIError
  // classifies by its HTTP status.
  (err) => {
    if (err instanceof OpenAI.APIConnectionError) return true;
    if (err instanceof OpenAI.APIError) return err.status !== undefined && TRANSIENT_STATUSES.has(err.status);
    return null;
  },

  // Provider-agnostic transport layer (fetch/undici): connection reset, DNS, etc.
  (err) => (err instanceof TypeError && /fetch failed|network/i.test(err.message) ? true : null),
];

function hasNumericStatus(err: unknown): err is { status: number } {
  return typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number";
}

export function isTransient(err: unknown): boolean {
  for (const classify of classifiers) {
    const verdict = classify(err);
    if (verdict !== null) return verdict; // a classifier recognized this error
  }
  // No classifier recognized it. Don't retry unknown errors — but if it LOOKS like an
  // unclassified HTTP/SDK error (has a numeric status), warn: that's the signature of a
  // new provider whose transient errors would otherwise silently never retry.
  if (hasNumericStatus(err)) {
    console.warn(
      `[retry] unrecognized SDK-style error (status ${err.status}) treated as non-transient — ` +
      `add a provider classifier in retry.ts if its transient errors should retry`
    );
  }
  return false;
}

// Short label for the retry log line — HTTP status when present, else the error name.
function describeError(err: unknown): string {
  if (hasNumericStatus(err)) return `HTTP ${err.status}`;
  if (err instanceof Error) return err.name || "error";
  return "error";
}

export interface RetryOptions {
  maxAttempts?: number;  // total attempts including the first (default: 6)
  baseDelayMs?: number;  // base for exponential backoff in ms (default: 2000)
  maxDelayMs?: number;   // cap before jitter to prevent unbounded waits (default: 45000)
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const { maxAttempts = 6, baseDelayMs = 2000, maxDelayMs = 45_000 } = opts;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === maxAttempts;
      if (!isTransient(err) || isLastAttempt) throw err;

      // Exponential backoff: ~2s, ~4s, ~8s, ~16s, ~32s (capped at 45s) + ±25% jitter
      // Total span ≈ 62s — enough for a provider overload window to clear.
      const base = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = base * 0.25 * (Math.random() * 2 - 1);
      const waitMs = Math.round(base + jitter);
      console.warn(
        `[retry] Attempt ${attempt}/${maxAttempts} failed (${describeError(err)}): ${(err as Error).message}. Retrying in ${waitMs}ms...`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}
