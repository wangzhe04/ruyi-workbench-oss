'use strict';

const fs = require('fs');

// 浏览器探测:Edge(Win 必装) -> Chrome -> 明确 FAIL(不静默跳过,沉默的跳过 = 假绿)。
function findBrowserExecutable() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* next */ } }
  return '';
}

module.exports = { findBrowserExecutable };
