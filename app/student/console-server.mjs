import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { defaults, validateConfig, validateCourseURL, readJSON, saveJSON } from './settings.mjs';
import { createBrowserSession, courseFromURL } from './browser-session.mjs';
import { createCheckin } from './checkin.mjs';
import { checkinURL } from './checkin-browser.mjs';

const phases = { opening: '打开学习资源', connecting: '等待浏览器授权', loading_catalog: '读取课程目录', video: '播放视频', solving: '准备答案', awaiting_verification: '等待网站验证', submitting: '提交测验', paused: '已暂停', complete: '已完成' };
const statuses = { ready: '未开始', queued: '等待运行', starting: '正在连接', running: '运行中', pausing: '正在暂停', paused: '已暂停', stopping: '正在停止', stopped: '已停止', error: '需要处理', complete: '已完成' };

export async function createConsole({ appDir, dataDir, spawnController, browserOptions = {}, fetchImpl = fetch, checkDependencies, installDependencies, checkinOptions = {} } = {}) {
  const configFile = path.join(dataDir, 'api.json');
  const queueFile = path.join(dataDir, 'courses.json');
  const require = createRequire(path.join(appDir, 'package.json'));
  let config;
  let configError = '';
  try { config = await readJSON(configFile, null); }
  catch { configError = '原来的设置不可读，请在控制台重新保存 Key。'; config = null; }
  if (config) { try { validateConfig(config); } catch (error) { configError = error.message; config = null; } }
  const saved = await readJSON(queueFile, { courses: [] });
  const courses = Array.isArray(saved.courses) ? saved.courses : [];
  for (const course of courses) {
    validateCourseURL(course.url);
    course.url = courseFromURL(course.url).url;
    course.id = new URL(course.url).hash.replace(/^#\/?/, '').split('/')[0];
    if (['running', 'starting', 'pausing', 'stopping', 'queued'].includes(course.status)) { course.status = 'stopped'; course.error = '上次控制台已关闭，点击开始可继续。'; }
  }
  const active = new Map();
  let queueRunning = false;
  let shuttingDown = false;
  let dependencyChild;
  let installing;
  let savedQueue = Promise.resolve();
  let mutations = Promise.resolve();
  const logs = [];
  const environment = { status: 'checking', message: '正在检查运行环境', output: '' };
  const connection = { status: 'untested', message: '尚未测试连接' };
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(24).toString('hex');
  let origin;

  const scrub = value => String(value ?? '').replaceAll(config?.api_key || '\0', '[已隐藏]').replace(/(?:sk-|sess-)[a-z0-9_-]+|Bearer\s+\S+/gi, '[已隐藏]').slice(0, 1000);
  const log = (message, courseId) => { logs.push({ at: new Date().toISOString(), message: scrub(message), courseId }); if (logs.length > 100) logs.shift(); };
  const browserSession = createBrowserSession({ appDir, dataDir, log, ...browserOptions });
  const launchController = spawnController || browserSession.spawnWorker;
  function persist() {
    const snapshot = structuredClone({ courses });
    savedQueue = savedQueue.then(() => saveJSON(queueFile, snapshot));
    return savedQueue;
  }
  const checkin = await createCheckin({ ...checkinOptions, appDir, dataDir, getCourses: () => courses, log });
  const requestCheckin = () => checkin.tick().catch(error => log(error.message));
  const dependenciesReady = checkDependencies || (async () => {
    try {
      const pw = await readJSON(path.join(appDir, 'node_modules/playwright/package.json'), null);
      const core = await readJSON(path.join(appDir, 'node_modules/playwright-core/package.json'), null);
      return pw?.version === '1.62.1' && core?.version === '1.62.1' && Boolean(require('playwright').chromium);
    } catch { return false; }
  });

  async function prepareEnvironment() {
    if (installing) return installing;
    if (await dependenciesReady()) { Object.assign(environment, { status: 'ready', message: '运行环境已就绪', output: '' }); return; }
    installing = (async () => {
      Object.assign(environment, { status: 'installing', message: '首次启动，正在下载浏览器连接组件', output: '', startedAt: Date.now() });
      try {
        if (installDependencies) await installDependencies();
        else {
          const runtime = path.dirname(process.execPath);
          const npm = process.platform === 'win32' ? path.join(runtime, 'node_modules/npm/bin/npm-cli.js') : path.resolve(runtime, '../lib/node_modules/npm/bin/npm-cli.js');
          await new Promise((resolve, reject) => {
            dependencyChild = spawn(process.execPath, [npm, 'ci', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--cache', path.resolve(appDir, '../runtime/npm-cache')], {
              cwd: appDir, windowsHide: true,
              env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
            });
            const update = chunk => { environment.output = scrub(chunk.toString().trim()); };
            dependencyChild.stdout.on('data', update);
            dependencyChild.stderr.on('data', update);
            dependencyChild.once('error', reject);
            dependencyChild.once('exit', code => code === 0 ? resolve() : reject(new Error('下载没有完成，请检查网络后点击重试。')));
          });
        }
        if (!await dependenciesReady()) throw new Error('组件自检未通过，请点击重试。');
        Object.assign(environment, { status: 'ready', message: '运行环境已就绪', output: '' });
        log('运行环境已准备好，可以添加课程。');
      } catch (error) { Object.assign(environment, { status: 'error', message: scrub(error.message) }); }
      finally { dependencyChild = null; installing = null; }
    })();
    return installing;
  }

  async function costs(id) {
    try {
      const ledger = await readJSON(path.join(dataDir, 'ledger', `course-${id}.json`), { requests: [] });
      if (!Array.isArray(ledger.requests)) throw new Error('账本结构异常');
      let spent = 0, reserved = 0, unknown = false;
      for (const entry of ledger.requests) {
        const amount = entry.status === 'known' ? entry.cost_nanos : entry.reserved_nanos;
        if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('账本金额异常');
        if (entry.status === 'known') spent += amount;
        else { reserved += amount; if (entry.status === 'unknown') unknown = true; }
      }
      return { spent: spent / 1e9, reserved: reserved / 1e9, unknown };
    } catch { return { spent: null, reserved: null, unknown: true }; }
  }

  async function state() {
    const list = await Promise.all(courses.map(async course => ({ ...course, checkin: checkin.courseState(course), statusLabel: statuses[course.status] || '需要处理', phaseLabel: phases[course.phase] || '', costs: await costs(course.id) })));
    return { brand: 'szu-uooc', csrf, environment, connection, configError, config: { ...(config || defaults), api_key: undefined, hasKey: Boolean(config?.api_key) },
      courses: list, checkin: checkin.state(), browser: browserSession.state(), activeIds: [...active.keys()], activeId: [...active.keys()][0] || null, queueRunning, logs, shuttingDown };
  }

  function selected(id) { const course = courses.find(course => course.id === String(id)); if (!course) throw new Error('找不到这门课程。'); return course; }

  async function startCourse(course) {
    if (shuttingDown) throw new Error('控制台正在关闭。');
    if (active.has(course.id)) throw new Error('这门课程已经在运行。');
    if (active.size) throw new Error('先停止当前课程，再开始另一门。');
    if (environment.status !== 'ready') throw new Error('请等运行环境准备完成后再开始。');
    if (!config) throw new Error('先在「解题服务设置」里保存你的 Key。');
    validateConfig(config);
    validateCourseURL(course.url);
    course.status = 'starting'; course.error = ''; course.phase = 'connecting';
    await persist();
    const child = launchController(process.execPath, [path.join(appDir, 'controller.mjs'), course.url, '--config', configFile, '--data-dir', dataDir, '--console'], { cwd: appDir, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    const current = { id: course.id, child, stopped: false };
    active.set(course.id, current);
    let pendingLine = '';
    const output = chunk => {
      pendingLine += chunk.toString();
      const lines = pendingLine.split(/\r?\n/); pendingLine = lines.pop();
      for (const line of lines) if (line.trim()) log(line.trim(), course.id);
      pendingLine = pendingLine.slice(-4000);
    };
    child.stdout?.on('data', output); child.stderr?.on('data', output);
    child.on('message', message => {
      if (active.get(course.id) !== current) return;
      if (message?.type === 'error') { course.error = scrub(message.error); return; }
      if (message?.type !== 'state') return;
      const status = message.state;
      if (!status || String(status.courseId) !== course.id) return;
      for (const key of ['phase', 'completed', 'total', 'lockedUnits', 'currentTitle']) course[key] = status[key];
      if (message.title && !course.customName && course.nameSource !== 'catalog') course.name = scrub(message.title).slice(0, 120);
      course.error = scrub(status.error || '');
      if (!['stopping', 'pausing'].includes(course.status)) course.status = status.phase === 'complete' ? 'complete' : status.phase === 'paused' ? 'paused' : 'running';
      if (course.status === 'pausing' && !status.active) course.status = 'paused';
      persist().catch(error => log(error.message));
    });
    child.once('error', error => {
      course.error = scrub(error.message); course.status = 'error';
      if (active.get(course.id) === current) active.delete(course.id);
      queueRunning = active.size > 0;
      persist().catch(error => log(error.message));
    });
    child.once('exit', (code, signal) => {
      if (active.get(course.id) !== current) return;
      active.delete(course.id);
      queueRunning = active.size > 0;
      if (current.stopped) { course.status = 'stopped'; course.error = ''; }
      else if (course.phase === 'complete' && code === 0) course.status = 'complete';
      else { course.status = 'error'; course.error ||= '连接已中断，请检查 Chrome 登录、调试开关和授权后重试。'; }
      if (signal) log('课程连接已结束，已完成进度保留。', course.id);
      persist().catch(error => log(error.message));
    });
    log('开始连接：' + course.name, course.id);
  }

  async function actionCourse(id, action) {
    const course = selected(id);
    const worker = active.get(course.id);
    if (action === 'focus') { if (!worker) throw new Error('这门课程当前没有连接。'); worker.child.send({ type: 'command', action: 'focus' }); return; }
    if (action === 'start') { queueRunning = false; return startCourse(course); }
    if (action === 'resume') {
      if (worker && course.status === 'paused') {
        course.status = 'running'; course.error = ''; worker.child.send({ type: 'command', action: 'resume' }); return persist();
      }
      queueRunning = false; return startCourse(course);
    }
    if (action === 'pause') {
      if (!worker || !['running', 'starting'].includes(course.status)) throw new Error('这门课程当前没有运行。');
      queueRunning = false; course.status = 'pausing'; worker.child.send({ type: 'command', action: 'pause' }); return persist();
    }
    if (action === 'stop') {
      queueRunning = false;
      if (worker) {
        worker.stopped = true; course.status = 'stopping';
        worker.child.send({ type: 'command', action: 'stop' });
      } else { course.status = 'stopped'; course.error = ''; }
      return persist();
    }
    if (action === 'remove') {
      if (worker) throw new Error('请先停止这门课程，再移除。');
      courses.splice(courses.indexOf(course), 1); return persist();
    }
    throw new Error('不支持这个操作。');
  }

  async function requestBody(request) {
    let text = '';
    for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 16384) throw new Error('输入内容过长。'); }
    try { return JSON.parse(text || '{}'); } catch { throw new Error('输入格式不正确。'); }
  }

  function nextConfig(body) {
    return validateConfig({ base_url: body.base_url ?? config?.base_url ?? defaults.base_url, model: body.model ?? config?.model ?? defaults.model,
      wire_api: 'responses', reasoning_effort: 'medium', budget: body.budget ?? config?.budget ?? defaults.budget,
      pricing: body.pricing ?? config?.pricing ?? structuredClone(defaults.pricing), api_key: body.api_key || config?.api_key || '' });
  }

  async function mutate(route, body) {
    if (route === '/api/browser-open') return browserSession.open(body.target);
    if (route === '/api/browser-connect') { await browserSession.get(); return; }
    if (route === '/api/browser-courses' || route === '/api/courses-import') {
      const items = route === '/api/browser-courses' ? await browserSession.courses() : await Promise.all(String(body.urls || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).map(value => browserSession.resolveCourse(value)));
      if (!items.length) throw new Error('请粘贴课程网址，每行一个。');
      let added = 0;
      for (const item of items) {
        const existing = courses.find(course => course.id === item.id);
        if (existing) { if (!existing.customName && item.name) { existing.name = item.name; existing.nameSource = 'catalog'; } continue; }
        courses.push({ ...item, name: item.name || `课程 ${item.id}`, customName: false, nameSource: item.name ? 'catalog' : 'url', status: 'ready', completed: 0, total: 0, error: '', phase: '', currentTitle: '', checkinEnabled: false }); added++;
      }
      await persist(); requestCheckin(); return { added };
    }
    if (route === '/api/checkin-config') { await checkin.configure(body); requestCheckin(); return; }
    if (route === '/api/checkin-test') return checkin.testBrowser(body.profileDirectory);
    if (route === '/api/checkin-open') return checkin.manual(body.ids);
    if (route === '/api/checkin-course') {
      const course = selected(body.id);
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('请选择是否加入每日签到。');
      const url = body.url === undefined ? course.checkinURL : checkinURL(body.url || course.url);
      if (body.name !== undefined) {
        const name = String(body.name).trim().slice(0, 120);
        if (!name) throw new Error('课程名称不能为空。');
        course.name = name; course.customName = true;
      }
      if (body.enabled !== undefined) course.checkinEnabled = body.enabled;
      if (url !== undefined) course.checkinURL = url;
      await persist(); requestCheckin(); return;
    }
    if (route === '/api/config') {
      if (active.size) throw new Error('先停止正在运行的课程，再修改解题服务设置。');
      const next = nextConfig(body);
      await saveJSON(configFile, next); config = next; configError = '';
      Object.assign(connection, { status: 'untested', message: '设置已保存，可以测试连接' });
      log('解题服务设置已保存。'); return;
    }
    if (route === '/api/test-connection') {
      const settings = nextConfig(body);
      const tested = { status: 'testing', message: '正在测试连接' };
      const savedMatch = config && JSON.stringify(settings) === JSON.stringify(config);
      if (savedMatch) Object.assign(connection, tested);
      try {
        const base = new URL(settings.base_url.replace(/\/+$/, '') + '/');
        const response = await fetchImpl(new URL('models', base), { headers: { Authorization: `Bearer ${settings.api_key}` }, redirect: 'error', signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Key 不可用，请检查后重新保存。' : response.status === 404 || response.status === 405 ? '服务商未提供连接检测接口；请核对接口地址。' : `服务商返回 HTTP ${response.status}，请稍后重试。`);
        const text = await response.text();
        if (text.length > 2 * 1024 * 1024) throw new Error('检测结果过长。');
        let models;
        try { models = JSON.parse(text).data; } catch { throw new Error('接口返回格式不正确，请核对地址。'); }
        if (!Array.isArray(models)) throw new Error('服务商未返回模型列表，请核对接口地址。');
        if (!models.some(model => model.id === settings.model)) throw new Error('连接成功，但模型列表中没有所选模型，请核对模型名称。');
        Object.assign(tested, { status: 'ok', message: 'Key 和模型列表检查通过；解题能力在运行时确认' });
      } catch (error) { Object.assign(tested, { status: 'error', message: scrub(error.message).replaceAll(settings.api_key, '[已隐藏]') }); }
      if (savedMatch) Object.assign(connection, tested);
      return { connection: tested };
    }
    if (route === '/api/environment') { prepareEnvironment(); return; }
    if (route === '/api/courses') {
      const url = courseFromURL(validateCourseURL(body.url)).url; const id = new URL(url).hash.replace(/^#\/?/, '').split('/')[0];
      if (courses.some(course => course.id === id)) throw new Error('这门课程已经在列表里了。');
      const name = String(body.name || '').trim().slice(0, 120);
      courses.push({ id, url, name: name || `课程 ${courses.length + 1}`, customName: Boolean(name), status: 'ready', completed: 0, total: 0, error: '', phase: '', currentTitle: '', checkinEnabled: body.checkinEnabled === true });
      await persist(); log('已添加课程。', id); requestCheckin(); return;
    }
    if (route === '/api/course-action') return actionCourse(body.id, body.action);
    if (route === '/api/queue') {
      const targets = body.ids === undefined ? courses : (() => {
        if (!Array.isArray(body.ids)) throw new Error('请选择课程。');
        return [...new Set(body.ids.map(String))].map(selected);
      })();
      if (body.action === 'start') {
        if (targets.filter(course => course.status !== 'complete').length > 1) throw new Error('一次只运行一门课，请点课程旁的「开始」。');
        if (!config) throw new Error('先保存你的解题服务 Key。');
        if (environment.status !== 'ready') throw new Error('请等运行环境准备完成。');
        for (const course of targets) {
          if (course.status === 'complete') continue;
          if (active.has(course.id)) { if (course.status === 'paused') await actionCourse(course.id, 'resume'); continue; }
          await startCourse(course);
        }
        queueRunning = active.size > 0; return;
      }
      if (['pause', 'stop'].includes(body.action)) {
        for (const course of targets) if (active.has(course.id) && (body.action === 'stop' || ['running', 'starting'].includes(course.status))) await actionCourse(course.id, body.action);
        queueRunning = false; await persist(); return;
      }
    }
    if (route === '/api/shutdown') { setImmediate(() => close()); return; }
    throw new Error('找不到这个操作。');
  }

  const assets = { '/': ['console.html', 'text/html; charset=utf-8'], '/console.css': ['console.css', 'text/css; charset=utf-8'], '/console.js': ['console.js', 'text/javascript; charset=utf-8'] };
  function json(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (request.headers.host !== origin.slice(7)) { json(response, 403, { error: '请从启动入口打开控制台。' }); return; }
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && url.pathname === '/' && url.searchParams.get('token') === token) {
        response.writeHead(303, { Location: '/', 'Set-Cookie': `szu_session=${token}; HttpOnly; SameSite=Strict; Path=/` }); response.end(); return;
      }
      const authenticated = (request.headers.cookie || '').split(';').some(cookie => cookie.trim() === `szu_session=${token}`);
      if (!authenticated) { json(response, 401, { error: '控制台会话已过期，请重新双击启动。' }); return; }
      if (request.method === 'GET' && url.pathname === '/api/state') { json(response, 200, await state()); return; }
      if (request.method === 'GET' && url.pathname === '/api/checkin-profiles') {
        const browser = await checkin.profiles(); json(response, 200, { available: browser.available, profiles: browser.profiles, error: browser.error }); return;
      }
      if (request.method === 'GET' && url.pathname === '/szu-uooc.user.js') {
        response.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Content-Disposition': 'inline; filename="szu-uooc.user.js"' });
        response.end(await fs.readFile(path.join(appDir, 'szu-uooc.user.js'))); return;
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (request.headers.origin !== origin || request.headers['x-szu-token'] !== csrf || !request.headers['content-type']?.startsWith('application/json')) { json(response, 403, { error: '操作来源无效，请刷新控制台重试。' }); return; }
        const body = await requestBody(request);
        const call = mutations.then(() => mutate(url.pathname, body)); mutations = call.catch(() => {});
        const result = await call; json(response, 200, { ok: true, ...result }); return;
      }
      if (request.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname]; response.writeHead(200, { 'Content-Type': type }); response.end(await fs.readFile(path.join(appDir, 'student', file))); return;
      }
      json(response, 404, { error: '找不到这个页面。' });
    } catch (error) { json(response, 400, { error: scrub(error.message) }); }
  });
  let port = 0;
  try {
    const previous = new URL((await readJSON(path.join(dataDir, 'console-address.json'), null))?.url);
    if (previous.protocol === 'http:' && previous.hostname === '127.0.0.1' && !previous.username && !previous.password
      && previous.pathname === '/' && !previous.hash && Number(previous.port) >= 1024 && Number(previous.port) <= 65535) port = Number(previous.port);
  } catch { /* Missing or damaged launch metadata must not prevent startup. */ }
  await new Promise((resolve, reject) => {
    const ready = () => { server.removeListener('error', failed); resolve(); };
    const failed = error => {
      if (port && error.code === 'EADDRINUSE') { port = 0; server.listen(port, '127.0.0.1'); }
      else { server.removeListener('listening', ready); server.removeListener('error', failed); reject(error); }
    };
    server.on('error', failed); server.once('listening', ready); server.listen(port, '127.0.0.1');
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  async function close() {
    if (shuttingDown) return;
    shuttingDown = true; queueRunning = false;
    await checkin.close();
    dependencyChild?.kill();
    await Promise.all([...active.values()].map(async ({ id, child }) => {
      const exited = new Promise(resolve => {
        const timeout = setTimeout(() => { child.kill(); resolve(); }, 135000); timeout.unref();
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
      await actionCourse(id, 'stop').catch(() => {}); await exited;
    }));
    await browserSession.close();
    await savedQueue;
    await new Promise(resolve => server.close(resolve));
  }
  await persist();
  checkin.start().catch(error => log(error.message));
  prepareEnvironment();
  return { url: `${origin}/?token=${token}`, origin, server, close, state, checkin };
}
