import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { detectService } = await import(process.env.DETECTOR_UNDER_TEST || '../student/service-detection.mjs');

test('detection accepts a response arriving after 30 seconds within a 120-second deadline', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uooc-detect-slow-'));
  const deadlines = [], timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    deadlines.push(milliseconds);
    return timeout(milliseconds);
  });
  let paidCalls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'timeout-fixture', supported_endpoints: ['responses'],
        pricing: { currency: 'USD', scope: 'key', input_per_million: .001, cached_input_per_million: .0001, output_per_million: .001 } }] }));
      return;
    }
    paidCalls++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': hi\n\n');
    const timer = setTimeout(() => res.end('event: response.completed\ndata: ' + JSON.stringify({
      type: 'response.completed', response: { model: 'timeout-fixture', status: 'completed',
        output: [{ content: [{ type: 'output_text', text: '{"answers":[{"index":0,"answers":["2"]}]}' }] }],
        usage: { input_tokens: 100, output_tokens: 20 } },
    }) + '\n\n'), 31000);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const started = Date.now();
  const result = await detectService({ base_url: 'https://timeout.test/v1', api_key: 'fixture-only', dataDir,
    fetchImpl: (url, options) => fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options) });
  assert.equal(result.status, 'ready', result.message);
  assert.ok(Date.now() - started >= 31000, 'the final response really arrives beyond the old deadline');
  assert.deepEqual(deadlines, [12000, 120000], 'catalogue timeout stays short; paid detection stays bounded');
  assert.equal(result.profile.verified_text, true);
  assert.equal(paidCalls, 1, 'waiting must not dispatch a duplicate paid request');
  assert.equal(result.testCosts.unknown, false);
  assert.ok(result.testCosts.estimated_usd > 0 && result.testCosts.estimated_usd <= .02);
  const files = (await fs.readdir(path.join(dataDir, 'detection-ledger'))).filter(file => /^course-\d+\.json$/.test(file));
  const ledger = JSON.parse(await fs.readFile(path.join(dataDir, 'detection-ledger', files[0]), 'utf8'));
  assert.equal(ledger.requests.length, 1);
  assert.equal(ledger.requests[0].status, 'known');
  assert.equal(ledger.requests[0].reserved_nanos, 0);
});
