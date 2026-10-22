import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createConsole } from '../student/console-server.mjs';
import { saveJSON, defaults } from '../student/settings.mjs';
import { appDir, courseURL, session, fixtureWorker } from './console-fixtures.mjs';

test('an unconnected browser selection can be changed back after restart without connecting it', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-browser-reselect-'));
  await saveJSON(path.join(dataDir, 'browser.json'), { kind: 'edge', needsCourseRefresh: true });
  await saveJSON(path.join(dataDir, 'api.json'), { ...defaults, answer_mode: 'free', api_key: '' });
  await saveJSON(path.join(dataDir, 'courses.json'), { courses: [{ id: '123', url: courseURL('123'), status: 'stopped' }] });
  let connections = 0, app;
  const options = { appDir, dataDir, checkDependencies: async () => true,
    browserOptions: { connectBrowser: async () => { connections++; throw new Error('Edge is unavailable'); } },
    checkinOptions: { autoTick: false } };
  t.after(async () => { await app?.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  app = await createConsole(options);
  let client = await session(app);
  await client.post('/api/browser-connect', {}, 400);
  await client.post('/api/browser-select', { kind: 'chrome', sameAccount: true });
  assert.equal(connections, 1);
  let state = await client.get();
  assert.equal(state.browser.kind, 'chrome'); assert.equal(state.browser.needsCourseRefresh, true);
  assert.equal(state.courses[0].id, '123');
  const blocked = await client.post('/api/course-action', { id: '123', action: 'start' }, 400);
  assert.match(blocked.error, /重新读取课程/);
  await app.close(); app = await createConsole(options); client = await session(app);
  assert.equal((await client.get()).browser.kind, 'chrome');
  await client.post('/api/browser-select', { kind: 'edge', sameAccount: true });
  assert.equal(connections, 1);
});

test('a damaged signup configuration pauses signup without preventing the console from opening', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-damaged-checkin-'));
  await fs.writeFile(path.join(dataDir, 'checkin.json'), '{bad json');
  let app;
  t.after(async () => { await app?.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  app = await createConsole({ appDir, dataDir, checkDependencies: async () => true, checkinOptions: { autoTick: false } });
  const client = await session(app), state = await client.get();
  assert.match(state.checkin.error, /签到配置或记录不可读/);
  assert.equal(state.browser.kind, 'chrome');
});

test('reselection still checks submissions in a connected browser before course refresh', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-connected-submission-'));
  await saveJSON(path.join(dataDir, 'browser.json'), { kind: 'edge', needsCourseRefresh: true });
  await saveJSON(path.join(dataDir, 'courses.json'), { courses: [{ id: '123', url: courseURL('123'), status: 'stopped' }] });
  const owner = new EventEmitter(); owner.isConnected = () => true; owner.close = async () => {};
  owner.contexts = () => [{ pages: () => [{ url: () => 'https://www.uooc.net.cn/home/index', evaluate: async () => ['123'] }] }];
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true,
    browserOptions: { connectBrowser: async () => owner }, checkinOptions: { autoTick: false } });
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const client = await session(app);
  await client.post('/api/browser-connect');
  const result = await client.post('/api/browser-select', { kind: 'chrome', sameAccount: true }, 400);
  assert.match(result.error, /交卷.*123/); assert.equal((await client.get()).browser.kind, 'edge');
  const confirmed = await client.post('/api/browser-select', { kind: 'chrome', sameAccount: true, submissionConfirmed: true }, 400);
  assert.match(confirmed.error, /交卷.*123/); assert.notEqual(confirmed.requiresSubmissionConfirmation, true);
});

test('an offline previously used browser can be changed after explicit submission confirmation', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-disconnected-submission-'));
  await saveJSON(path.join(dataDir, 'browser.json'), { kind: 'edge', needsCourseRefresh: false });
  await saveJSON(path.join(dataDir, 'courses.json'), { courses: [{ id: '123', url: courseURL('123'), status: 'stopped' }] });
  let connections = 0;
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true,
    browserOptions: { connectBrowser: async () => { connections++; throw new Error('Edge is unavailable'); } }, checkinOptions: { autoTick: false } });
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const client = await session(app);
  const result = await client.post('/api/browser-select', { kind: 'chrome', sameAccount: true }, 400);
  assert.equal(result.requiresSubmissionConfirmation, true);
  assert.match(result.error, /核对.*测验/); assert.equal((await client.get()).browser.kind, 'edge');
  await client.post('/api/browser-select', { kind: 'chrome', sameAccount: true, submissionConfirmed: 'true' }, 400);
  await client.post('/api/browser-select', { kind: 'chrome', sameAccount: true, submissionConfirmed: true });
  const state = await client.get();
  assert.equal(state.browser.kind, 'chrome'); assert.equal(state.browser.needsCourseRefresh, true);
  assert.equal(state.courses.length, 1); assert.equal(connections, 0, 'selection and manual confirmation must not connect Edge');
  assert(state.logs.some(item => /人工确认.*交卷/.test(item.message)));
});

