import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverAccounts, resolveCredential, accountEnvironment, normalizeAccountHost } from '../src/accounts.mjs';

async function fixture(t, extra = {}) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'copilot-accounts-test-'));
  t.after(async () => { const real = await fs.realpath(root); assert.equal(path.dirname(real), parent); assert.ok(path.basename(real).startsWith('copilot-accounts-test-')); await fs.rm(real, { recursive: true, force: true }); });
  const env = { COPILOT_HOME: path.join(root, 'copilot'), DEVMOOR_DATA_DIR: path.join(root, 'devmoor'),
    APPDATA: path.join(root, 'roaming'), LOCALAPPDATA: path.join(root, 'local'), XDG_CONFIG_HOME: path.join(root, 'config') };
  const options = { env, homeDir: root, platform: 'win32', includeGh: false, ...extra };
  const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  return { root, env, options, write, config: path.join(env.COPILOT_HOME, 'config.json') };
}

function safe(publicValue, ...tokens) { for (const token of tokens) assert.ok(!JSON.stringify(publicValue).includes(token)); }
async function safeReject(promise, secret) {
  await assert.rejects(promise, error => { assert.ok(!String(error.stack).includes(secret)); assert.equal(error.cause, undefined); return true; });
}

test('gh discovery enumerates every user and resolves the selected host+user without switching global auth', async () => {
  const calls = [];
  const env = { PATH: 'retained-path', GH_TOKEN: 'ambient-wrong-token', GITHUB_TOKEN: 'ambient-other-token', GH_ENTERPRISE_TOKEN: 'ambient-enterprise', GITHUB_ENTERPRISE_TOKEN: 'ambient-enterprise2', COPILOT_GITHUB_TOKEN: 'ambient-copilot', GH_HOST: 'wrong.ghe.com', GH_DEBUG: 'api' };
  const run = async (command, args, opts) => {
    calls.push({ command, args, env: opts.env });
    if (args[1] === 'status') return { code: 0, stdout: JSON.stringify({ hosts: {
      'github.com': [{ login: 'alice', state: 'success', active: true, token: 'bad-cli-leaked-fixture' }, { login: 'bob', state: 'success', active: false }],
      'tenant.ghe.com': [{ login: 'alice', state: 'success', active: true }],
    } }) };
    return { code: 0, stdout: `fixture-token-${args[3]}-${args[5]}\n` };
  };
  const accounts = await discoverAccounts({ includeDefaults: false, run, env });
  assert.equal(accounts.length, 3); assert.equal(new Set(accounts.map(row => row.id)).size, 3);
  safe(accounts, 'ambient-wrong-token', 'bad-cli-leaked-fixture');
  const account = accounts.find(row => row.login === 'bob');
  assert.equal((await resolveCredential(account, { run, env })).token, 'fixture-token-github.com-bob');
  const enterprise = accounts.find(row => row.host === 'tenant.ghe.com');
  assert.equal((await resolveCredential(enterprise, { run, env })).token, 'fixture-token-tenant.ghe.com-alice');
  assert.deepEqual(calls[1].args, ['auth', 'token', '--hostname', 'github.com', '--user', 'bob']);
  assert.deepEqual(calls[2].args, ['auth', 'token', '--hostname', 'tenant.ghe.com', '--user', 'alice']);
  for (const call of calls) { assert.equal(call.command, 'gh'); assert.ok(!call.args.includes('switch')); assert.equal(call.env.PATH, env.PATH); for (const key of Object.keys(env).filter(key => key !== 'PATH')) assert.equal(call.env[key], undefined); }
  assert.equal(env.GH_TOKEN, 'ambient-wrong-token');
});

test('gh failures never propagate captured output or secretly use ambient credentials', async () => {
  const warnings = [], secret = 'fixture-private-command-output';
  const accounts = await discoverAccounts({ includeDefaults: false, run: async () => { throw new Error(secret); }, onWarning: value => warnings.push(value) });
  assert.deepEqual(accounts, []); assert.ok(warnings.length); safe(warnings, secret);
  const run = async () => ({ code: 0, stdout: JSON.stringify({ hosts: { 'github.com': [{ login: 'a', state: 'error' }] } }) });
  const [account] = await discoverAccounts({ includeDefaults: false, run });
  assert.equal(account.available, false);
  await safeReject(resolveCredential(account, { run: async () => { throw new Error(secret); } }), secret);
});

