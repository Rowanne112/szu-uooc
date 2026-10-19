import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

export async function diagnosticReport({ appDir, dataDir, courses, logs, browser, environment, config, secrets = [] }) {
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
    service:pick(config,['answer_mode','wire_api','model','service_status']), courses:[],
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
      evidence:state ? pick(state,['phase','active','completed','total','lockedUnits','error','heartbeatAt','progressAt','recoveryAttempt','recoveryOperation','recoveryReason','recoveryResult','nextRetryAt','pendingSubmit']) : null, recovery_events:events});
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
