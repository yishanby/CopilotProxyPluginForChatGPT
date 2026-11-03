import { randomUUID } from 'node:crypto';

export class CopilotError extends Error {
  constructor(message, status = 502, code = 'copilot_error', retryAfter) {
    super(message); this.name = 'CopilotError'; this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}

export function githubApiBase(host) {
  const normalized = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!/^(?:github\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com)$/.test(normalized)) {
    throw new CopilotError('Invalid GitHub account host.', 400, 'invalid_account_host');
  }
  if (normalized === 'github.com') return 'https://api.github.com';
  if (normalized.endsWith('.ghe.com')) return `https://api.${normalized}`;
  throw new CopilotError('Only GitHub.com and GitHub Enterprise Cloud accounts are supported.', 400, 'invalid_account_host');
}

export function validateCopilotEndpoint(value, host) {
  let url;
  try { url = new URL(value); } catch { throw new CopilotError('Copilot returned an invalid API endpoint.'); }
  const hostname = url.hostname.toLowerCase();
  const accountHost = String(host).toLowerCase();
  githubApiBase(accountHost);
  const allowed = accountHost === 'github.com'
    ? hostname === 'githubcopilot.com' || hostname.endsWith('.githubcopilot.com')
    : hostname.endsWith(`.${accountHost}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    (url.port && url.port !== '443') || url.pathname !== '/' || !allowed) {
    throw new CopilotError('Copilot returned an untrusted API endpoint.', 502, 'untrusted_upstream');
  }
  return url.origin;
}

// Adapted from DevMoor gateway/copilot_{stream_ids,collaboration}.go (MIT, yishanby).
// Keep history, continuation tokens, call IDs and encrypted content opaque.
export function createResponsesAdapter(original) {
  const alias = 'copilot_proxy_collaboration';
  const messageTools = new Set(['spawn_agent', 'send_message', 'followup_task']);
  const input = structuredClone(original);
  const namespaces = []; const candidates = []; const identities = new Map();
  let conflict = false;
  const encrypted = value => value && typeof value === 'object' && Object.entries(value).some(([key, nested]) =>
    key === 'encrypted' ? nested !== false : encrypted(nested));
  const visit = (tools, namespace = '') => {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') continue;
      const name = tool.name;
      if (typeof name === 'string' && (name === alias || name.startsWith(`${alias}.`) || name.startsWith(`${alias}__`))) conflict = true;
      if (tool.type === 'namespace') {
        if (name === 'collaboration') namespaces.push(tool);
        visit(tool.tools, name); continue;
      }
      if (namespace !== 'collaboration' || typeof name !== 'string') continue;
      identities.set(name, false);
      if (!messageTools.has(name)) continue;
      const message = tool.parameters?.properties?.message;
      const remaining = structuredClone(tool.parameters || {});
      if (remaining.properties?.message) delete remaining.properties.message.encrypted;
      if (tool.type !== 'function' || message?.type !== 'string' ||
        ('encrypted' in message && typeof message.encrypted !== 'boolean') || encrypted(remaining)) { conflict = true; continue; }
      candidates.push(tool); identities.set(name, true);
    }
  };
  visit(input.tools);
  if (Array.isArray(input.input)) for (const item of input.input) if (item?.type === 'additional_tools') visit(item.tools);
  if (input.tool_choice != null && !['auto', 'none', 'required'].includes(input.tool_choice)) conflict = true;
  if (!conflict && candidates.length) {
    for (const tool of candidates) delete tool.parameters.properties.message.encrypted;
    for (const namespace of namespaces) namespace.name = alias;
  } else identities.clear();
  const rewriteCall = (item, complete) => {
    if (!item || !['function_call', 'custom_tool_call'].includes(item.type) || !identities.size) return;
    let name = item.name; let matched = item.namespace === alias;
    if (!item.namespace && typeof name === 'string') {
      for (const separator of ['.', '__']) if (name.startsWith(alias + separator)) { name = name.slice(alias.length + separator.length); matched = true; break; }
    }
    if (!matched || !identities.has(name)) return;
    item.name = name; item.namespace = 'collaboration';
    if (!complete || item.type !== 'function_call' || !identities.get(name) ||
      (item.status && item.status !== 'completed') || item.encrypted_function_args != null) return;
    try {
      const args = JSON.parse(item.arguments);
      if (typeof args.message === 'string' && !args.message.trimStart().startsWith('gAAAAA')) item.encrypted_function_args = [];
    } catch { /* Partial or opaque arguments must not be labelled as plaintext. */ }
  };
  const anchors = new Map();
  const rewrite = payload => {
    if (!payload || typeof payload !== 'object') return payload;
    const event = payload.type || '';
    if (event.startsWith('response.')) {
      const index = payload.output_index;
      if (Number.isSafeInteger(index) && index >= 0) {
        const item = payload.item;
        if (event === 'response.output_item.added' && typeof item?.id === 'string' && item.id &&
          typeof item.type === 'string' && item.type && !anchors.has(index)) anchors.set(index, { id: item.id, kind: item.type, blocked: false });
        const anchor = anchors.get(index);
        if (anchor && !anchor.blocked) {
          if (item && item.type !== anchor.kind) anchor.blocked = true;
          else {
            if (typeof item?.id === 'string' && item.id) item.id = anchor.id;
            if (typeof payload.item_id === 'string' && payload.item_id) payload.item_id = anchor.id;
          }
        }
      }
      if (['response.completed', 'response.failed', 'response.incomplete', 'response.in_progress'].includes(event)) {
        const output = payload.response?.output;
        if (Array.isArray(output) && [...anchors.keys()].every(index => index < output.length)) {
          output.forEach((item, index) => { const anchor = anchors.get(index); if (anchor && !anchor.blocked && item?.type === anchor.kind && typeof item.id === 'string' && item.id) item.id = anchor.id; });
        }
      }
    }
    if (event === 'response.output_item.added' || event === 'response.output_item.done') rewriteCall(payload.item, event.endsWith('.done'));
    else if (event === '' || ['response.created', 'response.in_progress', 'response.completed', 'response.failed', 'response.incomplete'].includes(event)) {
      const output = event ? payload.response?.output : payload.output;
      const complete = event ? event === 'response.completed' : !payload.status || payload.status === 'completed';
      if (Array.isArray(output)) for (const item of output) rewriteCall(item, complete);
    }
    return payload;
  };
  return { input: identities.size ? input : original, rewrite };
}

export async function* rewriteSSE(body, rewrite) {
  const decoder = new TextDecoder(); let pending = '';
  const frame = source => {
    const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [];
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/\r?\n$/, '')).join('\n');
    let parsed;
    try { parsed = JSON.parse(data); } catch { return source; }
    const before = JSON.stringify(parsed); const after = JSON.stringify(rewrite(parsed));
    if (before === after) return source;
    let written = false;
    return lines.map(line => {
      if (!line.startsWith('data:')) return line;
      if (written) return ''; written = true;
      return `data: ${after}${line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''}`;
    }).join('');
  };
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const end = boundary.index + boundary[0].length;
      if (Buffer.byteLength(pending.slice(0, end)) > 4 * 1024 * 1024) throw new CopilotError('Copilot sent an oversized stream event.');
      yield frame(pending.slice(0, end)); pending = pending.slice(end);
    }
    if (Buffer.byteLength(pending) > 4 * 1024 * 1024) throw new CopilotError('Copilot sent an oversized stream event.');
  }
  pending += decoder.decode();
  if (pending) yield frame(pending);
}

function serviceError(response, operation) {
  const status = response.status;
  const retryAfter = /^\d{1,6}$/.test(response.headers.get('retry-after') || '') ? response.headers.get('retry-after') : undefined;
  if (status === 401) return new CopilotError(`The selected account needs renewed GitHub Copilot authorization (${operation}).`, 401, 'copilot_authentication_failed');
  if (status === 403) return new CopilotError(`The selected account cannot access Copilot (${operation}). Check its subscription, organization policy, and SSO authorization.`, 403, 'copilot_access_denied');
  if (status === 429) return new CopilotError('The selected Copilot account is rate limited. Try again after its limit resets.', 429, 'copilot_rate_limited', retryAfter);
  return new CopilotError(`Copilot ${operation} failed (HTTP ${status}).`, status >= 400 && status < 500 ? status : 502, 'copilot_upstream_error');
}

function headers(token, accept = 'application/json') {
  const requestId = randomUUID();
  return {
    authorization: `Bearer ${token}`, accept, 'content-type': 'application/json',
    'copilot-integration-id': 'vscode-chat', 'editor-version': 'vscode/1.107.0',
    'editor-plugin-version': 'copilot-chat/0.35.0', 'user-agent': 'GitHubCopilotChat/0.35.0',
    'x-github-api-version': '2025-04-01', 'openai-intent': 'conversation-edits',
    'x-interaction-type': 'conversation-edits', 'x-initiator': 'user',
    'x-request-id': requestId, 'x-agent-task-id': requestId,
  };
}

async function checkedJson(response, operation) {
  if (!response.ok) {
    await response.body?.cancel();
    throw serviceError(response, operation);
  }
  try { return await response.json(); }
  catch { throw new CopilotError(`Copilot returned invalid JSON (${operation}).`); }
}

export function responsesModels(payload) {
  const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return entries.filter(model => typeof model?.id === 'string' &&
    Array.isArray(model.supported_endpoints) && model.supported_endpoints.some(endpoint =>
      endpoint === '/responses' || endpoint === '/v1/responses'));
}

export class CopilotClient {
  constructor({ resolveCredential, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 300_000 } = {}) {
    if (typeof resolveCredential !== 'function') throw new TypeError('resolveCredential is required.');
    this.resolveCredential = resolveCredential; this.fetchImpl = fetchImpl; this.now = now; this.timeoutMs = timeoutMs;
    this.tokens = new Map(); this.refreshes = new Map(); this.catalogs = new Map();
  }

  accountKey(account) { return `${account.host.toLowerCase()}\0${account.login}\0${account.id}`; }

  async fetch(url, options) {
    try { return await this.fetchImpl(url, { ...options, redirect: 'error' }); }
    catch (error) {
      if (options.signal?.aborted) throw options.signal.reason || error;
      throw new CopilotError('Cannot reach the selected GitHub/Copilot host. Check your network and enterprise access.', 502, 'copilot_network_error');
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
        throw new CopilotError('The selected account credential no longer matches. Refresh the local account list.', 401, 'account_changed');
      }
      const response = await this.fetch(`${githubApiBase(account.host)}/copilot_internal/v2/token`, {
        headers: { authorization: `token ${credential.token}`, accept: 'application/json',
          'user-agent': 'GitHubCopilotChat/0.35.0', 'x-github-api-version': '2025-04-01' },
        signal: AbortSignal.timeout(30_000),
      });
      const data = await checkedJson(response, 'authorization');
      if (typeof data.token !== 'string' || !data.token) throw new CopilotError('The selected account did not return a Copilot credential.', 403, 'copilot_access_denied');
      const base = data.endpoints?.api || (account.host.toLowerCase() === 'github.com' ? 'https://api.githubcopilot.com' : null);
      if (!base) throw new CopilotError('The enterprise account did not advertise a Copilot API endpoint.', 502, 'missing_enterprise_endpoint');
      const endpoint = validateCopilotEndpoint(base, account.host);
      const expiresAt = Number(data.expires_at) * 1000;
      const refreshIn = Number(data.refresh_in) * 1000;
      const remaining = Math.min(Number.isFinite(expiresAt) && expiresAt > this.now() ? expiresAt - this.now() : 300_000,
        Number.isFinite(refreshIn) && refreshIn > 0 ? refreshIn : 300_000);
      const result = { token: data.token, endpoint, refreshAt: this.now() + Math.max(0, remaining - Math.min(60_000, remaining / 10)) };
      this.tokens.set(key, result);
      return result;
    })();
    this.refreshes.set(key, refresh);
    try { return await refresh; } finally { if (this.refreshes.get(key) === refresh) this.refreshes.delete(key); }
  }

  async request(account, resource, { signal, body, stream = false } = {}) {
    const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.timeoutMs)]);
    requestSignal.throwIfAborted();
    let credential = await this.token(account);
    requestSignal.throwIfAborted();
    const send = () => this.fetch(`${credential.endpoint}${resource}`, {
      method: body ? 'POST' : 'GET', headers: headers(credential.token, stream ? 'text/event-stream' : 'application/json'),
      ...(body ? { body: JSON.stringify(body) } : {}), signal: requestSignal,
    });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      this.tokens.delete(this.accountKey(account));
      credential = await this.token(account, { force: true });
      requestSignal.throwIfAborted();
      response = await send();
    }
    if (!response.ok) { await response.body?.cancel(); throw serviceError(response, resource === '/models' ? 'model discovery' : 'inference'); }
    return response;
  }

  async listModels(account, { signal, refresh = false } = {}) {
    const key = this.accountKey(account);
    const cached = this.catalogs.get(key);
    if (!refresh && cached && cached.expires > this.now()) return cached.models;
    const models = responsesModels(await checkedJson(await this.request(account, '/models', { signal }), 'model discovery'));
    this.catalogs.set(key, { models, expires: this.now() + 60_000 });
    return models;
  }

  async responses(account, input, { signal } = {}) {
    const models = await this.listModels(account, { signal });
    if (!models.some(model => model.id === input.model)) {
      throw new CopilotError('This model is unavailable through the selected account’s native Responses API. Choose a model in Copilot setup.', 400, 'model_not_supported');
    }
    const body = { ...input };
    // Copilot rejects ChatGPT subscription service tiers; all other Responses items pass through.
    delete body.service_tier;
    return this.request(account, '/responses', { signal, body, stream: body.stream === true });
  }
}