test('Copilot CLI JSONC metadata resolves exact keyring entries for multiple hosts and users', async t => {
  const f = await fixture(t);
  await f.write(f.config, '// auto managed\n{"logged_in_users":[{"host":"https://github.com","login":"alice"},{"host":"https://tenant.ghe.com","login":"alice"}],}');
  const before = await fs.readFile(f.config), calls = [];
  const readKeychain = async (service, key) => { calls.push({ service, key }); return `fixture-${key}`; };
  const accounts = await discoverAccounts(f.options);
  assert.equal(accounts.length, 2); safe(accounts, 'fixture-');
  for (const account of accounts) {
    const credential = await resolveCredential(account, { ...f.options, readKeychain });
    assert.equal(credential.token, `fixture-https://${account.host}:alice`);
  }
  assert.deepEqual(calls, [{ service: 'copilot-cli', key: 'https://github.com:alice' }, { service: 'copilot-cli', key: 'https://tenant.ghe.com:alice' }]);
  assert.deepEqual(await fs.readFile(f.config), before);
});

test('Copilot plaintext settings take precedence over an old keychain token and observe source rotation', async t => {
  const f = await fixture(t), accountKey = 'https://github.com:alice';
  const document = { loggedInUsers: [{ host: 'https://github.com', login: 'alice' }], copilotTokens: { [accountKey]: 'fixture-first' } };
  await f.write(f.config, document); await f.write(path.join(f.env.COPILOT_HOME, 'settings.json'), { store_token_plaintext: true });
  const [account] = await discoverAccounts(f.options); let keyReads = 0;
  const options = { ...f.options, readKeychain: async () => { keyReads++; return 'fixture-stale'; } };
  assert.equal((await resolveCredential(account, options)).token, 'fixture-first');
  document.copilotTokens[accountKey] = 'fixture-rotated'; await f.write(f.config, document);
  assert.equal((await resolveCredential(account, options)).token, 'fixture-rotated'); assert.equal(keyReads, 0);
  safe(account, 'fixture-first', 'fixture-rotated');
});

test('Copilot unavailable vault uses only selected plaintext token and explicit logout is not resurrected', async t => {
  const f = await fixture(t), users = [{ host: 'https://github.com', login: 'alice' }, { host: 'https://github.com', login: 'bob' }];
  const document = { logged_in_users: users, last_logged_in_user: users[0], copilot_tokens: { 'https://github.com:alice': 'fixture-alice' } };
  await f.write(f.config, document); const accounts = await discoverAccounts(f.options);
  const options = { ...f.options, readKeychain: async () => null };
  assert.equal((await resolveCredential(accounts[0], options)).token, 'fixture-alice');
  await safeReject(resolveCredential(accounts[1], options), 'fixture-alice');
  await f.write(f.config, { ...document, logged_in_users: [] });
  assert.deepEqual(await discoverAccounts(f.options), []);
  await assert.rejects(resolveCredential(accounts[0], options), /unavailable/);
});

test('legacy hosts and apps stay separate and support tenant hosts', async t => {
  const f = await fixture(t), base = path.join(f.env.APPDATA, 'github-copilot');
  await f.write(path.join(base, 'hosts.json'), { 'github.com': { user: 'alice', oauth_token: 'fixture-hosts' } });
  await f.write(path.join(base, 'apps.json'), { 'tenant.ghe.com:Iv1.example': { user: 'bob', oauth_token: 'fixture-apps' } });
  const accounts = await discoverAccounts(f.options);
  assert.equal(accounts.length, 2); safe(accounts, 'fixture-hosts', 'fixture-apps');
  const credential = await resolveCredential(accounts.find(row => row.host === 'tenant.ghe.com'), f.options);
  assert.deepEqual(credential, { token: 'fixture-apps', host: 'tenant.ghe.com', login: 'bob' });
});

