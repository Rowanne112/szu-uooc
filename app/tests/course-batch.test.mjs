import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConsole } from '../student/console-server.mjs';
import { appDir, courseURL, fixtureWorker, session } from './console-fixtures.mjs';

async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-batch-')), children = [];
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true, spawnController: fixtureWorker(children) });
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const client = await session(app); await client.post('/api/config', { api_key: 'batch-fixture-private-key' });
  for (const id of ['123', '456']) await client.post('/api/courses', { url: courseURL(id), name: `课程 ${id}` });
  return { app, client, children };
}
test('only one whole course runs at a time; a paused course must be stopped before switching', async t => {
  const { client, children } = await setup(t);
  await client.post('/api/queue', { action: 'start' }, 400);
  assert.equal(children.length, 0, 'reject a batch before starting any course');
  const starts = await Promise.allSettled(['123', '456'].map(id => client.post('/api/course-action', { id, action: 'start' })));
  assert.equal(starts.filter(result => result.status === 'fulfilled').length, 1, 'simultaneous requests cannot start two courses');
  assert.equal(children.length, 1);
  const first = children[0].id, next = first === '123' ? '456' : '123';
  await client.post('/api/course-action', { id: first, action: 'pause' });
  await client.post('/api/course-action', { id: next, action: 'start' }, 400);
  await client.post('/api/course-action', { id: first, action: 'stop' });
  await client.post('/api/course-action', { id: next, action: 'start' });
  assert.deepEqual((await client.get()).activeIds, [next]);
  Object.assign(children[1].state, { phase: 'complete', active: false, completed: 20 }); children[1].report(); children[1].emit('exit', 0, null);
  await client.post('/api/course-action', { id: first, action: 'start' });
  assert.deepEqual((await client.get()).activeIds, [first], 'completion releases the single course slot');
});
test('failed start can be retried for the same course', async t => {
  const { client, children } = await setup(t);
  await client.post('/api/course-action', { id: '123', action: 'start' });
  children[0].emit('exit', 1, null);
  assert.equal((await client.get()).courses[0].status, 'error');
  await client.post('/api/queue', { action: 'start', ids: ['123'] });
  assert.equal(children.length, 2, 'failed courses must be eligible to start again');
  assert.equal(children[1].id, '123');
});
