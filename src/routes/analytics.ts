import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";
import { startOfDay, endOfDay, startOfMonth, endOfMonth, format } from "date-fns";

const router = Router();

type Granularity = "day" | "week" | "month" | "year";

function pgTrunc(g: Granularity): string {
  const safe: Record<string, string> = { day: "day", week: "week", month: "month", year: "year" };
  return safe[g] ?? "day";
}

function formatBucket(d: Date, g: Granularity): string {
  if (g === "day") return format(d, "MMM d");
  if (g === "week") return `Wk ${format(d, "MMM d")}`;
  if (g === "month") return format(d, "MMM yyyy");
  return format(d, "yyyy");
}

// TODO: re-enable requireAuth once login flow is wired up
router.get("/analytics", async (req: Request, res: Response) => {
  const t0 = Date.now();
  const fromStr = String(req.query.from || "");
  const toStr = String(req.query.to || "");
  const granularity = (req.query.granularity as Granularity) || "day";

  const from = fromStr ? new Date(fromStr) : startOfMonth(new Date());
  const to = toStr ? new Date(toStr) : endOfMonth(new Date());

  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to < from) {
    res.status(400).json({ error: "Invalid date range" });
    return;
  }

  // Smart comparison: for ranges > 90 days, compare same period last year (YoY).
  const periodMs = to.getTime() - from.getTime();
  const periodDays = periodMs / (24 * 60 * 60 * 1000);
  let prevFrom: Date;
  let prevTo: Date;
  if (periodDays > 90) {
    prevFrom = new Date(from);
    prevFrom.setFullYear(prevFrom.getFullYear() - 1);
    prevTo = new Date(to);
    prevTo.setFullYear(prevTo.getFullYear() - 1);
  } else {
    prevFrom = new Date(from.getTime() - periodMs);
    prevTo = new Date(from.getTime() - 1);
  }
  const trunc = pgTrunc(granularity);
  const today = new Date();
  const todayStart = startOfDay(today);
  const todayEnd = endOfDay(today);

  try {
    const [kpiRow, revenueChart, callVolume] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(`
        SELECT
          COALESCE((SELECT SUM("amountPaid") FROM "Invoice" WHERE status = 'paid' AND "paidDate" >= $1 AND "paidDate" <= $2 AND "deletedAt" IS NULL), 0)::float AS cur_revenue,
          COALESCE((SELECT SUM("amountPaid") FROM "Invoice" WHERE status = 'paid' AND "paidDate" >= $3 AND "paidDate" <= $4 AND "deletedAt" IS NULL), 0)::float AS prev_revenue,
          (SELECT COUNT(*) FROM "Job" WHERE "createdAt" >= $1 AND "createdAt" <= $2 AND "deletedAt" IS NULL AND "workizId" IS NULL) AS cur_jobs,
          (SELECT COUNT(*) FROM "Job" WHERE "createdAt" >= $3 AND "createdAt" <= $4 AND "deletedAt" IS NULL AND "workizId" IS NULL) AS prev_jobs,
          COALESCE((SELECT COUNT(*) FROM "PhoneCall" WHERE "createdAt" >= $1 AND "createdAt" <= $2), 0) AS cur_calls,
          COALESCE((SELECT COUNT(*) FROM "PhoneCall" WHERE "createdAt" >= $3 AND "createdAt" <= $4), 0) AS prev_calls,
          (SELECT COUNT(DISTINCT "customerId") FROM "Job" WHERE "createdAt" >= $1 AND "createdAt" <= $2 AND "deletedAt" IS NULL) AS cur_customers,
          (SELECT COUNT(DISTINCT "customerId") FROM "Job" WHERE "createdAt" >= $3 AND "createdAt" <= $4 AND "deletedAt" IS NULL) AS prev_customers,
          COALESCE((SELECT SUM("total") - SUM("amountPaid") FROM "Invoice" WHERE "deletedAt" IS NULL AND "total" > "amountPaid"), 0)::float AS outstanding,
          (SELECT COUNT(*) FROM "Job" WHERE status IN ('completed', 'invoiced') AND "createdAt" >= $1 AND "createdAt" <= $2 AND "deletedAt" IS NULL) AS completed_jobs,
          COALESCE(
            NULLIF((SELECT AVG("total") FROM "Estimate" WHERE status = 'accepted' AND "createdAt" >= $1 AND "createdAt" <= $2 AND "deletedAt" IS NULL), 0),
            (SELECT AVG("amountPaid") FROM "Invoice" WHERE status = 'paid' AND "paidDate" >= $1 AND "paidDate" <= $2 AND "deletedAt" IS NULL AND "amountPaid" > 0),
            0
          )::float AS avg_job_value,
          COALESCE((SELECT COUNT(*) FROM "Invoice" WHERE status = 'sent' AND "dueDate" < NOW() AND "deletedAt" IS NULL), 0) AS overdue_count,
          COALESCE((SELECT SUM("total") FROM "Invoice" WHERE status = 'sent' AND "dueDate" < NOW() AND "deletedAt" IS NULL), 0)::float AS overdue_amount,
          (SELECT COUNT(*) FROM "Estimate" WHERE status = 'pending' AND "deletedAt" IS NULL) AS pending_estimates,
          (SELECT COUNT(*) FROM "Job" WHERE status = 'assigned' AND "technicianId" IS NULL AND "deletedAt" IS NULL) AS unassigned_jobs,
          (SELECT COUNT(*) FROM "Job" WHERE "createdAt" >= $5 AND "createdAt" <= $6 AND "deletedAt" IS NULL) AS today_jobs,
          COALESCE((SELECT COUNT(*) FROM "PhoneCall" WHERE "direction" = 'inbound' AND "createdAt" >= $1 AND "createdAt" <= $2), 0) AS inbound_calls,
          COALESCE((SELECT COUNT(*) FROM "PhoneCall" WHERE "direction" = 'outbound' AND "createdAt" >= $1 AND "createdAt" <= $2), 0) AS outbound_calls,
          COALESCE((SELECT AVG("duration") FROM "PhoneCall" WHERE "createdAt" >= $1 AND "createdAt" <= $2), 0)::float AS avg_duration,
          COALESCE((SELECT COUNT(*) FROM "PhoneCall" WHERE "status" = 'missed' AND "createdAt" >= $1 AND "createdAt" <= $2), 0) AS missed_calls
      `, from, to, prevFrom, prevTo, todayStart, todayEnd),

      prisma.$queryRawUnsafe<any[]>(`
        SELECT DATE_TRUNC('${trunc}', "paidDate")::date AS bucket_date, SUM("amountPaid")::float AS revenue
        FROM "Invoice" WHERE status = 'paid' AND "paidDate" >= $1 AND "paidDate" <= $2 AND "deletedAt" IS NULL
        GROUP BY DATE_TRUNC('${trunc}', "paidDate") ORDER BY bucket_date ASC
      `, from, to),

      prisma.$queryRawUnsafe<any[]>(`
        SELECT DATE_TRUNC('${trunc}', "createdAt")::date AS bucket_date,
          COUNT(*)::int AS total,
          COUNT(CASE WHEN direction = 'inbound' THEN 1 END)::int AS inbound,
          COUNT(CASE WHEN direction = 'outbound' THEN 1 END)::int AS outbound
        FROM "PhoneCall" WHERE "createdAt" >= $1 AND "createdAt" <= $2
        GROUP BY DATE_TRUNC('${trunc}', "createdAt") ORDER BY bucket_date ASC
      `, from, to),
    ]);

    if (!kpiRow?.length) {
      res.status(404).json({ error: "No data found" });
      return;
    }

    const k = kpiRow[0];
    const curRevenue = Number(k.cur_revenue);
    const prevRevenue = Number(k.prev_revenue);
    const curJobs = Number(k.cur_jobs);
    const prevJobs = Number(k.prev_jobs);
    const curCalls = Number(k.cur_calls);
    const prevCalls = Number(k.prev_calls);
    const curCustomers = Number(k.cur_customers);
    const prevCustomers = Number(k.prev_customers);
    const completedJobs = Number(k.completed_jobs);
    const avgJobValue = parseFloat(String(k.avg_job_value)) || 0;
    const outstanding = parseFloat(String(k.outstanding)) || 0;
    const inboundCalls = Number(k.inbound_calls);
    const outboundCalls = Number(k.outbound_calls);
    const avgDuration = parseFloat(String(k.avg_duration)) || 0;
    const missedCalls = Number(k.missed_calls);

    const pct = (c: number, p: number) => {
      if (p === 0 && c === 0) return 0;
      if (p === 0) return 100;
      return ((c - p) / p) * 100;
    };

    const revChart = revenueChart.map((r: any) => ({
      date: formatBucket(new Date(r.bucket_date), granularity),
      invoiced: parseFloat(r.revenue) || 0,
      collected: parseFloat(r.revenue) || 0,
    }));

    const callVol = callVolume.map((r: any) => ({
      date: formatBucket(new Date(r.bucket_date), granularity),
      total: Number(r.total), inbound: Number(r.inbound), outbound: Number(r.outbound),
    }));

    res.json({
      kpis: {
        totalRevenue: curRevenue, previousRevenue: prevRevenue, revenueChange: pct(curRevenue, prevRevenue),
        totalJobs: curJobs, previousJobs: prevJobs, jobsChange: pct(curJobs, prevJobs),
        completedJobs, avgJobValue,
        totalCalls: curCalls, previousCalls: prevCalls, callsChange: pct(curCalls, prevCalls),
        newCustomers: curCustomers, previousNewCustomers: prevCustomers, newCustomersChange: pct(curCustomers, prevCustomers),
        outstanding,
      },
      kpi: {
        revenue: { current: curRevenue, previous: prevRevenue, change: pct(curRevenue, prevRevenue) },
        jobs: { current: curJobs, previous: prevJobs, change: pct(curJobs, prevJobs) },
        calls: { current: curCalls, previous: prevCalls, change: pct(curCalls, prevCalls), inbound: inboundCalls, outbound: outboundCalls, avgDuration, missed: missedCalls },
        customers: { current: curCustomers, previous: prevCustomers },
        invoices: { outstanding, overdue: parseFloat(String(k.overdue_amount)) || 0, overdueCount: Number(k.overdue_count) },
      },
      revenueTimeSeries: revChart,
      callVolume: callVol,
      callMetrics: { totalCalls: curCalls, totalInbound: inboundCalls, totalOutbound: outboundCalls, avgDuration, bookingRate: 0, missedCalls },
      actionItems: {
        overdueInvoices: Number(k.overdue_count), overdueAmount: parseFloat(String(k.overdue_amount)) || 0,
        pendingEstimates: Number(k.pending_estimates), unassignedJobs: Number(k.unassigned_jobs), todayJobs: Number(k.today_jobs),
      },
      pipeline: { estimatesDraft: 0, estimatesSent: Number(k.pending_estimates), estimatesApproved: 0, estimatesDeclined: 0, estimateTotalValue: 0, approvedValue: 0, conversionRate: 0 },
      todaySchedule: [],
      meta: { requestTime: Date.now() - t0, cached: false },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[analytics] Error:", msg);
    res.status(500).json({ error: msg });
  }
});

export default router;
