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
//
// The port is derived from the PID because `node --test` runs each test FILE in its own process,
// concurrently: a fixed port made the second file to start fail with EADDRINUSE and took the whole
// run red (seen 2026-11-17, once a second file imported this module). The bind error is also
// swallowed — if the port is somehow taken, nothing listens on it and a connection is REFUSED
// instantly, which serves this module's only purpose just as well as the 503 does.
import http from "node:http";

const PORT = 59000 + (process.pid % 900);
const dead = http.createServer((_req, res) => { res.statusCode = 503; res.end("{}"); });
dead.on("error", () => { /* port taken: a closed port refuses instantly, which is equivalent here */ });
dead.listen(PORT, "127.0.0.1");
dead.unref();   // never holds the test process open

process.env.SUPABASE_URL = process.env.SUPABASE_URL || `http://127.0.0.1:${PORT}`;
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-key-not-used";
process.env.DOMAIN = process.env.DOMAIN || "moosii";

export const stubServer = dead;
