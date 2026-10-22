import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { connectOriginalChrome } from '../chrome-connection.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();

test('the original Chrome connector refuses remote or credential-bearing endpoints', async () => {
  const chromium={connectOverCDP(){throw new Error('must not connect');}};
  for(const endpoint of ['ws://example.test/devtools/browser/123','http://example.test/','ws://user:secret@127.0.0.1:9222/devtools/browser/123','wss://127.0.0.1:9222/']) await assert.rejects(connectOriginalChrome(chromium,endpoint),/本机地址/);
});

test('an early closed socket rejects without waiting for the connection timeout', async () => {
  const originalWebSocket=globalThis.WebSocket;
  class ClosedSocket {
    static OPEN=1;
    readyState=0;
    constructor() { queueMicrotask(()=>{this.readyState=3;this.onclose?.();}); }
    send() { assert.fail('a closed fixture socket must not send'); }
    close() { this.readyState=3; }
  }
  globalThis.WebSocket=ClosedSocket;
  try {
    await assert.rejects(connectOriginalChrome(chromium,'ws://127.0.0.1:1/devtools/browser/local-fixture',{timeout:1000}),error=>{
      assert.match(error.message,/Target page, context or browser has been closed/,'an already closed connection must fail immediately so the user can retry');
      return true;
    });
  } finally { globalThis.WebSocket=originalWebSocket; }
});

for (const [frozenURL,hasCourse] of [['http://127.0.0.1:54321/frozen',true],['about:blank',true],['about:blank',false]]) test(`original Chrome connects despite a frozen ${frozenURL === 'about:blank' ? 'blank tab' : 'unrelated renderer'}${hasCourse ? '' : ' before opening a course'} and retains user tabs`, async () => {
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'szu-original-cdp-'));
  const owner=await chromium.launchPersistentContext(temp,{executablePath,headless:true,args:['--remote-debugging-port=0']});
  let browser;
  try {
    await owner.route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('/frozen')?'<script>while(true){}</script>':'<title>Fixture</title><p>Keep this tab</p>'}));
    const user=await owner.newPage();await user.goto('https://example.test/');
    const course=hasCourse ? await owner.newPage() : null;
    if(course)await course.goto('https://www.uooc.net.cn/home/index');
    const frozen=await owner.newPage();
    if(frozenURL === 'about:blank') {
      const started=frozen.waitForEvent('console',{predicate:message=>message.text()==='frozen blank ready'});
      frozen.evaluate(()=>{console.log('frozen blank ready');while(true){}}).catch(()=>{});
      await started;
    } else await frozen.goto(frozenURL,{waitUntil:'commit'});
    const [port,endpoint]=(await fs.readFile(path.join(temp,'DevToolsActivePort'),'utf8')).trim().split('\n');
    browser=await connectOriginalChrome(chromium,`ws://127.0.0.1:${port}${endpoint}`,{timeout:2500});
    assert(browser.isConnected());
    assert.equal(browser.contexts()[0].pages().some(page=>page.url()==='https://www.uooc.net.cn/home/index'),hasCourse);
    assert(!browser.contexts()[0].pages().some(page=>page.url()===frozenURL));
    const added=await browser.contexts()[0].newPage();await added.goto('https://www.uooc.net.cn/home/learn/index#/123');await added.close();
    await browser.close();browser=null;
    assert.equal(await user.locator('p').textContent(),'Keep this tab');
    if(course)assert.equal(course.isClosed(),false);
    assert.equal(frozen.isClosed(),false);
  } finally { await browser?.close();await owner.close();await fs.rm(temp,{recursive:true,force:true}); }
});

test('clicking the console course link in connected Chrome opens the course instead of a frozen blank tab', async () => {
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'szu-course-popup-'));
  const owner=await chromium.launchPersistentContext(temp,{executablePath,headless:true,args:['--remote-debugging-port=0']});let browser;
  try {
    await owner.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:route.request().url().includes('/home/learn/')?'<h1>课程已打开</h1>':'<a target="_blank" rel="noopener noreferrer" href="https://www.uooc.net.cn/home/learn/index#/123/go">打开课程</a>'}));
    const consolePage=await owner.newPage();await consolePage.goto('http://127.0.0.1:54321/console');
    const [initial]=await Promise.all([owner.waitForEvent('page',{timeout:3000}),consolePage.getByRole('link',{name:'打开课程'}).click({timeout:3000,noWaitAfter:true})]);
    await initial.getByRole('heading',{name:'课程已打开'}).waitFor({timeout:3000});await initial.close();
    const [port,endpoint]=(await fs.readFile(path.join(temp,'DevToolsActivePort'),'utf8')).trim().split('\n');
    browser=await connectOriginalChrome(chromium,`ws://127.0.0.1:${port}${endpoint}`,{timeout:2500});
    const opened=owner.waitForEvent('page',{timeout:3000});await consolePage.getByRole('link',{name:'打开课程'}).click();const course=await opened;
    await course.waitForURL('https://www.uooc.net.cn/home/learn/**',{timeout:3000});
    assert.equal(await course.locator('h1').textContent({timeout:1000}),'课程已打开');
    assert(browser.contexts()[0].pages().some(page=>page.url()===course.url()),'the reopened course remains available for the original-browser worker to reuse');
    await browser.close();browser=null;
    assert.equal(consolePage.isClosed(),false);assert.equal(course.isClosed(),false);
  } finally {await browser?.close();await owner.close();await fs.rm(temp,{recursive:true,force:true});}
});
