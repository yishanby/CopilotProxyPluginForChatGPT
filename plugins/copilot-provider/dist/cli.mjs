#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// plugins/copilot-provider/src/state.mjs
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
function getPaths(env = process.env) {
  const codexHome = path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const dataDir = path.resolve(env.COPILOT_PROXY_HOME || path.join(codexHome, "copilot-proxy"));
  return {
    codexHome,
    dataDir,
    configFile: path.join(codexHome, "config.toml"),
    settingsFile: path.join(dataDir, "settings.json"),
    keyFile: path.join(dataDir, "local-key"),
    processFile: path.join(dataDir, "process.json"),
    logFile: path.join(dataDir, "proxy.log")
  };
}
async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`Cannot read ${path.basename(file)}: ${error.name}`);
  }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 448 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
async function readSettings(paths2 = getPaths()) {
  return { version: 1, port: 43128, accountId: null, model: null, credentialFiles: [], ...await readJson(paths2.settingsFile, {}) };
}
async function updateSettings(patch, paths2 = getPaths()) {
  const settings = { ...await readSettings(paths2), ...patch };
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) throw new Error("Invalid local port.");
  await writeJson(paths2.settingsFile, settings);
  return settings;
}
async function localKey(paths2 = getPaths()) {
  await fs.mkdir(paths2.dataDir, { recursive: true, mode: 448 });
  try {
    await fs.writeFile(paths2.keyFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 384 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const key = (await fs.readFile(paths2.keyFile, "utf8")).trim();
    if (/^[a-f0-9]{64}$/.test(key)) return key;
    await delay(25);
  }
  throw new Error("Invalid local proxy credential.");
}
function publicAccount(account) {
  return { id: account.id, host: account.host, login: account.login, source: account.source };
}
function safeError(error) {
  return String(error?.message || "Operation failed").replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+\S+|token\s+\S+)/gi, "[redacted]").slice(0, 600);
}
var BUILD_ID;
var init_state = __esm({
  "plugins/copilot-provider/src/state.mjs"() {
    BUILD_ID = true ? "2164e041930eec06dcdb" : "source";
  }
});

