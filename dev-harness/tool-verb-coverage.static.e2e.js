#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 本件 require 产物 server.js 取原生工具表;直跑时家目录自隔离
// 128d(48 号文 §1):每个原生工具在工具卡上都有「人话动词」—— 手攒名单配机械锁。
//
// 由来:public/js/interaction-prompts.js 的 TOOL_VERB_MAP 当初是给【授权弹窗】写的,只收会弹窗的改/执行类工具;
// 简易档(出厂默认)的工具卡复用同一个 humanizeToolName,于是 file_read、web_search 这些最常见的读类工具原样
// 显示英文标识(simple-mode.browser S5 在真浏览器里逮到)。补齐之后不锁,下一个新工具照样漏。
// 判据:
//   ① 产物 server.js 的 TOOL_HANDLERS 里每一个名字,要么在 TOOL_VERB_MAP 里,要么命中 humanizeToolName 的某条前缀规则;
//   ② 名单与前缀规则引用到的每个 tools.verb.* 键,两份 locale 里都有、且非空;
//   ③ 扫描器没失明:原生工具 ≥ 90、名单条目 ≥ 50、前缀规则 ≥ 4(件数变了回来改下限)。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'ruyi-workbench', 'app');
let fail = 0;
const ok = (c, label) => { if (c) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const srv = require(path.join(APP, 'server.js'));
const tools = Object.keys(srv.TOOL_HANDLERS || {}).sort();

const src = fs.readFileSync(path.join(APP, 'public', 'js', 'interaction-prompts.js'), 'utf8');
const mapBlock = /const TOOL_VERB_MAP = \{([\s\S]*?)\n\};/.exec(src);
const fnBlock = /function humanizeToolName\(name\) \{([\s\S]*?)\n\}/.exec(src);
const map = new Map();
if (mapBlock) for (const m of mapBlock[1].matchAll(/\b([a-z0-9_]+): '(tools\.verb\.[a-z0-9_.]+)'/g)) map.set(m[1], m[2]);
const prefixes = [];
if (fnBlock) for (const m of fnBlock[1].matchAll(/n\.startsWith\('([a-z0-9_]+)'\)\) return t\('(tools\.verb\.[a-z0-9_.]+)'/g)) prefixes.push([m[1], m[2]]);

ok(tools.length >= 90, `③ 原生工具表扫得到(${tools.length} 个)`);
ok(map.size >= 50, `③ TOOL_VERB_MAP 扫得到(${map.size} 条)`);
ok(prefixes.length >= 4, `③ 前缀规则扫得到(${prefixes.length} 条:${prefixes.map(p => p[0]).join(' ')})`);

const uncovered = tools.filter(name => !map.has(name) && !prefixes.some(([p]) => name.startsWith(p)));
ok(uncovered.length === 0, `① 每个原生工具都有人话动词(没有的 ${uncovered.length} 个${uncovered.length ? ':' + uncovered.join(' ') : ''})`);
const stale = [...map.keys()].filter(name => !srv.TOOL_HANDLERS[name]);
if (stale.length) console.log(`NOTE 名单里有已不存在的原生工具名(无害,可顺手删):${stale.join(' ')}`);

const keys = new Set([...map.values(), ...prefixes.map(p => p[1]), 'tools.verb.unknown']);
for (const locale of ['zh-CN', 'en-US']) {
  const catalog = JSON.parse(fs.readFileSync(path.join(APP, 'public', 'locales', locale + '.json'), 'utf8'));
  const missing = [...keys].filter(k => typeof catalog[k] !== 'string' || !catalog[k].trim());
  ok(missing.length === 0, `② ${locale} 里 ${keys.size} 个动词键都有文案${missing.length ? '(缺 ' + missing.join(' ') + ')' : ''}`);
}

console.log(`TOOL VERB COVERAGE STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
