'use strict';
// 前端 i18n 的翻译函数叫 `t`。把局部变量也起名 `t`,在同一作用域里再调 `t('…')`,就是暂时性死区里的
// ReferenceError(2026-09 README 截图走查撞见两处:工作流编辑器节点检查器的五个下拉写成
// `for (const [v, t] of [['', t('…')], …])`,命令面板「存为模板」里 `const t = getTemplates()` 让同一函数前面的
// `t('…')` 落进死区;两处都只有源码字面量锁、从没真跑过,坏了两个月)。
// 行为由 workflow-editor-inspector.browser.e2e.js 在真浏览器里钉(两处都走一遍);本件只留一条能写准的结构判据:
//   [S1] public/js 与 app.js 里没有「for…of 解构出一个叫 t 的绑定」。
// 「函数里 const t = … 又调 t('…')」那一族没有语法树就判不准(零依赖、没有解析器),交给浏览器件的零异常断言。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.resolve(__dirname, '../../ruyi-workbench/app/public');
const FILES = [...fs.readdirSync(path.join(PUBLIC, 'js')).filter(f => f.endsWith('.js')).map(f => path.join('js', f)), 'app.js'];
const read = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const lineOf = (src, i) => src.slice(0, i).split('\n').length;

test('[S1] 没有 for…of 解构出名叫 t 的绑定', () => {
  const hits = [];
  for (const f of FILES) {
    const src = read(f);
    for (const m of src.matchAll(/for\s*\(\s*(?:const|let|var)\s*\[[^\]\n]*\bt\b[^\]\n]*\]\s+of\b/g)) hits.push(`${f}:${lineOf(src, m.index)}`);
  }
  assert.deepEqual(hits, []);
});