// plugins/copilot-provider/src/accounts.mjs
import fs3 from "node:fs/promises";
import { constants } from "node:fs";
import os2 from "node:os";
import path3 from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
function normalizeAccountHost(value = "github.com") {
  if (typeof value !== "string" || /[\x00-\x20\x7f]/.test(value)) throw new Error("Invalid GitHub account host.");
  const host = value.toLowerCase().replace(/^https:\/\//, "").replace(/\/$/, "");
  if (!HOST.test(host)) throw new Error("Use github.com or a GitHub Enterprise Cloud tenant hostname.");
  return host;
}
function loginName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value)) throw new Error("Invalid GitHub account login.");
  return value;
}
function tokenValue(value) {
  if (typeof value !== "string" || !value || value.length > 16384 || /[\s\x00-\x1f\x7f]/.test(value) || /^\*+$/.test(value)) {
    throw new Error("The selected account has no usable stored GitHub credential.");
  }
  return value;
}
function accountEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !sensitiveEnv.test(key)).concat([
    ["GH_PROMPT_DISABLED", "1"],
    ["GH_NO_UPDATE_NOTIFIER", "1"],
    ["GCM_INTERACTIVE", "Never"]
  ]));
}
function runProcess(command2, args2, options = {}) {
  return new Promise((resolve) => {
    const child = execFile(command2, args2, {
      env: options.env,
      timeout: options.timeout ?? 15e3,
      maxBuffer: MAX_FILE_BYTES,
      encoding: "utf8",
      windowsHide: true
    }, (error, stdout) => resolve({ code: error ? 1 : 0, stdout: stdout || "" }));
    child.stdin?.on("error", () => {
    });
    child.stdin?.end(options.input ?? "");
  });
}
function context(options = {}) {
  return {
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    homeDir: options.homeDir ?? os2.homedir(),
    run: options.run ?? runProcess,
    readKeychain: options.readKeychain,
    decrypt: options.decrypt,
    now: options.now ?? Date.now,
    onWarning: options.onWarning ?? (() => {
    })
  };
}
function parseJsonc(text) {
  let clean = "", quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (quoted) {
      clean += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      clean += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      clean += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      if (i === text.length) throw new Error("Invalid JSON comment.");
      i++;
      clean += " ";
      continue;
    }
    clean += c;
  }
  let result = "";
  quoted = false;
  escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      result += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    if (c === "," && /^[\s]*[}\]]/.test(clean.slice(i + 1))) continue;
    result += c;
  }
  return JSON.parse(result.replace(/^\uFEFF/, ""));
}
async function readDocument(file, optional = false) {
  let handle;
  try {
    const before = await fs3.lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) throw new Error();
    handle = await fs3.open(file, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error();
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > MAX_FILE_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error();
    return parseJsonc(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw new Error("An account source could not be read. Check its format and permissions.");
  } finally {
    await handle?.close();
  }
}
function descriptor(source, host, login, locator, extra = {}) {
  host = normalizeAccountHost(host);
  login = loginName(login);
  const id = "account-" + createHash("sha256").update(JSON.stringify([source, host, login.toLowerCase(), locator])).digest("hex").slice(0, 24);
  return { id, host, login, source, ...extra, locator };
}
function field(record, names, normalizer = (value) => value) {
  const values = names.filter((key) => Object.hasOwn(record, key)).map((key) => normalizer(record[key]));
  if (new Set(values).size > 1) throw new Error("Account source contains conflicting credential fields.");
  return values[0];
}
function credentialRecord(record, defaultHost) {
  if (!object(record)) throw new Error("Invalid account source format.");
  const provider = field(record, ["type", "provider"]);
  if (provider !== void 0 && !["copilot", "github-copilot", "github"].includes(provider)) return null;
  const token = field(record, ["github_access_token", "githubToken", "github_token", "oauth_token", "access_token", "token"], tokenValue);
  const login = field(record, ["github_login", "githubLogin", "login", "user", "username"], loginName);
  const host = field(record, ["github_host", "githubHost", "host", "hostname"], normalizeAccountHost) ?? normalizeAccountHost(defaultHost);
  if (!token || !login) throw new Error("Account source needs an explicit login and GitHub token.");
  const expiresAt = field(record, ["expiresAt", "expires_at"]);
  if (expiresAt !== void 0 && (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)) throw new Error("Invalid account expiration.");
  const userId = field(record, ["githubUserId", "github_user_id"]);
  if (userId !== void 0 && !/^[1-9][0-9]{0,31}$/.test(String(userId))) throw new Error("Invalid account identity.");
  return { token, host, login, ...expiresAt ? { expiresAt } : {}, ...userId ? { githubUserId: String(userId) } : {} };
}
async function exportedCredentials(document, ctx) {
  if (object(document) && document.version === 1 && document.protection) {
    if (document.signedOut === true) return [];
    if (document.protection === "file") document = document.credential;
    else if (document.protection === "windows-dpapi") {
      if (typeof document.encrypted !== "string" || document.encrypted.length > MAX_FILE_BYTES) throw new Error("Invalid protected account source.");
      document = parseJsonc(await (ctx.decrypt ?? ((cipher) => decryptDpapi(cipher, ctx)))(document.encrypted));
    } else throw new Error("Unsupported account protection.");
  }
  const records = Array.isArray(document) ? document : Array.isArray(document?.accounts) ? document.accounts : [document];
  const result = [], seen = /* @__PURE__ */ new Set();
  for (const record of records) {
    const credential = credentialRecord(record);
    if (!credential) continue;
    const key = `${credential.host}:${credential.login.toLowerCase()}`;
    if (seen.has(key)) throw new Error("Account source contains more than one credential for the same identity.");
    seen.add(key);
    result.push(credential);
  }
  return result;
}
function copilotUsers(document) {
  if (!object(document)) throw new Error("Invalid Copilot CLI account source.");
  const hasUsers = Object.hasOwn(document, "logged_in_users") || Object.hasOwn(document, "loggedInUsers");
  const users = field(document, ["logged_in_users", "loggedInUsers"]) ?? [];
  if (!Array.isArray(users)) throw new Error("Invalid Copilot CLI account list.");
  const tokens = field(document, ["copilot_tokens", "copilotTokens"]) ?? {};
  if (!object(tokens)) throw new Error("Invalid Copilot CLI token map.");
  const found = /* @__PURE__ */ new Map();
  const add = (rawHost, login, tokenKey) => {
    const host = normalizeAccountHost(rawHost);
    login = loginName(login);
    const key = `${host}:${login.toLowerCase()}`;
    const previous = found.get(key);
    if (previous && tokenKey && previous.tokenKey && tokenKey !== previous.tokenKey) throw new Error("Ambiguous Copilot CLI account tokens.");
    if (previous) {
      if (tokenKey) previous.tokenKey = tokenKey;
      return;
    }
    found.set(key, { host, login, rawHost, tokenKey });
  };
  for (const user of users) {
    if (!object(user)) throw new Error("Invalid Copilot CLI account.");
    add(user.host, user.login);
  }
  const last = field(document, ["last_logged_in_user", "lastLoggedInUser"]);
  if (!hasUsers && object(last)) add(last.host, last.login);
  for (const key of Object.keys(tokens)) {
    const split = key.lastIndexOf(":");
    if (split < 1) throw new Error("Invalid Copilot CLI token identity.");
    const rawHost = key.slice(0, split), login = key.slice(split + 1);
    const identity = `${normalizeAccountHost(rawHost)}:${loginName(login).toLowerCase()}`;
    if (!hasUsers || found.has(identity)) add(rawHost, login, key);
  }
  return [...found.values()];
}
async function discoverGh(ctx) {
  let result;
  try {
    result = await ctx.run("gh", ["auth", "status", "--json", "hosts"], { env: accountEnvironment(ctx.env), timeout: 2e4 });
  } catch {
    ctx.onWarning("GitHub CLI accounts are unavailable.");
    return [];
  }
  if (result.code !== 0 && result.code !== void 0) {
    ctx.onWarning("GitHub CLI accounts are unavailable.");
    return [];
  }
  try {
    const document = JSON.parse(result.stdout), accounts = [];
    if (!object(document.hosts)) throw new Error();
    for (const [host, entries] of Object.entries(document.hosts)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!object(entry) || !entry.login) continue;
        try {
          accounts.push(descriptor("gh", host, entry.login, { kind: "gh" }, { active: entry.active === true, available: entry.state === "success" }));
        } catch {
          ctx.onWarning("A GitHub CLI account has an unsupported host or identity.");
        }
      }
    }
    return accounts;
  } catch {
    ctx.onWarning("GitHub CLI returned an unsupported account format.");
    return [];
  }
}
function knownFiles(ctx) {
  const copilotHome = ctx.env.COPILOT_HOME || path3.join(ctx.homeDir, ".copilot");
  const dirs = [path3.join(ctx.env.XDG_CONFIG_HOME || path3.join(ctx.homeDir, ".config"), "github-copilot")];
  if (ctx.platform === "win32") {
    for (const base of [ctx.env.APPDATA || path3.join(ctx.homeDir, "AppData", "Roaming"), ctx.env.LOCALAPPDATA || path3.join(ctx.homeDir, "AppData", "Local")]) dirs.push(path3.join(base, "github-copilot"));
  } else if (ctx.platform === "darwin") dirs.push(path3.join(ctx.homeDir, "Library", "Application Support", "github-copilot"));
  return { copilot: path3.resolve(copilotHome, "config.json"), legacy: [...new Set(dirs)].flatMap((dir) => ["hosts.json", "apps.json"].map((name) => path3.join(dir, name))) };
}
async function discoverLegacy(file) {
  const document = await readDocument(file, true);
  if (!document) return [];
  if (!object(document)) throw new Error("Invalid legacy Copilot account source.");
  const result = [];
  for (const [key, record] of Object.entries(document)) {
    if (!object(record) || !Object.hasOwn(record, "oauth_token")) continue;
    const host = key.split(":")[0];
    const credential = credentialRecord(record, host);
    if (!credential) continue;
    if (credential.host !== normalizeAccountHost(host)) throw new Error("Legacy Copilot account host does not match its key.");
    result.push(descriptor("copilot-legacy", credential.host, credential.login, { kind: "legacy", file: path3.resolve(file), key }));
  }
  return result;
}
function devmoorRoot(ctx) {
  return path3.resolve(ctx.env.DEVMOOR_DATA_DIR || path3.join(ctx.env.LOCALAPPDATA || path3.join(ctx.homeDir, ".local", "share"), "DevMoor"));
}
async function discoverDevmoor(ctx) {
  const root = devmoorRoot(ctx), index = await readDocument(path3.join(root, "copilot-accounts.json"), true);
  const files = [{ file: path3.join(root, "copilot-auth.json") }];
  if (index) {
    if (index.version !== 1 || !Array.isArray(index.ids) || index.ids.length > 32 || new Set(index.ids).size !== index.ids.length || index.ids.some((id) => typeof id !== "string" || !DEVMOOR_ID.test(id))) {
      throw new Error("DevMoor account index has an invalid identity.");
    }
    for (const id of index.ids) files.push({ id, file: path3.join(root, "copilot-accounts", id, "copilot-auth.json") });
  }
  const results = [], identities = /* @__PURE__ */ new Set();
  for (const { file, id } of files) {
    const document = await readDocument(file, true);
    if (!document) continue;
    const credentials = await exportedCredentials(document, ctx);
    for (const credential of credentials) {
      if (id) {
        const expected = `copilot-${credential.host === "github.com" ? "" : credential.host + "-"}${credential.githubUserId}`;
        if (id !== expected) throw new Error("DevMoor account identity does not match its record.");
      }
      const identity = `${credential.host}:${credential.githubUserId ?? credential.login.toLowerCase()}`;
      if (identities.has(identity)) throw new Error("DevMoor account index contains a duplicate identity.");
      identities.add(identity);
      results.push(descriptor("devmoor", credential.host, credential.login, { kind: "export", file, ...id ? { devmoorId: id } : {} }));
    }
  }
  return results;
}
async function discoverAccounts(options = {}) {
  const ctx = context(options), accounts = [];
  if (options.includeGh !== false) accounts.push(...await discoverGh(ctx));
  if (options.includeDefaults !== false) {
    const files = knownFiles(ctx);
    try {
      const document = await readDocument(files.copilot, true);
      if (document) for (const user of copilotUsers(document)) accounts.push(descriptor("copilot-cli", user.host, user.login, { kind: "copilot-cli", file: files.copilot, rawHost: user.rawHost }));
    } catch {
      ctx.onWarning("Copilot CLI account metadata could not be read.");
    }
    for (const file of files.legacy) {
      try {
        accounts.push(...await discoverLegacy(file));
      } catch {
        ctx.onWarning("A legacy Copilot account source could not be read.");
      }
    }
    try {
      accounts.push(...await discoverDevmoor(ctx));
    } catch {
      ctx.onWarning("DevMoor accounts could not be read. Check the original app for account status.");
    }
  }
  for (const file of options.credentialFiles ?? []) {
    if (typeof file !== "string" || !file) throw new Error("Credential file paths must be non-empty strings.");
    const absolute = path3.resolve(file), document = await readDocument(absolute);
    try {
      for (const credential of await exportedCredentials(document, ctx)) accounts.push(descriptor("credential-file", credential.host, credential.login, { kind: "export", file: absolute }));
    } catch {
      throw new Error("A credential file has an unsupported, ambiguous, or unreadable account format.");
    }
  }
  return [...new Map(accounts.map((account) => [account.id, account])).values()];
}
function powershellCommand(ctx) {
  return ctx.env.SystemRoot ? path3.join(ctx.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
}
function encodedCommand(script) {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
async function readOsKeychain(service, account, ctx) {
  let result;
  const env = accountEnvironment(ctx.env);
  if (ctx.platform === "win32") {
    result = await ctx.run(powershellCommand(ctx), encodedCommand(WINDOWS_KEYRING), { env: { ...env, COPILOT_KEYCHAIN_TARGET: `${service}/${account}` } });
  } else if (ctx.platform === "darwin") result = await ctx.run("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"], { env });
  else result = await ctx.run("secret-tool", ["lookup", "service", service, "account", account], { env });
  return result.code === 0 || result.code === void 0 ? result.stdout.trim() : null;
}
async function decryptDpapi(cipher, ctx) {
  if (ctx.platform !== "win32") throw new Error("This legacy account is protected by its original Windows profile.");
  const script = "$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain)) } catch { exit 1 }";
  const result = await ctx.run(powershellCommand(ctx), encodedCommand(script), { env: accountEnvironment(ctx.env), input: cipher });
  if (result.code !== 0 && result.code !== void 0) throw new Error("This legacy account could not be decrypted by the current Windows profile.");
  return result.stdout;
}
async function resolveCredential(account, options = {}) {
  const ctx = context(options);
  try {
    if (!object(account) || !object(account.locator)) throw new Error();
    const { source, locator } = account, host = normalizeAccountHost(account.host), login = loginName(account.login);
    if (descriptor(source, host, login, locator).id !== account.id) throw new Error();
    let credential;
    if (locator.kind === "gh" && source === "gh") {
      const result = await ctx.run("gh", ["auth", "token", "--hostname", host, "--user", login], { env: accountEnvironment(ctx.env) });
      if (result.code !== 0 && result.code !== void 0) throw new Error();
      credential = { token: tokenValue(result.stdout.trim()), host, login };
    } else if (locator.kind === "copilot-cli" && source === "copilot-cli") {
      const document = await readDocument(locator.file), users = copilotUsers(document);
      const user = users.find((row) => row.host === host && row.login.toLowerCase() === login.toLowerCase() && row.rawHost === locator.rawHost);
      if (!user) throw new Error();
      const settings = await readDocument(path3.join(path3.dirname(locator.file), "settings.json"), true);
      const plaintextOnly = settings?.store_token_plaintext === true || settings?.storeTokenPlaintext === true;
      let token;
      if (!plaintextOnly) {
        try {
          token = await (ctx.readKeychain ?? ((service, key) => readOsKeychain(service, key, ctx)))("copilot-cli", `${user.rawHost}:${user.login}`);
        } catch {
        }
      }
      if (!token) token = (document.copilot_tokens ?? document.copilotTokens)?.[user.tokenKey ?? `${user.rawHost}:${user.login}`];
      credential = { token: tokenValue(token), host, login };
    } else if (locator.kind === "legacy" && source === "copilot-legacy") {
      const document = await readDocument(locator.file), record = document[locator.key];
      credential = credentialRecord(record, locator.key.split(":")[0]);
    } else if (locator.kind === "export" && ["credential-file", "devmoor"].includes(source)) {
      if (locator.devmoorId) {
        const root = path3.dirname(path3.dirname(path3.dirname(locator.file)));
        const index = await readDocument(path3.join(root, "copilot-accounts.json"));
        if (!Array.isArray(index.ids) || !index.ids.includes(locator.devmoorId)) throw new Error();
      }
      const credentials = await exportedCredentials(await readDocument(locator.file), ctx);
      credential = credentials.find((row) => row.host === host && row.login.toLowerCase() === login.toLowerCase());
      if (locator.devmoorId && locator.devmoorId !== `copilot-${host === "github.com" ? "" : host + "-"}${credential?.githubUserId}`) throw new Error();
    } else throw new Error();
    if (!credential || credential.host !== host || credential.login.toLowerCase() !== login.toLowerCase()) throw new Error();
    tokenValue(credential.token);
    if (credential.expiresAt && credential.expiresAt <= ctx.now() / 1e3) throw new Error();
    return credential;
  } catch {
    throw new Error("The selected account credential is unavailable, expired, or changed. Refresh it in its original app, then refresh the account list.");
  }
}
var MAX_FILE_BYTES, HOST, DEVMOOR_ID, sensitiveEnv, object, WINDOWS_KEYRING;
var init_accounts = __esm({
  "plugins/copilot-provider/src/accounts.mjs"() {
    MAX_FILE_BYTES = 2 * 1024 * 1024;
    HOST = /^(?:github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$/;
    DEVMOOR_ID = /^copilot-(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com-)?[1-9][0-9]{0,31}$/;
    sensitiveEnv = /^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|COPILOT_GITHUB_TOKEN|GITHUB_COPILOT_API_TOKEN|GH_HOST|GH_DEBUG)$/i;
    object = (value) => value && typeof value === "object" && !Array.isArray(value);
    WINDOWS_KEYRING = `
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
  }
});

// node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r?\n/);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r?\n/);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError;
var init_error = __esm({
  "node_modules/smol-toml/dist/error.js"() {
    TomlError = class _TomlError extends Error {
      line;
      column;
      codeblock;
      constructor(message, options) {
        const [line, column] = getLineColFromPtr(options.toml, options.ptr);
        const codeblock = makeCodeBlock(options.toml, line, column);
        super(`Invalid TOML document: ${message}

${codeblock}`, options);
        this.line = line;
        this.column = column;
        this.codeblock = codeblock;
      }
      /** @internal */
      static x(message, ctx, ptr) {
        throw new _TomlError(message, { toml: ctx.s, ptr: ptr ?? ctx.p });
      }
    };
  }
});

// node_modules/smol-toml/dist/primitive.js
function parseString(ctx) {
  let startPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (; ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in strings", ctx);
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state) {
        let s = ctx.s.slice(sliceStart, ctx.p);
        parsed = parsed ? parsed + s : s;
      }
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let errPtr = ctx.p++ - 1;
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0; j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            TomlError.x("invalid non-hex character in unicode escape", ctx);
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          TomlError.x("invalid unicode escape", ctx, errPtr);
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p--;
        state = 0;
      } else if (isMultiline && (c === 32 || c === 9)) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "	";
        else if (c === 110)
          parsed += "\n";
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          TomlError.x("unrecognised escape sequence", ctx);
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2)
        TomlError.x("invalid escape: only line-ending whitespace may be escaped", ctx, sliceStart);
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  TomlError.x("unfinished string", ctx, startPtr);
}
var init_primitive = __esm({
  "node_modules/smol-toml/dist/primitive.js"() {
    init_error();
  }
});

// node_modules/smol-toml/dist/date.js
var DATE_TIME_RE, TomlDate;
var init_date = __esm({
  "node_modules/smol-toml/dist/date.js"() {
    DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;
    TomlDate = class _TomlDate extends Date {
      #hasDate = false;
      #hasTime = false;
      #offset = null;
      constructor(date, fasttype, unsafeDelim) {
        let hasDate = true;
        let hasTime = true;
        let offset = "Z";
        let c;
        if (typeof date === "string") {
          if (fasttype)
            prep: {
              if (fasttype < 3) {
                if (+date.slice(11, 13) > 23) {
                  date = "";
                  break prep;
                }
                if (fasttype === 2) {
                  offset = null;
                  date += "Z";
                } else if ((c = date.charCodeAt(date.length - 1)) !== 90 && c !== 122) {
                  offset = date.slice(date.length - 6);
                }
                if (unsafeDelim)
                  date = date.slice(0, 10) + "T" + date.slice(11);
              } else if (fasttype === 4) {
                date = +date.slice(0, 2) > 23 ? "" : `0000-01-01T${date}Z`;
              }
              hasDate = fasttype !== 4;
              hasTime = fasttype !== 3;
            }
          else {
            let match = date.match(DATE_TIME_RE);
            if (match) {
              if (!match[1]) {
                hasDate = false;
                date = `0000-01-01T${date}`;
              }
              hasTime = !!match[2];
              hasTime && date[10] === " " && (date = date.replace(" ", "T"));
              if (match[2] && +match[2] > 23) {
                date = "";
              } else {
                offset = match[3] || null;
                if (!offset && hasTime)
                  date += "Z";
              }
            } else {
              date = "";
            }
          }
        }
        super(date);
        if (!isNaN(this.getTime())) {
          this.#hasDate = hasDate;
          this.#hasTime = hasTime;
          this.#offset = offset;
        }
      }
      isDateTime() {
        return this.#hasDate && this.#hasTime;
      }
      isLocal() {
        return !this.#hasDate || !this.#hasTime || !this.#offset;
      }
      isDate() {
        return this.#hasDate && !this.#hasTime;
      }
      isTime() {
        return this.#hasTime && !this.#hasDate;
      }
      isValid() {
        return this.#hasDate || this.#hasTime;
      }
      toISOString() {
        let iso = super.toISOString();
        if (this.isDate())
          return iso.slice(0, 10);
        if (this.isTime())
          return iso.slice(11, 23);
        if (this.#offset === null)
          return iso.slice(0, -1);
        if (this.#offset === "Z" || this.#offset === "z")
          return iso;
        let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
        offset = this.#offset[0] === "-" ? offset : -offset;
        let offsetDate = new Date(this.getTime() - offset * 6e4);
        return offsetDate.toISOString().slice(0, -1) + this.#offset;
      }
      static wrapAsOffsetDateTime(jsDate, offset = "Z") {
        let date = new _TomlDate(jsDate);
        date.#offset = offset;
        return date;
      }
      static wrapAsLocalDateTime(jsDate) {
        let date = new _TomlDate(jsDate);
        date.#offset = null;
        return date;
      }
      static wrapAsLocalDate(jsDate) {
        let date = new _TomlDate(jsDate);
        date.#hasTime = false;
        date.#offset = null;
        return date;
      }
      static wrapAsLocalTime(jsDate) {
        let date = new _TomlDate(jsDate);
        date.#hasDate = false;
        date.#offset = null;
        return date;
      }
    };
  }
});

// node_modules/smol-toml/dist/extract.js
function isDigit(char, base = 10) {
  return base === 16 ? char > 47 && char < 58 || char > 64 && char < 71 || char > 96 && char < 103 : char > 47 && char < 48 + base;
}
function isEndOfValue(char, delim) {
  return char === 32 || char === 9 || char === 10 || char === 13 || // Structure end or next value delimiter
  delim && (char === delim || char === 44) || // Comment
  char === 35;
}
function extractValue(ctx, end) {
  let errPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p);
  if (c === 91 || c === 123) {
    ctx.d-- || TomlError.x("document contains excessively nested structures. aborting.", ctx);
    let value = c === 91 ? parseArray(ctx) : parseInlineTable(ctx);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, false;
  }
  if (c === 43 || c === 45) {
    return parseNumber(ctx, ctx.p, ctx.s.charCodeAt(++ctx.p), 44 - c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 4) === 45 && ctx.s.charCodeAt(ctx.p + 7) === 45) {
    return parseDate(ctx, c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 2) === 58) {
    return parseTime(ctx, c, end);
  }
  return parseNumber(ctx, ctx.p, c, 0, end);
}
function parseNumber(ctx, startPtr, startChr, sign, endChr) {
  let c = startChr;
  let state = 0;
  let hasUnderscores = false;
  if (c === 105) {
    if (ctx.s.charCodeAt(++ctx.p) !== 110 || ctx.s.charCodeAt(++ctx.p) !== 102)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, (sign || 1) / 0;
  }
  if (c === 110) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 110)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, NaN;
  }
  if (c === 48) {
    if (++ctx.p >= ctx.s.length || isEndOfValue(c = ctx.s.charCodeAt(ctx.p), endChr))
      return ctx.bi === true ? 0n : 0;
    if (!sign) {
      if (c === 120)
        return parseIntegerBaseN(ctx, startPtr, 16, endChr);
      else if (c === 98)
        return parseIntegerBaseN(ctx, startPtr, 2, endChr);
      else if (c === 111)
        return parseIntegerBaseN(ctx, startPtr, 8, endChr);
    }
    if (c === 46)
      state = 2;
    else if (c === 101 || c === 69)
      state = 4;
    else
      TomlError.x("illegal leading zero", ctx, startPtr);
  } else if (!isDigit(c))
    TomlError.x("invalid value", ctx, startPtr);
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (!state)
      state = 1;
    if (c === 95) {
      if (!(state & 1))
        TomlError.x("illegal underscore", ctx);
      state += 11;
      hasUnderscores = true;
    } else if (state === 1 && c === 46)
      state = 2;
    else if ((state === 1 || state === 3) && (c === 101 || c === 69))
      state = 4;
    else if (state === 4 && (c === 43 || c === 45)) {
      state = 6;
    } else if (!isDigit(c))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (state > 9)
      state -= 11;
    else if (!(state & 1))
      state++;
  }
  if (!state) {
    let val = (startChr - 48) * (sign || 1);
    return ctx.bi === true ? BigInt(val) : val;
  }
  if (!(state & 1))
    TomlError.x("unfinished numeric value", ctx, startPtr);
  let str = ctx.s.slice(startPtr, ctx.p);
  if (hasUnderscores)
    str = str.replaceAll("_", "");
  return state > 1 ? parseFloat(str) : parseInteger(ctx, str, 10, startPtr);
}
function parseIntegerBaseN(ctx, startPtr, base, endChr) {
  let c, underscore = 1;
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (c === 95) {
      if (underscore & 1)
        TomlError.x("illegal underscore", ctx);
      underscore = 3;
    } else if (!isDigit(c, base))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (underscore & 1)
      underscore--;
  }
  if (underscore & 1)
    TomlError.x("unfinished numeric value", ctx);
  let str = ctx.s.slice(startPtr + 2, ctx.p);
  if (underscore)
    str = str.replaceAll("_", "");
  return parseInteger(ctx, str, base, startPtr);
}
function parseInteger(ctx, str, base, startPtr) {
  if (ctx.bi !== true)
    int: {
      let val = parseInt(str, base);
      if (!Number.isSafeInteger(val)) {
        if (ctx.bi)
          break int;
        TomlError.x("integer value cannot be represented losslessly", ctx, startPtr);
      }
      return val;
    }
  return base === 10 ? BigInt(str) : BigInt((base === 2 ? "0b" : base === 8 ? "0o" : "0x") + str);
}
function parseDate(ctx, c, endChr) {
  let startPtr = ctx.p++, unsafeSeparator;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++)) || !isDigit(ctx.s.charCodeAt(ctx.p++))) {
    return parseNumber(ctx, ctx.p = startPtr, c, 0, endChr);
  }
  ctx.p += 5;
  if (!isDigit(ctx.s.charCodeAt(ctx.p++)))
    TomlError.x("invalid date-time: date part is malformed", ctx, startPtr);
  if (ctx.p >= ctx.s.length || ((c = ctx.s.charCodeAt(ctx.p)) !== 32 || (unsafeSeparator = true, !isDigit(ctx.s.charCodeAt(ctx.p + 1)))) && c !== 84 && c !== 116) {
    let t2 = ctx.s.slice(startPtr, ctx.p);
    return readDate(ctx, t2, 3, false, startPtr);
  }
  if (ctx.s.charCodeAt(ctx.p += 3) !== 58)
    TomlError.x("invalid date-time: time part is malformed", ctx, startPtr);
  if (ctx.s.charCodeAt(ctx.p += 3) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  if (c = ctx.s.charCodeAt(ctx.p)) {
    if (c === 90 || c === 122) {
      let t2 = ctx.s.slice(startPtr, ++ctx.p);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, "[+00:00]");
    }
    if (c === 43 || c === 45) {
      let t2 = ctx.s.slice(startPtr, ctx.p += 6);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, !ctx.ld && "[" + ctx.s.slice(ctx.p - 6, ctx.p) + "]");
    }
  }
  let t = ctx.s.slice(startPtr, ctx.p);
  return readDate(ctx, t, 2, unsafeSeparator, startPtr);
}
function parseTime(ctx, c, endChr) {
  let start = ctx.p;
  if (!isDigit(c) || !isDigit(ctx.s.charCodeAt(++ctx.p))) {
    return parseNumber(ctx, --ctx.p, c, 0, endChr);
  }
  if (ctx.s.charCodeAt(ctx.p += 4) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit(ctx.s.charCodeAt(++ctx.p)))
      ;
  let t = ctx.s.slice(start, ctx.p);
  return readDate(ctx, t, 4, false, start);
}
function readDate(ctx, str, type, unsafeDelim, errPtr, temporalSuffix) {
  if (ctx.ld) {
    let date = new TomlDate(str, type, unsafeDelim);
    if (!date.isValid())
      TomlError.x("invalid date", ctx, errPtr);
    return date;
  }
  try {
    if (temporalSuffix)
      str += temporalSuffix;
    switch (type) {
      case 1:
        return Temporal.ZonedDateTime.from(str);
      case 2:
        return Temporal.PlainDateTime.from(str);
      case 3:
        return Temporal.PlainDate.from(str);
      case 4:
        return Temporal.PlainTime.from(str);
    }
  } catch (e) {
    TomlError.x(e instanceof Error ? e.message : "" + e, ctx, errPtr);
  }
}
var init_extract = __esm({
  "node_modules/smol-toml/dist/extract.js"() {
    init_primitive();
    init_struct();
    init_error();
    init_date();
  }
});

// node_modules/smol-toml/dist/util.js
function skipComment(ctx) {
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      TomlError.x("control characters are not allowed in comments", ctx);
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (ctx.p < ctx.s.length) {
    while (ctx.p < ctx.s.length && ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}
var init_util = __esm({
  "node_modules/smol-toml/dist/util.js"() {
    init_error();
  }
});

// node_modules/smol-toml/dist/struct.js
function parseKey(ctx, end = 61) {
  let startPtr;
  let state = 0;
  let parsed = [];
  let sliceStart;
  let c = ctx.s.charCodeAt(startPtr = ctx.p);
  do {
    if (c === end) {
      if (!state)
        TomlError.x("unexpected end of key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      return ctx.p++, parsed;
    } else if (c === 46) {
      if (!state)
        TomlError.x("illegal empty bare key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      state = 0;
    } else if (!state && (c === 34 || c === 39)) {
      if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2))
        TomlError.x("illegal quoted key: multiline strings are not allowed", ctx);
      parsed.push(parseString(ctx));
      state = 2;
      ctx.p--;
    } else if (c === 32 || c === 9) {
      if (state === 1) {
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
        state = 2;
      }
    } else if (state === 2 || c < 48 && c !== 45 || c > 57 && c < 65 || c > 90 && c < 97 && c !== 95 || c > 122) {
      TomlError.x("illegal character in key", ctx);
    } else if (!state) {
      state = 1;
      sliceStart = ctx.p;
    }
  } while (c = ctx.s.charCodeAt(++ctx.p));
  TomlError.x("incomplete key-value: cannot find end of key", ctx, startPtr);
}
function parseInlineTable(ctx) {
  let startPtr = ctx.p++;
  let res = /* @__PURE__ */ Object.create(null);
  let seen = /* @__PURE__ */ new Set();
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let errPtr = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0; i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        TomlError.x("trying to redefine an already defined value", ctx, errPtr);
      }
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor")) {
        t = ctx.uk !== 1 && TomlError.x("document contains an unsafe property", ctx, errPtr);
        break;
      }
      if (!hasOwn && unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      TomlError.x("trying to redefine an already defined value", ctx, errPtr);
    }
    skipVoid(ctx, true, true);
    let value = extractValue(
      ctx,
      125
      /* } */
    );
    if (t && typeof (t[k] = value) === "object")
      seen.add(value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished table", ctx, startPtr);
}
function parseArray(ctx) {
  let startPtr = ctx.p++;
  let res = [];
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(
      ctx,
      93
      /* ] */
    ));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished array", ctx, startPtr);
}
var init_struct = __esm({
  "node_modules/smol-toml/dist/struct.js"() {
    init_primitive();
    init_extract();
    init_util();
    init_error();
  }
});

// node_modules/smol-toml/dist/parse.js
function peekTable(ctx, key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor"))
        return false;
      if (unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: /* @__PURE__ */ Object.create(null)
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = /* @__PURE__ */ Object.create(null));
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: /* @__PURE__ */ Object.create(null) };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function validateTablePeek(ctx, peek, ptr) {
  if (peek === null || ctx.uk === 2)
    TomlError.x(peek === null ? "trying to redefine an already defined table or value" : "document contains an unsafe property", ctx, ptr);
}
function parse(toml, options = {}) {
  let ctx = {
    s: toml,
    p: 0,
    d: options.maxDepth ?? 1e3,
    bi: options.integersAsBigInt ?? false,
    ld: options.useLegacyDate ?? true,
    uk: options.unsafeKeyBehaviour === "throw" ? 2 : options.unsafeKeyBehaviour === "drop" ? 1 : 0
  };
  let res = /* @__PURE__ */ Object.create(null);
  let meta = /* @__PURE__ */ Object.create(null);
  let tmp;
  let skipping = false;
  let tbl = res;
  let m = meta;
  if (toml.charCodeAt(0) === 65279)
    ctx.p++;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      skipping = false;
      let k = parseKey(
        ctx,
        93
        /* ] */
      );
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p) !== 93) {
          TomlError.x("expected end of table array declaration", ctx);
        }
        ctx.p++;
      }
      let p = peekTable(
        ctx,
        k,
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        validateTablePeek(ctx, p, tmp);
        skipping = true;
      } else {
        m = p[2];
        tbl = p[1];
      }
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(
        ctx,
        k,
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p && !skipping)
        validateTablePeek(ctx, p, tmp);
      skipVoid(ctx, true, true);
      let v = extractValue(ctx, void 0);
      if (p && !skipping)
        p[1][p[0]] = v;
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && (tmp !== 13 || toml.charCodeAt(ctx.p + 1) !== 10)) {
      TomlError.x("each key-value declaration must be followed by an end-of-line", ctx);
    }
    skipVoid(ctx);
  }
  return res;
}
var init_parse = __esm({
  "node_modules/smol-toml/dist/parse.js"() {
    init_struct();
    init_extract();
    init_util();
    init_error();
  }
});

// node_modules/smol-toml/dist/stringify.js
var HAS_WELLFORMED;
var init_stringify = __esm({
  "node_modules/smol-toml/dist/stringify.js"() {
    HAS_WELLFORMED = !!"".isWellFormed;
  }
});

// node_modules/smol-toml/dist/index.js
var init_dist = __esm({
  "node_modules/smol-toml/dist/index.js"() {
    init_parse();
    init_stringify();
    init_date();
    init_error();
  }
});

// plugins/copilot-provider/src/config.mjs
import fs4 from "node:fs/promises";
import path4 from "node:path";
import { randomBytes as randomBytes2, createHash as createHash2 } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
function locations(paths2) {
  return {
    journal: path4.join(paths2.dataDir, "config-install.json"),
    lock: path4.join(paths2.dataDir, "config-edit.lock"),
    backups: path4.join(paths2.dataDir, "config-backups"),
    selection: path4.join(paths2.dataDir, "selection-pending.json"),
    selectionLock: path4.join(paths2.dataDir, "selection-edit.lock")
  };
}
function hash(text) {
  return createHash2("sha256").update(text).digest("hex");
}
function quote(value) {
  return JSON.stringify(value);
}
function parseConfig(text) {
  try {
    return parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Codex config.toml is not valid TOML. No configuration was changed.");
  }
}
async function readConfig(file) {
  try {
    return { text: await fs4.readFile(file, "utf8"), exists: true };
  } catch (error) {
    if (error.code === "ENOENT") return { text: "", exists: false };
    throw error;
  }
}
async function withLock(paths2, work, lockFile) {
  await fs4.mkdir(paths2.dataDir, { recursive: true, mode: 448 });
  const lock = lockFile ?? locations(paths2).lock;
  let handle;
  try {
    handle = await fs4.open(lock, "wx", 384);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another provider configuration operation is active. If it was interrupted, remove ${lock} after confirming it has stopped.`);
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}
${(/* @__PURE__ */ new Date()).toISOString()}
`);
    return await work();
  } finally {
    await handle.close();
    await fs4.rm(lock, { force: true });
  }
}
function statements(text) {
  const spans = [];
  let start = 0;
  while (start < text.length) {
    let i = start;
    while (text[i] === " " || text[i] === "	" || text[i] === "\r") i++;
    if (text[i] === "\n" || text[i] === "#") {
      const end = text.indexOf("\n", i);
      start = end < 0 ? text.length : end + 1;
      continue;
    }
    let string = null;
    let triple = false;
    let depth = 0;
    let equals = -1;
    for (; i < text.length; i++) {
      const char = text[i];
      if (string) {
        if (string === '"' && char === "\\") {
          i++;
          continue;
        }
        if (char === string) {
          if (!triple) string = null;
          else if (text.slice(i, i + 3) === string.repeat(3)) {
            let count = 3;
            while (count < 5 && text[i + count] === string) count++;
            i += count - 1;
            string = null;
          }
        }
        continue;
      }
      if (char === '"' || char === "'") {
        string = char;
        triple = text.slice(i, i + 3) === char.repeat(3);
        if (triple) i += 2;
      } else if (char === "#") {
        const newline = text.indexOf("\n", i);
        if (newline < 0) {
          i = text.length;
          break;
        }
        i = newline;
        if (depth === 0) {
          i++;
          break;
        }
      } else if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") depth--;
      else if (char === "=" && equals < 0) equals = i;
      else if (char === "\n" && depth === 0) {
        i++;
        break;
      }
    }
    spans.push({ start, end: i, equals, text: text.slice(start, i) });
    start = i;
  }
  return spans;
}
function rootAssignments(text, keys) {
  const found = /* @__PURE__ */ new Map();
  for (const statement of statements(text)) {
    if (statement.text.trimStart().startsWith("[")) break;
    if (statement.equals < 0) continue;
    const lhs = text.slice(statement.start, statement.equals);
    let key;
    try {
      const probe = parse(`${lhs}= 1`);
      key = Object.keys(probe)[0];
      if (Object.keys(probe).length !== 1 || probe[key] !== 1) continue;
    } catch {
      continue;
    }
    if (keys.includes(key)) found.set(key, statement);
  }
  return found;
}
function replaceExactlyOnce(text, value, replacement) {
  const index = text.indexOf(value);
  if (index < 0 || text.indexOf(value, index + value.length) >= 0) {
    throw new Error("The plugin-owned Codex configuration was changed or removed. Refusing to overwrite it; restore the conflicting plugin block or saved-setting marker first.");
  }
  return text.slice(0, index) + replacement + text.slice(index + value.length);
}
function unapply(text, state) {
  const parsed = parseConfig(text);
  const expectedProvider = parseConfig(state.providerBlock).model_providers?.[PROVIDER_ID];
  if (!isDeepStrictEqual(parsed.model_providers?.[PROVIDER_ID], expectedProvider)) {
    throw new Error("The copilot-local provider contains user changes. Refusing to overwrite or remove those changes.");
  }
  let restored = replaceExactlyOnce(text, state.rootBlock, "");
  restored = replaceExactlyOnce(restored, state.providerBlock, "");
  for (const saved of state.saved) restored = replaceExactlyOnce(restored, saved.marker, saved.original);
  parseConfig(restored);
  return restored;
}
function canUnapply(text, state) {
  if (!state) return false;
  try {
    unapply(text, state);
    return true;
  } catch {
    return false;
  }
}
async function loadJournal(paths2, config) {
  const { journal } = locations(paths2);
  const record = await readJson(journal);
  if (!record) return null;
  if (record.version !== JOURNAL_VERSION || !Object.hasOwn(record, "active")) {
    throw new Error("Unsupported provider configuration journal. No configuration was changed.");
  }
  if (!record.pending) return record.active;
  if (hash(config.text) === record.pending.afterHash || canUnapply(config.text, record.pending.next)) {
    await writeJson(journal, { version: JOURNAL_VERSION, active: record.pending.next });
    return record.pending.next;
  }
  if (hash(config.text) === record.pending.beforeHash || canUnapply(config.text, record.active)) {
    await writeJson(journal, { version: JOURNAL_VERSION, active: record.active });
    return record.active;
  }
  throw new Error("An interrupted provider configuration update conflicts with the current config.toml. No configuration was changed.");
}
async function backupConfig(paths2, config) {
  if (!config.exists) return null;
  const { backups } = locations(paths2);
  await fs4.mkdir(backups, { recursive: true, mode: 448 });
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const file = path4.join(backups, `config.${stamp}.${randomBytes2(6).toString("hex")}.toml`);
  await fs4.writeFile(file, config.text, { flag: "wx", mode: 384 });
  return file;
}
async function writeConfig(paths2, before, text, remove = false) {
  const current = await readConfig(paths2.configFile);
  if (current.text !== before.text || current.exists !== before.exists) {
    throw new Error("Codex config.toml changed during setup. Retry after the other editor finishes.");
  }
  if (remove) {
    await fs4.rm(paths2.configFile, { force: true });
    return;
  }
  await fs4.mkdir(path4.dirname(paths2.configFile), { recursive: true, mode: 448 });
  const temporary = `${paths2.configFile}.${process.pid}.${randomBytes2(6).toString("hex")}.tmp`;
  try {
    await fs4.writeFile(temporary, text, { flag: "wx", mode: 384 });
    await fs4.rename(temporary, paths2.configFile);
  } finally {
    await fs4.rm(temporary, { force: true });
  }
}
function installText(base, options, previous) {
  const bom = base.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = base.slice(bom.length);
  const parsed = parseConfig(body);
  if (Object.hasOwn(parsed.model_providers ?? {}, PROVIDER_ID)) {
    throw new Error("A copilot-local provider already exists and is not owned by this plugin. Choose another provider or remove that conflicting configuration before setup.");
  }
  if (body.includes(markerPrefix)) throw new Error("Untracked copilot-provider markers already exist in config.toml. Restore their configuration journal before setup.");
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const id = previous?.id ?? randomBytes2(8).toString("hex");
  const values = { model: options.model, model_provider: PROVIDER_ID };
  if (options.catalogPath) values.model_catalog_json = options.catalogPath;
  const assignments = rootAssignments(body, Object.keys(values));
  const saved = [];
  let edited = body;
  for (const [key, value] of Object.entries(values)) {
    if (Object.hasOwn(parsed, key) && !assignments.has(key)) {
      throw new Error(`The existing ${key} setting uses a form this installer cannot safely edit. No configuration was changed.`);
    }
    if (typeof value !== "string") throw new Error(`Invalid ${key} setting.`);
  }
  for (const [key, statement] of [...assignments].sort((a, b) => b[1].start - a[1].start)) {
    const trailingNewline = statement.text.endsWith("\n") ? newline : "";
    const marker = `${markerPrefix}saved:${id}:${key}${trailingNewline}`;
    saved.push({ key, marker, original: statement.text });
    edited = edited.slice(0, statement.start) + marker + edited.slice(statement.end);
  }
  const rootBlock = `${markerPrefix}begin:${id}:settings${newline}` + Object.entries(values).map(([key, value]) => `${key} = ${quote(value)}${newline}`).join("") + `${markerPrefix}end:${id}:settings${newline}`;
  const provider = {
    name: "GitHub Copilot (local)",
    base_url: `http://127.0.0.1:${options.port}/v1`,
    wire_api: "responses",
    requires_openai_auth: false,
    auth: { command: process.execPath, args: [options.cliPath, "token"], timeout_ms: 3e4, refresh_interval_ms: 6e4 }
  };
  const separator = edited.length && !edited.endsWith("\n") ? newline : "";
  const providerBlock = `${separator}${markerPrefix}begin:${id}:provider${newline}[model_providers.${PROVIDER_ID}]${newline}name = ${quote(provider.name)}${newline}base_url = ${quote(provider.base_url)}${newline}wire_api = "responses"${newline}requires_openai_auth = false${newline}[model_providers.${PROVIDER_ID}.auth]${newline}command = ${quote(provider.auth.command)}${newline}args = ${quote(provider.auth.args)}${newline}timeout_ms = 30000${newline}refresh_interval_ms = 60000${newline}${markerPrefix}end:${id}:provider${newline}`;
  const text = bom + rootBlock + edited + providerBlock;
  parseConfig(text);
  return { text, state: { id, rootBlock, providerBlock, provider, saved } };
}
function validateOptions({ model, port, cliPath: cliPath2, catalogPath }) {
  if (typeof model !== "string" || !model.trim() || model !== model.trim() || /[\x00-\x1f\x7f]/.test(model) || model.length > 256) {
    throw new Error("Choose a nonempty model ID without whitespace at its edges or control characters.");
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local proxy port.");
  if (typeof cliPath2 !== "string" || !path4.isAbsolute(cliPath2)) throw new Error("The plugin CLI path must be absolute.");
  if (catalogPath !== void 0 && (typeof catalogPath !== "string" || !path4.isAbsolute(catalogPath))) {
    throw new Error("The model catalog path must be absolute.");
  }
  return { model, port, cliPath: cliPath2, ...catalogPath ? { catalogPath } : {} };
}
async function configureProvider(options, paths2 = getPaths()) {
  const validated = validateOptions(options);
  if (validated.catalogPath) {
    const catalog = validateCatalog(await readJson(validated.catalogPath));
    if (!catalog.models.some((model) => model.slug === validated.model)) throw new Error("The selected model is missing from the supplied Codex model catalog.");
  }
  return withLock(paths2, async () => {
    const before = await readConfig(paths2.configFile);
    const previous = await loadJournal(paths2, before);
    const base = previous ? unapply(before.text, previous) : before.text;
    const result = installText(base, validated, previous);
    if (result.text === before.text) return { configFile: paths2.configFile, backupFile: previous?.backupFile ?? null, restartRequired: true, changed: false };
    const backupFile = await backupConfig(paths2, before);
    const next = {
      ...result.state,
      originalExisted: previous?.originalExisted ?? before.exists,
      backupFile: previous?.backupFile ?? backupFile,
      latestBackupFile: backupFile
    };
    const { journal } = locations(paths2);
    await writeJson(journal, {
      version: JOURNAL_VERSION,
      active: previous,
      pending: { beforeHash: hash(before.text), afterHash: hash(result.text), next }
    });
    await writeConfig(paths2, before, result.text);
    await writeJson(journal, { version: JOURNAL_VERSION, active: next });
    return { configFile: paths2.configFile, backupFile, restartRequired: true, changed: true };
  });
}
async function restoreProvider(paths2 = getPaths()) {
  return withLock(paths2, async () => {
    await assertSelectionReady(paths2);
    return withLock(paths2, async () => {
      const before = await readConfig(paths2.configFile);
      const state = await loadJournal(paths2, before);
      if (!state) return { configFile: paths2.configFile, restored: false, restartRequired: false };
      const restored = unapply(before.text, state);
      const backupFile = await backupConfig(paths2, before);
      const { journal } = locations(paths2);
      await writeJson(journal, {
        version: JOURNAL_VERSION,
        active: state,
        pending: { beforeHash: hash(before.text), afterHash: hash(restored), next: null }
      });
      await writeConfig(paths2, before, restored, !state.originalExisted && restored === "");
      await writeJson(journal, { version: JOURNAL_VERSION, active: null });
      return { configFile: paths2.configFile, backupFile, restored: true, restartRequired: true };
    });
  }, locations(paths2).selectionLock);
}
function pendingSelectionError(cause) {
  if (cause?.code === "selection_incomplete") return cause;
  const detail = cause ? ` Details: ${safeError(cause)}` : "";
  const error = new Error(`An account/model change is unfinished. Inference is paused to avoid using the wrong account. Open Copilot setup and apply the intended account and model again.${detail}`);
  error.status = 503;
  error.code = "selection_incomplete";
  if (cause) error.cause = cause;
  return error;
}
async function hasPendingSelection(paths2 = getPaths()) {
  try {
    await fs4.stat(locations(paths2).selection);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function assertSelectionReady(paths2 = getPaths()) {
  if (await hasPendingSelection(paths2)) throw pendingSelectionError();
}
function selectionOptions(options) {
  if (typeof options.accountId !== "string" || !options.accountId.trim() || options.accountId.length > 256 || /[\x00-\x1f\x7f]/.test(options.accountId)) {
    throw new Error("Choose an existing account before applying the model provider.");
  }
  return { accountId: options.accountId, ...validateOptions(options) };
}
async function finishSelection(record, paths2, { configureProviderImpl = configureProvider, persistSettings = updateSettings } = {}) {
  const { accountId, ...provider } = selectionOptions(record.selection);
  const configured = await configureProviderImpl(provider, paths2);
  await persistSettings({ accountId, model: provider.model, port: provider.port }, paths2);
  const saved = await readSettings(paths2);
  if (saved.accountId !== accountId || saved.model !== provider.model || saved.port !== provider.port) {
    throw pendingSelectionError();
  }
  const current = await readJson(locations(paths2).selection);
  if (current?.id !== record.id) throw new Error("The pending account selection changed during setup. Inference remains paused.");
  await fs4.rm(locations(paths2).selection);
  return configured;
}
async function applyProviderSelection(options, paths2 = getPaths(), dependencies = {}) {
  const selection = selectionOptions(options);
  return withLock(paths2, async () => {
    const file = locations(paths2).selection;
    const pending = await readJson(file);
    if (pending && (pending.version !== 1 || !pending.id || !pending.selection)) {
      throw new Error("The pending account selection journal is invalid. Inference remains paused; preserve the journal for recovery.");
    }
    const record = { version: 1, id: randomBytes2(12).toString("hex"), selection, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
    await writeJson(file, record);
    try {
      return await finishSelection(record, paths2, dependencies);
    } catch (error) {
      throw pendingSelectionError(error);
    }
  }, locations(paths2).selectionLock);
}
function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.models) || !catalog.models.length) throw new Error("Supply a Codex ModelsResponse object with a nonempty models array.");
  const seen = /* @__PURE__ */ new Set();
  const strings = ["slug", "display_name", "shell_type", "visibility", "base_instructions"];
  const booleans = ["supported_in_api", "supports_reasoning_summaries", "support_verbosity", "supports_parallel_tool_calls"];
  for (const model of catalog.models) {
    if (!model || strings.some((key) => typeof model[key] !== "string") || !model.slug.trim() || booleans.some((key) => typeof model[key] !== "boolean") || !Number.isInteger(model.priority) || !Array.isArray(model.supported_reasoning_levels) || !Array.isArray(model.experimental_supported_tools) || !model.truncation_policy || typeof model.truncation_policy !== "object" || seen.has(model.slug)) {
      throw new Error("The supplied catalog lacks complete, uniquely named Codex model metadata. A raw Copilot model list cannot be used as a Codex catalog.");
    }
    seen.add(model.slug);
  }
  return catalog;
}
var PROVIDER_ID, JOURNAL_VERSION, markerPrefix;
var init_config = __esm({
  "plugins/copilot-provider/src/config.mjs"() {
    init_dist();
    init_state();
    PROVIDER_ID = "copilot-local";
    JOURNAL_VERSION = 1;
    markerPrefix = "# copilot-provider:";
  }
});

// plugins/copilot-provider/src/copilot.mjs
import { randomUUID } from "node:crypto";
function githubApiBase(host) {
  const normalized = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!/^(?:github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$/.test(normalized)) {
    throw new CopilotError("Invalid GitHub account host.", 400, "invalid_account_host");
  }
  if (normalized === "github.com") return "https://api.github.com";
  if (normalized.endsWith(".ghe.com")) return `https://api.${normalized}`;
  throw new CopilotError("Only GitHub.com and GitHub Enterprise Cloud accounts are supported.", 400, "invalid_account_host");
}
function validateCopilotEndpoint(value, host) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new CopilotError("Copilot returned an invalid API endpoint.");
  }
  const hostname = url.hostname.toLowerCase();
  const accountHost = String(host).toLowerCase();
  githubApiBase(accountHost);
  const allowed = accountHost === "github.com" ? hostname === "githubcopilot.com" || hostname.endsWith(".githubcopilot.com") : hostname.endsWith(`.${accountHost}`);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port && url.port !== "443" || url.pathname !== "/" || !allowed) {
    throw new CopilotError("Copilot returned an untrusted API endpoint.", 502, "untrusted_upstream");
  }
  return url.origin;
}
function createResponsesAdapter(original) {
  const alias = "copilot_proxy_collaboration";
  const messageTools = /* @__PURE__ */ new Set(["spawn_agent", "send_message", "followup_task"]);
  const input = structuredClone(original);
  const namespaces = [];
  const candidates = [];
  const identities = /* @__PURE__ */ new Map();
  let conflict = false;
  const encrypted = (value) => value && typeof value === "object" && Object.entries(value).some(([key, nested]) => key === "encrypted" ? nested !== false : encrypted(nested));
  const visit = (tools, namespace = "") => {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      if (!tool || typeof tool !== "object") continue;
      const name = tool.name;
      if (typeof name === "string" && (name === alias || name.startsWith(`${alias}.`) || name.startsWith(`${alias}__`))) conflict = true;
      if (tool.type === "namespace") {
        if (name === "collaboration") namespaces.push(tool);
        visit(tool.tools, name);
        continue;
      }
      if (namespace !== "collaboration" || typeof name !== "string") continue;
      identities.set(name, false);
      if (!messageTools.has(name)) continue;
      const message = tool.parameters?.properties?.message;
      const remaining = structuredClone(tool.parameters || {});
      if (remaining.properties?.message) delete remaining.properties.message.encrypted;
      if (tool.type !== "function" || message?.type !== "string" || "encrypted" in message && typeof message.encrypted !== "boolean" || encrypted(remaining)) {
        conflict = true;
        continue;
      }
      candidates.push(tool);
      identities.set(name, true);
    }
  };
  visit(input.tools);
  if (Array.isArray(input.input)) {
    for (const item of input.input) if (item?.type === "additional_tools") visit(item.tools);
  }
  if (input.tool_choice != null && !["auto", "none", "required"].includes(input.tool_choice)) conflict = true;
  if (!conflict && candidates.length) {
    for (const tool of candidates) delete tool.parameters.properties.message.encrypted;
    for (const namespace of namespaces) namespace.name = alias;
  } else identities.clear();
  const rewriteCall = (item, complete) => {
    if (!item || !["function_call", "custom_tool_call"].includes(item.type) || !identities.size) return;
    let name = item.name;
    let matched = item.namespace === alias;
    if (!item.namespace && typeof name === "string") {
      for (const separator of [".", "__"]) if (name.startsWith(alias + separator)) {
        name = name.slice(alias.length + separator.length);
        matched = true;
        break;
      }
    }
    if (!matched || !identities.has(name)) return;
    item.name = name;
    item.namespace = "collaboration";
    if (!complete || item.type !== "function_call" || !identities.get(name) || item.status && item.status !== "completed" || item.encrypted_function_args != null) return;
    try {
      const args2 = JSON.parse(item.arguments);
      if (typeof args2.message === "string" && !args2.message.trimStart().startsWith("gAAAAA")) item.encrypted_function_args = [];
    } catch {
    }
  };
  const anchors = /* @__PURE__ */ new Map();
  const rewrite = (payload) => {
    if (!payload || typeof payload !== "object") return payload;
    const event = payload.type || "";
    if (event.startsWith("response.")) {
      const index = payload.output_index;
      if (Number.isSafeInteger(index) && index >= 0) {
        const item = payload.item;
        if (event === "response.output_item.added" && typeof item?.id === "string" && item.id && typeof item.type === "string" && item.type && !anchors.has(index)) anchors.set(index, { id: item.id, kind: item.type, blocked: false });
        const anchor = anchors.get(index);
        if (anchor && !anchor.blocked) {
          if (item && item.type !== anchor.kind) anchor.blocked = true;
          else {
            if (typeof item?.id === "string" && item.id) item.id = anchor.id;
            if (typeof payload.item_id === "string" && payload.item_id) payload.item_id = anchor.id;
          }
        }
      }
      if (["response.completed", "response.failed", "response.incomplete", "response.in_progress"].includes(event)) {
        const output = payload.response?.output;
        if (Array.isArray(output) && [...anchors.keys()].every((index2) => index2 < output.length)) {
          output.forEach((item, index2) => {
            const anchor = anchors.get(index2);
            if (anchor && !anchor.blocked && item?.type === anchor.kind && typeof item.id === "string" && item.id) item.id = anchor.id;
          });
        }
      }
    }
    if (event === "response.output_item.added" || event === "response.output_item.done") rewriteCall(payload.item, event.endsWith(".done"));
    else if (event === "" || ["response.created", "response.in_progress", "response.completed", "response.failed", "response.incomplete"].includes(event)) {
      const output = event ? payload.response?.output : payload.output;
      const complete = event ? event === "response.completed" : !payload.status || payload.status === "completed";
      if (Array.isArray(output)) for (const item of output) rewriteCall(item, complete);
    }
    return payload;
  };
  return { input: identities.size ? input : original, rewrite };
}
async function* rewriteSSE(body, rewrite) {
  const decoder = new TextDecoder();
  let pending = "";
  const frame = (source) => {
    const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [];
    const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/\r?\n$/, "")).join("\n");
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return source;
    }
    const before = JSON.stringify(parsed);
    const after = JSON.stringify(rewrite(parsed));
    if (before === after) return source;
    let written = false;
    return lines.map((line) => {
      if (!line.startsWith("data:")) return line;
      if (written) return "";
      written = true;
      return `data: ${after}${line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : ""}`;
    }).join("");
  };
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary;
    while (boundary = /\r?\n\r?\n/.exec(pending)) {
      const end = boundary.index + boundary[0].length;
      if (Buffer.byteLength(pending.slice(0, end)) > 4 * 1024 * 1024) throw new CopilotError("Copilot sent an oversized stream event.");
      yield frame(pending.slice(0, end));
      pending = pending.slice(end);
    }
    if (Buffer.byteLength(pending) > 4 * 1024 * 1024) throw new CopilotError("Copilot sent an oversized stream event.");
  }
  pending += decoder.decode();
  if (pending) yield frame(pending);
}
function serviceError(response, operation) {
  const status = response.status;
  const retryAfter = /^\d{1,6}$/.test(response.headers.get("retry-after") || "") ? response.headers.get("retry-after") : void 0;
  if (status === 401) return new CopilotError(`The selected account needs renewed GitHub Copilot authorization (${operation}).`, 401, "copilot_authentication_failed");
  if (status === 403) return new CopilotError(`The selected account cannot access Copilot (${operation}). Check its subscription, organization policy, and SSO authorization.`, 403, "copilot_access_denied");
  if (status === 429) return new CopilotError("The selected Copilot account is rate limited. Try again after its limit resets.", 429, "copilot_rate_limited", retryAfter);
  return new CopilotError(`Copilot ${operation} failed (HTTP ${status}).`, status >= 400 && status < 500 ? status : 502, "copilot_upstream_error");
}
function headers(token, accept = "application/json") {
  const requestId = randomUUID();
  return {
    authorization: `Bearer ${token}`,
    accept,
    "content-type": "application/json",
    "copilot-integration-id": "vscode-chat",
    "editor-version": "vscode/1.107.0",
    "editor-plugin-version": "copilot-chat/0.35.0",
    "user-agent": "GitHubCopilotChat/0.35.0",
    "x-github-api-version": "2025-04-01",
    "openai-intent": "conversation-edits",
    "x-interaction-type": "conversation-edits",
    "x-initiator": "user",
    "x-request-id": requestId,
    "x-agent-task-id": requestId
  };
}
async function checkedJson(response, operation) {
  if (!response.ok) {
    await response.body?.cancel();
    throw serviceError(response, operation);
  }
  try {
    return await response.json();
  } catch {
    throw new CopilotError(`Copilot returned invalid JSON (${operation}).`);
  }
}
function responsesModels(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return entries.filter((model) => typeof model?.id === "string" && Array.isArray(model.supported_endpoints) && model.supported_endpoints.some((endpoint) => endpoint === "/responses" || endpoint === "/v1/responses"));
}
var CopilotError, CopilotClient;
var init_copilot = __esm({
  "plugins/copilot-provider/src/copilot.mjs"() {
    CopilotError = class extends Error {
      constructor(message, status = 502, code = "copilot_error", retryAfter) {
        super(message);
        this.name = "CopilotError";
        this.status = status;
        this.code = code;
        this.retryAfter = retryAfter;
      }
    };
    CopilotClient = class {
      constructor({ resolveCredential: resolveCredential2, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 3e5 } = {}) {
        if (typeof resolveCredential2 !== "function") throw new TypeError("resolveCredential is required.");
        this.resolveCredential = resolveCredential2;
        this.fetchImpl = fetchImpl;
        this.now = now;
        this.timeoutMs = timeoutMs;
        this.tokens = /* @__PURE__ */ new Map();
        this.refreshes = /* @__PURE__ */ new Map();
        this.catalogs = /* @__PURE__ */ new Map();
      }
      accountKey(account) {
        return `${account.host.toLowerCase()}\0${account.login}\0${account.id}`;
      }
      async fetch(url, options) {
        try {
          return await this.fetchImpl(url, { ...options, redirect: "error" });
        } catch (error) {
          if (options.signal?.aborted) throw options.signal.reason || error;
          throw new CopilotError("Cannot reach the selected GitHub/Copilot host. Check your network and enterprise access.", 502, "copilot_network_error");
        }
      }
      async token(account, { force = false } = {}) {
        const key = this.accountKey(account);
        const cached = this.tokens.get(key);
        if (!force && cached && cached.refreshAt > this.now()) return cached;
        if (this.refreshes.has(key)) return this.refreshes.get(key);
        const refresh = (async () => {
          const credential = await this.resolveCredential(account);
          if (!credential?.token || credential.host.toLowerCase() !== account.host.toLowerCase() || credential.login !== account.login) {
            throw new CopilotError("The selected account credential no longer matches. Refresh the local account list.", 401, "account_changed");
          }
          const response = await this.fetch(`${githubApiBase(account.host)}/copilot_internal/v2/token`, {
            headers: {
              authorization: `token ${credential.token}`,
              accept: "application/json",
              "user-agent": "GitHubCopilotChat/0.35.0",
              "x-github-api-version": "2025-04-01"
            },
            signal: AbortSignal.timeout(3e4)
          });
          const data = await checkedJson(response, "authorization");
          if (typeof data.token !== "string" || !data.token) throw new CopilotError("The selected account did not return a Copilot credential.", 403, "copilot_access_denied");
          const base = data.endpoints?.api || (account.host.toLowerCase() === "github.com" ? "https://api.githubcopilot.com" : null);
          if (!base) throw new CopilotError("The enterprise account did not advertise a Copilot API endpoint.", 502, "missing_enterprise_endpoint");
          const endpoint = validateCopilotEndpoint(base, account.host);
          const expiresAt = Number(data.expires_at) * 1e3;
          const refreshIn = Number(data.refresh_in) * 1e3;
          const remaining = Math.min(
            Number.isFinite(expiresAt) && expiresAt > this.now() ? expiresAt - this.now() : 3e5,
            Number.isFinite(refreshIn) && refreshIn > 0 ? refreshIn : 3e5
          );
          const result = { token: data.token, endpoint, refreshAt: this.now() + Math.max(0, remaining - Math.min(6e4, remaining / 10)) };
          this.tokens.set(key, result);
          return result;
        })();
        this.refreshes.set(key, refresh);
        try {
          return await refresh;
        } finally {
          if (this.refreshes.get(key) === refresh) this.refreshes.delete(key);
        }
      }
      async request(account, resource, { signal, body, stream = false } = {}) {
        const requestSignal = AbortSignal.any([...signal ? [signal] : [], AbortSignal.timeout(this.timeoutMs)]);
        requestSignal.throwIfAborted();
        let credential = await this.token(account);
        requestSignal.throwIfAborted();
        const send = () => this.fetch(`${credential.endpoint}${resource}`, {
          method: body ? "POST" : "GET",
          headers: headers(credential.token, stream ? "text/event-stream" : "application/json"),
          ...body ? { body: JSON.stringify(body) } : {},
          signal: requestSignal
        });
        let response = await send();
        if (response.status === 401) {
          await response.body?.cancel();
          this.tokens.delete(this.accountKey(account));
          credential = await this.token(account, { force: true });
          requestSignal.throwIfAborted();
          response = await send();
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw serviceError(response, resource === "/models" ? "model discovery" : "inference");
        }
        return response;
      }
      async listModels(account, { signal, refresh = false } = {}) {
        const key = this.accountKey(account);
        const cached = this.catalogs.get(key);
        if (!refresh && cached && cached.expires > this.now()) return cached.models;
        const models = responsesModels(await checkedJson(await this.request(account, "/models", { signal }), "model discovery"));
        this.catalogs.set(key, { models, expires: this.now() + 6e4 });
        return models;
      }
      async responses(account, input, { signal } = {}) {
        const models = await this.listModels(account, { signal });
        if (!models.some((model) => model.id === input.model)) {
          throw new CopilotError("This model is unavailable through the selected account\u2019s native Responses API. Choose a model in Copilot setup.", 400, "model_not_supported");
        }
        const body = { ...input };
        delete body.service_tier;
        return this.request(account, "/responses", { signal, body, stream: body.stream === true });
      }
    };
  }
});

