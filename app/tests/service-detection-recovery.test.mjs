import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectService } from '../student/service-detection.mjs';

const base = 'https://fixture.invalid/v1', key = 'fixture-detection-key';
const model = { id: 'fixture-model', pricing: { currency: 'USD', scope: 'key', input_per_million: .01, cached_input_per_million: .01, output_per_million: .01 } };
const success = () => Response.json({ model: model.id, status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"answers":[{"index":0,"answers":["2"]}]}' }] }], usage: { input_tokens: 10, output_tokens: 10 } });
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-detect-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'ledger'));
  const course = path.join(dir, 'ledger/course-123.json');
  const bytes = JSON.stringify({ courseId: '123', model: model.id, requests: [{ id: 'old-course', status: 'unknown', reserved_nanos: 1000000 }] });
  await fs.writeFile(course, bytes);
  return { dir, course, bytes };
}

test('a protocol fallback approves only this detection run and retains the failed probe reservation', async t => {
  const { dir, course, bytes } = await setup(t), paid = [];
  const result = await detectService({ base_url: base, api_key: key, dataDir: dir, fetchImpl: async url => {
    if (url.endsWith('/models')) return Response.json({ data: [model] });
    paid.push(url);
    return paid.length === 1 ? Response.json({ error: { message: 'unsupported endpoint' } }, { status: 404 }) : success();
  } });
  assert.equal(result.status, 'ready'); assert.equal(result.testCosts.unknown, true);
  assert.deepEqual(paid, [base + '/chat/completions', base + '/responses']);
  const filename = (await fs.readdir(path.join(dir, 'detection-ledger'))).find(name => /^course-\d+\.json$/.test(name));
  const book = JSON.parse(await fs.readFile(path.join(dir, 'detection-ledger', filename), 'utf8'));
  assert.equal(book.requests[0].status, 'unknown'); assert(book.requests[0].reserved_nanos > 0);
  assert.equal(book.recoveries[0].mode, 'detection'); assert.deepEqual(book.recoveries[0].request_ids, [book.requests[0].id]);
  assert.equal(await fs.readFile(course, 'utf8'), bytes, 'successful detection cannot approve course charges');
});

test('an unmetered provider failure never permits automatic candidate retries during detection', async t => {
  const { dir, course, bytes } = await setup(t); let paid = 0;
  const result = await detectService({ base_url: base, api_key: key, dataDir: dir, fetchImpl: async url => {
    if (url.endsWith('/models')) return Response.json({ data: [model, { ...model, id: 'second-model' }] });
    paid++; return Response.json({ error: { message: 'provider failure' } }, { status: 500 });
  } });
  assert.equal(result.status, 'blocked'); assert.equal(paid, 1);
  const filename = (await fs.readdir(path.join(dir, 'detection-ledger'))).find(name => /^course-\d+\.json$/.test(name));
  const book = JSON.parse(await fs.readFile(path.join(dir, 'detection-ledger', filename), 'utf8'));
  assert.equal(book.recoveries, undefined); assert(book.requests[0].reserved_nanos > 0);
  assert.equal(await fs.readFile(course, 'utf8'), bytes);
});
