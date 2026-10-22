import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { detectService, testImage } from '../student/service-detection.mjs';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uooc-detect-'));
const key = 'fixture-private-key';
let calls = [];
const fake = async (url, options) => {
  calls.push({ url, body: options.body && JSON.parse(options.body) });
  if (url.endsWith('/models')) return Response.json({ data: [{ id: 'embedding-1' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] });
  assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
  const body = JSON.parse(options.body);
  assert.equal(body.reasoning, undefined);
  const image = Array.isArray(body.messages[0].content);
  if (image) assert.equal(body.messages[0].content[1].image_url.url, testImage);
  return Response.json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: [{ index: 0, answers: [image ? '3' : '2'] }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 20 } });
};
try {
  const png = Buffer.from(testImage.split(',')[1], 'base64');
  const size = png.readUInt32BE(33); const pixels = inflateSync(png.subarray(41, 41 + size));
  assert.equal(pixels.length, (96 * 3 + 1) * 32, 'valid standalone test image');
  const result = await detectService({ base_url: 'https://api.deepseek.com/v1/chat/completions', api_key: key, dataDir: dir, fetchImpl: fake });
  assert.equal(result.model, 'deepseek-flash'); assert.equal(result.profile.verified_image, true);
  assert.equal(result.models.some(m => m.id.startsWith('embedding')), false);
  assert.equal(result.models.find(m => m.id === 'deepseek-v4-pro').status, 'unverified');
  assert.equal(result.testCosts.calls, 2); assert.equal(calls.length, 3);
  const cached = await detectService({ base_url: result.base_url, api_key: key, model: result.model, dataDir: dir, fetchImpl: fake });
  assert.equal(cached.cached, true); assert.equal(calls.length, 3, 'repeat detection uses cache');
  await detectService({ base_url: result.base_url, api_key: 'new-key', dataDir: dir, fetchImpl: fake });
  assert.equal(calls.length, 6, 'changing Key invalidates cache');
  const cache = await fs.readFile(path.join(dir, 'service-detection.json'), 'utf8');
  assert(!cache.includes(key)); assert(!cache.includes('new-key'));
  const unknown = await detectService({ base_url: 'https://relay.test/v1', api_key: key, dataDir: dir, fetchImpl: async url => { assert(url.endsWith('/models')); return Response.json({ data: [{ id: 'gpt-6-luna' }] }); } });
  assert.equal(unknown.status, 'blocked'); assert.equal(unknown.testCosts.calls, 0); assert.equal(unknown.models[0].pricing, null);
  await assert.rejects(detectService({ base_url: 'https://api.deepseek.com', api_key: key, dataDir: dir, fetchImpl: async () => Response.json({ error: { message: 'bad key ' + key } }, { status: 401 }) }), /Key 无效/);
  let paid = 0;
  const bounded = await detectService({ base_url: 'https://relay.test/v1', api_key: key, dataDir: dir, fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: Array.from({ length: 20 }, (_, i) => ({ id: 'candidate-' + i, input_modalities: ['text', 'image'], max_image_tokens: 100,
      pricing: { currency: 'USD', scope: 'key', input_per_million: .001, cached_input_per_million: .001, output_per_million: .001, debug_secret: key } })) });
    paid++; const body = JSON.parse(options.body);
    return Response.json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: [{ index: 0, answers: [Array.isArray(body.messages[0].content) ? '1' : '2'] }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  } });
  assert.equal(paid, 6, 'at most three candidates and six calls, including failed image answer checks');
  assert.equal(bounded.models.filter(m => m.verified_text).length, 3);
  assert.equal(bounded.image_profile, null, 'wrong image answer never becomes a verified vision model');
  assert(!(await fs.readFile(path.join(dir, 'service-detection.json'), 'utf8')).includes(key), 'provider pricing metadata cannot echo secrets into the cache');
  await assert.rejects(detectService({ base_url: 'https://relay.test/' + key, api_key: key, dataDir: dir, fetchImpl: fake }), /网址中不能包含 Key/);
} finally { await fs.rm(dir, { recursive: true, force: true }); }
