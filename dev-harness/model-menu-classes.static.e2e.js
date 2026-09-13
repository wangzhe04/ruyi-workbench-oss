#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js');
// 静态锁（37 号文 §3.7·123-M3）：public/js/model-menu.js 的 MODEL_MENU_CLASSES 表里，
// 不许再混入「造出来但没有一条 CSS 规则认」的死字符串。
//
// 现状（本波实测清点，见提交说明）：这张表原是 2.0 独立模型弹层的类名族，那族 CSS
// （.mc-pop／.mc-group*／.mc-row*／.mc-switch-note／.mc-sep）已被 K8 整段删除（34 号文 §13.13），
// 但表本身没跟着清——`grep -rn "mc-" public/css public/js` 核过：root/group/groupDot/groupLabel/
// groupCount/groupSwitchNote/groupDetails/groupSummary/row/rowDisabled/rowAction/check/label/
// badge/hint/separator 这 16 个键的字面量，除了表定义那一行，仓内零命中；已删。表里只留两条
// 仍有真实消费的：rowActive（'active'，全仓通用状态类，见下方形状断言）与 del（'mc-del'，
// chat-shell.css 267/269 行还在渲染自定义模型行尾那枚 ×）。
//
// 判据：动态 import 真模块（不读字符串、不猜表长什么样），把 MODEL_MENU_CLASSES 的每一条值
// （空格拆开支持 groupSummary 那种「一个键两个类名」的写法，虽然这类键本波已经不存在了）逐个
// 拿去核：CSS 全量文本（read-frontend-css.js 的 readFrontendCss，覆盖全部载荷层）里必须能找到
// 一条 `.<class>` 选择器（用「点号 + 类名 + 非字母数字/连字符边界」防止 .active 误命中
// .activeSomething 之类的前缀共享）。
//
// 反向验证：不改源码，直接在测试里把加载到的表复制一份、塞进一个查无 CSS 的假类名
// （mc-nonexistent-guard-check），拿同一条判据函数去核这份假表——必须给红；再核原表本身必须全绿。
// 这样「反向必须真红」在每次跑这把锁的时候都会被验一遍，不是写完就再也没人跑过的一次性动作。
const path = require('path');
const url = require('url');
const { readFrontendCss } = require('./read-frontend-css.js');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const MODEL_MENU_JS = path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'js', 'model-menu.js');

function classHasCssRule(cssText, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\.' + escaped + '(?![\\w-])');
  return re.test(cssText);
}

// 每个键的值都可能是「一个键塞两个类名」（空格分隔），全部拆开逐条核——即便本波清完之后
// 表里已经没有这种写法了，判据函数本身不应该假设「以后也不会有」。
function everyClassHasCssRule(classesTable, cssText) {
  const missing = [];
  for (const key of Object.keys(classesTable)) {
    const value = classesTable[key];
    if (typeof value !== 'string' || !value) continue;
    for (const cls of value.split(/\s+/).filter(Boolean)) {
      if (!classHasCssRule(cssText, cls)) missing.push(`${key}=${cls}`);
    }
  }
  return missing;
}

async function main() {
  const mod = await import(url.pathToFileURL(MODEL_MENU_JS).href);
  const classesTable = mod.MODEL_MENU_CLASSES;
  ok(classesTable && typeof classesTable === 'object', 'MODEL_MENU_CLASSES 真的从模块里导出了一个对象');

  const cssText = readFrontendCss();

  // ① 正面：真表里每一个类名都能在 CSS 全量文本里找到一条规则。
  const missingReal = everyClassHasCssRule(classesTable, cssText);
  ok(missingReal.length === 0,
    'MODEL_MENU_CLASSES 表里每个类名都在 CSS 里有规则' +
    (missingReal.length ? `（实得缺失 ${JSON.stringify(missingReal)}）` : ''));

  // ② 形状断言：本波清理后只应剩这两条键，人肉核对「没有清多了也没有清少了」。
  const keys = Object.keys(classesTable).sort();
  ok(JSON.stringify(keys) === JSON.stringify(['del', 'rowActive']),
    `表只剩 del／rowActive 两条键（实得 ${JSON.stringify(keys)}）`);
  ok(classesTable.rowActive === 'active', `rowActive 原样是 'active'（实得 ${classesTable.rowActive}）`);
  ok(classesTable.del === 'mc-del', `del 原样是 'mc-del'（实得 ${classesTable.del}）`);

  // ③ 反向：往同一份判据函数里喂一张「多一个查无 CSS 的假类名」的表，必须给红——
  // 证明①不是画上去的门（32 号文 §4 纪律 5）。喂完之后原表自己再核一遍，确认没有被污染。
  const poisoned = { ...classesTable, guard: 'mc-nonexistent-guard-check' };
  const missingPoisoned = everyClassHasCssRule(poisoned, cssText);
  ok(missingPoisoned.length === 1 && missingPoisoned[0] === 'guard=mc-nonexistent-guard-check',
    `反向：塞一个查无 CSS 的假类名 → 判据函数真的报缺失（实得 ${JSON.stringify(missingPoisoned)}）`);
  const missingRealAgain = everyClassHasCssRule(classesTable, cssText);
  ok(missingRealAgain.length === 0, '反向验证之后原表自己再核一遍仍然零缺失（没有被污染）');

  console.log('\nMODEL MENU CLASSES STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
}

main().catch(err => {
  console.error('MODEL MENU CLASSES STATIC E2E: ERROR', err && err.stack || err);
  process.exit(1);
});
