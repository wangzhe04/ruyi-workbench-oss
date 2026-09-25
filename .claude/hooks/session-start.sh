#!/bin/bash
# Claude Code 云端会话(Linux 容器)启动钩子:让服务端能起、回归套件能跑。
# 服务端零 npm 运行时依赖,只需 Node >= 20;这里只准备浏览器件要用的 Chromium 包装。
# 幂等、非交互;本机(Windows)开发不触发。
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 20 ]; then
  echo "session-start: 需要 Node >= 20,当前 $(node -v 2>/dev/null || echo 未安装)" >&2
  exit 1
fi

# 浏览器件(*.browser.e2e.js)要一个 Chromium。容器里以 root 跑,Chromium 必须带 --no-sandbox;
# 界面断言多为中文,顺手固定 --lang=zh-CN。包装脚本交给 dev-harness/lib/browser-path.js(读 RUYI_E2E_BROWSER)。
chromium=""
for c in /opt/pw-browsers/chromium /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do
  if [ -x "$c" ]; then chromium="$c"; break; fi
done

if [ -n "$chromium" ]; then
  wrapper="$HOME/.cache/ruyi-e2e/chromium"
  mkdir -p "$(dirname "$wrapper")"
  printf '#!/bin/sh\nexec %s --no-sandbox --lang=zh-CN "$@"\n' "$chromium" > "$wrapper"
  chmod +x "$wrapper"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export RUYI_E2E_BROWSER=\"$wrapper\"" >> "$CLAUDE_ENV_FILE"
  fi
  echo "session-start: Node $(node -v);浏览器件用 $chromium"
else
  echo "session-start: Node $(node -v);没找到 Chromium,浏览器件会明确 FAIL(非浏览器件不受影响)"
fi
