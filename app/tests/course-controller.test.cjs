const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const script = fs.readFileSync(`${__dirname}/../szu-uooc.user.js`, 'utf8');
assert.match(script, /const COURSE_AI_EXTRA_INPUT_RESERVE = 16384;/, 'budget reservation includes the measured hidden provider prefix plus headroom');
assert.match(script, /entry\.input_tokens > maxInputTokens \|\| entry\.output_tokens > maxOutputTokens/, 'over-limit returned usage is accounted then rejected before answer resolution');
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageWithQuiz(browser, taskType = 10, autoSuccess = false, nextUnit = '', navMode = '', fillMode = '') {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body></body></html>' }));
  await page.goto('https://www.uooc.net.cn/exam/901#/123/1/2/900/section', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await page.evaluate(({ taskType, autoSuccess, nextUnit, fillMode }) => {
    const questions = [
      { type: '10', question: 'Choose one', answers: ['Single A'], options: [['Single A', 'a'], ['Single a', 'aa'], ['Single B', 'b']], wrong: ['b'] },
      { type: '11', question: 'Choose two', answers: ['Multi A', 'Multi C'], options: [['Multi A', 'a'], ['Multi B', 'b'], ['Multi C', 'c']], wrong: ['b'] },
      { type: '30', question: 'Fill both blanks', answers: ['first text', 'second text'], options: [], wrong: ['stale', ''] },
    ];
    const imageMode = fillMode.startsWith('image');
    const choiceMode = fillMode.startsWith('choice');
    if (fillMode === 'choice-duplicate-text') questions[0].options[1][0] = 'Single A';
    if (imageMode) {
      const first = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAIAAABiouoDAAAAa0lEQVR4nO3YwQmAMBQFQSux/6LsRSvQJYePCrPk/BLmmO3UY9vbD/h6gCJAEaAIUAQoAhTdAh37vnRWL/7LPiBAgEb3AQECNLoPCBCg0X1AgACN7gMCBGh034dZBCgCFAGKAEWAIkARoOgCH+Euw7zVA+AAAAAASUVORK5CYII=';
      const second = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIA3CQxWwAAAABJRU5ErkJggg==';
      questions.splice(0, questions.length, { type: '10', question: fillMode === 'image-svg' ? 'Read <svg><path d="M0 0h10"/></svg>' : fillMode === 'image-lazy' ? 'Read <img src="' + second + '" data-src="' + first + '">' : 'Read <img src="' + (fillMode === 'image-fail' ? 'data:text/plain,broken' : first) + '">', answers: ['[选项C图片1]'], options: [['<img src="' + first + '">', 'a'], ['<img src="' + second + '">', 'b']], wrong: ['b'] });
    }
    if (fillMode && !imageMode && !choiceMode) questions.splice(0, questions.length, {
      type: '30', question: 'Complete the code and repeat the type',
      answers: ['printf("Hello  world\\n");\nreturn 0;', 'int', 'int', 'left\r\nright'],
      options: [], wrong: ['printf("Hello world\\n");\nreturn 0;', 'wrong', '', ''],
    });
    const qnodes = [];
    const root = { chapterList: [{ id: '1', children: [{ id: '2', unitSource: [{ id: '900', task_id: '901', type: 80, is_task: '1', finished: '0', name: 'Quiz fixture' }] }] }] };
    if (nextUnit) root.chapterList[0].children.push({ id: '3' });
    let serverFinished = false, successAcknowledged = false, serviceCalls = 0, nextRequests = 0;
    const serverSources = root.chapterList[0].children[0].unitSource.map((source) => ({ ...source }));
    const service = { getUnitLearn: async (request) => {
      serviceCalls++;
      if (request?.catalog_id === '3') {
        nextRequests++;
        if (nextUnit === 'unpublished') throw { code: 600, msg: '该章节未发布资源' };
        if (nextUnit === 'fail') throw { code: 401, msg: '其他读取失败' };
        if (!serverFinished || nextUnit === 'locked') throw { code: 600, msg: '本章为闯关模式，请先完成之前的视频和测验，再开始本节学习！' };
        return [{ id: '902', type: 10, finished: '1', name: 'Unlocked video fixture' }];
      }
      return serverSources.map((source) => ({ ...source, finished: serverFinished ? '1' : source.finished }));
    } };
    const vmScope = { vcode_params: {}, vm: { task: { id: 901, type: taskType }, commitCalls: 0, finalClicks: 0, cancelClicks: 0, commitTask() {
      this.commitCalls += 1;
      vmScope.vcode_params = {};
      const dialog = document.createElement('div'); dialog.id = 'commitConfirmDialog';
      dialog.innerHTML = '<div ng-click="vm.doCommitTask()" class="btn btn-warning">提交</div><a ng-click="vm.cancelCommitTask()" class="btn btn-success" data-action="cancel">取消</a>';
      dialog.querySelector('[ng-click="vm.doCommitTask()"]').addEventListener('click', () => {
        this.finalClicks++;
        dialog.remove();
        if (autoSuccess) {
          serverFinished = true;
          serverSources[0].finished = '1';
          if (autoSuccess === 'closed') return;
          const success = document.createElement('div'); success.innerHTML = '<div class="layui-layer-content">测验通过，可以继续后面的学习</div><button class="layui-layer-btn0">完成</button>';
          success.querySelector('.layui-layer-btn0').addEventListener('click', () => { successAcknowledged = true; });
          document.body.appendChild(success);
        }
      });
      dialog.querySelector('[data-action=cancel]').addEventListener('click', () => { this.cancelClicks++; dialog.remove(); });
      document.body.appendChild(dialog);
    } } };
    const stateService = { params: { courseId: '123', chapterId: '1', sectionId: '2', sourceId: '900' }, go: async (_name, params) => { Object.assign(stateService.params, params); } };
    const injector = { get(name) { return name === '$rootScope' ? root : name === 'courseService' ? service : name === '$state' ? stateService : null; } };
    window.angular = {
      element(node) { return { injector: () => injector, scope: () => node.__scope }; },
    };
    const bank = { questions: [] };
    for (const spec of questions) {
      bank.questions.push({ question: spec.question, type: spec.type === '10' ? '单选题' : spec.type === '11' ? '多选题' : '填空题', options: spec.options.map(([text]) => ({ text })), answers: spec.answers });
      if (fillMode === 'conflict') bank.questions.push({ question: spec.question, type: '填空题', options: [], answers: spec.answers.map(value => value.replace('Hello  world', 'Hello world')) });
      if (fillMode === 'count') bank.questions[0].answers = ['one answer'];
      if (fillMode === 'empty') bank.questions[0].answers = [' ', 'int', 'int', 'left\r\nright'];
      if (spec.type === '10') bank.questions.push({ question: spec.question, type: '单选题', options: spec.options.map(([text]) => ({ text })), answers: spec.answers });
      const group = document.createElement('section'); group.className = 'queItems';
      const type = spec.type === '10' ? '单选题' : spec.type === '11' ? '多选题' : '填空题';
      group.innerHTML = `<div class="queItems-type">${type}</div><div class="queContainer"><span class="index">1.</span><div class="ti-q-c">${spec.question}</div></div>`;
      const container = group.querySelector('.queContainer');
      const question = { type: spec.type, options: spec.options.map(([text, key], index) => ({ text: `<p>${text}<br/></p>` + (!imageMode && spec.type === '10' && key === 'a' ? '<img src="https://option-image.test/missing" onerror="window.__rawOptionExecuted=true">' : ''), key, keyText: String.fromCharCode(67 - index) })), student_answer: spec.wrong.slice(), checked: spec.type !== '30' };
      if (spec.type !== '30') {
        for (const [text, key] of spec.options) {
          const option = document.createElement('label'); option.className = 'ti-a';
          option.innerHTML = `<span class="ti-a-i">${question.options.find((item) => item.key === key).keyText}</span><input type="${spec.type === '11' ? 'checkbox' : 'radio'}" name="q-${qnodes.length}" value="${key}"><span class="ti-a-c">${text}</span>`;
          const input = option.querySelector('input'); input.checked = spec.wrong.includes(key);
          input.addEventListener('change', () => {
            question.student_answer = spec.options.filter(([, k]) => Array.from(container.querySelectorAll('input')).find((n) => n.value === k)?.checked).map(([, k]) => k);
            question.checked = question.student_answer.length > 0;
          });
          container.appendChild(option);
        }
      } else {
        spec.answers.forEach((_, index) => {
          const field = document.createElement('textarea'); field.value = spec.wrong[index] || ''; container.appendChild(field);
          const sync = () => {
            const values = Array.from(container.querySelectorAll('textarea')).map((node) => node.value);
            question.student_answer = fillMode === 'collapsed-model' ? values.map(value => value.replace(/\s+/g, ' ').trim()) : values;
            question.checked = values.every((value) => value.trim());
          };
          field.setAttribute('ng-mouseleave', 'vm.addAnswer($event,question)');
          field.addEventListener('mouseout', (event) => {
            if (!field.contains(event.relatedTarget)) sync();
          });
        });
      }
      const scope = { question, $parent: vmScope, $applyAsync() {} }; container.__scope = scope; qnodes.push({ container, question }); document.body.appendChild(group);
    }
    let aiCalls = 0;
    const aiMode = imageMode || choiceMode || ['ai', 'ai-count'].includes(fillMode);
    if (aiMode || fillMode === 'cache') bank.questions.length = 0;
    if (aiMode) localStorage.setItem('szu-uooc:auto-player:config', JSON.stringify({ aiBaseUrl: 'https://fixture-api.invalid/v1', aiModel: 'fixture-model', aiInputPrice: 0, aiCachedInputPrice: 0, aiOutputPrice: 0, aiBudget: 1, ...(fillMode === 'image-free' ? { courseAnswerMode: 'free' } : {}), ...(fillMode === 'image-unavailable' ? { aiManaged: true, aiServiceReady: true, aiVisionModel: '' } : {}) }));
    if (fillMode === 'cache') localStorage.setItem('szu-uooc:answers:123:' + JSON.stringify(['Complete the code and repeat the type', '30', [], 4]), JSON.stringify({ answers: questions[0].answers, source: 'AI' }));
    window.__fixture = { root, stateService, service, vmScope, qnodes, get aiCalls() { return aiCalls; }, get serviceCalls() { return serviceCalls; }, get nextRequests() { return nextRequests; }, get successAcknowledged() { return successAcknowledged; }, setVerified() { vmScope.vcode_params.captchaVerifyParam = 'fixture-real-result'; }, markFinished() { serverFinished = true; serverSources[0].finished = '1'; root.chapterList[0].children[0].unitSource[0].finished = '1'; } };
    window.GM_getValue = (key, fallback) => key === 'szu-uooc:answer-bank' ? JSON.stringify(bank) : key === 'szu-uooc:ai-api-key' && aiMode ? 'fixture-local-key' : fallback;
    window.GM_setValue = () => {};
    window.GM_xmlhttpRequest = details => {
      if (!aiMode) throw new Error('fixture must not call the paid API');
      aiCalls++;
      if (imageMode) {
        const payload = JSON.parse(details.data);
        window.__fixture.imagePayload = payload.input;
        if (!Array.isArray(payload.input) || payload.input[0].content.filter(p => p.type === 'input_image').length !== 3) throw new Error('all stem/option images must be transmitted');
      }
      const answers = fillMode === 'ai-count' ? ['one answer'] : questions[0].answers;
      let entries = [{ index: 0, answers }];
      if (choiceMode) {
        const prompt = JSON.parse(details.data).input;
        window.__fixture.aiPrompt = prompt;
        const indexed = prompt.includes('option_indices');
        entries = questions.map((spec, index) => spec.type === '30' || fillMode === 'choice-legacy' ? { index, answers: spec.answers } : indexed ? { index, option_indices: spec.type === '11' ? [0, 2] : [0] } : { index, answers: spec.answers.map(text => 'C. ' + text) });
        const invalid = { 'choice-duplicate-index': [0, 0], 'choice-range-index': [3], 'choice-negative-index': [-1], 'choice-string-index': ['0'], 'choice-fraction-index': [0.5], 'choice-empty-index': [], 'choice-null-index': null };
        if (Object.hasOwn(invalid, fillMode)) entries[1] = { index: 1, option_indices: invalid[fillMode], answers: questions[1].answers };
        if (fillMode === 'choice-single-many') entries[0] = { index: 0, option_indices: [0, 1] };
        if (fillMode === 'choice-fill-index') entries[2] = { index: 2, option_indices: [0], answers: questions[2].answers };
        if (fillMode === 'choice-unknown-text') entries[0] = { index: 0, answers: ['AI rewrote the option'] };
        if (fillMode === 'choice-reorder') for (const { container } of qnodes) Array.from(container.querySelectorAll('.ti-a')).reverse().forEach(node => container.appendChild(node));
        entries.reverse();
      }
      details.onload({ status: 200, responseText: JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ answers: entries }) }] }], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 } }) });
    };
  }, { taskType, autoSuccess, nextUnit, fillMode });
  if (navMode) await page.evaluate(mode => {
    const fixture = window.__fixture, nodes = [...document.querySelectorAll('.queItems')]; nodes.forEach(node => node.remove());
    fixture.root.lastSource = { id: '900' }; delete fixture.stateService.params.sourceId;
    history.replaceState(null, '', '/home/learn/new/123#/123/1/2');
    fixture.navigationCalls = 0;
    fixture.stateService.go = async (_name, params) => {
      fixture.navigationCalls++;
      if (mode === 'reject') throw new Error('fixture navigation rejected');
      Object.assign(fixture.stateService.params, params); history.replaceState(null, '', '/exam/901#/123/1/2/900/section'); nodes.forEach(node => document.body.appendChild(node));
    };
    const button = document.createElement('button'); button.textContent = '测验'; button.setAttribute('ng-click', 'goSource(source)');
    button.__scope = { source: fixture.root.chapterList[0].children[0].unitSource[0] };
    button.onclick = () => { if (mode === 'click') fixture.stateService.go('main.chapter.section.source', { sourceId: '900' }); };
    document.body.appendChild(button);
  }, navMode);
  await page.addScriptTag({ content: script, timeout: 10000 });
  await page.waitForFunction(() => Boolean(document.querySelector('#szu-uooc-course-state')), null, { timeout: 10000 });
  return page;
}


