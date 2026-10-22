import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConsole } from '../student/console-server.mjs';
import { appDir, courseURL, fixtureWorker, session } from './console-fixtures.mjs';
import { defaults, saveJSON } from '../student/settings.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();

test('a restarted console reports pending and unknown costs consistently and only user actions authorize billing recovery', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-billing-console-'));
  const children = [], invocations = [], spawn = fixtureWorker(children);
  await saveJSON(path.join(dataDir, 'api.json'), { ...defaults, answer_mode: 'free', api_key: '' });
  await saveJSON(path.join(dataDir, 'courses.json'), { courses: [{ id: '123', url: courseURL('123'), name: '保留的课程', status: 'paused', completed: 10, total: 11 }] });
  await saveJSON(path.join(dataDir, 'ledger/course-123.json'), { courseId: '123', model: 'fixture', requests: [
    { id: 'known', status: 'known', cost_nanos: 2300000 },
    { id: 'interrupted', status: 'pending', reserved_nanos: 7900000 },
  ] });
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true, spawnController: (...args) => { invocations.push(args); return spawn(...args); } });
  t.after(async () => { await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const client = await session(app), state = await client.get();
  assert.equal(invocations.length, 0, 'reopening the console never resumes a paid task');
  assert.equal(state.courses[0].completed, 10);
  assert.deepEqual(Object.fromEntries(['spent', 'reserved', 'unknown', 'pending', 'recoveryRequired'].map(key => [key, state.courses[0].costs[key]])), {
    spent: .0023, reserved: .0079, unknown: true, pending: 1, recoveryRequired: true,
  });
  await client.post('/api/course-action', { id: '123', action: 'resume' });
  assert(invocations[0][1].includes('--resume-billing'), 'the explicit user action must reach the controller');
});

test('cost recovery shows Continue and retained costs after restart without routing the user into repeated service detection', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-billing-ui-'));
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true });
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  t.after(async () => { await browser.close(); await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const state = structuredClone(await app.state());
  state.environment.status = 'ready';
  state.browser = { ...state.browser, status: 'connected', catalog: 'ready', selectionRequired: false };
  state.config = { ...state.config, hasKey: true, answer_mode: 'ai' };
  state.courses = [{ id: '123', name: '费用恢复测试', status: 'stopped', statusLabel: '已停止', error: '', completed: 10, total: 11, lockedUnits: 57,
    costs: { spent: .0023, reserved: .0079, unknown: true, pending: 1, recoveryRequired: true }, checkin: { enabled: false, label: '未加入签到' } }];
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.goto(app.url);
  const row = page.locator('.course-row[data-id="123"]');
  await row.waitFor();
  assert.match(await row.locator('.course-help').innerText(), /查看账单.*继续.*剩余预算.*可能.*计费/);
  assert.equal(await row.getByRole('button', { name: '继续', exact: true }).count(), 1);
  assert.equal(await row.locator('[data-fix-service]').count(), 0, 'cost recovery must not advertise redetection as its repair');
  await row.locator('summary').click();
  assert.match(await row.innerText(), /\$0\.0023.*\$0\.0079/s);
  await row.locator('summary').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const evidence = path.resolve('../dist/billing-refactor-20261022');
  await fs.mkdir(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, 'recovery-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(evidence, 'recovery-desktop.png'), fullPage: true });
  Object.assign(state.courses[0], { status: 'paused', error: '解题服务 HTTP 401：Key 无效' });
  await page.reload();
  await row.locator('[data-fix-service]').waitFor();
  assert.match(await row.locator('.course-help').innerText(), /Key/);
  assert.equal(await row.getByRole('button', { name: '修改 Key', exact: true }).count(), 1);
  Object.assign(state.courses[0], { status: 'running', phase: 'solving', error: '' });
  state.activeIds = ['123']; Object.assign(state.courses[0].costs, { unknownRequests: 0, unresolvedRequests: 1 });
  await page.reload(); await row.waitFor(); await row.locator('summary').click();
  assert.match(await row.locator('.course-menu').innerText(), /处理中/);
  assert.doesNotMatch(await row.locator('.course-menu').innerText(), /请核对账单/);
  state.courses[0].costs.unknownRequests = 1;
  await page.reload(); await row.waitFor(); await row.locator('summary').click();
  assert.match(await row.locator('.course-menu').innerText(), /请核对账单/);
  Object.assign(state.courses[0], { phase: 'video' });
  Object.assign(state.courses[0].costs, { unknownRequests: 0, unresolvedRequests: 0, recoveryRequired: false });
  await page.reload(); await row.waitFor(); await row.locator('summary').click();
  assert.match(await row.locator('.course-menu').innerText(), /待核对.*请核对账单/);
  assert.doesNotMatch(await row.locator('.course-menu').innerText(), /处理中/);
});
