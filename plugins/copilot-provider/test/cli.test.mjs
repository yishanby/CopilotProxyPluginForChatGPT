import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPaths, updateSettings, readSettings } from '../src/state.mjs';
const exec = promisify(execFile);
const cli = path.resolve('plugins/copilot-provider/src/cli.mjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-plugin-cli-'));
  const paths = getPaths({ CODEX_HOME: root });
  const env = { ...process.env, CODEX_HOME: root, COPILOT_PROXY_HOME: paths.dataDir };
  const run = (...args) => exec(process.execPath, [cli, ...args], { env, windowsHide: true, timeout: 20000 });
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  await updateSettings({ port }, paths);
  t.after(async () => { await run('stop').catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { paths, run };
}

test('standalone helper exits while its daemon stays usable; token stdout contains only local auth key', async t => {
  const { run } = await fixture(t);
  const started = JSON.parse((await run('start')).stdout);
  assert.equal(started.running, true);
  const token = await run('token');
  assert.match(token.stdout, /^[a-f0-9]{64}\r?\n$/);
  assert.equal(token.stderr, '');
  const status = JSON.parse((await run('status')).stdout);
  assert.equal(status.running, true);
  assert.equal(status.cliPath, cli);
  assert.equal(JSON.parse((await run('stop')).stdout).running, false);
});

test('changing a configured port cannot strand the existing provider if setup is cancelled', async t => {
  const { paths, run } = await fixture(t);
  await updateSettings({ accountId: 'existing', model: 'existing-model' }, paths);
  const before = await readSettings(paths);
  await assert.rejects(run('setup', '--port', '43298', '--no-open'), error => /Run restore before changing/.test(error.stderr));
  assert.deepEqual(await readSettings(paths), before);
});
