#!/usr/bin/env node
// 端口唯一性审计(第36波)的真身模块 —— 第46波46a 从 run-all.js 抽出,供 runner 与 unit 测试同源 require。
// 此前 unit/port-audit.test.js 与 unit/strip-comments.test.js 测的是复制重实现的副本(E2 教训:
// 副本会随真身漂移而假绿)。本模块是唯一实现,测试与 runner 共用。
//
// 判定 = 代码体(剥注释、保留字符串)里 8700-9199 测试带的数字字面量:注释里的历史
// 提及不算占用,字符串里的 'http://127.0.0.1:PORT' 算(它真引用该端口)。
// 剥注释用手写状态机而非正则:字符串态(含转义)内的 // 与 /* 绝不误判;模板串整体视为字符串
// (端口字面量不会写在 ${} 里),合法 JS 不存在字符串外的裸 // 序列。
'use strict';
const fs = require('fs');
const path = require('path');

function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let st = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (st === 'code') {
      if (c === '/' && d === '/') { st = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { st = 'block'; i += 2; continue; }
      if (c === "'") { st = 'sq'; out += c; i++; continue; }
      if (c === '"') { st = 'dq'; out += c; i++; continue; }
      if (c === '`') { st = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (st === 'line') { if (c === '\n') { out += '\n'; st = 'code'; } i++; continue; }
    if (st === 'block') { if (c === '*' && d === '/') { st = 'code'; i += 2; continue; } if (c === '\n') out += '\n'; i++; continue; }
    const term = st === 'sq' ? "'" : st === 'dq' ? '"' : '`';
    if (c === '\\') { out += c + (d || ''); i += 2; continue; }
    out += c; i++;
    if (c === term) st = 'code';
  }
  return out;
}

const PORT_BAND = /\b(8[7-9]\d\d|9[01]\d\d)\b/g;

function portAuditFromDir(dir) {
  const claims = new Map(); // port -> Set<file>
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.e2e.js'))) {
    const body = stripJsComments(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const m of body.matchAll(PORT_BAND)) {
      if (!claims.has(m[1])) claims.set(m[1], new Set());
      claims.get(m[1]).add(f);
    }
  }
  const collisions = [...claims.entries()].filter(([, set]) => set.size > 1)
    .map(([p, set]) => `${p} <- ${[...set].join(', ')}`);
  return { count: claims.size, collisions };
}

module.exports = { stripJsComments, PORT_BAND, portAuditFromDir };
