import express from "express";
import PatientReport from "../models/PatientReport.js";
import User from "../models/User.js";
import { authMiddleware } from "../middleware/auth.js";
import fs from "fs";
import path from "path";

const router = express.Router();

// ===================================================================
// ⭐ SAVE REPORT API (Now stores Base64 + ImagePath)
// ===================================================================
router.post("/save-report", authMiddleware, async (req, res) => {
  try {
    const email = req.user.email; // Get from authenticated user
    const {
      imagePath,
      predictedClass,
      riskLevel,
      riskScore,
      confidence,
      probabilities,
      patientData, // New: patient data from upload form
    } = req.body;

    if (!imagePath) {
      return res.status(400).json({
        status: "error",
        message: "Image path missing",
      });
    }

    if (!patientData) {
      return res.status(400).json({
        status: "error",
        message: "Patient data is required",
      });
    }

    // ===================================================================
    // ⭐ GET USER'S DATA FROM DATABASE
    // ===================================================================
    const user = await User.findOne({ email }).lean();
    
    if (!user) {
      return res.status(404).json({
        status: "error",
        message: "User not found",
      });
    }

    if (!user.patientId) {
      return res.status(400).json({
        status: "error",
        message: "User does not have a patient ID assigned",
      });
    }

    // Extract patient info from the upload form data
    const name = patientData.patientName || "Unknown";
    const age = parseInt(patientData.age) || 0;
    const gender = patientData.gender || "Not specified";
    const symptoms = patientData.symptoms || "";
    const medicalHistory = patientData.medicalHistory || "";

    // ===================================================================
    // ⭐ SAVE NEW REPORT
    // ===================================================================
    // If imageBase64 not sent, try to derive it from imagePath (uploaded file)
    let imageBase64ToStore = req.body.imageBase64;
    if (!imageBase64ToStore && imagePath) {
      try {
        const diskPath = path.join(process.cwd(), imagePath.replace(/^\//, ""));
        if (fs.existsSync(diskPath)) {
          const buff = fs.readFileSync(diskPath);
          const mime = "image/png"; // uploads are normalized to png/jpg - safe default
          imageBase64ToStore = `data:${mime};base64,${buff.toString("base64")}`;
        }
      } catch (err) {
        // Log and continue without blocking save
        console.warn("Could not derive imageBase64 from imagePath:", err.message);
      }
    }

    const report = await PatientReport.create({
      userEmail: email,
      patientId: user.patientId, // Use user's unique patient ID
      name,
      age,
      gender,
      symptoms,
      medicalHistory,
      
      // ⭐ BOTH STORED
      imagePath,
      imageBase64: imageBase64ToStore,

      predictedClass,
      riskLevel,
      riskScore,
      confidence,
      probabilities,
    });

    return res.json({
      status: "success",
      message: "Report saved successfully",
      patientId: user.patientId,
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
