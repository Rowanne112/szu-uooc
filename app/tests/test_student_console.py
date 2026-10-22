"""Live console check: python3 test_student_console.py /path/to/app /path/to/node."""
import http.cookiejar
import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

app, node = Path(sys.argv[1]).resolve(), sys.argv[2]
launcher = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else None
with tempfile.TemporaryDirectory(prefix='szu-console-first-use-') as private:
    def launch(use_launcher=False):
        command = ['/bin/bash', str(launcher)] if use_launcher else [node, str(app / 'student/start.mjs')]
        proc = subprocess.Popen([*command, '--no-open', '--data-dir', private], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, env={**os.environ, 'PATH': '/usr/bin:/bin'})
        output = bytearray()
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            ready, _, _ = select.select([proc.stdout], [], [], .2)
            if ready:
                chunk = os.read(proc.stdout.fileno(), 65536)
                output.extend(chunk)
                found = re.search(rb'http://127\.0\.0\.1:\d+/\?token=[a-f0-9]+', output)
                if found:
                    url = found.group().decode()
                    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                    opener.open(url, timeout=10).read()
                    origin = url.split('/?')[0]
                    def get():
                        return json.load(opener.open(origin + '/api/state', timeout=10))
                    csrf = get()['csrf']
                    def post(route, body=None, status=200):
                        req = urllib.request.Request(origin + route, data=json.dumps(body or {}).encode(), headers={'Content-Type':'application/json','Origin':origin,'X-Szu-Token':csrf}, method='POST')
                        try:
                            response = opener.open(req, timeout=10)
                        except urllib.error.HTTPError as error:
                            response = error
                        assert response.status == status
                        return json.load(response)
                    return proc, output, get, post
                if proc.poll() is not None:
                    raise AssertionError(output.decode(errors='replace'))
        raise AssertionError('Console did not start in time')

    def wait_ready(get):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            state = get()
            if state['environment']['status'] == 'ready':
                return state
            if state['environment']['status'] == 'error':
                raise AssertionError(state['environment']['message'])
            time.sleep(.25)
        raise AssertionError('Dependency preparation timed out')

    def stop(proc, post):
        post('/api/shutdown')
        proc.wait(timeout=10)
        assert proc.returncode == 0
        assert not (Path(private) / 'running.pid').exists()

    proc, output, get, post = launch(use_launcher=launcher is not None)
    try:
        state = wait_ready(get)
        assert not state['config']['hasKey']
        key = 'fixture-only-private-api-key'
        post('/api/config', {'api_key':key})
        config = Path(private) / 'api.json'
        assert config.stat().st_mode & 0o777 == 0o600
        assert json.loads(config.read_text())['api_key'] == key
        assert key not in json.dumps(get())
        post('/api/courses', {'url':'https://evil.test/course'}, 400)
        post('/api/courses', {'url':'https://www.uooc.net.cn/home/learn/#/111/1/2/3/section','name':'安装验收课程'})
        second = subprocess.run([node, str(app / 'student/start.mjs'),'--no-open','--data-dir',private], capture_output=True, text=True, timeout=10)
        assert second.returncode == 0 and '原来的控制台' in second.stdout
        assert key.encode() not in output
        stop(proc, post)
        print('真实首次启动：自动下载组件、配置权限0600、Key不回传、网址校验、重复启动复用控制台、退出清理：通过。', flush=True)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)

    # Repair a partial local install without asking the user to touch program files.
    core = app / 'node_modules/playwright-core'
    subprocess.run(['/bin/rm','-rf',str(core)],check=True)
    proc, output, get, post = launch()
    try:
        state = wait_ready(get)
        assert state['config']['hasKey']
        assert len(state['courses']) == 1 and state['activeId'] is None
        assert core.is_dir()
        stop(proc, post)
        print('再次启动：保留Key与课程列表、不自动运行、缺失组件自动修复：通过。无浏览器课程连接，无解题API请求。', flush=True)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
