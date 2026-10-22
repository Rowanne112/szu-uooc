import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConsole } from '../student/console-server.mjs';
import { appDir, session } from './console-fixtures.mjs';
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uooc-detect-console-'));
let calls = 0;
const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true, fetchImpl: async (url, options) => {
  calls++;
  if (url.endsWith('/models')) return Response.json({ data: [{ id: 'deepseek-flash' }] });
  const body = JSON.parse(options.body);
  return Response.json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: [{ index: 0, answers: [Array.isArray(body.messages[0].content) ? '3' : '2'] }] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
} });
try {
  const client = await session(app);
  assert.equal((await client.get()).config.base_url, 'https://api.daitu.cc/v1');
  const result = await client.post('/api/detect-save', { base_url: 'https://api.deepseek.com/chat/completions', api_key: 'fixture-secret', model: '' });
  assert.equal(result.connection.status, 'ok'); assert.equal(result.detection.model, 'deepseek-flash');
  assert.equal(calls, 3);
  const state = await client.get(); assert.equal(state.config.profile.verified_image, true);
  assert(!JSON.stringify(state).includes('fixture-secret'));
  await client.post('/api/detect-save', { base_url: 'https://other-service.test/v1', api_key: '' }, 400);
  assert.equal(calls, 3, 'changing service cannot forward a saved Key to the new address');
  const config = JSON.parse(await fs.readFile(path.join(dataDir, 'api.json')));
  assert.equal(config.api_key, 'fixture-secret'); assert.equal(config.wire_api, 'chat');
  await app.close();
  const reopened = await createConsole({ appDir, dataDir, checkDependencies: async () => true, fetchImpl: async () => { throw new Error('startup must not redetect'); } });
  try { assert.equal((await reopened.state()).config.model, 'deepseek-flash'); } finally { await reopened.close(); }
  config.detection.fingerprint = 'old-catalog-version';
  await fs.writeFile(path.join(dataDir, 'api.json'), JSON.stringify(config));
  const migrated = await createConsole({ appDir, dataDir, checkDependencies: async () => true, fetchImpl: async () => { throw new Error('migration must not make paid calls'); } });
  try { const state = await migrated.state(); assert.equal(state.config.hasKey, true); assert.equal(state.config.service_status, 'unchecked'); assert.equal(state.config.profile, undefined); }
  finally { await migrated.close(); }
} finally { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
