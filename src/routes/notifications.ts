import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";

const router = Router();

// ── Send SMS notification ────────────────────────────────────
async function sendSMS(to: string, body: string): Promise<boolean> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !auth || !from) return false;

  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${auth}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    return true;
  } catch { return false; }
}

// ── Send email notification ──────────────────────────────────
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "notifications@boltelectricnfl.com";
  if (!key) return false;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `Bolt Electric <${from}>`, to: [to], subject, html }),
    });
    return true;
  } catch { return false; }
}

// ── Notify customer of job status ────────────────────────────
router.post("/notifications/job-status", requireAuth, async (req: Request, res: Response) => {
  const { jobId, status } = req.body;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      customer: { select: { firstName: true, phone: true, email: true } },
      technician: { select: { firstName: true } },
    },
  });
  if (!job || !job.customer) { res.status(404).json({ error: "Job or customer not found" }); return; }

  const name = job.customer.firstName || "there";
  const techName = job.technician?.firstName || "your technician";
  const messages: Record<string, string> = {
    "en-route": `Hi ${name}! ${techName} from Bolt Electric is on the way to you now. 🔧⚡`,
    "arrived": `Hi ${name}, ${techName} has arrived! Please let them in. ⚡`,
    "completed": `Hi ${name}, the job is complete! Thank you for choosing Bolt Electric. ⚡ We'd love a review: https://g.page/boltelectricjax/review`,
    "scheduled": `Hi ${name}, your service with Bolt Electric has been scheduled for ${job.scheduledDate ? new Date(job.scheduledDate).toLocaleDateString() : "soon"}. We'll text when we're on the way!`,
  };

  const message = messages[status];
  if (!message) { res.status(400).json({ error: "No notification template for this status" }); return; }

  const results: any = { sms: false, email: false };

  if (job.customer.phone) {
    results.sms = await sendSMS(job.customer.phone, message);
  }
  if (job.customer.email) {
    results.email = await sendEmail(
      job.customer.email,
      `Bolt Electric — Job Update`,
      `<div style="font-family:Arial;max-width:500px;margin:0 auto;"><h2 style="color:#E8D44D;">⚡ Bolt Electric</h2><p>${message}</p><p style="color:#999;font-size:12px;">(904) 701-3312 • boltelectricnfl.com</p></div>`
    );
  }

  // Log notification
  await prisma.notification.create({
    data: {
      type: "job_status",
      title: `Job ${job.jobNumber}: ${status}`,
      body: message,
      userId: (req as any).user.id,
      metadata: { jobId, status, sms: results.sms, email: results.email },
    },
  });

  res.json({ sent: results, message });
});

// ── Notify technician of new assignment ──────────────────────
router.post("/notifications/tech-assignment", requireAuth, async (req: Request, res: Response) => {
  const { jobId, technicianId } = req.body;

  const [job, tech] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId }, include: { customer: { select: { firstName: true, lastName: true, address: true } } } }),
    prisma.technician.findUnique({ where: { id: technicianId }, select: { firstName: true, phone: true } }),
  ]);

  if (!job || !tech) { res.status(404).json({ error: "Job or technician not found" }); return; }

  const msg = `New job assigned: ${job.jobNumber} — ${job.title}. Customer: ${job.customer?.firstName || "N/A"} ${job.customer?.lastName || ""}. ${job.scheduledDate ? "Scheduled: " + new Date(job.scheduledDate).toLocaleDateString() : "Not yet scheduled."} Address: ${job.customer?.address || job.address || "TBD"}`;

  let sent = false;
  if (tech.phone) sent = await sendSMS(tech.phone, msg);

  res.json({ sent, to: tech.firstName });
});

// ── List notifications ───────────────────────────────────────
router.get("/notifications", requireAuth, async (req: Request, res: Response) => {
  const notifications = await prisma.notification.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json(notifications);
});

export default router;
