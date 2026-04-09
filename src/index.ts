import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";

import healthRoutes from "./routes/health";
import analyticsRoutes from "./routes/analytics";
import jobsRoutes from "./routes/jobs";
import customersRoutes from "./routes/customers";
import invoicesRoutes from "./routes/invoices";
import estimatesRoutes from "./routes/estimates";
import authRoutes from "./routes/auth";
import alertsRoutes from "./routes/alerts";
import locationsRoutes from "./routes/locations";
import voipRoutes from "./routes/voip";
import posRoutes from "./routes/pos";
import softphoneRoutes from "./routes/softphone";
import dispatchRoutes from "./routes/dispatch";
import performanceRoutes from "./routes/performance";
import notificationsRoutes from "./routes/notifications";
import reportsRoutes from "./routes/reports";

const app = express();
const PORT = parseInt(process.env.PORT || "4000", 10);

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGINS?.split(",") || [
    "http://localhost:3000",
    "https://boltelectricnfl.com",
    "https://bolt-opx.vercel.app",
    "http://192.168.5.227:3001",
  ],
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(morgan("short"));

// Routes
app.use("/api", healthRoutes);
app.use("/api", analyticsRoutes);
app.use("/api", jobsRoutes);
app.use("/api", customersRoutes);
app.use("/api", invoicesRoutes);
app.use("/api", estimatesRoutes);
app.use("/api", authRoutes);
app.use("/api", alertsRoutes);
app.use("/api", locationsRoutes);
app.use("/api", voipRoutes);
app.use("/api", posRoutes);
app.use("/api", softphoneRoutes);
app.use("/api", dispatchRoutes);
app.use("/api", performanceRoutes);
app.use("/api", notificationsRoutes);
app.use("/api", reportsRoutes);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[Error]", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[boltopx-api] Running on 0.0.0.0:${PORT}`);
});

export default app;
