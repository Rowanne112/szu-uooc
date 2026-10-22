import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAPI } from '../api-request.mjs';
import { testImage } from '../student/service-detection.mjs';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uooc-api-images-'));
const pricing = { input_per_million: .3, cached_input_per_million: .006, output_per_million: 1.2 };
const profile = { id: 'text-model', wire_api: 'chat', pricing, verified_text: true, verified_image: false };
const image_profile = { ...profile, id: 'image-model', verified_image: true, image_tokens: 1024 };
const config = { base_url: 'https://fixture.invalid/v1', model: profile.id, api_key: 'fixture-secret', budget: 1, profile, image_profile };
const details = { method: 'POST', url: config.base_url + '/responses', data: JSON.stringify({ model: profile.id, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: '题号0题干' }, { type: 'input_image', image_url: testImage }] }], max_output_tokens: 128 }) };
try {
  let calls = 0;
  const fake = async (url, options) => {
    calls++; const body = JSON.parse(options.body);
    assert.equal(url, config.base_url + '/chat/completions'); assert.equal(body.model, 'image-model');
    assert.equal(body.messages[0].content[1].image_url.url, testImage);
    assert.equal(body.reasoning, undefined); assert.equal(body.max_output_tokens, undefined);
    return Response.json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: '{"answers":[]}' } }], usage: { prompt_tokens: 1024, prompt_cache_hit_tokens: 24, completion_tokens: 2 } });
  };
  const response = await createAPI(config, dir, fake)('123', details);
  const data = JSON.parse(response.responseText);
  assert.equal(data.local_billing.model, 'image-model'); assert.equal(data.usage.input_tokens, 1024);
  const ledger = JSON.parse(await fs.readFile(path.join(dir, 'course-123.json')));
  assert.equal(ledger.requests[0].model, 'image-model'); assert.equal(ledger.requests[0].images, 1);
  assert.equal(ledger.requests[0].input_bound, 17421);
  await assert.rejects(createAPI({ ...config, image_profile: null }, dir, fake)('123', details), /图片题不可用/);
  await assert.rejects(createAPI({ ...config, budget: .00001 }, dir, fake)('123', details), /预算不足/);
  const oversized = Buffer.from(testImage.split(',')[1], 'base64'); oversized.writeUInt32BE(10000, 16);
  const large = JSON.parse(details.data); large.input[0].content[1].image_url = 'data:image/png;base64,' + oversized.toString('base64');
  await assert.rejects(createAPI(config, dir, fake)('123', { ...details, data: JSON.stringify(large) }), /2048像素/);
  assert.equal(calls, 1, 'unavailable vision and insufficient budget do not send requests');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
