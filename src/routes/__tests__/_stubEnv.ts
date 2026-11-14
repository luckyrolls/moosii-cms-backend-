// Imported FIRST by the route tests. src/supabase.ts calls process.exit(1) when SUPABASE_URL or
// SUPABASE_SERVICE_ROLE_KEY is missing, src/lib/domain.ts does the same for DOMAIN (invariant 4),
// and both are reached transitively by the middleware and the routers — so the stubs have to be
// set before any of those modules loads. Import order is load order, which is why this lives in
// its own module rather than in the test body.
//
// SUPABASE_URL points at a local socket that answers 503 instantly. An unroutable address also
// "works", but a connect TIMEOUT costs ~14s per call on Windows and made the suite 70s; a refusal
// that arrives immediately keeps it under a second. Either way NO real database is contacted: a
// test that gets past a capability gate must fail to reach one.
import http from "node:http";

const PORT = 59997;
const dead = http.createServer((_req, res) => { res.statusCode = 503; res.end("{}"); });
dead.listen(PORT, "127.0.0.1");
dead.unref();   // never holds the test process open

process.env.SUPABASE_URL = process.env.SUPABASE_URL || `http://127.0.0.1:${PORT}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-key-not-used";
process.env.DOMAIN = process.env.DOMAIN || "moosii";

export const stubServer = dead;
