import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAPI } from './api-request.mjs';

const config = { base_url: 'https://example.test/v1', api_key: 'test-key', model: 'test-model', budget: 0.01,
  pricing: { input_per_million: 0.05, cached_input_per_million: 0.005, output_per_million: 0.25 } };
const details = { method: 'POST', url: 'https://example.test/v1/responses', data: JSON.stringify({ model: config.model, store: false, reasoning: { effort: 'medium' }, input: 'test question', max_output_tokens: 32 }) };
const oldRequest = { id: 'old-timeout', at: '2026-10-15T05:38:49.043Z', status: 'unknown', reserved_nanos: 1364500, failure_stage: 'connecting', failure_type: 'TimeoutError' };
const answer = () => new Response(JSON.stringify({ status: 'completed', model: config.model, usage: { input_tokens: 10, output_tokens: 1 }, output: [] }));

async function fixture(t, entry = oldRequest, fetchImpl = answer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-uooc-api-test-'));
  const file = path.join(dir, 'course-1.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(file, JSON.stringify({ courseId: '1', model: config.model, requests: [entry] }));
  return { api: createAPI(config, dir, fetchImpl), read: async () => JSON.parse(await fs.readFile(file, 'utf8')) };
}

test('a transport timeout stays blocked without an explicit retry', async t => {
  let calls = 0;
  const { api, read } = await fixture(t, oldRequest, () => { calls++; return answer(); });
  await assert.rejects(api('1', details), /费用未知/);
  assert.equal(calls, 0);
  assert.deepEqual((await read()).requests, [oldRequest]);
});

test('explicit retry after a connection timeout preserves its full fee reservation', async t => {
  const { api, read } = await fixture(t);
  await api.prepareResume('1');
  assert.equal((await api('1', details)).status, 200);
  const { requests } = await read();
  assert.deepEqual(requests[0], oldRequest);
  assert.equal(requests[1].status, 'known');
  assert.deepEqual(requests[1].resumed_unknown_requests, [oldRequest.id]);
  assert.ok(requests[1].cost_nanos > 0);
});

test('an earlier unknown fee still consumes the remaining budget on explicit retry', async t => {
  let calls = 0;
  const entry = { ...oldRequest, reserved_nanos: 9999999 };
  const { api, read } = await fixture(t, entry, () => { calls++; return answer(); });
  await api.prepareResume('1');
  await assert.rejects(api('1', details), /预算不足/);
  assert.equal(calls, 0);
  assert.deepEqual((await read()).requests, [entry]);
});

test('a new transport failure requires another manual retry and never loops automatically', async t => {
  let calls = 0;
  const { api, read } = await fixture(t, oldRequest, () => { calls++; throw Object.assign(new Error('offline'), { name: 'TimeoutError' }); });
  await api.prepareResume('1');
  await assert.rejects(api('1', details), /结果或费用未知/);
  await assert.rejects(api('1', details), /费用未知/);
  assert.equal(calls, 1);
  assert.equal((await read()).requests.length, 2);
  assert.equal((await read()).requests[1].status, 'unknown');
});

test('pending requests and unrelated accounting or authentication errors remain blocked', async t => {
  for (const change of [ { status: 'pending' }, { failure_stage: 'accounting' }, { failure_stage: 'receiving' }, { failure_type: 'Error' }, { http_status: 401 }, { id: '' }, { reserved_nanos: 0 } ]) {
    const entry = { ...oldRequest, ...change };
    let calls = 0;
    const { api, read } = await fixture(t, entry, () => { calls++; return answer(); });
    await api.prepareResume('1');
    await assert.rejects(api('1', details), /费用未知|账本金额无效/);
    assert.equal(calls, 0);
    assert.deepEqual((await read()).requests, [entry]);
  }
});

test('explicit retry continues to support interrupted HTTP 200 and 502 responses', async t => {
  for (const http_status of [200, 502]) {
    const entry = { ...oldRequest, http_status, failure_stage: 'receiving' };
    const { api, read } = await fixture(t, entry);
    await api.prepareResume('1');
    assert.equal((await api('1', details)).status, 200);
    assert.deepEqual((await read()).requests[0], entry);
  }
});
