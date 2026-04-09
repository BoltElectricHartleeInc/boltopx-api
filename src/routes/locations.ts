import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";

const router = Router();

router.get("/locations", requireAuth, async (_req: Request, res: Response) => {
  const locations = await prisma.location.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
  res.json(locations);
});

export default router;
