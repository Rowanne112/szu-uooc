import { createHash } from 'node:crypto';

export const capabilityVersion = '2026-10-20.1';
const openaiSource = 'https://developers.openai.com/api/docs/pricing';
const deepseekSource = 'https://api-docs.deepseek.com/quick_start/pricing/';
const arkSource = 'https://www.volcengine.com/docs/82379/1544106';
const arkBase = 'https://ark.cn-beijing.volces.com/api/v3';
// shortcut: CNY ceilings use 6 CNY/USD (2026-10-20 reference: 6.7200); recheck if FX falls below 6 or prices change.
const arkKnown = Object.fromEntries(Object.entries({
  'doubao-seed-2-1-lite-260915': [.8, .16, 2.7],
  'doubao-seed-2-1-pro-260915': [6, 1.2, 30],
  'doubao-seed-2-1-pro-260628': [6, 1.2, 30],
  'doubao-seed-2-1-turbo-260628': [3, .6, 15],
  'doubao-seed-2-0-mini-260428': [.8, .16, 8],
  'doubao-seed-2-0-mini-260215': [.8, .16, 8],
  'doubao-seed-2-0-lite-260428': [1.8, .36, 10.8],
  'doubao-seed-2-0-lite-260215': [1.8, .36, 10.8],
  'doubao-seed-2-0-pro-260215': [9.6, 1.92, 48],
}).map(([id, rates]) => [id, { wire_api: 'chat', vision: true, image_tokens: 32768, rates: rates.map(value => value / 6), source: arkSource, updated: '2026-10-20' }]));
// Conservative standard/long-context and cache-write ceilings, not an exact bill.
const known = {
  'gpt-6-luna': { wire_api: 'responses', reasoning_effort: 'none', vision: true, image_tokens: 32768, rates: [.25, .02, .75], source: openaiSource },
  'gpt-6.1-sol': { wire_api: 'responses', reasoning_effort: 'low', vision: true, image_tokens: 32768, rates: [5, .2, 15], source: openaiSource },
  'deepseek-flash': { wire_api: 'chat', vision: true, image_tokens: 1024, rates: [.3, .006, 1.2], source: deepseekSource },
  'deepseek-v4-pro': { wire_api: 'chat', vision: false, image_tokens: 0, rates: [1.32, .044, 3.96], source: deepseekSource },
};

export function normalizeServiceURL(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('API 网址不完整，请复制服务商提供的 HTTPS 网址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('API 网址需要 HTTPS，不能包含 Key、查询参数或账号密码。');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|models)$/i, '');
  if (!url.pathname || url.pathname === '/') url.pathname = url.hostname === 'ark.cn-beijing.volces.com' ? '/api/v3' : '/v1';
  return url.href.replace(/\/+$/, '');
}

export const serviceFingerprint = (base, key) => createHash('sha256').update(capabilityVersion + '\0' + normalizeServiceURL(base) + '\0' + key).digest('hex');
export const endpointFor = (base, wire = 'responses') => normalizeServiceURL(base) + (wire === 'chat' ? '/chat/completions' : '/responses');
export const arkModelList = base => normalizeServiceURL(base) === arkBase ? Object.keys(arkKnown).filter(id => !id.endsWith('-260215')).map(id => ({ id })) : null;

function imageSize(bytes, format) {
  if (format === 'png' && bytes.length >= 24) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (format === 'jpeg') {
    for (let offset = 2; offset + 9 <= bytes.length;) {
      if (bytes[offset] !== 255) break;
      if (bytes[offset + 1] === 255) { offset++; continue; }
      const marker = bytes[offset + 1], length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
      offset += 2 + length;
    }
  }
  if (format === 'webp' && bytes.length >= 25) {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && bytes.length >= 30) return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (chunk === 'VP8L' && bytes[20] === 47) return [1 + (bytes[21] | (bytes[22] & 63) << 8), 1 + (bytes[22] >> 6 | bytes[23] << 2 | (bytes[24] & 15) << 10)];
    if (chunk === 'VP8 ' && bytes.length >= 30 && bytes.toString('hex', 23, 26) === '9d012a') return [bytes.readUInt16LE(26) & 16383, bytes.readUInt16LE(28) & 16383];
  }
  throw new Error('题目图片尺寸无法核实，已阻止付费请求，请手动完成图片题。');
}

