import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";
import { startOfMonth, endOfMonth, subMonths, format } from "date-fns";

const router = Router();

// ── Revenue report (monthly breakdown) ───────────────────────
router.get("/reports/revenue", requireAuth, async (req: Request, res: Response) => {
  const months = parseInt(String(req.query.months || "")) || 6;
  const now = new Date();

  const data = await Promise.all(
    Array.from({ length: months }, (_, i) => {
      const monthDate = subMonths(now, i);
      const from = startOfMonth(monthDate);
      const to = endOfMonth(monthDate);

      return prisma.invoice.aggregate({
        where: { status: "paid", paidDate: { gte: from, lte: to }, deletedAt: null },
        _sum: { amountPaid: true },
        _count: true,
      }).then(r => ({
        month: format(from, "MMM yyyy"),
        revenue: r._sum.amountPaid || 0,
        invoiceCount: r._count,
      }));
    })
  );

  res.json(data.reverse());
});

// ── Jobs report ──────────────────────────────────────────────
router.get("/reports/jobs", requireAuth, async (req: Request, res: Response) => {
  const from = req.query.from ? new Date(String(req.query.from || "")) : startOfMonth(new Date());
  const to = req.query.to ? new Date(String(req.query.to || "")) : endOfMonth(new Date());

  const [total, completed, cancelled, byType, byTech] = await Promise.all([
    prisma.job.count({ where: { createdAt: { gte: from, lte: to }, deletedAt: null } }),
    prisma.job.count({ where: { status: { in: ["completed", "invoiced"] }, createdAt: { gte: from, lte: to }, deletedAt: null } }),
    prisma.job.count({ where: { status: "cancelled", createdAt: { gte: from, lte: to }, deletedAt: null } }),
    prisma.job.groupBy({ by: ["jobType"], where: { createdAt: { gte: from, lte: to }, deletedAt: null }, _count: true }),
    prisma.job.groupBy({
      by: ["technicianId"],
      where: { createdAt: { gte: from, lte: to }, deletedAt: null, technicianId: { not: null } },
      _count: true,
    }),
  ]);

  // Resolve tech names
  const techIds = byTech.map(t => t.technicianId!).filter(Boolean);
  const techs = techIds.length > 0
    ? await prisma.technician.findMany({ where: { id: { in: techIds } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const techMap = Object.fromEntries(techs.map(t => [t.id, `${t.firstName} ${t.lastName}`]));

  res.json({
    total,
    completed,
    cancelled,
    completionRate: total > 0 ? (completed / total * 100).toFixed(1) : "0",
    byType: byType.map(t => ({ type: t.jobType, count: t._count })),
    byTechnician: byTech.map(t => ({ technicianId: t.technicianId, name: techMap[t.technicianId!] || "Unknown", count: t._count })),
  });
});

// ── Customer report ──────────────────────────────────────────
router.get("/reports/customers", requireAuth, async (req: Request, res: Response) => {
  const from = req.query.from ? new Date(String(req.query.from || "")) : startOfMonth(new Date());
  const to = req.query.to ? new Date(String(req.query.to || "")) : endOfMonth(new Date());

  const [totalCustomers, newCustomers, topCustomers] = await Promise.all([
    prisma.customer.count({ where: { deletedAt: null } }),
    prisma.customer.count({ where: { createdAt: { gte: from, lte: to }, deletedAt: null } }),
    prisma.$queryRaw<any[]>`
      SELECT c.id, c."firstName", c."lastName",
        COUNT(j.id)::int as job_count,
        COALESCE(SUM(i."amountPaid"), 0)::float as total_spent
      FROM "Customer" c
      LEFT JOIN "Job" j ON j."customerId" = c.id AND j."deletedAt" IS NULL
      LEFT JOIN "Invoice" i ON i."customerId" = c.id AND i.status = 'paid' AND i."deletedAt" IS NULL
      WHERE c."deletedAt" IS NULL
      GROUP BY c.id
      ORDER BY total_spent DESC
      LIMIT 10
    `,
  ]);

  res.json({
    totalCustomers,
    newCustomers,
    topCustomers: topCustomers.map(c => ({
      id: c.id, name: `${c.firstName} ${c.lastName}`, jobCount: c.job_count, totalSpent: c.total_spent,
    })),
  });
});

// ── Financial summary ────────────────────────────────────────
router.get("/reports/financial", requireAuth, async (req: Request, res: Response) => {
  const now = new Date();
  const thisMonth = { gte: startOfMonth(now), lte: endOfMonth(now) };
  const lastMonth = { gte: startOfMonth(subMonths(now, 1)), lte: endOfMonth(subMonths(now, 1)) };

  const [thisRev, lastRev, outstanding, overdue, paidThisMonth, avgInvoice] = await Promise.all([
    prisma.invoice.aggregate({ where: { status: "paid", paidDate: thisMonth, deletedAt: null }, _sum: { amountPaid: true } }),
    prisma.invoice.aggregate({ where: { status: "paid", paidDate: lastMonth, deletedAt: null }, _sum: { amountPaid: true } }),
    prisma.invoice.aggregate({ where: { deletedAt: null, total: { gt: prisma.invoice.fields?.amountPaid as any || 0 } }, _sum: { total: true } }),
    prisma.invoice.count({ where: { status: "sent", dueDate: { lt: new Date() }, deletedAt: null } }),
    prisma.invoice.count({ where: { status: "paid", paidDate: thisMonth, deletedAt: null } }),
    prisma.invoice.aggregate({ where: { status: "paid", deletedAt: null }, _avg: { amountPaid: true } }),
  ]);

  res.json({
    thisMonthRevenue: thisRev._sum.amountPaid || 0,
    lastMonthRevenue: lastRev._sum.amountPaid || 0,
    revenueChange: lastRev._sum.amountPaid ? (((thisRev._sum.amountPaid || 0) - lastRev._sum.amountPaid) / lastRev._sum.amountPaid * 100).toFixed(1) : "0",
    overdueInvoices: overdue,
    paidThisMonth,
    avgInvoiceValue: avgInvoice._avg.amountPaid || 0,
  });
});

export default router;
