import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import timers from 'node:timers/promises';
import { createAPI, decodeResponse } from '../api-request.mjs';
import { diagnosticReport } from '../student/diagnostics.mjs';

const config = { base_url: 'https://fixture.invalid/v1', model: 'fixture-model', api_key: 'fixture-private-key', budget: 1, pricing: { input_per_million: .05, cached_input_per_million: .005, output_per_million: .25 } };
const reply = { model: config.model, status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ content: [{ type: 'output_text', text: '{"answers":[]}' }] }] };
const details = { method: 'POST', url: config.base_url + '/responses', data: JSON.stringify({ model: config.model, reasoning: { effort: 'medium' }, store: false, input: 'fixture', max_output_tokens: 128 }) };
const ended = 'event: response.created\ndata: {"type":"response.created"}\n\n';
async function setup(t, fetcher, settings = config) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-stream-end-')), dir = path.join(dataDir, 'ledger');
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, api: createAPI(settings, dir, fetcher), ledger: async () => JSON.parse(await fs.readFile(path.join(dir, 'course-123.json'), 'utf8')) };
}

test('a metered incomplete result keeps its known cost and exports its failure stage', async t => {
  let calls = 0;
  const { api, ledger, dataDir } = await setup(t, async () => { calls++; return Response.json({ ...reply, status: 'incomplete' }); });
  await assert.rejects(api('123', details, async () => true), /已记录 usage/);
  assert.equal(calls, 1);
  const entry = (await ledger()).requests[0];
  assert.equal(entry.status, 'known'); assert(entry.cost_nanos > 0); assert.equal(entry.reserved_nanos, 0);
  assert.equal(entry.failure_stage, 'accounting');
  const report = await diagnosticReport({ appDir: process.cwd(), dataDir, courses: [{ id: '123' }], logs: [], config, browser: {}, environment: {} });
  assert.equal(report.courses[0].api_requests[0].status, 'known');
  assert.equal(report.courses[0].api_requests[0].failure_stage, 'accounting');
  assert(!JSON.stringify(report).includes(config.api_key));
});

