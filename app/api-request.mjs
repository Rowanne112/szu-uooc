import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const nanos = (usd) => Math.ceil(usd * 1e9);

export function validPrices(pricing) {
  const values = ['input_per_million', 'cached_input_per_million', 'output_per_million'].map((key) => pricing?.[key]);
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
    throw new Error('缺少已核实的三项价格；禁止付费请求');
  }
  return values;
}

export function usageCost(usage, pricing) {
  const [inputPrice, cachePrice, outputPrice] = validPrices(pricing);
  const input = usage?.input_tokens;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const output = usage?.output_tokens;
  if (![input, cached, output].every((v) => Number.isSafeInteger(v) && v >= 0) || cached > input) {
    throw new Error('usage 无效；费用须核对，禁止自动重试');
  }
  return ((input - cached) * inputPrice + cached * cachePrice + output * outputPrice) / 1e6;
}

export function decodeResponse(text, { completeFramesOnly = false } = {}) {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!completeFramesOnly) { try { return JSON.parse(text); } catch { /* SSE */ } }
  const frames = text.split('\n\n');
  if (completeFramesOnly && !text.endsWith('\n\n')) frames.pop();
  for (const frame of frames) {
    const data = frame.split('\n').filter(line => /^data(?::|$)/.test(line)).map(line => line.replace(/^data: ?/, '')).join('\n');
    if (!data || data.trim() === '[DONE]') continue;
    const event = JSON.parse(data);
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type) && event.response) return event.response;
    if (event.type === 'error') throw Object.assign(new Error('Responses 流返回错误'), { stage: 'decoding', providerError: event.error || event });
  }
  if (completeFramesOnly) return null;
  throw Object.assign(new Error('Responses 流缺少最终结果；费用须核对'), { stage: 'decoding' });
}

async function readResponse(response, onBytes) {
  if (!response.body?.getReader) {
    const text = await response.text(); onBytes(Buffer.byteLength(text));
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('API 响应超限');
    return { text, data: decodeResponse(text) };
  }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '', bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { text += decoder.decode(); break; }
      bytes += chunk.value.byteLength; onBytes(bytes);
      if (bytes > 4 * 1024 * 1024) throw new Error('API 响应超限');
      text += decoder.decode(chunk.value, { stream: true });
      if (/^(data:|event:|:)/.test(text.trimStart())) {
        let data;
        try { data = decodeResponse(text, { completeFramesOnly: true }); }
        catch (error) { error.stage = 'decoding'; throw error; }
        if (data) return { text, data };
      }
    }
    try { return { text, data: decodeResponse(text) }; }
    catch (error) { error.stage = 'decoding'; throw error; }
  } finally { await reader.cancel().catch(() => {}); }
}

async function save(file, ledger) {
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}

// Serialize each course ledger across controllers; other courses run independently.
const requestQueues = new Map();

