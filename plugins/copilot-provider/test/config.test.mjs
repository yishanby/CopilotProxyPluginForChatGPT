import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { configureProvider, restoreProvider, writeModelCatalog, applyProviderSelection, recoverProviderSelection, assertSelectionReady } from '../src/config.mjs';
import { readSettings, updateSettings } from '../src/state.mjs';

async function fixture(t, initial) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-config-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { codexHome: root, dataDir: path.join(root, 'plugin-data'), configFile: path.join(root, 'config.toml'), settingsFile: path.join(root, 'plugin-data', 'settings.json') };
  if (initial !== undefined) await fs.writeFile(paths.configFile, initial);
  const options = { model: 'copilot-test-model', port: 43128, cliPath: path.join(root, 'plugin files', 'cli.mjs') };
  return { paths, options, read: () => fs.readFile(paths.configFile, 'utf8') };
}

test('setup preserves other settings and comments, is idempotent, and restores exact original bytes', async t => {
  const original = '# User preferences\r\nmodel = "old-model" # original model\r\nmodel_provider = "other"\r\nsandbox_mode = "workspace-write"\r\napproval_policy = "on-request"\r\n\r\n[model_providers.other]\r\nname = "Other"\r\nbase_url = "https://example.test/v1"\r\n\r\n[features]\r\nhooks = false\r\n';
  const f = await fixture(t, original);
  const result = await configureProvider(f.options, f.paths);
  assert.equal(await fs.readFile(result.backupFile, 'utf8'), original);
  const installed = await f.read();
  const config = parse(installed);
  assert.equal(config.model, f.options.model);
  assert.equal(config.model_provider, 'copilot-local');
  assert.equal(config.sandbox_mode, 'workspace-write');
  assert.equal(config.approval_policy, 'on-request');
  assert.equal(config.features.hooks, false);
  assert.equal(config.model_providers.other.base_url, 'https://example.test/v1');
  assert.equal(config.model_providers['copilot-local'].auth.command, process.execPath);
  assert.deepEqual(config.model_providers['copilot-local'].auth.args, [f.options.cliPath, 'token']);
  assert.equal(config.model_providers['copilot-local'].auth.refresh_interval_ms, 60000);
  assert.ok(installed.includes('# User preferences\r\n'));
  assert.equal((await configureProvider(f.options, f.paths)).changed, false);
  assert.equal(await f.read(), installed);
  await restoreProvider(f.paths);
  assert.equal(await f.read(), original);
  assert.equal((await restoreProvider(f.paths)).restored, false);
});

test('uninstall preserves later unrelated edits and restores the original model after multiple model switches', async t => {
  const original = 'model = "old"\n# keep this\n[features]\nexample = false\n';
  const f = await fixture(t, original);
  await configureProvider(f.options, f.paths);
  await fs.writeFile(f.paths.configFile, (await f.read()).replace('example = false', 'example = true') + '\n[notifications]\nenabled = true\n');
  await configureProvider({ ...f.options, model: 'second-model', port: 43129 }, f.paths);
  assert.equal(parse(await f.read()).model, 'second-model');
  await restoreProvider(f.paths);
  const restored = await f.read();
  assert.equal(restored, original.replace('example = false', 'example = true') + '\n[notifications]\nenabled = true\n');
  assert.equal(parse(restored).model, 'old');
});

test('setup and uninstall refuse modified plugin fields instead of overwriting user edits', async t => {
  const f = await fixture(t, 'model = "old"\n');
  await configureProvider(f.options, f.paths);
  const changed = (await f.read()).replace('http://127.0.0.1:43128/v1', 'http://127.0.0.1:9999/v1');
  await fs.writeFile(f.paths.configFile, changed);
  await assert.rejects(restoreProvider(f.paths), /user changes/);
  await assert.rejects(configureProvider({ ...f.options, model: 'other-model' }, f.paths), /user changes/);
  assert.equal(await f.read(), changed);
});

test('uninstall refuses newly added keys inside the owned provider even outside the marker', async t => {
  const f = await fixture(t, 'model = "old"\n');
  await configureProvider(f.options, f.paths);
  const changed = (await f.read()) + 'custom_auth_option = true\n';
  await fs.writeFile(f.paths.configFile, changed);
  await assert.rejects(restoreProvider(f.paths), /user changes/);
  assert.equal(await f.read(), changed);
});

