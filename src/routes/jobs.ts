import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";

const router = Router();

router.get("/jobs", requireAuth, async (req: Request, res: Response) => {
  const page = parseInt(String(Array.isArray(req.query.page) ? req.query.page[0] : req.query.page || "")) || 1;
  const limit = Math.min(parseInt(String(Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit || "")) || 25, 100);
  const status = String(Array.isArray(req.query.status) ? req.query.status[0] : req.query.status || "");
  const search = String(Array.isArray(req.query.search) ? req.query.search[0] : req.query.search || "");

  const where: any = { deletedAt: null };
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { jobNumber: { contains: search, mode: "insensitive" } },
      { customer: { OR: [
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
      ]}},
    ];
  }

  const [data, total] = await Promise.all([
    prisma.job.findMany({
      where,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
        technician: { select: { id: true, firstName: true, lastName: true, color: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.job.count({ where }),
  ]);

  res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
});

router.get("/jobs/:id", requireAuth, async (req: Request, res: Response) => {
  const job = await prisma.job.findUnique({
    where: { id: req.params.id },
    include: {
      customer: true,
      technician: true,
      invoices: true,
      estimates: true,
      photos: true,
      lineItems: true,
    },
  });
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json(job);
});

router.post("/jobs", requireAuth, async (req: Request, res: Response) => {
  const { title, description, customerId, technicianId, scheduledDate, jobType, priority, address } = req.body;

  const lastJob = await prisma.job.findFirst({ orderBy: { jobNumber: "desc" }, select: { jobNumber: true } });
  const nextNum = lastJob ? parseInt(lastJob.jobNumber.replace(/\D/g, "")) + 1 : 1001;
  const jobNumber = `J-${nextNum}`;

  const job = await prisma.job.create({
    data: { jobNumber, title, description, customerId, technicianId, scheduledDate: scheduledDate ? new Date(scheduledDate) : null, jobType: jobType || "service", priority: priority || "medium", address },
    include: { customer: true, technician: true },
  });
  res.status(201).json(job);
});

router.put("/jobs/:id", requireAuth, async (req: Request, res: Response) => {
  const job = await prisma.job.update({
    where: { id: req.params.id },
    data: req.body,
    include: { customer: true, technician: true },
  });
  res.json(job);
});

export default router;
