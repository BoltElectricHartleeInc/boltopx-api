/** Safely extract a single string from Express query param (which can be string | string[]) */
export function qs(val: unknown): string | undefined {
  if (typeof val === "string") return val;
  if (Array.isArray(val) && typeof val[0] === "string") return val[0];
  return undefined;
}
