import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ledgerCosts, validateLedger } from '../api-ledger.mjs';
const exec = promisify(execFile);

// Read only named, bounded regular files; never traverse the private data directory.
async function readArtifact(file) {
  let handle;
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) return null;
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(131072);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return null; }
  finally { await handle?.close(); }
}

const failureCodes = ['stream_incomplete','invalid_response','invalid_usage','response_limit','provider_error'];
function apiMetadata(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const result = {};
  if (typeof source.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(source.at) && Number.isFinite(Date.parse(source.at))) result.at = source.at;
  for (const [key, values] of Object.entries({status:['pending','known','unknown'],purpose:['course','connection_test'],failure_stage:['connecting','receiving','decoding','accounting'],failure_type:['Error','SyntaxError','TypeError','TimeoutError','AbortError'],failure_code:failureCodes})) {
    if (values.includes(source[key])) result[key] = source[key];
  }
  if (Number.isInteger(source.http_status) && source.http_status >= 100 && source.http_status <= 599) result.http_status = source.http_status;
  if (Number.isSafeInteger(source.response_bytes) && source.response_bytes >= 0) result.response_bytes = source.response_bytes;
  for (const key of ['not_sent','metering_bound_exceeded']) if (typeof source[key] === 'boolean') result[key] = source[key];
  return result;
}

async function apiRequests(file) {
  try {
    if (!(await fs.lstat(path.dirname(file))).isDirectory()) return [];
    const ledger = JSON.parse(await readArtifact(file));
    return Array.isArray(ledger?.requests) ? ledger.requests.slice(-10).map(apiMetadata).filter(Boolean) : [];
  } catch { return []; }
}

async function billingMetadata(file, courseId) {
  try {
    if (!(await fs.lstat(path.dirname(file))).isDirectory()) return { readable: false };
    const raw = await readArtifact(file);
    if (!raw) return { readable: false };
    const costs = ledgerCosts(validateLedger(JSON.parse(raw), courseId));
    return { readable: true, requests: costs.requests, pending: costs.pending, unresolved_requests: costs.unresolvedRequests,
      recovery_required: costs.recoveryRequired, metering_bound_exceeded: costs.meteringBoundExceeded };
  } catch { return { readable: false }; }
}

async function detectionFailure(dataDir) {
  const dir = path.join(dataDir,'detection-ledger');
  try {
    if (!(await fs.lstat(dir)).isDirectory()) return null;
    // shortcut: read only the ten latest detection ledgers; widen if older failures become relevant.
    const files = (await fs.readdir(dir,{withFileTypes:true})).filter(file => file.isFile() && /^course-\d{1,32}\.json$/.test(file.name))
      .map(file => file.name).sort((a,b) => b.length-a.length || b.localeCompare(a)).slice(0,10);
    for (const file of files) {
      const failure = (await apiRequests(path.join(dir,file))).findLast(entry => entry.status === 'unknown' || entry.failure_stage || entry.failure_type || entry.failure_code);
      if (failure) return failure;
    }
  } catch { /* Missing or unreadable detection evidence is not fatal. */ }
  return null;
}

function connectionMetadata(connection) {
  if (!['untested','testing','listed','ok','error'].includes(connection?.status)) return {};
  const result = {status:connection.status};
  if (connection.status === 'error') {
    const message = typeof connection.message === 'string' ? connection.message : '';
    result.reason = failureCodes.includes(connection.failure_code) ? connection.failure_code
      : /Responses 流缺少最终结果|响应流提前结束/.test(message) ? 'stream_incomplete'
      : /响应超限|响应超过大小上限/.test(message) ? 'response_limit'
      : /usage 无效|响应缺少有效用量/.test(message) ? 'invalid_usage'
      : /响应格式无法识别/.test(message) ? 'invalid_response'
      : /Responses 流返回错误|服务返回错误事件/.test(message) ? 'provider_error'
      : /检测记录.*无法读取/.test(message) ? 'cache_unreadable'
      : /费用记录.*不可读|账本.*(?:不可读|异常|无效)/.test(message) ? 'ledger_unreadable'
      : /HTTP (?:401|403)/.test(message) ? 'authentication'
      : /HTTP 429|频率限制|并发限制/.test(message) ? 'rate_limit'
      : /无法连接|网络|超时/.test(message) ? 'connection_failed'
      : /模型列表/.test(message) ? 'model_list'
      : /预算|价格|核价/.test(message) ? 'budget_or_pricing'
      : 'unknown';
  }
  return result;
}

