// Unit(2026-10 工具走查·第二轮 · 文件工具组):几个纯函数的快通道锁。运行时行为由 dev-harness/tool-audit-r2-files.e2e.js 钉着;
// 这里钉的是只靠字符串/路径运算、不碰盘的判据 —— 其中 fileMoveSameFileKind 的 win32 / darwin 分支在 Linux CI 上无法实机跑,
// 只能在这里用注入的 platform 与 stat 字段把「大小写改名」的判据钉住(Windows 实机行为未验证)。
//
// 这些函数没有导出(14-main 的导出面有只减不增的锁),按 CLAUDE.md 的做法用 source-slice 从源码切出来单独求值。
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const { functionBlock } = require('../lib/source-slice');

const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const sliceFn = (file, name, ...deps) => new Function(...deps.map(d => d[0]), functionBlock(read(file), name) + `; return ${name};`)(...deps.map(d => d[1]));

describe('fileMoveSameFileKind', () => {
  const same = sliceFn('12-tool-dispatch.js', 'fileMoveSameFileKind');
  const a = { dev: 1, ino: 5 }, b = { dev: 1, ino: 6 };
  it('逐字相同 → identical;目标不存在 → null', () => {
    assert.equal(same('/w/a', '/w/a', a, a, 'linux'), 'identical');
    assert.equal(same('/w/a', '/w/b', a, null, 'linux'), null);
  });
  it('win32 / darwin:同 dev+ino 且仅大小写不同 → case-only', () => {
    assert.equal(same('C:\\w\\data.csv', 'C:\\w\\DATA.csv', a, a, 'win32'), 'case-only');
    assert.equal(same('/w/data.csv', '/w/DATA.csv', a, a, 'darwin'), 'case-only');
  });
  it('ino 不同 = 两个文件;linux 上大小写不同的同 ino 只可能是硬链接 → 都不是改名', () => {
    assert.equal(same('C:\\w\\data.csv', 'C:\\w\\DATA.csv', a, b, 'win32'), null);
    assert.equal(same('/w/data.csv', '/w/DATA.csv', a, a, 'linux'), null);
    assert.equal(same('C:\\w\\a.csv', 'C:\\w\\b.csv', a, a, 'win32'), null);   // 不同名的硬链接不是改名
    assert.equal(same('C:\\w\\a.csv', 'C:\\w\\DATA.csv', { dev: 1, ino: 0 }, { dev: 1, ino: 0 }, 'win32'), null);   // ino 取不到(0)不冒认
  });
});

describe('expandFileToolPathVars', () => {
  const expand = sliceFn('12-tool-dispatch.js', 'expandFileToolPathVars', ['os', require('os')]);
  it('~ 只在开头、后接分隔符或结尾时展开', () => {
    assert.equal(expand('~', {}, 'H'), 'H');
    assert.equal(expand('~/x', {}, 'H'), 'H/x');
    assert.equal(expand('~\\x', {}, 'H'), 'H\\x');
    assert.equal(expand('~x', {}, 'H'), '~x');
    assert.equal(expand('~$doc.docx', {}, 'H'), '~$doc.docx');
    assert.equal(expand('a/~/b', {}, 'H'), 'a/~/b');
  });
  it('%USERPROFILE% / %HOMEPATH% / %APPDATA% / %TEMP% 只在开头展开,未知变量与取不到的原样', () => {
    assert.equal(expand('%USERPROFILE%\\a', { USERPROFILE: 'C:\\Users\\u' }, 'H'), 'C:\\Users\\u\\a');
    assert.equal(expand('%userprofile%/a', { USERPROFILE: 'C:\\U' }, 'H'), 'C:\\U/a');
    assert.equal(expand('%HOMEPATH%\\a', { HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\u' }, 'H'), 'C:\\Users\\u\\a');
    assert.equal(expand('%APPDATA%', { APPDATA: 'C:\\A' }, 'H'), 'C:\\A');
    assert.equal(expand('%TEMP%/t', { TEMP: '/tmp' }, 'H'), '/tmp/t');
    assert.equal(expand('%NOPE%\\a', {}, 'H'), '%NOPE%\\a');
    assert.equal(expand('%APPDATA%\\a', {}, 'H'), '%APPDATA%\\a');
    assert.equal(expand('x\\%USERPROFILE%', { USERPROFILE: 'Q' }, 'H'), 'x\\%USERPROFILE%');
  });
  it('USERPROFILE 取不到时回落到 home', () => {
    assert.equal(expand('%USERPROFILE%/a', {}, 'H'), 'H/a');
  });
  it('路径里有 NUL → 抛带 ERR_INVALID_ARG_VALUE 的 TypeError(toolCall 出口转成 bad_path 信封)', () => {
    assert.throws(() => expand('a\0b', {}, 'H'), e => e.code === 'ERR_INVALID_ARG_VALUE');
  });
});

describe('normalizeGlobPatternForRoot', () => {
  const norm = sliceFn('11-native-tools.js', 'normalizeGlobPatternForRoot', ['path', path]);
  const root = path.resolve('/ws/proj');
  it('前导 ./ 与 .\\ 被剥掉并说明', () => {
    assert.equal(norm('./src/*.js', root).pattern, 'src/*.js');
    assert.equal(norm('.\\src\\*.js', root).pattern, 'src\\*.js');
    assert.equal(norm('././a', root).pattern, 'a');
    assert.match(norm('./a', root).note, /leading/);
    assert.equal(norm('**/*.js', root).note, '');
  });
  it('root 内的绝对 pattern 改写成相对 root;root 外的标 outside', () => {
    const inside = norm(path.join(root, 'src', '*.js'), root);
    assert.equal(inside.pattern, 'src/*.js');
    assert.equal(inside.outside, false);
    const out = norm(path.resolve('/elsewhere/*.js'), root);
    assert.equal(out.outside, true);
    assert.match(out.note, /outside root/);
  });
  it('只剩 ./ 时 pattern 为空串(调用方据此回信封)', () => {
    assert.equal(norm('./', root).pattern, '');
  });
});

describe('zipTopLevelNames', () => {
  const names = sliceFn('11-native-tools.js', 'zipTopLevelNames');
  it('互不同名的保持 basename', () => {
    assert.deepEqual(names(['/w/a.txt', '/w/b.txt']), ['a.txt', 'b.txt']);
  });
  it('同名的逐步补上父目录段直到互不相同(Windows 盘符冒号去掉)', () => {
    assert.deepEqual(names(['/w/d1/n.txt', '/w/d2/n.txt']), ['d1/n.txt', 'd2/n.txt']);
    assert.deepEqual(names(['C:\\a\\x\\n.txt', 'C:\\b\\x\\n.txt']), ['a/x/n.txt', 'b/x/n.txt']);
    assert.deepEqual(names(['/p/q/n.txt', '/r/q/n.txt', '/w/z.txt']), ['p/q/n.txt', 'r/q/n.txt', 'z.txt']);
  });
  it('大小写不同也算同名(zip 在 Windows 上解压不分大小写)', () => {
    const r = names(['/w/d1/N.txt', '/w/d2/n.txt']);
    assert.equal(new Set(r.map(x => x.toLowerCase())).size, 2);
  });
});
