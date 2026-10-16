#!/bin/bash
cd "$(dirname "$0")" || exit 1
umask 077
/bin/bash app/student/install-mac.sh --node-only || { echo "网络连接失败，请重新双击启动重试。"; if [ -t 0 ]; then read -r -p "按回车关闭窗口。"; fi; exit 1; }
case "$(uname -m)" in
  arm64) runtime="runtime/mac-arm64/bin/node" ;;
  x86_64) runtime="runtime/mac-x64/bin/node" ;;
  *) echo "暂不支持这台 Mac 的芯片。"; exit 1 ;;
esac
if [ "$#" -gt 0 ]; then "$runtime" app/student/start.mjs "$@"; exit "$?"; fi
nohup "$runtime" app/student/start.mjs > runtime/console.log 2>&1 < /dev/null &
pid=$!
sleep 2
if ! kill -0 "$pid" 2>/dev/null; then
  wait "$pid"
  status=$?
  if [ "$status" -ne 0 ]; then cat runtime/console.log; if [ -t 0 ]; then read -r -p "按回车关闭窗口。"; fi; exit "$status"; fi
fi
echo "szu-uooc 控制台正在浏览器中打开，可以关闭这个窗口。"
