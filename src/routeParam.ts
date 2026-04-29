import type { Request } from "express";

/** Express 5 route params may be typed as string | string[] — normalize to one string. */
export function routeParam(req: Request, key: string): string {
  const v = req.params[key];
  if (v === undefined || v === null) return "";
  return Array.isArray(v) ? String(v[0] ?? "") : String(v);
}

/** First query-string value (handles string | string[]). */
export function queryFirst(req: Request, key: string): string {
  const v = req.query[key];
  if (v === undefined || v === null) return "";
  return Array.isArray(v) ? String(v[0] ?? "") : String(v);
}
