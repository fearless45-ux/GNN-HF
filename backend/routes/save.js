import express from "express";
import PatientReport from "../models/PatientReport.js";
import User from "../models/User.js";
import { authMiddleware } from "../middleware/auth.js";
import fs from "fs";
import path from "path";

const router = express.Router();

// ===================================================================
// ⭐ SAVE REPORT API — FIXED FOR BOTH FRONTEND CASES
// ===================================================================
router.post("/save-report", authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;

    // Accept BOTH camelCase and snake_case
    const imagePath = req.body.imagePath;

    const predicted_class =
      req.body.predicted_class || req.body.predictedClass;

    const risk_level =
      req.body.risk_level || req.body.riskLevel;

    const risk_score =
      req.body.risk_score || req.body.riskScore;

    const confidence = req.body.confidence;
    const probabilities = req.body.probabilities;
    const patientData = req.body.patientData;

    // 🔥 Validate
    if (!patientData) {
      return res.status(400).json({
        status: "error",
        message: "Patient data is required",
      });
    }

    if (!imagePath) {
      return res.status(400).json({
        status: "error",
        message: "Image path missing",
      });
    }

    // =======================
    // Get user
    // =======================
    const user = await User.findOne({ email }).lean();
    if (!user) {
      return res.status(404).json({
        status: "error",
        message: "User not found",
      });
    }

    // =======================
    // Extract Patient Info
    // =======================
    const name = patientData.patientName;
    const age = parseInt(patientData.age);
    const gender = patientData.gender;
    const symptoms = patientData.symptoms;
    const medicalHistory = patientData.medicalHistory;

    // ===================================================================
    // ⭐ Convert image to base64
    // ===================================================================
    let imageBase64ToStore = req.body.imageBase64;
    if (!imageBase64ToStore && imagePath) {
      try {
        const diskPath = path.join(process.cwd(), imagePath.replace(/^\//, ""));
        if (fs.existsSync(diskPath)) {
          const buff = fs.readFileSync(diskPath);
          imageBase64ToStore = `data:image/png;base64,${buff.toString("base64")}`;
        }
      } catch (err) {
        console.warn("⚠️ Could not derive imageBase64:", err.message);
      }
    }

    // ===================================================================
    // ⭐ Create report
    // ===================================================================
    const report = await PatientReport.create({
      userEmail: email,
      patientId: user.patientId,
      name,
      age,
      gender,
      symptoms,
      medicalHistory,

      // Store both
      imagePath,
      imageBase64: imageBase64ToStore,

      // Final normalized fields
      predictedClass: predicted_class,
      riskLevel: risk_level,
      riskScore: risk_score,
      confidence,
      probabilities,
    });

    return res.json({
      status: "success",
      message: "Report saved successfully",
      report,
    });
  } catch (error) {
    console.error("❌ SAVE REPORT ERROR:", error);
    return res.status(500).json({
      status: "error",
      message: "Server error while saving report",
      details: error.toString(),
    });
  }
});

export default router;
