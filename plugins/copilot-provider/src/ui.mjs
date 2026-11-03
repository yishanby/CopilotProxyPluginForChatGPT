export const setupHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Copilot provider</title><link rel="stylesheet" href="/style.css"></head>
<body><main><p class="eyebrow">LOCAL MODEL PROVIDER</p><h1>Use your Copilot account</h1>
<p class="intro">Choose an account already signed in on this computer. GitHub.com and enterprise accounts stay separate.</p>
<section><div class="row"><h2>Account and model</h2><button id="refresh" type="button">Refresh accounts</button></div>
<label for="account">GitHub account</label><select id="account" disabled><option>Loading accounts…</option></select>
<p id="source" class="hint"></p><label for="model">Copilot model</label><select id="model" disabled><option>Select an account first</option></select>
<p class="hint">Only models advertising the Responses API are listed. Codex runs the tools.</p>
<button id="apply" class="primary" type="button" disabled>Use this account and model</button></section>
<p id="status" role="status" aria-live="polite"></p><p id="warnings" class="source-warning" role="status" aria-live="polite" hidden></p><p class="foot">Credentials remain in their existing local credential stores. Switching here does not switch your GitHub CLI account.</p>
</main><script src="/app.js"></script></body></html>`;

export const setupCss = `:root{font:16px/1.5 system-ui,sans-serif;color:#1c2733;background:#f4f6f8;color-scheme:light}*{box-sizing:border-box}body{margin:0}main{max-width:700px;margin:64px auto;padding:0 24px}h1{font-size:32px;letter-spacing:-.8px;line-height:1.15;margin:10px 0 16px}h2{font-size:18px;margin:0}.eyebrow{font-size:12px;letter-spacing:1.4px;color:#466173;font-weight:700}.intro{color:#566570;margin-bottom:32px}section{background:white;border:1px solid #d8e0e6;border-radius:12px;padding:26px}.row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px}label{display:block;font-weight:600;margin:18px 0 8px}select{display:block;width:100%;font:inherit;padding:10px;border:1px solid #aab8c3;border-radius:6px;background:white;color:inherit}button{font:inherit;border:1px solid #aab8c3;background:white;color:#263c4b;border-radius:6px;padding:8px 12px;cursor:pointer}button:disabled{opacity:.5;cursor:default}.primary{margin-top:20px;background:#145f52;border-color:#145f52;color:white;padding:11px 16px}button:focus-visible,select:focus-visible{outline:3px solid #86baef;outline-offset:3px}.hint,.foot{font-size:13px;color:#647480}.hint{margin:7px 0}.foot{margin-top:28px}#status{min-height:28px;white-space:pre-line}#status.error{color:#a32424}.source-warning{padding:12px;border-left:3px solid #b38424;background:#fff8e8;color:#775513;font-size:13px;white-space:pre-line}@media(max-width:500px){main{margin:28px auto}.row{align-items:flex-start;flex-direction:column}section{padding:20px}}`;

export const setupJs = String.raw`const account = document.getElementById('account');
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
