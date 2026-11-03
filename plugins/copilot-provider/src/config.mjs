import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'smol-toml';
import { getPaths, readJson, writeJson, readSettings, updateSettings, safeError } from './state.mjs';

const PROVIDER_ID = 'copilot-local';
const JOURNAL_VERSION = 1;
const markerPrefix = '# copilot-provider:';

function locations(paths) {
  return {
    journal: path.join(paths.dataDir, 'config-install.json'),
    lock: path.join(paths.dataDir, 'config-edit.lock'),
    backups: path.join(paths.dataDir, 'config-backups'),
    selection: path.join(paths.dataDir, 'selection-pending.json'),
    selectionLock: path.join(paths.dataDir, 'selection-edit.lock'),
  };
}

function hash(text) { return createHash('sha256').update(text).digest('hex'); }
function quote(value) { return JSON.stringify(value); }

function parseConfig(text) {
  try { return parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Codex config.toml is not valid TOML. No configuration was changed.'); }
}

async function readConfig(file) {
  try { return { text: await fs.readFile(file, 'utf8'), exists: true }; }
  catch (error) {
    if (error.code === 'ENOENT') return { text: '', exists: false };
    throw error;
  }
}

async function withLock(paths, work, lockFile) {
  await fs.mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
  const lock = lockFile ?? locations(paths).lock;
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another provider configuration operation is active. If it was interrupted, remove ${lock} after confirming it has stopped.`);
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    return await work();
  } finally {
    await handle.close();
    await fs.rm(lock, { force: true });
  }
}

// Find complete TOML statements without reserializing unrelated formatting. The
// TOML parser remains the source of truth for syntax and key identity.
function statements(text) {
  const spans = [];
  let start = 0;
  while (start < text.length) {
    let i = start;
    while (text[i] === ' ' || text[i] === '\t' || text[i] === '\r') i++;
    if (text[i] === '\n' || text[i] === '#') {
      const end = text.indexOf('\n', i);
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
        if (string === '"' && char === '\\') { i++; continue; }
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
      } else if (char === '#') {
        const newline = text.indexOf('\n', i);
        if (newline < 0) { i = text.length; break; }
        i = newline;
        if (depth === 0) { i++; break; }
      } else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') depth--;
      else if (char === '=' && equals < 0) equals = i;
      else if (char === '\n' && depth === 0) { i++; break; }
    }
    spans.push({ start, end: i, equals, text: text.slice(start, i) });
    start = i;
  }
  return spans;
}

function rootAssignments(text, keys) {
  const found = new Map();
  for (const statement of statements(text)) {
    if (statement.text.trimStart().startsWith('[')) break;
    if (statement.equals < 0) continue;
    const lhs = text.slice(statement.start, statement.equals);
    let key;
    try {
      const probe = parse(`${lhs}= 1`);
      key = Object.keys(probe)[0];
      if (Object.keys(probe).length !== 1 || probe[key] !== 1) continue;
    } catch { continue; }
    if (keys.includes(key)) found.set(key, statement);
  }
  return found;
}

function replaceExactlyOnce(text, value, replacement) {
  const index = text.indexOf(value);
  if (index < 0 || text.indexOf(value, index + value.length) >= 0) {
    throw new Error('The plugin-owned Codex configuration was changed or removed. Refusing to overwrite it; restore the conflicting plugin block or saved-setting marker first.');
  }
  return text.slice(0, index) + replacement + text.slice(index + value.length);
}

function unapply(text, state) {
  const parsed = parseConfig(text);
  const expectedProvider = parseConfig(state.providerBlock).model_providers?.[PROVIDER_ID];
  if (!isDeepStrictEqual(parsed.model_providers?.[PROVIDER_ID], expectedProvider)) {
    throw new Error('The copilot-local provider contains user changes. Refusing to overwrite or remove those changes.');
  }
  let restored = replaceExactlyOnce(text, state.rootBlock, '');
  restored = replaceExactlyOnce(restored, state.providerBlock, '');
  for (const saved of state.saved) restored = replaceExactlyOnce(restored, saved.marker, saved.original);
  parseConfig(restored);
  return restored;
}

function canUnapply(text, state) {
  if (!state) return false;
  try { unapply(text, state); return true; } catch { return false; }
}

async function loadJournal(paths, config) {
  const { journal } = locations(paths);
  const record = await readJson(journal);
  if (!record) return null;
  if (record.version !== JOURNAL_VERSION || !Object.hasOwn(record, 'active')) {
    throw new Error('Unsupported provider configuration journal. No configuration was changed.');
  }
  if (!record.pending) return record.active;
  // A durable prepare record makes a crash between the two file replacements
  // recoverable. Never guess ownership if neither saved configuration matches.
  if (hash(config.text) === record.pending.afterHash || canUnapply(config.text, record.pending.next)) {
    await writeJson(journal, { version: JOURNAL_VERSION, active: record.pending.next });
    return record.pending.next;
  }
  if (hash(config.text) === record.pending.beforeHash || canUnapply(config.text, record.active)) {
    await writeJson(journal, { version: JOURNAL_VERSION, active: record.active });
    return record.active;
  }
  throw new Error('An interrupted provider configuration update conflicts with the current config.toml. No configuration was changed.');
}

async function backupConfig(paths, config) {
  if (!config.exists) return null;
  const { backups } = locations(paths);
  await fs.mkdir(backups, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(backups, `config.${stamp}.${randomBytes(6).toString('hex')}.toml`);
  await fs.writeFile(file, config.text, { flag: 'wx', mode: 0o600 });
  return file;
}

async function writeConfig(paths, before, text, remove = false) {
  const current = await readConfig(paths.configFile);
  if (current.text !== before.text || current.exists !== before.exists) {
    throw new Error('Codex config.toml changed during setup. Retry after the other editor finishes.');
  }
  if (remove) {
    await fs.rm(paths.configFile, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(paths.configFile), { recursive: true, mode: 0o700 });
  const temporary = `${paths.configFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, paths.configFile);
  } finally { await fs.rm(temporary, { force: true }); }
}

