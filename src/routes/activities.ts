import { verifyAnyUser } from "../middleware/jwtAuth";
import { createActivitiesRouters } from "../activities/router";
import { activitiesDbDeps } from "../activities/db";

// App-facing activity follow-ups (end-user JWT; own rows only). Mounted bare in index.ts at /activities and
// /activity-followups: each route verifies the token itself. Contract: api-contract.md §10.
export const { activities: activitiesRouter, followups: activityFollowupsRouter } = createActivitiesRouters({
  async verifyUser(token) {
    const v = await verifyAnyUser(token);
    return v.ok ? { ok: true, userId: v.user.id } : v;
  },
  deps: activitiesDbDeps,
});
