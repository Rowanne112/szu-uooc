import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAPI } from '../api-request.mjs';

const config = { base_url: 'https://fixture.invalid/v1', model: 'new-model', api_key: 'fixture-key', budget: 1, pricing: { input_per_million: 0.1, cached_input_per_million: 0.01, output_per_million: 0.6 } };
const details = { method: 'POST', url: config.base_url + '/responses', data: JSON.stringify({ model: config.model, reasoning: { effort: 'medium' }, store: false, input: 'question', max_output_tokens: 128 }) };
const known = { id: 'old-known', status: 'known', cost_nanos: 100000, pricing: { input_per_million: 0.05, cached_input_per_million: 0.005, output_per_million: 0.25 } };
const rejected = { id: 'old-rejected', status: 'unknown', http_status: 429, reserved_nanos: 1000000 };
async function setup(t, requests) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-model-switch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'course-123.json');
  await fs.writeFile(file, JSON.stringify({ courseId: '123', unit: 'provider_USD_credit', model: 'old-model', requests }));
  return { dir, file };
}
test('switching models preserves legacy entries and records the new model and prices per request', async t => {
  const { dir, file } = await setup(t, [known, rejected]); let calls = 0;
  const api = createAPI(config, dir, async (_url, options) => {
    calls++; assert.equal(JSON.parse(options.body).model, config.model);
    return new Response(JSON.stringify({ model: config.model, status: 'completed', usage: { input_tokens: 10, output_tokens: 1 }, output: [] }));
  });
  await assert.rejects(api('123', details), /上次请求费用未知/); assert.equal(calls, 0);
  await api.prepareResume('123');
  assert.equal((await api('123', details)).status, 200); assert.equal(calls, 1);
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(ledger.model, 'old-model');
  assert.deepEqual(ledger.requests.slice(0, 2), [known, rejected]);
  assert.equal(ledger.requests[2].model, config.model);
  assert.deepEqual(ledger.requests[2].pricing, config.pricing);
  assert(ledger.requests[2].cost_nanos >= 1600 && ledger.requests[2].cost_nanos <= 1601);
});
test('switching models still counts old known costs and reservations against the same course budget', async t => {
  const { dir, file } = await setup(t, [known, rejected]); const before = await fs.readFile(file, 'utf8'); let calls = 0;
  const api = createAPI({ ...config, budget: 0.002 }, dir, async () => { calls++; throw new Error('must not send'); });
  await assert.rejects(api('123', details), /预算不足/); assert.equal(calls, 0);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});
test('switching models cannot bypass an unresolved HTTP 502 charge', async t => {
  const old = { ...rejected, http_status: 502 }; const { dir, file } = await setup(t, [old]);
  const before = await fs.readFile(file, 'utf8'); let calls = 0;
  await assert.rejects(createAPI(config, dir, async () => { calls++; })('123', details), /费用未知.*HTTP 502/);
  assert.equal(calls, 0); assert.equal(await fs.readFile(file, 'utf8'), before);
});
