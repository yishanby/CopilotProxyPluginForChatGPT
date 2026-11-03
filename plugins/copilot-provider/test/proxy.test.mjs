import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { startServer } from '../src/proxy.mjs';
import { BUILD_ID, getPaths, localKey, updateSettings, readSettings } from '../src/state.mjs';
import { configureProvider } from '../src/config.mjs';
import { setupJs } from '../src/ui.mjs';

const alice = { id: 'alice', host: 'github.com', login: 'alice', source: 'fixture', locator: 'private-location', token: 'must-not-leak' };
const bob = { id: 'bob', host: 'tenant.ghe.com', login: 'bob', source: 'fixture', locator: 'other-private' };
const model = { id: 'fixture-model', name: 'Fixture model', supported_endpoints: ['/responses'] };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('generated setup browser script has valid JavaScript syntax', () => {
  assert.doesNotThrow(() => new vm.Script(setupJs));
});

async function fixture(t, extras = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-proxy-test-'));
  const paths = getPaths({ CODEX_HOME: directory });
  await updateSettings({ accountId: alice.id, model: model.id }, paths);
  const requests = []; const configured = [];
  const app = await startServer({ paths, port: 0, cliPath: path.resolve('fake-cli.mjs'),
    discoverAccounts: async () => [alice, bob],
    copilot: {
      listModels: async () => [model],
      responses: async (account, input) => { requests.push({ account, input }); return json({ output: [] }); },
    },
    configureProvider: async options => { configured.push(options); return { configFile: paths.configFile }; },
    ...extras,
  });
  const key = await localKey(paths);
  const call = (route, body, options = {}) => fetch(app.url + route, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}), ...options.headers },
    ...(body ? { body: JSON.stringify(body) } : {}), ...options,
  });
  t.after(async () => { await app.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { app, paths, requests, configured, call, key };
}

test('requires local credentials and rejects foreign origins/hosts', async t => {
  const { app, call, key } = await fixture(t);
  const health = await fetch(app.url + '/health');
  assert.deepEqual(await health.json(), { service: 'copilot-proxy-plugin', version: 1 });
  assert.equal((await fetch(app.url + '/admin/accounts')).status, 401);
  assert.equal((await fetch(app.url + '/admin/accounts', { headers: { authorization: `Bearer ${key}`, origin: 'https://evil.test' } })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(app.url + '/admin/accounts', { headers: { authorization: `Bearer ${key}`, host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  const accounts = await (await call('/admin/accounts')).text();
  assert.ok(!accounts.includes('must-not-leak')); assert.ok(!accounts.includes('private-location'));
  assert.ok(accounts.includes('tenant.ghe.com'));
  const html = await fetch(app.url + '/');
  assert.equal(html.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(!(await html.text()).includes(key));
});

test('Codex native catalog refresh retains bundled metadata while normal clients discover Copilot models', async t => {
  const { call } = await fixture(t);
  assert.deepEqual(await (await call('/v1/models?client_version=0.143.0')).json(), { models: [] });
  const ordinary = await (await call('/v1/models')).json();
  assert.deepEqual(ordinary, { object: 'list', data: [model] });
});

test('account discovery warnings remain visible alongside usable accounts and expose no token text', async t => {
  const { call } = await fixture(t, { discoverAccounts: async ({ onWarning }) => {
    onWarning('DevMoor accounts could not be read. Check the original app for account status.');
    onWarning('GitHub CLI failed: ghp_exampleSecretValue');
    return [alice];
  } });
  const response = await (await call('/admin/accounts')).json();
  assert.equal(response.accounts.length, 1); assert.equal(response.warnings.length, 2);
  assert.match(response.warnings[0], /DevMoor/);
  assert.ok(!JSON.stringify(response).includes('ghp_exampleSecretValue'));
});

test('authenticated status identifies executable, build, and active requests', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let release; const ready = new Promise(resolve => { release = resolve; });
  const { call } = await fixture(t, { copilot: {
    listModels: async () => [model],
    responses: async () => { entered(); await ready; return json({ output: [] }); },
  } });
  const request = call('/v1/responses', { model: model.id, input: 'active' });
  await started;
  const busy = await (await call('/admin/status')).json();
  assert.equal(busy.cliPath, path.resolve('fake-cli.mjs')); assert.equal(busy.buildId, BUILD_ID); assert.equal(busy.activeRequests, 1);
  release(); await (await request).text();
  const idle = await (await call('/admin/status')).json();
  assert.equal(idle.activeRequests, 0);
});

test('switching validates the account/model before updating routing and config', async t => {
  const { call, paths, configured, requests } = await fixture(t);
  assert.equal((await call('/admin/select', { accountId: bob.id, model: 'unknown' })).status, 400);
  assert.equal((await readSettings(paths)).accountId, alice.id); assert.equal(configured.length, 0);
  assert.equal((await call('/admin/select', { accountId: bob.id, model: model.id })).status, 200);
  assert.equal((await readSettings(paths)).accountId, bob.id); assert.equal(configured.length, 1);
  assert.equal((await call('/v1/responses', { model: model.id, input: [{ type: 'function_call_output', call_id: 'c1', output: 'text' }] })).status, 200);
  assert.equal(requests[0].account.id, bob.id);
  assert.equal(requests[0].input.input[0].call_id, 'c1');
});

test('a removed account fails rather than falling back to another local account', async t => {
  const { call, requests } = await fixture(t, { discoverAccounts: async () => [bob] });
  assert.equal((await call('/v1/responses', { model: model.id, input: 'hello' })).status, 401);
  assert.equal(requests.length, 0);
});

test('configuration failure leaves selected account unchanged', async t => {
  const { call, paths } = await fixture(t, { configureProvider: async () => { throw new Error('Configuration conflict.'); } });
  assert.equal((await call('/admin/select', { accountId: bob.id, model: model.id })).status, 503);
  assert.equal((await readSettings(paths)).accountId, alice.id);
});

test('failed settings commit and a daemon restart cannot route the new model through the old account', async t => {
  const nextModel = { ...model, id: 'next-fixture-model' };
  let failWrite = false;
  const usedAccounts = [];
  const copilot = {
    listModels: async () => [model, nextModel],
    responses: async (account, input) => { usedAccounts.push({ accountId: account.id, model: input.model }); return json({ output: [] }); },
  };
  const f = await fixture(t, { configureProvider, copilot,
    persistSettings: async (patch, paths) => {
      if (failWrite) throw new Error('Cannot replace settings.json.');
      return updateSettings(patch, paths);
    },
  });
  assert.equal((await f.call('/admin/select', { accountId: alice.id, model: model.id })).status, 200);
  failWrite = true;
  const failed = await f.call('/admin/select', { accountId: bob.id, model: nextModel.id });
  assert.equal(failed.status, 503);
  assert.match((await failed.json()).error.message, /settings.json/);
  assert.equal((await readSettings(f.paths)).accountId, alice.id);
  assert.match(await fs.readFile(f.paths.configFile, 'utf8'), /next-fixture-model/);
  assert.equal((await f.call('/v1/responses', { model: nextModel.id, input: 'must not send' })).status, 503);
  const status = await (await f.call('/admin/status')).json();
  assert.equal(status.selectionPending, true); assert.equal(status.configured, false);
  assert.equal((await f.call('/admin/accounts')).status, 200);
  assert.equal(usedAccounts.length, 0);

  await f.app.close();
  const restarted = await startServer({ paths: f.paths, port: 0, cliPath: path.resolve('fake-cli.mjs'),
    discoverAccounts: async () => [alice, bob], configureProvider, copilot });
  const call = (route, body) => fetch(restarted.url + route, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${f.key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    assert.equal((await call('/v1/responses', { model: nextModel.id, input: 'still blocked' })).status, 503);
    assert.equal(usedAccounts.length, 0);
    assert.equal((await call('/admin/select', { accountId: bob.id, model: nextModel.id })).status, 200);
    assert.equal((await call('/v1/responses', { model: nextModel.id, input: 'now consistent' })).status, 200);
    assert.deepEqual(usedAccounts, [{ accountId: bob.id, model: nextModel.id }]);
    assert.equal((await readSettings(f.paths)).model, nextModel.id);
  } finally { await restarted.close(); }
});

test('real Codex config integration can select a model without inventing a model catalog', async t => {
  const { call, paths } = await fixture(t, { configureProvider });
  const response = await call('/admin/select', { accountId: bob.id, model: model.id });
  assert.equal(response.status, 200, await response.text());
  const config = await fs.readFile(paths.configFile, 'utf8');
  assert.match(config, /copilot-local/); assert.match(config, /fixture-model/);
  assert.doesNotMatch(config, /model_catalog_json/);
  assert.equal((await readSettings(paths)).accountId, bob.id);
});

test('streaming forwards events incrementally and client disconnect cancels upstream', async t => {
  let capturedSignal; let emit;
  const { call } = await fixture(t, { copilot: {
    listModels: async () => [model],
    responses: async (_account, _input, { signal }) => {
      capturedSignal = signal;
      return new Response(new ReadableStream({ start(controller) { emit = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  } });
  const response = await call('/v1/responses', { model: model.id, input: 'hello', stream: true });
  const reader = response.body.getReader();
  const first = reader.read();
  emit.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"first"}\n\n'));
  const chunk = await first; assert.match(new TextDecoder().decode(chunk.value), /first/);
  await reader.cancel();
  for (let i = 0; i < 30 && !capturedSignal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(capturedSignal.aborted, true);
  // A real fetch cancels its reader on signal abort; the fixture stream must also be released.
  emit.close();
});

test('in-flight requests keep their original account during a switch', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  let finish; const ready = new Promise(resolve => { finish = resolve; });
  let usedAccount;
  const { call } = await fixture(t, { copilot: {
    listModels: async () => [model],
    responses: async account => { usedAccount = account.id; entered(); await ready; return json({ output: [] }); },
  } });
  const original = call('/v1/responses', { model: model.id, input: 'old request' });
  await started;
  assert.equal((await call('/admin/select', { accountId: bob.id, model: model.id })).status, 200);
  finish(); assert.equal((await original).status, 200); assert.equal(usedAccount, alice.id);
});

test('an incomplete upstream stream is reported as failed without replaying output', async t => {
  let calls = 0;
  const { call } = await fixture(t, { copilot: {
    listModels: async () => [model],
    responses: async () => {
      calls++;
      return new Response('data: {"type":"response.output_text.delta","delta":"once"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  } });
  const text = await (await call('/v1/responses', { model: model.id, stream: true, input: 'test' })).text();
  assert.equal(calls, 1); assert.equal(text.match(/"delta":"once"/g).length, 1);
  assert.match(text, /response.failed/); assert.match(text, /incomplete_upstream_stream/);
});

test('authenticated shutdown closes the listener', async t => {
  const { app, call } = await fixture(t);
  assert.equal((await call('/admin/shutdown', {})).status, 200);
  await new Promise(resolve => app.server.once('close', resolve));
  assert.equal(app.server.listening, false);
});
