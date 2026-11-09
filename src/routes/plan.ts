import { verifyAnyUser } from "../middleware/jwtAuth";
import { createPlanRouter } from "../plan/router";
import { planDbDeps } from "../plan/db";

// App-facing plan read (end-user JWT; the token's own user only). Mounted bare in index.ts at /plan — the route
// verifies the token itself, exactly like /activity-followups. Contract: api-contract.md §11.
export const planRouter = createPlanRouter({
  async verifyUser(token) {
    const v = await verifyAnyUser(token);
    return v.ok ? { ok: true, userId: v.user.id } : v;
  },
  deps: planDbDeps,
});
