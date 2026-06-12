import type { CmsUser } from "../middleware/jwtAuth";

declare global {
  namespace Express {
    interface Request {
      user?: CmsUser;
    }
  }
}
