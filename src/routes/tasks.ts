import { Router, Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { requireAuth } from "../auth";

const router = Router();
const prisma = new PrismaClient();

router.get("/tasks", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const { status, technicianId } = req.query;
    const where: any = {};
    if (status && typeof status === "string") where.status = status;
    if (technicianId && typeof technicianId === "string") where.technicianId = technicianId;

    const tasks = await prisma.task.findMany({
      where,
      include: {
        technician: { select: { id: true, firstName: true, lastName: true, color: true } },
        job: { select: { id: true, jobNumber: true, title: true } },
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
      take: 100,
    });
    res.json({ data: tasks });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/tasks", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const { title, description, priority, dueDate, technicianId, jobId } = req.body;
    const task = await prisma.task.create({
      data: { title, description, priority: priority || "medium", status: "pending", dueDate: dueDate ? new Date(dueDate) : null, technicianId, jobId, createdById: (req as any).user.id },
    });
    res.status(201).json(task);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.put("/tasks/:id", requireAuth as any, async (req: Request, res: Response) => {
  try {
    const { status, title, description, priority, dueDate, technicianId } = req.body;
    const data: any = {};
    if (status) data.status = status;
    if (status === "completed") data.completedAt = new Date();
    if (title) data.title = title;
    if (description !== undefined) data.description = description;
    if (priority) data.priority = priority;
    if (dueDate) data.dueDate = new Date(dueDate);
    if (technicianId) data.technicianId = technicianId;

    const task = await prisma.task.update({ where: { id: req.params.id }, data });
    res.json(task);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
