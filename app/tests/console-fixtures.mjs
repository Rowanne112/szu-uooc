import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const courseURL = id => `https://www.uooc.net.cn/home/learn/index#/${id}/1/2/3/4/subsection`;
export function fixtureWorker(children) {
  return (_node, args, options) => {
    assert.equal(options.stdio[3], 'ipc'); assert(args.includes('--console'));
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.id = new URL(args[1]).hash.slice(2).split('/')[0]; child.state = { courseId: child.id, phase: 'video', active: true, total: 20, completed: 7, currentTitle: '1.2 课程视频' };
    child.report = () => child.emit('message', { type: 'state', state: { ...child.state }, title: `课程 ${child.id}` });
    child.send = message => queueMicrotask(() => {
      if (message.action === 'stop') { child.emit('exit', 0, null); return; }
      Object.assign(child.state, message.action === 'pause' ? { phase: 'paused', active: false, error: '用户暂停' } : { phase: 'video', active: true, error: '' }); child.report();
    });
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    children.push(child); queueMicrotask(child.report); return child;
  };
}
export async function session(app) {
  const auth = await fetch(app.url, { redirect: 'manual' }); assert.equal(auth.status, 303);
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const get = async () => { const res = await fetch(app.origin + '/api/state', { headers: { Cookie: cookie } }); assert.equal(res.status, 200); return res.json(); };
  const state = await get();
  const post = async (route, data = {}, status = 200) => {
    const res = await fetch(app.origin + route, { method: 'POST', headers: { Cookie: cookie, Origin: app.origin, 'X-Szu-Token': state.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await res.json(); assert.equal(res.status, status, JSON.stringify(body)); return body;
  };
  return { cookie, get, post, csrf: state.csrf };
}
