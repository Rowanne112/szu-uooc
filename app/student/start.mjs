import fs from 'node:fs/promises';
import { explainProblem } from './user-guidance.mjs';
import { readFileSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import { createConsole } from './console-server.mjs';
import { defaultDataDir, migrateSettings, readJSON } from './settings.mjs';
export { validateCourseURL, validateConfig } from './settings.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function controllerArgs(courseURL, file, dir) {
  return [path.join(appDir, 'controller.mjs'), courseURL, '--config', file, '--data-dir', dir, '--console'];
}

export async function acquireStartLock(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'running.pid');
  try { writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('启动记录异常，请检查本机配置目录里的 running.pid；不要删除费用账本。');
    try { process.kill(pid, 0); }
    catch (probe) {
      if (probe.code !== 'ESRCH') {
        let image;
        if (process.platform === 'win32' && probe.code === 'EPERM') {
          try {
            const output = childProcess.execFileSync(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
            const row = output.trim().match(/^"([^"]+)","(\d+)"/);
            if (row && Number(row[2]) === pid) image = row[1];
          } catch { /* Keep the lock when Windows cannot identify its owner. */ }
        }
        // The portable Windows launcher always runs node.exe; another image means this PID was reused.
        if (!image || image.toLowerCase() === 'node.exe') throw probe;
      }
      unlinkSync(file);
      return acquireStartLock(dir);
    }
    throw new Error('控制台已打开，请回到原来的控制台。');
  }
  const release = () => {
    process.removeListener('exit', release);
    try { if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file); } catch {}
  };
  process.once('exit', release);
  return release;
}

export function checkPackage() {
  const require = createRequire(path.join(appDir, 'package.json'));
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('运行环境版本不匹配。');
  if (require('playwright/package.json').version !== '1.62.1' || require('playwright-core/package.json').version !== '1.62.1' || !require('playwright').chromium) throw new Error('浏览器连接组件尚未准备好。');
}

export function openBrowser(url) {
  let command, args;
  if (process.platform === 'darwin') { command = '/usr/bin/open'; args = [url]; }
  else if (process.platform === 'win32') { command = 'rundll32.exe'; args = ['url.dll,FileProtocolHandler', url]; }
  else { command = 'xdg-open'; args = [url]; }
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log('请在浏览器中打开控制台：' + url));
  child.on('exit', code => {
    if (code && process.platform === 'darwin') {
      const fallback = spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true });
      fallback.on('error', () => console.log('请在浏览器中打开控制台：' + url));
      fallback.unref();
    }
  });
  child.unref();
}

async function main() {
  if (process.argv.includes('--check')) { checkPackage(); console.log('szu-uooc 运行环境自检通过。'); return; }
  const index = process.argv.indexOf('--data-dir');
  const dataDir = index < 0 ? defaultDataDir : path.resolve(process.argv[index + 1]);
  const readyIndex = process.argv.indexOf('--ready-file');
  const manifest = await fs.readFile(path.resolve(appDir, '../文件校验.sha256')).catch(() => fs.readFile(path.join(appDir, 'student/console-server.mjs')));
  const build = createHash('sha256').update(manifest).digest('hex');
  const markReady = async () => {
    if (readyIndex >= 0) { const { saveJSON } = await import('./settings.mjs'); await saveJSON(path.resolve(process.argv[readyIndex + 1]), { ready: true }); }
  };
  await migrateSettings(dataDir);
  let release;
  try { release = await acquireStartLock(dataDir); }
  catch (error) {
    const address = await readJSON(path.join(dataDir, 'console-address.json'), null);
    if (address && /^http:\/\/127\.0\.0\.1:\d+\//.test(address.url)) {
      let response;
      try {
        response = await fetch(address.url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
      } catch {}
      if (response?.status === 303) {
        if (!process.argv.includes('--no-open')) openBrowser(address.url);
        if (address.appDir !== appDir || address.build !== build) throw new Error('旧版或另一文件夹的控制台仍在运行。请在旧控制台点击「设置 → 退出程序」，再双击新版启动文件；不要删除设置或费用记录。');
        await markReady(); console.log('已打开原来的控制台。'); return;
      }
    }
    throw error;
  }
  const consoleApp = await createConsole({ appDir, dataDir });
  consoleApp.server.once('close', release);
  console.log('szu-uooc 控制台已打开。按页面指引选择并连接浏览器，读取课程或停止运行。');
  console.log(consoleApp.url);
  await saveAddress();
  async function saveAddress() {
    const { saveJSON } = await import('./settings.mjs');
    await saveJSON(path.join(dataDir, 'console-address.json'), { url: consoleApp.url, pid: process.pid, appDir, build });
  }
  if (!process.argv.includes('--no-open')) openBrowser(consoleApp.url);
  const close = async () => {
    await consoleApp.close();
    release();
    process.exit(0);
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  await markReady();
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    const logs = path.resolve(appDir, '../runtime');
    try { await fs.mkdir(logs, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(logs, 'start-error.log'), String(error.stack || error), { mode: 0o600 }); } catch {}
    console.error(explainProblem(error.message)); process.exitCode = 1;
  });
}
