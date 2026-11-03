import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const HOST = /^(?:github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$/;
const DEVMOOR_ID = /^copilot-(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com-)?[1-9][0-9]{0,31}$/;
const sensitiveEnv = /^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|COPILOT_GITHUB_TOKEN|GITHUB_COPILOT_API_TOKEN|GH_HOST|GH_DEBUG)$/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

/** GitHub Enterprise Cloud is supported. GHES does not expose this Copilot route. */
export function normalizeAccountHost(value = 'github.com') {
  if (typeof value !== 'string' || /[\x00-\x20\x7f]/.test(value)) throw new Error('Invalid GitHub account host.');
  const host = value.toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  if (!HOST.test(host)) throw new Error('Use github.com or a GitHub Enterprise Cloud tenant hostname.');
  return host;
}

function loginName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)) throw new Error('Invalid GitHub account login.');
  return value;
}

function tokenValue(value) {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\s\x00-\x1f\x7f]/.test(value) || /^\*+$/.test(value)) {
    throw new Error('The selected account has no usable stored GitHub credential.');
  }
  return value;
}

/** Never let an ambient token or default host replace the explicitly selected user. */
export function accountEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !sensitiveEnv.test(key)).concat([
    ['GH_PROMPT_DISABLED', '1'], ['GH_NO_UPDATE_NOTIFIER', '1'], ['GCM_INTERACTIVE', 'Never'],
  ]));
}

function runProcess(command, args, options = {}) {
  return new Promise(resolve => {
    const child = execFile(command, args, {
      env: options.env, timeout: options.timeout ?? 15000, maxBuffer: MAX_FILE_BYTES,
      encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => resolve({ code: error ? 1 : 0, stdout: stdout || '' }));
    // Secrets are passed only over a pipe, never in command arguments.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });
}

function context(options = {}) {
  return { env: options.env ?? process.env, platform: options.platform ?? process.platform,
    homeDir: options.homeDir ?? os.homedir(), run: options.run ?? runProcess,
    readKeychain: options.readKeychain, decrypt: options.decrypt, now: options.now ?? Date.now,
    onWarning: options.onWarning ?? (() => {}) };
}

// JSONC is used by recent Copilot CLI config files. Preserve quoted URL strings.
function parseJsonc(text) {
  let clean = '', quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (quoted) { clean += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; clean += c; continue; }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; clean += '\n'; continue; }
    if (c === '/' && next === '*') {
      i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      if (i === text.length) throw new Error('Invalid JSON comment.');
      i++; clean += ' '; continue;
    }
    clean += c;
  }
  let result = ''; quoted = false; escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) { result += c; if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    if (c === ',' && /^[\s]*[}\]]/.test(clean.slice(i + 1))) continue;
    result += c;
  }
  return JSON.parse(result.replace(/^\uFEFF/, ''));
}

async function readDocument(file, optional = false) {
  let handle;
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) throw new Error();
    handle = await fs.open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error();
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1); let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > MAX_FILE_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error();
    return parseJsonc(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    // JSON parsers and subprocess errors can include credentials. Do not propagate them.
    throw new Error('An account source could not be read. Check its format and permissions.');
  } finally { await handle?.close(); }
}

function descriptor(source, host, login, locator, extra = {}) {
  host = normalizeAccountHost(host); login = loginName(login);
  const id = 'account-' + createHash('sha256').update(JSON.stringify([source, host, login.toLowerCase(), locator])).digest('hex').slice(0, 24);
  return { id, host, login, source, ...extra, locator };
}

function field(record, names, normalizer = value => value) {
  const values = names.filter(key => Object.hasOwn(record, key)).map(key => normalizer(record[key]));
  if (new Set(values).size > 1) throw new Error('Account source contains conflicting credential fields.');
  return values[0];
}

