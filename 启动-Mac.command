#!/bin/bash
cd "$(dirname "$0")" || exit 1
umask 077
if [ ! -f app/student/install-mac.sh ] || [ ! -f app/student/network-mac.sh ]; then echo "请重新下载并完整解压安装包，再在解压后的文件夹里双击「启动-Mac.command」。"; if [ -t 0 ]; then read -r -p "按回车关闭窗口。"; fi; exit 1; fi
. app/student/network-mac.sh
/bin/bash app/student/install-mac.sh --node-only || { echo "请先照上面的步骤操作，再双击「启动-Mac.command」。"; if [ -t 0 ]; then read -r -p "按回车关闭窗口。"; fi; exit 1; }
case "$(uname -m)" in
  arm64) runtime="runtime/mac-arm64/bin/node" ;;
  x86_64) runtime="runtime/mac-x64/bin/node" ;;
  *) echo "请在 Apple 芯片或 Intel 芯片的 Mac 上使用这个安装包；这台电脑请联系帮你安装的人。"; exit 1 ;;
esac
if [ "$#" -gt 0 ]; then "$runtime" app/student/start.mjs "$@"; exit "$?"; fi
nohup "$runtime" app/student/start.mjs > runtime/console.log 2>&1 < /dev/null &
pid=$!
sleep 2
if ! kill -0 "$pid" 2>/dev/null; then
  wait "$pid"
  status=$?
  if [ "$status" -ne 0 ]; then echo "请重新下载并完整解压安装包，再双击「启动-Mac.command」。仍不能打开时，把程序文件夹里的 runtime/console.log 发给帮你安装的人；不要删除已有设置和费用记录。"; if [ -t 0 ]; then read -r -p "按回车关闭窗口。"; fi; exit "$status"; fi
fi
echo "szu-uooc 控制台正在浏览器中打开，可以关闭这个窗口。"
