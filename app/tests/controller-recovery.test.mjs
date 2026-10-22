import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { runController } from '../controller.mjs';
import { defaults, saveJSON } from '../student/settings.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const waitFor = async (predicate, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Controller recovery timed out');
};
const html = `<!doctype html><meta charset="utf-8"><title>恢复测试</title><video></video><script>
const video=document.querySelector('video');let playing=false;
Object.defineProperty(video,'paused',{get:()=>!playing});video.play=()=>{playing=true;return Promise.resolve()};video.pause=()=>{playing=false};
const source={id:'500',type:10,finished:'0',name:'测试视频'};
const root={chapterList:[{id:'1',children:[{id:'2',unitSource:[source]}]}]};
const service={getUnitLearn:async()=>[{...source}]};const route={params:{courseId:'123',chapterId:'1',sectionId:'2',sourceId:'500'},go:async()=>{}};
const injector={get:name=>name==='$rootScope'?root:name==='courseService'?service:name==='$state'?route:null};
window.angular={element:node=>({injector:()=>injector,scope:()=>node.__scope})};
</script>`;
async function fixture(t, { stateFault = '', reloadTimeouts = 0, waitForReady = true, setupPage, ...options } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-controller-recovery-'));
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  await context.route('https://www.uooc.net.cn/**', route => route.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage(), url = 'https://www.uooc.net.cn/home/learn/index#/123/1/2/500/section';
  await page.goto(url);
  if (setupPage) await setupPage(page);
  const config = path.join(temp, 'api.json'); await saveJSON(config, { ...defaults, answer_mode: 'free', api_key: '' });
  const commands = new EventEmitter(), states = [], logs = [];
  const originalLocator = page.locator.bind(page), originalReload = page.reload.bind(page);
  const fault = { mode: stateFault, reloads: 0, reloadTimes: [], reloadTimeouts, recoverAfterReload: false };
  page.locator = (selector, ...args) => {
    const locator = originalLocator(selector, ...args);
    if (selector !== '#szu-uooc-course-state') return locator;
    const originalText = locator.textContent.bind(locator);
    locator.textContent = async (...args) => {
      if (fault.mode === 'missing') return null;
      if (fault.mode === 'invalid') return '{broken';
      const text = await originalText(...args);
      const state = JSON.parse(text);
      if (fault.taskRecovery) return JSON.stringify({ ...state, ...fault.taskRecovery });
      if (fault.mode === 'submitting') return JSON.stringify({ ...state, phase: 'submitting', pendingSubmit: true });
      if (fault.mode === 'heartbeat') return JSON.stringify({ ...state, heartbeatAt: Date.now() });
      if (['stale', 'retrying'].includes(fault.mode)) return JSON.stringify({ ...state, heartbeatAt: Date.now() - 100000, nextRetryAt: fault.mode === 'retrying' ? Date.now() + 5000 : 0 });
      return text;
    };
    return locator;
  };
  page.reload = async (...args) => {
    fault.reloads++; fault.reloadTimes.push(Date.now()); if (fault.recoverAfterReload) fault.mode = '';
    const result = await originalReload(...args);
    if (fault.reloadTimeouts > 0) { fault.reloadTimeouts--; const error = new Error('fixture navigation timed out'); error.name = 'TimeoutError'; throw error; }
    if (fault.afterReload) await fault.afterReload();
    return result;
  };
  const running = runController({ args: [url, '--config', config, '--data-dir', temp, '--console'], browser, page, commands,
    recovery: { pollMs: 25, missingTimeoutMs: 75, idleGraceMs: 75, baseDelayMs: 100, maxDelayMs: 200, maxAttempts: 2, stableMs: 500 },
    onState: message => states.push(message.state), log: message => logs.push(message), fetchAPI: async () => { throw new Error('No paid requests in this fixture'); }, ...options });
  let failure; running.catch(error => { failure = error; });
  t.after(async () => { commands.emit('message', { type: 'command', action: 'stop' }); await browser.close(); await running.catch(() => {}); await fs.rm(temp, { recursive: true, force: true }); });
  if (waitForReady) { await waitFor(() => failure || states.some(state => state.phase === 'video')); if (failure) throw failure; }
  return { page, commands, states, logs, running, fault, temp, config, url, failure: () => failure };
}

for (const mode of ['missing', 'invalid']) test(`a ${mode} state channel recovers with a bounded reload and resumes the saved course`, async t => {
  const { states, logs, fault, failure } = await fixture(t);
  const before = fault.reloads, previous = states.length;
  fault.mode = mode; fault.recoverAfterReload = true;
  await waitFor(() => fault.reloads > before);
  await waitFor(() => states.slice(previous).some(state => state.phase === 'video' && state.active));
  assert.equal(failure(), undefined, 'a malformed DOM snapshot cannot terminate the controller');
  assert.equal(fault.reloads, before + 1);
  assert(logs.some(line => /自动恢复/.test(line)));
});

test('a persistent missing state channel exhausts a finite backoff budget and safely pauses', async t => {
  const { states, fault, logs, temp, failure } = await fixture(t);
  const before = fault.reloads;
  fault.mode = 'missing';
  await waitFor(() => states.some(state => state.phase === 'paused' && /自动恢复.*上限|恢复.*耗尽/.test(state.error)));
  const attempts = fault.reloads - before;
  assert.equal(attempts, 2);
  assert(fault.reloadTimes[before + 1] - fault.reloadTimes[before] >= 90, 'a second recovery must respect the first backoff');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(fault.reloads - before, attempts, 'exhausted recovery must wait for human resume');
  assert.equal(failure(), undefined);
  assert(logs.some(line => /自动恢复/.test(line)));
  const journal = (await fs.readFile(path.join(temp, 'evidence/course-123/recovery.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert(journal.some(event => event.event === 'exhausted'));
  assert(journal.filter(event => event.event === 'attempt').length === 2);
});

test('user pause cancels recovery while the DOM state is unavailable and survives a reload', async t => {
  const { page, commands, states, fault } = await fixture(t);
  fault.mode = 'missing'; commands.emit('message', { type: 'command', action: 'pause' });
  await waitFor(() => states.some(state => state.phase === 'paused' && state.error === '用户暂停'));
  fault.mode = ''; await page.reload({ waitUntil: 'domcontentloaded' });
  const before = fault.reloads;
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(fault.reloads, before);
  assert.equal(states.at(-1).active, false);
  assert.equal(states.at(-1).error, '用户暂停');
});

test('a pending submission blocks automatic page replay and reports a manual pause', async t => {
  const { page, states, fault } = await fixture(t);
  fault.mode = 'submitting';
  await waitFor(() => states.some(state => state.phase === 'submitting'));
  const before = fault.reloads; fault.mode = 'missing';
  await waitFor(() => states.some(state => state.phase === 'paused' && /交卷.*人工|人工.*交卷/.test(state.error)));
  assert.equal(fault.reloads, before, 'an unconfirmed submit must never trigger a reload and replay');
});

test('a brief missing snapshot returns without a reload or manual pause', async t => {
  const { fault, states } = await fixture(t);
  const before = fault.reloads;
  fault.mode = 'missing'; await new Promise(resolve => setTimeout(resolve, 35)); fault.mode = '';
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(fault.reloads, before); assert.equal(states.at(-1).phase, 'video');
});

test('a transient observational hook failure is logged without terminating the active course', async t => {
  let failed = false;
  const { fault, states, logs, failure } = await fixture(t, { observePage: async (_page, state) => {
    if (state.phase === 'video' && !failed) { failed = true; throw new Error('fixture observation lost execution context'); }
  } });
  assert.equal(failed, true); assert.equal(failure(), undefined);
  assert(logs.some(line => /观察暂时失败/.test(line)));
  assert.equal(states.at(-1).active, true); assert.equal(fault.reloads, 1);
});

test('a checkpoint with an unconfirmed submission blocks recovery even before the first readable snapshot', async t => {
  const { states, fault } = await fixture(t, { stateFault: 'missing', waitForReady: false, setupPage: page => page.addInitScript(() => {
    localStorage.setItem('szu-uooc:course-state:123', JSON.stringify({ active: true, pendingSubmit: { courseId: '123', sourceId: '500', task_id: '500', at: Date.now() } }));
  }) });
  await waitFor(() => states.some(state => state.phase === 'paused' && /交卷.*人工|人工.*交卷/.test(state.error)));
  assert.equal(fault.reloads, 1, 'only the initial injection reload is allowed');
});

test('a malformed checkpoint stops the managed document without restarting a runner', async t => {
  const { states, fault } = await fixture(t, { stateFault: 'missing', waitForReady: false, setupPage: page => page.addInitScript(() => {
    localStorage.setItem('szu-uooc:course-state:123', '{broken');
  }) });
  await waitFor(() => states.some(state => state.phase === 'paused' && /断点无法核对/.test(state.error)));
  assert.equal(fault.reloads, 2, 'one initial reload and one controlled shutdown, with no automatic task replay');
});

test('fresh heartbeats do not create progress logs or duplicate state events', async t => {
  const { states, logs, fault } = await fixture(t); fault.mode = 'heartbeat';
  const before = states.length, previousLogs = logs.length;
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(states.length, before); assert.equal(logs.length, previousLogs);
});

test('a dead script heartbeat recovers but an active bounded retry retains ownership', async t => {
  const { fault, states } = await fixture(t); const before = fault.reloads;
  fault.mode = 'retrying'; await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(fault.reloads, before, 'the controller cannot race the userscript backoff');
  fault.mode = 'stale'; fault.recoverAfterReload = true;
  await waitFor(() => fault.reloads > before);
  await waitFor(() => states.at(-1).phase === 'video');
  assert.equal(fault.reloads, before + 1);
});

test('a duplicate controller for the same saved course is rejected before browser operations and releases the lock after stop', async t => {
  const { page, commands, states, running, temp, config, url, fault } = await fixture(t);
  const before = fault.reloads;
  const args = [url, '--config', config, '--data-dir', temp, '--console'];
  await assert.rejects(runController({ args, browser: page.context().browser(), page, commands: new EventEmitter(), log: () => {} }), /这门课程已有控制器运行/);
  assert.equal(fault.reloads, before); assert.equal(states.at(-1).active, true);
  commands.emit('message', { type: 'command', action: 'stop' }); await running;
  const next = new EventEmitter(), nextStates = [];
  const restarted = runController({ args, browser: page.context().browser(), page, commands: next, log: () => {}, onState: event => nextStates.push(event.state), fetchAPI: async () => { throw new Error('No paid requests'); } });
  t.after(async () => { next.emit('message', { type: 'command', action: 'stop' }); await restarted.catch(() => {}); });
  await waitFor(() => nextStates.some(state => state.phase === 'video'));
  next.emit('message', { type: 'command', action: 'stop' }); await restarted;
});

test('an initial page load timeout keeps monitoring and starts when the DOM becomes usable', async t => {
  const { states, logs, failure } = await fixture(t, { reloadTimeouts: 1 });
  assert.equal(failure(), undefined); assert.equal(states.at(-1).active, true);
  assert(logs.some(line => /页面加载超时/.test(line)));
});

test('a recovery navigation timeout can still observe a successfully restored script', async t => {
  const { states, fault, temp } = await fixture(t); const before = fault.reloads;
  fault.mode = 'missing'; fault.recoverAfterReload = true; fault.reloadTimeouts = 1;
  await waitFor(() => fault.reloads > before);
  await waitFor(async () => (await fs.readFile(path.join(temp, 'evidence/course-123/recovery.jsonl'), 'utf8')).includes('recovered'));
  assert.equal(states.at(-1).phase, 'video');
  const journal = await fs.readFile(path.join(temp, 'evidence/course-123/recovery.jsonl'), 'utf8');
  assert(journal.includes('action_failed'));
});

test('stop interrupts page recovery backoff and retains the original browser tab', async t => {
  const { commands, running, page, fault } = await fixture(t); const before = fault.reloads;
  fault.mode = 'missing'; await waitFor(() => fault.reloads > before);
  commands.emit('message', { type: 'command', action: 'stop' });
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('stop did not interrupt recovery')), 1500))]);
  const stopped = fault.reloads; await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fault.reloads, stopped); assert.equal(page.isClosed(), false);
});