function credentialRecord(record, defaultHost) {
  if (!object(record)) throw new Error('Invalid account source format.');
  const provider = field(record, ['type', 'provider']);
  if (provider !== undefined && !['copilot', 'github-copilot', 'github'].includes(provider)) return null;
  const token = field(record, ['github_access_token', 'githubToken', 'github_token', 'oauth_token', 'access_token', 'token'], tokenValue);
  const login = field(record, ['github_login', 'githubLogin', 'login', 'user', 'username'], loginName);
  const host = field(record, ['github_host', 'githubHost', 'host', 'hostname'], normalizeAccountHost) ?? normalizeAccountHost(defaultHost);
  if (!token || !login) throw new Error('Account source needs an explicit login and GitHub token.');
  const expiresAt = field(record, ['expiresAt', 'expires_at']);
  if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)) throw new Error('Invalid account expiration.');
  const userId = field(record, ['githubUserId', 'github_user_id']);
  if (userId !== undefined && !/^[1-9][0-9]{0,31}$/.test(String(userId))) throw new Error('Invalid account identity.');
  return { token, host, login, ...(expiresAt ? { expiresAt } : {}), ...(userId ? { githubUserId: String(userId) } : {}) };
}

async function exportedCredentials(document, ctx) {
  if (object(document) && document.version === 1 && document.protection) {
    if (document.signedOut === true) return [];
    if (document.protection === 'file') document = document.credential;
    else if (document.protection === 'windows-dpapi') {
      if (typeof document.encrypted !== 'string' || document.encrypted.length > MAX_FILE_BYTES) throw new Error('Invalid protected account source.');
      document = parseJsonc(await (ctx.decrypt ?? (cipher => decryptDpapi(cipher, ctx)))(document.encrypted));
    } else throw new Error('Unsupported account protection.');
  }
  const records = Array.isArray(document) ? document : Array.isArray(document?.accounts) ? document.accounts : [document];
  const result = [], seen = new Set();
  for (const record of records) {
    const credential = credentialRecord(record);
    if (!credential) continue;
    const key = `${credential.host}:${credential.login.toLowerCase()}`;
    if (seen.has(key)) throw new Error('Account source contains more than one credential for the same identity.');
    seen.add(key); result.push(credential);
  }
  return result;
}

function copilotUsers(document) {
  if (!object(document)) throw new Error('Invalid Copilot CLI account source.');
  const hasUsers = Object.hasOwn(document, 'logged_in_users') || Object.hasOwn(document, 'loggedInUsers');
  const users = field(document, ['logged_in_users', 'loggedInUsers']) ?? [];
  if (!Array.isArray(users)) throw new Error('Invalid Copilot CLI account list.');
  const tokens = field(document, ['copilot_tokens', 'copilotTokens']) ?? {};
  if (!object(tokens)) throw new Error('Invalid Copilot CLI token map.');
  const found = new Map();
  const add = (rawHost, login, tokenKey) => {
    const host = normalizeAccountHost(rawHost); login = loginName(login);
    const key = `${host}:${login.toLowerCase()}`;
    const previous = found.get(key);
    if (previous && tokenKey && previous.tokenKey && tokenKey !== previous.tokenKey) throw new Error('Ambiguous Copilot CLI account tokens.');
    if (previous) { if (tokenKey) previous.tokenKey = tokenKey; return; }
    found.set(key, { host, login, rawHost, tokenKey });
  };
  for (const user of users) { if (!object(user)) throw new Error('Invalid Copilot CLI account.'); add(user.host, user.login); }
  const last = field(document, ['last_logged_in_user', 'lastLoggedInUser']);
  if (!hasUsers && object(last)) add(last.host, last.login);
  for (const key of Object.keys(tokens)) {
    const split = key.lastIndexOf(':');
    if (split < 1) throw new Error('Invalid Copilot CLI token identity.');
    const rawHost = key.slice(0, split), login = key.slice(split + 1);
    const identity = `${normalizeAccountHost(rawHost)}:${loginName(login).toLowerCase()}`;
    // An explicit empty user list represents logout, even if stale token bytes remain.
    if (!hasUsers || found.has(identity)) add(rawHost, login, key);
  }
  return [...found.values()];
}

