import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAPI } from '../api-request.mjs';

const config = { base_url: 'https://fixture.invalid/v1', model: 'fixture-model', api_key: 'fixture-key', budget: 1, pricing: { input_per_million: .1, cached_input_per_million: .01, output_per_million: .6 } };
const details = { method: 'POST', url: config.base_url + '/responses', data: JSON.stringify({ model: config.model, reasoning: { effort: 'medium' }, store: false, input: 'question', max_output_tokens: 128 }) };
const ok = () => new Response(JSON.stringify({ model: config.model, status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [] }));
async function setup(t, entries, settings = config, fetcher = ok) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-reserved-resume-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'course-123.json');
  await fs.writeFile(file, JSON.stringify({ courseId: '123', model: config.model, unit: 'provider_USD_credit', requests: entries }));
  return { file, api: createAPI(settings, dir, fetcher) };
}
const old = { id: 'old-502', status: 'unknown', http_status: 502, reserved_nanos: 1363500 };
test('explicit resume retains the complete old 502 reservation and records its recovery on the new request', async t => {
  let calls = 0; const { api, file } = await setup(t, [old], config, async () => { calls++; return ok(); });
  await assert.rejects(api('123', details), /上次请求费用未知/); assert.equal(calls, 0);
  const before = await fs.readFile(file, 'utf8'); await api.prepareResume('123');
  const approved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(approved.requests, JSON.parse(before).requests);
  assert.deepEqual(approved.recoveries[0].request_ids, [old.id]);
  assert.equal((await api('123', details, async () => true)).status, 200);
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(ledger.requests[0], old); assert.equal(ledger.requests[1].status, 'known');
  assert.deepEqual(ledger.requests[1].resumed_unknown_requests, ['old-502']); assert.equal(calls, 1);
});
test('a new 502 cannot be retried until a new explicit resume and cannot trigger the managed retry loop', async t => {
  let calls = 0; const { api, file } = await setup(t, [old], config, async () => { calls++; return calls === 1 ? new Response('Bad Gateway', { status: 502 }) : ok(); });
  await api.prepareResume('123'); await assert.rejects(api('123', details, async () => true), /HTTP 502/);
  assert.equal(calls, 1); await assert.rejects(api('123', details, async () => true), /上次请求费用未知/); assert.equal(calls, 1);
  await api.prepareResume('123'); assert.equal((await api('123', details)).status, 200);
  const ledger = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(ledger.requests.length, 3);
  assert.deepEqual(ledger.requests[0], old); assert(ledger.requests[1].reserved_nanos > 0);
});
test('an old HTTP 200 without usage can be explicitly resumed without erasing or zeroing its reserved charge', async t => {
  const entry = { ...old, id: 'old-200', http_status: 200 }; let calls = 0;
  const { api, file } = await setup(t, [entry], config, async () => { calls++; return ok(); });
  await assert.rejects(api('123', details), /费用未知/); assert.equal(calls, 0);
  await api.prepareResume('123'); assert.equal((await api('123', details)).status, 200);
  const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(ledger.requests[0], entry); assert.deepEqual(ledger.requests[1].resumed_unknown_requests, ['old-200']); assert.equal(calls, 1);
});
test('explicit resume cannot bypass the shared budget, invalid amounts or metering overflow', async t => {
  for (const [entry, settings, error] of [
    [old, { ...config, budget: .002 }, /预算不足/],
    [{ ...old, reserved_nanos: 0 }, config, /金额无效/],
    [{ ...old, metering_bound_exceeded: true }, config, /计量/],
  ]) {
    let calls = 0; const { api, file } = await setup(t, [entry], settings, async () => { calls++; return ok(); });
    const before = await fs.readFile(file, 'utf8');
    if (error.test('预算不足')) await api.prepareResume('123');
    else await assert.rejects(api.prepareResume('123'), error);
    await assert.rejects(api('123', details), error); assert.equal(calls, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).requests, JSON.parse(before).requests);
  }
});
test('explicit resume recognizes an interrupted pending request and every terminal HTTP failure without erasing reservations', async t => {
  for (const entry of [{ ...old, status: 'pending' }, { ...old, http_status: 500 }, { ...old, http_status: 404 }, { ...old, http_status: null }]) {
    let calls = 0; const { api, file } = await setup(t, [entry], config, async () => { calls++; return ok(); });
    await assert.rejects(api('123', details), /费用未知/); assert.equal(calls, 0);
    await api.prepareResume('123'); assert.equal((await api('123', details)).status, 200);
    const ledger = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(ledger.requests[0], entry); assert.equal(calls, 1);
    assert.deepEqual(ledger.recoveries[0].request_ids, [entry.id]);
  }
});