async function pageWithVideo(browser) {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><video id="player"></video></body></html>' }));
  await page.goto('https://www.uooc.net.cn/home/learn/#/123/1/2/500/section', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    const video = { id: '500', type: 10, finished: '0', name: 'Video fixture' };
    const unit = { id: '2', unitSource: [video] };
    const root = { chapterList: [{ id: '1', children: [unit] }] };
    let finishedOnServer = false, refreshCount = 0;
    const service = { getUnitLearn: async () => { refreshCount += 1; return [{ ...video, finished: finishedOnServer ? '1' : '0' }]; } };
    const stateService = { params: { courseId: '123', chapterId: '1', sectionId: '2', sourceId: '500' }, go: async () => {} };
    const injector = { get(name) { return name === '$rootScope' ? root : name === 'courseService' ? service : name === '$state' ? stateService : null; } };
    window.angular = { element(node) { return { injector: () => injector, scope: () => node.__scope }; } };
    window.GM_getValue = (_key, fallback) => fallback;
    window.GM_setValue = () => {};
    window.__videoFixture = { root, unit, video, service, stateService, get refreshCount() { return refreshCount; }, set finished(value) { finishedOnServer = value; } };
  });
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => Boolean(document.querySelector('#szu-uooc-course-state')), null, { timeout: 10000 });
  return page;
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: chrome, args: ['--no-sandbox'], timeout: 10000 });
  try {
    for (const mode of ['choice-index', 'choice-legacy', 'choice-reorder', 'choice-duplicate-index', 'choice-range-index', 'choice-negative-index', 'choice-string-index', 'choice-fraction-index', 'choice-empty-index', 'choice-null-index', 'choice-single-many', 'choice-fill-index', 'choice-duplicate-text', 'choice-unknown-text']) {
      const choicePage = await pageWithQuiz(browser, 10, false, '', '', mode);
      const before = await choicePage.evaluate(() => window.__fixture.qnodes.map(({ question }) => question.student_answer));
      await choicePage.locator('[data-action="course-start"]').click();
      await choicePage.waitForFunction(() => ['awaiting_verification', 'paused'].includes(JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase), null, { timeout: 5000 });
      const result = JSON.parse(await choicePage.locator('#szu-uooc-course-state').textContent());
      const valid = ['choice-index', 'choice-legacy', 'choice-reorder'].includes(mode);
      assert.equal(result.phase, valid ? 'awaiting_verification' : 'paused', mode + ': ' + result.error);
      assert.equal(await choicePage.evaluate(() => window.__fixture.aiCalls), 1, 'answer mapping never sends an extra paid request');
      if (valid) {
        assert.deepEqual(await choicePage.evaluate(() => window.__fixture.qnodes.map(({ question }) => question.student_answer)), [['a'], ['a', 'c'], ['first text', 'second text']], 'request positions map to native keys despite shuffled display letters, and fill answers retain their order');
        const cached = await choicePage.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('szu-uooc:answers:')).map(key => JSON.parse(localStorage.getItem(key)).answers));
        assert.deepEqual(cached, [['Single A'], ['Multi A', 'Multi C'], ['first text', 'second text']], 'the existing text cache contract is preserved');
        if (mode === 'choice-index') {
          const prompt = await choicePage.evaluate(() => window.__fixture.aiPrompt);
          assert.match(prompt, /option_indices/);
          assert.deepEqual(JSON.parse(prompt.split('题目=')[1])[0].options, [{ index: 0, text: 'Single A' }, { index: 1, text: 'Single a' }, { index: 2, text: 'Single B' }]);
        }
        await choicePage.locator('[data-action="course-stop"]').click();
      } else {
        assert.match(result.error, mode === 'choice-duplicate-text' || mode === 'choice-unknown-text' ? /AI答案无法唯一匹配选项文本/ : /AI选项序号无效/);
        assert.equal(await choicePage.evaluate(() => window.__fixture.vmScope.vm.commitCalls), 0, 'invalid or ambiguous answers never open submission');
        assert.deepEqual(await choicePage.evaluate(() => window.__fixture.qnodes.map(({ question }) => question.student_answer)), before, 'a failed batch cannot partially change the quiz');
        assert.equal(await choicePage.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('szu-uooc:answers:')).length), 0, 'a failed batch cannot cache partial answers');
      }
      await choicePage.close();
    }
    console.log('选择题验收：序号映射、原文兼容、单选多选与填空混合、乱序字母及缓存；无效序号和歧义答案保留暂停保护，均不追加付费请求。');
    for (const mode of ['image', 'image-fail', 'image-unavailable', 'image-free', 'image-lazy', 'image-svg']) {
      const imagePage = await pageWithQuiz(browser, 10, false, '', '', mode);
      await imagePage.locator('[data-action="course-start"]').click();
      await imagePage.waitForFunction(() => ['awaiting_verification','paused'].includes(JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase), null, { timeout: 10000 });
      const result = JSON.parse(await imagePage.locator('#szu-uooc-course-state').textContent());
      assert.equal(result.phase, ['image','image-lazy'].includes(mode) ? 'awaiting_verification' : 'paused', mode + ': ' + result.error);
      assert.equal(await imagePage.evaluate(() => window.__fixture.aiCalls), ['image','image-lazy'].includes(mode) ? 1 : 0, 'missing images/vision never call AI or submit guesses');
      if (['image','image-lazy'].includes(mode)) {
        assert.deepEqual(await imagePage.evaluate(() => window.__fixture.qnodes[0].question.student_answer), ['a'], 'image-only option maps to its actual native key');
        const parts = await imagePage.evaluate(() => window.__fixture.imagePayload[0].content);
        assert.deepEqual(parts.filter(p => p.type === 'input_text').slice(1).map(p => p.text), ['题号0：题目图片1','题号0：选项C图片1','题号0：选项B图片1']);
        assert.equal(await imagePage.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('szu-uooc:answers:')).length), 0, 'mutable image URLs cannot reuse a text-only answer cache');
      } else assert.equal(await imagePage.evaluate(() => window.__fixture.vmScope.vm.commitCalls), 0);
      await imagePage.close();
    }
    console.log('图片验收：题干与图片选项实际发送、标签对应、原生答案键映射、读图失败和缺少识图模型时停止。全部使用自带测试图及模拟 AI。');
    for (const mode of ['format', 'ai', 'cache', 'collapsed-model', 'conflict', 'count', 'ai-count', 'empty']) {
      const fillPage = await pageWithQuiz(browser, 10, false, '', '', mode);
      const before = await fillPage.locator('textarea').evaluateAll(fields => fields.map(field => field.value));
      await fillPage.locator('[data-action="course-start"]').click();
      const valid = ['format', 'ai', 'cache'].includes(mode);
      const expected = valid ? 'awaiting_verification' : 'paused';
      await fillPage.waitForFunction(() => ['awaiting_verification', 'paused'].includes(JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase), null, { timeout: 5000 });
      const result = JSON.parse(await fillPage.locator('#szu-uooc-course-state').textContent());
      assert.equal(result.phase, expected, mode + ': ' + JSON.stringify(await fillPage.evaluate(() => window.__fixture.qnodes.map(({ container, question }) => ({ displayed: [...container.querySelectorAll('textarea')].map(field => field.value), saved: question.student_answer, checked: question.checked })))));
      if (valid) {
        const actual = await fillPage.locator('textarea').evaluateAll(fields => fields.map(field => field.value));
        assert.deepEqual(actual, ['printf("Hello  world\\n");\nreturn 0;', 'int', 'int', 'left\nright'], 'fill answers retain significant whitespace, repeated answers, and native textarea line endings');
        assert.deepEqual(await fillPage.evaluate(() => window.__fixture.qnodes[0].question.student_answer), actual, 'the native saved fill answers match the displayed values exactly');
      } else {
        assert.match(result.error, { 'collapsed-model': /尚未同步/, conflict: /答案冲突/, count: /填空数量/, 'ai-count': /填空答案数量/, empty: /答案格式/ }[mode]);
        assert.equal(await fillPage.evaluate(() => window.__fixture.vmScope.vm.commitCalls), 0, 'unreliable fill answers cannot open the submission dialog');
        if (mode !== 'collapsed-model') assert.deepEqual(await fillPage.locator('textarea').evaluateAll(fields => fields.map(field => field.value)), before, 'invalid fill answers do not modify any blank');
      }
      assert.equal(await fillPage.evaluate(() => window.__fixture.aiCalls), ['ai', 'ai-count'].includes(mode) ? 1 : 0, 'bank and cache never call AI, and simulated AI is requested only once');
      if (result.active) await fillPage.locator('[data-action="course-stop"]').click();
      await fillPage.close();
    }
    console.log('填空验收：题库、模拟 AI 和缓存保留多空顺序、重复答案及代码空白；保存值失真、题库冲突、空数不符和空答案均阻止提交。无真实平台或付费请求。');
    const page = await pageWithQuiz(browser);
    await page.locator('[data-action="course-start"]').click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'awaiting_verification', null, { timeout: 10000 });
    const state = JSON.parse(await page.locator('#szu-uooc-course-state').textContent());
    assert.equal(state.courseId, '123');
    assert.equal(state.quizUrl, '/exam/901');
    assert.equal(await page.evaluate(() => window.__fixture.vmScope.vm.commitCalls), 1, 'one native commit dialog is opened');
    assert.equal(await page.evaluate(() => window.__fixture.vmScope.vm.finalClicks), 0, 'no final submit without a real verification result');
    const domResult = await page.evaluate(() => window.__fixture.qnodes.map(({ container, question }) => ({
      type: question.type,
      answer: question.student_answer,
      checked: question.checked,
      selected: Array.from(container.querySelectorAll('input:checked')).map((input) => input.value),
      fields: Array.from(container.querySelectorAll('textarea')).map((field) => field.value),
    })));
    assert.deepEqual(domResult[0].selected, ['a'], 'single choice replaces the prior wrong selection');
    assert.deepEqual(domResult[0].answer, ['a'], 'rich HTML option text maps to its original key rather than shuffled display letter');
    assert.deepEqual(domResult[1].selected.sort(), ['a', 'c'], 'multi choice removes prior wrong selection');
    assert.deepEqual(domResult[1].answer.sort(), ['a', 'c']);
    assert.deepEqual(domResult[2].fields, ['first text', 'second text']);
    assert.deepEqual(domResult[2].answer, ['first text', 'second text']);
    assert(domResult.every((item) => item.checked), 'all native answer models are marked complete');
    assert.equal(await page.evaluate(() => Boolean(window.__rawOptionExecuted)), false, 'HTML-to-text parsing does not activate remote images or event handlers');
    assert.equal(await page.locator('#szu-uooc-course-state').textContent().then((text) => /captchaVerifyParam|API Key|Single A/.test(text)), false, 'public state exposes no secret or answer');
    await page.locator('[data-action="course-stop"]').click();
    assert.equal(await page.evaluate(() => window.__fixture.vmScope.vm.finalClicks), 0, 'stop prevents the final submit click');
    assert.equal(await page.evaluate(() => window.__fixture.vmScope.vm.cancelClicks), 1, 'stop closes the pending native confirmation');
    await page.close();
    const failedVerification = await pageWithQuiz(browser);
    await failedVerification.locator('[data-action="course-start"]').click();
    await failedVerification.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'awaiting_verification');
    await failedVerification.evaluate(() => { const hint=document.createElement('div');hint.id='sc';hint.textContent='验证失败，请刷新';document.querySelector('#commitConfirmDialog').appendChild(hint); });
    await failedVerification.waitForFunction(() => /5秒后自动重试/.test(JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).error));
    await failedVerification.waitForFunction(() => window.__fixture.vmScope.vm.commitCalls === 2, null, { timeout:8000 });
    const retryState=JSON.parse(await failedVerification.locator('#szu-uooc-course-state').textContent());
    assert.equal(retryState.phase,'awaiting_verification');assert.equal(retryState.active,true);
    assert.equal(await failedVerification.evaluate(() => window.__fixture.vmScope.vm.cancelClicks),1,'retry closes the old native dialog before reopening');
    assert.equal(await failedVerification.evaluate(() => window.__fixture.vmScope.vm.finalClicks),0,'retry cannot submit without a real verification result');
    await failedVerification.locator('[data-action="course-stop"]').click();
    await failedVerification.close();
    const cancelledDialog = await pageWithQuiz(browser);
    await cancelledDialog.locator('[data-action="course-start"]').click();
    await cancelledDialog.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'awaiting_verification');
    await cancelledDialog.evaluate(() => { document.querySelector('#commitConfirmDialog').style.display = 'none'; });
    await cancelledDialog.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'paused', null, { timeout: 6000 });
    assert.match(JSON.parse(await cancelledDialog.locator('#szu-uooc-course-state').textContent()).error, /验证弹窗已关闭/);
    assert.equal(await cancelledDialog.evaluate(() => window.__fixture.vmScope.vm.finalClicks), 0, 'hidden native dialog cannot submit');
    assert.equal(await cancelledDialog.evaluate(() => window.__fixture.vmScope.vm.commitCalls), 1, 'user cancellation must not reopen the dialog automatically');
    await cancelledDialog.evaluate(() => { document.querySelector('#commitConfirmDialog')?.remove(); });
    await cancelledDialog.locator('[data-action="course-start"]').click();
    await cancelledDialog.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'awaiting_verification');
    assert.equal(await cancelledDialog.evaluate(() => window.__fixture.vmScope.vm.commitCalls), 2, 'explicit resume reopens native verification with saved answers');
    await cancelledDialog.locator('[data-action="course-stop"]').click();
    await cancelledDialog.close();
    const hiddenVerified = await pageWithQuiz(browser);
    await hiddenVerified.locator('[data-action="course-start"]').click();
    await hiddenVerified.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'awaiting_verification');
    await hiddenVerified.evaluate(() => { document.querySelector('#commitConfirmDialog').style.display = 'none'; window.__fixture.setVerified(); });
    await hiddenVerified.waitForTimeout(1200);
    assert.equal(await hiddenVerified.evaluate(() => window.__fixture.vmScope.vm.finalClicks), 0, 'a verification result cannot authorize a click on a hidden submit control');
    await hiddenVerified.locator('[data-action="course-stop"]').click();
    await hiddenVerified.close();
    const closedSuccess = await pageWithQuiz(browser, 10, 'closed');
    await closedSuccess.locator('[data-action="course-start"]').click();
    await closedSuccess.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'awaiting_verification');
    await closedSuccess.evaluate(() => { window.__fixture.setVerified(); document.querySelector('#commitConfirmDialog [ng-click="vm.doCommitTask()"] ').click(); });
    await closedSuccess.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'complete', null, { timeout: 6000 });
    assert.equal(await closedSuccess.evaluate(() => window.__fixture.vmScope.vm.finalClicks), 1, 'manual submission whose success notice is already closed must complete from the platform directory without resubmitting');
    await closedSuccess.close();
    const failedSave = await pageWithQuiz(browser);
    await failedSave.locator('[data-action="course-start"]').click();
    await failedSave.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'awaiting_verification');
    await failedSave.evaluate(() => { const save = Storage.prototype.setItem; Storage.prototype.setItem = function(key,value) { if (key==='szu-uooc:course-state:123' && JSON.parse(value).pendingSubmit) throw new Error('fixture storage unavailable'); return save.call(this,key,value); }; window.__fixture.setVerified(); });
    await failedSave.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'paused', null, { timeout: 6000 });
    assert.equal(await failedSave.evaluate(() => window.__fixture.vmScope.vm.finalClicks), 0, 'saving the duplicate-submission marker is required before the final native click');
    assert.match(JSON.parse(await failedSave.locator('#szu-uooc-course-state').textContent()).error, /保存失败/);
    await failedSave.close();
    const delayedCatalog = await pageWithQuiz(browser);
    await delayedCatalog.evaluate(() => {
      const loaded = window.__fixture.root.chapterList;
      window.__fixture.root.chapterList = [];
      setTimeout(() => { window.__fixture.root.chapterList = loaded; }, 1000);
    });
    await delayedCatalog.locator('[data-action="course-start"]').click();
    await delayedCatalog.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'awaiting_verification', null, { timeout: 10000 });
    assert.equal(await delayedCatalog.evaluate(() => window.__fixture.vmScope.vm.commitCalls), 1, 'initial start waits for the asynchronous catalog instead of pausing prematurely');
    await delayedCatalog.locator('[data-action="course-stop"]').click();
    await delayedCatalog.close();

    for (const taskType of [20, 30]) {
      const protectedPage = await pageWithQuiz(browser, taskType);
      const before = await protectedPage.evaluate(() => window.__fixture.qnodes.map(({ container }) => Array.from(container.querySelectorAll('input:checked,textarea')).map((node) => node.value)));
      await protectedPage.locator('[data-action="course-start"]').click();
      await protectedPage.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'paused', null, { timeout: 10000 });
      const after = await protectedPage.evaluate(() => window.__fixture.qnodes.map(({ container }) => Array.from(container.querySelectorAll('input:checked,textarea')).map((node) => node.value)));
      assert.deepEqual(after, before, `task.type ${taskType} is not modified`);
      assert.match(JSON.parse(await protectedPage.locator('#szu-uooc-course-state').textContent()).error, /不会自动作答或提交/);
      assert.equal(await protectedPage.evaluate(() => window.__fixture.vmScope.vm.commitCalls), 0);
      await protectedPage.close();
    }

    const stalePage = await pageWithQuiz(browser);
    await stalePage.evaluate(async () => {
      document.querySelectorAll('.queItems').forEach((node) => node.remove());
      const frame = document.createElement('iframe'); frame.src = '/exam/900'; document.body.appendChild(frame);
      await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
      const doc = frame.contentDocument;
      const group = doc.createElement('section'); group.className = 'queItems';
      group.innerHTML = '<div class="queItems-type">单选题</div><div class="queContainer"><span class="index">1.</span><div class="ti-q-c">Choose one</div><label class="ti-a"><span class="ti-a-i">A</span><input type="radio" name="stale" value="a"><span class="ti-a-c">Single A</span></label><label class="ti-a"><span class="ti-a-i">B</span><input type="radio" name="stale" value="b"><span class="ti-a-c">Single B</span></label></div>';
      const container = group.querySelector('.queContainer');
      const question = { type: '10', options: [{ text: 'Single A', key: 'a' }, { text: 'Single B', key: 'b' }], student_answer: [], checked: false };
      container.__scope = { question, $parent: { vm: { task: { id: 900, type: 10 } } } };
      doc.body.appendChild(group);
      frame.contentWindow.angular = { element: (node) => ({ scope: () => node.__scope }) };
      window.__staleInput = container.querySelector('input[value="a"]');
    });
    await stalePage.locator('[data-action="course-start"]').click();
    await stalePage.waitForTimeout(1200);
    assert.equal(await stalePage.evaluate(() => window.__staleInput.checked), false, 'old /exam/900 iframe is ignored for current task_id 901');
    assert.equal(await stalePage.evaluate(() => window.__fixture.vmScope.vm.commitCalls), 0, 'stale iframe cannot open the native commit dialog');
    assert.equal(JSON.parse(await stalePage.locator('#szu-uooc-course-state').textContent()).phase, 'opening');
    await stalePage.locator('[data-action="course-stop"]').click();
    await stalePage.close();

    const successPage = await pageWithQuiz(browser, 10, true);
    await successPage.locator('[data-action="course-start"]').click();
    await successPage.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'awaiting_verification', null, { timeout: 10000 });
    await successPage.evaluate(() => { const stale=document.createElement('div');stale.id='sc';stale.textContent='验证失败，请刷新';document.querySelector('#commitConfirmDialog').appendChild(stale);window.__fixture.setVerified(); });
    await successPage.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'complete', null, { timeout: 10000 });
    assert.equal(JSON.parse(await successPage.locator('#szu-uooc-course-state').textContent()).phase, 'complete', JSON.stringify({ state: await successPage.locator('#szu-uooc-course-state').textContent(), vm: await successPage.evaluate(async () => ({ final: window.__fixture.vmScope.vm.finalClicks, verified: window.__fixture.vmScope.vcode_params.captchaVerifyParam, success: document.body.innerText.includes('测验通过'), acknowledged: window.__fixture.successAcknowledged, calls: window.__fixture.serviceCalls, sources: await window.__fixture.service.getUnitLearn() })) }));
    assert.equal(await successPage.evaluate(() => window.__fixture.vmScope.vm.finalClicks), 1, 'real fixture verification permits one native final click');
    assert.equal(await successPage.evaluate(() => JSON.parse(localStorage.getItem('szu-uooc:course-state:123')).pendingSubmit), null, 'finished confirmation clears pending-submit');
    await successPage.close();

    for (const nextUnit of ['unlock', 'locked', 'fail', 'unpublished']) {
      const lockedPage = await pageWithQuiz(browser, 10, true, nextUnit);
      await lockedPage.locator('[data-action="course-start"]').click();
      const firstPhase = nextUnit === 'fail' ? 'paused' : 'awaiting_verification';
      await lockedPage.waitForFunction((phase) => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === phase, firstPhase, { timeout: 4000 });
      assert.equal(await lockedPage.evaluate(() => window.__fixture.vmScope.vm.finalClicks), 0);
      if (nextUnit !== 'fail') {
        await lockedPage.evaluate(() => window.__fixture.setVerified());
        await lockedPage.waitForFunction((phase) => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === phase, nextUnit === 'unlock' ? 'complete' : 'paused', { timeout: 10000 });
        const result = JSON.parse(await lockedPage.locator('#szu-uooc-course-state').textContent());
        assert.equal(result.completed, nextUnit === 'unlock' ? 2 : 1);
        assert.equal(await lockedPage.evaluate(() => window.__fixture.nextRequests > 1), true, 'locked units are retried after the preceding task finishes');
        if (nextUnit === 'locked') assert.match(result.error, /锁定|闯关/);
        if (nextUnit === 'unpublished') assert.match(result.error, /尚未发布/);
      }
      await lockedPage.close();
    }

    for (const mode of ['click', 'silent', 'reject']) {
      const navigationPage = await pageWithQuiz(browser, 10, false, '', mode);
      await navigationPage.locator('[data-action="course-start"]').click();
      await navigationPage.waitForFunction(expected => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === expected, mode === 'reject' ? 'paused' : 'awaiting_verification', { timeout: 14000 });
      assert.equal(await navigationPage.evaluate(() => window.__fixture.vmScope.vm.commitCalls), mode === 'reject' ? 0 : 1);
      if (mode !== 'click') assert.equal(await navigationPage.evaluate(() => window.__fixture.navigationCalls), 1, 'a silent catalog click must use a verified route fallback');
      await navigationPage.close();
    }

    const interruptedPage = await pageWithQuiz(browser, 10, false);
    await interruptedPage.locator('[data-action="course-start"]').click();
    await interruptedPage.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'awaiting_verification', null, { timeout: 10000 });
    await interruptedPage.evaluate(() => window.__fixture.setVerified());
    await interruptedPage.waitForFunction(() => window.__fixture.vmScope.vm.finalClicks === 1, null, { timeout: 10000 });
    const pendingRecord = await interruptedPage.evaluate(() => JSON.parse(localStorage.getItem('szu-uooc:course-state:123')).pendingSubmit);
    assert.deepEqual(Object.keys(pendingRecord).sort(), ['at', 'courseId', 'sourceId', 'task_id']);
    await interruptedPage.locator('[data-action="course-stop"]').click();
    await interruptedPage.close();

    const restartedPage = await pageWithQuiz(browser, 10, false);
    await restartedPage.evaluate((pending) => localStorage.setItem('szu-uooc:course-state:123', JSON.stringify({ active: true, pendingSubmit: pending })), pendingRecord);
    await restartedPage.locator('[data-action="course-start"]').click();
    await restartedPage.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'paused', null, { timeout: 10000 });
    assert.match(JSON.parse(await restartedPage.locator('#szu-uooc-course-state').textContent()).error, /上次交卷仍未被目录确认完成/);
    assert.equal(await restartedPage.evaluate(() => window.__fixture.vmScope.vm.commitCalls), 0, 'restart with pending-submit never repeats native commit');
    await restartedPage.close();

    const recoveredPage = await pageWithQuiz(browser, 10, false);
    await recoveredPage.evaluate((pending) => localStorage.setItem('szu-uooc:course-state:123', JSON.stringify({ active: true, pendingSubmit: pending })), pendingRecord);
    await recoveredPage.evaluate(() => window.__fixture.markFinished());
    await recoveredPage.locator('[data-action="course-start"]').click();
    await recoveredPage.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'complete', null, { timeout: 10000 });
    assert.equal(await recoveredPage.evaluate(() => JSON.parse(localStorage.getItem('szu-uooc:course-state:123')).pendingSubmit), null, 'directory finished=1 clears a recovered pending-submit');
    assert.equal(await recoveredPage.evaluate(() => window.__fixture.vmScope.vm.commitCalls), 0);
    await recoveredPage.close();

    const videoPage = await pageWithVideo(browser);
    await videoPage.locator('[data-action="course-start"]').click();
    await videoPage.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'video', null, { timeout: 10000 });
    await videoPage.evaluate(() => { window.__videoFixture.finished = true; const video = document.querySelector('video'); video.dispatchEvent(new Event('ended')); video.dispatchEvent(new Event('ended')); });
    await videoPage.waitForFunction(() => JSON.parse(document.querySelector('#szu-uooc-course-state').textContent).phase === 'complete', null, { timeout: 10000 });
    const finished = JSON.parse(await videoPage.locator('#szu-uooc-course-state').textContent());
    assert.equal(finished.completed, 1, 'duplicate ended events complete a video exactly once');
    assert.equal(finished.total, 1);
    await videoPage.close();
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
