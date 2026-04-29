import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";
import { routeParam } from "../routeParam";
import { startOfDay, endOfDay, addDays, format } from "date-fns";

const router = Router();

// ── Today's jobs for logged-in user's technician ─────────────
router.get("/dispatch/today", requireAuth, async (req: Request, res: Response) => {
  const user = (req as any).user;
  const techId = user.technicianId || String(Array.isArray(req.query.technicianId) ? req.query.technicianId[0] : req.query.technicianId || "");
  const today = new Date();

  const where: any = {
    deletedAt: null,
    scheduledDate: { gte: startOfDay(today), lte: endOfDay(today) },
  };
  if (techId) where.technicianId = techId;

  const jobs = await prisma.job.findMany({
    where,
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true, address: true } },
      technician: { select: { id: true, firstName: true, lastName: true, color: true } },
    },
    orderBy: { scheduledDate: "asc" },
  });

  res.json({ date: format(today, "yyyy-MM-dd"), count: jobs.length, jobs });
});

// ── Week view for technician ─────────────────────────────────
router.get("/dispatch/technician/:id/week", requireAuth, async (req: Request, res: Response) => {
  const techId = routeParam(req, "id");
  const today = new Date();
  const weekEnd = addDays(today, 7);

  const jobs = await prisma.job.findMany({
    where: {
      technicianId: techId,
      deletedAt: null,
      scheduledDate: { gte: startOfDay(today), lte: endOfDay(weekEnd) },
    },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true, address: true } },
    },
    orderBy: { scheduledDate: "asc" },
  });

  // Group by date
  const grouped: Record<string, typeof jobs> = {};
  for (const job of jobs) {
    const dateKey = job.scheduledDate ? format(job.scheduledDate, "yyyy-MM-dd") : "unscheduled";
    if (!grouped[dateKey]) grouped[dateKey] = [];
    grouped[dateKey].push(job);
  }

  res.json({ technicianId: techId, days: grouped });
});

// ── Update job status with activity log ──────────────────────
router.post("/dispatch/job/:id/status", requireAuth, async (req: Request, res: Response) => {
  const { status, notes } = req.body;
  const user = (req as any).user;
  const validStatuses = ["pending", "scheduled", "assigned", "en-route", "arrived", "in-progress", "completed", "invoiced", "cancelled"];

  if (!status || !validStatuses.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    return;
  }

  const job = await prisma.job.findUnique({ where: { id: routeParam(req, "id") } });
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }

  const previousStatus = job.status;

  // Update job
  const updateData: any = { status };
  if (status === "completed") updateData.completedDate = new Date();
  if (status === "en-route") updateData.enRouteAt = new Date();

  const updated = await prisma.job.update({
    where: { id: routeParam(req, "id") },
    data: updateData,
    include: { customer: true, technician: true },
  });

  // Log activity
  await prisma.jobActivity.create({
    data: {
      jobId: routeParam(req, "id"),
      type: "status_change",
      description: `Status changed: ${previousStatus} → ${status}`,
      userName: user.name || user.email,
      userId: user.id,
      metadata: { previousStatus, newStatus: status, notes },
    },
  });

  res.json({ job: updated, previousStatus, newStatus: status });
});

// ── Assign job to technician ─────────────────────────────────
router.post("/dispatch/job/:id/assign", requireAuth, async (req: Request, res: Response) => {
  const { technicianId, scheduledDate } = req.body;
  const user = (req as any).user;

  if (!technicianId) { res.status(400).json({ error: "technicianId required" }); return; }

  const tech = await prisma.technician.findUnique({ where: { id: technicianId }, select: { id: true, firstName: true, lastName: true } });
  if (!tech) { res.status(404).json({ error: "Technician not found" }); return; }

  const job = await prisma.job.update({
    where: { id: routeParam(req, "id") },
    data: {
      technicianId,
      status: "assigned",
      scheduledDate: scheduledDate ? new Date(scheduledDate) : undefined,
    },
    include: { customer: true, technician: true },
  });

  await prisma.jobActivity.create({
    data: {
      jobId: routeParam(req, "id"),
      type: "assignment",
      description: `Assigned to ${tech.firstName} ${tech.lastName}`,
      userName: user.name || user.email,
      userId: user.id,
      metadata: { technicianId, assignedBy: user.id },
    },
  });

  res.json(job);
});

// ── Unassigned jobs ──────────────────────────────────────────
router.get("/dispatch/unassigned", requireAuth, async (req: Request, res: Response) => {
  const jobs = await prisma.job.findMany({
    where: { technicianId: null, deletedAt: null, status: { notIn: ["completed", "cancelled", "invoiced"] } },
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, phone: true, address: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({ count: jobs.length, jobs });
});

// ── All technicians with today's job count ───────────────────
router.get("/dispatch/technicians", requireAuth, async (req: Request, res: Response) => {
  const today = new Date();
  const techs = await prisma.technician.findMany({
    where: { isActive: true },
    select: {
      id: true, firstName: true, lastName: true, phone: true, color: true, position: true,
      _count: {
        select: {
          jobs: { where: { scheduledDate: { gte: startOfDay(today), lte: endOfDay(today) }, deletedAt: null } },
        },
      },
    },
    orderBy: { firstName: "asc" },
  });

  res.json(techs.map(t => ({
    id: t.id, firstName: t.firstName, lastName: t.lastName, phone: t.phone,
    color: t.color, position: t.position, todayJobCount: t._count.jobs,
  })));
});

// ── Job activity log ─────────────────────────────────────────
router.get("/dispatch/job/:id/activity", requireAuth, async (req: Request, res: Response) => {
  const activities = await prisma.jobActivity.findMany({
    where: { jobId: routeParam(req, "id") },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(activities);
});

export default router;
