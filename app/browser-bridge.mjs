export const allowedHost = (hostname) => /(^|\.)(uooc\.net\.cn|uooconline\.com|uooc\.online)$/.test(hostname);
export const verificationSelector = '#commitConfirmDialog #sc #aliyunCaptcha-checkbox-icon';

export async function stopCourseScript(page) {
  const stop = page.locator('[data-action="course-stop"]');
  if (!await stop.count()) return;
  // The panel may be collapsed; the ordinary stop button must still cancel the runner.
  await stop.evaluate(node => node.click());
  await page.waitForFunction(() => {
    const state = document.querySelector('#szu-uooc-course-state');
    return !state || JSON.parse(state.textContent).active === false;
  }, null, { timeout: 3000 });
}

export async function clickVerificationControl(page, frame, beforeClick) {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // UOOC's desktop sidebar leaves the quiz clipped in a narrow browser viewport.
  if (viewport.width < 1000) await page.setViewportSize({ width: 1280, height: Math.max(900, viewport.height) });
  const checkbox = frame.locator(verificationSelector);
  await checkbox.scrollIntoViewIfNeeded({ timeout: 5000 });
  const visible = await checkbox.evaluate(node => {
    const r = node.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const hit = document.elementFromPoint(x, y);
    return r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && (hit === node || node.contains(hit));
  });
  if (!visible) throw new Error('验证控件被裁剪或遮挡，未发送点击');
  await checkbox.click({ trial: true, timeout: 5000 });
  // Like drissionpage-ai's adapter, use viewport coordinates for native input.
  // Playwright boundingBox already includes iframe offsets; do not add them again.
  const box = await checkbox.boundingBox();
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  if (!box || box.x < 0 || box.y < 0 || box.x + box.width > size.width || box.y + box.height > size.height) throw new Error('验证控件不在课程视口内，未发送点击');
  if (beforeClick && !await beforeClick()) return false;
  // Native input must not wait for a target to reappear after the cancellation check.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

export async function installCourseScript(target, { config, bank, script, expectedCourse, requestAPI, consoleMode = false }) {
  const binding = await target.exposeBinding('szuUoocNetwork', async ({ page, frame }, details) => {
    const source = new URL(frame.url());
    if (frame !== page.mainFrame() || source.protocol !== 'https:' || !allowedHost(source.hostname) || !/^\/home\/learn\//.test(source.pathname)) throw new Error('拒绝不属于课程学习页的 API 请求');
    const text = await page.locator('#szu-uooc-course-state').textContent({ timeout: 2000 });
    const state = JSON.parse(text);
    if (String(state.courseId) !== expectedCourse || !state.active || state.phase !== 'solving') throw new Error('当前课程范围内没有等待解题的任务');
    if (config.answer_mode === 'free') throw new Error('免费模式不会调用解题服务。');
    try { return await requestAPI(state.courseId, details, async () => {
      const current = JSON.parse(await page.locator('#szu-uooc-course-state').textContent().catch(() => 'null'));
      return current?.active && current.phase === 'solving' && String(current.courseId) === expectedCourse && current.sourceId === state.sourceId;
    }); } catch (error) {
      if (error.notSent) return { status: 0, notSent: true, error: '课程已暂停，未发送解题请求' };
      const message = String(error.message || '本地控制器已暂停请求').replaceAll(config.api_key || '\0', '[redacted]');
      console.log(message); throw new Error(message);
    }
  });

  let injection;
  try { injection = await target.addInitScript({ content: `
if (window === window.top && /(^|\\.)(uooc\\.net\\.cn|uooconline\\.com|uooc\\.online)$/.test(location.hostname) && /^\\/home\\/learn\\//.test(location.pathname) && location.hash.replace(/^#\\/?/, '').split('/')[0] === ${JSON.stringify(expectedCourse)}) {
  (() => {
    const values = { 'szu-uooc:ai-api-key': '[managed-by-local-controller]', 'szu-uooc:answer-bank': ${JSON.stringify(bank)} };
    window.GM_getValue = (key, fallback) => key in values ? values[key] : fallback;
    window.GM_setValue = (key, value) => { if (key !== 'szu-uooc:ai-api-key') values[key] = value; };
    window.GM_getResourceURL = () => '';
    window.GM_xmlhttpRequest = (details) => {
      window.szuUoocNetwork({ method: details.method, url: details.url, data: details.data, timeout: details.timeout }).then(
        (response) => response.notSent ? details.onerror?.({error: response.error, notSent: true}) : details.onload?.(response), (error) => details.onerror?.({ error: error.message || '本地控制器已拒绝或暂停请求' })
      );
      return { abort() {} };
    };
    const key = 'szu-uooc:auto-player:config';
    let prior = {}; try { prior = JSON.parse(localStorage.getItem(key) || '{}'); } catch (_) {}
    delete prior.aiApiKey;
    localStorage.setItem(key, JSON.stringify({ ...prior, enabled: false, autoPlay: false, autoNext: false, aiBaseUrl: ${JSON.stringify(config.base_url)}, aiModel: ${JSON.stringify(config.model)}, aiTimeout: 90000,
      aiInputPrice: ${JSON.stringify(config.pricing?.input_per_million ?? '')}, aiCachedInputPrice: ${JSON.stringify(config.pricing?.cached_input_per_million ?? '')}, aiOutputPrice: ${JSON.stringify(config.pricing?.output_per_million ?? '')}, aiBudget: ${JSON.stringify(config.budget)}, aiOutputTokens: 2048, courseAnswerMode: ${JSON.stringify(config.answer_mode || 'ai')} }));
    ${script}
    ${consoleMode ? "const hide = () => { const style = document.createElement('style'); style.textContent = '#szu-uooc-auto-player-controls{display:none!important}'; document.head.appendChild(style); }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hide, {once:true}); else hide();" : ''}
  })();
}` }); }
  catch (error) { await binding.dispose(); throw error; }
  return async () => { try { await injection.dispose(); } finally { await binding.dispose(); } };
}
