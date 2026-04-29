import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";
import PDFDocument from "pdfkit";

const router = Router();

// ── Process payment against invoice ──────────────────────────
router.post("/pos/pay", requireAuth, async (req: Request, res: Response) => {
  const { invoiceId, amount, method, tipAmount, notes, reference, signatureDataUrl } = req.body;

  if (!invoiceId || !amount || amount <= 0) {
    res.status(400).json({ error: "invoiceId and positive amount required" });
    return;
  }

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }

  const totalPayment = (amount || 0) + (tipAmount || 0);

  // If credit card → Stripe payment intent
  if (method === "credit_card" || method === "stripe") {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) { res.status(500).json({ error: "Stripe not configured" }); return; }

    try {
      const stripeRes = await fetch("https://api.stripe.com/v1/payment_intents", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          amount: String(Math.round(totalPayment * 100)), // cents
          currency: "usd",
          "automatic_payment_methods[enabled]": "true",
          description: `Invoice ${invoice.invoiceNumber}`,
          "metadata[invoiceId]": invoiceId,
          "metadata[invoiceNumber]": invoice.invoiceNumber,
        }),
      });
      const pi = await stripeRes.json() as any;

      if (pi.error) {
        res.status(400).json({ error: pi.error.message });
        return;
      }

      // Record payment as pending (will be confirmed via webhook or client-side)
      const payment = await prisma.payment.create({
        data: {
          invoiceId,
          amount: totalPayment,
          tipAmount: tipAmount || 0,
          method: "stripe",
          stripePaymentIntentId: pi.id,
          notes,
          reference,
        },
      });

      res.json({
        paymentId: payment.id,
        clientSecret: pi.client_secret,
        stripePaymentIntentId: pi.id,
        status: "requires_confirmation",
      });
      return;
    } catch (err) {
      res.status(500).json({ error: "Stripe payment failed" });
      return;
    }
  }

  // Cash / check / ACH — record immediately
  const payment = await prisma.payment.create({
    data: {
      invoiceId,
      amount: totalPayment,
      tipAmount: tipAmount || 0,
      method: method || "cash",
      notes,
      reference,
    },
  });

  // Update invoice paid amount
  const newPaid = invoice.amountPaid + totalPayment;
  const newStatus = newPaid >= invoice.total ? "paid" : invoice.status;
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      amountPaid: newPaid,
      status: newStatus,
      paidDate: newStatus === "paid" ? new Date() : invoice.paidDate,
    },
  });

  // Save signature if provided
  if (signatureDataUrl) {
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { notes: (invoice.notes || "") + "\n[Signature captured at POS]" },
    });
  }

  res.json({
    paymentId: payment.id,
    status: "completed",
    invoiceStatus: newStatus,
    amountPaid: newPaid,
    remaining: Math.max(invoice.total - newPaid, 0),
  });
});

// ── Confirm Stripe payment (after client-side confirmation) ──
router.post("/pos/confirm", requireAuth, async (req: Request, res: Response) => {
  const { paymentIntentId } = req.body;
  if (!paymentIntentId) { res.status(400).json({ error: "paymentIntentId required" }); return; }

  const payment = await prisma.payment.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
  if (!payment) { res.status(404).json({ error: "Payment not found" }); return; }

  const invoice = await prisma.invoice.findUnique({ where: { id: payment.invoiceId } });
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }

  // Update invoice
  const newPaid = invoice.amountPaid + payment.amount;
  const newStatus = newPaid >= invoice.total ? "paid" : invoice.status;
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      amountPaid: newPaid,
      status: newStatus,
      paidDate: newStatus === "paid" ? new Date() : invoice.paidDate,
    },
  });

  res.json({ status: "confirmed", invoiceStatus: newStatus, amountPaid: newPaid });
});

// ── Offline payment sync (batch upload from field) ───────────
router.post("/pos/sync", requireAuth, async (req: Request, res: Response) => {
  const { payments } = req.body;
  if (!Array.isArray(payments) || payments.length === 0) {
    res.status(400).json({ error: "payments array required" });
    return;
  }

  const results = [];
  for (const p of payments) {
    try {
      const invoice = await prisma.invoice.findUnique({ where: { id: p.invoiceId } });
      if (!invoice) { results.push({ invoiceId: p.invoiceId, status: "error", error: "Not found" }); continue; }

      const payment = await prisma.payment.create({
        data: {
          invoiceId: p.invoiceId,
          amount: p.amount + (p.tipAmount || 0),
          tipAmount: p.tipAmount || 0,
          method: p.method || "cash",
          notes: p.notes ? `[Offline] ${p.notes}` : "[Offline payment]",
          reference: p.reference,
        },
      });

      const newPaid = invoice.amountPaid + payment.amount;
      const newStatus = newPaid >= invoice.total ? "paid" : invoice.status;
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { amountPaid: newPaid, status: newStatus, paidDate: newStatus === "paid" ? new Date() : undefined },
      });

      results.push({ invoiceId: p.invoiceId, paymentId: payment.id, status: "synced" });
    } catch (err) {
      results.push({ invoiceId: p.invoiceId, status: "error", error: "Failed" });
    }
  }

  res.json({ synced: results.filter(r => r.status === "synced").length, failed: results.filter(r => r.status === "error").length, results });
});