async function discoverGh(ctx) {
  let result;
  try { result = await ctx.run('gh', ['auth', 'status', '--json', 'hosts'], { env: accountEnvironment(ctx.env), timeout: 20000 }); }
  catch { ctx.onWarning('GitHub CLI accounts are unavailable.'); return []; }
  if (result.code !== 0 && result.code !== undefined) { ctx.onWarning('GitHub CLI accounts are unavailable.'); return []; }
  try {
    const document = JSON.parse(result.stdout), accounts = [];
    if (!object(document.hosts)) throw new Error();
    for (const [host, entries] of Object.entries(document.hosts)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!object(entry) || !entry.login) continue;
        // A broken account remains visible so selection never silently falls back.
        try { accounts.push(descriptor('gh', host, entry.login, { kind: 'gh' }, { active: entry.active === true, available: entry.state === 'success' })); }
        catch { ctx.onWarning('A GitHub CLI account has an unsupported host or identity.'); }
      }
    }
    return accounts;
  } catch { ctx.onWarning('GitHub CLI returned an unsupported account format.'); return []; }
}

function knownFiles(ctx) {
  const copilotHome = ctx.env.COPILOT_HOME || path.join(ctx.homeDir, '.copilot');
  const dirs = [path.join(ctx.env.XDG_CONFIG_HOME || path.join(ctx.homeDir, '.config'), 'github-copilot')];
  if (ctx.platform === 'win32') {
    for (const base of [ctx.env.APPDATA || path.join(ctx.homeDir, 'AppData', 'Roaming'), ctx.env.LOCALAPPDATA || path.join(ctx.homeDir, 'AppData', 'Local')]) dirs.push(path.join(base, 'github-copilot'));
  } else if (ctx.platform === 'darwin') dirs.push(path.join(ctx.homeDir, 'Library', 'Application Support', 'github-copilot'));
  return { copilot: path.resolve(copilotHome, 'config.json'), legacy: [...new Set(dirs)].flatMap(dir => ['hosts.json', 'apps.json'].map(name => path.join(dir, name))) };
}

async function discoverLegacy(file) {
  const document = await readDocument(file, true);
  if (!document) return [];
  if (!object(document)) throw new Error('Invalid legacy Copilot account source.');
  const result = [];
  for (const [key, record] of Object.entries(document)) {
    if (!object(record) || !Object.hasOwn(record, 'oauth_token')) continue;
    const host = key.split(':')[0];
    const credential = credentialRecord(record, host);
    if (!credential) continue;
    if (credential.host !== normalizeAccountHost(host)) throw new Error('Legacy Copilot account host does not match its key.');
    result.push(descriptor('copilot-legacy', credential.host, credential.login, { kind: 'legacy', file: path.resolve(file), key }));
  }
  return result;
}

function devmoorRoot(ctx) {
  return path.resolve(ctx.env.DEVMOOR_DATA_DIR || path.join(ctx.env.LOCALAPPDATA || path.join(ctx.homeDir, '.local', 'share'), 'DevMoor'));
}

