'use strict';
// Unit:59 号文 §6 —— 04j-hanzi-pinyin.js(汉字 → 普通话读音的离线小表)与它的生成脚本 dev-harness/hanzi-pinyin-generate.js。
//
//   [P1] 运行时的表:覆盖面(基本区两万多字、四百多个音节)、主读音在前、多音字的其余读音(含姓氏读法)、ü 写成 v、表外的字回空
//   [P2] 生成脚本:去声调(含 ü 的组合附加符)、只认 kMandarin 与 kXHC1983(kHanyuPinyin 的古读不收)、基本区之外不收、
//        render 出来的模块在 Node 里真能跑且查得回原表;仓里那份的头注与 COUNT 自洽(仓里不放 Unihan 原文件,CI 不重生成)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-hanzi-pinyin-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const { VoiceLearn } = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));
const gen = require(path.join(repo, 'dev-harness', 'hanzi-pinyin-generate.js'));
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
const P = VoiceLearn.HanziPinyin;

test('[P1] 运行时的表:覆盖面、主读音在前、多音字、ü、表外', () => {
  assert.ok(Object.isFrozen(P));
  assert.equal(P.FROM, 0x4E00);
  assert.equal(P.TO, 0x9FFF);
  assert.ok(P.COUNT > 20000 && P.COUNT <= 0x9FFF - 0x4E00 + 1, 'COUNT ' + P.COUNT);
  assert.ok(P.SYLLABLE_COUNT >= 400 && P.SYLLABLE_COUNT <= 430, 'SYLLABLE_COUNT ' + P.SYLLABLE_COUNT);
  assert.deepEqual(P.readings('张'), ['zhang']);
  assert.deepEqual(P.readings('伟'), ['wei']);
  assert.deepEqual(P.readings('玮'), ['wei']);
  assert.equal(P.readings('行')[0], 'xing');
  assert.ok(P.readings('行').includes('hang'));
  assert.deepEqual(P.readings('单'), ['dan', 'chan', 'shan']);   // 姓氏读法 shàn 来自 kXHC1983
  assert.deepEqual(P.readings('区'), ['qu', 'ou']);
  assert.ok(P.readings('仇').includes('qiu'));
  assert.deepEqual(P.readings('绿'), ['lv', 'lu']);
  assert.deepEqual(P.readings('女'), ['nv']);
  assert.deepEqual(P.readings('A'), []);
  assert.deepEqual(P.readings('。'), []);
  assert.deepEqual(P.readings(''), []);
  assert.deepEqual(P.readings(null), []);
  assert.deepEqual(P.readings('𠀀'), []);   // 扩展 B 区不在表里
  for (const ch of '的一是不了人我在有他这中大来上个国到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好') {
    const r = P.readings(ch);
    assert.ok(r.length >= 1 && r.every(x => /^[a-z]+$/.test(x)), ch + ' → ' + JSON.stringify(r));
  }
});

test('[P2] 生成脚本:去声调、只收两个字段、基本区之外不收、render 能跑、仓里那份自洽', () => {
  assert.equal(gen.toneless('zhāng'), 'zhang');
  assert.equal(gen.toneless('lǜ'), 'lv');
  assert.equal(gen.toneless('nǚ'), 'nv');
  assert.equal(gen.toneless('Shàn'), 'shan');
  const sample = [
    '# Unihan_Readings.txt 的样子(制表符分隔)',
    'U+4E00\tkMandarin\tyī',
    'U+4E00\tkHanyuPinyin\t10001.010:yī',
    'U+5355\tkMandarin\tdān',
    'U+5355\tkXHC1983\t0213.050:dān 0105.040:chán 1006.070:shàn',
    'U+5355\tkHanyuPinyin\t10293.010:dān,chán,shàn,dàn,tán',   // 古读(dàn/tán)不收
    'U+7EFF\tkMandarin\tlǜ',
    'U+7EFF\tkXHC1983\t0805.010:lǜ 0788.130:lù',
    'U+3400\tkMandarin\tqiū',                                    // 扩展 A 区:不收
    'U+20000\tkMandarin\thē',                                    // 扩展 B 区:不收
  ].join('\n');
  const file = path.join(root, 'Unihan_Readings.sample.txt');
  fs.writeFileSync(file, sample);
  const table = gen.parse(file);
  assert.deepEqual([...table.keys()], [0x4E00, 0x5355, 0x7EFF]);
  assert.deepEqual(table.get(0x5355), ['dan', 'chan', 'shan']);
  assert.deepEqual(table.get(0x7EFF), ['lv', 'lu']);
  const text = gen.render(table);
  const sandbox = {};
  vm.runInNewContext(text + '\nthis.out = HanziPinyin;', sandbox);
  const mod = sandbox.out;
  assert.equal(mod.COUNT, 3);
  assert.deepEqual(Array.from(mod.readings('一')), ['yi']);
  assert.deepEqual(Array.from(mod.readings('单')), ['dan', 'chan', 'shan']);
  assert.deepEqual(Array.from(mod.readings('绿')), ['lv', 'lu']);
  assert.deepEqual(Array.from(mod.readings('二')), []);
  assert.ok(!/[\\'"`]/.test(text.split('\n').filter(l => /^    '/.test(l)).map(l => l.slice(5, -2)).join('')), '编码段里没有要转义的字符');
  const src = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'src', '04j-hanzi-pinyin.js'), 'utf8');
  assert.match(src, /【生成物,不要手改】由 dev-harness\/hanzi-pinyin-generate\.js/);
  assert.ok(src.includes('里有读音的 ' + P.COUNT + ' 个字'), '头注里的字数与 COUNT 一致');
  assert.ok(src.includes('COUNT = ' + P.COUNT + ';'));
  const notices = fs.readFileSync(path.join(repo, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  assert.match(notices, /Unihan/);
  assert.match(notices, /UNICODE LICENSE V3/i);
});
