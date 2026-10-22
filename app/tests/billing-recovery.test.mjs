import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

// An alternate source path permits the same recovery contract to run against HEAD.
const source = process.env.SZU_RECOVERY_API_MODULE
  ? pathToFileURL(path.resolve(process.env.SZU_RECOVERY_API_MODULE)).href
  : new URL('../api-request.mjs', import.meta.url).href;
const { createAPI } = await import(source);
const config = { base_url: 'https://fixture.invalid/v1', model: 'fixture-model', api_key: 'fixture-key', budget: 1, pricing: { input_per_million: .1, cached_input_per_million: .01, output_per_million: .6 } };
const details = { method: 'POST', url: config.base_url + '/responses', data: JSON.stringify({ model: config.model, reasoning: { effort: 'medium' }, store: false, input: 'question', max_output_tokens: 128 }) };
const ok = () => Response.json({ model: config.model, status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [] });

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-billing-recovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'course-123.json');
  return { dir, file, read: async () => JSON.parse(await fs.readFile(file, 'utf8')) };
}

test('verified zero token prices still dispatch and preserve a conservative reservation when a response is lost', async t => {
  const { dir, read } = await setup(t);
  const free = { ...config, pricing: { input_per_million: 0, cached_input_per_million: 0, output_per_million: 0 } };
  let calls = 0;
  const api = createAPI(free, dir, async () => { if (++calls === 2) throw new TypeError('fixture lost response'); return ok(); });
  assert.equal((await api('123', details)).status, 200);
  assert.equal((await read()).requests[0].cost_nanos, 0);
  await assert.rejects(api('123', details), /费用未知/);
  const before = await read();
  assert(before.requests[1].reserved_nanos > 0);
  await api.prepareResume('123');
  assert.equal((await api('123', details)).status, 200);
  assert.deepEqual((await read()).requests.slice(0, 2), before.requests);
  assert.equal(calls, 3);
});

test('diagnostic replay: explicit resume after a pre-header TypeError survives a controller restart and retains the charge', async t => {
  const { dir, read } = await setup(t);
  const failed = createAPI(config, dir, async () => { throw new TypeError('fixture connection failed'); });
  await assert.rejects(failed('123', details), /费用未知/);
  const before = await read();
  assert.equal(before.requests[0].status, 'unknown');
  assert.equal(before.requests[0].failure_stage, 'connecting');
  assert.equal(before.requests[0].failure_type, 'TypeError');
  assert.equal(before.requests[0].http_status, undefined);
  let calls = 0;
  const restarted = createAPI(config, dir, async () => { calls++; return ok(); });
  await assert.rejects(restarted('123', details), /上次请求费用未知/);
  assert.equal(calls, 0);
  await restarted.prepareResume('123');
  assert.deepEqual((await read()).requests, before.requests);
  assert.equal((await restarted('123', details)).status, 200);
  const after = await read();
  assert.deepEqual(after.requests[0], before.requests[0]);
  assert.deepEqual(after.requests[1].resumed_unknown_requests, [before.requests[0].id]);
  assert.equal(calls, 1);
});

test('a real process exit after dispatch leaves a reservation that explicit restart resume can recover without deleting it', async t => {
  const { dir, read } = await setup(t);
  const child = `import { createAPI } from ${JSON.stringify(source)};
    const api = createAPI(${JSON.stringify(config)}, ${JSON.stringify(dir)}, async () => {
      process.stdout.write('request-dispatched'); process.exit(86);
    });
    await api('123', ${JSON.stringify(details)});`;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', child]), error => error.code === 86 && error.stdout === 'request-dispatched');
  const before = await read();
  assert.equal(before.requests.length, 1);
  assert.equal(before.requests[0].status, 'pending');
  assert(before.requests[0].reserved_nanos > 0);
  let calls = 0;
  const restarted = createAPI(config, dir, async () => { calls++; return ok(); });
  await assert.rejects(restarted('123', details), /费用未知/);
  assert.equal(calls, 0, 'reopening an API alone cannot authorize a new paid attempt');
  await restarted.prepareResume('123');
  assert.deepEqual((await read()).requests, before.requests, 'an explicit recovery cannot rewrite historical charges');
  assert.equal((await restarted('123', details)).status, 200, 'the explicit Continue action must recover an orphaned dispatched request');
  const after = await read();
  assert.deepEqual(after.requests[0], before.requests[0]);
  assert.deepEqual(after.requests[1].resumed_unknown_requests, [before.requests[0].id]);
  assert.equal(calls, 1);
});

