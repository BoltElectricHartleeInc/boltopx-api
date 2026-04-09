import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";

const router = Router();

router.get("/invoices", requireAuth, async (req: Request, res: Response) => {
  const page = parseInt(String(req.query.page || "")) || 1;
  const limit = Math.min(parseInt(String(req.query.limit || "")) || 25, 100);
  const status = String(req.query.status || "");

  const where: any = { deletedAt: null };
  if (status) where.status = status;

  const [data, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, email: true } },
        job: { select: { id: true, jobNumber: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.invoice.count({ where }),
  ]);
  res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
});

router.get("/invoices/:id", requireAuth, async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: { customer: true, job: true, lineItems: true, payments: true },
  });
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }
  res.json(invoice);
});

router.post("/invoices", requireAuth, async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.create({ data: req.body, include: { customer: true, job: true } });
  res.status(201).json(invoice);
});

router.put("/invoices/:id", requireAuth, async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.update({ where: { id: req.params.id }, data: req.body });
  res.json(invoice);
});

export default router;