// plugins/copilot-provider/src/ui.mjs
var setupHtml, setupCss, setupJs;
var init_ui = __esm({
  "plugins/copilot-provider/src/ui.mjs"() {
    setupHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Copilot provider</title><link rel="stylesheet" href="/style.css"></head>
<body><main><p class="eyebrow">LOCAL MODEL PROVIDER</p><h1>Use your Copilot account</h1>
<p class="intro">Choose an account already signed in on this computer. GitHub.com and enterprise accounts stay separate.</p>
<section><div class="row"><h2>Account and model</h2><button id="refresh" type="button">Refresh accounts</button></div>
<label for="account">GitHub account</label><select id="account" disabled><option>Loading accounts\u2026</option></select>
<p id="source" class="hint"></p><label for="model">Copilot model</label><select id="model" disabled><option>Select an account first</option></select>
<p class="hint">Only models advertising the Responses API are listed. Codex runs the tools.</p>
<button id="apply" class="primary" type="button" disabled>Use this account and model</button></section>
<p id="status" role="status" aria-live="polite"></p><p id="warnings" class="source-warning" role="status" aria-live="polite" hidden></p><p class="foot">Credentials remain in their existing local credential stores. Switching here does not switch your GitHub CLI account.</p>
</main><script src="/app.js"></script></body></html>`;
    setupCss = `:root{font:16px/1.5 system-ui,sans-serif;color:#1c2733;background:#f4f6f8;color-scheme:light}*{box-sizing:border-box}body{margin:0}main{max-width:700px;margin:64px auto;padding:0 24px}h1{font-size:32px;letter-spacing:-.8px;line-height:1.15;margin:10px 0 16px}h2{font-size:18px;margin:0}.eyebrow{font-size:12px;letter-spacing:1.4px;color:#466173;font-weight:700}.intro{color:#566570;margin-bottom:32px}section{background:white;border:1px solid #d8e0e6;border-radius:12px;padding:26px}.row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px}label{display:block;font-weight:600;margin:18px 0 8px}select{display:block;width:100%;font:inherit;padding:10px;border:1px solid #aab8c3;border-radius:6px;background:white;color:inherit}button{font:inherit;border:1px solid #aab8c3;background:white;color:#263c4b;border-radius:6px;padding:8px 12px;cursor:pointer}button:disabled{opacity:.5;cursor:default}.primary{margin-top:20px;background:#145f52;border-color:#145f52;color:white;padding:11px 16px}button:focus-visible,select:focus-visible{outline:3px solid #86baef;outline-offset:3px}.hint,.foot{font-size:13px;color:#647480}.hint{margin:7px 0}.foot{margin-top:28px}#status{min-height:28px;white-space:pre-line}#status.error{color:#a32424}.source-warning{padding:12px;border-left:3px solid #b38424;background:#fff8e8;color:#775513;font-size:13px;white-space:pre-line}@media(max-width:500px){main{margin:28px auto}.row{align-items:flex-start;flex-direction:column}section{padding:20px}}`;
    setupJs = String.raw`const account = document.getElementById('account');
const model = document.getElementById('model');
const status = document.getElementById('status');
const warnings = document.getElementById('warnings');
const apply = document.getElementById('apply');
const refresh = document.getElementById('refresh');
const fragment = new URLSearchParams(location.hash.slice(1));
let key = fragment.get('key') || sessionStorage.getItem('copilot-local-key');
history.replaceState(null, '', '/');
if (key) sessionStorage.setItem('copilot-local-key', key);
let accounts = []; let selectedModel = null; let generation = 0;
function message(text, error = false) { status.textContent = text; status.className = error ? 'error' : ''; }
async function api(path, body) {
  if (!key) throw new Error('Open setup from the Copilot plugin so it can authorize this local page.');
  const response = await fetch(path, {method: body ? 'POST' : 'GET', headers: {Authorization: 'Bearer ' + key, ...(body ? {'Content-Type': 'application/json'} : {})}, ...(body ? {body: JSON.stringify(body)} : {})});
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || 'Request failed.'); return data;
}
function options(select, entries) { select.replaceChildren(...entries.map(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; return option; })); }
async function loadModels() {
  const current = ++generation; model.disabled = true; apply.disabled = true;
  const selected = accounts.find(item => item.id === account.value);
  document.getElementById('source').textContent = selected ? 'Credential source: ' + selected.source : '';
  if (!selected) { options(model, [['', 'No account selected']]); return; }
  options(model, [['', 'Checking Copilot access…']]); message('Checking the selected account’s Copilot subscription…');
  try {
    const result = await api('/admin/models?accountId=' + encodeURIComponent(selected.id));
    if (current !== generation) return;
    options(model, result.models.map(item => [item.id, item.name || item.id]));
    if (result.models.some(item => item.id === selectedModel)) model.value = selectedModel;
    model.disabled = !result.models.length; apply.disabled = !result.models.length;
    message(result.models.length ? 'Ready. Choose a model, then apply.' : 'This account has no models advertising the Responses API.', !result.models.length);
  } catch (error) { if (current === generation) { options(model, [['', 'Models unavailable']]); message(error.message, true); } }
}
async function loadAccounts() {
  ++generation; refresh.disabled = true; account.disabled = true; apply.disabled = true; model.disabled = true;
  warnings.textContent = ''; warnings.hidden = true;
  try {
    const result = await api('/admin/accounts'); accounts = result.accounts; selectedModel = result.model;
    if (result.warnings?.length) { warnings.textContent = 'Some account sources could not be read:\n' + result.warnings.map(item => '• ' + item).join('\n'); warnings.hidden = false; }
    options(account, accounts.map(item => [item.id, item.login + ' @ ' + item.host + ' · ' + item.source]));
    if (accounts.some(item => item.id === result.accountId)) account.value = result.accountId;
    account.disabled = !accounts.length;
    if (accounts.length) await loadModels(); else { options(account, [['', 'No existing accounts found']]); options(model, [['', 'No account selected']]); message('No reusable credentials were found. Sign in using GitHub Copilot CLI or GitHub CLI, then refresh. You can also add an existing credential file using the plugin command.', true); }
  } catch (error) { message(error.message, true); } finally { refresh.disabled = false; }
}
account.addEventListener('change', loadModels); refresh.addEventListener('click', loadAccounts);
apply.addEventListener('click', async () => {
  const chosenAccount = account.value; const chosenModel = model.value;
  apply.disabled = true; account.disabled = true; model.disabled = true; refresh.disabled = true;
  try { await api('/admin/select', {accountId: chosenAccount, model: chosenModel}); message('Saved. Restart Codex and begin a new chat to load the provider and model configuration. Existing requests keep their original account.'); }
  catch (error) { message(error.message, true); }
  finally { apply.disabled = false; account.disabled = false; model.disabled = false; refresh.disabled = false; }
});
loadAccounts();`;
  }
});

// plugins/copilot-provider/src/proxy.mjs
var proxy_exports = {};
__export(proxy_exports, {
  startServer: () => startServer
});
import http from "node:http";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
function json(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
async function requestJson(request, limit) {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) throw new CopilotError("Use application/json for this request.", 415, "unsupported_media_type");
  const buffers = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw new CopilotError("The request is too large.", 413, "request_too_large");
    buffers.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(buffers).toString("utf8"));
  } catch {
    throw new CopilotError("The request must contain valid JSON.", 400, "invalid_request_error");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CopilotError("The request must be a JSON object.", 400, "invalid_request_error");
  return value;
}
async function startServer({
  paths: paths2 = getPaths(),
  cliPath: cliPath2,
  port,
  discoverAccounts: discoverAccounts2 = discoverAccounts,
  resolveCredential: resolveCredential2 = resolveCredential,
  configureProvider: configureProvider2 = configureProvider,
  persistSettings = updateSettings,
  fetchImpl = globalThis.fetch,
  copilot = new CopilotClient({ resolveCredential: resolveCredential2, fetchImpl })
} = {}) {
  const key = await localKey(paths2);
  const settings = await readSettings(paths2);
  const listenPort = port ?? settings.port;
  const controllers = /* @__PURE__ */ new Set();
  let closing;
  let baseUrl;
  let mutation = Promise.resolve();
  const serialize = (operation) => {
    const next = mutation.then(operation);
    mutation = next.catch(() => {
    });
    return next;
  };
  const accounts = async () => {
    const current = await readSettings(paths2);
    const warnings = /* @__PURE__ */ new Set();
    const values = await discoverAccounts2({ credentialFiles: current.credentialFiles || [], onWarning: (warning) => {
      if (typeof warning === "string" && warnings.size < 10) warnings.add(safeError(new Error(warning)));
    } });
    return { current, values, warnings: [...warnings] };
  };
  const findAccount = async (id) => {
    const { current, values } = await accounts();
    const selected = values.find((account) => account.id === (id || current.accountId));
    if (!selected) throw new CopilotError("The selected local account is unavailable. Open Copilot setup and refresh the accounts.", 401, "account_unavailable");
    return selected;
  };
  const authorized = (request) => {
    const received = request.headers.authorization;
    if (typeof received !== "string" || !received.startsWith("Bearer ")) return false;
    const value = Buffer.from(received.slice(7));
    const expected = Buffer.from(key);
    return value.length === expected.length && timingSafeEqual(value, expected);
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const controller = new AbortController();
    controllers.add(controller);
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
      controllers.delete(controller);
    });
    try {
      const actualPort = server.address()?.port;
      if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(request.headers.host) || request.headers.origin && ![baseUrl, `http://localhost:${actualPort}`].includes(request.headers.origin)) {
        throw new CopilotError("This endpoint only accepts requests from its local origin.", 403, "invalid_origin");
      }
      const url = new URL(request.url, baseUrl);
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { service: SERVICE, version: VERSION });
      if (request.method === "GET" && ["/", "/app.js", "/style.css"].includes(url.pathname)) {
        const [body, type] = url.pathname === "/" ? [setupHtml, "text/html"] : url.pathname === "/app.js" ? [setupJs, "text/javascript"] : [setupCss, "text/css"];
        response.writeHead(200, { "content-type": `${type}; charset=utf-8` });
        response.end(body);
        return;
      }
      if (!authorized(request)) throw new CopilotError("A local proxy credential is required.", 401, "unauthorized");
      if (request.method === "GET" && url.pathname === "/admin/status") {
        const current = await readSettings(paths2);
        const selectionPending = await hasPendingSelection(paths2);
        return json(response, 200, {
          service: SERVICE,
          version: VERSION,
          configured: !selectionPending && !!(current.accountId && current.model),
          selectionPending,
          port: actualPort,
          cliPath: cliPath2,
          buildId: BUILD_ID,
          activeRequests: Math.max(0, controllers.size - 1)
        });
      }
      if (request.method === "POST" && url.pathname === "/admin/shutdown") {
        json(response, 200, { stopped: true });
        setTimeout(() => close(), 25).unref();
        return;
      }
      if (request.method === "GET" && url.pathname === "/admin/accounts") {
        const { current, values, warnings } = await accounts();
        return json(response, 200, { accounts: values.map(publicAccount), accountId: current.accountId, model: current.model, warnings });
      }
      if (request.method === "GET" && url.pathname === "/admin/models") {
        const account = await findAccount(url.searchParams.get("accountId"));
        const models = await copilot.listModels(account, { signal: controller.signal, refresh: true });
        return json(response, 200, { models: models.map((model) => ({ id: model.id, name: model.name || model.id })) });
      }
      if (request.method === "POST" && url.pathname === "/admin/select") {
        const input = await requestJson(request, 16 * 1024);
        if (typeof input.accountId !== "string" || typeof input.model !== "string" || !input.model || input.model.length > 256) {
          throw new CopilotError("Choose an existing account and a Copilot model.", 400, "invalid_selection");
        }
        const result = await serialize(async () => {
          controller.signal.throwIfAborted();
          const account = await findAccount(input.accountId);
          const models = await copilot.listModels(account, { signal: controller.signal, refresh: true });
          if (!models.some((model) => model.id === input.model)) throw new CopilotError("The chosen model is not available for this account.", 400, "model_not_supported");
          controller.signal.throwIfAborted();
          const configured = await applyProviderSelection(
            { accountId: account.id, model: input.model, port: actualPort, cliPath: cliPath2 },
            paths2,
            { configureProviderImpl: configureProvider2, persistSettings }
          );
          return { account: publicAccount(account), model: input.model, restartRequired: true, configFile: configured.configFile };
        });
        return json(response, 200, result);
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        if (url.searchParams.has("client_version")) return json(response, 200, { models: [] });
        const account = await findAccount();
        const models = await copilot.listModels(account, { signal: controller.signal });
        return json(response, 200, { object: "list", data: models });
      }
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        const input = await requestJson(request, 16 * 1024 * 1024);
        if (typeof input.model !== "string" || !input.model || input.stream != null && typeof input.stream !== "boolean") throw new CopilotError("A model and a valid stream flag are required.", 400, "invalid_request_error");
        await assertSelectionReady(paths2);
        const account = await findAccount();
        await assertSelectionReady(paths2);
        const adapter = createResponsesAdapter(input);
        const upstream = await copilot.responses(account, adapter.input, { signal: controller.signal });
        if (/^text\/event-stream(?:;|$)/i.test(upstream.headers.get("content-type") || "")) {
          response.writeHead(upstream.status, { "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no" });
          response.flushHeaders();
          try {
            let terminal = false;
            for await (const chunk of rewriteSSE(upstream.body, (payload) => {
              if (["response.completed", "response.failed", "response.incomplete", "error"].includes(payload?.type)) terminal = true;
              return adapter.rewrite(payload);
            })) {
              controller.signal.throwIfAborted();
              if (!response.write(chunk)) await once(response, "drain", { signal: controller.signal });
            }
            if (!terminal) throw new CopilotError("Copilot closed the response stream before a terminal event.", 502, "incomplete_upstream_stream");
            response.end();
          } finally {
            controller.abort();
          }
        } else {
          let payload;
          try {
            payload = await upstream.json();
          } catch {
            throw new CopilotError("Copilot returned an invalid Responses object.");
          }
          json(response, upstream.status, adapter.rewrite(payload));
        }
        return;
      }
      throw new CopilotError("Endpoint not found.", 404, "not_found");
    } catch (error) {
      if (response.destroyed || response.writableEnded || request.aborted) return;
      const aborted = error?.name === "TimeoutError" || error?.name === "AbortError";
      const status = Number.isInteger(error.status) ? error.status : aborted ? 504 : 500;
      const envelope = { error: { message: aborted ? "The request was cancelled or timed out." : safeError(error), type: "api_error", code: error.code || (aborted ? "request_timeout" : "proxy_error") } };
      if (response.headersSent) {
        response.end(`event: response.failed
data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: envelope.error } })}

`);
      } else {
        if (error.retryAfter) response.setHeader("retry-after", error.retryAfter);
        json(response, status, envelope);
      }
    } finally {
      controllers.delete(controller);
    }
  });
  server.headersTimeout = 15e3;
  server.requestTimeout = 3e4;
  server.keepAliveTimeout = 2e3;
  const close = () => {
    if (!closing) closing = new Promise((resolve, reject) => {
      for (const controller of controllers) controller.abort();
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    return closing;
  };
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => {
      server.off("error", reject);
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  return { server, url: baseUrl, close };
}
var SERVICE, VERSION;
var init_proxy = __esm({
  "plugins/copilot-provider/src/proxy.mjs"() {
    init_state();
    init_accounts();
    init_config();
    init_copilot();
    init_ui();
    SERVICE = "copilot-proxy-plugin";
    VERSION = 1;
  }
});

// plugins/copilot-provider/src/cli.mjs
init_state();
import fs5 from "node:fs/promises";
import path5 from "node:path";
import { fileURLToPath } from "node:url";

// plugins/copilot-provider/src/runtime.mjs
init_state();
import fs2 from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import path2 from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay2 } from "node:timers/promises";
async function inspectService(paths2 = getPaths(), fetchImpl = fetch) {
  const { port } = await readSettings(paths2);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const response = await fetchImpl(`${baseUrl}/health`, { signal: AbortSignal.timeout(800) });
    const body = await response.json();
    if (body.service !== "copilot-proxy-plugin" || body.version !== 1) return { running: false, occupied: true, baseUrl };
    const authenticated = await fetchImpl(`${baseUrl}/admin/status`, {
      headers: { Authorization: `Bearer ${await localKey(paths2)}` },
      signal: AbortSignal.timeout(1200)
    });
    if (!authenticated.ok) return { running: false, occupied: true, baseUrl };
    const status = await authenticated.json();
    return { running: true, baseUrl, cliPath: status.cliPath, buildId: status.buildId, activeRequests: status.activeRequests ?? 0 };
  } catch (error) {
    if (error.name === "SyntaxError") return { running: false, occupied: true, baseUrl };
    return { running: false, baseUrl };
  }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
async function ensureRunning({ paths: paths2 = getPaths(), cliPath: cliPath2, timeoutMs = 15e3, spawnImpl = spawn, fetchImpl = fetch } = {}) {
  if (!cliPath2 || !path2.isAbsolute(cliPath2)) throw new Error("An absolute plugin CLI path is required.");
  await localKey(paths2);
  const lockDir = path2.join(paths2.dataDir, "start.lock");
  const lockFile = path2.join(lockDir, "owner.json");
  const deadline = Date.now() + timeoutMs;
  let locked = false;
  const samePackage = (service) => {
    const normalize = (value) => process.platform === "win32" ? path2.resolve(value).toLowerCase() : path2.resolve(value);
    return typeof service.cliPath === "string" && normalize(service.cliPath) === normalize(cliPath2) && service.buildId === BUILD_ID;
  };
  while (Date.now() < deadline) {
    const service = await inspectService(paths2, fetchImpl);
    if (service.running && samePackage(service)) return service;
    if (service.running) {
      if (service.activeRequests > 0) throw new Error("The previous plugin version has active requests. Finish them before starting the updated plugin.");
      await stopService(paths2);
    }
    if (service.occupied) throw new Error("The configured local port belongs to another service. Select another port in setup.");
    try {
      await fs2.mkdir(lockDir);
      await writeJson(lockFile, { pid: process.pid, createdAt: Date.now() });
      locked = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs2.stat(lockDir).catch(() => null);
      const owner = await readJson(lockFile).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 3e4 && !alive(owner?.pid)) {
        await fs2.rm(lockFile, { force: true });
        await fs2.rmdir(lockDir).catch(() => {
        });
      }
      await delay2(150);
    }
  }
  if (!locked) throw new Error("Timed out waiting for another proxy startup. Retry setup.");
  try {
    const existing = await inspectService(paths2, fetchImpl);
    if (existing.running && samePackage(existing)) return existing;
    if (existing.running) throw new Error("Another plugin version started concurrently. Retry setup after its requests finish.");
    if (existing.occupied) throw new Error("The configured port is already in use.");
    const logStat = await fs2.stat(paths2.logFile).catch(() => null);
    if (logStat?.size > 1024 * 1024) await fs2.rename(paths2.logFile, `${paths2.logFile}.previous`).catch(() => {
    });
    const fd = openSync(paths2.logFile, "a", 384);
    try {
      const child = spawnImpl(process.execPath, [cliPath2, "serve"], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", fd, fd],
        cwd: path2.dirname(cliPath2),
        env: { ...process.env, CODEX_HOME: paths2.codexHome, COPILOT_PROXY_HOME: paths2.dataDir }
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
    while (Date.now() < deadline) {
      const service = await inspectService(paths2, fetchImpl);
      if (service.running && samePackage(service)) return service;
      if (service.occupied) throw new Error("Another service claimed the configured local port.");
      await delay2(150);
    }
    throw new Error(`Proxy did not become ready. Check ${paths2.logFile}.`);
  } finally {
    const owner = await readJson(lockFile).catch(() => null);
    if (owner?.pid === process.pid) {
      await fs2.rm(lockFile, { force: true });
      await fs2.rmdir(lockDir).catch(() => {
      });
    }
  }
}
async function stopService(paths2 = getPaths()) {
  const service = await inspectService(paths2);
  if (!service.running) return service;
  const response = await fetch(`${service.baseUrl}/admin/shutdown`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await localKey(paths2)}` },
    signal: AbortSignal.timeout(5e3)
  });
  if (!response.ok) throw new Error("The running proxy refused the shutdown request.");
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay2(100);
    if (!(await inspectService(paths2)).running) return { running: false };
  }
  throw new Error("Proxy is still draining requests. Retry status shortly.");
}
async function openBrowser(url) {
  let executable, args2;
  if (process.platform === "win32") {
    executable = "powershell.exe";
    args2 = ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:COPILOT_SETUP_URL"];
  } else if (process.platform === "darwin") {
    executable = "open";
    args2 = [url];
  } else {
    executable = "xdg-open";
    args2 = [url];
  }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args2, { windowsHide: true, stdio: "ignore", env: { ...process.env, COPILOT_SETUP_URL: url } });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Could not open the local account selector in a browser.")));
  });
}

// plugins/copilot-provider/src/cli.mjs
init_accounts();
init_config();
var cliPath = fileURLToPath(import.meta.url);
var paths = getPaths();
var command = process.argv[2] || "help";
var args = process.argv.slice(3);
var flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? void 0 : args[i + 1];
};
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or newer is required.");
  if (command === "serve") {
    const { startServer: startServer2 } = await Promise.resolve().then(() => (init_proxy(), proxy_exports));
    const running = await startServer2({ paths, cliPath });
    await writeJson(paths.processFile, { pid: process.pid, startedAt: (/* @__PURE__ */ new Date()).toISOString() });
    const close = async () => {
      await running.close();
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
    await new Promise((resolve) => running.server.once("close", resolve));
    await fs5.rm(paths.processFile, { force: true });
    return;
  }
  if (command === "token") {
    await ensureRunning({ paths, cliPath });
    process.stdout.write(`${await localKey(paths)}
`);
    return;
  }
  if (command === "hook") {
    const settings = await readSettings(paths);
    if (settings.accountId && settings.model) await ensureRunning({ paths, cliPath });
    return;
  }
  if (command === "setup" || command === "accounts-ui") {
    const port = flag("--port");
    if (port !== void 0) {
      const current = await readSettings(paths);
      if (current.accountId || current.model) throw new Error("Run restore before changing a configured port, then set up the provider again.");
      if ((await inspectService(paths)).running) throw new Error("Stop the proxy before changing its port.");
      await updateSettings({ port: Number(port) }, paths);
    }
    const service = await ensureRunning({ paths, cliPath });
    if (!args.includes("--no-open")) await openBrowser(`${service.baseUrl}/#key=${await localKey(paths)}`);
    console.log(args.includes("--no-open") ? `Proxy ready at ${service.baseUrl}. Run setup without --no-open to choose an account.` : "Opened the local Copilot account selector. Choose an existing account and a Responses model, then apply.");
    return;
  }
  if (command === "accounts") {
    const settings = await readSettings(paths);
    const accounts = await discoverAccounts({ credentialFiles: settings.credentialFiles, onWarning: (warning) => console.error(safeError(new Error(warning))) });
    console.log(JSON.stringify(accounts.map(publicAccount), null, 2));
    return;
  }
  if (command === "add-credential-file") {
    const file = args[0];
    if (!file) throw new Error("Usage: add-credential-file <absolute-path>");
    const resolved = path5.resolve(file);
    if (!(await fs5.stat(resolved)).isFile()) throw new Error("Credential source must be a file.");
    const settings = await readSettings(paths);
    await updateSettings({ credentialFiles: [.../* @__PURE__ */ new Set([...settings.credentialFiles, resolved])] }, paths);
    console.log("Credential source registered; run setup to refresh accounts. Source tokens are not copied.");
    return;
  }
  if (command === "start") {
    console.log(JSON.stringify(await ensureRunning({ paths, cliPath })));
    return;
  }
  if (command === "status") {
    const settings = await readSettings(paths);
    console.log(JSON.stringify({ ...await inspectService(paths), accountId: settings.accountId, model: settings.model, logFile: paths.logFile }, null, 2));
    return;
  }
  if (command === "stop") {
    console.log(JSON.stringify(await stopService(paths)));
    return;
  }
  if (command === "restore") {
    console.log(JSON.stringify(await restoreProvider(paths), null, 2));
    await updateSettings({ accountId: null, model: null }, paths);
    await stopService(paths);
    return;
  }
  if (command !== "help" && command !== "--help") throw new Error(`Unknown command: ${command}`);
  console.log("Copilot local provider\n\nsetup [--port N]   Open the existing-account selector\naccounts          List detected accounts (no tokens)\nadd-credential-file <path>  Add an existing exported credential source\nstatus | start | stop\nrestore           Restore provider settings before removing the plugin\n\nNode.js 22+ is required. No new GitHub login is performed.");
}
main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
/*! Bundled license information:

smol-toml/dist/error.js:
smol-toml/dist/primitive.js:
smol-toml/dist/date.js:
smol-toml/dist/extract.js:
smol-toml/dist/util.js:
smol-toml/dist/struct.js:
smol-toml/dist/parse.js:
smol-toml/dist/stringify.js:
smol-toml/dist/index.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)
*/