// ── Quick invoice for field POS ──────────────────────────────
router.post("/pos/quick-invoice", requireAuth, async (req: Request, res: Response) => {
  const { customerId, jobId, items, notes } = req.body;

  const lineItems = items || [];
  const subtotal = lineItems.reduce((sum: number, i: any) => sum + (i.quantity || 1) * (i.unitPrice || 0), 0);
  const taxRate = 0.075;
  const taxAmount = subtotal * taxRate;
  const total = subtotal + taxAmount;

  // Generate invoice number
  const lastInv = await prisma.invoice.findFirst({ orderBy: { invoiceNumber: "desc" }, select: { invoiceNumber: true } });
  const nextNum = lastInv ? parseInt(lastInv.invoiceNumber.replace(/\D/g, "")) + 1 : 1001;
  const invoiceNumber = `INV-${nextNum}`;

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber,
      customerId,
      jobId,
      status: "sent",
      subtotal,
      taxRate,
      taxAmount,
      total,
      notes,
      lineItems: {
        create: lineItems.map((item: any, idx: number) => ({
          description: item.description,
          quantity: item.quantity || 1,
          unitPrice: item.unitPrice || 0,
          total: (item.quantity || 1) * (item.unitPrice || 0),
          sortOrder: idx,
        })),
      },
    },
    include: { lineItems: true, customer: true },
  });

  res.status(201).json(invoice);
});

// ── Payment history for invoice ──────────────────────────────
router.get("/pos/payments/:invoiceId", requireAuth, async (req: Request, res: Response) => {
  const payments = await prisma.payment.findMany({
    where: { invoiceId: req.params.invoiceId },
    orderBy: { paidAt: "desc" },
  });
  res.json(payments);
});

// ── Capture signature ────────────────────────────────────────
router.post("/pos/signature/:invoiceId", requireAuth, async (req: Request, res: Response) => {
  const { signatureDataUrl } = req.body;
  if (!signatureDataUrl) { res.status(400).json({ error: "signatureDataUrl required" }); return; }

  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.invoiceId } });
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }

  // Store signature data URL in notes (or a dedicated field if you add one)
  await prisma.invoice.update({
    where: { id: req.params.invoiceId },
    data: { notes: (invoice.notes || "") + `\n[SIGNATURE:${signatureDataUrl.substring(0, 50)}...]` },
  });

  res.json({ status: "captured", invoiceId: req.params.invoiceId });
});

