import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createConsole } from '../student/console-server.mjs';
import { openCheckinPages, checkinURL } from '../student/checkin-browser.mjs';
import { autostartDefinition, setAutostart } from '../student/autostart.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appDir, courseURL } from './console-fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const chrome = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const exec = promisify(execFile);
const waitFor = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out waiting for browser state'); };

test('actual Chrome command opens all URLs in the specified existing profile; signup pages stay inactive through navigation', async t => {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-browser-profile-'));
  // External Chrome tabs can navigate before Playwright installs a route. Dispatch
  // only to our own HTTP fixture, then test UOOC URLs in already attached tabs.
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html><body>Local dispatch fixture</body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Headless Chrome rejects second-process URL dispatch. Users run ordinary windowed Chrome.
  const context = await chromium.launchPersistentContext(await fs.realpath(userDataDir), { executablePath: chrome, headless: false, args: ['--profile-directory=Profile 2'] });
  t.after(async () => { await context.close(); await new Promise(resolve => server.close(resolve)); await fs.rm(userDataDir, { recursive: true, force: true }); });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><video></video></body></html>' }));
  const script = await fs.readFile(path.join(appDir, 'szu-uooc.user.js'), 'utf8');
  await context.addInitScript({ content: `if (/uooc\\.net\\.cn$/.test(location.hostname)) {
    window.__playCalls = 0; window.__paidCalls = 0;
    HTMLMediaElement.prototype.play = function () { window.__playCalls++; return Promise.resolve(); };
    window.GM_getValue = (_key, fallback) => fallback; window.GM_setValue = () => {};
    window.GM_xmlhttpRequest = () => { window.__paidCalls++; throw new Error('No paid requests allowed'); };
    localStorage.setItem('szu-uooc:course-state:123', JSON.stringify({ active: true, courseId: '123' }));
    ${script}
  }` });
  const urls = ['123', '456'].map(id => `http://127.0.0.1:${server.address().port}/course/${id}?szu_checkin=1`);
  const results = await openCheckinPages(urls, { executable: chrome, userDataDir: await fs.realpath(userDataDir), profileDirectory: 'Profile 2' });
  assert(results.every(result => result.ok));
  await waitFor(() => context.pages().filter(page => urls.includes(page.url())).length === 2);
  assert(await fs.stat(path.join(userDataDir, 'Profile 2')).catch(() => null));
  const page = await context.newPage(); await page.goto(checkinURL(courseURL('123'), true));
  await page.waitForLoadState('domcontentloaded');
  assert.equal(await page.locator('#szu-uooc-auto-player-controls').count(), 0);
  assert.deepEqual(await page.evaluate(() => [window.__playCalls, window.__paidCalls, JSON.parse(localStorage.getItem('szu-uooc:course-state:123')).active]), [0, 0, true]);
  await page.evaluate(() => history.replaceState(null, '', location.pathname + location.hash));
  await page.reload();
  assert.equal(await page.locator('#szu-uooc-auto-player-controls').count(), 0);
  assert.equal(await page.evaluate(() => window.__playCalls), 0);
  await page.goto('https://www.uooc.net.cn/home/course/123');
  assert.equal(await page.locator('#szu-uooc-auto-player-controls').count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('szu-uooc:checkin-tab')), '1');
  const learning = await context.newPage(); await learning.goto(courseURL('123'));
  await learning.locator('#szu-uooc-auto-player-controls').waitFor();
  await waitFor(() => learning.evaluate(() => window.__playCalls > 0));
  assert.equal(await learning.evaluate(() => sessionStorage.getItem('szu-uooc:checkin-tab')), null);
});

