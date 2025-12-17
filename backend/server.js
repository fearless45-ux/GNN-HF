import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import logger from "./utils/logger.js";
import { requestIdMiddleware } from "./middleware/requestId.js";

// Routes
import authRoutes from "./routes/auth.js";
import predictRoutes from "./routes/predict.js";
import saveRoute from "./routes/save.js";
import reportRoute from "./routes/reports.js";
import updatePasswordRoute from "./routes/updatePassword.js";
import dashboardStatsRoute from "./routes/dashboardStats.js";
import { runPythonScript } from "./utils/runPython.js";

// Models
import User from "./models/User.js";
import users from "./data/users.js";

dotenv.config();
const app = express();

// Fix dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================================
// SIMPLE GLOBAL CORS FOR RENDER DEPLOYMENT
// =========================================
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// =========================================
// SECURITY MIDDLEWARE
// =========================================
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: false,
  })
);

app.use(requestIdMiddleware);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Serve uploaded ECG images
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

// =========================================
// DATABASE CONNECTION
// =========================================
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    logger.info("MongoDB Connected");

    // Insert default users if not present
    for (const u of users) {
      const exists = await User.findOne({ email: u.email });
      if (!exists) await User.create(u);
    }
  })
  .catch((err) =>
    logger.error("Mongo Connection Error", { error: err.message })
  );

// =========================================
// RATE LIMITING
// =========================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    status: "error",
    message: "Too many authentication requests, please try again later",
  },
});

const predictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: {
    status: "error",
    message: "Too many prediction requests, try again later",
  },
});

// =========================================
// ROUTES
// =========================================
app.use("/api/auth", authLimiter, authRoutes);

// IMPORTANT: only ONE predict route
app.use("/api/predict", predictLimiter, predictRoutes);

app.use("/api", saveRoute);
app.use("/api", reportRoute);
app.use("/api", updatePasswordRoute);
app.use("/api", dashboardStatsRoute);

// =========================================
// DEFAULT ROUTES
// =========================================
app.get("/", (req, res) => {
  res.send("🔥 GNN-HF Backend API Running");
});

app.get("/health", (req, res) => {
  const healthcheck = {
    uptime: process.uptime(),
    message: "OK",
    timestamp: Date.now(),
    database: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  };
  res.status(200).json(healthcheck);
});

// =========================================
// 404 HANDLER
// =========================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// =========================================
// GLOBAL ERROR HANDLER
// =========================================
app.use((err, req, res, next) => {
  logger.error("Global error", { error: err.message, stack: err.stack });

  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(400).json({
      success: false,
      message: "File too large. Max size is 10MB.",
    });
  }

  res.status(500).json({
    success: false,
    message: "Internal server error",
  });
});

// =========================================
// START SERVER
// =========================================
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () =>
  logger.info(`Server running on port ${PORT}`)
);

// Attempt a non-blocking model warmup after server start to avoid cold-start timeouts
(async function warmupModels() {
  try {
    const candidates = [
      path.join(__dirname, '..', 'ml', 'predict_real.py'),
      path.join(__dirname, '..', 'ml', 'predict_ecg.py'),
      path.join(process.cwd(), 'ml', 'predict_real.py'),
      path.join(process.cwd(), 'ml', 'predict_ecg.py')
    ];
    const script = candidates.find((p) => fs.existsSync(p));
    if (!script) {
      logger.info('No prediction script found for warmup');
      return;
    }

    logger.info('Warming up prediction script to pre-load models', { script: script });
    const start = Date.now();
    try {
      await runPythonScript(script, ['__WARMUP__'], { timeoutMS: 120000 });
    } catch (err) {
      logger.info('Warmup completed (expected failure on invalid path) ', { tookMS: Date.now() - start, stdout: err.stdout ? err.stdout.substring(0, 500) : undefined });
      return;
    }
    logger.info('Warmup finished quickly', { tookMS: Date.now() - start });
  } catch (err) {
    logger.error('Warmup error', { error: err.message });
  }
})();

// =========================================
// GRACEFUL SHUTDOWN
// =========================================
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received, shutting down...`);

  server.close(() => {
    logger.info("Server closed");

    mongoose.connection.close(false, () => {
      logger.info("MongoDB connection closed");
      process.exit(0);
    });
  });

  setTimeout(() => {
    logger.error("Forced shutdown due to timeout");
    process.exit(1);
  }, 10000);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled Rejection", { reason });
  gracefulShutdown("unhandledRejection");
});

process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception", { error: err.message });
  gracefulShutdown("uncaughtException");
});