test('failed terminal events and metered provider errors cannot become successful answers', async t => {
  for (const type of ['response.incomplete', 'response.failed']) {
    for (const status of [undefined, 'completed']) {
      for (const body of [{ ...reply, status }, { model: config.model, status, choices: [{ finish_reason: 'stop', message: { content: 'partial' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]) {
        let calls = 0;
        const { api, ledger } = await setup(t, async () => { calls++; return new Response(`event: ${type}\ndata: ${JSON.stringify({ response: body })}\n\n`); });
        await assert.rejects(api('123', details, async () => true), /已记录 usage/);
        assert.equal(calls, 1); const entry = (await ledger()).requests[0];
        assert.equal(entry.status, 'known'); assert(entry.cost_nanos > 0); assert.equal(entry.failure_stage, 'accounting');
      }
    }
  }
  for (const choices of [undefined, [{ finish_reason: 'stop', message: { content: 'partial' } }]]) {
    let calls = 0;
    const { api, ledger } = await setup(t, async () => { calls++; return Response.json({ ...reply, choices, usage: choices ? { prompt_tokens: 1, completion_tokens: 1 } : reply.usage, error: { message: config.api_key } }); });
    await assert.rejects(api('123', details, async () => true), error => /已记录 usage/.test(error.message) && !error.message.includes(config.api_key));
    assert.equal(calls, 1); const entry = (await ledger()).requests[0];
    assert.equal(entry.status, 'known'); assert(entry.cost_nanos > 0); assert.equal(entry.failure_code, 'provider_error');
  }
});

test('a managed stream ending without a final response recovers and preserves the unknown reservation', async t => {
  const waits = []; t.mock.method(timers, 'setTimeout', async ms => { waits.push(ms); });
  let calls = 0;
  const { api, ledger } = await setup(t, async () => ++calls === 1 ? new Response(ended) : Response.json(reply));
  assert.equal((await api('123', details, async () => true)).status, 200);
  assert.equal(calls, 2); assert.deepEqual(waits, [10000]);
  const entries = (await ledger()).requests;
  assert.equal(entries[0].failure_code, 'stream_incomplete');
  assert.equal(entries[0].status, 'unknown'); assert(entries[0].reserved_nanos > 0);
  assert.equal(entries[1].status, 'known');
  assert.deepEqual(entries[1].resumed_unknown_requests, [entries[0].id]);
  assert.equal((await api('123', details, async () => true)).status, 200);
});

test('persistent early EOF is bounded and cancellation or insufficient budget prevents another dispatch', async t => {
  t.mock.method(timers, 'setTimeout', async () => {});
  let calls = 0;
  const { api, ledger } = await setup(t, async () => { calls++; return new Response(ended); });
  await assert.rejects(api('123', details, async () => true), /已自动补跑 2 次/);
  assert.equal(calls, 3); assert((await ledger()).requests.every(entry => entry.reserved_nanos > 0));
  await assert.rejects(api('123', details, async () => true), /上次请求费用未知/); assert.equal(calls, 3);
  for (const budgetLimited of [false, true]) {
    let active = true, sent = 0; const settings = { ...config };
    const task = await setup(t, async () => {
      sent++;
      if (budgetLimited) settings.budget = (await task.ledger()).requests[0].reserved_nanos * 1.5 / 1e9;
      else active = false;
      return new Response(ended);
    }, settings);
    await assert.rejects(task.api('123', details, async () => active), budgetLimited ? /预算不足/ : /费用未知/);
    assert.equal(sent, 1); assert((await task.ledger()).requests[0].reserved_nanos > 0);
  }
});

test('unmanaged EOF, invalid frames, non-stream responses and missing usage never auto-retry', async t => {
  t.mock.method(timers, 'setTimeout', async () => {});
  for (const [body, code, managed] of [[ended, 'stream_incomplete', false], ['data: {broken}\n\n', 'invalid_response', true], ['data: {"unexpected":true}\n\n', 'invalid_response', true], ['', 'invalid_response', true], ['not JSON', 'invalid_response', true], ['null', 'invalid_response', true], [JSON.stringify({ ...reply, usage: undefined }), 'invalid_usage', true]]) {
    let calls = 0;
    const { api, ledger } = await setup(t, async () => { calls++; return new Response(body); });
    await assert.rejects(api('123', details, managed ? async () => true : undefined), /费用未知/);
    assert.equal(calls, 1); assert.equal((await ledger()).requests[0].failure_code, code);
    assert(!JSON.stringify(await ledger()).includes(config.api_key));
  }
});

test('SSE event names identify final responses and incomplete final frames are never accepted', () => {
  assert.deepEqual(decodeResponse(`event: response.completed\ndata: ${JSON.stringify({ response: reply })}\n\n`), reply);
  assert.deepEqual(decodeResponse(`event: message\ndata: ${JSON.stringify({ type: 'response.completed', response: reply })}\n\n`), reply);
  assert.throws(() => decodeResponse(ended + `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: reply })}\n`), error => error.failureCode === 'stream_incomplete');
  assert.throws(() => decodeResponse('data: {"type":"response.completed"}\n\n'), error => error.failureCode === 'invalid_response');
  assert.throws(() => decodeResponse('event: response.completed\ndata: {"type":"response.created"}\n\n'), error => error.failureCode === 'invalid_response');
  assert.throws(() => decodeResponse('event: error\ndata: {"message":"private-provider-error"}\n\n'), error => error.failureCode === 'provider_error' && !error.message.includes('private-provider-error'));
});

test('real HTTP clean EOF recovers and a final event after an SSE id settles before the connection closes', async t => {
  t.mock.method(timers, 'setTimeout', async () => {});
  let calls = 0;
  const server = http.createServer((request, response) => {
    request.resume(); response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (++calls === 1) response.end(ended + 'data: {"type":"response.output_text.delta","delta":"partial');
    else response.write(`id: fixture-event\nevent: response.completed\ndata: ${JSON.stringify({ response: reply })}\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const { api, ledger } = await setup(t, (_url, options) => fetch('http://127.0.0.1:' + server.address().port, options));
  let deadline;
  try {
    const result = await Promise.race([api('123', details, async () => true), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('terminal SSE must settle before EOF')), 1500); })]);
    assert.equal(result.status, 200); assert.equal(calls, 2);
    assert.equal((await ledger()).requests[0].failure_code, 'stream_incomplete');
    assert.equal((await ledger()).requests[1].status, 'known');
  } finally { clearTimeout(deadline); }
});

test('CRLF split between transport chunks cannot turn a partial event into a completed frame', async t => {
  const event = JSON.stringify({ type: 'response.completed', response: reply }, null, 2).split('\n');
  const chunks = ['event: response.completed\r', '\ndata: ' + event[0] + '\r', '\n' + event.slice(1).map(line => 'data: ' + line).join('\r\n') + '\r\n\r\n'];
  const { api, ledger } = await setup(t, async () => new Response(new ReadableStream({
    pull(controller) { if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift())); else controller.close(); },
  })));
  assert.equal((await api('123', details)).status, 200);
  assert.equal((await ledger()).requests[0].status, 'known');
});
