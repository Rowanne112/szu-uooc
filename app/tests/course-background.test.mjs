import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const { installCourseScript } = await import(process.env.SZU_UOOC_TEST_BRIDGE ? pathToFileURL(path.resolve(process.env.SZU_UOOC_TEST_BRIDGE)).href : '../browser-bridge.mjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) { value = await read(); if (predicate(value)) return value; await delay(50); }
  assert.fail('Background fixture timed out: ' + JSON.stringify(value));
}

test('the original browser course bridge keeps background timers and native video alive, then restores visibility on cleanup', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-background-'));
  // Ordinary Playwright launch enables focus emulation and disables background throttling, masking this bug.
  const child = spawn(executablePath, ['--headless=new', '--disable-extensions', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--use-mock-keychain', '--remote-debugging-port=0', '--user-data-dir=' + temp, 'about:blank'], { stdio: 'ignore' });
  let browser, uninstall;
  try {
    const activePort = await waitFor(() => fs.readFile(path.join(temp, 'DevToolsActivePort'), 'utf8').catch(() => ''), Boolean);
    const [port, endpoint] = activePort.trim().split(/\r?\n/);
    browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, { noDefaults: true });
    const context = browser.contexts()[0], page = context.pages()[0];
    await page.setContent('<video muted playsinline width="320" height="240"></video><script>window.ticks=0;setInterval(()=>window.ticks++,50)</script>');
    const clip = (await fs.readFile(new URL('./fixtures/three-seconds.mp4', import.meta.url))).toString('base64');
    await page.evaluate(clip => { document.querySelector('video').src = 'data:video/mp4;base64,' + clip; }, clip);
    const other = await context.newPage(); await other.bringToFront();
    const visibility = () => page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus(), ticks: window.ticks }));
    await waitFor(visibility, state => state.visibility === 'hidden' && !state.focused);
    uninstall = await installCourseScript(page, { config: {}, bank: '{"questions":[]}', script: '', expectedCourse: '123', requestAPI: () => { throw new Error('No provider requests in this fixture'); } });
    await waitFor(visibility, state => state.visibility === 'visible' && state.focused && state.ticks >= 3);
    assert.equal(await other.evaluate(() => typeof window.szuUoocNetwork), 'undefined', 'unrelated tabs receive no bridge');
    await page.evaluate(() => document.querySelector('video').play());
    await waitFor(() => page.evaluate(() => ({ time: document.querySelector('video').currentTime, ended: document.querySelector('video').ended })), state => state.ended, 7000);
    await page.evaluate(() => { const video = document.querySelector('video'); video.currentTime = 0; video.pause(); });
    await delay(200);
    assert.equal(await page.evaluate(() => document.querySelector('video').paused), true, 'focus protection does not resume a user-paused video');
    await uninstall(); uninstall = undefined;
    await waitFor(visibility, state => state.visibility === 'hidden' && !state.focused);
    assert.equal(page.isClosed(), false);
    console.log('Raw Chrome/noDefaults: background timers advance, real MP4 naturally ends, explicit pause survives, cleanup releases focus. No course platform or provider requests.');
  } finally {
    await uninstall?.().catch(() => {});
    child.kill('SIGKILL');
    await browser?.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    await fs.rm(temp, { recursive: true, force: true });
  }
});
