import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";
import { queryFirst, routeParam } from "../routeParam";
import { startOfMonth, endOfMonth, subMonths } from "date-fns";

const router = Router();

// ── Technician performance dashboard ─────────────────────────
router.get("/performance/technicians", requireAuth, async (req: Request, res: Response) => {
  const fromStr = queryFirst(req, "from");
  const toStr = queryFirst(req, "to");
  const from = fromStr ? new Date(fromStr) : startOfMonth(new Date());
  const to = toStr ? new Date(toStr) : endOfMonth(new Date());

  const techs = await prisma.technician.findMany({
    where: { isActive: true },
    select: { id: true, firstName: true, lastName: true, color: true },
  });

  const results = await Promise.all(techs.map(async (tech) => {
    const [jobCount, completedCount, revenue, avgDuration] = await Promise.all([
      prisma.job.count({ where: { technicianId: tech.id, createdAt: { gte: from, lte: to }, deletedAt: null } }),
      prisma.job.count({ where: { technicianId: tech.id, status: { in: ["completed", "invoiced"] }, createdAt: { gte: from, lte: to }, deletedAt: null } }),
      prisma.invoice.aggregate({ where: { job: { technicianId: tech.id }, status: "paid", OR: [{ paidDate: { gte: from, lte: to } }, { paidDate: null, updatedAt: { gte: from, lte: to } }], deletedAt: null }, _sum: { amountPaid: true } }),
      prisma.job.aggregate({ where: { technicianId: tech.id, actualDuration: { not: null }, createdAt: { gte: from, lte: to }, deletedAt: null }, _avg: { actualDuration: true } }),
    ]);

    return {
      ...tech,
      totalJobs: jobCount,
      completedJobs: completedCount,
      completionRate: jobCount > 0 ? (completedCount / jobCount * 100).toFixed(1) : "0",
      totalRevenue: revenue._sum.amountPaid || 0,
      avgJobDuration: Math.round(avgDuration._avg.actualDuration || 0),
      revenuePerJob: completedCount > 0 ? (revenue._sum.amountPaid || 0) / completedCount : 0,
    };
  }));

  res.json(results.sort((a, b) => b.totalRevenue - a.totalRevenue));
});

// ── Single tech performance detail ───────────────────────────
router.get("/performance/technician/:id", requireAuth, async (req: Request, res: Response) => {
  const techId = routeParam(req, "id");
  const now = new Date();
  const thisMonth = { gte: startOfMonth(now), lte: endOfMonth(now) };
  const lastMonth = { gte: startOfMonth(subMonths(now, 1)), lte: endOfMonth(subMonths(now, 1)) };

  const [tech, thisMonthJobs, lastMonthJobs, thisMonthRev, lastMonthRev, recentJobs] = await Promise.all([
    prisma.technician.findUnique({ where: { id: techId }, select: { id: true, firstName: true, lastName: true, color: true, phone: true, position: true } }),
    prisma.job.count({ where: { technicianId: techId, createdAt: thisMonth, deletedAt: null } }),
    prisma.job.count({ where: { technicianId: techId, createdAt: lastMonth, deletedAt: null } }),
    prisma.invoice.aggregate({ where: { job: { technicianId: techId }, status: "paid", OR: [{ paidDate: thisMonth }, { paidDate: null, updatedAt: thisMonth }], deletedAt: null }, _sum: { amountPaid: true } }),
    prisma.invoice.aggregate({ where: { job: { technicianId: techId }, status: "paid", OR: [{ paidDate: lastMonth }, { paidDate: null, updatedAt: lastMonth }], deletedAt: null }, _sum: { amountPaid: true } }),
    prisma.job.findMany({ where: { technicianId: techId, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 10, include: { customer: { select: { firstName: true, lastName: true } } } }),
  ]);

  if (!tech) { res.status(404).json({ error: "Technician not found" }); return; }

  res.json({
    ...tech,
    thisMonth: { jobs: thisMonthJobs, revenue: thisMonthRev._sum.amountPaid || 0 },
    lastMonth: { jobs: lastMonthJobs, revenue: lastMonthRev._sum.amountPaid || 0 },
    recentJobs,
  });
});

export default router;
