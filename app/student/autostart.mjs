import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
const ps = value => "'" + String(value).replaceAll("'", "''") + "'";
export function autostartDefinition({ platform = process.platform, home = os.homedir(), env = process.env, node = process.execPath, script, dataDir }) {
  if ([node, script, dataDir].some(value => !value || /[\r\n\0]/.test(value))) throw new Error('自启动路径无效，请把程序放在普通文件夹中。');
  if (platform === 'darwin') {
    const file = path.join(home, 'Library/LaunchAgents/local.szu-uooc.checkin.plist');
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>local.szu-uooc.checkin</string><key>ProgramArguments</key><array>${[node, script, '--no-open', '--data-dir', dataDir].map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>LimitLoadToSessionType</key><string>Aqua</string><key>ProcessType</key><string>Interactive</string><key>WorkingDirectory</key><string>${xml(path.dirname(script))}</string><key>StandardOutPath</key><string>${xml(path.join(dataDir, 'startup.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(dataDir, 'startup-error.log'))}</string></dict></plist>\n`;
    return { file, content };
  }
  if (platform === 'win32') {
    if (!env.APPDATA) throw new Error('未找到当前用户的启动文件夹。');
    const file = path.join(env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup/szu-uooc.lnk');
    const args = [script, '--no-open', '--data-dir', dataDir].map(arg => '"' + arg + '"').join(' ');
    const payload = `Start-Process -FilePath ${ps(node)} -ArgumentList ${ps(args)} -WorkingDirectory ${ps(dataDir)} -WindowStyle Hidden -RedirectStandardOutput ${ps(path.join(dataDir, 'startup.log'))} -RedirectStandardError ${ps(path.join(dataDir, 'startup-error.log'))}`;
    const powershell = path.join(env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const shortcutArgs = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + Buffer.from(payload, 'utf16le').toString('base64');
    const command = `$ErrorActionPreference = 'Stop'; $shell = New-Object -ComObject WScript.Shell; $shortcut = $shell.CreateShortcut(${ps(file)}); $shortcut.TargetPath = ${ps(powershell)}; $shortcut.Arguments = ${ps(shortcutArgs)}; $shortcut.WorkingDirectory = ${ps(dataDir)}; $shortcut.WindowStyle = 7; $shortcut.Description = 'szu-uooc 每日签到'; $shortcut.Save()`;
    return { file, command, powershell };
  }
  throw new Error('开机自启动目前支持 Windows 和 macOS。');
}

export async function setAutostart(enabled, options) {
  const definition = autostartDefinition(options);
  if (!enabled) { await fs.rm(definition.file, { force: true }); return; }
  await fs.mkdir(path.dirname(definition.file), { recursive: true, mode: 0o700 });
  await fs.mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  if (definition.content) {
    const temp = definition.file + '.tmp';
    await fs.writeFile(temp, definition.content, { mode: 0o600 }); await fs.rename(temp, definition.file);
  } else await exec(definition.powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(definition.command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
}
