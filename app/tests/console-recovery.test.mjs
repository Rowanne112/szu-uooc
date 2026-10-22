import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConsole } from '../student/console-server.mjs';
import { appDir, courseURL, fixtureWorker, session } from './console-fixtures.mjs';
import { explainProblem } from '../student/user-guidance.mjs';

test('manual recovery guidance preserves checkpoints and identifies exhausted retries', () => {
  assert.match(explainProblem('课程断点读取失败，已保留原记录'), /保留断点和费用记录/);
  assert.match(explainProblem('页面自动恢复次数已达上限'), /学习已暂停.*页面恢复后点「继续」/);
  assert.match(explainProblem('这门课程已有控制器运行，请先停止原任务'), /原窗口.*避免重复执行/);
});

test('a temporary checkpoint write failure does not poison subsequent saves', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-console-save-recovery-'));
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true });
  t.after(async () => { try { await app.close(); } finally { app.server.closeAllConnections(); app.server.close(); await fs.rm(dataDir, { recursive: true, force: true }); } });
  const client = await session(app), blocked = path.join(dataDir, 'courses.json.tmp');
  await fs.mkdir(blocked);
  await client.post('/api/courses', { url: courseURL('123') }, 400);
  await fs.rmdir(blocked);
  await client.post('/api/courses', { url: courseURL('456') });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'courses.json'), 'utf8')).courses.map(c => c.id), ['123', '456']);
});

test('recovery reasons survive console restart with credentials removed and bounded history', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-console-log-recovery-')), children = [];
  let app;
  t.after(async () => { await app?.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  app = await createConsole({ appDir, dataDir, checkDependencies: async () => true, spawnController: fixtureWorker(children) });
  const client = await session(app);
  await client.post('/api/config', { api_key: 'recovery-fixture-secret' });
  await client.post('/api/courses', { url: courseURL('123') });
  await client.post('/api/course-action', { id: '123', action: 'start' });
  for (let i = 0; i < 115; i++) children[0].stdout.write('恢复：第' + i + '次，recovery-fixture-secret\n');
  children[0].stdout.write('恢复成功：task=500 attempt=2\n');
  await client.post('/api/course-action', { id: '123', action: 'stop' });
  await app.close();
  const raw = await fs.readFile(path.join(dataDir, 'recovery-log.json'), 'utf8');
  assert(!raw.includes('recovery-fixture-secret'));
  assert(JSON.parse(raw).length <= 100);
  app = await createConsole({ appDir, dataDir, checkDependencies: async () => true });
  assert((await app.state()).logs.some(entry => entry.message.includes('恢复成功：task=500 attempt=2')));
});
