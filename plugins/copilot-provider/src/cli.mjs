#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPaths, localKey, readSettings, updateSettings, writeJson, publicAccount, safeError } from './state.mjs';
import { ensureRunning, inspectService, stopService, openBrowser } from './runtime.mjs';
import { discoverAccounts } from './accounts.mjs';
import { restoreProvider } from './config.mjs';

const cliPath = fileURLToPath(import.meta.url);
const paths = getPaths();
const command = process.argv[2] || 'help';
const args = process.argv.slice(3);
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  if (command === 'serve') {
    const { startServer } = await import('./proxy.mjs');
    const running = await startServer({ paths, cliPath });
    await writeJson(paths.processFile, { pid: process.pid, startedAt: new Date().toISOString() });
    const close = async () => { await running.close(); };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
    await new Promise(resolve => running.server.once('close', resolve));
    await fs.rm(paths.processFile, { force: true });
    return;
  }
  if (command === 'token') {
    await ensureRunning({ paths, cliPath });
    // This is a local gateway key for Codex's auth command, never a GitHub/Copilot token.
    process.stdout.write(`${await localKey(paths)}\n`);
    return;
  }
  if (command === 'hook') {
    const settings = await readSettings(paths);
    if (settings.accountId && settings.model) await ensureRunning({ paths, cliPath });
    return;
  }
  if (command === 'setup' || command === 'accounts-ui') {
    const port = flag('--port');
    if (port !== undefined) {
      const current = await readSettings(paths);
      if (current.accountId || current.model) throw new Error('Run restore before changing a configured port, then set up the provider again.');
      if ((await inspectService(paths)).running) throw new Error('Stop the proxy before changing its port.');
      await updateSettings({ port: Number(port) }, paths);
    }
    const service = await ensureRunning({ paths, cliPath });
    if (!args.includes('--no-open')) await openBrowser(`${service.baseUrl}/#key=${await localKey(paths)}`);
    console.log(args.includes('--no-open') ? `Proxy ready at ${service.baseUrl}. Run setup without --no-open to choose an account.` : 'Opened the local Copilot account selector. Choose an existing account and a Responses model, then apply.');
    return;
  }
  if (command === 'accounts') {
    const settings = await readSettings(paths);
    const accounts = await discoverAccounts({ credentialFiles: settings.credentialFiles, onWarning: warning => console.error(safeError(new Error(warning))) });
    console.log(JSON.stringify(accounts.map(publicAccount), null, 2));
    return;
  }
  if (command === 'add-credential-file') {
    const file = args[0];
    if (!file) throw new Error('Usage: add-credential-file <absolute-path>');
    const resolved = path.resolve(file);
    if (!(await fs.stat(resolved)).isFile()) throw new Error('Credential source must be a file.');
    const settings = await readSettings(paths);
    await updateSettings({ credentialFiles: [...new Set([...settings.credentialFiles, resolved])] }, paths);
    console.log('Credential source registered; run setup to refresh accounts. Source tokens are not copied.');
    return;
  }
  if (command === 'start') { console.log(JSON.stringify(await ensureRunning({ paths, cliPath }))); return; }
  if (command === 'status') {
    const settings = await readSettings(paths);
    console.log(JSON.stringify({ ...await inspectService(paths), accountId: settings.accountId, model: settings.model, logFile: paths.logFile }, null, 2));
    return;
  }
  if (command === 'stop') { console.log(JSON.stringify(await stopService(paths))); return; }
  if (command === 'restore') {
    console.log(JSON.stringify(await restoreProvider(paths), null, 2));
    await updateSettings({ accountId: null, model: null }, paths);
    await stopService(paths);
    return;
  }
  if (command !== 'help' && command !== '--help') throw new Error(`Unknown command: ${command}`);
  console.log('Copilot local provider\n\nsetup [--port N]   Open the existing-account selector\naccounts          List detected accounts (no tokens)\nadd-credential-file <path>  Add an existing exported credential source\nstatus | start | stop\nrestore           Restore provider settings before removing the plugin\n\nNode.js 22+ is required. No new GitHub login is performed.');
}

main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
