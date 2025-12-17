import { spawn, spawnSync } from 'child_process';

function pythonCandidates() {
  const env = process.env.PYTHON_PATH ? [process.env.PYTHON_PATH] : [];
  // Prefer 'python' on Windows, then 'py', then 'python3'
  return [...env, 'python', 'py', 'python3'].filter(Boolean);
}

function findAvailablePython() {
  for (const exe of pythonCandidates()) {
    try {
      const res = spawnSync(exe, ['--version'], { timeout: 2000 });
      // spawnSync may write version to stderr on some installs
      if (res.status === 0 || res.stdout?.length || res.stderr?.length) return exe;
    } catch (e) {
      // ignore and try next
    }
  }
  return null;
}

export function getPythonExecutable() {
  // If user explicitly set PYTHON_PATH, try validating it first
  const envPath = process.env.PYTHON_PATH;
  if (envPath) {
    try {
      const res = spawnSync(envPath, ['--version'], { timeout: 2000 });
      if (res.status === 0 || res.stdout?.length || res.stderr?.length) {
        return envPath;
      }
      console.warn(`PYTHON_PATH set to '${envPath}' but it didn't respond to --version; falling back to system candidates`);
    } catch (e) {
      console.warn(`PYTHON_PATH='${envPath}' is not executable: ${e.message}; falling back to system candidates`);
    }
  }

  const found = findAvailablePython();
  if (found) return found;
  // final fallback
  return 'python';
}

export function runPythonScript(scriptPath, args = [], options = {}) {
  const timeoutMS = typeof options.timeoutMS === 'number' ? options.timeoutMS : 20000; // default 20s
  return new Promise((resolve, reject) => {
    const py = getPythonExecutable();
    // use -u to force unbuffered output so we get stdout/stderr promptly
    const child = spawn(py, ['-u', scriptPath, ...args], { shell: false, ...options.spawnOptions });

    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    const timer = timeoutMS > 0 ? setTimeout(() => {
      killedByTimeout = true;
      try { child.kill(); } catch (e) { /* ignore */ }
    }, timeoutMS) : null;

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (err && err.code === 'ENOENT') {
        return reject(new Error(`Python executable not found: ${py}. Install Python or set PYTHON_PATH to python.exe (e.g. C:\\Program Files\\Python\\python.exe)`));
      }
      return reject(err);
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killedByTimeout) {
        return reject(new Error(`Python script timed out after ${timeoutMS}ms`));
      }
      return resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), python: py, signal });
    });
  });
}