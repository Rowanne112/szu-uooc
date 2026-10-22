import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { runController } from '../controller.mjs';
import { defaults, saveJSON } from '../student/settings.mjs';
import { serviceFingerprint } from '../api-protocol.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const url = 'https://www.uooc.net.cn/home/learn/index#/123/1/2/900/section';
const courseHTML = `<!doctype html><meta charset="utf-8"><title>费用恢复回归</title><iframe src="/exam/901" style="width:100%;height:700px;border:0"></iframe><script>
window.submits=0;
const source={id:'900',task_id:'901',type:80,is_task:'1',finished:'0',name:'恢复后测验'};
const root={chapterList:[{id:'1',children:[{id:'2',unitSource:[source]}]}]};
const service={getUnitLearn:async()=>[{...source,finished:window.submits?'1':'0'}]};
const stateService={params:{courseId:'123',chapterId:'1',sectionId:'2',sourceId:'900'},go:async()=>{}};
const injector={get:name=>name==='$rootScope'?root:name==='courseService'?service:name==='$state'?stateService:null};
window.angular={element:node=>({injector:()=>injector,scope:()=>node.__scope})};
</script>`;
const examHTML = `<!doctype html><meta charset="utf-8"><style>#aliyunCaptcha-checkbox-icon{width:21px;height:21px;border:1px solid;display:block}</style>
<section class="queItems"><div class="queItems-type">单选题</div><div class="queContainer"><span class="index">1.</span><div class="ti-q-c">Recovery fixture question</div><label class="ti-a"><input type="radio" name="q" value="a"><span class="ti-a-c">Correct</span></label><label class="ti-a"><input type="radio" name="q" value="b"><span class="ti-a-c">Wrong</span></label></div></section><script>
const question={type:'10',options:[{text:'Correct',key:'a'},{text:'Wrong',key:'b'}],student_answer:[],checked:false};
const scope={vcode_params:{},vm:{task:{id:901,type:10},commitTask(){
 const dialog=document.createElement('div');dialog.id='commitConfirmDialog';dialog.innerHTML='<div id="sc"><span id="aliyunCaptcha-checkbox-icon"></span></div><button ng-click="vm.doCommitTask()">提交</button><button ng-click="vm.cancelCommitTask()">取消</button>';document.body.appendChild(dialog);
 dialog.querySelector('#aliyunCaptcha-checkbox-icon').onclick=()=>{scope.vcode_params.captchaVerifyParam='fixture-verified';dialog.querySelector('#sc').textContent='验证通过';};
 dialog.querySelector('button').onclick=()=>{parent.submits++;dialog.remove();};
 dialog.querySelector('[ng-click="vm.cancelCommitTask()"]').onclick=()=>dialog.remove();
},doCommitTask(){}}};
const node=document.querySelector('.queContainer');node.__scope={question,$parent:scope,$applyAsync(){}};
for(const input of document.querySelectorAll('input'))input.onchange=()=>{question.student_answer=[...document.querySelectorAll('input:checked')].map(node=>node.value);question.checked=question.student_answer.length>0;};
window.angular={element:node=>({scope:()=>node.__scope})};
</script>`;
const waitFor = async predicate => {
  for (let n = 0; n < 120; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Billing controller recovery timed out');
};

const unknown = { id: 'diagnostic-connecting', status: 'unknown', failure_stage: 'connecting', failure_type: 'TypeError', reserved_nanos: 1363500 };
const pending = { id: 'process-exit-pending', status: 'pending', reserved_nanos: 1363500 };
for (const [entry, recovery] of [[unknown, 'resume'], [pending, 'resume'], [pending, 'explicit-start'], [unknown, 'none']]) test('real controller ' + recovery + ' with historical ' + entry.status + ' reservation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-billing-controller-'));
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  await context.route('https://www.uooc.net.cn/**', route => route.fulfill({ contentType: 'text/html', body: new URL(route.request().url()).pathname === '/exam/901' ? examHTML : courseHTML }));
  const page = await context.newPage(); await page.goto(url);
  const config = { ...defaults, answer_mode: 'ai', api_key: 'billing-controller-fixture-key', service_status: 'ready' };
  config.profile = { id: config.model, wire_api: 'responses', reasoning_effort: 'medium', pricing: config.pricing, verified_text: true };
  config.detection = { fingerprint: serviceFingerprint(config.base_url, config.api_key) };
  const configFile = path.join(dir, 'api.json'), ledgerFile = path.join(dir, 'ledger/course-123.json');
  await saveJSON(configFile, config);
  await saveJSON(ledgerFile, { courseId: '123', model: config.model, unit: 'provider_USD_credit', requests: [entry] });
  const commands = new EventEmitter(), states = [];
  let calls = 0;
  const args = [url, '--config', configFile, '--data-dir', dir, '--console'];
  if (recovery === 'explicit-start') args.push('--resume-billing');
  const running = runController({ args, initialCommand: recovery === 'resume' ? 'pause' : undefined, browser, page, commands, onState: message => states.push(message.state), log: () => {}, fetchAPI: async () => {
    calls++;
    return Response.json({ model: config.model, status: 'completed', usage: { input_tokens: 10, output_tokens: 1 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ answers: [{ index: 0, answers: ['Correct'] }] }) }] }] });
  } });
  running.catch(() => {});
  t.after(async () => { commands.emit('message', { type: 'command', action: 'stop' }); await browser.close(); await running.catch(() => {}); await fs.rm(dir, { recursive: true, force: true }); });
  let previousStates = 0;
  if (recovery === 'resume') {
    await waitFor(() => states.some(state => state.phase === 'paused'));
    assert.equal(calls, 0);
    previousStates = states.length;
    commands.emit('message', { type: 'command', action: 'resume' });
  }
  await waitFor(() => states.slice(previousStates).some(state => state.phase === 'complete' || state.phase === 'paused' && /费用未知|上次请求/.test(state.error || '')));
  if (recovery === 'none') {
    assert.equal(calls, 0, 'a controller boot without an explicit Continue flag cannot approve billing recovery');
    assert.equal(states.at(-1).phase, 'paused');
    assert.deepEqual(JSON.parse(await fs.readFile(ledgerFile, 'utf8')).requests, [entry]);
    return;
  }
  assert.equal(states.at(-1).phase, 'complete', states.at(-1).error); await running;
  assert.equal(calls, 1);
  assert.equal(await page.evaluate(() => window.submits), 1, 'recovery completes the quiz exactly once');
  const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
  assert.deepEqual(ledger.requests[0], entry, 'Continue cannot clear or reduce the historical reservation');
  assert.deepEqual(ledger.requests[1].resumed_unknown_requests, [entry.id]);
});