async function discoverDevmoor(ctx) {
  const root = devmoorRoot(ctx), index = await readDocument(path.join(root, 'copilot-accounts.json'), true);
  const files = [{ file: path.join(root, 'copilot-auth.json') }];
  if (index) {
    if (index.version !== 1 || !Array.isArray(index.ids) || index.ids.length > 32 || new Set(index.ids).size !== index.ids.length || index.ids.some(id => typeof id !== 'string' || !DEVMOOR_ID.test(id))) {
      throw new Error('DevMoor account index has an invalid identity.');
    }
    for (const id of index.ids) files.push({ id, file: path.join(root, 'copilot-accounts', id, 'copilot-auth.json') });
  }
  const results = [], identities = new Set();
  for (const { file, id } of files) {
    const document = await readDocument(file, true);
    if (!document) continue;
    const credentials = await exportedCredentials(document, ctx);
    for (const credential of credentials) {
      if (id) {
        const expected = `copilot-${credential.host === 'github.com' ? '' : credential.host + '-'}${credential.githubUserId}`;
        if (id !== expected) throw new Error('DevMoor account identity does not match its record.');
      }
      const identity = `${credential.host}:${credential.githubUserId ?? credential.login.toLowerCase()}`;
      if (identities.has(identity)) throw new Error('DevMoor account index contains a duplicate identity.');
      identities.add(identity);
      results.push(descriptor('devmoor', credential.host, credential.login, { kind: 'export', file, ...(id ? { devmoorId: id } : {}) }));
    }
  }
  return results;
}

/**
 * Lists only safe descriptors. Locators identify a source; they never contain tokens.
 * Default sources: gh, Copilot CLI, known legacy files, and DevMoor's indexed store.
 * Set includeDefaults/includeGh false and inject homeDir/env/run/readKeychain for tests.
 */
export async function discoverAccounts(options = {}) {
  const ctx = context(options), accounts = [];
  if (options.includeGh !== false) accounts.push(...await discoverGh(ctx));
  if (options.includeDefaults !== false) {
    const files = knownFiles(ctx);
    try {
      const document = await readDocument(files.copilot, true);
      if (document) for (const user of copilotUsers(document)) accounts.push(descriptor('copilot-cli', user.host, user.login, { kind: 'copilot-cli', file: files.copilot, rawHost: user.rawHost }));
    } catch { ctx.onWarning('Copilot CLI account metadata could not be read.'); }
    for (const file of files.legacy) {
      try { accounts.push(...await discoverLegacy(file)); }
      catch { ctx.onWarning('A legacy Copilot account source could not be read.'); }
    }
    try { accounts.push(...await discoverDevmoor(ctx)); }
    catch { ctx.onWarning('DevMoor accounts could not be read. Check the original app for account status.'); }
  }
  for (const file of options.credentialFiles ?? []) {
    if (typeof file !== 'string' || !file) throw new Error('Credential file paths must be non-empty strings.');
    const absolute = path.resolve(file), document = await readDocument(absolute);
    try {
      for (const credential of await exportedCredentials(document, ctx)) accounts.push(descriptor('credential-file', credential.host, credential.login, { kind: 'export', file: absolute }));
    } catch { throw new Error('A credential file has an unsupported, ambiguous, or unreadable account format.'); }
  }
  return [...new Map(accounts.map(account => [account.id, account])).values()];
}

const WINDOWS_KEYRING = `
$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CopilotCredentialReader {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
}
'@
$pointer=[IntPtr]::Zero
if(-not [CopilotCredentialReader]::Read($env:COPILOT_KEYCHAIN_TARGET,1,0,[ref]$pointer)){ exit 2 }
try {
 $credential=[Runtime.InteropServices.Marshal]::PtrToStructure($pointer,[type][CopilotCredentialReader+Credential])
 if($credential.CredentialBlobSize -gt 16384){exit 3}
 $bytes=New-Object byte[] $credential.CredentialBlobSize
 [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob,$bytes,0,$bytes.Length)
 [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))
} finally { [CopilotCredentialReader]::CredFree($pointer) }
} catch { exit 4 }
`;

function powershellCommand(ctx) {
  return ctx.env.SystemRoot ? path.join(ctx.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}
function encodedCommand(script) { return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]; }

