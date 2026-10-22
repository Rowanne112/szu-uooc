import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { appDir } from './console-fixtures.mjs';
import { defaults, saveJSON } from '../student/settings.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const executablePath = process.env.SZU_UOOC_CHROME || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath();
const html = `<!doctype html><html><head><title>课程生命周期测试</title></head><body><video id="player"></video><script>
const video = document.querySelector('video'); let playing = false;
Object.defineProperty(video, 'paused', {get:()=>!playing});
video.play = () => { playing = true; return Promise.resolve(); }; video.pause = () => { playing = false; };
const source = {id:'500',type:10,finished:'0',name:'视频测试'};
const root = {chapterList:[{id:'1',children:[{id:'2',unitSource:[source]}]}]};
const service = {getUnitLearn: async()=>[{...source}]};
const stateService = {params:{courseId:'123',chapterId:'1',sectionId:'2',sourceId:'500'},go:async()=>{}};
const injector = {get:name=>name==='$rootScope'?root:name==='courseService'?service:name==='$state'?stateService:null};
window.angular = {element:node=>({injector:()=>injector,scope:()=>node.__scope})};
</script></body></html>`;
const waitUntil = async condition => { for (let i = 0; i < 160; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Controller lifecycle timed out'); };

test('real controller IPC pauses playback, resumes, stops cleanly and cannot start after parent disconnects during connection', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-controller-lifecycle-'));
  const context = await chromium.launchPersistentContext(path.join(temp, 'chrome'), { executablePath, headless: true, args: ['--remote-debugging-port=0'] });
  const [port, endpoint] = (await fs.readFile(path.join(temp, 'chrome/DevToolsActivePort'), 'utf8')).trim().split('\n');
  const websocket = `ws://127.0.0.1:${port}${endpoint}`;
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  let page = await context.newPage(); const url = 'https://www.uooc.net.cn/home/learn/#/123/1/2/500/section'; await page.goto(url);
  const signupPages = [];
  for (const keepMarker of [true, false]) {
    const signup = await context.newPage(); const marked = new URL(url); marked.searchParams.set('szu_checkin', '1'); await signup.goto(marked.href);
    await signup.evaluate(keep => { sessionStorage.setItem('szu-uooc:checkin-tab', '1'); if (!keep) history.replaceState(null, '', location.pathname + location.hash); }, keepMarker);
    signupPages.push(signup);
  }
  await saveJSON(path.join(temp, 'api.json'), { ...defaults, api_key: 'controller-private-fixture-key' });
  let delayed = false, requested;
  let requestSeen = new Promise(resolve => requested = resolve);
  const proxy = http.createServer((_req, res) => { requested(); setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ webSocketDebuggerUrl: websocket })); }, delayed ? 500 : 0); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const children = [];
  const launch = () => {
    const child = fork(path.join(appDir, 'controller.mjs'), [url, '--config', path.join(temp, 'api.json'), '--data-dir', temp, '--console'], { env: { ...process.env, SZU_UOOC_CDP_ENDPOINT: `http://127.0.0.1:${proxy.address().port}` }, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    children.push(child); child.states = []; child.output = '';
    child.on('message', message => { if (message.type === 'state') child.states.push(message.state); });
    child.stdout.on('data', chunk => child.output += chunk); child.stderr.on('data', chunk => child.output += chunk);
    child.exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    return child;
  };
  try {
    const child = launch();
    try { await waitUntil(() => child.states.some(state => state.phase === 'video' && state.active)); }
    catch (error) { throw new Error(error.message + '\n' + child.output.replaceAll('controller-private-fixture-key', '[redacted]')); }
    for (const signup of signupPages) assert.equal(await signup.locator('#szu-uooc-course-state').count(), 0, 'learning must ignore both URL-marked and session-marked signup tabs');
    child.send({ type: 'command', action: 'pause' });
    await waitUntil(() => child.states.some(state => state.phase === 'paused' && state.error === '用户暂停'));
    assert.equal(await page.locator('video').evaluate(video => video.paused), true);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('szu-uooc:auto-player:config')).enabled), false);
    child.states = []; child.send({ type: 'command', action: 'resume' });
    await waitUntil(() => child.states.some(state => state.phase === 'video' && state.active));
    child.send({ type: 'command', action: 'stop' });
    await waitUntil(() => child.exitCode !== null); assert.equal((await child.exit).code, 0);
    assert.equal(page.isClosed(), false, 'stopping must keep the original Chrome page open');
    assert.equal(await page.locator('video').evaluate(video => video.paused), true);
    assert(!child.output.includes('controller-private-fixture-key'));
    // Return to a fresh page, then lose the parent while /json/version is still pending.
    await page.close(); page = await context.newPage(); await page.goto(url);
    delayed = true; requestSeen = new Promise(resolve => requested = resolve);
    const orphan = launch(); await requestSeen; orphan.disconnect();
    await waitUntil(() => orphan.exitCode !== null); assert.equal((await orphan.exit).code, 0);
    assert.equal(await page.locator('#szu-uooc-course-state').count(), 0, 'an orphan must not install or start the course script');
    console.log('真实控制器 IPC：视频暂停、继续、停止保留 Chrome、连接期间失去父控制台不会启动任务。课程全部模拟，无解题 API 请求。');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => proxy.close(resolve)); await context.close(); await fs.rm(temp, { recursive: true, force: true });
  }
});
