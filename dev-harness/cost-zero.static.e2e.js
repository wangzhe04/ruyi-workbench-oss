#!/usr/bin/env node
'use strict';

// 121 波 K6a 静态契约（34 号文 §7.2「费用规则」／§13.7 K5 登记②）：管家视角与工作台线程头
// 「不印金额」这条红线，锁在这一件 K6a 实际接触过、能保证干净的文件上：
//   index.html（提醒设置块、安静卡挂点两处新增，右栏「用量」页签保持唯一入口）、
//   js/quiet-card.js（新）、js/thread-head.js、js/notify-policy.js、js/model-menu.js。
//
// 判据：`¥`／`$` 后跟数字／「费用」／独立词 `cost`（不区分大小写）四类字面量，在这五个文件里
// 只允许两类白名单命中——① 注释里描述规则本身的话（「不印费用」这类，不是显示文本）；
// ② index.html 里【设置弹窗】的货币单位选择器（`settings.currency.*`，选的是「用哪种货币显示
// 估算成本」这件全局配置，不是「管家视角印了多少钱」）与「用量」页签自己（唯一允许印钱的地方）。
// 命中行不在白名单 = 红。
//
// 范围说明（诚实记账，不是回避）：34 号文 §7.2 的锁名义范围是「public/ 模板与 steward-*.js／
// thread-head.js／quiet-card.js」，但 `js/steward-drawer.js`（`stewardCostText`／
// `#stewardDrawerMissionCost` 那一枚事项行费用/预算 pill）、`js/steward-board.js`、
// `js/steward-settings.js`（行动流水表的 cost 列）三个文件是本波派单表里明确的「绝不碰」——
// K6b 正在把 steward-drawer.js 改造成焦点栏（§2.6），那一枚费用 pill 按 §2.6 的焦点卡元信息
// 行设计（「来源图形 · 相对时间 · 只在定过时印权限」，没有费用）本就该在那一刀删掉。把它们
// 现在也塞进这把锁只会交出一把提交时就是红的锁——所以本文件【不扫】那三个文件，改为在下面
// 显式登记这笔债，与主会话的登记单对齐（见交付报告「登记给 K6b」一节）。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

// 四类字面量之一命中即算「印钱」候选行。
const MONEY_RE = /¥|\$[0-9]|费用|(?<![A-Za-z])cost(?![A-Za-z])/i;

// 白名单：命中行里只要包含以下任一子串，就判定为「不是真的在印钱」，允许存活。
const ALLOW_SUBSTRINGS = [
  '不印',              // 注释：说明「这里不印费用/金额」
  '不带金额',
  '不落',
  '退役',              // 注释里回顾已退役/待退役的费用展示（如「返回带里的费用已退役」一类话）
  '归 K',              // 注释：记债/登记给别的刀（「归 K6/K7/K8」）
  '登记',              // 注释：登记未做/登记债务
  'settings.currency', // 设置弹窗：全局「用哪种货币估算」选择器，不是费用展示
  '验收 a/b、费用／预算', // index.html 里事项行的【注释】，标的是 K6b 焦点栏要删的那一枚 pill（见头注）
];

function scanFile(relativePath, content) {
  const hits = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (!MONEY_RE.test(line)) return;
    if (ALLOW_SUBSTRINGS.some(allowed => line.includes(allowed))) return;
    hits.push({ line: idx + 1, text: line.trim().slice(0, 160) });
  });
  return hits;
}

// index.html：额外整段挖掉「用量」页签本体（tab-usage），唯一允许印钱的地方,不必逐行过白名单。
function indexHtmlWithoutUsageTab(html) {
  const startTag = '<section class="tool-section" id="tab-usage">';
  const start = html.indexOf(startTag);
  if (start < 0) return html; // 找不到就不挖，退化成全文扫描（更严格，不会漏判）
  const closeTag = '</section>';
  const close = html.indexOf(closeTag, start);
  if (close < 0) return html;
  return html.slice(0, start) + html.slice(close + closeTag.length);
}

const FILES = [
  ['index.html', indexHtmlWithoutUsageTab(read('index.html'))],
  ['js/quiet-card.js', read('js/quiet-card.js')],
  ['js/thread-head.js', read('js/thread-head.js')],
  ['js/notify-policy.js', read('js/notify-policy.js')],
  ['js/model-menu.js', read('js/model-menu.js')],
];

let totalHits = 0;
for (const [name, content] of FILES) {
  const hits = scanFile(name, content);
  totalHits += hits.length;
  ok(hits.length === 0,
    `A ${name} 零白名单外命中` + (hits.length ? `（实测 ${hits.length} 处：${hits.map(h => `L${h.line} "${h.text}"`).join(' | ')}）` : ''));
}
ok(totalHits === 0, `B 五个文件合计零白名单外命中（费用只在「用量」页签，管家视角/工作台线程头不印金额）`);

// 反向验证的判据本身要能被拉红：往其中一个文件塞一句真的印钱的话，正则必须逮到、且不在白名单里。
const poison = '本条待决预计花费 ¥12.50，请确认';
ok(MONEY_RE.test(poison) && !ALLOW_SUBSTRINGS.some(a => poison.includes(a)),
  'C 判据本身可拉红（毒丸句命中正则且不落在白名单里，用于反向验证：临时把它塞进 thread-head.js 应转红，见交付报告）');

// 「用量」页签本身仍然存在且是唯一常驻的费用入口（挖空之后原文件里应该还有这一段，只是不在扫描范围内）。
const fullHtml = read('index.html');
ok(fullHtml.includes('<section class="tool-section" id="tab-usage">') && fullHtml.includes('用量与成本'),
  'D 「用量」页签仍在（唯一允许印钱的地方没有被这把锁误伤到）');

console.log(fail === 0 ? `ALL PASS (${FILES.length + 2} checks)` : `FAIL x${fail}`);
process.exit(fail === 0 ? 0 : 1);
