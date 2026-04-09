import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";

const router = Router();

router.get("/alerts", requireAuth, async (req: Request, res: Response) => {
  const alerts = await prisma.alert.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(alerts);
});

router.get("/alerts/count", requireAuth, async (_req: Request, res: Response) => {
  const count = await prisma.alert.count({ where: { resolvedAt: null } });
  res.json({ count });
});

export default router;
