import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../auth";

const router = Router();
const prisma = new PrismaClient();

router.get("/photos", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const { jobId } = req.query;
    const where: any = {};
    if (jobId && typeof jobId === "string") where.jobId = jobId;

    const photos = await prisma.photo.findMany({
      where,
      include: {
        job: { select: { id: true, jobNumber: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ data: photos });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
