#!/usr/bin/env node
'use strict';

// W7(用户 2026-09-24「如果是如意自己开的工作区,默认不显示在常用工作区中,不要让用户自己感知到」):
// public/js/util.js 里「常用工作区该显示哪几行」的两个纯函数。顶栏选择器的弹层与文件页的快捷条都经
// workspace-preferences.js 的 favoriteList() 读它们;保存仍用整张表(那一半按源码钉,见本文件 ④)。
//
// 钉住的事:
//   ① 数据目录里的路径一律不显示(管家会话自己的目录、子代理临时工作树都在那儿)—— 前缀按整段比;
//   ② 如意为任务开的、用户没收编(adopted !== true)的目录不显示;收编过的照常显示(以用户为准);
//   ③ 用户自己的工作区一行不少、顺序不变;分隔符两种写法、大小写都认;
//   ④ workspace-preferences.js 只在【显示】时过滤,调整优先级时存的是整张表(不把藏起来的行删掉)。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUBLIC_JS = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js');
let modulePromise;
const load = () => (modulePromise ||= import(pathToFileURL(path.join(PUBLIC_JS, 'util.js')).href));

const DATA_ROOT = 'C:\\Users\\u\\.win-claude-workbench';
const OWNED = [
  { path: 'C:\\Users\\u\\Ruyi\\下周A股走势分析', at: '' },
  { path: 'C:\\Users\\u\\Ruyi\\英伟达分析', at: '', adopted: true },
];

describe('isRuyiOwnedWorkspace', () => {
  it('① 数据目录本身与其下任何目录都算如意的;前缀按整段比', async () => {
    const { isRuyiOwnedWorkspace } = await load();
    const ctx = { dataRoot: DATA_ROOT, owned: [] };
    assert.equal(isRuyiOwnedWorkspace(DATA_ROOT, ctx), true);
    assert.equal(isRuyiOwnedWorkspace(DATA_ROOT + '\\agent-worktrees\\run_1', ctx), true);
    assert.equal(isRuyiOwnedWorkspace('c:/users/u/.win-claude-workbench/tmp/', ctx), true, '正斜杠 + 小写 + 尾斜杠同样认');
    assert.equal(isRuyiOwnedWorkspace(DATA_ROOT + '-backup', ctx), false, '同前缀的兄弟目录不算(整段比,不是字符串前缀)');
  });
  it('② 如意开的、没收编的算;收编过的不算', async () => {
    const { isRuyiOwnedWorkspace } = await load();
    const ctx = { dataRoot: DATA_ROOT, owned: OWNED };
    assert.equal(isRuyiOwnedWorkspace('C:/Users/u/Ruyi/下周A股走势分析/', ctx), true);
    assert.equal(isRuyiOwnedWorkspace('C:\\Users\\u\\Ruyi\\英伟达分析', ctx), false, '用户亲手加回常用的,以用户为准');
    assert.equal(isRuyiOwnedWorkspace('C:\\Users\\u\\Ruyi', ctx), false, '如意根本身不在表里,不猜');
  });
  it('③ 空值与缺参不炸', async () => {
    const { isRuyiOwnedWorkspace } = await load();
    assert.equal(isRuyiOwnedWorkspace('', {}), false);
    assert.equal(isRuyiOwnedWorkspace(null), false);
    assert.equal(isRuyiOwnedWorkspace('D:\\work', { owned: null }), false);
  });
});

describe('visibleFavoriteWorkspaces', () => {
  it('③ 用户的工作区一行不少、顺序不变;如意的与数据目录里的去掉', async () => {
    const { visibleFavoriteWorkspaces } = await load();
    const rows = [
      { path: 'C:\\Users\\u' },
      { path: 'C:\\Users\\u\\Ruyi\\下周A股走势分析' },
      { path: 'E:\\Claude\\ruyi-workbench-oss' },
      { path: DATA_ROOT },
      { path: 'C:\\Users\\u\\Ruyi\\英伟达分析' },
      { path: '' },
    ];
    const shown = visibleFavoriteWorkspaces(rows, { dataRoot: DATA_ROOT, owned: OWNED }).map(r => r.path);
    assert.deepEqual(shown, ['C:\\Users\\u', 'E:\\Claude\\ruyi-workbench-oss', 'C:\\Users\\u\\Ruyi\\英伟达分析']);
    // 返回的是原对象(不是拷贝):调用方拿它去原表里找位置交换。
    assert.equal(visibleFavoriteWorkspaces(rows, { dataRoot: DATA_ROOT, owned: OWNED })[0], rows[0]);
  });
  it('没有如意痕迹时原样返回', async () => {
    const { visibleFavoriteWorkspaces } = await load();
    const rows = [{ path: 'D:\\a' }, { path: 'D:\\b' }];
    assert.deepEqual(visibleFavoriteWorkspaces(rows, { dataRoot: '', owned: [] }), rows);
    assert.deepEqual(visibleFavoriteWorkspaces(null, {}), []);
  });
});

describe('workspace-preferences 接线(源码)', () => {
  const src = fs.readFileSync(path.join(PUBLIC_JS, 'workspace-preferences.js'), 'utf8');
  const bodyOf = name => {
    const start = src.indexOf(`function ${name}(`);
    const end = src.indexOf('\n}\n', start);
    return start < 0 ? '' : src.slice(start, end < 0 ? undefined : end);
  };
  it('④ 显示走过滤(favoriteList),保存走整张表(allFavorites)', () => {
    assert.match(bodyOf('favoriteList'), /visibleFavoriteWorkspaces\(allFavorites\(\)/);
    assert.match(bodyOf('favoriteList'), /state\.status && state\.status\.dataRoot/);
    assert.match(bodyOf('favoriteList'), /state\.config\.stewardManagedWorkspaces/);
    // 调整优先级:下标来自显示列表,落到整张表上交换位置后存整张表。
    assert.match(bodyOf('reorderFavorite'), /const ws = allFavorites\(\);/);
    assert.match(bodyOf('reorderFavorite'), /persistWorkspaces\(ws, /);
    assert.match(bodyOf('promoteFavorite'), /const ws = allFavorites\(\);/);
    // 两个显示面(弹层列表、文件页快捷条)都经 favoriteList。
    assert.match(bodyOf('renderWorkspaceFavChips'), /const ws = favoriteList\(\);/);
    assert.match(src, /const refresh = \(\) => \{\s*\n\s*const ws = favoriteList\(\);/);
  });
});
