import { Router } from "express";
import { prisma } from "../db";
import { getCache } from "../cache";

const router = Router();

router.get("/health", async (_req, res) => {
  let database = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = true;
  } catch { /* */ }

  const cache = getCache();
  let cacheConnected = false;
  if (cache) {
    try {
      await cache.ping();
      cacheConnected = true;
    } catch { /* */ }
  }

  const status = database ? "ok" : "degraded";
  res.json({
    status,
    database: database ? "connected" : "disconnected",
    cache: cacheConnected ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

export default router;
