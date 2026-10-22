import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import timers from 'node:timers/promises';
import { createAPI } from '../api-request.mjs';

const config = { base_url: 'https://fixture.invalid/v1', model: 'fixture-model', api_key: 'local-fixture-key', budget: 1, pricing: { input_per_million: .05, cached_input_per_million: .005, output_per_million: .25 } };
const reply = { model: config.model, status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [] };
const details = { method: 'POST', url: config.base_url + '/responses', timeout: 5000, data: JSON.stringify({ model: config.model, reasoning: { effort: 'medium' }, store: false, input: 'fixture', max_output_tokens: 128 }) };
const limited = headers => new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Too many requests' } }), { status: 429, headers });

async function setup(t, fetcher, log) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-real-transport-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { api: createAPI(config, dir, fetcher, log), ledger: async () => JSON.parse(await fs.readFile(path.join(dir, 'course-123.json'), 'utf8')) };
}

async function transport(t, respond) {
  const server = http.createServer((request, response) => { request.resume(); respond(response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port;
}

test('real fetch SSE deadlines recover with reservations and normalize only the owned timeout AbortError', async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const waits = [], logs = [], limits = [];
  t.mock.method(AbortSignal, 'timeout', ms => { limits.push(ms); return timeout(150); });
  t.mock.method(timers, 'setTimeout', async ms => { waits.push(ms); });
  for (const wrapped of [false, true]) {
    let calls = 0;
    const address = await transport(t, response => {
      if (++calls === 1) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': waiting\n\n'); }
      else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(reply)); }
    });
    const { api, ledger } = await setup(t, async (_url, options) => {
      const response = await fetch(address, options);
      if (!wrapped || calls !== 1) return response;
      const reader = response.body.getReader();
      return { status: response.status, ok: response.ok, headers: response.headers, body: { getReader: () => ({
        async read() { try { return await reader.read(); } catch { throw new DOMException('transport wrapped deadline', 'AbortError'); } },
        cancel: () => reader.cancel(),
      }) } };
    }, message => logs.push(message));
    assert.equal((await api('123', details, async () => true)).status, 200);
    assert.equal(calls, 2);
    const entries = (await ledger()).requests;
    assert.equal(entries[0].failure_type, 'TimeoutError');
    assert.equal(entries[0].failure_stage, 'receiving');
    assert.equal(entries[0].status, 'unknown');
    assert(entries[0].reserved_nanos > 0);
    assert.equal(entries[1].status, 'known');
    assert.deepEqual(entries[1].resumed_unknown_requests, [entries[0].id]);
  }
  assert.deepEqual(waits, [10000, 10000]);
  assert(limits.every(ms => ms === 5000), 'the production minimum remains five seconds');
  assert.equal(logs.filter(message => /自动恢复成功/.test(message)).length, 2);
  assert(!logs.join('').includes(config.api_key));
});

test('an unrelated abort after HTTP 200 remains unknown and cannot auto-retry', async t => {
  let calls = 0;
  const address = await transport(t, response => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': waiting\n\n'); });
  const { api, ledger } = await setup(t, async () => {
    calls++;
    const controller = new AbortController();
    const response = await fetch(address, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    return response;
  });
  await assert.rejects(api('123', details, async () => true), /费用未知/);
  assert.equal(calls, 1);
  assert.equal((await ledger()).requests[0].failure_type, 'AbortError');
});

test('a real broken response stream recovers but a failure before headers remains blocked', async t => {
  const waits = [];
  t.mock.method(timers, 'setTimeout', async ms => { waits.push(ms); });
  let calls = 0;
  const address = await transport(t, response => {
    if (++calls === 1) { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': incomplete\n\n'); setTimeout(() => response.destroy(), 10); }
    else { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(reply)); }
  });
  const { api, ledger } = await setup(t, (_url, options) => fetch(address, options));
  assert.equal((await api('123', details, async () => true)).status, 200);
  assert.equal(calls, 2); assert.deepEqual(waits, [10000]);
  assert.equal((await ledger()).requests[0].failure_type, 'TypeError');
  let sent = 0;
  const beforeHeaders = await setup(t, async () => { sent++; throw new TypeError('fixture connection lost'); });
  await assert.rejects(beforeHeaders.api('123', details, async () => true), /费用未知/);
  assert.equal(sent, 1);
  assert.equal((await beforeHeaders.ledger()).requests[0].failure_stage, 'connecting');
});

