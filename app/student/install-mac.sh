#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "暂不支持这台 Mac 的芯片。"; exit 1 ;;
esac
runtime="$PWD/runtime/mac-$arch"
node="$runtime/bin/node"
if [ "${1:-}" = '--node-only' ] && [ -x "$node" ] && "$node" --version >/dev/null 2>&1; then exit 0; fi
if [ -x "$node" ] && "$node" app/student/start.mjs --check >/dev/null 2>&1; then
  echo "依赖已经齐全，无需再次下载。现在可以双击「启动-Mac.command」。"
  exit 0
fi
mkdir -p runtime
if ! mkdir runtime/.install-lock 2>/dev/null; then
  echo "已有下载窗口正在运行，请回到原窗口等待完成。"
  exit 1
fi
temp=""
cleanup() {
  [ -z "$temp" ] || rm -rf "$temp"
  rmdir runtime/.install-lock
}
trap cleanup EXIT
trap 'exit 130' INT TERM
temp=$(mktemp -d "$PWD/runtime/.download.XXXXXX")
filename="node-v24.21.0-darwin-$arch.tar.gz"
if [ ! -x "$node" ] || ! "$node" --version >/dev/null 2>&1 || [ ! -f "$runtime/lib/node_modules/npm/bin/npm-cli.js" ]; then
  echo "[1/3] 下载这台 Mac 的运行环境，请保持联网……"
  curl --fail --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 20 --max-time 900 \
    "https://nodejs.org/dist/v24.21.0/$filename" -o "$temp/$filename"
  echo "[2/3] 校验并解压运行环境……"
  awk -v file="$filename" '$2 == file' 依赖校验.sha256 > "$temp/check.sha256"
  [ -s "$temp/check.sha256" ] || { echo "依赖校验文件不完整，请重新解压 ZIP。"; exit 1; }
  (cd "$temp" && shasum -a 256 -c check.sha256 && tar -xzf "$filename")
  # Downloaded runtime stays local to the extracted folder; no system installation.
  rm -rf "$runtime"
  mv "$temp/node-v24.21.0-darwin-$arch" "$runtime"
fi
if [ "${1:-}" = '--node-only' ]; then
  echo "运行环境准备完成，正在打开 szu-uooc 控制台……"
  exit 0
fi
echo "[3/3] 下载浏览器连接组件……"
export PATH="$runtime/bin:$PATH"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
(cd app && "$node" "$runtime/lib/node_modules/npm/bin/npm-cli.js" ci --ignore-scripts --omit=optional \
  --no-audit --no-fund --registry=https://registry.npmjs.org --cache "$PWD/../runtime/npm-cache")
"$node" app/student/start.mjs --check
echo "下载完成。现在可以双击「启动-Mac.command」；以后无需重复下载。"
