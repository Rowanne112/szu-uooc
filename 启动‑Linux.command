#!/usr/bin/env bash
# Linux 启动脚本 – 与 mac 版本对应
# 用法： ./启动‑Linux.command   （可选参数直接传给 start.mjs）

cd "$(dirname "$0")" || exit 1
umask 077

# 检查并执行安装脚本（仅检查 Node）
if [ ! -x app/student/install-linux.sh ]; then
  echo "请先执行 ./app/student/install-linux.sh 完成依赖安装"
  exit 1
fi
./app/student/install-linux.sh --node-only

runtime="runtime/linux-x64"
node="$runtime/bin/node"

# 若有额外参数直接传给 start.mjs
if [ "$#" -gt 0 ]; then
  "$node" app/student/start.mjs "$@"
  exit $?
fi

# 启动控制台（后台运行）
nohup "$node" app/student/start.mjs > "$runtime/console.log" 2>&1 < /dev/null &
pid=$!
sleep 2
if ! kill -0 "$pid" 2>/dev/null; then
  wait "$pid"
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "启动失败，请查看 $runtime/console.log"
    exit $status
  fi
fi

# 自动打开浏览器（Linux 使用 xdg-open）
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:3000" >/dev/null 2>&1 || true
fi

echo "szu-uooc 控制台已在后台启动（PID=$pid）。请在浏览器访问 http://127.0.0.1:3000，或查看 $runtime/console.log"