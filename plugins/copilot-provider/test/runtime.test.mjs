import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { ensureRunning, inspectService, stopService } from '../src/runtime.mjs';
import { getPaths, localKey, updateSettings } from '../src/state.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-plugin-runtime-'));
  const paths = getPaths({ CODEX_HOME: root });
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await updateSettings({ port }, paths);
  t.after(async () => {
    await stopService(paths).catch(() => {});
    assert.ok(path.basename(root).startsWith('copilot-plugin-runtime-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, paths, port };
}

test('concurrent startup creates one detached service and waits for authenticated readiness', async t => {
  const { root, paths } = await fixture(t);
  const cliPath = path.join(root, 'server with spaces.mjs');
  await fs.writeFile(cliPath, `
    import http from 'node:http';
    import fs from 'node:fs';
    import path from 'node:path';
    import {fileURLToPath} from 'node:url';
    const dir = process.env.COPILOT_PROXY_HOME;
    const key = fs.readFileSync(path.join(dir,'local-key'),'utf8').trim();
    const {port} = JSON.parse(fs.readFileSync(path.join(dir,'settings.json'),'utf8'));
    fs.appendFileSync(path.join(dir,'starts'),'start\\n');
    const server = http.createServer((req,res) => {
      res.setHeader('Content-Type','application/json');
      if (req.url === '/health') { res.end(JSON.stringify({service:'copilot-proxy-plugin',version:1})); return; }
      if(req.headers.authorization !== 'Bearer '+key){res.writeHead(401);res.end('{}');return;}
      res.end(JSON.stringify({cliPath:fileURLToPath(import.meta.url),buildId:'source',activeRequests:0}));
      if(req.url === '/admin/shutdown') setImmediate(()=>{server.close();server.closeIdleConnections();});
    });
    server.listen(port,'127.0.0.1');
  `);
  const results = await Promise.all(Array.from({ length: 4 }, () => ensureRunning({ paths, cliPath })));
  assert.ok(results.every(result => result.running));
  assert.equal(await fs.readFile(path.join(paths.dataDir, 'starts'), 'utf8'), 'start\n');
  assert.equal((await inspectService(paths)).running, true);
  const installedPath = path.join(root, 'installed package.mjs');
  await fs.copyFile(cliPath, installedPath);
  const installed = await ensureRunning({ paths, cliPath: installedPath });
  assert.equal(installed.cliPath, installedPath);
  assert.equal(await fs.readFile(path.join(paths.dataDir, 'starts'), 'utf8'), 'start\nstart\n');
  assert.equal((await stopService(paths)).running, false);
});

test('does not adopt or stop a different service using the configured port', async t => {
  const { paths, port, root } = await fixture(t);
  let shutdownCalled = false;
  const other = http.createServer((req, res) => {
    if (req.url === '/admin/shutdown') shutdownCalled = true;
    if (req.url === '/health') res.end(JSON.stringify({ service: 'copilot-proxy-plugin', version: 1 }));
    else { res.writeHead(401); res.end('{}'); }
  });
  await new Promise(resolve => other.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => other.close(resolve)));
  await assert.rejects(ensureRunning({ paths, cliPath: path.join(root, 'unused.mjs') }), /another service/);
  assert.equal((await stopService(paths)).occupied, true);
  assert.equal(shutdownCalled, false);
});

test('local credential creation is stable across concurrent invocations', async t => {
  const { paths } = await fixture(t);
  const keys = await Promise.all(Array.from({ length: 12 }, () => localKey(paths)));
  assert.equal(new Set(keys).size, 1);
  assert.match(keys[0], /^[a-f0-9]{64}$/);
});

test('does not replace an older package while it is serving a request', async t => {
  const { paths, port, root } = await fixture(t);
  const key = await localKey(paths);
  let shutdownCalled = false;
  const busy = http.createServer((req, res) => {
    if (req.url === '/health') { res.end(JSON.stringify({ service: 'copilot-proxy-plugin', version: 1 })); return; }
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    if (req.url === '/admin/shutdown') shutdownCalled = true;
    res.end(JSON.stringify({ cliPath: path.join(root, 'old.mjs'), buildId: 'old', activeRequests: 1 }));
  });
  await new Promise(resolve => busy.listen(port, '127.0.0.1', resolve));
  try {
    await assert.rejects(ensureRunning({ paths, cliPath: path.join(root, 'new.mjs') }), /active requests/);
    assert.equal(shutdownCalled, false);
  } finally { await new Promise(resolve => busy.close(resolve)); }
});
