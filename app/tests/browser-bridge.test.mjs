import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installCourseScript, verificationSelector, clickVerificationControl, stopCourseScript } from '../browser-bridge.mjs';
import { createAPI } from '../api-request.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-uooc-bridge-test-'));
const owner = await chromium.launchPersistentContext(path.join(temp, 'chrome'), { headless: true, executablePath, timeout: 10000, args: ['--remote-debugging-port=0'] });
const [port, endpoint] = (await fs.readFile(path.join(temp, 'chrome/DevToolsActivePort'), 'utf8')).trim().split('\n');
const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, { noDefaults: true });
try {
  const config = { api_key: 'private-fixture-key', model: 'gpt-6-luna', base_url: 'https://api.example.test/v1', budget: 1, pricing: { input_per_million: 0.05, cached_input_per_million: 0.005, output_per_million: 0.25 } };
  let calls = 0;
  const api = createAPI(config, temp, async (_url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, 'Bearer private-fixture-key');
    return new Response(JSON.stringify({ model: config.model, status: 'completed', usage: { input_tokens: 20, output_tokens: 10 }, output: [] }), { status: 200 });
  });
  const context = browser.contexts()[0];
  await owner.route('**/*', (route) => route.fulfill({ body: '<!doctype html><html><body></body></html>', contentType: 'text/html' }));
  const unrelated = await owner.newPage();
  await unrelated.goto('https://example.test/');
  const page = await context.newPage();
  await installCourseScript(page, {
    config, bank: '{"questions":[]}', expectedCourse: '123', requestAPI: api,
    script: `document.addEventListener('DOMContentLoaded', () => {
      const state = document.createElement('script'); state.id='szu-uooc-course-state'; state.type='application/json';
      state.textContent = JSON.stringify({courseId:'123',active:true,phase:'solving'}); document.body.appendChild(state);
      window.fixtureRequest = () => new Promise((resolve,reject) => GM_xmlhttpRequest({method:'POST',url:'https://api.example.test/v1/responses',data:JSON.stringify({model:'gpt-6-luna',reasoning:{effort:'medium'},store:false,input:'test',max_output_tokens:128}),onload:resolve,onerror:reject}));
    });`,
  });
  await page.goto('https://www.uooc.net.cn/home/learn/#/123/1/2/3/section');
  assert.equal(await unrelated.evaluate(() => typeof szuUoocNetwork), 'undefined', 'existing unrelated tabs do not receive bindings or scripts');
  assert.equal(await page.evaluate(() => GM_getValue('szu-uooc:ai-api-key')), '[managed-by-local-controller]');
  assert.equal((await page.evaluate(() => JSON.stringify(localStorage))).includes(config.api_key), false);
  const result = await page.evaluate(() => fixtureRequest());
  assert.equal(result.status, 200);
  assert.equal(JSON.stringify(result).includes(config.api_key), false);
  assert.equal(calls, 1);
  config.answer_mode = 'free';
  assert.match(await page.evaluate(async () => { try { await fixtureRequest(); return 'unexpected'; } catch (error) { return error.error || error.message; } }), /免费模式/);
  assert.equal(calls, 1, 'free mode blocks provider calls even when an old Key is retained');
  delete config.answer_mode;

  const originalImageGet = page.request.get;
  let imageGets = 0;
  page.request.get = async (url, options) => {
    imageGets++; assert.equal(url, 'https://www.uooc.net.cn/image-fixture.png'); assert.equal(options.maxRedirects, 0);
    return { ok: () => true, body: async () => Buffer.from('fixture-image'), headers: () => ({ 'content-type': 'image/png' }), dispose: async () => {} };
  };
  await page.evaluate(() => { const q = document.createElement('div'); q.className = 'queContainer'; q.innerHTML = '<img src="https://www.uooc.net.cn/image-fixture.png">'; document.body.appendChild(q); });
  const image = await page.evaluate(() => szuUoocImage('https://www.uooc.net.cn/image-fixture.png'));
  assert.equal(Buffer.from(image.base64, 'base64').toString(), 'fixture-image');
  for (const url of ['https://www.uooc.net.cn/absent.png', 'https://127.0.0.1/private.png', 'https://api.example.test/v1/models']) assert.match(await page.evaluate(async url => { try { await szuUoocImage(url); return 'unexpected'; } catch (error) { return error.message; } }, url), /不匹配|不在支持范围/);
  assert.equal(imageGets, 1, 'image bridge only downloads present course images from supported hosts');
  page.request.get = originalImageGet;

  await page.evaluate(() => {
    const stop = document.createElement('button'); stop.dataset.action = 'course-stop'; stop.style.display = 'none';
    stop.onclick = () => { document.querySelector('#szu-uooc-course-state').textContent = JSON.stringify({courseId:'123',active:false,phase:'paused'}); };
    document.body.appendChild(stop);
  });
  await stopCourseScript(page);
  assert.equal(await page.evaluate(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).active), false, 'collapsed panel does not prevent cancellation');
  await page.evaluate(() => { document.querySelector('#szu-uooc-course-state').textContent = JSON.stringify({courseId:'123',active:true,phase:'solving'}); });

  const details = { method: 'POST', url: config.base_url + '/responses', data: JSON.stringify({ model: config.model, store: false, reasoning: { effort: 'medium' }, input: 'test', max_output_tokens: 128 }) };
  await page.evaluate(() => { const iframe=document.createElement('iframe'); iframe.src='/exam/44'; document.body.appendChild(iframe); });
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.readyState === 'complete');
  const frame = page.frames().find((f) => f.url().endsWith('/exam/44'));
  assert.equal(await frame.evaluate(() => typeof GM_getValue), 'undefined', 'script and bank are not injected into quiz frames');
  assert.match(await frame.evaluate(async (details) => { try { await szuUoocNetwork(details); return 'unexpected'; } catch (error) { return error.message; } }, details), /拒绝/);
  await frame.setContent('<div id="commitConfirmDialog"><div id="sc"><div id="aliyunCaptcha-checkbox-body" class="checkbox" style="width:335px;height:42px"><div id="aliyunCaptcha-checkbox-left" style="display:flex;align-items:center;width:183px;height:42px"><div id="aliyunCaptcha-checkbox-icon" style="flex-shrink:0;width:21px;height:21px;border:1px solid;box-sizing:border-box"></div><span style="flex-shrink:0;width:154px;margin-left:8px">点击复选框开始智能验证</span></div></div></div></div>');
  await frame.evaluate(() => document.querySelector('#aliyunCaptcha-checkbox-icon').addEventListener('click', (event) => { window.fixtureTrustedMouse = event.isTrusted; }));
  assert.equal(await frame.getByRole('checkbox').count(), 0, 'the observed native widget has no checkbox role');
  await page.bringToFront();
  await frame.locator(verificationSelector).click({ delay: 120 });
  assert.equal(await frame.evaluate(() => window.fixtureTrustedMouse), true, 'controller clicks the 21px square, not the center of its 183px text container');
  const unrelatedSize = await unrelated.evaluate(() => innerWidth);
  await page.setViewportSize({ width: 500, height: 761 });
  await page.locator('iframe').evaluate(node => { node.style.width = 'calc(100vw - 460px)'; });
  await frame.locator(verificationSelector).evaluate(node => { node.style.position = 'fixed'; node.style.left = '80px'; node.style.top = '20px'; window.fixtureTrustedMouse = false; });
  assert.equal(await frame.evaluate(() => innerWidth), 40);
  await assert.rejects(frame.locator(verificationSelector).click({ timeout: 500 }), /outside of the viewport|Timeout/);
  assert.equal(await frame.evaluate(() => window.fixtureTrustedMouse), false);
  await clickVerificationControl(page, frame);
  assert.equal(await frame.evaluate(() => window.fixtureTrustedMouse), true, 'narrow course viewport is expanded before native input');
  assert.equal(await unrelated.evaluate(() => innerWidth), unrelatedSize, 'viewport repair only affects the target page');
  await frame.locator(verificationSelector).evaluate(node => {
    window.fixtureTrustedMouse = false;
    node.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(2px)' }], { duration: 500, iterations: Infinity, direction: 'alternate' });
  });
  await clickVerificationControl(page, frame);
  assert.equal(await frame.evaluate(() => window.fixtureTrustedMouse), true, 'a visible animated verification control receives native input without waiting forever for layout stability');
  await frame.locator(verificationSelector).evaluate(node => node.getAnimations().forEach(animation => animation.cancel()));
  await frame.locator(verificationSelector).evaluate(node => { node.style.pointerEvents = 'none'; window.fixtureTrustedMouse = false; });
  await assert.rejects(clickVerificationControl(page, frame), /遮挡/);
  assert.equal(await frame.evaluate(() => window.fixtureTrustedMouse), false, 'covered targets never receive input');
  await frame.locator(verificationSelector).evaluate(node => { node.style.pointerEvents = ''; });
  await page.evaluate(() => {
    window.fixtureCoverClicks = 0;
    const cover = document.createElement('button'); cover.id = 'fixture-cover'; cover.style.cssText = 'position:fixed;inset:0;z-index:999999';
    cover.onclick = () => window.fixtureCoverClicks++; document.body.appendChild(cover);
  });
  await assert.rejects(clickVerificationControl(page, frame), /遮挡/);
  assert.equal(await page.evaluate(() => window.fixtureCoverClicks), 0, 'the parent overlay cannot receive the verification click');
  assert.equal(await frame.evaluate(() => window.fixtureTrustedMouse), false, 'parent-page overlays also block native verification input');
  await page.locator('#fixture-cover').evaluate(node => node.remove());
  await frame.locator(verificationSelector).evaluate(node => { node.style.pointerEvents = ''; window.fixturePaused = false; window.fixtureClickedWhilePaused = false; node.addEventListener('click', () => { if (window.fixturePaused) window.fixtureClickedWhilePaused = true; }); });
  await clickVerificationControl(page, frame, async () => {
    await frame.locator(verificationSelector).evaluate(node => {
      node.style.display = 'none';
      setTimeout(() => { window.fixturePaused = true; }, 10);
      setTimeout(() => { node.style.display = ''; }, 150);
    });
    return true;
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await frame.evaluate(() => window.fixtureClickedWhilePaused), false, 'native input cannot wait for a paused verification target to reappear');
  await page.evaluate(() => { document.querySelector('#szu-uooc-course-state').textContent=JSON.stringify({courseId:'999',active:true,phase:'solving'}); });
  assert.match(await page.evaluate(async (details) => { try { await szuUoocNetwork(details); return 'unexpected'; } catch (error) { return error.message; } }, details), /范围内/);
  await page.goto('https://example.test/');
  assert.equal(await page.evaluate(() => typeof GM_getValue), 'undefined');
  assert.match(await page.evaluate(async (details) => { try { await szuUoocNetwork(details); return 'unexpected'; } catch (error) { return error.message; } }, details), /拒绝/);
  assert.equal(calls, 1, 'unrelated origins, frames and courses cannot invoke the paid proxy');
  await page.goto('https://www.uooc.net.cn/home/learn/#/999/1/2/3/section');
  assert.equal(await page.evaluate(() => typeof GM_getValue), 'undefined', 'another course does not receive answer bank or config');
  await browser.close();
  assert.equal(owner.browser().isConnected(), true, 'disconnecting the controller keeps the original Chrome running');
  assert.equal(await unrelated.url(), 'https://example.test/', 'unrelated tabs remain open');
  const retained = owner.pages().find((candidate) => candidate.url().includes('/home/learn/'));
  await retained.goto('https://www.uooc.net.cn/home/learn/#/123/1/2/3/section');
  assert.equal(await retained.evaluate(() => typeof GM_getValue), 'undefined', 'reload after controller disconnect must not rerun its old injected script');
  console.log('Browser bridge self-check passed: private Key, streaming transport, origin/frame/course guards. All requests mocked.');
} finally {
  await browser.close();
  await owner.close();
  await fs.rm(temp, { recursive: true, force: true });
}
