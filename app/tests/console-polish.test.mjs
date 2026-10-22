import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createConsole } from '../student/console-server.mjs';
import { candidateModels } from '../api-protocol.mjs';
import { explainProblem, serviceActionFor } from '../student/user-guidance.mjs';
import { appDir, courseURL } from './console-fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const evidence = path.resolve(process.env.SZU_POLISH_EVIDENCE || '../dist/frontend-polish-20261020');

test('concise recovery actions distinguish billing and model errors from invalid keys', () => {
  for (const [message, action, recovery] of [
    ['解题服务 HTTP 403：余额不足', 'retry', /充值.*重新检测/],
    ['HTTP 403 AccountOverdueError', 'retry', /欠费.*充值/],
    ['HTTP 403 当前模型未开通', 'model', /模型未开通.*更换模型/],
    ['HTTP 429 SetLimitExceeded', 'retry', /用量上限.*调整/],
    ['解题服务 HTTP 401：Key 无效', 'key', /完整 Key.*检测并保存/],
    ['文字答案格式不符合要求。', 'model', /模型未通过检测.*更换模型/],
  ]) {
    assert.equal(serviceActionFor(message), action, message);
    const text = explainProblem(message);
    assert.match(text, recovery, message);
    assert(text.length <= 70, 'recovery names the problem and next action without a tutorial');
  }
  assert.match(explainProblem('API 费用未知，缺少 usage'), /查看账单.*继续.*不要删除/);
});

