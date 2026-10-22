"""Network integration check: python3 szu-uooc/tests/test_student_install.py path/to/package.zip.

Uses an isolated folder, no globally installed Node/npm, no browser or API requests.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

package = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='szu-uooc-light-package-') as temp:
    base = Path(temp)
    extracted = base / '中文 空格目录'
    subprocess.run(['/usr/bin/ditto', '-x', '-k', str(package), str(extracted)], check=True)
    root = extracted / 'szu-uooc-新手版'
    with zipfile.ZipFile(package) as archive:
        assert archive.testzip() is None
        names = archive.namelist()
        assert not any(set(Path(name).parts) & {'runtime', 'node_modules'} for name in names)
        assert package.stat().st_size < 1_000_000
    for line in (root / '文件校验.sha256').read_text().splitlines():
        checksum, filename = line.split('  ', 1)
        assert hashlib.sha256((root / filename).read_bytes()).hexdigest() == checksum
    assert (root / '启动-Mac.command').stat().st_mode & 0o111
    print('ZIP 完整性、无依赖、逐文件校验、Mac 双击入口权限：通过。', flush=True)

    env = {key: value for key, value in os.environ.items() if key.lower() not in {'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'npm_config_proxy', 'npm_config_https_proxy'}}
    env['PATH'] = '/usr/bin:/bin'
    shim = base / 'failed-network'
    shim.mkdir()
    (shim / 'curl').write_text('#!/bin/bash\nexit 22\n')
    (shim / 'curl').chmod(0o755)
    offline = {**env, 'PATH': str(shim) + ':' + env['PATH']}

    def run(args, settings=env, success=True, input_text=None):
        result = subprocess.run(args, cwd=root, env=settings, capture_output=True, text=True, input=input_text, timeout=1000)
        print(result.stdout, flush=True)
        if result.stderr:
            print(result.stderr, flush=True)
        assert (result.returncode == 0) == success, f'Unexpected exit: {result.returncode}'
        return result

    run(['/bin/bash', '启动-Mac.command', '--no-open'], offline, success=False)
    assert not (root / 'runtime/.install-lock').exists()
    assert not list((root / 'runtime').glob('.download.*'))
    print('首次自动下载失败可重试，锁与临时目录清理：通过。', flush=True)

    run(['/bin/bash', 'app/student/install-mac.sh', '--node-only'])
    arch = 'arm64' if os.uname().machine == 'arm64' else 'x64'
    node = root / f'runtime/mac-{arch}/bin/node'
    assert node.is_file()
    assert len(list((root / 'runtime').glob('mac-*'))) == 1
    assert not (root / 'runtime/windows-x64').exists()
    assert not (root / 'app/node_modules').exists(), 'Components are prepared after the console opens'
    console_test = Path(__file__).with_name('test_student_console.py').resolve()
    subprocess.run([sys.executable, str(console_test), str(root / 'app'), str(node), str(root / '启动-Mac.command')], check=True, env=env)
    run(['/bin/bash', '启动-Mac.command', '--check'], offline)
    assert not (root / 'runtime/.install-lock').exists()
    print('完整轻量ZIP、仅当前平台Node、自动组件下载、可视化设置与重启：通过。', flush=True)
print('轻量新手包 Mac 安装流程验收通过。Windows/Intel Mac 仍需对应实机验收。')
