'use strict';

const fs = require('fs');

// 浏览器探测:显式指定(RUYI_E2E_BROWSER)-> Edge(Win 必装) -> Chrome -> Linux 常见位置 -> 明确 FAIL
// (不静默跳过,沉默的跳过 = 假绿)。Linux/云端容器以 root 跑时 Chromium 需要 --no-sandbox,
// 用 RUYI_E2E_BROWSER 指向一个带该参数的包装脚本即可,不在各件里改启动参数。
function findBrowserExecutable() {
  const explicit = String(process.env.RUYI_E2E_BROWSER || '').trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : '';
  const candidates = process.platform === 'win32' ? [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ] : [
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/pw-browsers/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* next */ } }
  return '';
}

module.exports = { findBrowserExecutable };
