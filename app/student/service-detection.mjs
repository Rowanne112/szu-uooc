import path from 'node:path';
import { randomInt } from 'node:crypto';
import { createAPI } from '../api-request.mjs';
import { candidateModels, normalizeServiceURL, serviceFingerprint, endpointFor, parseAnswerJSON, serviceProblem, arkModelList } from '../api-protocol.mjs';
import { readJSON, saveJSON } from './settings.mjs';

// Three red squares on white; no course material is used for connection tests.
export const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAIAAABiouoDAAAAa0lEQVR4nO3YwQmAMBQFQSux/6LsRSvQJYePCrPk/BLmmO3UY9vbD/h6gCJAEaAIUAQoAhTdAh37vnRWL/7LPiBAgEb3AQECNLoPCBCg0X1AgACN7gMCBGh034dZBCgCFAGKAEWAIkARoOgCH+Euw7zVA+AAAAAASUVORK5CYII=';

export async function detectService({ base_url, api_key, model = '', dataDir, fetchImpl = fetch, force = false }) {
  const base = normalizeServiceURL(base_url);
  if (typeof api_key !== 'string' || !api_key || /\s/.test(api_key) || api_key.length > 2048) throw new Error('Key 无效，请重新复制完整 Key。');
  if (api_key.length >= 8 && decodeURI(base).includes(api_key)) throw new Error('API 网址中不能包含 Key，请把网址和 Key 分别填写。');
  const fingerprint = serviceFingerprint(base, api_key);
  const cacheFile = path.join(dataDir, 'service-detection.json');
  const cached = await readJSON(cacheFile, null);
  if (!force && cached?.fingerprint === fingerprint && cached.selection === model && Date.now() - cached.at < 86400000 && cached.result.status === 'ready') return { ...cached.result, cached: true };
  await saveJSON(cacheFile, { fingerprint, selection: model, at: Date.now(), result: { status: 'checking' } });
  let response;
  try { response = await fetchImpl(base + '/models', { headers: { Authorization: `Bearer ${api_key}` }, redirect: 'error', signal: AbortSignal.timeout(12000) }); }
  catch { throw new Error('无法连接解题服务，请检查 API 网址和网络后重新检测。'); }
  const raw = await response.text();
  if (raw.length > 2 * 1024 * 1024) throw new Error('服务商返回的模型列表过大，请修改服务后重新检测。');
  const ark = arkModelList(base);
  let data;
  if (ark && [404, 405].includes(response.status)) data = { data: ark };
  else {
    try { data = JSON.parse(raw); } catch { throw new Error(response.ok ? 'API 网址返回的不是模型列表，请复制服务商提供的 API 网址。' : serviceProblem(response.status, {})); }
    if (!response.ok) throw new Error(serviceProblem(response.status, data));
  }
  if (!Array.isArray(data.data) || data.data.length > 10000) throw new Error('服务商没有返回可识别的模型列表，请修改服务后重新检测。');
  const models = candidateModels(base, data.data.filter(item => typeof item?.id === 'string' && !item.id.includes(api_key)));
  const preferred = model ? models.find(m => m.id === model) : null;
  const candidates = [...(preferred ? [preferred] : []), ...models.filter(m => m !== preferred)].filter(m => m.pricing).slice(0, 3);
  const run = String(Date.now()) + String(randomInt(100000, 999999));
  const ledgerDir = path.join(dataDir, 'detection-ledger');
  let calls = 0, fatal = '';
  const safeReason = error => (/预算不足/.test(error.message) ? '本次检测的 $0.02 上限不足以安全测试这个模型，未发送请求。请选择其他主要模型或修改服务。' : String(error.message)).replaceAll(api_key, '[已隐藏]').replace(/(?:sk-|sess-)[a-z0-9_-]+|Bearer\s+\S+/gi, '[已隐藏]').slice(0, 220);
  const countedFetch = async (...args) => {
    if (++calls > 6) throw new Error('本次检测已达到六次调用上限，请修改服务后重新检测。');
    return fetchImpl(...args);
  };
  async function probe(profile, image) {
    if (calls >= 6) throw new Error('本次检测已达到六次调用上限。');
    const text = '仅返回JSON：{"answers":[{"index":0,"answers":["答案"]}]}。' + (image ? '图中有几个红色方块？答案只能是1、2、3、4之一。' : '计算1+1，答案只能是2或3。');
    const input = image ? [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: testImage }] }] : text;
    const api = createAPI({ base_url: base, api_key, model: profile.id, budget: .02, pricing: profile.pricing, profile: { ...profile, verified_text: true, verified_image: true }, test_probe: true }, ledgerDir, countedFetch);
    const reply = await api(run, { method: 'POST', url: endpointFor(base), timeout: 30000, data: JSON.stringify({ model: profile.id, input, store: false, max_output_tokens: 512 }) });
    const result = JSON.parse(reply.responseText);
    const parsed = parseAnswerJSON((result.output || []).flatMap(item => item.content || []).filter(p => p.type === 'output_text').map(p => p.text).join(''));
    if (!Array.isArray(parsed.answers) || parsed.answers.length !== 1 || parsed.answers[0].index !== 0 || JSON.stringify(parsed.answers[0].answers) !== JSON.stringify([image ? '3' : '2'])) throw new Error(image ? '测试图片的答案不符合要求，图片能力未验证。' : '文字测试的答案格式或结果不符合要求。');
  }
  for (const candidate of candidates) {
    if (calls >= 6 || fatal) break;
    try {
      try { await probe(candidate, false); }
      catch (error) {
        if (ark || !/HTTP (?:404|405)/.test(error.message) || calls >= 6) throw error;
        candidate.wire_api = candidate.wire_api === 'chat' ? 'responses' : 'chat';
        await probe(candidate, false);
      }
      candidate.verified_text = true; candidate.status = 'text'; candidate.reason = '已验证文字调用与答案格式';
      if (candidate.vision && candidate.image_tokens > 0 && calls < 6) {
        try { await probe(candidate, true); candidate.verified_image = true; candidate.status = 'text_image'; candidate.reason = '文字与自带测试图片均通过；仅验证连通性及格式'; }
        catch (error) { candidate.reason += '；' + safeReason(error); if (!error.modelUnavailable && (/HTTP (?:401|403|402)|余额|额度|上次请求|预留上限/.test(error.message) || /费用未知/.test(error.message) && !/HTTP (?:400|404|405)/.test(error.message))) fatal = candidate.reason; }
      }
      if (candidate.verified_image && (!model || candidate === preferred)) break;
    } catch (error) {
      candidate.status = 'failed'; candidate.reason = safeReason(error);
      if (!error.modelUnavailable && /401|403|余额|额度|上次请求|预留上限/.test(error.message)) fatal = candidate.reason;
    }
  }
  const verified = models.filter(m => m.verified_text);
  const primary = fatal ? null : preferred?.verified_text ? preferred : verified.find(m => m.verified_image) || verified[0];
  const image = primary ? primary.verified_image ? primary : verified.find(m => m.verified_image) : null;
  const ledger = await readJSON(path.join(ledgerDir, 'course-' + run + '.json'), { requests: [] });
  const testCosts = { calls, estimated_usd: ledger.requests.reduce((sum, item) => sum + (item.status === 'known' ? item.cost_nanos : item.reserved_nanos), 0) / 1e9, unknown: ledger.requests.some(item => item.status !== 'known') };
  const result = { base_url: base, fingerprint, models, model: primary?.id || '', profile: primary || null, image_profile: image || null,
    status: primary ? 'ready' : 'blocked', checked_at: new Date().toISOString(), testCosts,
    message: primary ? image ? '已验证文字和图片调用及答案格式；这不是答题准确率测试。' : '文字调用已验证；当前没有可用识图模型，遇到图片题将暂停，请手动完成或修改服务。' : fatal || models.find(m => m.status === 'failed')?.reason || '已读取模型列表，但价格无法核实，无法安全执行付费检测和预算保护。请修改服务；无需填写价格或模型名称。',
    reason: primary ? `${primary.id} 已通过实际文字测试${primary.verified_image ? '和图片测试' : ''}；优先选择已核价的较低报价候选，费用按上限预估。${primary.price_source === 'https://www.volcengine.com/docs/82379/1544106' ? '方舟人民币报价取长上下文上限，按 1 美元 = 6 元人民币保守折算；实际扣费以方舟账单为准。' : ''}` : '' };
  await saveJSON(cacheFile, { fingerprint, selection: primary?.id || model, at: Date.now(), result });
  return result;
}
