import { Router, Request, Response } from "express";
import { getCurrentUser } from "../auth";
import { prisma } from "../db";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const router = Router();

const SESSION_HASH_ENABLED = process.env.SESSION_HASH_ENABLED !== "false";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

router.get("/auth/me", async (req: Request, res: Response) => {
  const user = await getCurrentUser(req);
  if (!user) { res.status(401).json({ error: "Not authenticated" }); return; }
  res.json(user);
});

router.post("/auth/login", async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) { res.status(400).json({ error: "Email and password required" }); return; }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, email: true, name: true, role: true, passwordHash: true, isActive: true, technicianId: true },
  });

  if (!user || !user.isActive) { res.status(401).json({ error: "Invalid credentials" }); return; }
  if (!user.passwordHash) { res.status(401).json({ error: "Password not set. Use the web dashboard to set your password." }); return; }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) { res.status(401).json({ error: "Invalid credentials" }); return; }

  // Create session
  const rawToken = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  await prisma.session.create({
    data: {
      sessionToken: SESSION_HASH_ENABLED ? hashToken(rawToken) : rawToken,
      expiresAt,
      userId: user.id,
    },
  });

  // Set cookie for web clients
  res.setHeader("Set-Cookie", `bolt-session=${rawToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`);

  // Also return token in body for native clients
  res.json({
    token: rawToken,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

router.post("/auth/logout", async (req: Request, res: Response) => {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/bolt-session=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : null;

  if (token) {
    const lookup = SESSION_HASH_ENABLED ? hashToken(token) : token;
    await prisma.session.deleteMany({ where: { sessionToken: lookup } }).catch(() => {});
    // Also try plaintext fallback
    if (SESSION_HASH_ENABLED) {
      await prisma.session.deleteMany({ where: { sessionToken: token } }).catch(() => {});
    }
  }

  res.setHeader("Set-Cookie", "bolt-session=; Path=/; HttpOnly; Max-Age=0");
  res.json({ ok: true });
});

export default router;