export function createAPI(config, ledgerDir, fetchImpl = fetch) {
  const base = new URL(config.base_url.replace(/\/+$/, '') + '/');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('API 配置必须是无凭据参数的 HTTPS 地址');
  const endpoint = new URL('responses', base).href;
  let pending = Promise.resolve();
  const resumedUnknown = new Set();

  async function request(courseId, details) {
    if (!/^\d+$/.test(String(courseId))) throw new Error('无法核实本次解题所属课程');
    if (details.method !== 'POST' || details.url !== endpoint) throw new Error('控制器只代理配置中的 Responses 接口');
    const payload = JSON.parse(details.data);
    if (!config.api_key || payload.model !== config.model || payload.store !== false || payload.reasoning?.effort !== 'medium' || typeof payload.input !== 'string') {
      throw new Error('请求不符合已确认的模型、medium 或不储存响应设置');
    }
    if (!Number.isSafeInteger(payload.max_output_tokens) || payload.max_output_tokens < 32 || payload.max_output_tokens > 8192 || Buffer.byteLength(payload.input) > 128000) throw new Error('请求长度超限');
    const [inputPrice, cachePrice, outputPrice] = validPrices(config.pricing);
    const limit = Number(config.budget);
    if (!Number.isFinite(limit) || limit <= 0 || limit > 1) throw new Error('本轮课程预算必须大于 0 且不超过 $1.00');
    // The live provider added 4380 instruction tokens; allow headroom and stop if that bound changes.
    const inputBound = Buffer.byteLength(payload.input) + 16384;
    const reserve = nanos((inputBound * Math.max(inputPrice, cachePrice) + payload.max_output_tokens * outputPrice) / 1e6);
    await fs.mkdir(ledgerDir, { recursive: true, mode: 0o700 });
    const file = path.join(ledgerDir, `course-${courseId}.json`);
    let ledger;
    try { ledger = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('账本不可读，已阻止付费请求');
      ledger = { courseId: String(courseId), unit: 'provider_USD_credit', model: config.model, requests: [] };
    }
    if (typeof ledger.model !== 'string' || !ledger.model || !Array.isArray(ledger.requests)) throw new Error('账本结构异常，须先核对已有费用');
    // Rejected requests retain their full reservation when an explicit corrected attempt is sent.
    const resumableRejection = (entry) => entry.status === 'unknown' && (
      entry.http_status === 429 || ([200, 502].includes(entry.http_status) && resumedUnknown.has(courseId + ':' + entry.id)) || (entry.http_status === 400 && entry.provider_error?.type === 'invalid_request_error'
        && /^Unsupported (?:parameter|tool type): [a-z0-9_.-]+$/i.test(entry.provider_error.message || ''))
    );
    const unresolved = ledger.requests.find((entry) => entry.status !== 'known' && !resumableRejection(entry));
    if (unresolved) {
      const status = Number.isInteger(unresolved.http_status) && unresolved.http_status >= 100 && unresolved.http_status <= 599 ? `（解题服务 HTTP ${unresolved.http_status}）` : '';
      throw new Error(`上次请求费用未知${status}，须核对服务商账单后再继续；不要删除账本或反复重试。`);
    }
    if (ledger.requests.some((entry) => entry.metering_bound_exceeded)) throw new Error('上次计量超出预留上限，须核对计费规则后再继续');
    const accounted = ledger.requests.map((entry) => entry.status === 'known' ? entry.cost_nanos : entry.reserved_nanos);
    if (accounted.some((amount, index) => !Number.isSafeInteger(amount) || amount < 0 || (ledger.requests[index].status !== 'known' && amount === 0))) throw new Error('账本金额无效，已阻止请求');
    const spent = accounted.reduce((sum, amount) => sum + amount, 0);
    if (!Number.isSafeInteger(spent) || spent < 0 || spent + reserve > nanos(limit)) throw new Error('本地预算不足，已阻止付费请求');
    // Legacy entries inherit ledger.model; keep their original costs and record model changes per request.
    const entry = { id: randomUUID(), at: new Date().toISOString(), model: config.model, status: 'pending', reserved_nanos: reserve, pricing: config.pricing, input_bound: inputBound, output_bound: payload.max_output_tokens };
    const recovered = ledger.requests.filter(item => item.status === 'unknown' && [200, 502].includes(item.http_status) && resumedUnknown.has(courseId + ':' + item.id));
    if (recovered.length) entry.resumed_unknown_requests = recovered.map(item => item.id);
    ledger.requests.push(entry);
    await save(file, ledger);

    let stage = 'connecting';
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.api_key}`, 'User-Agent': 'Codex/0.156.0' },
        body: JSON.stringify({ model: payload.model, reasoning: { effort: 'medium' }, input: payload.input, store: false, max_output_tokens: payload.max_output_tokens, stream: true }),
        signal: AbortSignal.timeout(Math.min(120000, Math.max(5000, details.timeout || 60000))),
      });
      entry.http_status = response.status;
      stage = 'receiving';
      let text, decoded;
      if (response.ok) ({ text, data: decoded } = await readResponse(response, bytes => entry.response_bytes = bytes));
      else { text = await response.text(); entry.response_bytes = Buffer.byteLength(text); if (entry.response_bytes > 4 * 1024 * 1024) throw new Error('API 响应超限'); }
      if (!response.ok) {
        let providerError;
        try { providerError = JSON.parse(text).error; } catch (_) {}
        const safeCode = (value) => typeof value === 'string' && /^[a-z0-9_.:-]{1,80}$/i.test(value) && !value.includes(config.api_key) ? value : undefined;
        const message = typeof providerError?.message === 'string' ? providerError.message : '';
        const reason = /concurren|并发/i.test(message) ? '并发限制' : /insufficient|quota|余额|额度/i.test(message) ? '余额或额度限制' : /no available|unavailable|没有可用|无可用|上游/i.test(message) ? '上游不可用' : /rate.?limit|too many|频率|限流/i.test(message) ? '请求频率限制' : '未识别；需查看服务商诊断';
        const excerpt = message.replaceAll(config.api_key, '[redacted]').replace(/(?:sk-|sess-)[a-z0-9_-]+|Bearer\s+\S+/gi, '[redacted]').slice(0, 400);
        entry.provider_error = { type: safeCode(providerError?.type), code: safeCode(providerError?.code), reason, message: excerpt };
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter && /^\d{1,7}$/.test(retryAfter)) entry.retry_after_seconds = Number(retryAfter);
      }
      stage = 'decoding';
      const data = decoded || decodeResponse(text);
      stage = 'accounting';
      const cost = usageCost(data.usage, config.pricing);
      const usage = { input_tokens: data.usage.input_tokens, input_tokens_details: { cached_tokens: data.usage.input_tokens_details?.cached_tokens ?? 0 }, output_tokens: data.usage.output_tokens };
      Object.assign(entry, { status: 'known', usage, cost_nanos: nanos(cost), cost_usd: cost, reserved_nanos: 0, metering_bound_exceeded: usage.input_tokens > inputBound || usage.output_tokens > payload.max_output_tokens });
      await save(file, ledger);
      if (entry.metering_bound_exceeded) throw new Error('服务商计量超出预留上限，已暂停');
      if (spent + entry.cost_nanos > nanos(limit)) throw new Error('真实费用超过预算，已停止后续请求');
      // Account for usage even if the request was cancelled or the answer is incomplete.
      if (!response.ok || (data.status && data.status !== 'completed')) throw new Error(`API 返回 HTTP ${response.status} 或未完成响应，已记录费用`);
      if (data.model && data.model !== config.model) throw new Error('返回模型与指定模型不一致，已记录费用并停止');
      return { status: response.status, responseText: JSON.stringify(data) };
    } catch (error) {
      entry.failure_stage = ['connecting','receiving','decoding','accounting'].includes(error.stage) ? error.stage : stage;
      entry.failure_type = ['Error','SyntaxError','TypeError','TimeoutError','AbortError'].includes(error.name) ? error.name : 'Error';
      if (entry.status !== 'known') {
        entry.status = 'unknown';
        await save(file, ledger);
      }
      // Provider responses and request headers can contain credentials; retain no raw errors.
      const status = entry.http_status ? `HTTP ${entry.http_status}；` : '';
      const reason = entry.provider_error ? `${entry.provider_error.reason}；` : '';
      const failure = new Error(entry.status === 'known' ? `API ${status}${reason}未返回可用答案；已记录 usage，课程暂停` : `API ${status}${reason}结果或费用未知；保留预留额度，课程暂停，${[200, 502].includes(entry.http_status) ? '可点击继续在剩余预算内重试' : '禁止自动重试'}`);
      if (entry.http_status === 429 && ['请求频率限制', '并发限制'].includes(entry.provider_error?.reason)
        && (entry.retry_after_seconds === undefined || entry.retry_after_seconds <= 60)) failure.retryAfterMs = (entry.retry_after_seconds ?? 15) * 1000;
      throw failure;
    }
  }

  const api = (courseId, details, mayDispatch) => {
    if (!/^\d+$/.test(String(courseId))) return Promise.reject(new Error('无法核实本次解题所属课程'));
    const scope = path.join(path.resolve(ledgerDir), 'course-' + courseId);
    const call = (requestQueues.get(scope) || Promise.resolve()).then(async () => {
      let lastFailure;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (mayDispatch && !await mayDispatch()) throw lastFailure || Object.assign(new Error('课程已暂停，未发送解题请求'), { notSent: true });
        try { return await request(courseId, details); }
        catch (error) {
          // Retry only a live managed task; every earlier reservation remains in its budget.
          if (attempt === 2 && error.retryAfterMs !== undefined && mayDispatch) error.message = '解题服务持续限流（HTTP 429），已自动重试 2 次；课程已暂停，请稍后继续或更换解题服务。费用预留已保留。';
          if (attempt === 2 || error.retryAfterMs === undefined || !mayDispatch || !await mayDispatch()) throw error;
          lastFailure = error;
          await delay(error.retryAfterMs);
        }
      }
    });
    const settled = call.catch(() => {}); requestQueues.set(scope, settled);
    pending = Promise.all([pending, settled]).then(() => {});
    settled.then(() => { if (requestQueues.get(scope) === settled) requestQueues.delete(scope); });
    return call;
  };
  // A manual start/resume covers only recorded unknown 200/502s; new failures still stop the course.
  api.prepareResume = async courseId => {
    if (!/^\d+$/.test(String(courseId))) throw new Error('无法核实恢复请求所属课程');
    await pending;
    let ledger;
    try { ledger = JSON.parse(await fs.readFile(path.join(ledgerDir, `course-${courseId}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('账本不可读，已阻止恢复请求'); }
    if (!Array.isArray(ledger.requests)) throw new Error('账本结构异常，已阻止恢复请求');
    for (const entry of ledger.requests) {
      if (entry.status === 'unknown' && [200, 502].includes(entry.http_status) && typeof entry.id === 'string' && entry.id) resumedUnknown.add(courseId + ':' + entry.id);
    }
  };
  api.idle = () => pending;
  return api;
}