test('pause still stops the real runner when the stop button is removed', async t => {
  const { page, commands, states } = await fixture(t);
  await page.locator('[data-action="course-stop"]').evaluate(node => node.remove());
  commands.emit('message', { type: 'command', action: 'pause' });
  await waitFor(() => states.at(-1).phase === 'paused' && states.at(-1).error === '用户暂停');
  assert.equal(await page.evaluate(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).active), false, 'a paused UI must correspond to the real runner stopping');
});

test('losing both stop interfaces terminates the old document without discarding a pending submission and can resume manually', async t => {
  const { page, commands, states, fault } = await fixture(t);
  await page.evaluate(() => {
    delete window.szuUoocDebug.stopCourse;
    document.querySelector('[data-action="course-stop"]').remove();
  });
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('szu-uooc:course-state:123'));
    localStorage.setItem('szu-uooc:course-state:123', JSON.stringify({ ...saved, pendingSubmit: { courseId: '123', sourceId: '500', task_id: '500', at: Date.now() } }));
  });
  const before = fault.reloads;
  commands.emit('message', { type: 'command', action: 'pause' });
  await waitFor(() => states.at(-1).phase === 'paused' && states.at(-1).error === '用户暂停');
  assert.equal(await page.evaluate(() => JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent || '{}').active === true), false, 'failed DOM stop must destroy the active document before reporting paused');
  assert.equal(fault.reloads, before + 1);
  assert.equal(await page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('szu-uooc:course-state:123')).pendingSubmit)), true);
  commands.emit('message', { type: 'command', action: 'resume' });
  await waitFor(() => states.some(state => state.phase === 'paused' && /交卷/.test(state.error)));
  assert.equal(await page.evaluate(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).active), false, 'manual resume must retain the original unconfirmed-submission guard');
});

