import type { Response } from "express";

export function apiError(
  res: Response,
  status: number,
  code: string,
  message: string
): void {
  res.status(status).json({ error: { code, message } });
}