// ── Generate receipt PDF ─────────────────────────────────────
router.get("/pos/receipt/:invoiceId", requireAuth, async (req: Request, res: Response) => {
  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.invoiceId },
    include: {
      customer: true,
      lineItems: { orderBy: { sortOrder: "asc" } },
      payments: { orderBy: { paidAt: "desc" } },
      job: { select: { jobNumber: true, title: true } },
    },
  });
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }

  const doc = new PDFDocument({ size: "letter", margin: 50 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename=receipt-${invoice.invoiceNumber}.pdf`);
  doc.pipe(res);

  // Header
  doc.fontSize(24).font("Helvetica-Bold").text("BOLT ELECTRIC", { align: "center" });
  doc.fontSize(10).font("Helvetica").text("Licensed Electrical Contractor • EC13005160", { align: "center" });
  doc.fontSize(10).text("(904) 701-3312 • boltelectricnfl.com", { align: "center" });
  doc.moveDown(1.5);

  // Receipt title
  doc.fontSize(18).font("Helvetica-Bold").text("RECEIPT", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(10).font("Helvetica")
    .text(`Invoice #: ${invoice.invoiceNumber}`)
    .text(`Date: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`)
    .text(`Status: ${invoice.status.toUpperCase()}`);

  if (invoice.customer) {
    doc.moveDown(0.5)
      .text(`Customer: ${invoice.customer.firstName || ""} ${invoice.customer.lastName || ""}`)
      .text(`Phone: ${invoice.customer.phone || "N/A"}`)
      .text(`Email: ${invoice.customer.email || "N/A"}`);
  }
  if (invoice.job) {
    doc.text(`Job: ${invoice.job.jobNumber} — ${invoice.job.title || ""}`);
  }

  doc.moveDown(1);

  // Line items
  if (invoice.lineItems.length > 0) {
    doc.fontSize(11).font("Helvetica-Bold").text("Description", 50, doc.y, { width: 250 });
    doc.text("Qty", 310, doc.y - 14, { width: 50, align: "center" });
    doc.text("Price", 370, doc.y - 14, { width: 80, align: "right" });
    doc.text("Total", 460, doc.y - 14, { width: 80, align: "right" });
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(540, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font("Helvetica").fontSize(10);
    for (const item of invoice.lineItems) {
      const y = doc.y;
      doc.text(item.description, 50, y, { width: 250 });
      doc.text(String(item.quantity), 310, y, { width: 50, align: "center" });
      doc.text(`$${item.unitPrice.toFixed(2)}`, 370, y, { width: 80, align: "right" });
      doc.text(`$${item.total.toFixed(2)}`, 460, y, { width: 80, align: "right" });
      doc.moveDown(0.5);
    }
  }

  doc.moveDown(0.5);
  doc.moveTo(350, doc.y).lineTo(540, doc.y).stroke();
  doc.moveDown(0.3);

  // Totals
  doc.fontSize(10).font("Helvetica");
  doc.text(`Subtotal:`, 350, doc.y, { width: 100, align: "right" });
  doc.text(`$${invoice.subtotal.toFixed(2)}`, 460, doc.y - 14, { width: 80, align: "right" });
  doc.text(`Tax (${(invoice.taxRate * 100).toFixed(1)}%):`, 350, doc.y, { width: 100, align: "right" });
  doc.text(`$${invoice.taxAmount.toFixed(2)}`, 460, doc.y - 14, { width: 80, align: "right" });
  doc.moveDown(0.3);
  doc.fontSize(12).font("Helvetica-Bold");
  doc.text(`Total:`, 350, doc.y, { width: 100, align: "right" });
  doc.text(`$${invoice.total.toFixed(2)}`, 460, doc.y - 14, { width: 80, align: "right" });
  doc.text(`Paid:`, 350, doc.y, { width: 100, align: "right" });
  doc.text(`$${invoice.amountPaid.toFixed(2)}`, 460, doc.y - 14, { width: 80, align: "right" });

  const balance = invoice.total - invoice.amountPaid;
  if (balance > 0) {
    doc.fillColor("red").text(`Balance:`, 350, doc.y, { width: 100, align: "right" });
    doc.text(`$${balance.toFixed(2)}`, 460, doc.y - 14, { width: 80, align: "right" });
    doc.fillColor("black");
  }

  // Payments
  if (invoice.payments.length > 0) {
    doc.moveDown(1.5);
    doc.fontSize(11).font("Helvetica-Bold").text("Payment History");
    doc.moveDown(0.3);
    doc.fontSize(9).font("Helvetica");
    for (const p of invoice.payments) {
      doc.text(`${new Date(p.paidAt).toLocaleDateString()} — ${p.method} — $${p.amount.toFixed(2)}${p.tipAmount > 0 ? ` (incl. $${p.tipAmount.toFixed(2)} tip)` : ""}`);
    }
  }

  // Footer
  doc.moveDown(2);
  doc.fontSize(9).font("Helvetica").fillColor("gray");
  doc.text("Thank you for choosing Bolt Electric!", { align: "center" });
  doc.text("Licensed • Insured • Satisfaction Guaranteed", { align: "center" });

  doc.end();
});

// ── Email receipt ────────────────────────────────────────────
router.post("/pos/receipt/:invoiceId/email", requireAuth, async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) { res.status(400).json({ error: "email required" }); return; }

  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.invoiceId },
    include: { customer: true },
  });
  if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }

  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || "receipts@boltelectricnfl.com";

  if (!resendKey) { res.status(500).json({ error: "Email not configured" }); return; }

  try {
    const emailRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `Bolt Electric <${fromEmail}>`,
        to: [email],
        subject: `Receipt — Invoice ${invoice.invoiceNumber}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
            <h2 style="color:#E8D44D;">⚡ Bolt Electric</h2>
            <p>Thank you for your payment!</p>
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px 0;color:#666;">Invoice</td><td style="text-align:right;font-weight:bold;">${invoice.invoiceNumber}</td></tr>
              <tr><td style="padding:8px 0;color:#666;">Total</td><td style="text-align:right;font-weight:bold;">$${invoice.total.toFixed(2)}</td></tr>
              <tr><td style="padding:8px 0;color:#666;">Paid</td><td style="text-align:right;font-weight:bold;color:#22C55E;">$${invoice.amountPaid.toFixed(2)}</td></tr>
              ${invoice.total - invoice.amountPaid > 0 ? `<tr><td style="padding:8px 0;color:#666;">Balance</td><td style="text-align:right;font-weight:bold;color:#EF4444;">$${(invoice.total - invoice.amountPaid).toFixed(2)}</td></tr>` : ""}
            </table>
            <p style="color:#666;font-size:12px;margin-top:24px;">Bolt Electric • Licensed Electrical Contractor • EC13005160<br>(904) 701-3312 • boltelectricnfl.com</p>
          </div>
        `,
      }),
    });
    const result = await emailRes.json();
    res.json({ status: "sent", emailId: result.id, to: email });
  } catch (err) {
    res.status(500).json({ error: "Failed to send email" });
  }
});

export default router;
