import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { detectService } from '../student/service-detection.mjs';
import { serviceFingerprint } from '../api-protocol.mjs';
import { explainProblem, serviceActionFor } from '../student/user-guidance.mjs';
import { createConsole } from '../student/console-server.mjs';
import { appDir } from './console-fixtures.mjs';

const base = 'https://fixture.invalid/v1', key = 'fixture-service-private-key';
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-service-failure-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('malformed model lists and interrupted list bodies give safe service guidance without paid calls', async t => {
  const dataDir = await temporary(t);
  for (const value of [null, false, 12, [], {}, { data: null }]) {
    let calls = 0;
    await assert.rejects(detectService({ base_url: base, api_key: key, dataDir, fetchImpl: async url => {
      assert.equal(url, base + '/models'); calls++; return Response.json(value);
    } }), /模型列表/);
    assert.equal(calls, 1);
  }
  await assert.rejects(detectService({ base_url: base, api_key: key, dataDir, fetchImpl: async url => {
    assert.equal(url, base + '/models');
    return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('fixture ' + key)); } }));
  } }), error => /模型列表.*中断/.test(error.message) && !error.message.includes(key));
});

test('only expendable detection caches are rebuilt; existing cost records stay byte-for-byte intact', async t => {
  const dataDir = await temporary(t), cache = path.join(dataDir, 'service-detection.json');
  const ledgerDir = path.join(dataDir, 'detection-ledger'); await fs.mkdir(ledgerDir);
  const record = path.join(ledgerDir, 'course-123.json'), contents = '{unreadable cost record';
  await fs.writeFile(record, contents);
  for (const broken of ['{', JSON.stringify({ fingerprint: serviceFingerprint(base, key), selection: '', at: Date.now(), result: null })]) {
    await fs.writeFile(cache, broken); let calls = 0;
    const result = await detectService({ base_url: base, api_key: key, dataDir, fetchImpl: async url => {
      assert.equal(url, base + '/models'); calls++; return Response.json({ data: [] });
    } });
    assert.equal(result.status, 'blocked'); assert.equal(calls, 1);
    assert.equal(await fs.readFile(record, 'utf8'), contents);
    assert(!JSON.stringify(result).includes(key));
  }
});

test('an unreadable cache is reported as a local storage problem before any provider call', async t => {
  const dataDir = await temporary(t); await fs.mkdir(path.join(dataDir, 'service-detection.json'));
  let calls = 0;
  await assert.rejects(detectService({ base_url: base, api_key: key, dataDir, fetchImpl: async () => { calls++; } }), /检测记录.*无法读取/);
  assert.equal(calls, 0);
});

