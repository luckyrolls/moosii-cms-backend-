import { DOMAIN } from "../lib/domain";
import { jwtAuthMiddleware } from "../middleware/jwtAuth";
import { createFactsRouter } from "../facts/router";
import { factsDbDeps } from "../facts/db";

// POST /facts (FACTS_API_KEY, financial only) and GET /facts/:user_id (admin JWT).
// Mounted bare in index.ts: each route carries its own auth. Contract: api-contract.md §8.
export default createFactsRouter({
  domain: DOMAIN,
  factsKey: process.env.FACTS_API_KEY,
  adminAuth: jwtAuthMiddleware,
  deps: factsDbDeps,
});
