import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installCourseScript } from '../browser-bridge.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const url = 'https://www.uooc.net.cn/home/learn/#/123/1/2/500/section';
const script = `document.addEventListener('DOMContentLoaded', () => {
  const node = document.createElement('script'); node.id = 'szu-uooc-course-state';
  node.type = 'application/json'; node.textContent = JSON.stringify({courseId:'123',sourceId:'500',runId:1,active:true,phase:'solving'});
  document.body.appendChild(node);
});`;

test('queued paid requests cannot survive a new run or a document reload with the same runId', async t => {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  for (const change of ['same', 'resume', 'reload', 'replace']) {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
    let release, entered, dispatched = 0;
    const pending = new Promise(resolve => release = resolve), seen = new Promise(resolve => entered = resolve);
    const uninstall = await installCourseScript(page, { config: {}, bank: '{"questions":[]}', script, expectedCourse: '123', requestAPI: async (_course, _details, mayDispatch) => {
      entered(); await pending;
      if (await mayDispatch()) dispatched++;
      return { status: 200 };
    } });
    try {
      await page.goto(url);
      await page.evaluate(() => { window.fixtureCall = szuUoocNetwork({}).catch(() => null); });
      await seen;
      if (change === 'reload') await page.reload();
      else if (change !== 'same') await page.evaluate(change => {
        const node = document.querySelector('#szu-uooc-course-state');
        if (change === 'replace') node.replaceWith(node.cloneNode(true));
        else { const state = JSON.parse(node.textContent); state.runId++; node.textContent = JSON.stringify(state); }
      }, change);
      release();
      if (change !== 'reload') await page.evaluate(() => window.fixtureCall);
      else await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(dispatched, change === 'same' ? 1 : 0, change + ': only the same live run may send another paid request');
    } finally { release(); await uninstall(); await page.close(); }
  }
});

test('a delayed image is rejected after resuming the same task in a new run', async t => {
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  const uninstall = await installCourseScript(page, { config: {}, bank: '{"questions":[]}', script, expectedCourse: '123', requestAPI: () => { throw new Error('No paid requests'); } });
  let release, entered, disposed = false;
  const pending = new Promise(resolve => release = resolve), seen = new Promise(resolve => entered = resolve);
  const original = page.request.get;
  page.request.get = async () => ({ ok: () => true, body: async () => { entered(); await pending; return Buffer.from('image'); }, headers: () => ({}), dispose: async () => { disposed = true; } });
  try {
    await page.goto(url);
    await page.evaluate(() => {
      const container = document.createElement('div'); container.className = 'queContainer';
      container.innerHTML = '<img src="https://www.uooc.net.cn/fixture.png">'; document.body.appendChild(container);
      window.imageResult = szuUoocImage('https://www.uooc.net.cn/fixture.png').then(() => 'unexpected', error => error.message);
    });
    await seen;
    await page.evaluate(() => { const node = document.querySelector('#szu-uooc-course-state'); const state = JSON.parse(node.textContent); state.runId++; node.textContent = JSON.stringify(state); });
    release();
    assert.match(await page.evaluate(() => window.imageResult), /暂停或更换题目/);
    assert(disposed, 'discarded responses release their resources');
  } finally { release(); page.request.get = original; await uninstall(); }
});