test('a recovery approval survives another process restart and covers only the confirmed historical requests', async t => {
  const { dir, read } = await setup(t);
  const first = createAPI(config, dir, async () => { throw new TypeError('fixture initial failure'); });
  await assert.rejects(first('123', details), /费用未知/);
  const before = await read();
  await first.prepareResume('123');
  assert.deepEqual((await read()).requests, before.requests);
  let calls = 0;
  const restarted = createAPI(config, dir, async () => {
    if (++calls === 1) return ok();
    throw new TypeError('fixture newly failed request');
  });
  assert.equal((await restarted('123', details)).status, 200, 'a completed Continue approval must survive restart before dispatch');
  await assert.rejects(restarted('123', details), /费用未知/);
  await assert.rejects(restarted('123', details), /上次请求费用未知/);
  assert.equal(calls, 2, 'old approval cannot authorize another failed request');
  const after = await read();
  assert.deepEqual(after.requests[0], before.requests[0]);
  assert.equal(after.requests.length, 3);
  let nextCalls = 0;
  const again = createAPI(config, dir, async () => { nextCalls++; return ok(); });
  await assert.rejects(again('123', details), /上次请求费用未知/);
  assert.equal(nextCalls, 0, 'restart cannot extend a historical approval to a newer failure');
});

test('an explicit resume from another controller waits for the shared course request before approving recovery', async t => {
  const { dir, read } = await setup(t);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const dispatched = new Promise(resolve => { entered = resolve; });
  const active = createAPI(config, dir, async () => { entered(); await gate; throw new TypeError('fixture disconnected'); });
  const first = active('123', details).then(value => ({ value }), error => ({ error }));
  await dispatched;
  let calls = 0;
  const replacement = createAPI(config, dir, async () => { calls++; return ok(); });
  const preparing = replacement.prepareResume('123');
  const result = await Promise.race([preparing.then(() => 'returned-before-settlement'), new Promise(resolve => setTimeout(resolve, 100, 'waiting'))]);
  release();
  assert.match((await first).error.message, /费用未知/);
  await preparing;
  assert.equal(result, 'waiting', 'Continue must wait for the active shared request, not approve its in-flight reservation');
  const before = await read();
  assert.equal((await replacement('123', details)).status, 200);
  const after = await read();
  assert.deepEqual(after.requests[0], before.requests[0]);
  assert.deepEqual(after.requests[1].resumed_unknown_requests, [before.requests[0].id]);
  assert.equal(calls, 1);
});

test('an active paid request in another process cannot be approved as an orphaned pending request', { timeout: 5000 }, async t => {
  const { dir, read } = await setup(t);
  const childSource = `import { createAPI } from ${JSON.stringify(source)};
    setInterval(() => {}, 1000);
    const api = createAPI(${JSON.stringify(config)}, ${JSON.stringify(dir)}, async () => {
      process.stdout.write('request-dispatched'); return new Promise(() => {});
    });
    await api('123', ${JSON.stringify(details)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('active request fixture exited before dispatch')));
    child.stdout.once('data', bytes => bytes.toString() === 'request-dispatched' ? resolve() : reject(new Error('unexpected active fixture output')));
  });
  const before = await read();
  assert.equal(before.requests[0].status, 'pending');
  const replacement = createAPI(config, dir, ok);
  const preparing = replacement.prepareResume('123').then(() => 'approved', () => 'blocked');
  const verdict = await Promise.race([preparing, new Promise(resolve => setTimeout(resolve, 100, 'waiting'))]);
  assert.notEqual(verdict, 'approved', 'an active process still owns this pending request; Continue must wait or fail closed');
  const activeLedger = await read();
  assert.deepEqual(activeLedger.requests, before.requests);
  assert.deepEqual(activeLedger.recoveries, before.recoveries, 'no confirmation may be appended while the other process is active');
  child.kill('SIGTERM'); await exited;
  await preparing;
});