test('the console keeps essential costs visible and every dialog action reachable at desktop, tablet and phone sizes', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'uooc-polish-'));
  const model = 'doubao-seed-2-0-mini-260428', key = 'polish-fixture-key';
  let calls = 0;
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true, checkinOptions: { autoTick: false }, fetchImpl: async (url, options) => {
    calls++;
    if (url.endsWith('/models')) return Response.json({ data: [{ id: model }] });
    const body = JSON.parse(options.body);
    return Response.json({ model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ answers: [{ index: 0, answers: [Array.isArray(body.messages[0].content) ? '3' : '2'] }] }) } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  } });
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(async () => { await browser.close(); await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await fs.mkdir(evidence, { recursive: true });
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const state = structuredClone(await app.state());
  const profile = { ...candidateModels('https://ark.cn-beijing.volces.com/api/v3', [{ id: model }])[0], verified_text: true, verified_image: true };
  Object.assign(state.browser, { status: 'connected', catalog: 'ready', selectionRequired: false, needsCourseRefresh: false });
  Object.assign(state.config, { hasKey: true, answer_mode: 'ai', base_url: 'https://ark.cn-beijing.volces.com/api/v3', model, profile, detection: { model, profile, image_profile: profile, models: [profile], testCosts: { calls: 2, estimated_usd: .00004, unknown: false } } });
  state.activeIds = [];
  state.courses = ['示例 · 程序设计基础', '示例 · 高等数学', '示例 · 一门名称比较长的课程，用于检查小屏换行与按钮位置'].map((name, i) => ({ id: String(123 + i), name, url: courseURL(123 + i), status: 'ready', statusLabel: '未开始', currentTitle: i === 0 ? '第一章 · 初识程序设计' : '', completed: 0, total: 24, costs: { spent: 0, reserved: 0 }, checkin: { enabled: false, label: '未加入签到', url: courseURL(123 + i) } }));
  state.logs = [];
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/browsers', route => route.fulfill({ json: { browsers: [{ kind: 'chrome', name: 'Chrome', installed: true }, { kind: 'edge', name: 'Edge', installed: true }] } }));
  await page.route('**/api/checkin-profiles', route => route.fulfill({ json: { profiles: [{ directory: 'Default', name: '默认资料' }] } }));
  await page.route('**/api/checkin-course', async route => {
    const { id, enabled } = route.request().postDataJSON();
    await new Promise(resolve => setTimeout(resolve, 50));
    state.courses.find(course => course.id === id).checkin.enabled = enabled;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(app.url);
  const fits = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page scroll');
  const footerFits = async id => {
    assert(await page.locator(`#${id} .dialog-footer`).evaluate(node => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.width <= innerWidth; }), id + ' footer stays visible');
    assert(await page.locator(`#${id} .dialog-content`).evaluate(node => node.scrollWidth <= node.clientWidth), id + ' content does not overflow');
  };
  const openSettings = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await page.locator('#preferences-dialog [data-open="settings"]').click(); };
  for (const [width, height, label] of [[1440, 1000, 'desktop'], [768, 1024, 'tablet'], [390, 844, 'mobile'], [320, 640, 'small-phone']]) {
    await page.setViewportSize({ width, height }); await fits();
    await page.screenshot({ path: path.join(evidence, `${label}.png`), fullPage: true });
    await openSettings(); await footerFits('settings-dialog');
    assert.equal(await page.locator('#model-options').evaluate(node => node.open), false);
    assert.match(await page.locator('#detection-cost-note').innerText(), /检测≤\$0\.02.*每课≤\$/);
    assert.match(await page.locator('#model-capability').innerText(), /文字、图片可用/);
    assert((await page.locator('#settings-dialog').innerText()).length < 190, 'the default settings view stays concise');
    await page.screenshot({ path: path.join(evidence, `settings-${label}.png`) });
    await page.locator('#model-options summary').click(); await footerFits('settings-dialog');
    assert.match(await page.locator('#model-reason').innerText(), /人民币.*6/);
    await page.locator('#settings-dialog [data-close]').click();
    await page.getByRole('button', { name: '更换浏览器', exact: true }).click(); await footerFits('browser-dialog');
    assert.equal(await page.locator('#browser-same-account').evaluate(input => input.required), true);
    await page.locator('#browser-dialog [data-close]').click();
    await page.getByRole('button', { name: '设置', exact: true }).click(); await page.locator('#preferences-dialog [data-open="checkin"]').click();
    await footerFits('checkin-dialog'); await fits();
    await page.screenshot({ path: path.join(evidence, `checkin-${label}.png`) });
    await page.locator('#checkin-dialog [data-close]').first().click();
    await page.getByRole('button', { name: '粘贴网址', exact: true }).click(); await footerFits('add-dialog');
    await page.locator('#add-dialog [data-close]').click();
  }
  await page.setViewportSize({ width: 320, height: 640 });
  state.courses[0].checkin.error = '当前无法连接课程网站，5 分钟后重试。';
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.locator('#preferences-dialog [data-open="checkin"]').click();
  await page.locator('.checkin-choice span').first().filter({ hasText: '检查网络' }).waitFor(); await footerFits('checkin-dialog');
  const checkin = page.locator('[data-checkin-course="123"]');
  await checkin.focus(); await page.keyboard.press('Space');
  await page.waitForFunction(() => { const input = document.querySelector('[data-checkin-course="123"]'); return input.checked && !input.disabled && input === document.activeElement; });
  state.courses[0].checkin.label = '等待打开'; state.courses[0].checkin.error = '';
  await page.locator('.checkin-choice span').first().filter({ hasText: '等待打开' }).waitFor();
  assert(await checkin.evaluate(node => node === document.activeElement), 'polling preserves checkin keyboard focus');
  await page.screenshot({ path: path.join(evidence, 'checkin-keyboard-small-phone.png') });
  await page.locator('#checkin-dialog [data-close]').first().click();
  state.activeIds = ['123']; state.courses[0].status = 'paused';
  await page.waitForFunction(() => document.querySelector('#change-learning-browser').disabled);
  assert(await page.locator('[data-open="browser"]').evaluateAll(buttons => buttons.every(button => button.disabled)), 'all browser-selection entries share the active-course guard');
  state.activeIds = []; state.courses[0].status = 'ready';
  await page.waitForFunction(() => !document.querySelector('#change-learning-browser').disabled);
  await page.setViewportSize({ width: 1440, height: 1000 });
  state.config.detection.testCosts.unknown = true;
  await page.reload();
  for (let attempt = 0; attempt < 2; attempt++) {
    await openSettings(); assert.match(await page.locator('#test-result').innerText(), /预估 < \$0\.0001.*费用待核对/);
    assert.equal(await page.locator('#model-options').evaluate(node => node.open), false);
    await page.locator('#settings-dialog [data-close]').click();
  }
  await openSettings(); await page.locator('#api-key').fill(key);
  await page.getByRole('button', { name: '显示输入的 Key' }).click(); assert.equal(await page.locator('#show-key').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '隐藏输入的 Key' }).click();
  await page.getByRole('button', { name: '检测并保存', exact: true }).click();
  await page.locator('#test-result').filter({ hasText: '连接成功' }).waitFor(); assert.equal(calls, 3);
  assert.match(await page.locator('#test-result').innerText(), /本次预估/);
  assert.match(await page.locator('#detection-cost-note').innerText(), /每课≤\$/);
  assert.equal(await page.locator('#api-key').inputValue(), ''); assert(!(await page.locator('body').innerText()).includes(key));
  await page.locator('#settings-dialog [data-close]').click();
  const first = page.locator('.course-row').first(), menu = first.locator('.course-menu');
  await menu.locator('summary').click(); await menu.getByRole('button', { name: '打开课程', exact: true }).focus();
  state.courses[0].completed = 1;
  await page.waitForFunction(() => document.querySelector('.course-status').textContent.includes('1 / 24'));
  assert.equal(await menu.evaluate(node => node.open), true);
  assert(await menu.getByRole('button', { name: '打开课程', exact: true }).evaluate(node => node === document.activeElement), 'polling preserves menu focus');
  await menu.getByRole('button', { name: '课程与签到' }).click(); await footerFits('course-checkin-dialog');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '设置', exact: true }).focus(); await page.keyboard.press('Enter'); await footerFits('preferences-dialog');
  await page.keyboard.press('Escape'); assert(await page.locator('[data-open="preferences"]').evaluate(node => node === document.activeElement));
  await page.evaluate(() => document.body.style.zoom = '2'); await fits();
  assert.deepEqual(errors, []);
});