test('missing, malformed or invalid detection costs block completion instead of reporting zero costs', async t => {
  const dataDir = await temporary(t), originalRead = fs.readFile;
  for (const broken of [null, '{', '{"requests":null}', '{"requests":[{"status":"known","cost_nanos":null}]}']) {
    let reads = 0, record;
    fs.readFile = async (file, ...args) => {
      if (String(file).includes(path.join(dataDir, 'detection-ledger')) && ++reads === 2) {
        record = file;
        if (broken === null) throw Object.assign(new Error('fixture missing ledger'), { code: 'ENOENT' });
        return broken;
      }
      return originalRead(file, ...args);
    };
    try {
      await assert.rejects(detectService({ base_url: base, api_key: key, dataDir, fetchImpl: async url => url.endsWith('/models')
        ? Response.json({ data: [{ id: 'fixture-model', pricing: { currency: 'USD', scope: 'key', input_per_million: .01, cached_input_per_million: .01, output_per_million: .01 } }] })
        : Response.json({ model: 'fixture-model', choices: [{ finish_reason: 'stop', message: { content: '{"answers":[{"index":0,"answers":["2"]}]}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) }), /检测费用记录不可读.*不要删除费用记录/);
      const saved = JSON.parse(await originalRead(record, 'utf8'));
      assert.equal(saved.requests[0].status, 'known'); assert(saved.requests[0].cost_nanos > 0);
    } finally { fs.readFile = originalRead; }
  }
});

test('service, detection budget, storage and accounting failures retain specific next steps', () => {
  for (const message of ['API 网址返回的不是模型列表，请复制服务商提供的 API 网址。', '读取模型列表时连接中断，请检查 API 网址和网络后重新检测。', '无法连接解题服务，请检查 API 网址和网络后重新检测。']) {
    assert.match(explainProblem(message), /模型列表.*网址.*网络.*重新检测/);
    assert.equal(serviceActionFor(message), 'url');
  }
  const budget = '本次检测的 $0.02 上限不足以安全测试这个模型，未发送请求。请选择其他主要模型或修改服务。';
  assert.match(explainProblem(budget), /本次检测.*上限.*更换.*模型/);
  assert.equal(serviceActionFor(budget), 'model');
  for (const message of ['检测记录无法读取，请检查本机磁盘空间和目录权限后重新检测。', 'EISDIR: rename /Users/private/api.json.tmp', 'ENOSPC: fixture']) {
    assert.match(explainProblem(message), /磁盘空间.*权限.*不要删除.*费用记录/);
    assert.equal(serviceActionFor(message), 'retry');
    assert.doesNotMatch(explainProblem(message), /EISDIR|ENOSPC|\/Users/);
  }
  assert.match(explainProblem('账本金额无效，已阻止请求'), /费用记录异常.*不要删除.*核对/);
  const failures = [
    ['响应流提前结束，缺少最终结果', /响应.*中断/],
    ['响应格式无法识别', /格式无法识别/],
    ['响应缺少有效用量', /有效用量/],
    ['服务返回错误事件', /服务返回错误/],
    ['响应超过大小上限', /内容过大/],
  ];
  for (const [reason, expected] of failures) {
    const guidance = explainProblem(`API HTTP 200；${reason}；结果或费用未知；保留预留额度，课程暂停`);
    assert.match(guidance, expected); assert.match(guidance, /账单/); assert.match(guidance, /不要删除费用记录/);
  }
  assert.match(explainProblem('Unhandled unexpected fixture'), /^操作未完成/, 'unknown technical details stay private');
});

test('the real detect-save UI shows specific failures and recovers on retry after rebuilding a broken cache', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-service-failure-ui-')); let mode = 'null';
  const app = await createConsole({ appDir, dataDir, checkDependencies: async () => true, fetchImpl: async url => {
    if (url === base + '/models') {
      if (mode === 'success') return Response.json({ data: [{ id: 'fixture-model', pricing: { currency: 'USD', scope: 'key', input_per_million: .01, cached_input_per_million: .01, output_per_million: .01 } }] });
      return mode === 'interrupted' ? new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('fixture ' + key)); } })) : Response.json(null);
    }
    assert.equal(mode, 'success'); assert.equal(url, base + '/chat/completions');
    return Response.json({ model: 'fixture-model', choices: [{ finish_reason: 'stop', message: { content: '{"answers":[{"index":0,"answers":["2"]}]}' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  } });
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(async () => { await browser.close(); await app.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const page = await browser.newPage(); await page.goto(app.url);
  const evidence = path.resolve('../dist/service-failure-evidence'); await fs.mkdir(evidence, { recursive: true });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /^解题服务/ }).click();
  await page.locator('#base-url').fill(base); await page.locator('#api-key').fill(key);
  for (const failure of ['null', 'interrupted']) {
    mode = failure;
    await page.getByRole('button', { name: '检测并保存', exact: true }).click();
    await page.locator('#test-result.error').waitFor();
    const visible = await page.locator('#test-result').innerText();
    assert.match(visible, /模型列表.*网址.*网络.*重新检测/);
    assert.doesNotMatch(visible, /操作未完成|fixture|TypeError|Cannot read/);
    assert.equal(await page.locator('[data-service-action="url"]').count(), 1);
    assert(!(await page.locator('body').innerText()).includes(key));
  }
  await page.screenshot({ path: path.join(evidence, 'model-list-error.png'), fullPage: true });
  await fs.writeFile(path.join(dataDir, 'service-detection.json'), '{'); mode = 'success';
  await page.getByRole('button', { name: '检测并保存', exact: true }).click();
  await page.locator('#test-result.success').waitFor();
  assert.match(await page.locator('#test-result').innerText(), /连接成功，已保存.*本次预估/);
  assert.match(await page.locator('#model-summary').innerText(), /fixture-model/);
  assert.equal((await app.state()).config.service_status, 'ready');
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'service-detection.json'), 'utf8')).result.status, 'ready');
  await page.screenshot({ path: path.join(evidence, 'retry-success.png'), fullPage: true });
});
