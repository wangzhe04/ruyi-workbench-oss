'use strict';
// 150 号文 U7：记忆面板的搜索只做字面匹配 —— 范围就是卡片上看得见的字(名称、说明、核心摘要、类型与范围的显示名)，
// 并在搜索框下如实写明「按字面、不按意思」与找到几条。修前把内部 id、类型/范围的内部代号也拼进去，搜「mem」「pref」
// 会命中一批卡片上根本看不到这几个字母的记忆；没有匹配时只有一句「没有匹配的记忆」，分不清是真没有还是要换说法。
// skills-memory.js 是带 DOM 依赖的模块，Node 里 import 不了：切出两个纯函数(source-slice)在 vm 里跑它们的行为。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { functionBlock, sliceBlock } = require('../lib/source-slice');

const repo = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/js/skills-memory.js'), 'utf8');
const html = fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/index.html'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/locales/zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(repo, 'ruyi-workbench/app/public/locales/en-US.json'), 'utf8'));

const helpers = functionBlock(source, 'memoryToolboxFold') + '\n' + functionBlock(source, 'memoryToolboxSearchText').replace(/^export\s+/, '');
const searchText = vm.runInNewContext(helpers + '\n;memoryToolboxSearchText');
const matches = (m, q, labels) => searchText(m, labels).includes(String(q).normalize('NFKC').toLowerCase());

const MEMORY = { id: 'mem_8f3a2c', name: '提交说明怎么写', description: '用祈使句,首行不超过 50 字', type: 'preference', scope: 'global', coreSummary: '提交信息首行要短' };
const CORE = { ...MEMORY, core: true };
const LABELS = { type: '偏好', scope: '全局' };

test('the panel search matches exactly what the card shows', () => {
  assert.ok(matches(MEMORY, '提交说明', LABELS), 'title (name)');
  assert.ok(matches(MEMORY, '祈使句', LABELS), 'a non-core card shows its description');
  assert.equal(matches(MEMORY, '首行要短', LABELS), false, 'a non-core card does not show the core summary');
  assert.ok(matches(CORE, '首行要短', LABELS), 'a core card shows its core summary');
  assert.equal(matches(CORE, '祈使句', LABELS), false, 'a core card with a summary hides its description');
  assert.ok(matches(MEMORY, '偏好', LABELS), 'localized type label');
  assert.ok(matches(MEMORY, '全局', LABELS), 'localized scope label');
  assert.ok(matches({ id: 'mem_untitled_7', description: 'x' }, 'mem_untitled', {}), 'a card without a name shows its id as the title');
  assert.ok(matches({ name: 'Ｄｅｐｌｏｙ ｎｏｔｅｓ' }, 'deploy', {}), 'NFKC + case folding still applies');
});

test('internal ids and raw codes the card does not show no longer match', () => {
  assert.equal(matches(MEMORY, 'mem_8f3a', LABELS), false, 'internal id of a named memory');
  assert.equal(matches(MEMORY, 'preference', LABELS), false, 'raw type code');
  assert.equal(matches(MEMORY, 'global', LABELS), false, 'raw scope code');
});

test('the card and the search read the same fields', () => {
  const card = functionBlock(source, 'buildMemoryToolboxCard');
  assert.ok(card.includes("el('h4', '', m.name || m.id)"), 'card title = name || id');
  assert.ok(card.includes('const summary = m.core && m.coreSummary ? m.coreSummary : m.description;'), 'card summary rule');
  assert.ok(helpers.includes('const title = item.name || item.id;'));
  assert.ok(helpers.includes('const summary = item.core && item.coreSummary ? item.coreSummary : item.description;'));
});
test('the scope note is wired and says the search is literal, in both languages', () => {
  assert.match(html, /<p id="memoryToolboxSearchNote"[^>]*role="status"[^>]*hidden>/, 'note element present, hidden until a query is typed');
  const render = functionBlock(source, 'renderMemoryToolbox');
  const noteWiring = sliceBlock(render, "const scopeNote = $('memoryToolboxSearchNote');", "const statusOrder");
  assert.ok(noteWiring.includes("t('memory.toolbox.searchScope', { count: items.length })"), 'note shows the match count');
  assert.ok(render.includes("t(query ? 'memory.toolbox.searchEmptyHint' : 'memory.toolbox.emptyHint')"), 'empty state explains literal search when a query is typed');
  for (const key of ['memory.toolbox.searchScope', 'memory.toolbox.searchEmptyHint']) {
    assert.equal(typeof zh[key], 'string', key);
    assert.equal(typeof en[key], 'string', key);
  }
  assert.match(zh['memory.toolbox.searchScope'], /字面/);
  assert.match(zh['memory.toolbox.searchScope'], /卡片上显示的名称、说明、类型和范围/);
  assert.match(zh['memory.toolbox.searchScope'], /\{\{count\}\}/);
  assert.match(en['memory.toolbox.searchScope'], /not by meaning/);
});
