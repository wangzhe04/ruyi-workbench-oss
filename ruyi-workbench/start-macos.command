#!/bin/sh
# Finder and terminal entry point. Do not source login profiles to discover dependencies.
set -eu
cd -- "${0%/*}"

node_path=${RUYI_NODE_PATH:-}
if [ -z "$node_path" ]; then
  for candidate in "$PWD/runtime/node/bin/node" "${HOME:-}/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      node_path=$candidate
      break
    fi
  done
fi
if [ -z "$node_path" ]; then
  node_path=$(command -v node || true)
fi
if [ -z "$node_path" ] || [ ! -x "$node_path" ]; then
  printf '%s\n' '未找到 Node.js。请安装 Node.js 24，或将 RUYI_NODE_PATH 设置为 Node 可执行文件的绝对路径。' >&2
  exit 1
fi
"$node_path" -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || {
  printf '%s\n' '如意需要 Node.js 20 或更高版本，开发验证使用 Node.js 24。' >&2
  exit 1
}
exec "$node_path" app/server.js serve --open "$@"