export function candidateModels(base, list) {
  const normalized = normalizeServiceURL(base), host = new URL(normalized).hostname;
  const official = host === 'api.openai.com' ? 'openai' : host === 'api.deepseek.com' ? 'deepseek' : normalized === arkBase ? 'ark' : '';
  const models = new Map();
  for (const item of list) {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(item.id) || models.has(item.id)) continue;
    if (/embed|rerank|whisper|tts|audio|realtime|dall-e|gpt-image|moderation|sora/i.test(item.id)) continue;
    const hint = official === 'ark' ? arkKnown[item.id] : known[item.id];
    const supported = hint && (official === 'openai' ? item.id.startsWith('gpt-') : official === 'deepseek' ? item.id.startsWith('deepseek-') : official === 'ark');
    const quote = item.pricing;
    const priceKeys = ['input_per_million', 'cached_input_per_million', 'output_per_million'];
    const rates = quote && quote.currency === 'USD' && quote.scope === 'key' && priceKeys.every(k => typeof quote[k] === 'number' && Number.isFinite(quote[k]) && quote[k] >= 0) ? Object.fromEntries(priceKeys.map(k => [k, quote[k]])) : null;
    const pricing = supported ? { input_per_million: hint.rates[0], cached_input_per_million: hint.rates[1], output_per_million: hint.rates[2] } : rates;
    const wire = supported ? hint.wire_api : Array.isArray(item.supported_endpoints) && item.supported_endpoints.includes('responses') ? 'responses' : 'chat';
    const imageTokens = supported ? hint.image_tokens : Number.isSafeInteger(item.max_image_tokens) && item.max_image_tokens > 0 && item.max_image_tokens <= 1050000 ? item.max_image_tokens : 0;
    models.set(item.id, { id: item.id, wire_api: wire, ...(supported && hint.reasoning_effort ? { reasoning_effort: hint.reasoning_effort } : {}), vision: supported ? hint.vision : Array.isArray(item.input_modalities) && item.input_modalities.includes('image') || Boolean(hint?.vision),
      image_tokens: imageTokens, pricing, price_source: supported ? hint.source : rates ? normalizeServiceURL(base) + '/models' : null,
      price_updated: supported ? hint.updated || '2026-10-17' : rates ? new Date().toISOString() : null, price_kind: supported ? 'upper_bound' : rates ? 'provider_quote' : 'unknown',
      verified_text: false, verified_image: false, status: 'unverified', reason: pricing ? '尚未验证实际调用' : '价格无法核实，未进行付费测试' });
  }
  return [...models.values()].sort((a, b) => Number(Boolean(b.pricing)) - Number(Boolean(a.pricing)) || Number(b.vision) - Number(a.vision) ||
    ((a.pricing?.input_per_million ?? Infinity) + (a.pricing?.output_per_million ?? Infinity)) - ((b.pricing?.input_per_million ?? Infinity) + (b.pricing?.output_per_million ?? Infinity)) || a.id.localeCompare(b.id)).slice(0, 100);
}

export function inspectInput(input) {
  if (typeof input === 'string') {
    if (!input.trim() || Buffer.byteLength(input) > 128000) throw new Error('题目文字为空或超过长度上限，已暂停。');
    return { textBytes: Buffer.byteLength(input), images: 0 };
  }
  if (!Array.isArray(input) || input.length !== 1 || input[0]?.role !== 'user' || !Array.isArray(input[0]?.content)) throw new Error('题目内容格式无效，未发送请求。');
  let textBytes = 0, images = 0, imageBytes = 0;
  for (const part of input[0].content) {
    if (part.type === 'input_text' && typeof part.text === 'string') textBytes += Buffer.byteLength(part.text);
    else if (part.type === 'input_image' && typeof part.image_url === 'string' && /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(part.image_url)) {
      const encoded = part.image_url.split(',')[1];
      const bytes = Buffer.from(encoded, 'base64');
      if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('题目图片为空或超过5MB。');
      const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!(png && part.image_url.startsWith('data:image/png;') || jpeg && part.image_url.startsWith('data:image/jpeg;') || webp && part.image_url.startsWith('data:image/webp;'))) throw new Error('题目图片格式与内容不一致。');
      const size = imageSize(bytes, png ? 'png' : jpeg ? 'jpeg' : 'webp');
      if (size.some(value => !value || value > 2048)) throw new Error('题目图片超过支持的2048像素边长，已阻止付费请求，请手动完成图片题。');
      images++; imageBytes += bytes.length;
    } else throw new Error('题目图片或内容不完整，已暂停；请手动完成图片题或修改服务。');
  }
  if (!textBytes || textBytes > 128000 || images > 64 || imageBytes > 20 * 1024 * 1024) throw new Error('题目文字或图片超过上限，未发送不完整题目。');
  return { textBytes, images };
}