test('stop destroys an uncontrolled active document when both ordinary stop interfaces are lost', async t => {
  const { page, commands, running } = await fixture(t);
  await page.evaluate(() => { delete window.szuUoocDebug.stopCourse; document.querySelector('[data-action="course-stop"]').remove(); });
  commands.emit('message', { type: 'command', action: 'stop' }); await running;
  assert.equal(await page.evaluate(() => Boolean(window.__szuUoocRunnerInstalled)), false);
  assert.equal(page.isClosed(), false);
});

test('stop also terminates a runner whose stop API, button and DOM state have all disappeared', async t => {
  const { page, commands, running } = await fixture(t);
  await page.evaluate(() => {
    delete window.szuUoocDebug.stopCourse; document.querySelector('[data-action="course-stop"]').remove();
    const state = document.querySelector('#szu-uooc-course-state'), lookup = document.getElementById.bind(document);
    document.getElementById = id => id === 'szu-uooc-course-state' ? state : lookup(id);
    state.remove();
  });
  assert.equal(await page.locator('#szu-uooc-course-state').count(), 0);
  commands.emit('message', { type: 'command', action: 'stop' }); await running;
  assert.equal(await page.evaluate(() => Boolean(window.__szuUoocRunnerInstalled)), false);
});

test('a stop evaluate that never answers reaches its host deadline and terminates the old document', async t => {
  const { page, commands, running, logs } = await fixture(t);
  const evaluate = page.evaluate.bind(page);
  page.evaluate = (fn, ...args) => String(fn).includes('typeof window.szuUoocDebug?.stopCourse') ? new Promise(() => {}) : evaluate(fn, ...args);
  commands.emit('message', { type: 'command', action: 'stop' });
  let timer;
  try { await Promise.race([running, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('unresponsive stop never reached its deadline')), 5000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(await evaluate(() => Boolean(window.__szuUoocRunnerInstalled)), false);
  assert(logs.some(line => /停止入口不可用.*超时/.test(line)));
});

test('task-level recovery reasons, attempts and results reach persistent console logging once per change', async t => {
  const { fault, logs } = await fixture(t);
  fault.taskRecovery = { recoveryOperation: 'catalog:unit-2', recoveryAttempt: 2, recoveryResult: 'waiting', recoveryReason: 'fixture network timeout', nextRetryAt: Date.now() + 1000 };
  await waitFor(() => logs.some(line => /catalog:unit-2.*attempt=2.*result=waiting.*fixture network timeout/.test(line)));
  const before = logs.filter(line => /任务自动恢复/.test(line)).length;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(logs.filter(line => /任务自动恢复/.test(line)).length, before);
  fault.taskRecovery.recoveryResult = 'recovered'; fault.taskRecovery.nextRetryAt = 0;
  await waitFor(() => logs.some(line => /catalog:unit-2.*attempt=2.*result=recovered/.test(line)));
});

test('emergency pause never overwrites a checkpoint acquired by another course tab', async t => {
  const { page, commands, states, fault, url } = await fixture(t);
  const owner = await page.context().newPage(); await owner.goto(url);
  t.after(async () => { await owner.evaluate(() => window.releaseFixtureOwner?.()).catch(() => {}); });
  fault.afterReload = async () => {
    await owner.evaluate(() => {
      navigator.locks.request('szu-uooc:course:123', { ifAvailable: true }, async lock => {
        if (!lock) return;
        localStorage.setItem('szu-uooc:course-state:123', JSON.stringify({ active: true, sourceId: 'new-owner', marker: 'owned-by-another-tab' }));
        window.fixtureOwnerHeld = true;
        await new Promise(resolve => { window.releaseFixtureOwner = resolve; });
      });
    });
    await waitFor(() => owner.evaluate(() => window.fixtureOwnerHeld));
  };
  await page.evaluate(() => { delete window.szuUoocDebug.stopCourse; document.querySelector('[data-action="course-stop"]').remove(); });
  commands.emit('message', { type: 'command', action: 'pause' });
  await waitFor(() => states.at(-1).phase === 'paused' && states.at(-1).error === '用户暂停');
  const saved = await owner.evaluate(() => JSON.parse(localStorage.getItem('szu-uooc:course-state:123')));
  assert.equal(saved.active, true); assert.equal(saved.marker, 'owned-by-another-tab');
  fault.afterReload = null;
});

test('a pause whose checkpoint write fails cannot restart after storage recovers and the user reloads', async t => {
  const { page, commands, states, fault } = await fixture(t, { recovery: { pollMs: 2000 } });
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('szu-uooc:course-state:123')).active), true);
  await page.evaluate(() => {
    window.fixtureOriginalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'szu-uooc:course-state:123') throw new DOMException('fixture checkpoint storage unavailable', 'QuotaExceededError');
      return window.fixtureOriginalSetItem.call(this, key, value);
    };
  });
  const before = fault.reloads;
  commands.emit('message', { type: 'command', action: 'pause' });
  await waitFor(() => states.at(-1).phase === 'paused' && states.at(-1).error === '用户暂停');
  await page.evaluate(() => { if (window.fixtureOriginalSetItem) Storage.prototype.setItem = window.fixtureOriginalSetItem; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await page.evaluate(() => JSON.parse(document.querySelector('#szu-uooc-course-state')?.textContent || '{}').active === true), false, 'restoring storage and refreshing cannot revive a manually paused runner');
  assert.equal(fault.reloads, before + 2, 'an unpersisted pause must first destroy the managed document');
  assert.equal(page.isClosed(), false);
});
