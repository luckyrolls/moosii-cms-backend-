import cors from "cors";

// Allowed browser origins, driven by CORS_ALLOWED_ORIGINS (comma-separated).
// Falls back to the local dev SPA so the app works out of the box in dev.
const DEFAULT_ORIGINS = ["http://localhost:5173"];

// Normalize an origin for tolerant comparison: trim whitespace, strip a single
// trailing slash, lowercase. The browser sends e.g. "http://localhost:5173"
// (scheme+host+port, no trailing slash); a Render env var might carry stray
// whitespace or a trailing slash, so we normalize BOTH sides before comparing.
function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

const rawEnv = process.env.CORS_ALLOWED_ORIGINS ?? "";
const configured = rawEnv
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const sourceList = configured.length > 0 ? configured : DEFAULT_ORIGINS;
const allowedNormalized = new Set(sourceList.map(normalizeOrigin));

// Startup diagnostics — confirm what the running instance actually has.
console.log(
  `[cors] CORS_ALLOWED_ORIGINS raw=${JSON.stringify(rawEnv)} ` +
    `(${configured.length > 0 ? "from env" : "DEFAULT fallback"}) ` +
    `allowed=${JSON.stringify([...allowedNormalized])}`
);

// cors handles OPTIONS preflight itself (responds 204 + headers) before any
// downstream middleware, so mount this BEFORE auth — preflights carry no
// Authorization header and must not be gated by it.
export const corsMiddleware = cors({
  origin: (requestOrigin, callback) => {
    // No Origin header => non-browser request (curl, server-to-server /jobs).
    // Nothing to gate; allow through.
    if (!requestOrigin) {
      callback(null, true);
      return;
    }
    callback(null, allowedNormalized.has(normalizeOrigin(requestOrigin)));
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type"],
});