async function readOsKeychain(service, account, ctx) {
  let result;
  const env = accountEnvironment(ctx.env);
  if (ctx.platform === 'win32') {
    result = await ctx.run(powershellCommand(ctx), encodedCommand(WINDOWS_KEYRING), { env: { ...env, COPILOT_KEYCHAIN_TARGET: `${service}/${account}` } });
  } else if (ctx.platform === 'darwin') result = await ctx.run('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { env });
  else result = await ctx.run('secret-tool', ['lookup', 'service', service, 'account', account], { env });
  return result.code === 0 || result.code === undefined ? result.stdout.trim() : null;
}

async function decryptDpapi(cipher, ctx) {
  if (ctx.platform !== 'win32') throw new Error('This legacy account is protected by its original Windows profile.');
  const script = "$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain)) } catch { exit 1 }";
  const result = await ctx.run(powershellCommand(ctx), encodedCommand(script), { env: accountEnvironment(ctx.env), input: cipher });
  if (result.code !== 0 && result.code !== undefined) throw new Error('This legacy account could not be decrypted by the current Windows profile.');
  return result.stdout;
}

/** Resolves exactly the selected account afresh; never switches gh or writes a source. */
export async function resolveCredential(account, options = {}) {
  const ctx = context(options);
  try {
    if (!object(account) || !object(account.locator)) throw new Error();
    const { source, locator } = account, host = normalizeAccountHost(account.host), login = loginName(account.login);
    if (descriptor(source, host, login, locator).id !== account.id) throw new Error();
    let credential;
    if (locator.kind === 'gh' && source === 'gh') {
      const result = await ctx.run('gh', ['auth', 'token', '--hostname', host, '--user', login], { env: accountEnvironment(ctx.env) });
      if (result.code !== 0 && result.code !== undefined) throw new Error();
      credential = { token: tokenValue(result.stdout.trim()), host, login };
    } else if (locator.kind === 'copilot-cli' && source === 'copilot-cli') {
      const document = await readDocument(locator.file), users = copilotUsers(document);
      const user = users.find(row => row.host === host && row.login.toLowerCase() === login.toLowerCase() && row.rawHost === locator.rawHost);
      if (!user) throw new Error();
      const settings = await readDocument(path.join(path.dirname(locator.file), 'settings.json'), true);
      const plaintextOnly = settings?.store_token_plaintext === true || settings?.storeTokenPlaintext === true;
      let token;
      if (!plaintextOnly) {
        try { token = await (ctx.readKeychain ?? ((service, key) => readOsKeychain(service, key, ctx)))('copilot-cli', `${user.rawHost}:${user.login}`); }
        catch { /* Copilot CLI also falls back to its exact account-keyed plaintext value. */ }
      }
      if (!token) token = (document.copilot_tokens ?? document.copilotTokens)?.[user.tokenKey ?? `${user.rawHost}:${user.login}`];
      credential = { token: tokenValue(token), host, login };
    } else if (locator.kind === 'legacy' && source === 'copilot-legacy') {
      const document = await readDocument(locator.file), record = document[locator.key];
      credential = credentialRecord(record, locator.key.split(':')[0]);
    } else if (locator.kind === 'export' && ['credential-file', 'devmoor'].includes(source)) {
      if (locator.devmoorId) {
        const root = path.dirname(path.dirname(path.dirname(locator.file)));
        const index = await readDocument(path.join(root, 'copilot-accounts.json'));
        if (!Array.isArray(index.ids) || !index.ids.includes(locator.devmoorId)) throw new Error();
      }
      const credentials = await exportedCredentials(await readDocument(locator.file), ctx);
      credential = credentials.find(row => row.host === host && row.login.toLowerCase() === login.toLowerCase());
      if (locator.devmoorId && locator.devmoorId !== `copilot-${host === 'github.com' ? '' : host + '-'}${credential?.githubUserId}`) throw new Error();
    } else throw new Error();
    if (!credential || credential.host !== host || credential.login.toLowerCase() !== login.toLowerCase()) throw new Error();
    tokenValue(credential.token);
    if (credential.expiresAt && credential.expiresAt <= ctx.now() / 1000) throw new Error();
    return credential;
  } catch {
    throw new Error('The selected account credential is unavailable, expired, or changed. Refresh it in its original app, then refresh the account list.');
  }
}