export async function diagnosticReport({ appDir, dataDir, courses, logs, browser, environment, config, connection, secrets = [] }) {
  const replacements = [...secrets, config.api_key, os.homedir(), dataDir, appDir,
    ...courses.flatMap(c => [c.name, c.currentTitle, c.url, String(c.id)])]
    .filter(v => typeof v === 'string' && v.length > 0).sort((a,b) => b.length-a.length);
  const clean = value => {
    let s = String(value ?? '');
    for (const secret of replacements) s = s.split(secret).join('[已隐藏]');
    return s.replace(/https?:\/\/[^\s<>"']+/gi, '[网址已隐藏]')
      .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp|var)\/)[^\s"'<>，；]+/g, '[路径已隐藏]')
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已隐藏]').replace(/\b\d{7,}\b/g, '[编号已隐藏]')
      .replace(/(?:Bearer\s+\S+|\b(?:sk|sess)-[\w-]+|[A-Za-z0-9_-]{32,})/gi, '[凭据已隐藏]')
      .replace(/(?:cookie|authorization|api[_ -]?key|token|password|secret)\s*["']?\s*[:=]\s*[^\r\n]+/gi, '[凭据字段已隐藏]')
      .replace(/(?:question|answers?|student_answer|题干|答案|请求体|响应体)["']?\s*[:=：][^\r\n]+/gi, '[内容已隐藏]').slice(0, 1000);
  };
  const pick = (source, fields) => Object.fromEntries(fields.filter(k => Object.hasOwn(source || {},k)).map(k => [k,
    typeof source[k] === 'boolean' ? source[k] : typeof source[k] === 'number' ? (Number.isFinite(source[k]) ? source[k] : null) : clean(source[k]) ]));
  const aliases = new Map(courses.map((c,i) => [String(c.id), 'course-'+(i+1)]));
  const script = await readArtifact(path.join(appDir,'szu-uooc.user.js'));
  const manifest = await readArtifact(path.join(appDir,'../文件校验.sha256'));
  const report = { format_version:1, exported_at:new Date().toISOString(), instructions:'将此 ZIP 发给维护者。已排除账号配置、Cookie、访问令牌、课程网址、课程名称、题目答案、截图和浏览器资料。',
    build:{userscript_version:script?.match(/@version\s+(\S+)/)?.[1] || 'unknown', manifest_sha256:manifest ? createHash('sha256').update(manifest).digest('hex') : null},
    system:{platform:process.platform,arch:process.arch,node:process.versions.node,os_release:os.release()},
    browser:pick(browser,['kind','status','catalog']), environment:pick(environment,['status','message']),
    service:{...pick(config,['answer_mode','wire_api','model','service_status']),connection:connectionMetadata(connection),detection_failure:await detectionFailure(dataDir)}, courses:[],
    logs:logs.slice(-100).map(l => ({at:clean(l.at),course:aliases.get(String(l.courseId)) || null,message:clean(l.message)})) };
  for (const c of courses.slice(0,200)) {
    if (!/^\d+$/.test(String(c.id))) continue;
    const dir = path.join(dataDir,'evidence','course-'+c.id);
    let state;
    try { state = JSON.parse(await readArtifact(path.join(dir,'state.json'))); } catch { /* Missing evidence is reported, not fatal. */ }
    const events = (await readArtifact(path.join(dir,'recovery.jsonl')) || '').split('\n').filter(Boolean).slice(-100).flatMap(line => {
      try { return [pick(JSON.parse(line),['at','event','phase','attempt','stage','reason'])]; } catch { return []; }
    });
    report.courses.push({alias:aliases.get(String(c.id)),...pick(c,['status','phase','completed','total','lockedUnits','error']),
      evidence:state ? pick(state,['phase','active','completed','total','lockedUnits','error','heartbeatAt','progressAt','recoveryAttempt','recoveryOperation','recoveryReason','recoveryResult','nextRetryAt','pendingSubmit']) : null, recovery_events:events,
      api_requests:await apiRequests(path.join(dataDir,'ledger','course-'+c.id+'.json')),
      billing:await billingMetadata(path.join(dataDir,'ledger','course-'+c.id+'.json'), c.id)});
  }
  return report;
}

export async function diagnosticZip(options) {
  const report = await diagnosticReport(options);
  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(),'szu-diagnostics-'));
    const source = path.join(dir,'diagnostic.json'), archive = path.join(dir,'diagnostic.zip');
    await fs.writeFile(source,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    if (process.platform === 'win32') {
      await exec(path.join(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile','-NonInteractive','-Command','Compress-Archive -LiteralPath $env:SZU_DIAGNOSTIC_JSON -DestinationPath $env:SZU_DIAGNOSTIC_ZIP'],
        {env:{...process.env,SZU_DIAGNOSTIC_JSON:source,SZU_DIAGNOSTIC_ZIP:archive},timeout:15000,windowsHide:true});
    } else await exec('/usr/bin/zip',['-q','-j',archive,source],{timeout:15000});
    return await fs.readFile(archive);
  } catch { throw new Error('诊断包生成失败，请检查临时目录可写且系统压缩工具可用，再重试。'); }
  finally { if (dir) await fs.rm(dir,{recursive:true,force:true}).catch(() => {}); }
}
