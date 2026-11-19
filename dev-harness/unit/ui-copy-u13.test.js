'use strict';
// 150 号文 U13 里 4C 落地的两条(其余几条的归属见 4C 交付报告):
//   ① 「对话已用 1%」回落 0%：估算帧爬到 0.5% 显示 1%，真实用量帧一到又四舍五入成 0% —— 有用量就至少写「<1%」。
//   ② 吸顶条遮挡：设置页段内锚点条吸顶，点 chip 用 scrollIntoView(block:'start') 会把目标段标题滚到它底下 ——
//      滚之前按锚点条此刻的高度给目标留 scroll-margin-top。
// 两段都是 DOM 模块里的内部代码，Node 里 import 不了：切出来(source-slice)在 vm 里跑它们的行为。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { functionBlock, sliceBlock } = require('../lib/source-slice');

const repo = path.resolve(__dirname, '../..');
const render = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/js/chat-render-primitives.js'), 'utf8');
const nav = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/js/navigation-controls.js'), 'utf8');

test('context meter never reads 0% once there is usage', () => {
  const line = sliceBlock(render, 'const pctText =', ';');
  const pctText = p => vm.runInNewContext(line + '\n;pctText', { p });
  assert.equal(pctText(0), '0', 'no usage at all is still 0');
  assert.equal(pctText(0.001), '<1');
  assert.equal(pctText(0.0049), '<1');
  assert.equal(pctText(0.006), '1');
  assert.equal(pctText(0.5), '50');
  const paint = sliceBlock(render, 'const paint = shownN => {', '};');
  assert.ok(paint.includes("t('ctx.plain.used', { pct: pctText === '<1' ? pctText : Math.min(100, Number(pctText)) })"), 'plain mode uses it');
  assert.ok(paint.includes('· ${pctText}%'), 'detailed mode uses it');
});

test('a settings jump chip leaves room for the sticky jump bar', () => {
  const fn = functionBlock(nav, 'buildSettingsJumpList');
  const make = tag => ({ tag, children: [], style: {}, listeners: {}, className: '', textContent: '', type: '',
    appendChild(c) { this.children.push(c); }, addEventListener(type, cb) { this.listeners[type] = cb; },
    getBoundingClientRect() { return { height: this.tag === 'nav' ? 61.4 : 20 }; } });
  const targets = [0, 1, 2].map(i => ({ id: 'sec' + i, style: {}, scrolled: null, scrollIntoView(opts) { this.scrolled = { opts, margin: this.style.scrollMarginTop }; } }));
  let inserted = null;
  const panel = { querySelector: () => null, querySelectorAll: () => targets, insertBefore(node) { inserted = node; }, firstChild: null };
  const document = { getElementById: id => (id === 'stab-x' ? panel : targets.find(t => t.id === id) || null), createElement: make };
  vm.runInNewContext(fn + '\n;buildSettingsJumpList("stab-x")', {
    document, SETTINGS_JUMP_PANELS: { 'stab-x': 'section' }, jumpTargetLabel: node => 'label ' + node.id, matchMedia: () => ({ matches: false }),
  });
  assert.ok(inserted && inserted.children.length === 3, 'jump bar built');
  inserted.children[2].listeners.click();
  assert.equal(targets[2].scrolled && targets[2].scrolled.margin, '70px', 'scroll-margin-top = bar height (61.4 → 62) + 8 before scrolling');
  assert.equal(targets[2].scrolled.opts.block, 'start');
});