test('setup refuses an existing same-name provider and invalid TOML without modifying files', async t => {
  const existing = 'model = "mine"\n[model_providers.copilot-local]\nname = "Already mine"\n';
  const f = await fixture(t, existing);
  await assert.rejects(configureProvider(f.options, f.paths), /already exists/);
  assert.equal(await f.read(), existing);
  await fs.writeFile(f.paths.configFile, 'model = "unterminated');
  await assert.rejects(configureProvider(f.options, f.paths), /not valid TOML/);
  assert.equal(await f.read(), 'model = "unterminated');
});

test('multiline TOML strings, arrays and quoted keys do not confuse root setting edits', async t => {
  const original = '\uFEFF# heading\nnotes = """\nmodel = "not a setting"\n[also_not_a_table]\n"""\nlist = [\n  "[something]", # comment\n  "model = fake",\n]\n"model" = \'\'\'old\nmodel\'\'\' # multiline model string\n"model_provider" = "prior"';
  const f = await fixture(t, original);
  await configureProvider(f.options, f.paths);
  const installed = await f.read();
  assert.ok(installed.startsWith('\uFEFF'));
  assert.equal(parse(installed.slice(1)).notes, '\nmodel = "not a setting"\n[also_not_a_table]\n'.trimStart());
  await restoreProvider(f.paths);
  assert.equal(await f.read(), original);
});

test('uninstall removes a created config only if no unrelated settings were added', async t => {
  const f = await fixture(t);
  await configureProvider(f.options, f.paths);
  await restoreProvider(f.paths);
  await assert.rejects(fs.stat(f.paths.configFile), { code: 'ENOENT' });
  await configureProvider(f.options, f.paths);
  await fs.writeFile(f.paths.configFile, '# New user setting\npersonality = "friendly"\n' + await f.read());
  await restoreProvider(f.paths);
  assert.equal(await f.read(), '# New user setting\npersonality = "friendly"\n');
});

test('uninstall refuses changes to managed model lines and keeps user data intact', async t => {
  const f = await fixture(t, 'model = "old"\n');
  await configureProvider(f.options, f.paths);
  const changed = (await f.read()).replace('model = "copilot-test-model"', 'model = "user-new-model"');
  await fs.writeFile(f.paths.configFile, changed);
  await assert.rejects(restoreProvider(f.paths), /changed or removed/);
  assert.equal(await f.read(), changed);
});

test('catalog helper preserves provided metadata and rejects raw Copilot entries', async t => {
  const f = await fixture(t, 'model = "old"\nmodel_catalog_json = "old-catalog.json"\n');
  await assert.rejects(writeModelCatalog([{ id: 'raw-copilot-model' }], f.paths), /complete/);
  const model = { slug: 'copilot-test-model', display_name: 'Qualified model', description: null,
    supported_reasoning_levels: [], shell_type: 'shell_command', visibility: 'list', supported_in_api: true,
    priority: 1, base_instructions: 'Provider-supplied instructions.', supports_reasoning_summaries: false,
    support_verbosity: false, truncation_policy: { mode: 'bytes', limit: 10000 },
    supports_parallel_tool_calls: false, experimental_supported_tools: [], upgrade: null };
  const catalogPath = await writeModelCatalog([model], f.paths);
  assert.deepEqual(JSON.parse(await fs.readFile(catalogPath, 'utf8')), { models: [model] });
  await configureProvider({ ...f.options, catalogPath }, f.paths);
  assert.equal(parse(await f.read()).model_catalog_json, catalogPath);
  await configureProvider(f.options, f.paths);
  assert.equal(parse(await f.read()).model_catalog_json, 'old-catalog.json');
  await restoreProvider(f.paths);
  assert.equal(await f.read(), 'model = "old"\nmodel_catalog_json = "old-catalog.json"\n');
});

