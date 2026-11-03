import test from 'node:test';
import assert from 'node:assert/strict';
import { CopilotClient, githubApiBase, validateCopilotEndpoint, responsesModels, createResponsesAdapter, rewriteSSE } from '../src/copilot.mjs';

const account = { id: 'public', host: 'github.com', login: 'alice', source: 'fixture' };
const enterprise = { id: 'enterprise', host: 'microsoft.ghe.com', login: 'alice_enterprise', source: 'fixture' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const model = { id: 'fixture-model', supported_endpoints: ['/responses'] };

test('GitHub and GHE APIs and tokens stay on the selected host', async () => {
  assert.equal(githubApiBase('github.com'), 'https://api.github.com');
  assert.equal(githubApiBase('microsoft.ghe.com'), 'https://api.microsoft.ghe.com');
  assert.throws(() => githubApiBase('evil.test'));
  assert.throws(() => githubApiBase('one.two.ghe.com'));
  assert.throws(() => validateCopilotEndpoint('https://api.githubcopilot.com', enterprise.host));
  assert.throws(() => validateCopilotEndpoint('https://copilot-api.other.ghe.com', enterprise.host));
  assert.throws(() => validateCopilotEndpoint('http://api.githubcopilot.com', account.host));
  assert.throws(() => validateCopilotEndpoint('https://api.githubcopilot.com.evil.test', account.host));
  const exchanges = []; const calls = [];
  const client = new CopilotClient({
    resolveCredential: async value => ({ token: `fixture-${value.id}`, host: value.host, login: value.login }),
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      if (url.endsWith('/token')) {
        exchanges.push(url);
        return json({ token: url.includes('microsoft') ? 'enterprise-copilot' : 'public-copilot', expires_at: Date.now() / 1000 + 3600,
          endpoints: { api: url.includes('microsoft') ? 'https://copilot-api.microsoft.ghe.com' : 'https://api.githubcopilot.com' } });
      }
      return json({ data: [model, { id: 'chat-only', supported_endpoints: ['/chat/completions'] }] });
    },
  });
  assert.deepEqual(await client.listModels(account), [model]);
  assert.deepEqual(await client.listModels(enterprise), [model]);
  assert.equal(exchanges.length, 2);
  assert.equal(calls.find(([url]) => url === 'https://api.githubcopilot.com/models')[1].headers.authorization, 'Bearer public-copilot');
  assert.equal(calls.find(([url]) => url === 'https://copilot-api.microsoft.ghe.com/models')[1].headers.authorization, 'Bearer enterprise-copilot');
  assert.ok(calls.every(([, init]) => init.redirect === 'error'));
});

