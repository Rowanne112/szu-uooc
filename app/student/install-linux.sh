#!/usr/bin/env bash
set -euo pipefail
umask 077

# Change to project root
cd "$(dirname "$0")/../.." || exit 1

# Load network proxy config (reuse mac script)
. app/student/network-mac.sh

# Determine architecture (x64 only for now)
arch="x64"
runtime="$PWD/runtime/linux-$arch"
node="$runtime/bin/node"

# If only checking node, exit early
if [[ "${1:-}" == '--node-only' ]]; then
  if [[ -x "$node" ]] && "$node" --version >/dev/null 2>&1; then
    echo "Node 已就绪"
    exit 0
  else
    echo "未找到 Node，请先下载"
    exit 1
  fi
fi

# Ensure Node binary exists
if [[ ! -x "$node" ]]; then
  echo "Node binary 未找到，请先执行下载步骤"
  exit 1
fi

# Install npm dependencies if not already installed
if ! "$node" -e "require('playwright/package.json')" 2>/dev/null; then
  echo "[1/2] 安装 npm 依赖 (Playwright)..."
  export PATH="$runtime/bin:$PATH"
  # Install dependencies using local npm cache
  (cd "$PWD/app" && "$node" "$runtime/lib/node_modules/npm/bin/npm-cli.js" ci \
    --ignore-scripts --omit=optional --no-audit --no-fund \
    --registry=https://registry.npmjs.org \
    --cache "$PWD/../runtime/npm-cache")
else
  echo "npm 依赖已安装"
fi

echo "Linux 安装完成"
