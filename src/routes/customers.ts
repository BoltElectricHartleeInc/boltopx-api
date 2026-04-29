import { Router, Request, Response } from "express";
import { prisma } from "../db";
import { requireAuth } from "../auth";
import { routeParam } from "../routeParam";

const router = Router();

router.get("/customers", requireAuth, async (req: Request, res: Response) => {
  const page = parseInt(String(Array.isArray(req.query.page) ? req.query.page[0] : req.query.page || "")) || 1;
  const limit = Math.min(parseInt(String(Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit || "")) || 25, 100);
  const search = String(Array.isArray(req.query.search) ? req.query.search[0] : req.query.search || "");

  const where: any = { deletedAt: null };
  if (search) {
    where.OR = [
      { firstName: { contains: search, mode: "insensitive" } },
      { lastName: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { phone: { contains: search, mode: "insensitive" } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.customer.count({ where }),
  ]);
  res.json({ data, total, page, limit, pages: Math.ceil(total / limit) });
});

router.get("/customers/:id", requireAuth, async (req: Request, res: Response) => {
  const customer = await prisma.customer.findUnique({
    where: { id: routeParam(req, "id") },
    include: { jobs: { orderBy: { createdAt: "desc" }, take: 10 }, invoices: { orderBy: { createdAt: "desc" }, take: 10 } },
  });
  if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }
  res.json(customer);
});

router.post("/customers", requireAuth, async (req: Request, res: Response) => {
  const customer = await prisma.customer.create({ data: req.body });
  res.status(201).json(customer);
});

router.put("/customers/:id", requireAuth, async (req: Request, res: Response) => {
  const customer = await prisma.customer.update({ where: { id: routeParam(req, "id") }, data: req.body });
  res.json(customer);
});

export default router;