test('explicit exports use stable account IDs across array reorder and do not accept changed identities', async t => {
  const f = await fixture(t), file = path.join(f.root, 'export.json');
  const records = [{ login: 'alice', token: 'fixture-alice' }, { login: 'bob', host: 'tenant.ghe.com', github_access_token: 'fixture-bob' }];
  await f.write(file, { accounts: records });
  const options = { ...f.options, includeDefaults: false, credentialFiles: [file] };
  const accounts = await discoverAccounts(options), bob = accounts.find(row => row.login === 'bob'); safe(accounts, 'fixture-alice', 'fixture-bob');
  await f.write(file, { accounts: [...records].reverse() });
  assert.equal((await discoverAccounts(options)).find(row => row.login === 'bob').id, bob.id);
  assert.equal((await resolveCredential(bob, options)).token, 'fixture-bob');
  await f.write(file, { accounts: [{ ...records[1], login: 'charlie' }] });
  await assert.rejects(resolveCredential(bob, options), /changed/);
});

test('ambiguous token aliases, duplicate identities, missing login and malformed hosts are rejected without secrets', async t => {
  const f = await fixture(t), file = path.join(f.root, 'export.json'), secret = 'fixture-never-expose';
  const invalid = [
    { login: 'alice', token: secret, github_access_token: 'different' },
    { accounts: [{ login: 'alice', token: secret }, { login: 'ALICE', token: 'other' }] },
    { token: secret }, { login: 'alice', token: secret, host: 'https://tenant.ghe.com/path' },
    { login: 'alice', token: secret, host: 'tenant.ghe.com:443' }, { login: 'alice', token: secret, host: null },
    `{"login":"alice","token":"${secret}", broken JSON`,
  ];
  for (const document of invalid) {
    await f.write(file, document);
    await safeReject(discoverAccounts({ ...f.options, includeDefaults: false, credentialFiles: [file] }), secret);
  }
});

test('DevMoor index preserves tenant-local identities, source bytes and tombstone logout', async t => {
  const f = await fixture(t), root = f.env.DEVMOOR_DATA_DIR;
  const ids = ['copilot-101', 'copilot-tenant.ghe.com-101'];
  const index = path.join(root, 'copilot-accounts.json');
  await f.write(index, { version: 1, ids, activeId: ids[1] });
  const files = ids.map(id => path.join(root, 'copilot-accounts', id, 'copilot-auth.json'));
  const make = host => ({ version: 1, protection: 'file', credential: { login: 'alice', githubUserId: '101', githubHost: host, token: `fixture-${host}`, savedAt: '2026-11-01T00:00:00Z' } });
  await f.write(files[0], make('github.com')); await f.write(files[1], make('tenant.ghe.com'));
  const original = await fs.readFile(files[1]), accounts = await discoverAccounts(f.options);
  assert.equal(accounts.length, 2); assert.equal(new Set(accounts.map(row => row.id)).size, 2);
  const enterprise = accounts.find(row => row.host === 'tenant.ghe.com');
  assert.equal((await resolveCredential(enterprise, f.options)).token, 'fixture-tenant.ghe.com');
  assert.deepEqual(await fs.readFile(files[1]), original); safe(accounts, 'fixture-');
  await f.write(index, { version: 1, ids: [ids[0]], activeId: ids[0] });
  await assert.rejects(resolveCredential(enterprise, f.options), /unavailable/);
  await f.write(index, { version: 1, ids, activeId: null });
  await f.write(files[1], { version: 1, protection: 'file', signedOut: true });
  assert.equal((await discoverAccounts(f.options)).length, 1);
  await assert.rejects(resolveCredential(enterprise, f.options), /unavailable/);
});

