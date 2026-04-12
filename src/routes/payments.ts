import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../auth";

const router = Router();
const prisma = new PrismaClient();

router.get("/payments", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const payments = await prisma.payment.findMany({
      include: {
        invoice: {
          select: { id: true, invoiceNumber: true, customer: { select: { firstName: true, lastName: true } } },
        },
      },
      orderBy: { paidAt: "desc" },
      take: 100,
    });
    res.json({ data: payments });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