test('rate limits use exponential waits and report exhaustion without losing reservations', async t => {
  const waits = [], logs = []; let calls = 0;
  t.mock.method(timers, 'setTimeout', async ms => { waits.push(ms); });
  const { api, ledger } = await setup(t, async () => { calls++; return limited({ 'Retry-After': '2' }); }, message => logs.push(message));
  await assert.rejects(api('123', details, async () => true), /已自动重试 2 次/);
  assert.equal(calls, 3); assert.deepEqual(waits, [2000, 4000]);
  assert.equal(logs.length, 3); assert.match(logs[0], /HTTP 429.*2 秒.*1\/2/); assert.match(logs[2], /自动恢复停止.*2\/2/);
  assert((await ledger()).requests.every(entry => entry.status === 'unknown' && entry.reserved_nanos > 0));
});

test('HTTP-date Retry-After is respected and invalid or long waits require human recovery', async t => {
  const waits = [];
  t.mock.method(timers, 'setTimeout', async ms => { waits.push(ms); });
  const fixed = Date.now(); t.mock.method(Date, 'now', () => fixed);
  let calls = 0;
  const when = new Date(fixed + 5000).toUTCString();
  const { api, ledger } = await setup(t, async () => ++calls === 1 ? limited({ 'Retry-After': when }) : Response.json(reply));
  assert.equal((await api('123', details, async () => true)).status, 200);
  const seconds = Math.ceil((Date.parse(when) - fixed) / 1000);
  assert.deepEqual(waits, [seconds * 1000]); assert.equal((await ledger()).requests[0].retry_after_seconds, seconds);
  for (const value of ['not-a-date', '-1', new Date(fixed + 600000).toUTCString()]) {
    let attempts = 0;
    const blocked = await setup(t, async () => { attempts++; return limited({ 'Retry-After': value }); });
    await assert.rejects(blocked.api('123', details, async () => true), /HTTP 429/); assert.equal(attempts, 1);
  }
});

test('a throwing recovery logger cannot change a paid request outcome', async t => {
  t.mock.method(timers, 'setTimeout', async () => {});
  let calls = 0;
  const { api, ledger } = await setup(t, async () => ++calls === 1 ? limited({ 'Retry-After': '0' }) : Response.json(reply), () => { throw new Error('fixture logger unavailable'); });
  assert.equal((await api('123', details, async () => true)).status, 200);
  assert.equal(calls, 2); assert.equal((await ledger()).requests[1].status, 'known');
});

for (const operation of ['mkdir', 'readFile', 'rename']) test(`cancelling during ledger ${operation} prevents dispatch and releases only the unsent reservation`, async t => {
  let calls = 0, active = true, release, entered, held = false;
  const gate = new Promise(resolve => { release = resolve; }), seen = new Promise(resolve => { entered = resolve; });
  const { api, ledger } = await setup(t, async () => { calls++; return Response.json(reply); });
  const original = fs[operation].bind(fs);
  t.mock.method(fs, operation, async (...args) => {
    if (held || !String(args[0]).includes('szu-real-transport-')) return original(...args);
    held = true;
    const result = await original(...args).then(value => ({ value }), error => ({ error }));
    entered(); await gate;
    if (result.error) throw result.error;
    return result.value;
  });
  const pending = api('123', details, async () => active);
  await seen; active = false; release();
  await assert.rejects(pending, error => error.notSent === true);
  assert.equal(calls, 0);
  const entries = (await ledger().catch(error => { if (error.code === 'ENOENT') return { requests: [] }; throw error; })).requests;
  assert(entries.length === 0 || entries.every(entry => entry.status === 'known' && entry.cost_nanos === 0 && entry.reserved_nanos === 0 && entry.not_sent));
});

test('cancelling an unsent retry keeps the earlier paid attempt unknown and cannot claim the operation was never sent', async t => {
  let calls = 0, active = true, saves = 0;
  t.mock.method(timers, 'setTimeout', async () => {});
  const { api, ledger } = await setup(t, async () => { calls++; return limited({ 'Retry-After': '0' }); });
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (...args) => { await rename(...args); if (++saves === 3) active = false; });
  await assert.rejects(api('123', details, async () => active), error => /HTTP 429/.test(error.message) && !error.notSent);
  assert.equal(calls, 1);
  const entries = (await ledger()).requests;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].status, 'unknown'); assert(entries[0].reserved_nanos > 0);
  assert.equal(entries[1].status, 'known'); assert.equal(entries[1].cost_nanos, 0); assert.equal(entries[1].reserved_nanos, 0); assert.equal(entries[1].not_sent, true);
});
