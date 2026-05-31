import { Request, Response, NextFunction } from "express";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (header.slice(7) !== process.env.INTERNAL_API_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