export function wireRequest(payload, profile) {
  const common = { model: payload.model };
  if (profile.wire_api === 'chat') {
    const content = typeof payload.input === 'string' ? payload.input : payload.input[0].content.map(p => p.type === 'input_text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: p.image_url } });
    const ark = profile.price_source === arkSource && Boolean(arkKnown[profile.id]);
    return { ...common, messages: [{ role: 'user', content }], ...(ark ? { max_completion_tokens: payload.max_output_tokens } : { max_tokens: payload.max_output_tokens }), stream: false,
      ...(ark || profile.id?.startsWith('deepseek-') && profile.price_source === deepseekSource ? { thinking: { type: 'disabled' } } : {}) };
  }
  return { ...common, ...(profile.reasoning_effort ? { reasoning: { effort: profile.reasoning_effort } } : {}), input: payload.input, store: false, max_output_tokens: payload.max_output_tokens, stream: true };
}

export function normalizeResponse(data) {
  if (!Array.isArray(data?.choices)) return typeof data?.output_text === 'string' && !Array.isArray(data.output) ? { ...data, output: [{ content: [{ type: 'output_text', text: data.output_text }] }] } : data;
  const choice = data.choices[0];
  const usage = data.usage;
  return { model: data.model, status: choice?.finish_reason === 'stop' ? 'completed' : 'incomplete',
    output: [{ content: [{ type: 'output_text', text: Array.isArray(choice?.message?.content) ? choice.message.content.filter(p => p.type === 'text').map(p => p.text).join('') : choice?.message?.content }] }],
    usage: usage && { input_tokens: usage.prompt_tokens, input_tokens_details: { cached_tokens: usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0 }, output_tokens: usage.completion_tokens } };
}

export function parseAnswerJSON(text) {
  if (typeof text !== 'string' || text.length > 128000) throw new Error('解题服务没有返回完整答案，请更换模型后重新检测。');
  try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('解题服务返回的答案格式不符合要求，请更换模型后重新检测。'); }
}

export function serviceProblem(status, data) {
  const message = String(data?.error?.message || '').toLowerCase();
  const code = [data?.error?.code, data?.error?.type].filter(value => typeof value === 'string').join(' ').toLowerCase();
  if (status === 401) return 'Key 无效，请重新复制完整 Key，再点击「检测并保存」。';
  if (/^(modelnotopen|invalidendpointormodel\.notfound|operationdenied\.servicenotopen)(?: |$)/.test(code)) return '当前模型未开通、不存在或无权访问，请到方舟控制台开通模型或选择已有权限的模型，再重新检测。';
  if (/invalidendpointormodel\.modelidaccessdisabled/.test(code)) return '当前账号不允许通过模型 ID 调用，请到方舟控制台检查权限或使用有权限的推理接入点；接入点价格未核实时仍会阻止付费调用。';
  if (/setlimitexceeded/.test(code)) return '已达到方舟模型或接入点的用量上限，请到方舟控制台调整用量上限或「安心体验模式」，再重新检测。';
  if (status === 402 || /insufficient_quota|insufficient_balance|billing_hard_limit|accountoverdueerror|operationdenied\.serviceoverdue/.test(code) || /insufficient|余额不足|quota.*exceed|exceed.*quota/.test(message)) return '余额不足或额度用完，请到服务商后台检查余额，然后重新检测。';
  if (status === 403) return 'Key 没有调用权限，请到服务商后台检查权限，或修改 Key 后重新检测。';
  if (status === 429) return '解题服务繁忙或请求太频繁，请稍后重新检测。';
  if ([404, 405].includes(status)) return '当前 API 网址或模型接口不可用，请核对服务商提供的网址，再重新检测。';
  return `解题服务未完成请求（HTTP ${status}），原因尚不确定。请稍后重新检测或修改服务。`;
}
