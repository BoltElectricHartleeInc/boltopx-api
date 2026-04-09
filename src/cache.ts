import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

export function getCache(): Redis | null {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({ url, token });
  return redis;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const r = getCache();
  if (!r) return null;
  return r.get<T>(key);
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number = 300): Promise<void> {
  const r = getCache();
  if (!r) return;
  await r.set(key, value, { ex: ttlSeconds });
}