test('pending journal recovers an interrupted committed installation', async t => {
  const f = await fixture(t, 'model = "old"\n');
  await configureProvider(f.options, f.paths);
  const journalFile = path.join(f.paths.dataDir, 'config-install.json');
  const { active } = JSON.parse(await fs.readFile(journalFile, 'utf8'));
  await fs.writeFile(journalFile, JSON.stringify({ version: 1, active: null,
    pending: { beforeHash: 'before', afterHash: 'after', next: active } }));
  await restoreProvider(f.paths);
  assert.equal(await f.read(), 'model = "old"\n');
});

test('a failed account-settings write blocks inference until both model and account recover', async t => {
  const original = 'model = "original-model"\n[features]\ncustom = false\n';
  const f = await fixture(t, original);
  await applyProviderSelection({ ...f.options, accountId: 'previous-account', model: 'previous-model' }, f.paths);
  await updateSettings({ credentialFiles: ['keep-this-source.json'] }, f.paths);
  await assert.rejects(applyProviderSelection({ ...f.options, accountId: 'next-account', model: 'next-model' }, f.paths,
    { persistSettings: async () => { throw new Error('Settings are temporarily read-only.'); } }), error => {
    assert.equal(error.code, 'selection_incomplete'); assert.equal(error.status, 503);
    assert.match(error.message, /temporarily read-only/); return true;
  });
  assert.equal(parse(await f.read()).model, 'next-model');
  assert.equal((await readSettings(f.paths)).accountId, 'previous-account');
  await assert.rejects(assertSelectionReady(f.paths), { code: 'selection_incomplete' });
  await assert.rejects(restoreProvider(f.paths), { code: 'selection_incomplete' });
  // A later unrelated edit survives journal replay; recovery never restores a
  // whole old config snapshot over an editor's changes.
  await fs.writeFile(f.paths.configFile, (await f.read()).replace('custom = false', 'custom = true'));
  assert.equal((await recoverProviderSelection(f.paths)).recovered, true);
  await assertSelectionReady(f.paths);
  assert.equal(parse(await f.read()).model, 'next-model');
  assert.equal(parse(await f.read()).features.custom, true);
  const saved = await readSettings(f.paths);
  assert.equal(saved.accountId, 'next-account'); assert.equal(saved.model, 'next-model');
  assert.deepEqual(saved.credentialFiles, ['keep-this-source.json']);
  await restoreProvider(f.paths);
  assert.equal(await f.read(), original.replace('custom = false', 'custom = true'));
});

test('a crash after config commit retains a durable gate and can be resumed in a fresh call', async t => {
  const f = await fixture(t, 'model = "original"\n');
  await applyProviderSelection({ ...f.options, accountId: 'prior-account', model: 'prior-model' }, f.paths);
  await assert.rejects(applyProviderSelection({ ...f.options, accountId: 'new-account', model: 'new-model' }, f.paths, {
    configureProviderImpl: async (options, paths) => {
      await configureProvider(options, paths);
      throw new Error('Simulated process interruption after the config rename.');
    },
  }), { code: 'selection_incomplete' });
  assert.equal((await readSettings(f.paths)).accountId, 'prior-account');
  assert.equal(parse(await f.read()).model, 'new-model');
  await assert.rejects(assertSelectionReady(f.paths), { code: 'selection_incomplete' });
  // The record on disk is sufficient; no in-memory transaction object is used.
  await recoverProviderSelection({ ...f.paths });
  await assertSelectionReady(f.paths);
  assert.equal((await readSettings(f.paths)).accountId, 'new-account');
  assert.equal((await readSettings(f.paths)).model, 'new-model');
});

test('explicitly reapplying after a failed selection may choose another intended account', async t => {
  const f = await fixture(t, 'model = "original"\n');
  await assert.rejects(applyProviderSelection({ ...f.options, accountId: 'first-account' }, f.paths,
    { persistSettings: async () => { throw new Error('Write failed.'); } }), { code: 'selection_incomplete' });
  await applyProviderSelection({ ...f.options, accountId: 'replacement-account', model: 'replacement-model' }, f.paths);
  await assertSelectionReady(f.paths);
  assert.equal((await readSettings(f.paths)).accountId, 'replacement-account');
  assert.equal(parse(await f.read()).model, 'replacement-model');
});
