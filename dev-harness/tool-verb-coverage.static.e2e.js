#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 本件 require 产物 server.js 取原生工具表;直跑时家目录自隔离
// 128d(48 号文 §1):每个原生工具在工具卡上都有「人话动词」—— 手攒名单配机械锁。
//
// 由来:public/js/interaction-prompts.js 的 TOOL_VERB_MAP 当初是给【授权弹窗】写的,只收会弹窗的改/执行类工具;
// 简易档(出厂默认)的工具卡复用同一个 humanizeToolName,于是 file_read、web_search 这些最常见的读类工具原样
// 显示英文标识(simple-mode.browser S5 在真浏览器里逮到)。补齐之后不锁,下一个新工具照样漏。
// 判据:
//   ① 产物 server.js 的 TOOL_HANDLERS 里每一个名字,经真的 humanizeToolName 都落到某个 tools.verb.* 键
//      (名单或前缀规则命中都算;回落成原名 = 没有人话);
//   ② 这些键(外加桥接桌面工具的 tools.verb.desktop 与空名兜底的 tools.verb.unknown)两份 locale 里都有、且非空;
//   ③ 判据没失明:原生工具 ≥ 90;未知名字确实回落成原名、空名确实落到 tools.verb.unknown(① 的「没命中」判得出来)。
// 架构还债批 3·D:修前 ① 用 /const TOOL_VERB_MAP = \{([\s\S]*?)\n\};/ 与 humanizeToolName 函数体的正则把名单和
// 前缀规则从源码里抠出来重建一遍 —— 表拆成两张、前缀改成表驱动、换引号,锁就静默失明。现在直接 import 前端模块、
// 调工厂返回面上的 humanizeToolName:没加载语言包时 t(key) 返回 `[key]`,于是返回值本身就说出了落到哪个键。
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'ruyi-workbench', 'app');
let fail = 0;
const ok = (c, label) => { if (c) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const srv = require(path.join(APP, 'server.js'));
const tools = Object.keys(srv.TOOL_HANDLERS || {}).sort();

(async () => {
  if (!globalThis.window) globalThis.window = globalThis;   // state.js 顶层 `window.state = state`
  const warn = console.warn;
  console.warn = () => {};                                  // 未加载语言包时 t() 每个新键告警一次,这里正是要它回落
  const { createInteractionPromptsDomain } = await import(pathToFileURL(path.join(APP, 'public', 'js', 'interaction-prompts.js')).href);
  const { humanizeToolName } = createInteractionPromptsDomain({});
  const verbKey = name => (/^\[(tools\.verb\.[a-z0-9_.]+)\]$/.exec(String(humanizeToolName(name))) || [])[1] || '';

  ok(tools.length >= 90, `③ 原生工具表扫得到(${tools.length} 个)`);
  ok(humanizeToolName('zz_not_a_native_tool') === 'zz_not_a_native_tool', '③ 没有人话的名字原样回落(① 判得出「没命中」)');
  ok(verbKey('') === 'tools.verb.unknown', '③ 空名落到 tools.verb.unknown');

  const keyOf = new Map(tools.map(name => [name, verbKey(name)]));
  const uncovered = tools.filter(name => !keyOf.get(name));
  ok(uncovered.length === 0, `① 每个原生工具都有人话动词(没有的 ${uncovered.length} 个${uncovered.length ? ':' + uncovered.join(' ') : ''})`);

  // 桥接的桌面工具不在原生表里,但工具卡同样走这里(ai_computer_control__ 前缀规则);它的键一并对账。
  const desktopKey = verbKey('ai_computer_control__screenshot');
  ok(desktopKey === 'tools.verb.desktop', `③ 桥接桌面工具落到 tools.verb.desktop(got ${desktopKey || '原名'})`);
  const keys = new Set([...keyOf.values(), desktopKey].filter(Boolean).concat('tools.verb.unknown'));
  for (const locale of ['zh-CN', 'en-US']) {
    const catalog = JSON.parse(fs.readFileSync(path.join(APP, 'public', 'locales', locale + '.json'), 'utf8'));
    const missing = [...keys].filter(k => typeof catalog[k] !== 'string' || !catalog[k].trim());
    ok(missing.length === 0, `② ${locale} 里 ${keys.size} 个动词键都有文案${missing.length ? '(缺 ' + missing.join(' ') + ')' : ''}`);
  }
  console.warn = warn;

  console.log(`TOOL VERB COVERAGE STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.log('FAIL ' + (err && err.stack || err)); console.log('TOOL VERB COVERAGE STATIC E2E: FAIL (1)'); process.exit(1); });
