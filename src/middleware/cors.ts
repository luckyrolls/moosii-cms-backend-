import cors from "cors";

// Allowed browser origins, driven by ALLOWED_ORIGINS (comma-separated), with
// CORS_ALLOWED_ORIGINS accepted as a legacy alias. Falls back to the local dev SPA so
// local dev works out of the box with no env set.
const DEFAULT_ORIGINS = ["http://localhost:5173"];

// Normalize an origin for tolerant comparison: trim whitespace, strip a single
// trailing slash, lowercase. The browser sends e.g. "http://localhost:5173"
// (scheme+host+port, no trailing slash); a Render env var might carry stray
// whitespace or a trailing slash, so we normalize BOTH sides before comparing.
function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

// ALLOWED_ORIGINS is the current name; CORS_ALLOWED_ORIGINS is a legacy alias kept so an
// existing Render value keeps working. First non-empty (whitespace-trimmed) value wins.
const rawEnv =
  process.env.ALLOWED_ORIGINS?.trim() ||
  process.env.CORS_ALLOWED_ORIGINS?.trim() ||
  "";
const envVarUsed = process.env.ALLOWED_ORIGINS?.trim()
  ? "ALLOWED_ORIGINS"
  : process.env.CORS_ALLOWED_ORIGINS?.trim()
    ? "CORS_ALLOWED_ORIGINS (legacy alias)"
    : "none → localhost default";
const configured = rawEnv
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const sourceList = configured.length > 0 ? configured : DEFAULT_ORIGINS;
const allowedNormalized = new Set(sourceList.map(normalizeOrigin));

// Startup diagnostics — confirm what the running instance actually has.
console.log(
  `[cors] origins source=${envVarUsed} raw=${JSON.stringify(rawEnv)} ` +
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
