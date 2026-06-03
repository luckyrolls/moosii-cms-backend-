import { ApiError } from "@google/genai";

// Only retry on transient conditions. Fail fast on deterministic errors
// (bad request, auth, safety refusals, unknown job type, etc.).
const TRANSIENT_STATUSES = new Set([429, 500, 503]);

function isTransient(err: unknown): boolean {
  // HTTP-level transient errors from the Gemini SDK
  if (err instanceof ApiError) return TRANSIENT_STATUSES.has(err.status);
  // Network-level errors (connection reset, DNS failure, etc.) are also transient
  if (err instanceof TypeError && /fetch failed|network/i.test(err.message)) return true;
  return false;
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
      // Total span ≈ 62s — enough for a Gemini overload window to clear.
      const base = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = base * 0.25 * (Math.random() * 2 - 1);
      const waitMs = Math.round(base + jitter);
      const label =
        err instanceof ApiError ? `HTTP ${err.status}` : "network error";
      console.warn(
        `[retry] Attempt ${attempt}/${maxAttempts} failed (${label}): ${(err as Error).message}. Retrying in ${waitMs}ms...`
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}
