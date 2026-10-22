import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const nanos = usd => Math.ceil(usd * 1e9);
const queues = new Map();
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const amount = value => Number.isSafeInteger(value) && value >= 0;

function courseFile(ledgerDir, courseId) {
  if (!/^\d+$/.test(String(courseId))) throw new Error('无法核实本次解题所属课程');
  return path.join(path.resolve(ledgerDir), `course-${courseId}.json`);
}

// JSON is the financial record; SQLite holds only an OS-managed cross-process mutex.
export function withCourseLedger(ledgerDir, courseId, operation) {
  const file = courseFile(ledgerDir, courseId);
  const call = (queues.get(file) || Promise.resolve()).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = new DatabaseSync(path.join(path.dirname(file), `.course-${courseId}.lock.sqlite`));
    try {
      try { lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;'); }
      catch (error) {
        if (error.errcode === 5 || error.errcode === 6) throw new Error('这门课的解题请求仍在运行，请等待当前请求结束后再继续。');
        throw new Error('无法锁定课程费用账本，已阻止付费请求');
      }
      return await operation();
    } finally { lock.close(); }
  });
  const settled = call.catch(() => {});
  queues.set(file, settled);
  settled.then(() => { if (queues.get(file) === settled) queues.delete(file); });
  return call;
}

export function validateLedger(ledger, courseId) {
  if (!record(ledger) || String(ledger.courseId) !== String(courseId) || typeof ledger.model !== 'string' || !ledger.model || !Array.isArray(ledger.requests)
    || ledger.unit !== undefined && ledger.unit !== 'provider_USD_credit') throw new Error('账本结构异常，须先核对已有费用');
  const entries = new Map();
  let total = 0;
  for (const entry of ledger.requests) {
    if (!record(entry) || typeof entry.id !== 'string' || !entry.id || entries.has(entry.id) || !['known', 'unknown', 'pending'].includes(entry.status)) throw new Error('账本结构异常，须先核对已有费用');
    if (entry.metering_bound_exceeded !== undefined && typeof entry.metering_bound_exceeded !== 'boolean') throw new Error('账本计量记录异常，已阻止请求');
    const value = entry.status === 'known' ? entry.cost_nanos : entry.reserved_nanos;
    if (!amount(value) || entry.status !== 'known' && value === 0
      || entry.status === 'known' && entry.reserved_nanos !== undefined && entry.reserved_nanos !== 0) throw new Error('账本金额无效，已阻止请求');
    total += value;
    if (!amount(total)) throw new Error('账本金额无效，已阻止请求');
    entries.set(entry.id, entry);
  }
  if (ledger.recoveries !== undefined && !Array.isArray(ledger.recoveries)) throw new Error('账本恢复记录异常，已阻止请求');
  const recoveries = new Set();
  for (const recovery of ledger.recoveries || []) {
    if (!record(recovery) || typeof recovery.id !== 'string' || !recovery.id || recoveries.has(recovery.id) || !['manual', 'automatic', 'detection'].includes(recovery.mode)
      || typeof recovery.at !== 'string' || !Number.isFinite(Date.parse(recovery.at)) || !Array.isArray(recovery.request_ids) || !recovery.request_ids.length
      || new Set(recovery.request_ids).size !== recovery.request_ids.length || recovery.request_ids.some(id => !entries.has(id) || entries.get(id).status === 'known')) throw new Error('账本恢复记录异常，已阻止请求');
    recoveries.add(recovery.id);
  }
  return ledger;
}

export async function readLedger(ledgerDir, courseId) {
  let ledger;
  try { ledger = JSON.parse(await fs.readFile(courseFile(ledgerDir, courseId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('账本不可读，已阻止付费请求'); }
  return validateLedger(ledger, courseId);
}

export async function saveLedger(ledgerDir, courseId, ledger) {
  validateLedger(ledger, courseId);
  const file = courseFile(ledgerDir, courseId), temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}

export function approvedRequestIds(ledger) {
  return new Set((ledger.recoveries || []).flatMap(recovery => recovery.request_ids));
}

export function approveRecovery(ledger, requestIds, mode) {
  const approved = approvedRequestIds(ledger);
  const ids = [...new Set(requestIds)].filter(id => !approved.has(id));
  if (ids.length) (ledger.recoveries ||= []).push({ id: randomUUID(), at: new Date().toISOString(), mode, request_ids: ids });
  return ids;
}

export function ledgerCosts(ledger) {
  if (!ledger) return { spent: 0, reserved: 0, unknown: false, unknownRequests: 0, pending: 0, requests: 0, unresolvedRequests: 0, recoveryRequired: false, meteringBoundExceeded: false };
  validateLedger(ledger, ledger.courseId);
  const approved = approvedRequestIds(ledger);
  let spent = 0, reserved = 0, pending = 0, unresolvedRequests = 0;
  for (const entry of ledger.requests) {
    if (entry.status === 'known') spent += entry.cost_nanos;
    else { reserved += entry.reserved_nanos; if (!approved.has(entry.id)) unresolvedRequests++; }
    if (entry.status === 'pending') pending++;
  }
  return { spent: spent / 1e9, reserved: reserved / 1e9, unknown: ledger.requests.some(entry => entry.status !== 'known'), unknownRequests: ledger.requests.filter(entry => entry.status === 'unknown').length, pending, requests: ledger.requests.length,
    unresolvedRequests, recoveryRequired: unresolvedRequests > 0, meteringBoundExceeded: ledger.requests.some(entry => entry.metering_bound_exceeded === true) };
}

export async function readCourseCosts(ledgerDir, courseId) {
  return ledgerCosts(await readLedger(ledgerDir, courseId));
}

export function assertLedgerBudget(ledger, limit, reserve = 0) {
  if (!Number.isFinite(limit) || limit <= 0 || limit > 1) throw new Error('本轮课程预算必须大于 0 且不超过 $1.00');
  const costs = ledgerCosts(ledger);
  if (costs.meteringBoundExceeded) throw new Error('上次计量超出预留上限，须核对计费规则后再继续');
  const total = ledger.requests.reduce((sum, entry) => sum + (entry.status === 'known' ? entry.cost_nanos : entry.reserved_nanos), 0);
  if (!amount(reserve) || !amount(total + reserve) || total + reserve > nanos(limit)) throw new Error('本地预算不足，已阻止付费请求');
  return total;
}

export function assertLedgerReady(ledger, automaticIds = new Set()) {
  const approved = approvedRequestIds(ledger);
  const unresolved = ledger.requests.find(entry => entry.status !== 'known' && !approved.has(entry.id) && !automaticIds.has(entry.id));
  if (unresolved) {
    const status = Number.isInteger(unresolved.http_status) && unresolved.http_status >= 100 && unresolved.http_status <= 599 ? `（解题服务 HTTP ${unresolved.http_status}）` : '';
    throw new Error(`上次请求费用未知${status}，须核对服务商账单后再继续；不要删除账本或反复重试。`);
  }
}
