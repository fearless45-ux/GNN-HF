import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { runPythonScript } from '../utils/runPython.js';

const router = express.Router();

// Determine __dirname in ES module context and set directories relative to this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// uploads directory (create if missing) — resolve relative to backend folder (avoid backend/backend)
const uploadsDir = path.resolve(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
});
// limit to 10MB and accept any field name (handle in handler)
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/', upload.any(), async (req, res) => {
  try {
    // pick first uploaded file (supports field "image" or "file" or any)
    const file = req.file || (req.files && req.files[0]);
    if (!file) {
      return res.status(400).json({ success: false, message: 'No file uploaded. Use form field "image" or "file".' });
    }
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return res.status(400).json({ success: false, message: 'Uploaded file must be an image' });
    }
    const filePath = file.path;
    // resolve script path relative to this route file (reliable across workdirs)
    let script = path.resolve(__dirname, '..', 'ml', 'predict_real.py');
    if (!fs.existsSync(script)) {
      // fallback to project-root ml folder (older layout)
      script = path.resolve(process.cwd(), 'ml', 'predict_real.py');
    }

    if (!fs.existsSync(script)) {
      console.error('Predict script not found at', script);
      return res.status(500).json({ success: false, message: 'Prediction script not found on server' });
    }
    console.log('Using Python script:', script);

    const result = await runPythonScript(script, [filePath], { timeoutMS: 30000 }); // allow up to 30s

    console.log('Predict python result:', { code: result.code, python: result.python, stdoutLen: result.stdout?.length, stderrLen: result.stderr?.length });

    if (result.code !== 0) {
      return res.status(500).json({
        success: false,
        message: 'Python script error',
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code
      });
    }

    // predict_real.py should print JSON to stdout
    try {
      const parsed = JSON.parse(result.stdout);
      return res.json(parsed);
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: 'Invalid JSON output from Python',
        parseError: err.message,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
  } catch (err) {
    // surface timeout and python messages
    console.error('Predict route error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

export default router;