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

# 等待控制台地址就绪：端口是动态分配的，从数据目录读取真实 URL
data_dir="$HOME/.config/szu-uooc"
address_file="$data_dir/console-address.json"
url=""
for i in $(seq 1 20); do
  if [ -f "$address_file" ]; then
    url=$(sed -n 's/.*"url": *"\([^"]*\)".*/\1/p' "$address_file" 2>/dev/null)
    if [ -n "$url" ] && command -v curl >/dev/null 2>&1; then
      code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 1 "$url" 2>/dev/null || echo 000)
      [ "$code" = "000" ] && url=""   # 地址无响应，可能读到旧文件，继续等待
    fi
    [ -n "$url" ] && break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid"; status=$?
    if [ "$status" -ne 0 ]; then
      echo "启动失败，最近日志如下（完整日志：$runtime/console.log）："
      tail -n 5 "$runtime/console.log" 2>/dev/null
      exit "$status"
    fi
  fi
  sleep 0.5
done

if [ -z "$url" ]; then
  echo "未能获取控制台地址，请查看 $runtime/console.log"
  exit 1
fi

# 自动打开浏览器（Linux 使用 xdg-open）
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$url" >/dev/null 2>&1 || true
fi

echo "szu-uooc 控制台已启动。请在浏览器访问："
echo "$url"