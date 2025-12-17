
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { authMiddleware } from "./middleware/auth.js";
import PQueue from "p-queue";
import logger from "./utils/logger.js";

const router = express.Router();

// ML Prediction Queue - limit concurrent Python spawns
const mlQueue = new PQueue({ concurrency: 2 }); // max 2 concurrent predictions

// Fix __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================
// 📁 Ensure Upload Folder Exists (backend/uploads)
// =============================================================
const uploadFolder = path.join(process.cwd(), "uploads");

if (!fs.existsSync(uploadFolder)) {
  fs.mkdirSync(uploadFolder, { recursive: true });
  logger.info("Upload folder created", { path: uploadFolder });
} else {
  logger.info("Upload folder exists", { path: uploadFolder });
}

// Initial cleanup on startup
cleanOldUploads();

// =============================================================
// 📸 Multer Storage Config
// =============================================================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadFolder),
  filename: (req, file, cb) => {
    const uniquePrefix = crypto.randomBytes(12).toString("hex");
    const cleanExt = path.extname(file.originalname).toLowerCase() || "";
    cb(null, `${Date.now()}-${uniquePrefix}${cleanExt}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) return cb(null, true);
    cb(new Error("Only image files are allowed"));
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Periodic cleanup to avoid disk bloat
setInterval(cleanOldUploads, 12 * 60 * 60 * 1000).unref();

// =============================================================
// 🧹 Helper: Clean uploads older than 24 hours
// =============================================================
function cleanOldUploads() {
  fs.readdir(uploadFolder, (err, files) => {
    if (err) return logger.error("cleanup.readDir", { error: err.message });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h
    files.forEach((file) => {
      const filePath = path.join(uploadFolder, file);
      fs.stat(filePath, (err, stat) => {
        if (err) return;
        if (stat.mtimeMs < cutoff) {
          fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr) logger.error("cleanup.unlink", { error: unlinkErr.message, file });
            else logger.info("Old upload removed", { file });
          });
        }
      });
    });
  });
}

// =============================================================
// 🐍 Python Execution Helper
// Runs a Python script and returns trimmed stdout. Throws on non-zero exit.
// =============================================================
function runPython(script, args = []) {
  return new Promise((resolve, reject) => {
    logger.debug("Running Python script", { script, args });

    // Detect Python executable: prefer override via PYTHON_PATH
    let pythonPath = process.env.PYTHON_PATH;
    if (!pythonPath) {
      pythonPath = process.platform === "win32" ? "python" : "python3";
    }

    const py = spawn(pythonPath, [script, ...args], {
      cwd: process.cwd(),
      shell: false,
    });

    let output = "";
    let errors = "";

    py.stdout.on("data", (data) => (output += data.toString()));
    py.stderr.on("data", (data) => {
      const errMsg = data.toString();
      errors += errMsg;
      logger.debug("Python Stderr", { message: errMsg });
    });

    py.on("error", (err) => {
      logger.error("Python spawn error", { error: err.message });
      reject(new Error(`Failed to spawn Python: ${err.message}`));
    });

    py.on("close", (code) => {
      if (code !== 0) reject(new Error(`Python exited with code ${code}\n${errors}`));
      else resolve(output.trim());
    });
  });
}

// =============================================================
// 🚀 FINAL PREDICT ROUTE (Does NOT save to DB)
// Returns:
// - result from Python (JSON)
// - imagePath (public URL)
// - imageBase64 (for MongoDB storage)
// =============================================================
router.post("/", authMiddleware, upload.single("ecgImage"), async (req, res) => {
  const log = req.log || logger;

  try {
    if (!req.file)
      return res.status(400).json({ status: "error", message: "No ECG image uploaded" });

    // FULL OS FILE PATH (Python needs this)
    const imgOSPath = req.file.path;

    // PUBLIC FRONTEND URL PATH
    const imgPublicPath = "/uploads/" + req.file.filename;

    log.info("Image uploaded for prediction", { imagePath: imgPublicPath });

    // Convert image → Base64 for MongoDB
    const imageBase64 = "data:image/png;base64," + fs.readFileSync(imgOSPath, { encoding: "base64" });

    // Path to Python script - USE REAL MODEL
    const scriptPath = path.join(process.cwd(), "ml", "predict_real.py");

    // Execute Python with concurrency control
    const rawOutput = await mlQueue.add(async () => {
      log.info("Running ML prediction", { queueSize: mlQueue.size, pending: mlQueue.pending });
      return await runPython(scriptPath, [imgOSPath]);
    });

    log.debug("Python output received", { output: rawOutput.substring(0, 200) });

    let jsonData;
    try {
      jsonData = JSON.parse(rawOutput);
    } catch (err) {
      log.error("Invalid JSON from Python", { output: rawOutput });
      return res.status(500).json({ status: "error", message: "Invalid JSON returned by Python", pythonOutput: rawOutput });
    }

    // If the Python script returned a structured failure (e.g., image not valid ECG)
    if (jsonData.success === false || jsonData.is_valid_ecg === false) {
      // Return a 400 with the Python-provided message and details so the client can present it
      const clientMsg = jsonData.message || jsonData.error || "Image is not a valid ECG";
      log.warn("Python validation failed for uploaded image", { pythonOutput: jsonData });
      return res.status(400).json({ status: "error", message: clientMsg, pythonOutput: jsonData });
    }

    // Normalize common alternate key names and coerce simple types to expected shapes
    const normalized = {
      predictedClass: jsonData.predictedClass ?? (jsonData.predicted_class != null ? String(jsonData.predicted_class) : undefined),
      riskLevel: jsonData.riskLevel ?? jsonData.risk_level,
      riskScore: jsonData.riskScore ?? jsonData.risk_score ?? (jsonData.risk != null ? Number(jsonData.risk) : undefined),
      confidence: jsonData.confidence ?? (jsonData.conf != null ? Number(jsonData.conf) : undefined),
      probabilities: jsonData.probabilities ?? jsonData.probs,
      // include any other fields untouched for debugging
      _raw: jsonData,
    };

    const validationError = validatePredictionResult(normalized);
    if (validationError) {
      log.error("Prediction validation failed", { error: validationError, pythonOutput: jsonData });
      return res.status(500).json({ status: "error", message: "Invalid prediction payload", details: validationError, pythonOutput: jsonData });
    }

    // Attach image paths to normalized response
    normalized.imagePath = imgPublicPath; // for UI
    normalized.imageBase64 = imageBase64; // for MongoDB

    log.info("Prediction successful", { predictedClass: normalized.predictedClass, confidence: normalized.confidence });

    return res.json({ status: "success", result: normalized });
  } catch (err) {
    log.error("Predict route error", { error: err.message, stack: err.stack });
    return res.status(500).json({ status: "error", message: "Prediction failed", details: err.toString() });
  }
});

export default router;

// Basic shape validation for Python prediction output
function validatePredictionResult(data) {
  if (!data || typeof data !== "object") return "Result is not an object";

  const { predictedClass, riskLevel, riskScore, confidence, probabilities } = data;

  if (!predictedClass || typeof predictedClass !== "string") return "predictedClass missing or invalid";
  if (!riskLevel || typeof riskLevel !== "string") return "riskLevel missing or invalid";
  if (riskScore === undefined || isNaN(Number(riskScore))) return "riskScore missing or invalid";
  if (confidence === undefined || isNaN(Number(confidence))) return "confidence missing or invalid";
  if (probabilities && typeof probabilities !== "object") return "probabilities must be an object when provided";

  return null;
}

