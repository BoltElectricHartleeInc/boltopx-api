import { prisma } from "./db";
import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

const SESSION_HASH_ENABLED = process.env.SESSION_HASH_ENABLED !== "false";

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

async function findSessionByToken(token: string) {
  const primaryLookup = SESSION_HASH_ENABLED ? hashToken(token) : token;
  let session = await prisma.session.findUnique({
    where: { sessionToken: primaryLookup },
    include: {
      user: {
        select: {
          id: true, email: true, name: true, role: true, isActive: true,
          technicianId: true, onboardingCompleted: true, onboardingStep: true, tourCompleted: true,
        },
      },
    },
  });
  if (session) return session;

  // Legacy fallback: plaintext token
  if (SESSION_HASH_ENABLED) {
    session = await prisma.session.findUnique({
      where: { sessionToken: token },
      include: {
        user: {
          select: {
            id: true, email: true, name: true, role: true, isActive: true,
            technicianId: true, onboardingCompleted: true, onboardingStep: true, tourCompleted: true,
          },
        },
      },
    });
  }
  return session;
}

async function resolvePosition(technicianId: string | null): Promise<string> {
  if (!technicianId) return "OWNER";
  const tech = await prisma.technician.findUnique({
    where: { id: technicianId },
    select: { position: true },
  });
  return tech?.position || "OWNER";
}

export async function validateSession(token: string) {
  if (!token) return null;
  const session = await findSessionByToken(token);
  if (!session) return null;
  if (session.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (!session.user.isActive) return null;
  const position = await resolvePosition(session.user.technicianId);
  return { ...session.user, position };
}

export async function getCurrentUser(req: Request) {
  // 1. bolt-session cookie
  const cookieHeader = req.headers.cookie || "";
  const cookies = parseCookies(cookieHeader);
  const cookieToken = cookies["bolt-session"];
  if (cookieToken) return validateSession(cookieToken);

  // 2. Bearer token (iOS native)
  const authHeader = req.headers.authorization ?? "";
  if (authHeader.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken) return validateSession(bearerToken);
  }
  return null;
}

export type AuthUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

/** Express middleware: attaches req.user or returns 401 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = await getCurrentUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  (req as any).user = user;
  next();
}
