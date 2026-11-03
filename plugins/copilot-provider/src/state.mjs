import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const BUILD_ID = typeof __COPILOT_BUILD_ID__ === 'string' ? __COPILOT_BUILD_ID__ : 'source';

export function getPaths(env = process.env) {
  const codexHome = path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const dataDir = path.resolve(env.COPILOT_PROXY_HOME || path.join(codexHome, 'copilot-proxy'));
  return { codexHome, dataDir, configFile: path.join(codexHome, 'config.toml'),
    settingsFile: path.join(dataDir, 'settings.json'), keyFile: path.join(dataDir, 'local-key'),
    processFile: path.join(dataDir, 'process.json'), logFile: path.join(dataDir, 'proxy.log') };
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${path.basename(file)}: ${error.name}`); }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try { await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

export async function readSettings(paths = getPaths()) {
  return { version: 1, port: 43128, accountId: null, model: null, credentialFiles: [], ...await readJson(paths.settingsFile, {}) };
}

export async function updateSettings(patch, paths = getPaths()) {
  const settings = { ...await readSettings(paths), ...patch };
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw new Error('Invalid local port.');
  await writeJson(paths.settingsFile, settings);
  return settings;
}

export async function localKey(paths = getPaths()) {
  await fs.mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  try { await fs.writeFile(paths.keyFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = (await fs.readFile(paths.keyFile, 'utf8')).trim();
    if (/^[a-f0-9]{64}$/.test(key)) return key;
    // Another process may have won the exclusive create and still be completing its first write.
    await delay(25);
  }
  throw new Error('Invalid local proxy credential.');
}

export function publicAccount(account) {
  return { id: account.id, host: account.host, login: account.login, source: account.source };
}

export function safeError(error) {
  return String(error?.message || 'Operation failed').replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+|token\s+\S+)/gi, '[redacted]').slice(0, 600);
}
