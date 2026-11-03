import http from 'node:http';
import { once } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { BUILD_ID, getPaths, localKey, readSettings, updateSettings, publicAccount, safeError } from './state.mjs';
import { discoverAccounts as defaultDiscover, resolveCredential as defaultResolve } from './accounts.mjs';
import { configureProvider as defaultConfigure, applyProviderSelection, assertSelectionReady, hasPendingSelection } from './config.mjs';
import { CopilotClient, CopilotError, createResponsesAdapter, rewriteSSE } from './copilot.mjs';
import { setupHtml, setupCss, setupJs } from './ui.mjs';

const SERVICE = 'copilot-proxy-plugin';
const VERSION = 1;

function json(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function requestJson(request, limit) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new CopilotError('Use application/json for this request.', 415, 'unsupported_media_type');
  const buffers = []; let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw new CopilotError('The request is too large.', 413, 'request_too_large');
    buffers.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw new CopilotError('The request must contain valid JSON.', 400, 'invalid_request_error'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CopilotError('The request must be a JSON object.', 400, 'invalid_request_error');
  return value;
}

export async function startServer({ paths = getPaths(), cliPath, port,
  discoverAccounts = defaultDiscover, resolveCredential = defaultResolve,
  configureProvider = defaultConfigure, persistSettings = updateSettings, fetchImpl = globalThis.fetch,
  copilot = new CopilotClient({ resolveCredential, fetchImpl }),
} = {}) {
  const key = await localKey(paths);
  const settings = await readSettings(paths);
  const listenPort = port ?? settings.port;
  const controllers = new Set(); let closing; let baseUrl; let mutation = Promise.resolve();
  const serialize = operation => { const next = mutation.then(operation); mutation = next.catch(() => {}); return next; };
  const accounts = async () => {
    const current = await readSettings(paths);
    const warnings = new Set();
    const values = await discoverAccounts({ credentialFiles: current.credentialFiles || [], onWarning: warning => {
      if (typeof warning === 'string' && warnings.size < 10) warnings.add(safeError(new Error(warning)));
    } });
    return { current, values, warnings: [...warnings] };
  };
  const findAccount = async id => {
    const { current, values } = await accounts();
    const selected = values.find(account => account.id === (id || current.accountId));
    if (!selected) throw new CopilotError('The selected local account is unavailable. Open Copilot setup and refresh the accounts.', 401, 'account_unavailable');
    return selected;
  };
  const authorized = request => {
    const received = request.headers.authorization;
    if (typeof received !== 'string' || !received.startsWith('Bearer ')) return false;
    const value = Buffer.from(received.slice(7)); const expected = Buffer.from(key);
    return value.length === expected.length && timingSafeEqual(value, expected);
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const controller = new AbortController(); controllers.add(controller);
    request.once('aborted', () => controller.abort());
    response.once('close', () => { if (!response.writableEnded) controller.abort(); controllers.delete(controller); });
    try {
      const actualPort = server.address()?.port;
      if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(request.headers.host) ||
        (request.headers.origin && ![baseUrl, `http://localhost:${actualPort}`].includes(request.headers.origin))) {
        throw new CopilotError('This endpoint only accepts requests from its local origin.', 403, 'invalid_origin');
      }
      const url = new URL(request.url, baseUrl);
      if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { service: SERVICE, version: VERSION });
      if (request.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const [body, type] = url.pathname === '/' ? [setupHtml, 'text/html'] : url.pathname === '/app.js' ? [setupJs, 'text/javascript'] : [setupCss, 'text/css'];
        response.writeHead(200, { 'content-type': `${type}; charset=utf-8` }); response.end(body); return;
      }
      if (!authorized(request)) throw new CopilotError('A local proxy credential is required.', 401, 'unauthorized');
      if (request.method === 'GET' && url.pathname === '/admin/status') {
        const current = await readSettings(paths);
        const selectionPending = await hasPendingSelection(paths);
        return json(response, 200, { service: SERVICE, version: VERSION, configured: !selectionPending && !!(current.accountId && current.model), selectionPending, port: actualPort,
          cliPath, buildId: BUILD_ID, activeRequests: Math.max(0, controllers.size - 1) });
      }
      if (request.method === 'POST' && url.pathname === '/admin/shutdown') {
        json(response, 200, { stopped: true }); setTimeout(() => close(), 25).unref(); return;
      }
      if (request.method === 'GET' && url.pathname === '/admin/accounts') {
        const { current, values, warnings } = await accounts();
        return json(response, 200, { accounts: values.map(publicAccount), accountId: current.accountId, model: current.model, warnings });
      }
      if (request.method === 'GET' && url.pathname === '/admin/models') {
        const account = await findAccount(url.searchParams.get('accountId'));
        const models = await copilot.listModels(account, { signal: controller.signal, refresh: true });
        return json(response, 200, { models: models.map(model => ({ id: model.id, name: model.name || model.id })) });
      }
      if (request.method === 'POST' && url.pathname === '/admin/select') {
        const input = await requestJson(request, 16 * 1024);
        if (typeof input.accountId !== 'string' || typeof input.model !== 'string' || !input.model || input.model.length > 256) {
          throw new CopilotError('Choose an existing account and a Copilot model.', 400, 'invalid_selection');
        }
        const result = await serialize(async () => {
          controller.signal.throwIfAborted();
          const account = await findAccount(input.accountId);
          const models = await copilot.listModels(account, { signal: controller.signal, refresh: true });
          if (!models.some(model => model.id === input.model)) throw new CopilotError('The chosen model is not available for this account.', 400, 'model_not_supported');
          controller.signal.throwIfAborted();
          const configured = await applyProviderSelection({ accountId: account.id, model: input.model, port: actualPort, cliPath }, paths,
            { configureProviderImpl: configureProvider, persistSettings });
          return { account: publicAccount(account), model: input.model, restartRequired: true, configFile: configured.configFile };
        });
        return json(response, 200, result);
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        // Codex refreshes expect ModelInfo records rather than OpenAI model objects.
        // An empty native catalog keeps its bundled metadata instead of merging an invalid Copilot schema.
        if (url.searchParams.has('client_version')) return json(response, 200, { models: [] });
        const account = await findAccount();
        const models = await copilot.listModels(account, { signal: controller.signal });
        return json(response, 200, { object: 'list', data: models });
      }
      if (request.method === 'POST' && url.pathname === '/v1/responses') {
        const input = await requestJson(request, 16 * 1024 * 1024);
        if (typeof input.model !== 'string' || !input.model || (input.stream != null && typeof input.stream !== 'boolean')) throw new CopilotError('A model and a valid stream flag are required.', 400, 'invalid_request_error');
        await assertSelectionReady(paths);
        const account = await findAccount(); // Capture account before awaiting; a UI switch cannot move an in-flight request.
        await assertSelectionReady(paths);
        const adapter = createResponsesAdapter(input);
        const upstream = await copilot.responses(account, adapter.input, { signal: controller.signal });
        if (/^text\/event-stream(?:;|$)/i.test(upstream.headers.get('content-type') || '')) {
          response.writeHead(upstream.status, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' });
          response.flushHeaders();
          try {
            let terminal = false;
            for await (const chunk of rewriteSSE(upstream.body, payload => {
              if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(payload?.type)) terminal = true;
              return adapter.rewrite(payload);
            })) {
              controller.signal.throwIfAborted();
              if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
            }
            if (!terminal) throw new CopilotError('Copilot closed the response stream before a terminal event.', 502, 'incomplete_upstream_stream');
            response.end();
          } finally { controller.abort(); }
        } else {
          let payload;
          try { payload = await upstream.json(); } catch { throw new CopilotError('Copilot returned an invalid Responses object.'); }
          json(response, upstream.status, adapter.rewrite(payload));
        }
        return;
      }
      throw new CopilotError('Endpoint not found.', 404, 'not_found');
    } catch (error) {
      if (response.destroyed || response.writableEnded || request.aborted) return;
      const aborted = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const status = Number.isInteger(error.status) ? error.status : aborted ? 504 : 500;
      const envelope = { error: { message: aborted ? 'The request was cancelled or timed out.' : safeError(error), type: 'api_error', code: error.code || (aborted ? 'request_timeout' : 'proxy_error') } };
      if (response.headersSent) {
        response.end(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: envelope.error } })}\n\n`);
      } else {
        if (error.retryAfter) response.setHeader('retry-after', error.retryAfter);
        json(response, status, envelope);
      }
    } finally { controllers.delete(controller); }
  });
  server.headersTimeout = 15_000; server.requestTimeout = 30_000; server.keepAliveTimeout = 2_000;
  const close = () => {
    if (!closing) closing = new Promise((resolve, reject) => {
      for (const controller of controllers) controller.abort();
      server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
    });
    return closing;
  };
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => { server.off('error', reject); baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  return { server, url: baseUrl, close };
}
