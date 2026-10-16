import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { allowedHost } from '../browser-bridge.mjs';
import { validPrices } from '../api-request.mjs';

export const defaults = {
  base_url: 'https://api.daitu.cc/v1', model: 'gpt-6-luna', wire_api: 'responses',
  reasoning_effort: 'medium', budget: 1,
  pricing: { input_per_million: 0.05, cached_input_per_million: 0.005, output_per_million: 0.25 },
};
export const defaultDataDir = path.join(os.homedir(), '.config', 'szu-uooc');

export function validateCourseURL(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请粘贴浏览器地址栏里的完整课程网址。'); }
  if (url.protocol !== 'https:' || !allowedHost(url.hostname) || !/^\/home\/learn\//.test(url.pathname) || !/^#\/?\d+(?:\/|$)/.test(url.hash) || url.username || url.password) {
    throw new Error('请复制课程学习页网址，包含 # 后面的内容；首页和登录页不能添加。');
  }
  return url.href;
}

export function validateConfig(config) {
  let url;
  try { url = new URL(config.base_url); } catch { throw new Error('请输入完整的解题服务接口地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('接口地址需要是 HTTPS 地址，不能带 Key 或其他参数。');
  if (typeof config.model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(config.model) || config.reasoning_effort !== 'medium' || config.wire_api !== 'responses') throw new Error('请填写支持 Responses 接口和 medium 推理的模型名称。');
  if (typeof config.api_key !== 'string' || !config.api_key.trim() || /\s/.test(config.api_key) || config.api_key.length > 2048) throw new Error('Key 不能为空，也不能包含空格或换行。');
  if (typeof config.budget !== 'number' || !Number.isFinite(config.budget) || config.budget <= 0 || config.budget > 1) throw new Error('每门课预算应大于 0 且不超过 $1.00。');
  validPrices(config.pricing);
  return config;
}

export async function saveJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(temp, 0o600);
  await fs.rename(temp, file);
}

export async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function migrateSettings(dataDir) {
  if (dataDir !== defaultDataDir) return;
  const oldDir = path.join(os.homedir(), '.config', ['fast', 'uooc-student'].join(''));
  const pid = Number(await fs.readFile(path.join(oldDir, 'running.pid'), 'utf8').catch(() => ''));
  if (Number.isSafeInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); throw new Error('原来的学习窗口仍在运行，请先停止它，再打开 szu-uooc。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  // Copy existing credentials and every cost ledger together. Never reset a course budget.
  if (await fs.stat(dataDir).catch(() => null)) return;
  if (await fs.stat(oldDir).catch(() => null)) {
    await fs.cp(oldDir, dataDir, { recursive: true });
    await fs.rm(path.join(dataDir, 'running.pid'), { force: true });
    await fs.chmod(dataDir, 0o700);
    await fs.chmod(path.join(dataDir, 'api.json'), 0o600).catch(() => {});
  }
}
