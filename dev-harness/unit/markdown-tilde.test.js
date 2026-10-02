'use strict';
// 2026-10(用户实报截图:管家回复「单核快 20%~25%，多核快 10%~15%」中间一大段被画成删除线)。
// marked 的 GFM 删除线认单个 `~`;中文里 `~` 是写区间的记号,一句里两个区间就把中间全划掉。
// public/js/chat-render-primitives.js 的 createMarkdownParser 只认成对的 `~~双波浪~~`。
// 判据跑的是真 vendor marked(UMD,可直接 require)+ 真模块导出的工厂,不读源码。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const PUBLIC = path.resolve(__dirname, '../../ruyi-workbench/app/public');
const markedLib = require(path.join(PUBLIC, 'vendor', 'marked.min.js'));

async function parser() {
  const { createMarkdownParser } = await import(pathToFileURL(path.join(PUBLIC, 'js', 'chat-render-primitives.js')).href);
  const p = createMarkdownParser(markedLib);
  assert.ok(p, '用 vendor marked 建得出解析器');
  return p;
}

test('单个 ~ 是区间记号,不是删除线(截图原句)', async () => {
  const p = await parser();
  const html = p.parse('· 3800X→5800X：单核快 20%~25%，多核快 10%~15%，游戏高 15%~25%。');
  assert.ok(!html.includes('<del>'), html);
  assert.ok(html.includes('20%~25%') && html.includes('10%~15%') && html.includes('15%~25%'), html);
  assert.ok(!p.parse('约 ~3 秒,~5 秒也行').includes('<del>'));
});

test('成对 ~~双波浪~~ 仍是删除线;落单的 ~~ 原样当字', async () => {
  const p = await parser();
  assert.match(p.parse('旧 ~~划掉~~ 新'), /<del>划掉<\/del>/);
  assert.match(p.parse('~~**粗**~~'), /<del><strong>粗<\/strong><\/del>/);
  assert.ok(!p.parse('a ~~ b').includes('<del>'));
});

test('其余 GFM 与换行口径不变(gfm + breaks)', async () => {
  const p = await parser();
  assert.match(p.parse('第一行\n第二行'), /第一行<br>第二行/);
  assert.match(p.parse('| a | b |\n|---|---|\n| 1 | 2 |'), /<table>/);
  assert.match(p.parse('**粗~体**'), /<strong>粗~体<\/strong>/);
});

test('建不出来时返回 null(调用方回落全局 marked.parse)', async () => {
  const { createMarkdownParser } = await import(pathToFileURL(path.join(PUBLIC, 'js', 'chat-render-primitives.js')).href);
  assert.equal(createMarkdownParser(null), null);
  assert.equal(createMarkdownParser({}), null);
});
