const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const script = fs.readFileSync(`${__dirname}/../szu-uooc.user.js`, 'utf8');
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) }); });
after(async () => { await browser?.close(); });

for (const mode of ['paragraphs', 'blocks', 'multiple', 'judgement', 'numeric-key', 'string-options', 'reordered-model', 'quoted-code', 'quoted-line-continuation', 'quoted-nbsp', 'multiline-bank', 'multiline-div-bank', 'duplicate-text', 'missing-value', 'missing-key', 'duplicate-key', 'wrong-key', 'duplicate-control-value', 'unsynced-model']) test('native option mapping: ' + mode, async t => {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8">' }));
  await page.goto('https://www.uooc.net.cn/exam/901#/123/1/2/900/section');
  await page.evaluate(mode => {
    const source = { id: '900', task_id: '901', type: 80, is_task: '1', finished: '0', name: 'Rich text fixture' };
    const root = { chapterList: [{ id: '1', children: [{ id: '2', unitSource: [source] }] }] };
    const service = { getUnitLearn: async () => [{ ...source }] };
    const route = { params: { courseId: '123', chapterId: '1', sectionId: '2', sourceId: '900' } };
    const injector = { get: name => ({ $rootScope: root, courseService: service, $state: route })[name] };
    const question = { type: '10', options: [{ key: 'native-correct', keyText: 'C', text: '<p>First line</p><p>Second line</p>' }, { key: 'native-wrong', keyText: 'A', text: 'Other option' }], student_answer: ['native-wrong'], checked: true };
    if (mode === 'blocks' || mode === 'multiline-div-bank') question.options[0].text = '<div>First line</div><div>Second line</div>';
    if (mode === 'quoted-code') { question.options[0].text = 'printf("a  b");'; question.options[1].text = 'printf("a b");'; }
    if (mode === 'quoted-line-continuation') { question.options[0].text = 'printf("a\\\n  b");'; question.options[1].text = 'printf("a\\\nb");'; }
    if (mode === 'quoted-nbsp') { question.options[0].text = 'printf("a\u00a0b");'; question.options[1].text = 'printf("a b");'; }
    if (mode === 'multiple') { question.type = '11'; question.options.push({ key: 'native-third', keyText: 'B', text: '<ul><li>Third</li><li>option</li></ul>' }); }
    if (mode === 'judgement') question.type = '20';
    if (mode === 'numeric-key') question.options[0].key = 0;
    if (mode === 'string-options') { question.options.forEach((option, index) => { option.key = index; }); question.student_answer = ['1']; }
    if (mode === 'duplicate-text') question.options[1].text = question.options[0].text;
    const vmScope = { vcode_params: {}, vm: { task: { id: '901', type: 10 }, commitCalls: 0, finalClicks: 0, commitTask() {
      this.commitCalls++;
      const dialog = document.createElement('div'); dialog.id = 'commitConfirmDialog';
      dialog.innerHTML = '<button ng-click="vm.doCommitTask()">提交</button><button ng-click="vm.cancelCommitTask()">取消</button>';
      dialog.firstElementChild.onclick = () => { this.finalClicks++; };
      dialog.lastElementChild.onclick = () => dialog.remove();
      document.body.appendChild(dialog);
    } } };
    const group = document.createElement('section'); group.className = 'queItems';
    group.innerHTML = '<div class="queItems-type">单选题</div><div class="queContainer"><div class="ti-q-c">Choose the first option</div></div>';
    const container = group.querySelector('.queContainer');
    container.__scope = { question, $parent: vmScope, $applyAsync() {} };
    question.options.forEach(option => {
      const label = document.createElement('label'); label.className = 'ti-a';
      label.innerHTML = `<span class="ti-a-i">${option.keyText}</span><input type="${question.type === '11' ? 'checkbox' : 'radio'}" name="q1" value="${option.key}"><span class="ti-a-c">${option.text}</span>`;
      const input = label.querySelector('input'); input.checked = question.student_answer.includes(String(option.key));
      input.onchange = () => { if (mode !== 'unsynced-model') { question.student_answer = [...container.querySelectorAll('input:checked')].map(node => node.value); question.checked = question.student_answer.length > 0; } };
      container.appendChild(label);
    });
    const inputs = container.querySelectorAll('input');
    if (mode === 'missing-value') inputs[0].removeAttribute('value');
    if (mode === 'missing-key') delete question.options[0].key;
    if (mode === 'duplicate-key') question.options[1].key = question.options[0].key;
    if (mode === 'wrong-key') inputs[0].value = 'unknown-key';
    if (mode === 'duplicate-control-value') inputs[1].value = inputs[0].value;
    if (mode === 'reordered-model') question.options.reverse();
    if (mode === 'string-options') question.options = question.options.map(option => option.text);
    document.body.appendChild(group);
    window.angular = { element: node => ({ injector: () => injector, scope: () => node.__scope }) };
    localStorage.setItem('szu-uooc:auto-player:config', JSON.stringify({ aiBaseUrl: 'https://fixture.invalid/v1', aiModel: 'fixture-model', aiInputPrice: 0, aiCachedInputPrice: 0, aiOutputPrice: 0, aiBudget: 1 }));
    const bank = { questions: [{ question: 'Choose the first option', type: '单选题', options: [{ text: 'First line\nSecond line' }, { text: 'Other option' }], answers: ['First line\nSecond line'] }] };
    window.GM_getValue = (key, fallback) => key === 'szu-uooc:answer-bank' && mode.startsWith('multiline-') ? JSON.stringify(bank) : key === 'szu-uooc:ai-api-key' ? 'fixture-private-key' : fallback;
    window.GM_setValue = () => {};
    let aiCalls = 0;
    window.GM_xmlhttpRequest = details => {
      aiCalls++;
      details.onload({ status: 200, responseText: JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ answers: [{ index: 0, option_indices: mode === 'multiple' ? [0, 2] : [0] }] }) }] }], usage: { input_tokens: 1, output_tokens: 1 } }) });
    };
    window.__fixture = { question, vmScope, get aiCalls() { return aiCalls; } };
  }, mode);
  await page.addScriptTag({ content: script });
  await page.locator('[data-action="course-start"]').click();
  await page.waitForFunction(() => ['paused', 'awaiting_verification'].includes(JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase), null, { timeout: 5000 });
  const state = JSON.parse(await page.locator('#szu-uooc-course-state').textContent());
  const invalid = ['duplicate-text', 'missing-value', 'missing-key', 'duplicate-key', 'wrong-key', 'duplicate-control-value', 'unsynced-model'].includes(mode);
  assert.equal(state.phase, invalid ? 'paused' : 'awaiting_verification', state.error);
  assert.equal(await page.evaluate(() => window.__fixture.aiCalls), mode.startsWith('multiline-') ? 0 : 1);
  assert.equal(await page.evaluate(() => window.__fixture.vmScope.vm.commitCalls), invalid ? 0 : 1);
  assert.equal(await page.evaluate(() => window.__fixture.vmScope.vm.finalClicks), 0);
  if (invalid) {
    assert.match(state.error, /唯一|控件缺失|尚未同步/);
    assert.deepEqual(await page.evaluate(() => window.__fixture.question.student_answer), ['native-wrong']);
    assert.equal(state.pendingSubmit, false);
  } else {
    const expected = mode === 'multiple' ? ['native-correct', 'native-third'] : [mode === 'numeric-key' || mode === 'string-options' ? '0' : 'native-correct'];
    assert.deepEqual(await page.evaluate(() => window.__fixture.question.student_answer), expected);
    await page.locator('[data-action="course-stop"]').click();
    const stopped = JSON.parse(await page.locator('#szu-uooc-course-state').textContent());
    await page.locator('[data-action="course-start"]').click();
    await page.waitForFunction(runId => { const current = JSON.parse(document.querySelector('#szu-uooc-course-state').textContent); return current.runId !== runId && ['paused', 'awaiting_verification'].includes(current.phase); }, stopped.runId, { timeout: 5000 });
    const resumed = JSON.parse(await page.locator('#szu-uooc-course-state').textContent());
    assert.equal(resumed.phase, 'awaiting_verification', 'cached resume: ' + resumed.error);
    assert.equal(await page.evaluate(() => window.__fixture.aiCalls), mode.startsWith('multiline-') ? 0 : 1, 'resume must reuse bank or cached answers');
    await page.locator('[data-action="course-stop"]').click();
  }
});
