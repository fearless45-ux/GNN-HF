import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { runPythonScript } from "./utils/runPython.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsDir = path.resolve(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) =>
    cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`)
});

const upload = multer({ storage });

router.post("/", upload.single("ecgImage"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        status: "error",
        message: "No file uploaded"
      });
    }

    const filePath = req.file.path;

    // Python script
    const script = path.resolve(__dirname, "ml", "predict_ecg.py");

    const result = await runPythonScript(script, [filePath], {
      timeoutMS: 45000
    });

    if (result.code !== 0) {
      return res.status(500).json({
        status: "error",
        message: "Python execution failed",
        stderr: result.stderr
      });
    }

    let parsed = JSON.parse(result.stdout);

    // ⭐⭐ RETURN IMAGE PATH IN RESPONSE ⭐⭐
    parsed.imagePath = `/uploads/${req.file.filename}`;

    return res.json({
      status: "success",
      result: parsed
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: "error",
      message: "Server error during prediction"
    });
  }
});

export default router;
