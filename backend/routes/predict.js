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
    // Resolve script path by trying a list of candidate locations/names so redeploys
    // that rename files still work. Prefer scripts next to this route file.
    const candidates = [
      path.resolve(__dirname, '..', 'ml', 'predict_real.py'),
      path.resolve(__dirname, '..', 'ml', 'predict_ecg.py'),
      path.resolve(process.cwd(), 'ml', 'predict_real.py'),
      path.resolve(process.cwd(), 'ml', 'predict_ecg.py'),
      path.resolve(process.cwd(), 'backend', 'ml', 'predict_real.py'),
      path.resolve(process.cwd(), 'backend', 'ml', 'predict_ecg.py')
    ];

    let script = null;
    const tried = [];
    for (const c of candidates) {
      tried.push(c);
      if (fs.existsSync(c)) { script = c; break; }
    }

    if (!script) {
      console.error('Predict script not found. Tried paths:', tried);
      return res.status(500).json({ success: false, message: 'Prediction script not found on server' });
    }

    console.log('Using Python script:', script);

    // Allow more time for initial model loading on cold starts (models are loaded at import time)
    // Increase to 120s to accommodate slow disk/network during deploys. Adjust later if needed.
    const result = await runPythonScript(script, [filePath], { timeoutMS: 120000 }); // allow up to 120s

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
    // surface timeout and python messages with better status codes and helpful content
    console.error('Predict route error:', err && err.message ? err.message : err);
    if (err && typeof err.message === 'string' && err.message.includes('timed out')) {
      // include any captured stdout/stderr to help debugging (but keep small)
      return res.status(504).json({ success: false, message: err.message, stdout: err.stdout ? String(err.stdout).slice(0, 2000) : undefined, stderr: err.stderr ? String(err.stderr).slice(0, 2000) : undefined });
    }
    return res.status(500).json({ success: false, message: err.message || 'Prediction failed' });
  }
});

export default router;

// =========================
// Debug endpoint: which prediction script is available?
// =========================
router.get('/script-check', (req, res) => {
  const candidates = [
    path.resolve(__dirname, '..', 'ml', 'predict_real.py'),
    path.resolve(__dirname, '..', 'ml', 'predict_ecg.py'),
    path.resolve(process.cwd(), 'ml', 'predict_real.py'),
    path.resolve(process.cwd(), 'ml', 'predict_ecg.py'),
    path.resolve(process.cwd(), 'backend', 'ml', 'predict_real.py'),
    path.resolve(process.cwd(), 'backend', 'ml', 'predict_ecg.py')
  ];

  const found = candidates.find((c) => fs.existsSync(c));
  if (found) return res.json({ available: true, script: path.basename(found) });
  return res.json({ available: false, tried: candidates.map(p => path.basename(p)) });
});

// Light-weight warmup endpoint: triggers the Python script once to pre-load models
router.post('/script-warmup', async (req, res) => {
  try {
    const candidates = [
      path.resolve(__dirname, '..', 'ml', 'predict_real.py'),
      path.resolve(__dirname, '..', 'ml', 'predict_ecg.py'),
      path.resolve(process.cwd(), 'ml', 'predict_real.py'),
      path.resolve(process.cwd(), 'ml', 'predict_ecg.py')
    ];
    const script = candidates.find((c) => fs.existsSync(c));
    if (!script) return res.status(404).json({ warmed: false, message: 'No prediction script found' });

    const start = Date.now();
    try {
      // pass an obviously invalid path so script imports models then fails quickly
      await runPythonScript(script, ['__WARMUP__'], { timeoutMS: 120000 });
    } catch (err) {
      // We expect an error because the dummy path is invalid; but models should now be loaded
      const ms = Date.now() - start;
      return res.json({ warmed: true, tookMS: ms, stdout: err.stdout ? String(err.stdout).slice(0, 2000) : undefined, stderr: err.stderr ? String(err.stderr).slice(0, 2000) : undefined });
    }
    const ms = Date.now() - start;
    return res.json({ warmed: true, tookMS: ms });
  } catch (err) {
    return res.status(500).json({ warmed: false, message: err.message });
  }
});