function installText(base, options, previous) {
  const bom = base.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = base.slice(bom.length);
  const parsed = parseConfig(body);
  if (Object.hasOwn(parsed.model_providers ?? {}, PROVIDER_ID)) {
    throw new Error('A copilot-local provider already exists and is not owned by this plugin. Choose another provider or remove that conflicting configuration before setup.');
  }
  if (body.includes(markerPrefix)) throw new Error('Untracked copilot-provider markers already exist in config.toml. Restore their configuration journal before setup.');
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const id = previous?.id ?? randomBytes(8).toString('hex');
  const values = { model: options.model, model_provider: PROVIDER_ID };
  if (options.catalogPath) values.model_catalog_json = options.catalogPath;
  const assignments = rootAssignments(body, Object.keys(values));
  const saved = [];
  let edited = body;
  for (const [key, value] of Object.entries(values)) {
    if (Object.hasOwn(parsed, key) && !assignments.has(key)) {
      throw new Error(`The existing ${key} setting uses a form this installer cannot safely edit. No configuration was changed.`);
    }
    if (typeof value !== 'string') throw new Error(`Invalid ${key} setting.`);
  }
  for (const [key, statement] of [...assignments].sort((a, b) => b[1].start - a[1].start)) {
    const trailingNewline = statement.text.endsWith('\n') ? newline : '';
    const marker = `${markerPrefix}saved:${id}:${key}${trailingNewline}`;
    saved.push({ key, marker, original: statement.text });
    edited = edited.slice(0, statement.start) + marker + edited.slice(statement.end);
  }
  const rootBlock = `${markerPrefix}begin:${id}:settings${newline}`
    + Object.entries(values).map(([key, value]) => `${key} = ${quote(value)}${newline}`).join('')
    + `${markerPrefix}end:${id}:settings${newline}`;
  const provider = {
    name: 'GitHub Copilot (local)', base_url: `http://127.0.0.1:${options.port}/v1`,
    wire_api: 'responses', requires_openai_auth: false,
    auth: { command: process.execPath, args: [options.cliPath, 'token'], timeout_ms: 30000, refresh_interval_ms: 60000 },
  };
  const separator = edited.length && !edited.endsWith('\n') ? newline : '';
  const providerBlock = `${separator}${markerPrefix}begin:${id}:provider${newline}`
    + `[model_providers.${PROVIDER_ID}]${newline}`
    + `name = ${quote(provider.name)}${newline}base_url = ${quote(provider.base_url)}${newline}`
    + `wire_api = "responses"${newline}requires_openai_auth = false${newline}`
    + `[model_providers.${PROVIDER_ID}.auth]${newline}`
    + `command = ${quote(provider.auth.command)}${newline}args = ${quote(provider.auth.args)}${newline}`
    + `timeout_ms = 30000${newline}refresh_interval_ms = 60000${newline}`
    + `${markerPrefix}end:${id}:provider${newline}`;
  const text = bom + rootBlock + edited + providerBlock;
  parseConfig(text);
  return { text, state: { id, rootBlock, providerBlock, provider, saved } };
}

