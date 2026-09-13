#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js');
// 静态锁（122 波 §2.9 · 36 号文）：非独占层的 letter-spacing／text-transform:uppercase 归零。
//
// 现状（本波实测清点，见提交说明）：34 号文点名的八个非独占层里，letter-spacing／
// text-transform:uppercase 计 onboarding 1／tool-pane 9／layout 1／chat-live 6／ui-modes 1／
// workbench 1／workspace 3 = 22 处，逐条读过之后只有 3 处能写出理由（下面 ALLOWED 表），
// 其余 19 处已在本波删除。steward-*.css 与 chat-shell.css 是【独占层】（K8 已各自定案三处理由），
// 不在本锁扫描范围 —— 混进来只会把两批不同性质的债算成一批。
//
// 允许名单（逐条附理由，任何一条改动都会让下面的存在性断言先红）：
//   ① css/components/tool-pane.css `.tool-pane-head h2`             —— ≥17px 标题负字距（--fs-lg=17px）。
//   ② css/components/tool-pane.css `.ask-question-modal .modal-head h3` —— 同①，另一处 ≥17px 标题负字距。
//   ③ css/views/workbench.css      `.wb-node-title b`                —— 等宽代码（font-family: var(--mono)）。
//
// 判据两段：① 允许名单里每条規则原文必须原样存在（改字号/删负字距/换字体都会让这条先红，
// 不会被"反正后面零命中"那条掩盖）；② 把允许名单从文本里挖掉之后，八层里必须零 letter-spacing／
// text-transform:uppercase 残留。
//
// 反向验证：在 tool-pane.css 加回 `.ask-question-kicker { letter-spacing: .04em; }` → 第②段红；
// 把允许名单①的 -.015em 改成 -.02em → 第①段红（原文不再逐字匹配）。两处均已实测（见提交说明）。
const fs = require('fs');
const path = require('path');
const { PUBLIC } = require('./read-frontend-css.js');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// 非独占层清单（34 号文 §2.9；steward-*.css 与 chat-shell.css 是独占层，各有 K8 已定案的三处理由，
// 不在本锁扫描范围）。
const LAYERS = [
  'css/components/onboarding.css',
  'css/components/tool-pane.css',
  'css/components/chat-primitives.css',
  'css/views/workbench.css',
  'css/views/workspace.css',
  'css/layout.css',
  'css/states/chat-live.css',
  'css/themes/ui-modes.css',
];

const ALLOWED = [
  {
    file: 'css/components/tool-pane.css',
    pattern: /\.tool-pane-head h2\s*\{[^}]*letter-spacing:\s*-\.015em[^}]*\}/,
    reason: '≥17px 标题负字距（--fs-lg=17px）',
  },
  {
    file: 'css/components/tool-pane.css',
    pattern: /\.ask-question-modal \.modal-head h3\s*\{[^}]*letter-spacing:\s*-\.015em[^}]*\}/,
    reason: '≥17px 标题负字距（--fs-lg=17px）',
  },
  {
    file: 'css/views/workbench.css',
    pattern: /\.wb-node-title b\s*\{[^}]*font-family:\s*var\(--mono\)[^}]*letter-spacing:\s*-\.01em[^}]*\}/,
    reason: '等宽代码（font-family: var(--mono)）',
  },
];

const DEBT_LINE_RE = /^.*(?:letter-spacing\s*:|text-transform\s*:\s*uppercase).*$/gm;

for (const layer of LAYERS) {
  const file = path.join(PUBLIC, ...layer.split('/'));
  const src = fs.readFileSync(file, 'utf8');
  let remaining = src;
  for (const a of ALLOWED.filter(x => x.file === layer)) {
    const hits = remaining.match(new RegExp(a.pattern.source, 'g')) || [];
    ok(hits.length === 1, `允许名单原文存在且仅一次:${layer} —— ${a.reason}`);
    remaining = remaining.replace(a.pattern, '');
  }
  const debtLines = remaining.match(DEBT_LINE_RE) || [];
  ok(debtLines.length === 0,
    `${layer} 挖掉允许名单后零 letter-spacing／text-transform:uppercase 残留` +
    (debtLines.length ? `（实得 ${JSON.stringify(debtLines)}）` : ''));
}

// 反证:允许名单条数与「非独占层里 letter-spacing 或 uppercase 出现次数」的差,应等于本波删除的 19 处。
// 这里只钉允许名单总数(3),不重复上面按层的扫描 —— 避免同一件事两把锁分歧时无人知道哪把对。
ok(ALLOWED.length === 3, `允许名单总数 = 3（tool-pane×2 负字距标题 + workbench×1 等宽代码）`);

console.log('\nCSS TYPOGRAPHY DEBT STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
