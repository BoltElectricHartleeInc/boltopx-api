import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";
import { routeParam } from "../routeParam";

const router = Router();

router.get("/estimates", requireAuth, async (req: Request, res: Response) => {
  const page = parseInt(String(Array.isArray(req.query.page) ? req.query.page[0] : req.query.page || "")) || 1;
  const limit = Math.min(parseInt(String(Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit || "")) || 25, 100);
  const status = String(Array.isArray(req.query.status) ? req.query.status[0] : req.query.status || "");

  const where: any = { deletedAt: null };
  if (status) where.status = status;

  const [data, total] = await Promise.all([
    prisma.estimate.findMany({
      where,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true } },
        job: { select: { id: true, jobNumber: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.estimate.count({ where }),
  ]);
  res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
});

router.get("/estimates/:id", requireAuth, async (req: Request, res: Response) => {
  const estimate = await prisma.estimate.findUnique({
    where: { id: routeParam(req, "id") },
    include: { customer: true, job: true, lineItems: true },
  });
  if (!estimate) { res.status(404).json({ error: "Estimate not found" }); return; }
  res.json(estimate);
});

router.post("/estimates", requireAuth, async (req: Request, res: Response) => {
  const estimate = await prisma.estimate.create({ data: req.body, include: { customer: true } });
  res.status(201).json(estimate);
});

export default router;
