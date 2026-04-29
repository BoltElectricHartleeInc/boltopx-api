import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../auth";
import { routeParam } from "../routeParam";

const router = Router();
const prisma = new PrismaClient();

router.get("/recurring", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const schedules = await prisma.recurringInvoiceSchedule.findMany({
      include: {
        customer: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { nextInvoiceDate: "asc" },
      take: 100,
    });
    res.json({ data: schedules });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/recurring", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const schedule = await prisma.recurringInvoiceSchedule.create({ data: req.body });
    res.status(201).json(schedule);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/recurring/:id", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const schedule = await prisma.recurringInvoiceSchedule.update({ where: { id: routeParam(req, "id") }, data: req.body });
    res.json(schedule);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
