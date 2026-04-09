import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";

const router = Router();

// ── List calls with filtering ────────────────────────────────
router.get("/voip/calls", requireAuth, async (req: Request, res: Response) => {
  const page = parseInt(String(req.query.page || "")) || 1;
  const limit = Math.min(parseInt(String(req.query.limit || "")) || 25, 100);
  const direction = String(req.query.direction || "");
  const status = String(req.query.status || "");
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");

  const where: any = {};
  if (direction) where.direction = direction;
  if (status) where.status = status;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  const [data, total] = await Promise.all([
    prisma.phoneCall.findMany({
      where,
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
        technician: { select: { id: true, firstName: true, lastName: true } },
        lead: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.phoneCall.count({ where }),
  ]);

  res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
});

// ── Single call detail ───────────────────────────────────────
router.get("/voip/calls/:id", requireAuth, async (req: Request, res: Response) => {
  const call = await prisma.phoneCall.findUnique({
    where: { id: req.params.id },
    include: {
      customer: true,
      technician: true,
      lead: true,
      tagAssignments: { include: { callTag: true } },
      dispositions: true,
      voicemails: true,
    },
  });
  if (!call) { res.status(404).json({ error: "Call not found" }); return; }
  res.json(call);
});

// ── Call metrics / analytics ─────────────────────────────────
router.get("/voip/metrics", requireAuth, async (req: Request, res: Response) => {
  const from = req.query.from ? new Date(String(req.query.from || "")) : new Date(new Date().setDate(new Date().getDate() - 30));
  const to = req.query.to ? new Date(String(req.query.to || "")) : new Date();

  const [total, inbound, outbound, missed, avgDuration, byHour] = await Promise.all([
    prisma.phoneCall.count({ where: { createdAt: { gte: from, lte: to } } }),
    prisma.phoneCall.count({ where: { direction: "inbound", createdAt: { gte: from, lte: to } } }),
    prisma.phoneCall.count({ where: { direction: "outbound", createdAt: { gte: from, lte: to } } }),
    prisma.phoneCall.count({ where: { status: "missed", createdAt: { gte: from, lte: to } } }),
    prisma.phoneCall.aggregate({ where: { createdAt: { gte: from, lte: to }, duration: { not: null } }, _avg: { duration: true } }),
    prisma.$queryRawUnsafe<any[]>(`
      SELECT EXTRACT(HOUR FROM "createdAt") as hour, COUNT(*)::int as count
      FROM "PhoneCall" WHERE "createdAt" >= $1 AND "createdAt" <= $2
      GROUP BY EXTRACT(HOUR FROM "createdAt") ORDER BY hour
    `, from, to),
  ]);

  res.json({
    total, inbound, outbound, missed,
    avgDuration: Math.round(avgDuration._avg.duration || 0),
    missedRate: total > 0 ? (missed / total * 100).toFixed(1) : "0",
    byHour: byHour.map((r: any) => ({ hour: Number(r.hour), count: r.count })),
  });
});

// ── Log inbound call (Twilio webhook) ────────────────────────
router.post("/voip/webhook/inbound", async (req: Request, res: Response) => {
  const { CallSid, From, To, CallStatus, Direction } = req.body;

  // Auto-match caller to customer
  const cleanPhone = From?.replace(/\D/g, "").slice(-10);
  const customer = cleanPhone
    ? await prisma.customer.findFirst({ where: { phone: { contains: cleanPhone } } })
    : null;

  const call = await prisma.phoneCall.upsert({
    where: { twilioSid: CallSid },
    create: {
      twilioSid: CallSid,
      direction: Direction || "inbound",
      from: From || "",
      to: To || "",
      status: CallStatus || "ringing",
      customerId: customer?.id,
    },
    update: { status: CallStatus },
  });

  // Smart routing: customer's tech → available techs → owner → voicemail
  const routeResult = await smartRoute(customer?.id || null);

  // Auto-record ALL calls
  const recordAttrs = `record="record-from-answer-dual" recordingStatusCallback="/api/voip/webhook/recording" recordingStatusCallbackEvent="completed"`;

  if (routeResult.type === "technician" && routeResult.phone) {
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="20" callerId="${To}" action="/api/voip/webhook/dial-fallback" ${recordAttrs}>
    <Number>${routeResult.phone}</Number>
  </Dial>
</Response>`);
  } else {
    const ownerPhone = process.env.LUMEN_OWNER_PHONE || process.env.TWILIO_FORWARD_TO;
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="25" callerId="${To}" action="/api/voip/webhook/dial-fallback" ${recordAttrs}>
    <Number>${ownerPhone}</Number>
  </Dial>
</Response>`);
  }
});

// ── Smart routing logic ──────────────────────────────────────
async function smartRoute(customerId: string | null): Promise<{ type: string; phone?: string; techId?: string; reason: string }> {
  // 1. If customer has an active job, route to that job's technician
  if (customerId) {
    const activeJob = await prisma.job.findFirst({
      where: { customerId, status: { in: ["scheduled", "assigned", "in-progress"] }, deletedAt: null, technicianId: { not: null } },
      include: { technician: { select: { id: true, phone: true, firstName: true } } },
      orderBy: { scheduledDate: "asc" },
    });
    if (activeJob?.technician?.phone) {
      // Check if tech is available (not on another call)
      const onCall = await prisma.phoneCall.findFirst({
        where: { technicianId: activeJob.technicianId!, status: { in: ["in-progress", "ringing"] } },
      });
      if (!onCall) {
        return { type: "technician", phone: activeJob.technician.phone, techId: activeJob.technicianId!, reason: `Routed to ${activeJob.technician.firstName} (assigned tech)` };
      }
    }
  }

  // 2. Round-robin available technicians
  const availableTechs = await prisma.technician.findMany({
    where: { isActive: true, phone: { not: null } },
    select: { id: true, phone: true, firstName: true },
  });
  for (const tech of availableTechs) {
    const onCall = await prisma.phoneCall.findFirst({
      where: { technicianId: tech.id, status: { in: ["in-progress", "ringing"] } },
    });
    if (!onCall && tech.phone) {
      return { type: "technician", phone: tech.phone, techId: tech.id, reason: `Routed to ${tech.firstName} (next available)` };
    }
  }

  // 3. Fall back to owner
  return { type: "owner", reason: "No techs available, routing to owner" };
}

// ── Dial fallback (if no answer, go to voicemail) ────────────
router.post("/voip/webhook/dial-fallback", async (req: Request, res: Response) => {
  const { DialCallStatus } = req.body;
  if (DialCallStatus === "completed" || DialCallStatus === "answered") {
    res.type("text/xml").send("<Response/>");
    return;
  }
  // No answer — voicemail
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">We're sorry, no one is available right now. Please leave a message after the beep.</Say>
  <Record maxLength="120" transcribe="true" transcribeCallback="/api/voip/webhook/transcription"
          recordingStatusCallback="/api/voip/webhook/recording" recordingStatusCallbackEvent="completed" />
</Response>`);
});

// ── Recording webhook ────────────────────────────────────────
router.post("/voip/webhook/recording", async (req: Request, res: Response) => {
  const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = req.body;
  if (CallSid && RecordingUrl) {
    await prisma.phoneCall.updateMany({
      where: { twilioSid: CallSid },
      data: { recordingUrl: `${RecordingUrl}.mp3` },
    });
    console.log(`[VoIP] Recording saved for ${CallSid}: ${RecordingUrl} (${RecordingDuration}s)`);
  }
  res.sendStatus(200);
});

// ── Get recording audio (proxy to avoid exposing Twilio URL) ─
router.get("/voip/calls/:id/recording", requireAuth, async (req: Request, res: Response) => {
  const call = await prisma.phoneCall.findUnique({ where: { id: req.params.id }, select: { recordingUrl: true } });
  if (!call?.recordingUrl) { res.status(404).json({ error: "No recording" }); return; }
  res.json({ url: call.recordingUrl });
});

// ── Call status update webhook ───────────────────────────────
router.post("/voip/webhook/status", async (req: Request, res: Response) => {
  const { CallSid, CallStatus, CallDuration, RecordingUrl } = req.body;
  if (CallSid) {
    await prisma.phoneCall.updateMany({
      where: { twilioSid: CallSid },
      data: {
        status: CallStatus || "completed",
        duration: CallDuration ? parseInt(CallDuration) : undefined,
        recordingUrl: RecordingUrl || undefined,
      },
    });
  }
  res.type("text/xml").send("<Response/>");
});

// ── Transcription webhook ────────────────────────────────────
router.post("/voip/webhook/transcription", async (req: Request, res: Response) => {
  const { CallSid, TranscriptionText } = req.body;
  if (CallSid && TranscriptionText) {
    await prisma.phoneCall.updateMany({
      where: { twilioSid: CallSid },
      data: { transcription: TranscriptionText },
    });
  }
  res.sendStatus(200);
});

// ── Click-to-call (outbound) ─────────────────────────────────
router.post("/voip/call", requireAuth, async (req: Request, res: Response) => {
  const { to, customerId, jobId } = req.body;
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioAuth = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

  if (!twilioSid || !twilioAuth || !twilioFrom) {
    res.status(500).json({ error: "Twilio not configured" });
    return;
  }

  try {
    // Create call via Twilio REST API
    const twilioRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls.json`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + Buffer.from(`${twilioSid}:${twilioAuth}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: to,
        From: twilioFrom,
        Url: `${process.env.APP_URL || "https://api.boltopx.com"}/api/voip/webhook/outbound-connect`,
        StatusCallback: `${process.env.APP_URL || "https://api.boltopx.com"}/api/voip/webhook/status`,
      }),
    });
    const twilioData = await twilioRes.json();

    // Log the call
    const call = await prisma.phoneCall.create({
      data: {
        twilioSid: twilioData.sid,
        direction: "outbound",
        from: twilioFrom,
        to,
        status: "initiated",
        customerId: customerId || null,
      },
    });

    res.json({ callId: call.id, twilioSid: twilioData.sid, status: "initiated" });
  } catch (err) {
    res.status(500).json({ error: "Failed to initiate call" });
  }
});

// ── Outbound connect TwiML ───────────────────────────────────
router.post("/voip/webhook/outbound-connect", (_req: Request, res: Response) => {
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${process.env.TWILIO_PHONE_NUMBER}">
    <Number>${_req.body.To}</Number>
  </Dial>
</Response>`);
});

// ── Add note to call ─────────────────────────────────────────
router.post("/voip/calls/:id/note", requireAuth, async (req: Request, res: Response) => {
  const call = await prisma.phoneCall.update({
    where: { id: req.params.id },
    data: { notes: req.body.notes },
  });
  res.json(call);
});

// ── Add disposition ──────────────────────────────────────────
router.post("/voip/calls/:id/disposition", requireAuth, async (req: Request, res: Response) => {
  const disposition = await prisma.callDisposition.create({
    data: {
      phoneCallId: req.params.id,
      code: req.body.code,
      notes: req.body.notes,
    },
  });
  // Also update the quick disposition on the call itself
  await prisma.phoneCall.update({
    where: { id: req.params.id },
    data: { dispositionCode: req.body.code },
  });
  res.json(disposition);
});

export default router;
