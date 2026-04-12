import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../auth";

const router = Router();
const prisma = new PrismaClient();

router.get("/templates", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const templates = await prisma.estimateTemplate.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    res.json({ data: templates });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/templates", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const template = await prisma.estimateTemplate.create({ data: req.body });
    res.status(201).json(template);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/templates/:id", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const template = await prisma.estimateTemplate.update({ where: { id: req.params.id }, data: req.body });
    res.json(template);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
