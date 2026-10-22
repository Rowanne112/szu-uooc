const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const script = fs.readFileSync(`${__dirname}/../szu-uooc.user.js`, 'utf8');
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const courseState = page => page.locator('#szu-uooc-course-state').textContent().then(JSON.parse);

async function fixture(browser, mode, context) {
  const page = context ? await context.newPage() : await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><video></video>' }));
  await page.goto('https://www.uooc.net.cn/home/learn/#/123/1/2/500/section');
  await page.evaluate(mode => {
    // Advance browser deadlines and timers together; production code runs unchanged.
    const now = Date.now, base = now(), timeout = window.setTimeout, interval = window.setInterval;
    Date.now = () => base + (now() - base) * 50;
    window.setTimeout = (callback, ms, ...args) => timeout(callback, Math.max(1, ms / 50), ...args);
    window.setInterval = (callback, ms, ...args) => interval(callback, Math.max(1, ms / 50), ...args);
    const source = { id: '500', type: mode === 'quiz-pending' ? 80 : 10, is_task: '1', task_id: '901', finished: '0', name: 'Recovery fixture' };
    const unit = { id: '2' }, root = { chapterList: [{ id: '1', children: [unit] }] };
    let calls = 0, late, navigations = 0, loads = 0, time = 0;
    const sources = [source];
    if (mode === 'locked-refresh') {
      root.chapterList[0].children.push({ id: '3' });
      for (let id = 501; id <= 503; id++) sources.push({ ...source, id: String(id) });
    }
    let lockedCalls = 0;
    const service = { getUnitLearn(request) {
      calls++;
      if (mode === 'locked-refresh' && request.catalog_id === '3') {
        lockedCalls++;
        if (sources.some(s => s.finished !== '1')) throw { code: 600, msg: '本章为闯关模式，请先完成之前的视频和测验，再开始本节学习！' };
        return Promise.resolve([{ ...source, id: '600', finished: '0' }]);
      }
      if (mode === 'unauthorized') throw { code: 401, msg: '请重新登录' };
      if (mode === 'persistent') return Promise.reject({ status: 503, msg: '服务器暂不可用' });
      if (calls === 1 && mode === 'network') return Promise.reject(new TypeError('Failed to fetch'));
      if (calls === 1 && ['timeout', 'late'].includes(mode)) return new Promise(resolve => { late = resolve; });
      return Promise.resolve(sources.map(s => ({ ...s })));
    } };
    const stateService = { params: { courseId: '123', chapterId: '1', sectionId: '2', sourceId: mode.startsWith('navigation') ? '999' : '500' }, go: async (_name, params) => {
      navigations++;
      if (navigations === 1 && mode === 'navigation-timeout') await new Promise(() => {});
      if (navigations === 1 && mode === 'navigation-network') throw { status: 503, msg: 'temporarily unavailable' };
      Object.assign(stateService.params, params);
      history.replaceState(null, '', '/home/learn/#/123/1/2/' + params.sourceId + '/section');
    } };
    if (mode.startsWith('navigation')) history.replaceState(null, '', '/home/learn/#/123/1/2/999/section');
    if (mode.startsWith('media') || mode === 'position') {
      const video = document.querySelector('video');
      Object.defineProperties(video, { currentTime: { get: () => time, set: value => { time = value; } }, duration: { get: () => 100 }, readyState: { get: () => 2 }, src: { get: () => 'https://www.uooc.net.cn/fixture.mp4' }, currentSrc: { get: () => 'https://www.uooc.net.cn/fixture.mp4' } });
      video.play = () => Promise.resolve();
      video.load = () => { loads++; if (mode === 'media-once') window.setInterval(() => { time += 1; }, 1000); };
      if (mode === 'position') localStorage.setItem('szu-uooc:course-state:123', JSON.stringify({ active: true, videoPosition: { sourceId: '500', time: 17 } }));
      if (mode === 'media-spent') localStorage.setItem('szu-uooc:course-state:123', JSON.stringify({ active: true, recoveryCounts: { 'media:500': 2 } }));
    }
    const injector = { get: name => name === '$rootScope' ? root : name === 'courseService' ? service : name === '$state' ? stateService : null };
    window.angular = { element: node => ({ injector: () => injector, scope: () => node.__scope || root }) };
    const bank = { questions: [] };
    if (mode === 'quiz-pending') {
      history.replaceState(null, '', '/exam/901#/123/1/2/500/section');
      const group = document.createElement('section'); group.className = 'queItems';
      group.innerHTML = '<div class="queItems-type">单选题</div><div class="queContainer"><div class="ti-q-c">Fixture question</div><label class="ti-a"><span class="ti-a-i">A</span><input type="radio" value="a"><span class="ti-a-c">Correct</span></label></div>';
      const question = { type: '10', options: [{ text: 'Correct', key: 'a' }], student_answer: [], checked: false };
      const vmScope = { vcode_params: { captchaVerifyParam: 'fixture-result' }, vm: { task: { id: '901', type: 10 }, commitTask() {
        const dialog = document.createElement('div'); dialog.id = 'commitConfirmDialog';
        dialog.innerHTML = '<button ng-click="vm.doCommitTask()">提交</button>';
        document.body.appendChild(dialog);
      } } };
      group.querySelector('.queContainer').__scope = { question, $parent: vmScope, $applyAsync() {} };
      group.querySelector('input').onchange = () => { question.student_answer = ['a']; question.checked = true; };
      document.body.appendChild(group);
      bank.questions.push({ question: 'Fixture question', type: '单选题', options: [{ text: 'Correct' }], answers: ['Correct'] });
    }
    window.GM_getValue = (key, fallback) => key === 'szu-uooc:answer-bank' ? JSON.stringify(bank) : fallback;
    window.GM_setValue = () => {};
    window.GM_xmlhttpRequest = () => { throw new Error('Recovery tests must not call AI'); };
    if (mode === 'corrupt') localStorage.setItem('szu-uooc:course-state:123', '{"active":true,"pendingSubmit":');
    if (mode === 'invalid-pending') localStorage.setItem('szu-uooc:course-state:123', JSON.stringify({ active: true, pendingSubmit: { courseId: 'wrong', sourceId: '500' } }));
    if (mode === 'storage-fail') { const save = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'szu-uooc:course-state:123') throw new Error('fixture storage unavailable'); return save.call(this, key, value); }; }
    if (mode === 'unsupported-lock') Object.defineProperty(navigator, 'locks', { value: undefined });
    window.__fixture = { root, unit, service, stateService, get calls() { return calls; }, get lockedCalls() { return lockedCalls; }, finishVideo() { sources.find(s => s.id === stateService.params.sourceId).finished = '1'; document.querySelector('video').dispatchEvent(new Event('ended')); }, get navigations() { return navigations; }, get loads() { return loads; }, resolveLate() { late?.([{ ...source, id: 'obsolete', finished: '1' }]); } };
  }, mode);
  await page.addScriptTag({ content: script });
  return page;
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  try {
    const locked = await fixture(browser, 'locked-refresh');
    await locked.locator('[data-action="course-start"]').click();
    for (let id = 500; id <= 503; id++) {
      await locked.waitForFunction(id => { const s = JSON.parse(document.querySelector('#szu-uooc-course-state').textContent); return s.phase === 'paused' || s.phase === 'video' && s.sourceId === String(id); }, id, { timeout: 3000 });
      assert.equal((await courseState(locked)).active, true, 'a known locked unit must not exhaust the network retry budget on later catalog scans: ' + JSON.stringify(await courseState(locked)));
      await locked.evaluate(() => window.__fixture.finishVideo());
    }
    await locked.waitForFunction(() => { const s = JSON.parse(document.querySelector('#szu-uooc-course-state').textContent); return s.phase === 'paused' || s.sourceId === '600' && s.phase === 'video'; }, null, { timeout: 3000 });
    assert.equal((await courseState(locked)).sourceId, '600', 'the newly unlocked video must run instead of ending at the old partial total');
    assert.equal((await courseState(locked)).completed, 4);
    assert.equal((await courseState(locked)).total, 5);
    assert.equal((await courseState(locked)).lockedUnits, 0);
    assert(await locked.evaluate(() => window.__fixture.lockedCalls >= 5));
    await locked.close();
    for (const mode of ['network', 'timeout']) {
      const page = await fixture(browser, mode);
      await page.locator('[data-action="course-start"]').click();
      await page.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'video', null, { timeout: 3000 }).catch(async error => { throw new Error(`${mode}: ${JSON.stringify(await courseState(page))}; ${error.message}`); });
      assert.equal(await page.evaluate(() => window.__fixture.calls), 2, mode + ' automatically recovers the idempotent read');
      await page.locator('[data-action="course-stop"]').click();
      await page.close();
    }
    for (const mode of ['persistent', 'unauthorized']) {
      const page = await fixture(browser, mode);
      await page.locator('[data-action="course-start"]').click();
      await page.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'paused', null, { timeout: 3000 });
      assert.equal(await page.evaluate(() => window.__fixture.calls), mode === 'persistent' ? 3 : 1, 'persistent faults are bounded and authentication is never blindly retried');
      const state = await courseState(page);
      assert.match(state.error, mode === 'persistent' ? /失败|重试|503/ : /登录|401/);
      await page.waitForTimeout(150);
      assert.equal((await courseState(page)).active, false);
      await page.close();
    }
    for (const mode of ['navigation-network', 'navigation-timeout']) {
      const page = await fixture(browser, mode);
      await page.locator('[data-action="course-start"]').click();
      await page.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'video', null, { timeout: 3000 });
      assert.equal(await page.evaluate(() => window.__fixture.navigations), 2, 'the failed native route is retried within a bounded timeout');
      await page.close();
    }
    for (const mode of ['media-once', 'media-persistent', 'media-spent']) {
      const page = await fixture(browser, mode);
      if (mode !== 'media-spent') await page.locator('[data-action="course-start"]').click();
      if (mode === 'media-once') {
        await page.waitForFunction(() => document.querySelector('video').currentTime >= 1, null, { timeout: 3000 });
        assert.equal((await courseState(page)).phase, 'video');
        assert.equal(await page.evaluate(() => window.__fixture.loads), 1, 'a transient media stall reloads the current native player once');
      } else {
        await page.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'paused', null, { timeout: 4000 });
        assert.equal(await page.evaluate(() => window.__fixture.loads), mode === 'media-spent' ? 0 : 1, 'media budget survives a fresh userscript instance');
        assert.equal(await page.evaluate(() => window.__fixture.navigations), mode === 'media-spent' ? 0 : 1, 'second media recovery reopens the same native resource, then stops');
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('szu-uooc:course-state:123')).recoveryCounts['media:500']), 2);
      }
      await page.close();
    }
    const resumed = await fixture(browser, 'position');
    await resumed.waitForFunction(() => document.querySelector('video').currentTime === 17, null, { timeout: 3000 });
    assert.equal((await courseState(resumed)).completed, 0, 'restored observed position never fabricates completion');
    await resumed.evaluate(() => { document.querySelector('video').currentTime = 3; });
    await resumed.waitForTimeout(100);
    assert.equal(await resumed.evaluate(() => document.querySelector('video').currentTime), 3, 'an intentional rewind after restoration remains under user control');
    await resumed.close();
    for (const mode of ['corrupt', 'invalid-pending', 'storage-fail']) {
      const page = await fixture(browser, mode);
      const before = await page.evaluate(() => localStorage.getItem('szu-uooc:course-state:123'));
      if (mode === 'storage-fail') await page.locator('[data-action="course-start"]').click();
      await page.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'paused', null, { timeout: 3000 });
      assert.match((await courseState(page)).error, /断点.*失败/);
      assert.equal(await page.evaluate(() => window.__fixture.calls), 0, 'corrupt or unsavable state blocks new work before any server request');
      assert.equal(await page.evaluate(() => localStorage.getItem('szu-uooc:course-state:123')), before, 'the unresolved record is preserved exactly');
      await page.close();
    }
    const unsavableStop = await fixture(browser, 'network');
    await unsavableStop.locator('[data-action="course-start"]').click();
    await unsavableStop.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'video');
    await unsavableStop.evaluate(() => {
      window.__pausedOnStop = 0;
      document.querySelector('video').pause = () => { window.__pausedOnStop++; };
      Storage.prototype.setItem = () => { throw new Error('fixture all storage unavailable'); };
      document.querySelector('[data-action="course-stop"]').remove();
      window.szuUoocDebug.stopCourse();
    });
    assert.equal((await courseState(unsavableStop)).active, false, 'safe stop publishes despite missing controls and completely broken storage');
    assert.match((await courseState(unsavableStop)).error, /配置保存失败/);
    assert.equal(await unsavableStop.evaluate(() => window.__pausedOnStop), 1, 'persistence failure cannot prevent native playback pause');
    await unsavableStop.close();
    const unsupported = await fixture(browser, 'unsupported-lock');
    await unsupported.locator('[data-action="course-start"]').click();
    await unsupported.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'paused');
    assert.match((await courseState(unsupported)).error, /Web Locks/);
    assert.equal(await unsupported.evaluate(() => window.__fixture.calls), 0);
    await unsupported.close();
    const shared = await browser.newContext();
    const first = await fixture(browser, 'media-once', shared);
    await first.locator('[data-action="course-start"]').click();
    await first.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'video');
    const second = await fixture(browser, 'quiz-pending', shared);
    await second.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'paused');
    assert.match((await courseState(second)).error, /其他标签/);
    assert.equal(await second.evaluate(() => window.__fixture.calls), 0, 'an occupied course lock blocks the second tab before platform requests');
    assert.equal((await courseState(first)).active, true);
    assert.equal(await first.evaluate(() => JSON.parse(localStorage.getItem('szu-uooc:course-state:123')).active), true, 'a rejected tab must not overwrite the owner checkpoint');
    await first.locator('[data-action="course-stop"]').click();
    await first.evaluate(() => {
      const save = Storage.prototype.setItem; window.__obsoleteCheckpointWrites = 0;
      Storage.prototype.setItem = function(key, value) { if (key === 'szu-uooc:course-state:123') window.__obsoleteCheckpointWrites++; return save.call(this, key, value); };
    });
    await second.locator('[data-action="course-start"]').click();
    await second.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).pendingSubmit === true);
    await second.waitForTimeout(150);
    assert.equal(await first.evaluate(() => window.__obsoleteCheckpointWrites), 0, 'a former owner must never write the new owner checkpoint after releasing its lock');
    const ownerCheckpoint = await second.evaluate(() => JSON.parse(localStorage.getItem('szu-uooc:course-state:123')));
    assert.equal(ownerCheckpoint.active, true);
    assert.equal(ownerCheckpoint.pendingSubmit.task_id, '901', 'several old-tab scans cannot erase a new native submission journal');
    assert.equal((await courseState(first)).active, false);
    await shared.close();
    const page = await fixture(browser, 'late');
    await page.locator('[data-action="course-start"]').click();
    await page.waitForFunction(() => window.__fixture.calls === 1);
    await page.locator('[data-action="course-stop"]').click();
    await page.locator('[data-action="course-start"]').click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'video', null, { timeout: 3000 });
    await page.evaluate(() => window.__fixture.resolveLate());
    await page.waitForTimeout(100);
    assert.equal((await courseState(page)).phase, 'video', 'a cancelled old request cannot pause the replacement run');
    assert.equal(await page.evaluate(() => window.__fixture.unit.unitSource[0].id), '500', 'late responses cannot overwrite the active catalog');
    await page.close();
    console.log('课程恢复：网络断开/无响应与导航超时自动恢复，持续503有限退避，401安全暂停，媒体重载→原生重开→耗尽暂停，恢复预算跨刷新，播放断点不冒充完成，停止后迟到响应不污染新任务。无真实平台或付费请求。');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