test('DevMoor legacy DPAPI is read-only and platform decryption errors expose no plaintext', async t => {
  const f = await fixture(t), file = path.join(f.env.DEVMOOR_DATA_DIR, 'copilot-auth.json');
  await f.write(file, { version: 1, protection: 'windows-dpapi', encrypted: 'synthetic-encrypted' });
  const original = await fs.readFile(file), options = { ...f.options, decrypt: async () => JSON.stringify({ login: 'alice', token: 'fixture-protected-secret' }) };
  const [account] = await discoverAccounts(options);
  assert.equal((await resolveCredential(account, options)).token, 'fixture-protected-secret');
  safe(account, 'fixture-protected-secret'); assert.deepEqual(await fs.readFile(file), original);
  await safeReject(resolveCredential(account, { ...options, decrypt: async () => { throw new Error('fixture-protected-secret'); } }), 'fixture-protected-secret');
  await safeReject(discoverAccounts({ ...options, includeDefaults: false, credentialFiles: [file],
    decrypt: async () => '{"token":"fixture-protected-secret", malformed' }), 'fixture-protected-secret');
});

test('DevMoor invalid path IDs and mismatched record identities do not enumerate accounts', async t => {
  const warnings = [], f = await fixture(t, { onWarning: value => warnings.push(value) }), root = f.env.DEVMOOR_DATA_DIR;
  const index = path.join(root, 'copilot-accounts.json');
  await f.write(index, { version: 1, ids: ['../../outside'] });
  assert.deepEqual(await discoverAccounts(f.options), []);
  await f.write(index, { version: 1, ids: ['copilot-101'] });
  await f.write(path.join(root, 'copilot-accounts', 'copilot-101', 'copilot-auth.json'), { version: 1, protection: 'file', credential: { login: 'alice', githubUserId: '202', token: 'fixture-mismatch' } });
  assert.deepEqual(await discoverAccounts(f.options), []); assert.equal(warnings.length, 2); safe(warnings, 'fixture-mismatch');
});

test('selected source expiration and descriptor tampering fail without falling back', async t => {
  const f = await fixture(t), file = path.join(f.root, 'account.json');
  await f.write(file, { login: 'alice', token: 'fixture-expiring', expires_at: 200 });
  const options = { ...f.options, includeDefaults: false, credentialFiles: [file], now: () => 100000 };
  const [account] = await discoverAccounts(options); assert.equal((await resolveCredential(account, options)).token, 'fixture-expiring');
  await assert.rejects(resolveCredential(account, { ...options, now: () => 300000 }), /expired/);
  await assert.rejects(resolveCredential({ ...account, host: 'other.ghe.com' }, options), /changed/);
});

for (const platform of ['win32', 'darwin', 'linux']) test(`${platform} keyring lookup is exact and captured only inside the resolver`, async t => {
  const f = await fixture(t, { platform }), calls = [];
  await f.write(f.config, { logged_in_users: [{ host: 'https://tenant.ghe.com', login: 'alice' }] });
  const [account] = await discoverAccounts(f.options);
  const run = async (command, args, opts) => { calls.push({ command, args, opts }); return { code: 0, stdout: 'fixture-vault-secret\n' }; };
  const result = await resolveCredential(account, { ...f.options, run });
  assert.equal(result.token, 'fixture-vault-secret'); assert.equal(calls.length, 1); safe(calls, 'fixture-vault-secret');
  if (platform === 'win32') { assert.match(calls[0].command, /powershell\.exe$/); assert.equal(calls[0].opts.env.COPILOT_KEYCHAIN_TARGET, 'copilot-cli/https://tenant.ghe.com:alice'); assert.ok(calls[0].args.includes('-EncodedCommand')); }
  else if (platform === 'darwin') assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'copilot-cli', '-a', 'https://tenant.ghe.com:alice', '-w']);
  else assert.deepEqual(calls[0].args, ['lookup', 'service', 'copilot-cli', 'account', 'https://tenant.ghe.com:alice']);
});

test('host normalization supports Enterprise Cloud and refuses downgrade-prone URLs', () => {
  assert.equal(normalizeAccountHost('https://TENANT.ghe.com/'), 'tenant.ghe.com');
  assert.equal(normalizeAccountHost(), 'github.com');
  for (const host of ['http://github.com', 'github.com@evil.test', 'github.com/path', 'api.tenant.ghe.com', 'github.com:443', '', ' github.com', 'github.com\n']) assert.throws(() => normalizeAccountHost(host));
  assert.equal(accountEnvironment({ gh_token: 'fixture', PATH: 'x' }).gh_token, undefined);
});
