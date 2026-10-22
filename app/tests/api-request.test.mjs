import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAPI, validPrices, usageCost, decodeResponse } from '../api-request.mjs';

const pricing = { input_per_million: 1, cached_input_per_million: 0.1, output_per_million: 6 };
assert.equal(usageCost({ input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 100 }, pricing), 0.00088);
assert.throws(() => validPrices(null), /缺少/);
assert.throws(() => validPrices({ ...pricing, input_per_million: '' }), /缺少/);
assert.throws(() => usageCost({ input_tokens: 1, input_tokens_details: { cached_tokens: 2 }, output_tokens: 0 }, pricing), /usage/);
const reply = { model: 'gpt-6-luna', status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"answers":[]}' }] }], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 100 } };
assert.deepEqual(decodeResponse(`data: {"type":"response.created"}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: reply })}\n\ndata: [DONE]\n`), reply);
assert.throws(() => decodeResponse('data: {"type":"response.created"}\n'), /最终/);
const multiline = '\ufeffevent: response.completed\r\n' + JSON.stringify({ type: 'response.completed', response: reply }, null, 2).split('\n').map(line => 'data: ' + line).join('\r\n') + '\r\n\r\n';
assert.deepEqual(decodeResponse(multiline), reply, 'valid SSE data lines are combined per event');
assert.deepEqual(decodeResponse(`data: ${JSON.stringify({type:'response.completed',response:reply})}\n\ndata: {"type":"error"}\n\n`), reply, 'terminal usage must not be lost to trailing transport events');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-uooc-api-test-'));
try {
  const config = { base_url: 'https://example.test/v1', model: 'gpt-6-luna', api_key: 'private-test-key', reasoning_effort: 'medium', budget: 1, pricing };
  const details = { method: 'POST', url: 'https://example.test/v1/responses', data: JSON.stringify({ model: config.model, reasoning: { effort: 'medium' }, store: false, input: 'Question', max_output_tokens: 2048 }) };
  let calls = 0;
  const fakeFetch = async (url, options) => {
    calls++;
    assert.equal(url, details.url);
    assert.equal(options.headers.Authorization, 'Bearer private-test-key');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { model: config.model, reasoning: { effort: 'medium' }, store: false, input: 'Question', max_output_tokens: 2048, stream: true });
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: reply })}\n\n`, { status: 200 });
  };
  const api = createAPI(config, path.join(temp, 'good'), fakeFetch);
  const result = await api('123', details);
  assert.equal(result.status, 200);
  assert.equal(result.responseText.includes(config.api_key), false);
  const ledger = JSON.parse(await fs.readFile(path.join(temp, 'good/course-123.json'), 'utf8'));
  assert.equal(ledger.requests[0].cost_usd, 0.00088);
  assert.equal(ledger.requests[0].status, 'known');
  assert.equal(JSON.stringify(ledger).includes(config.api_key), false);
  await assert.rejects(() => api('123', { ...details, url: 'https://other.test/v1/responses' }), /只代理/);
  await assert.rejects(() => api('123', { ...details, data: details.data.replace('gpt-6-luna', 'gpt-5.5') }), /不符合/);
  assert.equal(calls, 1);
  await assert.rejects(() => createAPI({ ...config, pricing: null }, path.join(temp, 'no-price'), fakeFetch)('123', details), /缺少/);
  assert.equal(calls, 1);
  await assert.rejects(() => createAPI({ ...config, budget: 0.00001 }, path.join(temp, 'budget'), fakeFetch)('123', details), /预算不足/);
  assert.equal(calls, 1);
  await assert.rejects(() => createAPI({ ...config, budget: 0.02, pricing: { ...pricing, cached_input_per_million: 100 } }, path.join(temp, 'expensive-cache'), fakeFetch)('123', details), /预算不足/);
  assert.equal(calls, 1, 'reservation uses the higher of cached and uncached input prices');

  let streamCancelled = false;
  const keptOpen = createAPI(config, path.join(temp, 'kept-open'), async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(multiline)); },
    cancel() { streamCancelled = true; },
  }), { headers: {'Content-Type':'text/event-stream'} }));
  let deadline;
  try { const streamed = await Promise.race([keptOpen('124', details), new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('terminal event must settle without waiting for EOF')),1000)})]); assert.equal(streamed.status,200); }
  finally { clearTimeout(deadline); }
  assert.equal(streamCancelled, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(temp,'kept-open/course-124.json'),'utf8')).requests[0].status,'known');

  let unknownCalls = 0;
  const unknown = createAPI(config, path.join(temp, 'unknown'), async () => {
    unknownCalls++;
    return new Response('{"error":{"type":"model_not_found"}}', { status: 404 });
  });
  await assert.rejects(() => unknown('123', details), /费用未知/);
  await assert.rejects(() => unknown('123', details), /上次请求费用未知/);
  assert.equal(unknownCalls, 1, 'unknown charges do not get automatically retried');
  const unknownLedger = JSON.parse(await fs.readFile(path.join(temp, 'unknown/course-123.json'), 'utf8'));
  assert.equal(unknownLedger.requests[0].status, 'unknown');
  assert.ok(unknownLedger.requests[0].reserved_nanos > 0);

  let gatewayCalls = 0;
  const gateway = createAPI(config, path.join(temp, 'gateway'), async () => {
    gatewayCalls++;
    return new Response('Bad Gateway', { status: 502 });
  });
  await assert.rejects(() => gateway('123', details), /HTTP 502/);
  const gatewayBefore = await fs.readFile(path.join(temp, 'gateway/course-123.json'), 'utf8');
  await assert.rejects(() => gateway('123', details), /上次请求费用未知.*HTTP 502.*核对服务商账单/);
  assert.equal(gatewayCalls, 1, 'report the original service failure without sending a second paid request');
  assert.equal(await fs.readFile(path.join(temp, 'gateway/course-123.json'), 'utf8'), gatewayBefore);

  let limitedCalls = 0;
  const rateLimited = createAPI(config, path.join(temp, 'rate-limit'), async () => {
    limitedCalls++;
    return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'Too many concurrent requests ' + config.api_key + ' Bearer other-private-token sk-other-secret' } }), { status: 429, headers: { 'Retry-After': '60' } });
  });
  await assert.rejects(() => rateLimited('123', details), (error) => /HTTP 429/.test(error.message) && !error.message.includes(config.api_key));
  const rateLedger = JSON.parse(await fs.readFile(path.join(temp, 'rate-limit/course-123.json'), 'utf8'));
  assert.equal(rateLedger.requests[0].status, 'unknown');
  assert.equal(rateLedger.requests[0].http_status, 429);
  assert.ok(rateLedger.requests[0].reserved_nanos > 0, '429 with missing usage retains its reservation');
  assert.equal(rateLedger.requests[0].provider_error.reason, '并发限制');
  assert.equal(rateLedger.requests[0].retry_after_seconds, 60);
  assert.equal(JSON.stringify(rateLedger).includes(config.api_key), false);
  assert.equal(JSON.stringify(rateLedger).includes('other-private-token'), false);
  assert.equal(JSON.stringify(rateLedger).includes('sk-other-secret'), false);
  assert.equal(limitedCalls, 1, 'a 429 never automatically retries');
  await assert.rejects(() => rateLimited('123', details), /上次请求费用未知/);
  assert.equal(limitedCalls, 1, 'a previous unknown 429 requires an explicit recovery');
  await rateLimited.prepareResume('123');
  await assert.rejects(() => rateLimited('123', details), /HTTP 429/);
  const retriedLedger = JSON.parse(await fs.readFile(path.join(temp, 'rate-limit/course-123.json'), 'utf8'));
  assert.equal(retriedLedger.requests.length, 2, 'an explicit retry retains both unknown charges');
  const smallerBudget = { ...config, budget: rateLedger.requests[0].reserved_nanos * 2.5 / 1e9 };
  await assert.rejects(() => createAPI(smallerBudget, path.join(temp, 'rate-limit'), fakeFetch)('123', details), /预算不足/);
  assert.equal(calls, 1, 'unknown 429 reservations count against the budget before another request');

  for (const [label, message] of [['parameter', 'Unsupported parameter: max_tool_calls'], ['tool', 'Unsupported tool type: computer']]) {
    let validationCalls = 0;
    const validationDir = path.join(temp, 'rejected-' + label);
    const rejectedParameter = createAPI(config, validationDir, async () => {
      validationCalls++;
      return validationCalls === 1
        ? new Response(JSON.stringify({ error: { type: 'invalid_request_error', message } }), { status: 400 })
        : new Response(JSON.stringify(reply), { status: 200 });
    });
    await assert.rejects(() => rejectedParameter('123', details), /HTTP 400/);
    assert.equal(validationCalls, 1, 'a rejected parameter never automatically retries');
    const validationLedger = JSON.parse(await fs.readFile(path.join(validationDir, 'course-123.json'), 'utf8'));
    const validationBudget = { ...config, budget: validationLedger.requests[0].reserved_nanos * 1.5 / 1e9 };
    await assert.rejects(() => createAPI(validationBudget, validationDir, fakeFetch)('123', details), /预算不足/);
    assert.equal(calls, 1, 'the full rejected-request reservation reduces the budget for a corrected request');
    await assert.rejects(rejectedParameter('123', details), /上次请求费用未知/);
    await rejectedParameter.prepareResume('123');
    assert.equal((await rejectedParameter('123', details)).status, 200);
    const correctedLedger = JSON.parse(await fs.readFile(path.join(validationDir, 'course-123.json'), 'utf8'));
    assert.equal(correctedLedger.requests[0].status, 'unknown');
    assert.equal(correctedLedger.requests[0].reserved_nanos, validationLedger.requests[0].reserved_nanos, 'a corrected request does not erase the rejected request or assign it zero cost');
    assert.equal(correctedLedger.requests[1].status, 'known');
  }

  let otherBadCalls = 0;
  const otherBadRequest = createAPI(config, path.join(temp, 'other-bad-request'), async () => {
    otherBadCalls++;
    return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Unknown upstream failure' } }), { status: 400 });
  });
  await assert.rejects(() => otherBadRequest('123', details), /HTTP 400/);
  await assert.rejects(() => otherBadRequest('123', details), /上次请求费用未知/);
  assert.equal(otherBadCalls, 1, 'other unknown 400 responses still require reconciliation');

  const sharedDir=path.join(temp,'shared-workers');let activeCalls=0,maxCalls=0,providerCalls=0;
  const sharedFetch=async()=>{providerCalls++;activeCalls++;maxCalls=Math.max(maxCalls,activeCalls);await new Promise(resolve=>setTimeout(resolve,15));activeCalls--;return new Response(JSON.stringify(reply));};
  const workerA=createAPI(config,sharedDir,sharedFetch),workerB=createAPI(config,sharedDir,sharedFetch);
  await Promise.all([workerA('111',details),workerB('222',details)]);assert.equal(maxCalls,2,'different courses must not wait for each other');assert.equal(providerCalls,2);
  maxCalls=0;await Promise.all([workerA('111',details),workerB('111',details)]);assert.equal(maxCalls,1,'the same course ledger remains serialized across controllers');
  let release,started;const gate=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>started=resolve);let cancellationCalls=0;
  const cancellationFetch=async()=>{cancellationCalls++;started();await gate;return new Response(JSON.stringify(reply));};
  const cancellationDir=path.join(temp,'cancelled-queue');const first=createAPI(config,cancellationDir,cancellationFetch),second=createAPI(config,cancellationDir,cancellationFetch);
  const inFlight=first('333',details);await seen;let allowed=true;const queued=second('333',details,()=>allowed);allowed=false;release();
  await inFlight;await assert.rejects(queued,error=>error.notSent===true);assert.equal(cancellationCalls,1);assert.equal(JSON.parse(await fs.readFile(path.join(cancellationDir,'course-333.json'),'utf8')).requests.length,1,'cancelled queued requests never add a reservation');
  let truncatedCalls=0;const truncatedDir=path.join(temp,'truncated');const truncated=createAPI(config,truncatedDir,async()=>{truncatedCalls++;return new Response('data: {"type":"response.created"}\n\n');});
  await assert.rejects(()=>truncated('555',details),/费用未知/);const truncatedLedger=JSON.parse(await fs.readFile(path.join(truncatedDir,'course-555.json'),'utf8'));
  assert.equal(truncatedLedger.requests[0].failure_stage,'decoding');assert(truncatedLedger.requests[0].response_bytes>0);await assert.rejects(()=>truncated('555',details),/上次请求费用未知/);assert.equal(truncatedCalls,1);

  let parallelCalls = 0;
  const cheap = { input_per_million: 1, cached_input_per_million: 0, output_per_million: 1 };
  const parallel = createAPI({ ...config, budget: 0.017, pricing: cheap }, path.join(temp, 'parallel'), async () => {
    parallelCalls++;
    return new Response(JSON.stringify({ ...reply, usage: { input_tokens: 768, output_tokens: 32 } }), { status: 200 });
  });
  const short = { ...details, data: JSON.stringify({ ...JSON.parse(details.data), max_output_tokens: 32 }) };
  const results = await Promise.allSettled([parallel('123', short), parallel('123', short)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(parallelCalls, 1, 'budget includes preceding concurrent requests');
  console.log('API transport self-check passed: pricing, usage/cache, budget, model, credential isolation, SSE, unknown charge, concurrency. No network requests.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
