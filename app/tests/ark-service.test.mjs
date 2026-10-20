import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectService, testImage } from '../student/service-detection.mjs';
import { createAPI } from '../api-request.mjs';
import { endpointFor, normalizeServiceURL, candidateModels, serviceProblem } from '../api-protocol.mjs';

const base = 'https://ark.cn-beijing.volces.com/api/v3';
const model = 'doubao-seed-2-0-mini-260428';
const key = 'fixture-ark-private-key';

test('official Ark models without a pricing extension pass detection and answer through the course API', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uooc-ark-'));
  const calls = [];
  const fake = async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    calls.push(url);
    if (url.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: model, object: 'model', owned_by: 'bytedance' }] });
    assert.equal(url, base + '/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, model);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, undefined, 'Ark max_tokens alone does not cap reasoning tokens');
    assert.equal(body.max_completion_tokens, 512);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.reasoning, undefined);
    const image = Array.isArray(body.messages[0].content);
    if (image) assert.equal(body.messages[0].content[1].image_url.url, testImage);
    return Response.json({ id: 'chat-fixture', model, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ answers: [{ index: 0, answers: [image ? '3' : '2'] }] }) } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 60 } } });
  };
  try {
    const result = await detectService({ base_url: base, api_key: key, dataDir: dir, fetchImpl: fake });
    assert.equal(result.status, 'ready', result.message);
    assert.equal(result.profile.verified_image, true);
    assert.equal(result.model, model);
    assert.equal(result.testCosts.calls, 2);
    assert.equal(result.testCosts.unknown, false);
    assert(result.testCosts.estimated_usd > 0 && result.testCosts.estimated_usd < .02);
    assert.match(result.reason, /人民币.*6/);
    const api = createAPI({ base_url: base, api_key: key, model, budget: 1, profile: result.profile }, path.join(dir, 'ledger'), fake);
    const reply = await api('123', { method: 'POST', url: endpointFor(base), data: JSON.stringify({ model, store: false, input: '计算1+1', max_output_tokens: 512 }) });
    assert.equal(JSON.parse(reply.responseText).output[0].content[0].text, '{"answers":[{"index":0,"answers":["2"]}]}');
    const ledger = JSON.parse(await fs.readFile(path.join(dir, 'ledger/course-123.json'), 'utf8'));
    assert.equal(ledger.requests[0].status, 'known');
    assert.equal(ledger.requests[0].usage.input_tokens_details.cached_tokens, 60);
    assert.equal(ledger.requests[0].cost_nanos, 49600, 'long-context CNY ceiling at the documented conservative FX rate');
    assert.equal(calls.length, 4);
    for (const file of ['service-detection.json', 'ledger/course-123.json']) assert(!(await fs.readFile(path.join(dir, file), 'utf8')).includes(key));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Ark without /models tries bounded official candidates and skips unopened models without changing protocol', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uooc-ark-catalog-'));
  const paid = [];
  try {
    const result = await detectService({ base_url: 'https://ark.cn-beijing.volces.com/', api_key: key, dataDir: dir, fetchImpl: async (url, options) => {
      if (options.method !== 'POST') {
        assert.equal(url, base + '/models');
        return new Response('Not Found', { status: 404 });
      }
      assert.equal(url, base + '/chat/completions');
      const body = JSON.parse(options.body); paid.push(body.model);
      if (body.model !== model) return Response.json({ error: { code: 'OperationDenied.ServiceNotOpen', type: 'Forbidden', message: 'Activate this model service in the Ark Console.' } }, { status: 403 });
      return Response.json({ model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: [{ index: 0, answers: [Array.isArray(body.messages[0].content) ? '3' : '2'] }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    } });
    assert.equal(result.status, 'ready', result.message);
    assert.equal(result.model, model);
    assert.equal(result.profile.verified_image, true);
    assert.deepEqual(paid, ['doubao-seed-2-1-lite-260915', model, model]);
    assert.equal(result.testCosts.unknown, true, 'failed candidate reservations remain accounted for');
    assert(result.testCosts.estimated_usd <= .02);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('only the official Ark base inherits known prices and defaults to /api/v3', () => {
  for (const url of [base, base + '/models/', base + '/responses', base + '/chat/completions', 'https://ark.cn-beijing.volces.com']) assert.equal(normalizeServiceURL(url), base);
  for (const url of ['https://relay.test/api/v3', 'https://ark.cn-beijing.volces.com.relay.test/api/v3', 'https://ark.cn-beijing.volces.com/api/coding/v3']) {
    assert.equal(candidateModels(url, [{ id: model }])[0].pricing, null);
  }
  for (const id of ['ep-20261020-private', 'doubao-seed-9-9-unknown']) assert.equal(candidateModels(base, [{ id }])[0].pricing, null, 'unknown endpoints and future model prices are never guessed');
});

test('Ark lists returning auth, billing or network errors never trigger paid fallback calls', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uooc-ark-errors-'));
  try {
    for (const [status, code, message] of [[401, 'AuthenticationError', /Key 无效/], [403, 'AccessDenied', /权限/], [403, 'AccountOverdueError', /余额|欠费/], [429, 'SetLimitExceeded', /用量上限|安心体验/], [500, 'InternalServiceError', /500/]]) {
      let calls = 0;
      await assert.rejects(detectService({ base_url: base, api_key: key, dataDir: dir, fetchImpl: async url => {
        calls++; assert.equal(url, base + '/models');
        return Response.json({ error: { code, message: code } }, { status });
      } }), message);
      assert.equal(calls, 1);
    }
    assert.match(serviceProblem(404, { error: { code: 'ModelNotOpen' } }), /模型.*开通/);
    assert.match(serviceProblem(404, { error: { code: 'InvalidEndpointOrModel.ModelIDAccessDisabled' } }), /接入点/);
    let failedCalls = 0;
    await assert.rejects(detectService({ base_url: base, api_key: key, dataDir: dir, fetchImpl: async () => { failedCalls++; throw new TypeError('network unavailable'); } }), /网络/);
    assert.equal(failedCalls, 1);
    await assert.rejects(detectService({ base_url: 'https://relay.test/api/v3', api_key: key, dataDir: dir, fetchImpl: async url => {
      assert.equal(url, 'https://relay.test/api/v3/models');
      return new Response('Not Found', { status: 404 });
    } }), /网址或模型接口/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('course errors retain Ark billing and usage-limit guidance and keep unknown cost reservations', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uooc-ark-course-errors-'));
  const profile = { ...candidateModels(base, [{ id: model }])[0], verified_text: true };
  try {
    for (const [status, code, message] of [[403, 'AccountOverdueError', /余额/], [429, 'SetLimitExceeded', /用量上限/]]) {
      const ledgerDir = path.join(dir, code);
      const api = createAPI({ base_url: base, api_key: key, model, budget: 1, profile }, ledgerDir, async () => Response.json({ error: { code, message: code } }, { status }));
      await assert.rejects(api('123', { method: 'POST', url: endpointFor(base), data: JSON.stringify({ model, input: '计算1+1', store: false, max_output_tokens: 512 }) }), message);
      const ledger = JSON.parse(await fs.readFile(path.join(ledgerDir, 'course-123.json'), 'utf8'));
      assert.equal(ledger.requests[0].status, 'unknown');
      assert(ledger.requests[0].reserved_nanos > 0);
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
