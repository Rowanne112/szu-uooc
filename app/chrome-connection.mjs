import fs from 'node:fs/promises';
import path from 'node:path';
import { allowedHost } from './browser-bridge.mjs';

export async function connectOriginalChrome(chromium, endpoint, { userDataDir, timeout = 60000 } = {}) {
  if (endpoint === 'chrome') {
    const [port, route] = (await fs.readFile(path.join(userDataDir, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser(?:\/[A-Za-z0-9-]+)?$/.test(route)) throw new Error('Chrome 调试地址无效，请重新开启调试开关。');
    endpoint = `ws://127.0.0.1:${port}${route}`;
  }
  const local = value => {
    const url = new URL(value);
    if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('浏览器连接只能使用本机地址。');
    return url;
  };
  let address = local(endpoint);
  if (address.protocol === 'http:') {
    const response = await fetch(new URL('/json/version', address), { signal: AbortSignal.timeout(timeout), redirect: 'error' });
    if (!response.ok) throw new Error('Chrome 调试服务未就绪。');
    address = local((await response.json()).webSocketDebuggerUrl);
  }
  if (address.protocol !== 'ws:') throw new Error('Chrome 调试服务没有返回 WebSocket 地址。');
  let socket, internalId = -1, connected = false;
  const queue = [], ignored = new Set(), internal = new Set();
  const send = message => {
    // Wait until Playwright installs its handlers before opening the socket.
    transport.open();
    socket.readyState === WebSocket.OPEN ? socket.send(JSON.stringify(message)) : queue.push(message);
  };
  const transport = {
    open() {
      if (socket) return;
      socket = new WebSocket(address);
      socket.onopen = () => { for (const message of queue.splice(0)) send(message); };
      socket.onmessage = event => {
        let message;
        try { message = JSON.parse(event.data); } catch { socket.close(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(); return; }
        if (internal.delete(message.id)) return;
        if (message.method === 'Target.attachedToTarget' && !message.sessionId && message.params.targetInfo.type === 'page') {
          const target = message.params.targetInfo;
          let course = connected && (target.url === 'about:blank' || target.url === '');
          try { const url = new URL(target.url); course ||= url.protocol === 'https:' && allowedHost(url.hostname); } catch {}
          // Playwright waits for every attached renderer; an unrelated hung tab must not block the course.
          if (!course) {
            ignored.add(message.params.sessionId);
            const id = internalId--; internal.add(id);
            send({ id, method: 'Target.detachFromTarget', params: { sessionId: message.params.sessionId } });
            return;
          }
        }
        if (ignored.has(message.sessionId) || message.method === 'Target.detachedFromTarget' && ignored.has(message.params.sessionId)) return;
        transport.onmessage?.(message);
      };
      socket.onclose = () => transport.onclose?.();
      socket.onerror = () => socket.close();
    },
    send,
    close() { socket?.close(); },
  };
  const browser = await chromium.connectOverCDP(transport, { timeout, noDefaults: true });
  connected = true;
  return browser;
}
