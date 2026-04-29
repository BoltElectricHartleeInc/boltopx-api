import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../auth";
import { routeParam } from "../routeParam";

const router = Router();
const prisma = new PrismaClient();

router.get("/leads", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const { stage } = req.query;
    const where: any = { deletedAt: null };
    if (stage && typeof stage === "string") where.stage = stage;

    const leads = await prisma.lead.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    res.json({ data: leads });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/leads", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const { firstName, lastName, email, phone, source, notes, address, value } = req.body;
    const lead = await prisma.lead.create({
      data: { firstName, lastName, email, phone, source, notes, address, value, stage: "new" },
    });
    res.status(201).json(lead);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/leads/:id", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const lead = await prisma.lead.update({ where: { id: routeParam(req, "id") }, data: req.body });
    res.json(lead);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
