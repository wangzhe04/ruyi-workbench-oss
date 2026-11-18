'use strict';

// 150 号文 U13：新建记忆不再默认加入核心记忆。
//
// 修前编辑弹窗在条目没有 core 字段时按类型自动勾选（preference / convention 即勾），而类型下拉默认第一项
// 就是 preference，于是每条新建记忆都默认进了每轮基础提示词；用户确认这不是有意设计。
// 现在只有带明确 core:true 的条目（已有记忆、带 core 的草稿或提案）才勾选，改类型也不再联动。
// openMemoryEditModal 是 DOM 模块里的内部函数，运行时拿不到，所以切出核心勾选那一段，配假的 el/t 执行它的行为。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { bracedBlock, functionBlock, sliceBlock } = require('../lib/source-slice');

const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/skills-memory.js'), 'utf8');
const modal = functionBlock(source, 'openMemoryEditModal');
// 切到核心摘要字段之前：勾选初值与任何类型联动（typeSel.onchange）都落在这一段里。
const fragment = sliceBlock(modal, "const corePanel = el('div', 'memory-edit-core');", 'const coreSummaryEl');

test('the core checkbox fragment is present in the memory edit modal', () => {
  assert.ok(modal.length > 1000, 'openMemoryEditModal not found');
  assert.ok(fragment.includes("coreCheck.type = 'checkbox'"), 'core checkbox fragment not found');
});

function openWith(full, type) {
  const el = (tag, className = '', text = '') => ({ tag, className, text, type: '', checked: false, children: [],
    append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); } });
  const typeSel = { value: type, onchange: null };
  const body = el('div', 'pb-form');
  return vm.runInNewContext(fragment + '\n;({ coreCheck, typeSel });', { el, t: key => key, full, typeSel, body });
}

test('new memories are not added to core memory by default, whatever the type', () => {
  for (const type of ['preference', 'convention', 'lesson', 'reference']) {
    assert.equal(openWith(null, type).coreCheck.checked, false, type);
    assert.equal(openWith({ _isDraft: true, type, name: 'x' }, type).coreCheck.checked, false, 'draft without core: ' + type);
  }
});

test('an explicit core choice is kept as is', () => {
  assert.equal(openWith({ _isDraft: true, type: 'lesson', core: true }, 'lesson').coreCheck.checked, true);
  assert.equal(openWith({ id: 'm1', type: 'preference', core: false }, 'preference').coreCheck.checked, false);
  assert.equal(openWith({ id: 'm2', type: 'reference', core: true }, 'reference').coreCheck.checked, true);
});

test('changing the type after opening does not tick the core checkbox', () => {
  const { coreCheck, typeSel } = openWith(null, 'lesson');
  typeSel.value = 'preference';
  if (typeof typeSel.onchange === 'function') typeSel.onchange();
  assert.equal(coreCheck.checked, false);
});

// 上一条只执行到核心摘要字段之前；类型联动若被加在弹窗更后面也要拦住：整个函数体里任何类型变化处理器都不许碰核心勾选。
test('no type-change handler anywhere in the modal touches the core checkbox', () => {
  for (const match of modal.matchAll(/typeSel\s*\.\s*(?:onchange\s*=|addEventListener\s*\(\s*['"]change['"])/g)) {
    const tail = modal.slice(match.index, match.index + 800);
    const brace = tail.indexOf('{'), semicolon = tail.indexOf(';');
    const handler = brace >= 0 && (semicolon < 0 || brace < semicolon) ? bracedBlock(tail, '{') : tail.slice(0, semicolon + 1);
    assert.ok(handler.length > 0, 'type-change handler could not be sliced');
    assert.ok(!/coreCheck/.test(handler), 'type-change handler touches coreCheck: ' + handler.slice(0, 160));
  }
});
