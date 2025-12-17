import express from "express";
import User from "../models/User.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { generateUniquePatientId } from "../utils/generatePatientId.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

/* --- new helper functions --- */
function getJwtExpiresIn() {
  const raw = process.env.JWT_EXPIRES_IN || process.env.JWT_EXPIRE || '7d';
  const s = String(raw ?? '').trim();
  if (s === '') return '7d';
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return s; // allow "7d", "1h", etc.
}

function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error('Missing JWT_SECRET env var');
    throw new Error('Missing JWT_SECRET');
  }
  return jwt.sign(payload, secret, { expiresIn: getJwtExpiresIn() });
}
/* --- end helpers --- */

/* ============================================
   SIGNUP ROUTE
=============================================== */
router.post("/signup", async (req, res) => {
  try {
    const { email, password, confirmPassword } = req.body;

    if (!email || !password || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "All fields are required"
      });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters"
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Email already registered. Please login."
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Create unique patient ID ONCE, only during signup
    const patientId = await generateUniquePatientId();

    const newUser = new User({
      email,
      password: hashedPassword,
      patientId,
      patientInfo: { isCompleted: false }
    });

    // Try saving and retry if patientId duplicates (race condition)
    const MAX_RETRIES = 5;
    let savedUser = null;
    let attempts = 0;
    while (!savedUser && attempts < MAX_RETRIES) {
      try {
        await newUser.save();
        savedUser = newUser;
      } catch (err) {
        // If duplicate patientId, regenerate and retry
        if (err && err.code === 11000 && err.keyPattern && err.keyPattern.patientId) {
          attempts++;
          console.warn(`Duplicate patientId on save, retrying (${attempts}/${MAX_RETRIES})`);
          newUser.patientId = await generateUniquePatientId();
          continue;
        }
        throw err;
      }
    }

    if (!savedUser) {
      return res.status(500).json({
        success: false,
        message: "Could not generate a unique patient ID, please try again"
      });
    }

    // Replace direct jwt.sign with signToken
    const token = signToken(
      { email: newUser.email, userId: newUser._id, patientId: newUser.patientId }
    );

    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      token,
      user: { email: newUser.email, patientId: newUser.patientId }
    });
  } catch (error) {
    console.error("Signup error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during signup"
    });
  }
});

/* ============================================
   LOGIN ROUTE
=============================================== */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Email not found"
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({
        success: false,
        message: "Incorrect password"
      });
    }

    // Replace in login as well
    const token = signToken(
      { email: user.email, userId: user._id, patientId: user.patientId }
    );

    return res.json({
      success: true,
      message: "Login successful",
      token,
      user: {
        email: user.email,
        patientId: user.patientId,
        patientInfoCompleted: user.patientInfo?.isCompleted
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during login"
    });
  }
});

/* ============================================
   CHECK PATIENT ID (NOW CHECKS ROOT patientId)
=============================================== */
router.get("/check-patient-id", async (req, res) => {
  try {
    const { patientId } = req.query;

    if (!patientId) {
      return res.status(400).json({
        available: false,
        message: "Patient ID is required"
      });
    }

    const existingUser = await User.findOne({ patientId });

    if (existingUser) {
      return res.json({
        available: false,
        message: "Patient ID already in use"
      });
    }

    return res.json({
      available: true,
      message: "Patient ID is available"
    });
  } catch (error) {
    console.error("Check patient ID error:", error);
    return res.status(500).json({
      available: false,
      message: "Server error checking patient ID"
    });
  }
});

/* ============================================
   SAVE PATIENT INFORMATION
=============================================== */
router.post("/patient-info", async (req, res) => {
  try {
    const {
      email,
      patientName,
      age,
      gender,
      contactNumber,
      patientEmail,
      symptoms,
      medicalHistory
    } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required"
      });
    }

    if (!patientName || !age || !gender || !contactNumber ||
        !patientEmail || !symptoms || !medicalHistory) {
      return res.status(400).json({
        success: false,
        message: "All fields are required"
      });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    // Do NOT overwrite patientId
    user.patientInfo = {
      patientName,
      age,
      gender,
      contactNumber,
      patientEmail,
      symptoms,
      medicalHistory,
      isCompleted: true
    };

    await user.save();

    return res.json({
      success: true,
      message: "Patient information saved successfully",
      user: { email: user.email, patientInfoCompleted: true }
    });
  } catch (error) {
    console.error("Patient info error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error saving patient information"
    });
  }
});

/* ============================================
   GET PROFILE
=============================================== */
router.get("/profile", authMiddleware, async (req, res) => {
  try {
    const email = req.user.email;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    return res.json({
      success: true,
      user: {
        email: user.email,
        patientId: user.patientId,
        patientInfo: user.patientInfo
      }
    });
  } catch (error) {
    console.error("Get profile error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error fetching profile"
    });
  }
});

export default router;
