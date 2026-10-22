import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('../student/network-mac.sh', import.meta.url));
const systemProxy = (host = '127.0.0.1', port = '7892', enabled = '1') => `<dictionary> {
  HTTPSEnable : ${enabled}
  HTTPSProxy : ${host}
  HTTPSPort : ${port}
}`;

async function network(t, config, overrides = {}, repeats = 1) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'szu-mac-network-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'scutil'), '#!/bin/bash\nprintf "%s\\n" "$SZU_TEST_SYSTEM_PROXY"\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${dir}:/usr/bin:/bin`, SZU_TEST_SYSTEM_PROXY: config };
  for (const name of Object.keys(env)) if (/^(https?|all|no)_proxy$/i.test(name)) delete env[name];
  const result = await run('/bin/bash', ['-euc', `for ((i=0;i<${repeats};i++)); do source "$1"; done
    printf '%s\\n' "__values__" "\${https_proxy-}" "\${HTTPS_PROXY-}" "\${all_proxy-}" "\${ALL_PROXY-}" "\${no_proxy-}" "\${NO_PROXY-}"`, 'bash', helper], { env: { ...env, ...overrides } });
  assert.equal(result.stderr, '');
  const [marker, https, HTTPS, all, ALL, no, NO] = result.stdout.trimEnd().split('\n');
  assert.equal(marker, '__values__', 'sourcing the helper stays silent');
  return { https, HTTPS, all, ALL, no, NO };
}

test('Mac downloads use system HTTPS proxy with no inherited proxy variables', async t => {
  const result = await network(t, systemProxy());
  assert.equal(result.https, 'http://127.0.0.1:7892');
  assert.equal(result.HTTPS, result.https);
  assert.equal(result.no, 'localhost,127.0.0.1,::1');
  assert.equal(result.NO, result.no);
  assert.equal((await network(t, systemProxy('proxy.example.test', '8080'))).https, 'http://proxy.example.test:8080');
});

test('disabled or malformed system proxies do not become download proxies', async t => {
  for (const config of [systemProxy('127.0.0.1', '7892', '0'), systemProxy('127.0.0.1', '0'), systemProxy('127.0.0.1', '65536'), systemProxy('127.0.0.1', 'abc'), systemProxy('999.0.0.1'), systemProxy('-bad.test'), systemProxy('bad..test'), systemProxy('user:password@proxy.test'), systemProxy('$(touch-owned)'), systemProxy(''), systemProxy('good.test extra'), 'not a proxy dictionary']) {
    const result = await network(t, config);
    assert.equal(result.https, '', config);
    assert.equal(result.HTTPS, '', config);
  }
});

test('explicit HTTPS or ALL proxy configuration keeps priority', async t => {
  for (const name of ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    const result = await network(t, systemProxy(), { [name]: 'http://explicit.test:8080' });
    assert.equal(result[{ https_proxy: 'https', HTTPS_PROXY: 'HTTPS', all_proxy: 'all', ALL_PROXY: 'ALL' }[name]], 'http://explicit.test:8080');
    if (name.toLowerCase() === 'all_proxy') {
      assert.equal(result.https, 'http://explicit.test:8080', 'npm must receive ALL proxy through its supported HTTPS variable');
      assert.equal(result.HTTPS, result.https);
    }
    assert(!Object.values(result).includes('http://127.0.0.1:7892'));
  }
  const all = await network(t, systemProxy(), { all_proxy: 'http://lower.test:8080', ALL_PROXY: 'http://upper.test:8080' });
  assert.equal(all.https, 'http://lower.test:8080');
  assert.equal(all.HTTPS, all.https);
  assert.equal(all.all, 'http://lower.test:8080');
  assert.equal(all.ALL, 'http://upper.test:8080');
  for (const name of ['https_proxy', 'HTTPS_PROXY']) {
    const result = await network(t, systemProxy(), { [name]: 'http://https.test:8080', ALL_PROXY: 'http://all.test:8080' });
    assert.equal(result[name === 'https_proxy' ? 'https' : 'HTTPS'], 'http://https.test:8080');
    assert.equal(result[name === 'https_proxy' ? 'HTTPS' : 'https'], '', 'ALL proxy must not replace an explicit HTTPS configuration');
    assert.equal(result.ALL, 'http://all.test:8080');
  }
});

test('loopback bypass preserves user exclusions and stays stable when sourced twice', async t => {
  const result = await network(t, systemProxy(), { no_proxy: 'internal.test,127.0.0.1', NO_PROXY: '.example.test' }, 2);
  assert.equal(result.no, 'internal.test,127.0.0.1,.example.test,localhost,::1');
  assert.equal(result.NO, result.no);
});
