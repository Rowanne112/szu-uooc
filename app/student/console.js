const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icons = { play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m9 5 11 7-11 7z"/></svg>', pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>' };
let state;
let polling = false;
let busy = false;
let toastTimeout;
let closed = false;
let seenCheckinBatch;
let guideStep = "login";
let guideError = "";

function toast(message, error = false) {
  const element = $('#toast'); element.textContent = message; element.classList.toggle('error', error); element.hidden = false;
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => element.hidden = true, error ? 6500 : 3000);
}
function money(amount) { return amount === null ? '待核对' : '$' + Number(amount || 0).toFixed(4); }
function percent(course) { return course.total ? Math.max(0, Math.min(100, Math.round(course.completed / course.total * 100))) : 0; }
function badge(course) { return `<span class="status ${esc(course.status)}"><i></i>${esc(course.statusLabel)}</span>`; }
function progress(course) { return `<progress class="progress" value="${percent(course)}" max="100" aria-label="${esc(course.name)}进度">${percent(course)}%</progress>`; }
function courseButton(course, action, text, cls = 'secondary') {
  const blocked = ['start', 'resume'].includes(action) && state.activeIds.some(id => id !== course.id);
  return `<button class="button ${cls}" data-course="${esc(course.id)}" data-action="${action}" ${busy || blocked ? 'disabled' : ''} ${blocked ? 'title="先停止当前课程，再开始另一门"' : ''}>${text}</button>`;
}
function buttons(course) {
  if (['pausing', 'stopping'].includes(course.status)) return `<button class="button secondary" disabled>${esc(course.statusLabel)}…</button>`;
  if (course.status === 'running' && course.phase === 'awaiting_verification' && state.activeIds.includes(course.id)) return courseButton(course, 'focus', '去验证', 'primary') + courseButton(course, 'pause', '暂停');
  if (state.activeIds.includes(course.id) && ['running', 'starting'].includes(course.status)) return courseButton(course, 'pause', '暂停');
  if (course.status === 'paused') return courseButton(course, 'resume', course.error && !['用户暂停', '用户停止'].includes(course.error) ? '重试' : '继续') + (state.activeIds.includes(course.id) ? courseButton(course, 'stop', '停止') : '');
  if (course.status === 'complete') return '<span class="done-icon" aria-label="已完成"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg></span>';
  return courseButton(course, 'start', course.status === 'error' ? '重试' : course.status === 'stopped' ? '继续' : '开始');
}
const renderedHTML = new Map();
function updateHTML(selector, html) {
  if (renderedHTML.get(selector) === html) return;
  const element = $(selector), opened = [...element.querySelectorAll('.course-row details[open]')].map(detail => detail.closest('[data-id]').dataset.id);
  const focus = document.activeElement;
  const focusRow = element.contains(focus) ? focus.closest('.course-row')?.dataset.id : null;
  const focusIndex = focusRow ? [...focus.closest('.course-row').querySelectorAll('button,input,summary,a')].indexOf(focus) : -1;
  element.innerHTML = html; renderedHTML.set(selector, html);
  for (const id of opened) element.querySelector(`.course-row[data-id="${CSS.escape(id)}"] details`)?.setAttribute('open', '');
  if (focusRow) element.querySelector(`.course-row[data-id="${CSS.escape(focusRow)}"]`)?.querySelectorAll('button,input,summary,a')[focusIndex]?.focus({ preventScroll: true });
}
function renderGuide() {
  const environment = state.environment, browser = state.browser || {};
  let html;
  if (environment.status !== 'ready') html = `<h2>${esc(environment.message)}</h2>${environment.status === 'error' ? '<button class="button primary" data-environment>重新下载</button>' : '<progress aria-label="正在准备运行环境"></progress>'}`;
  else if (browser.status !== 'connected') {
    if (guideStep === 'login' && !state.courses.length && browser.status !== 'connecting') html = '<h2>先登录你的课程账号</h2><div class="guide-actions"><button class="button primary" data-browser-open="site">打开 UOOC</button><button class="button secondary" data-guide-step="debug">已登录，下一步</button></div>';
    else html = `<h2>${browser.status === 'connecting' ? '在 Chrome 弹窗中点「允许」' : '连接 Chrome'}</h2><input id="debug-url" aria-label="Chrome 调试页地址" readonly value="chrome://inspect/#remote-debugging"><p class="guide-note">在 Chrome 地址栏粘贴并回车，再开启该页开关。</p><div class="guide-visual"><span>Chrome</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg><strong>Allow remote debugging</strong><span class="switch" aria-hidden="true"></span></div><div class="guide-actions"><button class="button secondary" data-copy-debug>复制调试页地址</button><button class="button primary" data-connect>${browser.status === 'connecting' ? '等待允许…' : '已开启，连接 Chrome'}</button></div><p class="guide-note">Chrome 弹窗会请求控制浏览器，以读取课程并打开学习页。</p>`;
  } else if (browser.catalog === 'error') html = '<h2>重新打开我的课程</h2><div class="guide-actions"><button class="button primary" data-browser-open="site">打开 UOOC</button><button class="button secondary" data-read-courses>已登录，读取课程</button></div>';
  else if (!state.courses.length) html = '<h2>把所有课程放进来</h2><div class="guide-actions"><button class="button primary" data-read-courses>读取我的课程</button><button class="button secondary" data-browser-open="site">打开我的课程</button></div><p class="guide-note"><button class="text-button" data-open="add">或批量粘贴课程网址</button></p>';
  else if (!state.config.hasKey) html = '<h2>填入解题 Key</h2><button class="button primary" data-open="settings">设置解题服务</button>';
  $('#onboarding').hidden = !html;
  updateHTML('#guide-content', html ? `<div class="guide-body">${html}</div>` : '');
  $('#guide-error').textContent = guideError || browser.error || state.configError || '';
  document.querySelectorAll('#onboarding button').forEach(button => button.disabled = busy);
}
function render() {
  state.activeIds ||= state.activeId ? [state.activeId] : [];
  renderGuide();
  $('#courses-section').hidden = !state.courses.length;
  $('#service-label').textContent = state.config.hasKey ? state.config.model : '未设置';
  $('#checkin-summary').textContent = state.checkin?.settings.enabled ? '已开启' : '未开启';
  $('#browser-summary').textContent = state.browser?.status === 'connected' ? '已连接' : '未连接';
  $('#stop-all').disabled = busy || !state.activeIds.length;
  updateHTML('#course-list', state.courses.map(course => {
    const awaiting = course.status === 'running' && course.phase === 'awaiting_verification' && state.activeIds.includes(course.id);
    const canStart = state.config.hasKey && state.environment.status === 'ready' && state.browser?.status === 'connected';
    const control = !canStart && !state.activeIds.includes(course.id) ? '' : buttons(course);
    return `<article class="course-row" data-id="${esc(course.id)}"><div class="course-name"><h3>${esc(course.name)}</h3><p>${esc(course.currentTitle || (course.status === 'ready' ? '整门课程' : course.phaseLabel || course.statusLabel))}</p>${course.error ? `<p class="course-error" role="status">${esc(course.error)}</p>` : ''}</div><div class="course-progress"><div class="course-status ${esc(awaiting ? course.phase : course.status)}"><span>${esc(awaiting ? '待验证' : course.statusLabel)}</span><span>${course.total ? `${Number(course.completed) || 0} / ${Number(course.total)}` : '—'}</span></div>${progress(course)}</div><div class="course-buttons">${control}<details class="course-menu"><summary aria-label="${esc(course.name)}更多操作"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></summary><div>${state.activeIds.includes(course.id) ? `<button data-course="${esc(course.id)}" data-action="focus">切到课程</button>` : `<a href="${esc(course.url)}" target="_blank" rel="noopener noreferrer">打开课程</a>`}<button data-edit-course="${esc(course.id)}">课程与签到</button>${state.activeIds.includes(course.id) ? `<button data-course="${esc(course.id)}" data-action="stop">停止学习</button>` : `<button data-course="${esc(course.id)}" data-action="remove">移出列表</button>`}<span class="field-help">费用 ${money(course.costs.spent)}${course.costs.reserved ? ' · 预留 ' + money(course.costs.reserved) : ''}${course.costs.unknown ? ' · 待核对' : ''}</span></div></details></div></article>`;
  }).join(''));
  updateHTML('#log-list', [...state.logs].reverse().map(log => `<li><time>${new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>${esc(log.message)}</li>`).join(''));
  if (state.checkin) {
    $('#checkin-message').textContent = `${state.checkin.date} · ${state.checkin.counts.opened} / ${state.checkin.counts.total} 今日已打开（请在网站核对签到）`;
    $('#checkin-reopen').disabled = busy || state.checkin.running || !state.checkin.settings.browser || !state.checkin.counts.total;
    updateHTML('#checkin-courses', state.courses.map(course => `<div class="checkin-choice"><label class="checkbox-label"><input type="checkbox" data-checkin-course="${esc(course.id)}" ${course.checkin.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}>${esc(course.name)}</label><span>${esc(course.checkin.label)}</span></div>`).join(''));
  }
}
async function refresh() {
  if (polling || closed) return;
  polling = true;
  try {
    const response = await fetch('/api/state'); const data = await response.json();
    if (!response.ok) throw new Error(data.error || '无法连接控制台');
    state = data; $('#connection-error').hidden = true; render();
    if (state.shuttingDown) showClosed();
  } catch (error) { $('#connection-error').textContent = error.message + '。请重新双击启动。'; $('#connection-error').hidden = false; }
  finally { polling = false; }
}
async function api(route, data = {}) {
  if (!state) throw new Error('控制台尚未连接，请稍后重试。');
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Szu-Token': state.csrf }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '操作没有完成');
  await refresh(); return result;
}
async function runAction(fn) {
  if (busy) return;
  busy = true; if (state) render();
  try { await fn(); } catch (error) { toast(error.message, true); }
  finally { busy = false; if (state && !closed) render(); }
}
function settingsValues() {
  return { api_key: $('#api-key').value.trim(), base_url: $('#base-url').value.trim(), model: $('#model').value.trim(), budget: Number($('#budget').value), pricing: { input_per_million: Number($('#price-input').value), cached_input_per_million: Number($('#price-cache').value), output_per_million: Number($('#price-output').value) } };
}
function updatePrices() {
  const values = settingsValues();
  $('#price-summary').textContent = `每百万 token：输入 $${values.pricing.input_per_million} · 缓存 $${values.pricing.cached_input_per_million} · 输出 $${values.pricing.output_per_million}；每门课预算 $${values.budget}。`;
  try { $('#provider-summary').textContent = new URL(values.base_url).hostname; } catch { $('#provider-summary').textContent = '自定义服务'; }
  $('#model-summary').textContent = values.model;
}
function openDialog(name) {
  if (name === 'checkin') {
    if (!state?.checkin) { toast('控制台正在连接，请稍候。'); return; }
    const settings = state.checkin.settings;
    $('#checkin-enabled').checked = settings.enabled; $('#checkin-mode').value = settings.mode; $('#checkin-time').value = settings.time;
    $('#checkin-time-field').hidden = settings.mode !== 'scheduled'; $('#checkin-autostart').checked = settings.autostart; $('#checkin-script-ready').checked = settings.scriptReady;
    $('#checkin-error').textContent = ''; loadProfiles(settings.browser?.profileDirectory);
  }
  if (name === 'settings') {
    if (!state) { toast('控制台正在连接，请稍候。'); return; }
    const config = state.config;
    $('#api-key').value = ''; $('#api-key').type = 'password'; $('#show-key').textContent = '显示';
    $('#api-key').placeholder = config.hasKey ? '已保存，留空保留原 Key' : '粘贴你的 Key';
    $('#base-url').value = config.base_url; $('#model').value = config.model; $('#budget').value = config.budget;
    $('#price-input').value = config.pricing.input_per_million; $('#price-cache').value = config.pricing.cached_input_per_million; $('#price-output').value = config.pricing.output_per_million;
    $('#settings-error').textContent = ''; $('#test-result').textContent = ''; updatePrices();
  }
  if (name === 'add') { $('#add-error').textContent = ''; }
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('#' + name + '-dialog').showModal();
}
document.addEventListener('click', event => {
  const menu = event.target.closest('.course-menu'); if (menu && !event.target.closest('summary')) menu.removeAttribute('open');
  const edit = event.target.closest('[data-edit-course]');
  if (edit) {
    const course = state.courses.find(course => course.id === edit.dataset.editCourse);
    $('#edit-course-id').value = course.id; $('#edit-course-name').value = course.name; $('#edit-course-checkin').checked = course.checkin.enabled;
    $('#edit-checkin-url').value = course.checkin.url; $('#course-checkin-error').textContent = ''; $('#course-checkin-dialog').showModal();
  }
  const reopen = event.target.closest('[data-reopen-course]');
  if (reopen) runAction(() => api('/api/checkin-open', { ids: [reopen.dataset.reopenCourse] }));
  const open = event.target.closest('[data-open]'); if (open) openDialog(open.dataset.open);
  const close = event.target.closest('[data-close]'); if (close) close.closest('dialog').close();
  const action = event.target.closest('[data-course][data-action]');
  if (action) runAction(async () => { await api('/api/course-action', { id: action.dataset.course, action: action.dataset.action }); if (action.dataset.action === 'remove') toast('已从列表移除，已完成进度保留。'); });

});
document.addEventListener('change', event => {
  if (event.target.matches('[data-checkin-course]')) runAction(() => api('/api/checkin-course', { id: event.target.dataset.checkinCourse, enabled: event.target.checked }));
});
async function loadProfiles(selected = $('#checkin-profile').value) {
  $('#checkin-profile').disabled = true;
  try {
    const response = await fetch('/api/checkin-profiles'); const data = await response.json(); if (!response.ok) throw new Error(data.error);
    $('#checkin-profile').innerHTML = '<option value="">请选择已登录的资料</option>' + data.profiles.map(profile => `<option value="${esc(profile.directory)}">${esc(profile.name)} · ${esc(profile.directory)}</option>`).join('');
    if (selected) $('#checkin-profile').value = selected;
    $('#checkin-profile-note').textContent = data.error || '使用「测试打开」确认网站显示的是你的账号。登录失效时，请在这个资料中重新登录。';
  } catch (error) { $('#checkin-profile-note').textContent = error.message; }
  finally { $('#checkin-profile').disabled = false; }
}
$('#checkin-mode').addEventListener('change', () => $('#checkin-time-field').hidden = $('#checkin-mode').value !== 'scheduled');
$('#checkin-refresh-profiles').addEventListener('click', () => loadProfiles());
$('#checkin-test-browser').addEventListener('click', () => runAction(async () => { await api('/api/checkin-test', { profileDirectory: $('#checkin-profile').value }); toast('已请求打开 UOOC，请核对当前账号。'); }));
$('#checkin-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  runAction(async () => {
    try { await api('/api/checkin-config', { enabled: $('#checkin-enabled').checked, mode: $('#checkin-mode').value, time: $('#checkin-time').value, autostart: $('#checkin-autostart').checked, scriptReady: $('#checkin-script-ready').checked, profileDirectory: $('#checkin-profile').value }); $('#checkin-dialog').close(); toast('签到设置已保存。'); }
    catch (error) { $('#checkin-error').textContent = error.message; }
  });
});
$('#edit-course-reopen').addEventListener('click', () => runAction(() => api('/api/checkin-open', { ids: [$('#edit-course-id').value] })));
$('#course-checkin-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  runAction(async () => { try { await api('/api/checkin-course', { id: $('#edit-course-id').value, name: $('#edit-course-name').value, enabled: $('#edit-course-checkin').checked, url: $('#edit-checkin-url').value }); $('#course-checkin-dialog').close(); toast('课程设置已保存。'); } catch (error) { $('#course-checkin-error').textContent = error.message; } });
});
$('#checkin-reopen').addEventListener('click', () => runAction(() => api('/api/checkin-open', { ids: state.courses.filter(course => course.checkin.enabled).map(course => course.id) })));
$('#add-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return; const button = event.submitter; button.disabled = true;
  runAction(async () => { try { await api('/api/courses-import', { urls: $('#course-url').value }); event.target.reset(); $('#add-dialog').close(); toast('课程已添加。'); } catch (error) { $('#add-error').textContent = error.message; } finally { button.disabled = false; } });
});
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return; const button = event.submitter; button.disabled = true;
  runAction(async () => { try { await api('/api/config', settingsValues()); $('#api-key').value = ''; $('#settings-dialog').close(); toast('解题服务设置已保存。'); } catch (error) { $('#settings-error').textContent = error.message; } finally { button.disabled = false; } });
});
$('#settings-form').addEventListener('input', updatePrices);
$('#show-key').addEventListener('click', () => { const field = $('#api-key'); field.type = field.type === 'password' ? 'text' : 'password'; $('#show-key').textContent = field.type === 'password' ? '显示' : '隐藏'; $('#show-key').setAttribute('aria-label', field.type === 'password' ? '显示输入的 Key' : '隐藏输入的 Key'); });
$('#test-connection').addEventListener('click', () => runAction(async () => {
  $('#test-connection').disabled = true; $('#test-result').textContent = '正在检查 Key 和模型列表，不发送解题请求…';
  try { const result = await api('/api/test-connection', settingsValues()); $('#test-result').textContent = result.connection.message; $('#test-result').classList.toggle('error', result.connection.status === 'error'); }
  catch (error) { $('#test-result').textContent = error.message; $('#test-result').classList.add('error'); }
  finally { $('#test-connection').disabled = false; }
}));
$('#stop-all').addEventListener('click', () => runAction(() => api('/api/queue', { action: 'stop' })));
document.addEventListener('click', async event => {
  const copy = event.target.closest('[data-copy-debug]');
  if (copy) {
    const field = $('#debug-url'); field.focus(); field.select();
    try { await navigator.clipboard.writeText(field.value); toast('已复制，在 Chrome 地址栏粘贴并回车。'); }
    catch { toast('请复制已选中的地址，粘贴到 Chrome 地址栏。'); }
  }
  const step = event.target.closest('[data-guide-step]'); if (step) { guideStep = step.dataset.guideStep; guideError = ''; render(); }
  const open = event.target.closest('[data-browser-open]'); if (open) runAction(async () => { await api('/api/browser-open', { target: open.dataset.browserOpen }); });
  const connect = event.target.closest('[data-connect]'); if (connect) runAction(async () => { guideError = ''; try { await api('/api/browser-connect'); await api('/api/browser-courses'); } catch (error) { guideError = error.message; } });
  const read = event.target.closest('[data-read-courses]'); if (read) runAction(async () => { guideError = ''; read.textContent = '读取中…'; try { const result = await api('/api/browser-courses'); toast(`已加入 ${result.added} 门课程`); } catch (error) { guideError = error.message; toast(error.message, true); } finally { read.textContent = '刷新课程'; } });
  if (event.target.closest('[data-environment]')) runAction(() => api('/api/environment'));
});
$('#connect-again').addEventListener('click', () => { $('#preferences-dialog').close(); guideStep = 'debug'; runAction(async () => { await api('/api/browser-connect'); await api('/api/browser-courses'); }); });
function showClosed() { closed = true; document.querySelectorAll('button').forEach(button => button.disabled = true); $('#connection-error').className = 'notice'; $('#connection-error').textContent = '控制台已关闭，后续任务已停止。下次双击启动即可继续。'; $('#connection-error').hidden = false; }
$('#exit-button').addEventListener('click', () => runAction(async () => { await api('/api/shutdown'); showClosed(); }));
refresh(); setInterval(refresh, 1000);
