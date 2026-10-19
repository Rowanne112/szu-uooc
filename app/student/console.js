import {explainProblem, activityMessage} from './user-guidance.mjs';
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
const browserName = () => state?.browser?.name || 'Chrome';

function toast(message, error = false) {
  if (error) { const dialog = document.querySelector('dialog[open]'); const target = dialog?.querySelector('.form-error') || $('#action-error'); if (dialog && target.id === 'action-error') dialog.close(); target.textContent = explainProblem(message, browserName()); target.hidden = false; return; }
  const element = $('#toast'); element.textContent = message; element.classList.toggle('error', error); element.hidden = false;
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => element.hidden = true, error ? 6500 : 3000);
}
function money(amount) { return amount === null ? '待核对' : amount > 0 && amount < .0001 ? '< $0.0001' : '$' + Number(amount || 0).toFixed(4); }
function percent(course) { return course.total ? Math.max(0, Math.min(100, Math.round(course.completed / course.total * 100))) : 0; }
function badge(course) { return `<span class="status ${esc(course.status)}"><i></i>${esc(course.statusLabel)}</span>`; }
function progress(course) {
  if (course.lockedUnits > 0 || course.phase === 'loading_catalog') return `<p class="field-help">已读取任务（含视频和测验）；${course.lockedUnits > 0 ? `${Number(course.lockedUnits)} 个目录单元待解锁` : '正在读取目录'}，总任务数待确认</p>`;
  return `<progress class="progress" value="${percent(course)}" max="100" aria-label="${esc(course.name)}任务进度">${percent(course)}%</progress>`;
}
function courseButton(course, action, text, cls = 'secondary') {
  const blocked = ['start', 'resume'].includes(action) && state.activeIds.some(id => id !== course.id);
  return `<button class="button ${cls}" data-course="${esc(course.id)}" data-action="${action}" ${busy || blocked ? 'disabled' : ''} ${blocked ? 'title="先停止当前课程，再开始另一门"' : ''}>${text}</button>`;
}
function buttons(course) {
  if (['pausing', 'stopping'].includes(course.status)) return `<button class="button secondary" disabled>${esc(course.statusLabel)}…</button>`;
  if (course.status === 'running' && course.phase === 'awaiting_verification' && state.activeIds.includes(course.id)) return courseButton(course, 'focus', '去验证', 'primary') + courseButton(course, 'pause', '暂停');
  if (state.activeIds.includes(course.id) && ['running', 'starting'].includes(course.status)) return courseButton(course, 'pause', '暂停');
  if (course.status === 'paused') return courseButton(course, 'resume', '继续') + (state.activeIds.includes(course.id) ? courseButton(course, 'stop', '停止') : '');
  if (course.status === 'complete') return '<span class="done-icon" aria-label="已完成"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4 10-10"/></svg></span>';
  return courseButton(course, 'start', ['error','stopped'].includes(course.status) ? '继续' : '开始');
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
  if (environment.status !== 'ready') html = `<h2>${esc(environment.status === 'error' ? '请重新下载启动所需的文件' : '正在准备启动所需的文件，请保持联网')}</h2>${environment.status === 'error' ? '<button class="button primary" data-environment>重新下载</button>' : '<progress aria-label="正在准备运行环境"></progress>'}`;
  else if (browser.selectionRequired) html = '<h2>选择学习浏览器</h2><div class="guide-actions"><button class="button primary" data-open="browser">选择浏览器</button></div>';
  else if (browser.status !== 'connected') {
    if (guideStep === 'login' && !state.courses.length && browser.status !== 'connecting') html = '<h2>先登录你的课程账号</h2><div class="guide-actions"><button class="button primary" data-browser-open="site">打开 UOOC</button><button class="button secondary" data-guide-step="debug">已登录，下一步</button></div>';
    else html = `<h2>${browser.status === 'connecting' ? `在 ${browserName()} 中允许连接` : `连接 ${browserName()}`}</h2><input id="debug-url" aria-label="${esc(browserName())} 调试页地址" readonly value="${esc(browser.debugURL)}"><p class="guide-note">在 ${esc(browserName())} 地址栏粘贴并回车，再开启该页开关。</p><div class="guide-visual"><span>${esc(browserName())}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg><strong>Allow remote debugging</strong><span class="switch" aria-hidden="true"></span></div><div class="guide-actions"><button class="button secondary" data-copy-debug>复制调试页地址</button><button class="button primary" data-connect>${browser.status === 'connecting' ? '等待允许…' : `已开启，连接 ${browserName()}`}</button></div><p class="guide-note">允许所选浏览器的连接请求，以读取课程并打开学习页。</p>`;
  } else if (browser.catalog === 'error') html = '<h2>重新打开我的课程</h2><div class="guide-actions"><button class="button primary" data-browser-open="site">打开 UOOC</button><button class="button secondary" data-read-courses>已登录，读取课程</button></div>';
  else if (!state.courses.length) html = '<h2>把所有课程放进来</h2><div class="guide-actions"><button class="button primary" data-read-courses>读取我的课程</button><button class="button secondary" data-browser-open="site">打开我的课程</button></div><p class="guide-note"><button class="text-button" data-open="add">或批量粘贴课程网址</button></p>';
  else if (browser.needsCourseRefresh) html = '<h2>重新读取课程并核对账号</h2><button class="button primary" data-read-courses>读取我的课程</button>';
  else if (!state.config.hasKey && state.config.answer_mode !== 'free') html = '<h2>选择答题方式</h2><p class="guide-note">不填 Key 也能开始。免费模式优先题库，缺题随机作答并自动提交，可能答错；缺答案的填空题需人工处理。</p><div class="guide-actions"><button class="button primary" data-free-mode>先不填，免费开始</button><button class="button secondary" data-open="settings">设置解题服务</button></div>';
  if (!html && (guideError || browser.error || state.configError)) html = '<h2>请按下面的步骤继续</h2>';
  $('#onboarding').hidden = !html;
  updateHTML('#guide-content', html ? `<div class="guide-body">${html}</div>` : '');
  $('#guide-error').textContent = explainProblem(guideError || browser.error || state.configError, browserName());
  document.querySelectorAll('#onboarding button').forEach(button => button.disabled = busy);
}
function render() {
  state.activeIds ||= state.activeId ? [state.activeId] : [];
  renderGuide();
  $('#courses-section').hidden = !state.courses.length;
  $('#service-label').textContent = state.config.answer_mode === 'free' ? '免费模式' : state.config.hasKey ? state.config.model : '未设置';
  $('#checkin-summary').textContent = state.checkin?.settings.enabled ? '已开启' : '未开启';
  $('#browser-name-summary').textContent = browserName();
  $('#learning-browser-status').textContent = `学习浏览器：${browserName()} · ${state.browser?.status === 'connected' ? '已连接' : state.browser?.status === 'connecting' ? '正在连接' : '未连接'}`;
  $('#change-learning-browser').disabled = busy || Boolean(state.activeIds.length);
  $('#change-learning-browser').title = state.activeIds.length ? '请先停止当前课程，再更换浏览器' : '选择 Chrome 或 Edge，已完成进度和费用记录会保留';
  $('#connect-again-label').textContent = '重新连接 ' + browserName();
  $('#checkin-profile-label').textContent = browserName() + ' 中已登录课程账号的个人资料';
  $('#browser-summary').textContent = state.browser?.status === 'connected' ? '已连接' : '未连接';
  $('#stop-all').disabled = busy || !state.activeIds.length;
  updateHTML('#course-list', state.courses.map(course => {
    const awaiting = course.status === 'running' && course.phase === 'awaiting_verification' && state.activeIds.includes(course.id);
    const canStart = (state.config.hasKey || state.config.answer_mode === 'free') && state.environment.status === 'ready' && state.browser?.status === 'connected' && !state.browser.needsCourseRefresh;
    const control = !canStart && !state.activeIds.includes(course.id) ? '' : buttons(course);
    return `<article class="course-row" data-id="${esc(course.id)}"><div class="course-name"><h3>${esc(course.name)}</h3><p>${esc(course.currentTitle || (course.status === 'ready' ? '整门课程' : course.phaseLabel || course.statusLabel))}</p></div><div class="course-progress"><div class="course-status ${esc(awaiting ? course.phase : course.status)}"><span>${esc(awaiting ? '待验证' : course.statusLabel)}</span><span>${course.total ? `${Number(course.completed) || 0} / ${Number(course.total)}` : '—'}</span></div>${progress(course)}</div><div class="course-buttons">${control}<details class="course-menu"><summary aria-label="${esc(course.name)}更多操作"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></summary><div>${state.activeIds.includes(course.id) ? `<button data-course="${esc(course.id)}" data-action="focus">切到课程</button>` : `<button data-course-open="${esc(course.id)}">打开课程</button>`}<button data-edit-course="${esc(course.id)}">课程与签到</button>${state.activeIds.includes(course.id) ? `<button data-course="${esc(course.id)}" data-action="stop">停止学习</button>` : `<button data-course="${esc(course.id)}" data-action="remove">移出列表</button>`}<span class="field-help">费用记录（含报价上限估算）${money(course.costs.spent)}${course.costs.reserved ? ' · 费用待核对，暂占预算 ' + money(course.costs.reserved) : ''}${course.costs.unknown ? ' · 请到服务商核对扣费' : ''}</span></div></details></div>${course.error && !['用户暂停','用户停止'].includes(course.error) ? `<div class="course-help" role="status">${esc(explainProblem(course.error, browserName()))}${/Key|HTTP\s*(?:401|403)|解题服务|模型|图片|价格|余额|费用未知/.test(course.error) ? `<span class="dialog-actions"><button class="button secondary" data-fix-service="${esc(course.id)}" ${/余额|额度|繁忙|限流/.test(course.error) ? 'data-service-retry="true"' : ''}>${/401|403|Key/.test(course.error) ? '修改 Key' : /余额|额度|繁忙|限流/.test(course.error) ? '重新检测' : '修改服务'}</button>${/图片|识图/.test(course.error) ? `<button class="button secondary" data-course-open="${esc(course.id)}">去课程页面</button>` : ''}</span>` : ''}</div>` : awaiting ? '<p class="course-help">请点「去验证」，完成课程页面上的验证后保持页面打开。</p>' : ''}</article>`;
  }).join(''));
  updateHTML('#log-list', [...state.logs].reverse().map(log => ({...log, text: activityMessage(log.message, browserName())})).filter(log => log.text).map(log => `<li><time>${new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>${esc(log.text)}</li>`).join(''));
  if (state.checkin) {
    $('#checkin-status-error').textContent = explainProblem(state.checkin.error, browserName());
    $('#checkin-message').textContent = `${state.checkin.date} · ${state.checkin.counts.opened} / ${state.checkin.counts.total} 今日已打开（请在网站核对签到）`;
    $('#checkin-reopen').disabled = busy || state.checkin.running || !state.checkin.settings.browser || !state.checkin.counts.total;
    updateHTML('#checkin-courses', state.courses.map(course => `<div class="checkin-choice"><label class="checkbox-label"><input type="checkbox" data-checkin-course="${esc(course.id)}" ${course.checkin.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''}>${esc(course.name)}</label><span>${esc(course.checkin.error ? explainProblem('签到打开失败：' + course.checkin.error, browserName()) : course.checkin.label)}</span></div>`).join(''));
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
  } catch (error) { $('#connection-error').textContent = '请重新双击安装包里的启动文件，在新打开的控制台中继续操作。已完成进度会保留。'; $('#connection-error').hidden = false; }
  finally { polling = false; }
}
async function api(route, data = {}) {
  if (!state) throw new Error('控制台尚未连接，请稍后重试。');
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Szu-Token': state.csrf }, body: JSON.stringify(data) });
  const result = await response.json(); if (!response.ok) throw Object.assign(new Error(result.error || '操作没有完成'), { requiresSubmissionConfirmation: result.requiresSubmissionConfirmation === true });
  await refresh(); return result;
}
async function runAction(fn) {
  if (busy) return;
  busy = true; $('#action-error').hidden = true; if (state) render();
  try { await fn(); } catch (error) { toast(error.message, true); }
  finally { busy = false; if (state && !closed) render(); }
}
function settingsValues() {
  return { answer_mode: $('#answer-mode').value, api_key: $('#api-key').value.trim(), base_url: $('#base-url').value.trim(), model: $('#model').value };
}
function updatePrices() {
  const free = $('#answer-mode').value === 'free';
  $('#ai-settings').hidden = free; $('#free-mode-note').hidden = !free;
  $('#ai-settings').querySelectorAll('input,select').forEach(input => input.disabled = free);
  $('#detect-save').textContent = free ? '保存答题方式' : '检测并保存';
}
function showDetection(result) {
  $('#model-result').hidden = !result?.models?.length;
  $('#model-summary').textContent = result?.model || '尚无经过验证的可用模型';
  $('#model-reason').textContent = result?.reason || result?.message || '';
  $('#image-model-summary').textContent = result?.image_profile ? `图片题实际使用：${result.image_profile.id}${result.image_profile.id === result.model ? '（同一模型）' : '（程序自动安排，使用同一网址和 Key）'}` : result ? '图片题暂不可用；遇到图片题会暂停，请手动完成或修改服务。' : '';
  $('#model').innerHTML = (result?.models || []).map(model => `<option value="${esc(model.id)}">${esc(model.id)} · ${model.verified_image ? '文字与图片已验证' : model.verified_text ? '文字已验证' : model.status === 'failed' ? '检测未通过' : '尚未验证'}${model.pricing ? '' : ' · 价格未知'}</option>`).join('');
  $('#model').value = result?.model || result?.models?.[0]?.id || '';
  $('#model-options').open = false;
  const testCost = result?.testCosts?.calls ? `本次检测 ${result.testCosts.calls} 次调用，费用${result.testCosts.unknown ? '待核对，预算占用' : '上限预估'} ${money(result.testCosts.estimated_usd)}。` : '';
  $('#price-summary').textContent = result?.profile ? `每门课预算上限 $${state.config.budget}；费用按已核实报价的上限预估，实际扣费以服务商账单为准。价格资料更新：${result.profile.price_updated}。${testCost}` : result ? (result.models?.some(model => model.pricing) ? '尚未找到通过验证的可用模型，正式解题已阻止。' : '价格无法核实，付费检测与正式解题均已阻止；预算保护保持开启。') + testCost : '';
}
function serviceActions(message) {
  const auth = /Key|401|403|鉴权/.test(message);
  return `${auth ? '<button type="button" class="button secondary" data-service-action="key">修改 Key</button>' : ''}<button type="button" class="button secondary" data-service-action="retry">重新检测</button><button type="button" class="text-button" data-service-action="url">修改服务</button>`;
}
async function openDialog(name) {
  if (name === 'browser') {
    $('#browser-error').textContent = ''; $('#browser-same-account').checked = false;
    $('#browser-submission-field').hidden = true; $('#browser-submission-confirmed').checked = false; $('#browser-submission-confirmed').required = false;
    try {
      const response = await fetch('/api/browsers'); const data = await response.json(); if (!response.ok) throw new Error(data.error);
      $('#browser-kind').innerHTML = data.browsers.map(browser => `<option value="${esc(browser.kind)}" ${browser.installed ? '' : 'disabled'}>${esc(browser.name)}${browser.installed ? '' : '（未安装）'}</option>`).join('');
      let kind = state.browser.kind;
      if (state.browser.selectionRequired && !data.browsers.some(browser => browser.kind === kind && browser.installed)) kind = data.browsers.find(browser => browser.installed)?.kind || '';
      $('#browser-kind').value = kind;
    } catch (error) { $('#browser-error').textContent = explainProblem(error.message, browserName()); }
  }
  if (name === 'checkin') {
    if (!state?.checkin) { toast('控制台正在连接，请稍候。'); return; }
    const settings = state.checkin.settings;
    $('#checkin-enabled').checked = settings.enabled; $('#checkin-mode').value = settings.mode; $('#checkin-time').value = settings.time;
    $('#checkin-time-field').hidden = settings.mode !== 'scheduled'; $('#checkin-autostart').checked = settings.autostart; $('#checkin-script-ready').checked = settings.scriptReady;
    $('#checkin-confirmation-field').hidden = !settings.requiresConfirmation; $('#checkin-account-confirmed').checked = false;
    $('#checkin-error').textContent = ''; loadProfiles(settings.browser?.profileDirectory);
  }
  if (name === 'settings') {
    if (!state) { toast('控制台正在连接，请稍候。'); return; }
    const config = state.config;
    $('#answer-mode').value = config.answer_mode || 'ai';
    $('#api-key').value = ''; $('#api-key').type = 'password'; $('#show-key').textContent = '显示';
    $('#api-key').placeholder = config.hasKey ? '已保存，留空保留原 Key' : '粘贴你的 Key';
    $('#base-url').value = config.base_url; showDetection(config.detection);
    $('#answer-mode-settings').open = config.answer_mode === 'free';
    $('#settings-error').textContent = ''; $('#test-result').textContent = ''; $('#service-actions').innerHTML = ''; updatePrices();
  }
  if (name === 'add') { $('#add-error').textContent = ''; }
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  $('#' + name + '-dialog').showModal();
}
document.addEventListener('click', event => {
  const fix = event.target.closest('[data-fix-service]');
  if (fix) runAction(async () => {
    if (state.activeIds.includes(fix.dataset.fixService)) {
      await api('/api/course-action', { id: fix.dataset.fixService, action: 'stop' });
      for (let attempt = 0; state.activeIds.includes(fix.dataset.fixService) && attempt < 100; attempt++) { await new Promise(resolve => setTimeout(resolve, 100)); await refresh(); }
      if (state.activeIds.includes(fix.dataset.fixService)) throw new Error('正在停止课程并记录费用，请稍等后再修改服务。');
    }
    await openDialog('settings'); $('#api-key').focus();
  }).then(() => { if (fix.dataset.serviceRetry && $('#settings-dialog').open) detectAndSave(true); });
  const menu = event.target.closest('.course-menu'); if (menu && !event.target.closest('summary')) menu.removeAttribute('open');
  const edit = event.target.closest('[data-edit-course]');
  if (edit) {
    const course = state.courses.find(course => course.id === edit.dataset.editCourse);
    $('#edit-course-id').value = course.id; $('#edit-course-name').value = course.name; $('#edit-course-checkin').checked = course.checkin.enabled;
    $('#edit-checkin-url').value = course.checkin.url; $('#course-checkin-error').textContent = ''; $('#course-checkin-dialog').showModal();
  }
  const courseOpen = event.target.closest('[data-course-open]'); if (courseOpen) runAction(() => api('/api/course-open', { id: courseOpen.dataset.courseOpen }));
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
    $('#checkin-profile').innerHTML = '<option value="">请选择已登录的资料</option>' + data.profiles.map(profile => `<option value="${esc(profile.directory)}">${esc(profile.name)}</option>`).join('');
    if (selected) $('#checkin-profile').value = selected;
    $('#checkin-profile-note').textContent = data.error ? explainProblem(data.error, browserName()) : '先在浏览器右上角头像中核对个人资料名称，在这里选择相同名称，再点「测试打开，核对账号」。';
  } catch (error) { $('#checkin-profile-note').textContent = explainProblem(error.message, browserName()); }
  finally { $('#checkin-profile').disabled = false; }
}
$('#browser-kind').addEventListener('change', () => {
  $('#browser-error').textContent = '';
  $('#browser-submission-field').hidden = true; $('#browser-submission-confirmed').checked = false; $('#browser-submission-confirmed').required = false;
});
$('#browser-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  runAction(async () => {
    try {
      await api('/api/browser-select', { kind: $('#browser-kind').value, sameAccount: $('#browser-same-account').checked, submissionConfirmed: $('#browser-submission-confirmed').checked });
      guideStep = 'login'; guideError = ''; $('#browser-dialog').close(); toast('已保存，请在所选浏览器核对账号并重新读取课程。');
    } catch (error) {
      $('#browser-submission-field').hidden = !error.requiresSubmissionConfirmation;
      $('#browser-submission-confirmed').required = error.requiresSubmissionConfirmation === true; $('#browser-submission-confirmed').checked = false;
      $('#browser-error').textContent = error.requiresSubmissionConfirmation ? error.message : explainProblem(error.message, browserName());
    }
  });
});
$('#checkin-mode').addEventListener('change', () => $('#checkin-time-field').hidden = $('#checkin-mode').value !== 'scheduled');
$('#checkin-refresh-profiles').addEventListener('click', () => loadProfiles());
$('#checkin-test-browser').addEventListener('click', () => runAction(async () => { await api('/api/checkin-test', { profileDirectory: $('#checkin-profile').value }); toast('已请求打开 UOOC，请核对当前账号。'); }));
$('#checkin-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  runAction(async () => {
    try { await api('/api/checkin-config', { enabled: $('#checkin-enabled').checked, mode: $('#checkin-mode').value, time: $('#checkin-time').value, autostart: $('#checkin-autostart').checked, scriptReady: $('#checkin-script-ready').checked, profileDirectory: $('#checkin-profile').value, accountConfirmed: $('#checkin-account-confirmed').checked }); $('#checkin-dialog').close(); toast('签到设置已保存。'); }
    catch (error) { $('#checkin-error').textContent = explainProblem(error.message, browserName()); }
  });
});
$('#edit-course-reopen').addEventListener('click', () => runAction(() => api('/api/checkin-open', { ids: [$('#edit-course-id').value] })));
$('#course-checkin-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  runAction(async () => { try { await api('/api/checkin-course', { id: $('#edit-course-id').value, name: $('#edit-course-name').value, enabled: $('#edit-course-checkin').checked, url: $('#edit-checkin-url').value }); $('#course-checkin-dialog').close(); toast('课程设置已保存。'); } catch (error) { $('#course-checkin-error').textContent = explainProblem(error.message, browserName()); } });
});
$('#checkin-reopen').addEventListener('click', () => runAction(() => api('/api/checkin-open', { ids: state.courses.filter(course => course.checkin.enabled).map(course => course.id) })));
$('#add-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return; const button = event.submitter; button.disabled = true;
  runAction(async () => { try { await api('/api/courses-import', { urls: $('#course-url').value }); event.target.reset(); $('#add-dialog').close(); toast('课程已添加。'); } catch (error) { $('#add-error').textContent = explainProblem(error.message, browserName()); } finally { button.disabled = false; } });
});
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault(); detectAndSave();
});
async function detectAndSave(force = false) {
  if (busy) return;
  return runAction(async () => {
    const values = settingsValues(); const button = $('#detect-save'); button.disabled = true;
    const fields = [...$('#settings-form').querySelectorAll('input,select,#show-key')].map(field => [field, field.disabled]);
    fields.forEach(([field]) => field.disabled = true);
    $('#settings-error').textContent = ''; $('#service-actions').innerHTML = ''; $('#test-result').textContent = values.answer_mode === 'free' ? '正在保存…' : '正在获取模型并检测文字、图片调用，请稍等…';
    $('#settings-form').setAttribute('aria-busy', 'true');
    try {
      if (values.answer_mode === 'free') { await api('/api/config', { answer_mode: 'free' }); $('#settings-dialog').close(); toast('免费答题设置已保存。'); return; }
      const result = await api('/api/detect-save', { ...values, force });
      if (result.detection) { showDetection(result.detection); $('#api-key').value = ''; $('#api-key').placeholder = '已保存，留空保留原 Key'; $('#base-url').value = result.detection.base_url; }
      $('#test-result').textContent = result.connection.message; $('#test-result').classList.toggle('error', result.connection.status === 'error');
      if (result.connection.status === 'error') $('#service-actions').innerHTML = serviceActions(result.connection.message);
      else toast('检测完成并已保存，可以回到课程继续。');
    } catch (error) { $('#settings-error').textContent = explainProblem(error.message, browserName()); $('#service-actions').innerHTML = serviceActions(error.message); }
    finally { button.disabled = false; fields.forEach(([field, disabled]) => field.disabled = disabled); updatePrices(); $('#settings-form').removeAttribute('aria-busy'); }
  });
}
$('#settings-form').addEventListener('input', event => {
  if (event.target.matches('#base-url,#api-key')) { showDetection(null); $('#test-result').textContent = '网址或 Key 已变化，请重新检测。'; }
});
$('#answer-mode').addEventListener('change', updatePrices);
$('#show-key').addEventListener('click', () => { const field = $('#api-key'); field.type = field.type === 'password' ? 'text' : 'password'; $('#show-key').textContent = field.type === 'password' ? '显示' : '隐藏'; $('#show-key').setAttribute('aria-label', field.type === 'password' ? '显示输入的 Key' : '隐藏输入的 Key'); });
document.addEventListener('click', event => {
  const action = event.target.closest('[data-service-action]'); if (!action || busy) return;
  if (action.dataset.serviceAction === 'retry') detectAndSave(true);
  else { const input = action.dataset.serviceAction === 'key' ? $('#api-key') : $('#base-url'); input.focus(); input.select(); }
});
$('#stop-all').addEventListener('click', () => runAction(() => api('/api/queue', { action: 'stop' })));
$('#export-diagnostics').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true; button.textContent = '正在生成诊断包…'; $('#diagnostics-error').textContent = '';
  try {
    const response = await fetch('/api/diagnostics', { method:'POST', headers:{'Content-Type':'application/json','X-Szu-Token':state.csrf},body:'{}' });
    if (!response.ok) throw new Error((await response.json()).error || '诊断包导出失败，请重试。');
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
    link.href = url; link.download = response.headers.get('Content-Disposition')?.match(/filename="([\w.-]+)"/)?.[1] || 'ShenYiShua-diagnostics.zip';
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('诊断包已下载，可将 ZIP 文件发给维护者。');
  } catch (error) { $('#diagnostics-error').textContent = error.message; }
  finally { button.disabled = closed; button.textContent = '导出诊断包'; }
});
document.addEventListener('click', async event => {
  const copy = event.target.closest('[data-copy-debug]');
  if (copy) {
    const field = $('#debug-url'); field.focus(); field.select();
    try { await navigator.clipboard.writeText(field.value); toast(`已复制，在 ${browserName()} 地址栏粘贴并回车。`); }
    catch { toast(`请复制已选中的地址，粘贴到 ${browserName()} 地址栏。`); }
  }
  const step = event.target.closest('[data-guide-step]'); if (step) { guideStep = step.dataset.guideStep; guideError = ''; render(); }
  if (event.target.closest('[data-free-mode]')) runAction(() => api('/api/config', { answer_mode: 'free' }));
  const open = event.target.closest('[data-browser-open]'); if (open) runAction(async () => { await api('/api/browser-open', { target: open.dataset.browserOpen }); });
  const connect = event.target.closest('[data-connect]'); if (connect) runAction(async () => { guideError = ''; try { await api('/api/browser-connect'); await api('/api/browser-courses'); } catch (error) { guideError = error.message; } });
  const read = event.target.closest('[data-read-courses]'); if (read) runAction(async () => { guideError = ''; read.textContent = '读取中…'; try { const result = await api('/api/browser-courses'); toast(`已加入 ${result.added} 门课程`); } catch (error) { guideError = error.message; toast(error.message, true); } finally { read.textContent = '刷新课程'; } });
  if (event.target.closest('[data-environment]')) runAction(() => api('/api/environment'));
});
$('#connect-again').addEventListener('click', () => { $('#preferences-dialog').close(); guideStep = 'debug'; runAction(async () => { await api('/api/browser-connect'); await api('/api/browser-courses'); }); });
function showClosed() { closed = true; document.querySelectorAll('button').forEach(button => button.disabled = true); $('#connection-error').className = 'notice'; $('#connection-error').textContent = '控制台已关闭，后续任务已停止。下次双击启动即可继续。'; $('#connection-error').hidden = false; }
$('#exit-button').addEventListener('click', () => runAction(async () => { await api('/api/shutdown'); showClosed(); }));
refresh(); setInterval(refresh, 1000);