test('native Responses preserve function calls, history and stream semantics', async () => {
  const requests = [];
  const client = new CopilotClient({ resolveCredential: async () => ({ token: 'fixture-auth', ...account }), fetchImpl: async (url, init) => {
    if (url.endsWith('/token')) return json({ token: 'fixture-copilot', endpoints: { api: 'https://api.githubcopilot.com' } });
    if (url.endsWith('/models')) return json({ data: [model] });
    requests.push(JSON.parse(init.body));
    return json({ id: 'response-fixture', output: [] });
  } });
  const input = { model: model.id, stream: false, service_tier: 'priority', store: false, input: [
    { type: 'function_call', call_id: 'call-1', name: 'shell', arguments: '{"command":"dir"}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'fixture' },
    { type: 'reasoning', encrypted_content: 'gAAAAA-history' },
  ] };
  await client.responses(account, input);
  const { service_tier, ...expected } = input;
  assert.deepEqual(requests[0], expected);
  assert.equal(input.service_tier, 'priority');
  await assert.rejects(client.responses(account, { model: 'chat-only', input: [] }), error => error.code === 'model_not_supported');
});

test('deduplicates refresh and retries one pre-stream 401 without exposing upstream text', async () => {
  let exchanges = 0; let inference = 0;
  const client = new CopilotClient({ resolveCredential: async () => ({ token: 'fixture-auth', ...account }), fetchImpl: async (url) => {
    if (url.endsWith('/token')) { exchanges++; await new Promise(resolve => setTimeout(resolve, 10)); return json({ token: `copilot-${exchanges}`, endpoints: { api: 'https://api.githubcopilot.com' } }); }
    if (url.endsWith('/models')) return json({ data: [model] });
    inference++;
    return inference === 1 ? json({ secret: 'must-not-appear' }, 401) : json({ output: [] });
  } });
  await Promise.all([client.token(account), client.token(account), client.token(account)]);
  assert.equal(exchanges, 1);
  await client.responses(account, { model: model.id, input: [] });
  assert.equal(exchanges, 2); assert.equal(inference, 2);
  const denied = new CopilotClient({ resolveCredential: async () => ({ token: 'secret', ...account }), fetchImpl: async () => json({ message: 'token ghp_shouldneverappear' }, 403) });
  await assert.rejects(denied.listModels(account), error => error.status === 403 && !error.message.includes('shouldneverappear'));
});

test('credential mismatch and enterprise missing endpoint fail closed', async () => {
  const mismatched = new CopilotClient({ resolveCredential: async () => ({ token: 'other-token', host: 'github.com', login: 'other' }), fetchImpl: () => assert.fail('network must not run') });
  await assert.rejects(mismatched.token(account), error => error.code === 'account_changed');
  const missing = new CopilotClient({ resolveCredential: async () => ({ token: 'enterprise', ...enterprise }), fetchImpl: async () => json({ token: 'copilot' }) });
  await assert.rejects(missing.token(enterprise), error => error.code === 'missing_enterprise_endpoint');
  assert.deepEqual(responsesModels({ data: [{ id: 'unknown' }, model] }), [model]);
});

test('DevMoor compatibility keeps collaboration history opaque and marks only complete plaintext calls', async () => {
  const historical = { type: 'function_call', namespace: 'collaboration', name: 'send_message', arguments: '{"message":"gAAAAA-old"}', encrypted_function_args: ['message'], call_id: 'history-call' };
  const original = { input: [historical], tools: [{ type: 'namespace', name: 'collaboration', tools: [{ type: 'function', name: 'send_message', parameters: { type: 'object', properties: { message: { type: 'string', encrypted: true }, target: { type: 'string', encrypted: false } } } }] }] };
  const adapter = createResponsesAdapter(original);
  assert.equal(adapter.input.tools[0].name, 'copilot_proxy_collaboration');
  assert.equal(adapter.input.tools[0].tools[0].parameters.properties.message.encrypted, undefined);
  assert.deepEqual(adapter.input.input[0], historical);
  assert.equal(original.tools[0].name, 'collaboration');
  const output = adapter.rewrite({ output: [{ type: 'function_call', namespace: 'copilot_proxy_collaboration', name: 'send_message', arguments: '{"message":"hello"}', call_id: 'call-1' }] });
  assert.equal(output.output[0].namespace, 'collaboration'); assert.equal(output.output[0].call_id, 'call-1');
  assert.deepEqual(output.output[0].encrypted_function_args, []);
  const opaque = adapter.rewrite({ output: [{ type: 'function_call', namespace: 'copilot_proxy_collaboration', name: 'send_message', arguments: '{"message":"gAAAAA-new"}' }] });
  assert.equal(opaque.output[0].encrypted_function_args, undefined);
  const forced = createResponsesAdapter({ ...original, tool_choice: { type: 'function', name: 'send_message' } });
  assert.equal(forced.input.tools[0].name, 'collaboration');
});

test('chunked SSE stabilizes output IDs while preserving call IDs and terminal events', async () => {
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { id: 'first', type: 'function_call', call_id: 'keep-call' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'changed', delta: '{"text":"你好"}' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'other', type: 'function_call', call_id: 'keep-call' } },
    { type: 'response.completed', response: { id: 'keep-response', output: [{ id: 'last', type: 'function_call', call_id: 'keep-call' }] } },
  ];
  const raw = events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('') + ': keepalive\n\ndata: [DONE]\n\n';
  const bytes = Buffer.from(raw); const chunks = [];
  for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.subarray(i, i + 7));
  let output = ''; for await (const chunk of rewriteSSE(chunks, createResponsesAdapter({}).rewrite)) output += chunk;
  const rewritten = output.split(/\r?\n/).filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  assert.equal(rewritten[1].item_id, 'first'); assert.equal(rewritten[1].delta, '{"text":"你好"}');
  assert.equal(rewritten[2].item.id, 'first'); assert.equal(rewritten[2].item.call_id, 'keep-call');
  assert.equal(rewritten[3].response.output[0].id, 'first'); assert.equal(rewritten[3].response.id, 'keep-response');
  assert.ok(output.endsWith(': keepalive\n\ndata: [DONE]\n\n'));
});
