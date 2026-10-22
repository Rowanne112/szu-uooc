import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAPI } from '../api-request.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uooc-auth-'));
const config = { base_url: 'https://fixture.invalid/v1', model: 'gpt-6-luna', api_key: 'fixture-key', budget: 1, pricing: { input_per_million: .1, cached_input_per_million: .01, output_per_million: .5 } };
const details = { method: 'POST', url: config.base_url + '/responses', data: JSON.stringify({ model: config.model, store: false, reasoning: { effort: 'medium' }, input: 'question', max_output_tokens: 128 }) };
try {
  let calls = 0;
  const api = createAPI(config, dir, async () => {
    calls++;
    return calls === 1 ? new Response('{"error":{"code":"invalid_api_key","message":"Invalid API key"}}', { status: 401 }) : Response.json({ model: config.model, output: [{ content: [{ type: 'output_text', text: '{}' }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  await assert.rejects(api('123', details, async () => true), /Key.*无效/);
  assert.equal(calls, 1, 'authentication failure never retries automatically');
  const before = JSON.parse(await fs.readFile(path.join(dir, 'course-123.json')));
  assert.ok(before.requests[0].reserved_nanos > 0, 'unreported cost retains reservation');
  const corrected = createAPI({ ...config, api_key: 'corrected-key' }, dir, async () => {
    calls++;
    return Response.json({ model: config.model, output: [{ content: [{ type: 'output_text', text: '{}' }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  });
  await assert.rejects(corrected('123', details), /上次请求费用未知/);
  assert.equal(calls, 1, 'changing credentials cannot approve a previous unknown charge');
  await corrected.prepareResume('123');
  const result = await corrected('123', details);
  assert.equal(result.status, 200, 'corrected credentials can resume past a previous 401');
  const after = JSON.parse(await fs.readFile(path.join(dir, 'course-123.json')));
  assert.equal(after.requests[0].reserved_nanos, before.requests[0].reserved_nanos, 'do not erase old charges');
  assert.equal(after.requests.length, 2);
  assert.equal(calls, 2);
} finally { await fs.rm(dir, { recursive: true, force: true }); }
