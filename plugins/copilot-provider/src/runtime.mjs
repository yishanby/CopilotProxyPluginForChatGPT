import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { getPaths, localKey, readSettings, readJson, writeJson, BUILD_ID } from './state.mjs';

export async function inspectService(paths = getPaths(), fetchImpl = fetch) {
  const { port } = await readSettings(paths);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const response = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(800) });
    const body = await response.json();
    if (body.service !== 'copilot-proxy-plugin' || body.version !== 1) return { running: false, occupied: true, baseUrl };
    // An authenticated probe prevents adopting somebody else's proxy on the same port.
    const authenticated = await fetchImpl(`${baseUrl}/admin/status`, {
      headers: { Authorization: `Bearer ${await localKey(paths)}` }, signal: AbortSignal.timeout(1200),
    });
    if (!authenticated.ok) return { running: false, occupied: true, baseUrl };
    const status = await authenticated.json();
    return { running: true, baseUrl, cliPath: status.cliPath, buildId: status.buildId, activeRequests: status.activeRequests ?? 0 };
  } catch (error) {
    if (error.name === 'SyntaxError') return { running: false, occupied: true, baseUrl };
    return { running: false, baseUrl };
  }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function ensureRunning({ paths = getPaths(), cliPath, timeoutMs = 15000, spawnImpl = spawn, fetchImpl = fetch } = {}) {
  if (!cliPath || !path.isAbsolute(cliPath)) throw new Error('An absolute plugin CLI path is required.');
  await localKey(paths);
  const lockDir = path.join(paths.dataDir, 'start.lock');
  const lockFile = path.join(lockDir, 'owner.json');
  const deadline = Date.now() + timeoutMs;
  let locked = false;
  const samePackage = service => {
    const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    return typeof service.cliPath === 'string' && normalize(service.cliPath) === normalize(cliPath) && service.buildId === BUILD_ID;
  };
  while (Date.now() < deadline) {
    const service = await inspectService(paths, fetchImpl);
    if (service.running && samePackage(service)) return service;
    if (service.running) {
      if (service.activeRequests > 0) throw new Error('The previous plugin version has active requests. Finish them before starting the updated plugin.');
      await stopService(paths);
    }
    if (service.occupied) throw new Error('The configured local port belongs to another service. Select another port in setup.');
    try {
      await fs.mkdir(lockDir);
      await writeJson(lockFile, { pid: process.pid, createdAt: Date.now() });
      locked = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.stat(lockDir).catch(() => null);
      const owner = await readJson(lockFile).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30000 && !alive(owner?.pid)) {
        await fs.rm(lockFile, { force: true });
        await fs.rmdir(lockDir).catch(() => {});
      }
      await delay(150);
    }
  }
  if (!locked) throw new Error('Timed out waiting for another proxy startup. Retry setup.');
  try {
    const existing = await inspectService(paths, fetchImpl);
    if (existing.running && samePackage(existing)) return existing;
    if (existing.running) throw new Error('Another plugin version started concurrently. Retry setup after its requests finish.');
    if (existing.occupied) throw new Error('The configured port is already in use.');
    const logStat = await fs.stat(paths.logFile).catch(() => null);
    if (logStat?.size > 1024 * 1024) await fs.rename(paths.logFile, `${paths.logFile}.previous`).catch(() => {});
    const fd = openSync(paths.logFile, 'a', 0o600);
    try {
      const child = spawnImpl(process.execPath, [cliPath, 'serve'], {
        detached: true, windowsHide: true, stdio: ['ignore', fd, fd], cwd: path.dirname(cliPath),
        env: { ...process.env, CODEX_HOME: paths.codexHome, COPILOT_PROXY_HOME: paths.dataDir },
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { closeSync(fd); }
    while (Date.now() < deadline) {
      const service = await inspectService(paths, fetchImpl);
      if (service.running && samePackage(service)) return service;
      if (service.occupied) throw new Error('Another service claimed the configured local port.');
      await delay(150);
    }
    throw new Error(`Proxy did not become ready. Check ${paths.logFile}.`);
  } finally {
    const owner = await readJson(lockFile).catch(() => null);
    if (owner?.pid === process.pid) { await fs.rm(lockFile, { force: true }); await fs.rmdir(lockDir).catch(() => {}); }
  }
}

export async function stopService(paths = getPaths()) {
  const service = await inspectService(paths);
  if (!service.running) return service;
  const response = await fetch(`${service.baseUrl}/admin/shutdown`, {
    method: 'POST', headers: { Authorization: `Bearer ${await localKey(paths)}` }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('The running proxy refused the shutdown request.');
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(100);
    if (!(await inspectService(paths)).running) return { running: false };
  }
  throw new Error('Proxy is still draining requests. Retry status shortly.');
}

export async function openBrowser(url) {
  let executable, args;
  if (process.platform === 'win32') {
    executable = 'powershell.exe';
    // Fixed script; the URL is delivered through the environment, never interpolated into shell code.
    args = ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:COPILOT_SETUP_URL'];
  } else if (process.platform === 'darwin') { executable = 'open'; args = [url]; }
  else { executable = 'xdg-open'; args = [url]; }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore', env: { ...process.env, COPILOT_SETUP_URL: url } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Could not open the local account selector in a browser.')));
  });
}
