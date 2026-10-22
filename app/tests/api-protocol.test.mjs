import assert from 'node:assert/strict';
import { normalizeServiceURL, candidateModels, wireRequest, normalizeResponse, inspectInput, parseAnswerJSON, serviceFingerprint, serviceProblem } from '../api-protocol.mjs';

for (const value of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/responses', 'https://api.deepseek.com/v1/chat/completions', 'https://api.deepseek.com/v1/models/']) assert.equal(normalizeServiceURL(value), 'https://api.deepseek.com/v1');
assert.equal(normalizeServiceURL('https://example.test/prefix/v1/chat/completions'), 'https://example.test/prefix/v1');
for (const value of ['http://example.test', 'https://key@example.test', 'https://example.test?key=secret']) assert.throws(() => normalizeServiceURL(value));
const list = [{ id: 'deepseek-flash' }, { id: 'embed-x' }, { id: 'deepseek-v4-pro' }];
const official = candidateModels('https://api.deepseek.com', list);
assert.deepEqual(official.map(m => m.id), ['deepseek-flash', 'deepseek-v4-pro']);
assert.equal(official[0].verified_image, false);
assert.equal(official[0].pricing.output_per_million, 1.2);
assert.equal(candidateModels('https://relay.test/v1', list)[0].pricing, null, 'relay names never inherit official prices');
assert.equal(candidateModels('https://api.openai.com/v1', [{ id: 'gpt-6.1-sol' }])[0].reasoning_effort, 'low', 'Sol does not support none reasoning');
assert.notEqual(serviceFingerprint('https://relay.test/v1', 'a'), serviceFingerprint('https://relay.test/v1', 'b'));
const payload = { model: 'deepseek-flash', input: 'question', max_output_tokens: 128 };
const wire = wireRequest(payload, official[0]);
assert.equal(wire.max_tokens, 128); assert.equal(wire.reasoning, undefined); assert.equal(wire.store, undefined); assert.equal(wire.thinking.type, 'disabled');
assert.deepEqual(inspectInput('题目'), { textBytes: 6, images: 0 });
assert.throws(() => inspectInput([{ role: 'user', content: [{ type: 'input_image', image_url: 'https://image.test/q.png' }] }]), /不完整/);
const normalized = normalizeResponse({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop', message: { content: '{"answers":[]}' } }], usage: { prompt_tokens: 20, prompt_cache_hit_tokens: 10, completion_tokens: 2 } });
assert.equal(normalized.usage.input_tokens_details.cached_tokens, 10);
assert.equal(normalized.output[0].content[0].text, '{"answers":[]}');
assert.equal(normalizeResponse({ choices: [{ finish_reason: 'length' }] }).status, 'incomplete');
assert.deepEqual(parseAnswerJSON('```json\n{"answers":[]}\n```'), { answers: [] });
assert.throws(() => parseAnswerJSON('答案是 A'), /格式/);
assert.match(serviceProblem(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }), /后台检查余额/);
assert.match(serviceProblem(429, { error: { type: 'rate_limit_error', message: 'Too many requests' } }), /繁忙/);
const jpegHeader = Buffer.from([255,216,255,192,0,17,8,0,32,0,96,3,1,0,2,0,3,0,0,0,0]);
const webpHeader = Buffer.alloc(30); webpHeader.write('RIFF', 0); webpHeader.write('WEBPVP8X', 8); webpHeader[24] = 95; webpHeader[27] = 31;
for (const [format, bytes] of [['jpeg', jpegHeader], ['webp', webpHeader]]) {
  assert.deepEqual(inspectInput([{ role: 'user', content: [{ type: 'input_text', text: 'q' }, { type: 'input_image', image_url: `data:image/${format};base64,${bytes.toString('base64')}` }] }]), { textBytes: 1, images: 1 }, `${format} dimensions are read before reserving image fees`);
}
