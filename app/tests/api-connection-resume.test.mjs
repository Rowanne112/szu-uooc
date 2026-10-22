import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAPI } from '../api-request.mjs';

const config = { base_url: 'https://fixture.invalid/v1', model: 'fixture-model', api_key: 'fixture-key', budget: 1, pricing: { input_per_million: .1, cached_input_per_million: .01, output_per_million: .6 } };
const details = { method: 'POST', url: config.base_url + '/responses', data: JSON.stringify({ model: config.model, reasoning: { effort: 'medium' }, store: false, input: 'question', max_output_tokens: 128 }) };
const ok = () => Response.json({ model: config.model, status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [] });

async function setup(t, fetcher) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-connection-resume-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'course-123.json');
  return { dir, file, read: async () => JSON.parse(await fs.readFile(file, 'utf8')), api: createAPI(config, dir, fetcher) };
}

test('manual resume after HTTP 200 then a connection failure survives a controller restart and preserves both reservations', async t => {
  let calls = 0;
  const { dir, file, read, api } = await setup(t, async () => {
    calls++;
    if (calls === 1) return Response.json({ model: config.model, status: 'completed', output: [] });
    throw new TypeError('fixture connection closed before response headers');
  });
  await assert.rejects(api('123', details), /HTTP 200.*费用未知/);
  await api.prepareResume('123');
  await assert.rejects(api('123', details, async () => true), /费用未知/);
  assert.equal(calls, 2, 'a request without HTTP headers must not retry automatically');
  const before = await read();
  assert.equal(before.requests.length, 2);
  assert.equal(before.requests[1].failure_stage, 'connecting');
  assert.equal(before.requests[1].http_status, undefined);
  assert(before.requests.every(entry => entry.status === 'unknown' && entry.reserved_nanos > 0));
  const restarted = createAPI(config, dir, async () => { calls++; return ok(); });
  await assert.rejects(restarted('123', details, async () => true), /上次请求费用未知/);
  assert.equal(calls, 2);
  const raw = await fs.readFile(file, 'utf8');
  await restarted.prepareResume('123');
  assert.deepEqual((await read()).requests, JSON.parse(raw).requests, 'preparing resume must not mutate old charges');
  assert.deepEqual((await read()).recoveries.at(-1).request_ids, [before.requests[1].id]);
  assert.equal((await restarted('123', details, async () => true)).status, 200);
  const after = await read();
  assert.deepEqual(after.requests.slice(0, 2), before.requests);
  assert.deepEqual(after.requests[2].resumed_unknown_requests, before.requests.map(entry => entry.id));
  assert.equal(calls, 3);
});

test('manual connection recovery keeps the reserved charge in the budget', async t => {
  const { dir, read, api } = await setup(t, async () => { throw new DOMException('fixture request deadline', 'TimeoutError'); });
  await assert.rejects(api('123', details), /费用未知/);
  const before = await read();
  const budget = before.requests[0].reserved_nanos * 1.5 / 1e9;
  let calls = 0;
  const resumed = createAPI({ ...config, budget }, dir, async () => { calls++; return ok(); });
  await resumed.prepareResume('123');
  await assert.rejects(resumed('123', details), /预算不足/);
  assert.equal(calls, 0);
  assert.deepEqual((await read()).requests, before.requests);
});

test('an old unknown request without HTTP or failure metadata can be manually resumed without rewriting its reservation', async t => {
  let calls = 0;
  const { file, read, api } = await setup(t, async () => { calls++; return ok(); });
  const old = { id: 'legacy-no-headers', status: 'unknown', reserved_nanos: 1363500 };
  await fs.writeFile(file, JSON.stringify({ courseId: '123', model: config.model, requests: [old] }));
  await assert.rejects(api('123', details), /上次请求费用未知/);
  assert.equal(calls, 0);
  const before = await fs.readFile(file, 'utf8');
  await api.prepareResume('123');
  assert.deepEqual((await read()).requests, JSON.parse(before).requests);
  assert.equal((await api('123', details)).status, 200);
  const ledger = await read();
  assert.deepEqual(ledger.requests[0], old);
  assert.deepEqual(ledger.requests[1].resumed_unknown_requests, [old.id]);
  assert.equal(calls, 1);
});

test('each new connection failure requires another explicit resume and never triggers automatic retries', async t => {
  let calls = 0;
  const { read, api } = await setup(t, async () => {
    if (++calls === 3) return ok();
    throw new TypeError('fixture connection closed before response headers');
  });
  await assert.rejects(api('123', details, async () => true), /费用未知/);
  assert.equal(calls, 1);
  await api.prepareResume('123');
  await assert.rejects(api('123', details, async () => true), /费用未知/);
  assert.equal(calls, 2);
  const before = await read();
  await assert.rejects(api('123', details, async () => true), /上次请求费用未知/);
  assert.equal(calls, 2, 'a prior resume cannot approve a newly failed request');
  await api.prepareResume('123');
  assert.equal((await api('123', details, async () => true)).status, 200);
  const after = await read();
  assert.deepEqual(after.requests.slice(0, 2), before.requests);
  assert.deepEqual(after.requests[2].resumed_unknown_requests, before.requests.map(entry => entry.id));
  assert.equal(calls, 3);
});

test('manual connection recovery still rejects invalid reservations and metering overflow', async t => {
  const old = { id: 'legacy-no-headers', status: 'unknown', reserved_nanos: 1363500 };
  for (const [entry, expected] of [
    [{ ...old, reserved_nanos: 0 }, /金额无效/],
    [{ ...old, reserved_nanos: -1 }, /金额无效/],
    [{ ...old, reserved_nanos: Number.MAX_SAFE_INTEGER + 1 }, /金额无效/],
    [{ ...old, metering_bound_exceeded: true }, /计量/],
  ]) {
    let calls = 0;
    const { file, api } = await setup(t, async () => { calls++; return ok(); });
    await fs.writeFile(file, JSON.stringify({ courseId: '123', model: config.model, requests: [entry] }));
    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(api.prepareResume('123'), expected);
    await assert.rejects(api('123', details), expected);
    assert.equal(calls, 0);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
});