test('removing the final course and restarting cannot bypass unresolved submission checks', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-removed-submission-'));
  await saveJSON(path.join(dataDir, 'api.json'), { ...defaults, answer_mode: 'free', api_key: '' });
  const owner = new EventEmitter(); owner.isConnected = () => true; owner.close = async () => {};
  owner.contexts = () => [{ pages: () => [{ url: () => 'https://www.uooc.net.cn/home/index', evaluate: async () => ['123'] }] }];
  const options = { appDir, dataDir, checkDependencies: async () => true, browserOptions: { connectBrowser: async () => owner }, checkinOptions: { autoTick: false } };
  let app = await createConsole(options);
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  let client = await session(app);
  await client.post('/api/courses', { url: courseURL('123') });
  await client.post('/api/course-action', { id: '123', action: 'remove' });
  await app.close(); app = await createConsole(options); client = await session(app);
  await client.post('/api/browser-connect');
  const result = await client.post('/api/browser-select', { kind: 'edge', sameAccount: true }, 400);
  assert.match(result.error, /交卷.*123/); assert.equal((await client.get()).browser.kind, 'chrome');
});

test('browser selection waits for worker exit, preserves shared costs and survives restart', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-browser-selection-')), children = [];
  await saveJSON(path.join(dataDir, 'api.json'), { ...defaults, answer_mode: 'free', api_key: '' });
  await saveJSON(path.join(dataDir, 'ledger/course-123.json'), { courseId: '123', model: 'fixture', requests: [{ id: 'known', status: 'known', cost_nanos: 25000000 }, { id: 'unknown', status: 'unknown', reserved_nanos: 50000000 }] });
  const owner = new EventEmitter(); owner.isConnected = () => true; owner.close = async () => {};
  owner.contexts = () => [{ pages: () => [{ url: () => 'https://www.uooc.net.cn/home/index', evaluate: async () => [] }] }];
  const options = { appDir, dataDir, checkDependencies: async () => true,
    spawnController: (...args) => { const child = fixtureWorker(children)(...args); child.send = () => {}; return child; },
    browserOptions: { connectBrowser: async () => owner, discoverBrowser: async ({ kind }) => ({ kind, available: true, profiles: [{ directory: 'Default', name: kind }] }) },
    checkinOptions: { autoTick: false },
  };
  let app = await createConsole(options);
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  let client = await session(app);
  assert.equal((await client.get()).browser.kind, 'chrome');
  await client.post('/api/courses', { url: courseURL('123') });
  await client.post('/api/browser-connect');
  await client.post('/api/course-action', { id: '123', action: 'start' });
  await client.post('/api/browser-select', { kind: 'edge', sameAccount: true }, 400);
  await client.post('/api/course-action', { id: '123', action: 'stop' });
  await client.post('/api/browser-select', { kind: 'edge', sameAccount: true }, 400);
  children[0].emit('exit', 0, null);
  await client.post('/api/browser-select', { kind: 'invalid', sameAccount: true }, 400);
  await client.post('/api/browser-select', { kind: 'edge' }, 400);
  await client.post('/api/browser-select', { kind: 'edge', sameAccount: true });
  let state = await client.get();
  assert.equal(state.browser.kind, 'edge'); assert.equal(state.browser.needsCourseRefresh, true);
  assert.deepEqual(state.courses[0].costs, { spent: 0.025, reserved: 0.05, unknown: true, unknownRequests: 1, pending: 0, requests: 2, unresolvedRequests: 1, recoveryRequired: true, meteringBoundExceeded: false });
  assert.equal(state.checkin.settings.requiresConfirmation, true);
  await client.post('/api/course-action', { id: '123', action: 'start' }, 400);
  await app.close(); app = await createConsole(options); client = await session(app);
  state = await client.get(); assert.equal(state.browser.kind, 'edge');
  assert.equal(state.browser.needsCourseRefresh, true); assert.equal(state.courses.length, 1);
});
