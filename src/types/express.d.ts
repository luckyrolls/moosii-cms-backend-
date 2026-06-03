import type { Tables } from "./database.types";

declare global {
  namespace Express {
    interface Request {
      user?: Tables<"users_internal">;
    }
  }
}