test('user can configure signup, add courses, switch schedule and reopen from the real console UI without a Key', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-checkin-ui-')); const batches = [], startup = [];
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true, spawnController: () => { throw new Error('Should not learn'); }, checkinOptions: {
    autoTick: false, discoverBrowser: async () => ({ available: true, executable: '/fixture/Chrome', userDataDir: '/fixture/Profile', profiles: [{ directory: 'Default', name: '学习账号' }] }),
    autostart: async enabled => startup.push(enabled), isOnline: async () => true, notify: () => {}, openPages: async urls => { batches.push(urls); return urls.map(url => ({ url, ok: true })); },
  } });
  const browser = await chromium.launch({ executablePath: chrome, headless: true }); const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = [];
  const evidence = path.join(appDir, 'dist/evidence'); await fs.mkdir(evidence, { recursive: true });
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await browser.close(); await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  await page.goto(app.url); await page.getByRole('button', { name: '设置', exact: true }).waitFor();
  const openSettings = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); };
  await openSettings(); await page.locator('#preferences-dialog [data-open="add"]').click();
  await page.locator('#course-url').fill(['123', '456'].map(courseURL).join('\n'));
  await page.locator('#add-form button[type="submit"]').click(); await page.waitForFunction(() => !document.querySelector('#add-dialog').open);
  await openSettings();
  await page.locator('[data-open="checkin"]').click(); await page.locator('#checkin-profile option[value="Default"]').waitFor({ state: 'attached' });
  await page.locator('[data-checkin-course="123"]').check(); await page.locator('[data-checkin-course="456"]').check();
  await page.locator('#checkin-enabled').check(); await page.locator('#checkin-profile').selectOption('Default'); await page.locator('#checkin-autostart').check(); await page.locator('#checkin-script-ready').check();
  await page.screenshot({ path: path.join(evidence, '每日签到-设置.png'), fullPage: true });
  await page.locator('#checkin-form button[type="submit"]').click(); await page.waitForFunction(() => !document.querySelector('#checkin-dialog').open);
  await waitFor(async () => (await app.state()).checkin.counts.opened === 2);
  assert.equal(batches.length, 1); assert.equal(batches[0].length, 2); assert.deepEqual(startup, [true]);
  await page.screenshot({ path: path.join(evidence, '每日签到-已打开.png'), fullPage: true });
  await page.reload(); await page.locator('.course-row').first().waitFor(); assert.equal(batches.length, 1);
  await page.locator('.course-row[data-id="123"] summary').click(); await page.locator('[data-edit-course="123"]').click(); await page.locator('#edit-course-name').fill('我的签到课'); await page.locator('#course-checkin-form button[type="submit"]').click();
  await page.waitForFunction(() => !document.querySelector('#course-checkin-dialog').open); assert.equal(batches.length, 1);
  await page.locator('.course-row[data-id="123"] summary').click(); await page.locator('[data-edit-course="123"]').click(); await page.locator('#edit-course-reopen').click(); await waitFor(() => batches.length === 2); assert.equal(batches[1].length, 1); await page.locator('#course-checkin-dialog [data-close]').first().click();
  await openSettings(); await page.locator('[data-open="checkin"]').click(); await page.locator('#checkin-mode').selectOption('scheduled'); await page.locator('#checkin-time').fill('21:30'); await page.locator('#checkin-autostart').uncheck();
  await page.locator('#checkin-form button[type="submit"]').click(); await page.waitForFunction(() => !document.querySelector('#checkin-dialog').open);
  assert.deepEqual(startup, [true, false]); assert.equal((await app.state()).checkin.settings.time, '21:30'); assert.equal(batches.length, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(evidence, '每日签到-手机宽度.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
});

test('macOS validates and actually launches the per-user job, then removes its startup file', { skip: process.platform !== 'darwin' }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-native-startup-')); const marker = path.join(home, 'started.json');
  const script = path.join(home, '中文 & 程序', 'start.mjs'); await fs.mkdir(path.dirname(script));
  await fs.writeFile(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`);
  const options = { platform: 'darwin', home, node: process.execPath, script, dataDir: path.join(home, '签到 配置') };
  const definition = autostartDefinition(options), domain = `gui/${process.getuid()}`;
  // Use a unique job label so the smoke test can never unload a real user's agent.
  const testLabel = `local.szu-uooc.checkin-test-${process.pid}`;
  t.after(async () => { await exec('/bin/launchctl', ['bootout', domain, definition.file]).catch(() => {}); await setAutostart(false, options); await fs.rm(home, { recursive: true, force: true }); });
  await setAutostart(true, options); await fs.writeFile(definition.file, definition.content.replace('local.szu-uooc.checkin</string>', testLabel + '</string>')); await exec('/usr/bin/plutil', ['-lint', definition.file]);
  await exec('/bin/launchctl', ['bootstrap', domain, definition.file]); await waitFor(() => fs.stat(marker).catch(() => false));
  assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), ['--no-open', '--data-dir', options.dataDir]);
  await exec('/bin/launchctl', ['bootout', domain, definition.file]); await setAutostart(false, options);
  assert(!await fs.stat(definition.file).catch(() => null));
});