function validateOptions({ model, port, cliPath, catalogPath }) {
  if (typeof model !== 'string' || !model.trim() || model !== model.trim() || /[\x00-\x1f\x7f]/.test(model) || model.length > 256) {
    throw new Error('Choose a nonempty model ID without whitespace at its edges or control characters.');
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local proxy port.');
  if (typeof cliPath !== 'string' || !path.isAbsolute(cliPath)) throw new Error('The plugin CLI path must be absolute.');
  if (catalogPath !== undefined && (typeof catalogPath !== 'string' || !path.isAbsolute(catalogPath))) {
    throw new Error('The model catalog path must be absolute.');
  }
  return { model, port, cliPath, ...(catalogPath ? { catalogPath } : {}) };
}

export async function configureProvider(options, paths = getPaths()) {
  const validated = validateOptions(options);
  if (validated.catalogPath) {
    const catalog = validateCatalog(await readJson(validated.catalogPath));
    if (!catalog.models.some(model => model.slug === validated.model)) throw new Error('The selected model is missing from the supplied Codex model catalog.');
  }
  return withLock(paths, async () => {
    const before = await readConfig(paths.configFile);
    const previous = await loadJournal(paths, before);
    const base = previous ? unapply(before.text, previous) : before.text;
    const result = installText(base, validated, previous);
    if (result.text === before.text) return { configFile: paths.configFile, backupFile: previous?.backupFile ?? null, restartRequired: true, changed: false };
    const backupFile = await backupConfig(paths, before);
    const next = { ...result.state, originalExisted: previous?.originalExisted ?? before.exists,
      backupFile: previous?.backupFile ?? backupFile, latestBackupFile: backupFile };
    const { journal } = locations(paths);
    await writeJson(journal, { version: JOURNAL_VERSION, active: previous,
      pending: { beforeHash: hash(before.text), afterHash: hash(result.text), next } });
    await writeConfig(paths, before, result.text);
    await writeJson(journal, { version: JOURNAL_VERSION, active: next });
    return { configFile: paths.configFile, backupFile, restartRequired: true, changed: true };
  });
}

export async function restoreProvider(paths = getPaths()) {
  return withLock(paths, async () => {
    await assertSelectionReady(paths);
    return withLock(paths, async () => {
      const before = await readConfig(paths.configFile);
      const state = await loadJournal(paths, before);
      if (!state) return { configFile: paths.configFile, restored: false, restartRequired: false };
      const restored = unapply(before.text, state);
      const backupFile = await backupConfig(paths, before);
      const { journal } = locations(paths);
      await writeJson(journal, { version: JOURNAL_VERSION, active: state,
        pending: { beforeHash: hash(before.text), afterHash: hash(restored), next: null } });
      await writeConfig(paths, before, restored, !state.originalExisted && restored === '');
      await writeJson(journal, { version: JOURNAL_VERSION, active: null });
      return { configFile: paths.configFile, backupFile, restored: true, restartRequired: true };
    });
  }, locations(paths).selectionLock);
}

function pendingSelectionError(cause) {
  if (cause?.code === 'selection_incomplete') return cause;
  const detail = cause ? ` Details: ${safeError(cause)}` : '';
  const error = new Error(`An account/model change is unfinished. Inference is paused to avoid using the wrong account. Open Copilot setup and apply the intended account and model again.${detail}`);
  error.status = 503;
  error.code = 'selection_incomplete';
  if (cause) error.cause = cause;
  return error;
}

export async function hasPendingSelection(paths = getPaths()) {
  try { await fs.stat(locations(paths).selection); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// The gate is durable across daemon restarts. Existing requests may retain a
// captured account, but no new inference may use partially committed routing.
export async function assertSelectionReady(paths = getPaths()) {
  if (await hasPendingSelection(paths)) throw pendingSelectionError();
}

function selectionOptions(options) {
  if (typeof options.accountId !== 'string' || !options.accountId.trim() ||
      options.accountId.length > 256 || /[\x00-\x1f\x7f]/.test(options.accountId)) {
    throw new Error('Choose an existing account before applying the model provider.');
  }
  return { accountId: options.accountId, ...validateOptions(options) };
}

async function finishSelection(record, paths, { configureProviderImpl = configureProvider, persistSettings = updateSettings } = {}) {
  const { accountId, ...provider } = selectionOptions(record.selection);
  const configured = await configureProviderImpl(provider, paths);
  await persistSettings({ accountId, model: provider.model, port: provider.port }, paths);
  const saved = await readSettings(paths);
  if (saved.accountId !== accountId || saved.model !== provider.model || saved.port !== provider.port) {
    throw pendingSelectionError();
  }
  const current = await readJson(locations(paths).selection);
  if (current?.id !== record.id) throw new Error('The pending account selection changed during setup. Inference remains paused.');
  await fs.rm(locations(paths).selection);
  return configured;
}

/**
 * Commit an explicitly approved account/model selection. The intent is durable
 * before either config or routing changes, so write failures/crashes fail closed.
 * Reapplying resumes through configureProvider's surgical, idempotent journal;
 * no whole-file rollback can discard unrelated user edits.
 */
export async function applyProviderSelection(options, paths = getPaths(), dependencies = {}) {
  const selection = selectionOptions(options);
  return withLock(paths, async () => {
    const file = locations(paths).selection;
    const pending = await readJson(file);
    if (pending && (pending.version !== 1 || !pending.id || !pending.selection)) {
      throw new Error('The pending account selection journal is invalid. Inference remains paused; preserve the journal for recovery.');
    }
    const record = { version: 1, id: randomBytes(12).toString('hex'), selection, createdAt: new Date().toISOString() };
    await writeJson(file, record);
    try { return await finishSelection(record, paths, dependencies); }
    catch (error) {
      // Keep the intent even when configureProvider itself failed: that call can
      // commit config before a final journal write fails. Never infer rollback.
      throw pendingSelectionError(error);
    }
  }, locations(paths).selectionLock);
}

/** Explicit recovery utility; startup only checks the gate and never applies settings. */
export async function recoverProviderSelection(paths = getPaths(), dependencies = {}) {
  return withLock(paths, async () => {
    const record = await readJson(locations(paths).selection);
    if (!record) return { recovered: false };
    if (record.version !== 1 || typeof record.id !== 'string' || !record.selection) throw pendingSelectionError();
    try {
      const result = await finishSelection(record, paths, dependencies);
      return { ...result, recovered: true };
    } catch (error) {
      throw pendingSelectionError(error);
    }
  }, locations(paths).selectionLock);
}

// This accepts provider-supplied Codex metadata, not GitHub's generic model list.
// Required fields below follow ModelInfo from the public rust-v0.143.0 schema:
// https://github.com/openai/codex/blob/rust-v0.143.0/codex-rs/protocol/src/openai_models.rs
// We preserve all instructions/capabilities verbatim; callers must qualify their
// catalog for the actual client version as described in /codex/model-catalogs.
function validateCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.models) || !catalog.models.length) throw new Error('Supply a Codex ModelsResponse object with a nonempty models array.');
  const seen = new Set();
  const strings = ['slug', 'display_name', 'shell_type', 'visibility', 'base_instructions'];
  const booleans = ['supported_in_api', 'supports_reasoning_summaries', 'support_verbosity', 'supports_parallel_tool_calls'];
  for (const model of catalog.models) {
    if (!model || strings.some(key => typeof model[key] !== 'string') || !model.slug.trim()
      || booleans.some(key => typeof model[key] !== 'boolean') || !Number.isInteger(model.priority)
      || !Array.isArray(model.supported_reasoning_levels) || !Array.isArray(model.experimental_supported_tools)
      || !model.truncation_policy || typeof model.truncation_policy !== 'object' || seen.has(model.slug)) {
      throw new Error('The supplied catalog lacks complete, uniquely named Codex model metadata. A raw Copilot model list cannot be used as a Codex catalog.');
    }
    seen.add(model.slug);
  }
  return catalog;
}

export async function writeModelCatalog(models, paths = getPaths()) {
  const catalog = validateCatalog(Array.isArray(models) ? { models } : models);
  const catalogPath = path.join(paths.dataDir, 'models.json');
  await writeJson(catalogPath, catalog);
  return catalogPath;
}
