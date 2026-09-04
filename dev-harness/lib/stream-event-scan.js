#!/usr/bin/env node
// 112b: 回合流事件枚举扫描器 —— 服务端「发了什么」与两壳「认了什么」的机械对账真身。
//
// 为什么存在:第 112 波摸底发现服务端已经在发五十多种回合流事件,两壳却把其中二十种静默丢进
// `default: break`。靠人肉清单维护「哪些事件有人认领」在上一波已经证明会漂移(新事件加进引擎,
// 没人记得去补前端 case),所以这里把两侧都做成扫描出来的集合,由 progress-events.static.e2e.js
// 逐项对账:服务端有、前端两壳都没有、且没有登记豁免理由 => 红。
//
// 判定口径:
//   · 服务端侧 = src/*.js 里传给 onEvent / downstreamEvent / emit 的对象字面量的 type 值。
//     这三个名字是本仓库仅有的下行事件入口(downstreamEvent 是 onEvent 的直发别名,
//     emit 是 10-context-governance 里流式封装的本地名)。
//   · 剥注释复用 port-audit 的手写状态机(注释里提到的事件名不算发出)。
//   · 括号配平取实参文本,再取其中第一个 `type: '...'`;变量实参(onEvent(normalized))没有
//     字面量 type,跳过 —— 它转发的是别处已经登记过的事件。
//   · 前端侧 = `case 'x':`、`x.type === 'y'`、`[...].includes(x.type)` 三种写法的并集,
//     覆盖经典壳的 switch 与 Preview 壳的 if 链两种形状。
'use strict';
const fs = require('fs');
const path = require('path');
const { stripJsComments } = require('./port-audit');

const EMITTERS = Object.freeze(['onEvent', 'downstreamEvent', 'emit']);

// 从 `fn(` 的左括号后开始配平,返回实参文本。字符串态内的括号不计数。
function captureArgs(body, from) {
  let i = from;
  let depth = 1;
  let st = 'code'; // code | sq | dq | tpl
  while (i < body.length && depth > 0) {
    const c = body[i];
    if (st === 'code') {
      if (c === "'") st = 'sq';
      else if (c === '"') st = 'dq';
      else if (c === '`') st = 'tpl';
      else if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      i++;
      continue;
    }
    const term = st === 'sq' ? "'" : st === 'dq' ? '"' : '`';
    if (c === '\\') { i += 2; continue; }
    if (c === term) st = 'code';
    i++;
  }
  return { text: body.slice(from, Math.max(from, i - 1)), end: i };
}

function scanSourceEventTypes(srcDir) {
  const found = new Map(); // type -> [ 'file:line', ... ]
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.js')).sort();
  for (const file of files) {
    const body = stripJsComments(fs.readFileSync(path.join(srcDir, file), 'utf8'));
    const re = new RegExp('\\b(' + EMITTERS.join('|') + ')\\s*\\(', 'g');
    let m;
    while ((m = re.exec(body))) {
      const { text } = captureArgs(body, m.index + m[0].length);
      const hit = text.match(/\btype:\s*'([A-Za-z_][A-Za-z0-9_]*)'/);
      if (!hit) continue;
      const line = body.slice(0, m.index).split('\n').length;
      if (!found.has(hit[1])) found.set(hit[1], []);
      found.get(hit[1]).push(`${file}:${line}`);
    }
  }
  return found;
}

function scanShellHandledTypes(files) {
  const found = new Set();
  for (const file of files) {
    const body = stripJsComments(fs.readFileSync(file, 'utf8'));
    for (const m of body.matchAll(/case\s+'([A-Za-z_][A-Za-z0-9_]*)'\s*:/g)) found.add(m[1]);
    for (const m of body.matchAll(/\.type\s*===\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) found.add(m[1]);
    for (const m of body.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'\s*===\s*\w+\.type/g)) found.add(m[1]);
    for (const m of body.matchAll(/\[([^\]]*)\]\s*\.includes\(\s*\w+\.type\s*\)/g)) {
      for (const s of m[1].matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)) found.add(s[1]);
    }
  }
  return found;
}

module.exports = { EMITTERS, captureArgs, scanSourceEventTypes, scanShellHandledTypes };
