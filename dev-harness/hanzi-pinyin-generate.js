#!/usr/bin/env node
'use strict';
// 59 号文 §6(语音词库第二步):生成 ruyi-workbench/app/src/04j-hanzi-pinyin.js —— 汉字 → 普通话读音(不带声调)的离线小表,
// 给「用户这处改动读音像不像」用(人名:张伟 → 张玮 读音一样;改内容:三点 → 四点 读音不像)。
//
// 数据源:Unicode 汉字数据库 Unihan 的 Unihan_Readings.txt(https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip),
// 许可 Unicode License v3(THIRD-PARTY-NOTICES §4)。只取 CJK 统一汉字基本区 U+4E00–U+9FFF 的两个字段:
//   kMandarin —— 最常用的那个读音(第一个当主读音);
//   kXHC1983  —— 《现代汉语词典》收的全部现代读音(多音字的其余读音从这里来,含姓氏读法:单 shàn、区 ōu、仇 qiú)。
// 不取 kHanyuPinyin:它收了大量古读,拿来比「像不像」只会凭空多出近音。
//
// 用法:
//   node dev-harness/hanzi-pinyin-generate.js <Unihan_Readings.txt>            只核对:生成结果与仓里那份逐字节相同才退出 0
//   node dev-harness/hanzi-pinyin-generate.js <Unihan_Readings.txt> --write    重写 04j-hanzi-pinyin.js
// 仓里不放 Unihan 原文件(约 7 MB),所以 CI 不跑本脚本;表的形状与抽查由 unit/hanzi-pinyin.test.js 钉。
//
// 编码(为了把 2 万字压进几十 KB、又不出现要转义的字符):
//   SYLLABLES —— 不带声调的音节表(ü 写成 v),下标从 1 起(0 = 这个字没有读音);
//   PRIMARY   —— 基本区每个码位 2 个字符(64 进制),是主读音的下标;
//   EXTRA     —— 多音字的其余读音:每条 = 码位偏移 3 个字符 + 个数 1 个字符 + 每个读音 2 个字符。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'ruyi-workbench', 'app', 'src', '04j-hanzi-pinyin.js');
const FROM = 0x4E00, TO = 0x9FFF;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

function toneless(reading) {
  return String(reading || '').normalize('NFD').toLowerCase()
    .replace(/ü/g, 'v').replace(/[̀-ͯ]/g, '').replace(/ü/g, 'v').replace(/[^a-z]/g, '');
}
function encode(n, width) {
  let s = '';
  for (let i = 0; i < width; i += 1) { s = ALPHABET[n % 64] + s; n = Math.floor(n / 64); }
  if (n) throw new Error('number too large for width ' + width);
  return s;
}

function parse(file) {
  const mandarin = new Map(), xhc = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [cpText, field, value] = line.split('\t');
    if (!cpText || !value || (field !== 'kMandarin' && field !== 'kXHC1983')) continue;
    const cp = parseInt(cpText.replace(/^U\+/, ''), 16);
    if (!(cp >= FROM && cp <= TO)) continue;
    if (field === 'kMandarin') mandarin.set(cp, value.split(/\s+/).map(toneless).filter(Boolean));
    else xhc.set(cp, value.split(/\s+/).map(piece => toneless(piece.split(':').pop())).filter(Boolean));
  }
  const table = new Map();
  for (let cp = FROM; cp <= TO; cp += 1) {
    const list = [];
    for (const r of [...(mandarin.get(cp) || []), ...(xhc.get(cp) || [])]) if (!list.includes(r)) list.push(r);
    if (list.length) table.set(cp, list);
  }
  return table;
}

function render(table) {
  const syllables = [...new Set([...table.values()].flat())].sort();
  const index = new Map(syllables.map((s, i) => [s, i + 1]));
  let primary = '', extra = '';
  for (let cp = FROM; cp <= TO; cp += 1) {
    const list = table.get(cp);
    primary += encode(list ? index.get(list[0]) : 0, 2);
    if (list && list.length > 1) extra += encode(cp - FROM, 3) + encode(list.length - 1, 1) + list.slice(1).map(r => encode(index.get(r), 2)).join('');
  }
  const chunk = (s, n) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; };
  const lines = [];
  lines.push("// 04j-hanzi-pinyin.js - 汉字 → 普通话读音(不带声调)的离线小表,给语音词库判断「这处改动读音像不像」用(59 号文 §6)。");
  lines.push('//');
  lines.push('// 【生成物,不要手改】由 dev-harness/hanzi-pinyin-generate.js 从 Unicode 汉字数据库 Unihan 的 Unihan_Readings.txt 生成:');
  lines.push('// CJK 统一汉字基本区 U+4E00–U+9FFF 里有读音的 ' + table.size + ' 个字,kMandarin 第一个读音是主读音,其余读音取 kXHC1983');
  lines.push('// (《现代汉语词典》现代读音,含多音字的姓氏读法)。数据许可 Unicode License v3,见 THIRD-PARTY-NOTICES §4。');
  lines.push('// 编码见生成脚本头注:SYLLABLES 音节表(ü 写成 v,下标从 1 起)、PRIMARY 每码位 2 位 64 进制主读音、EXTRA 多音字其余读音。');
  lines.push('//');
  lines.push('// 依赖环纪律:与 11b-file-text-io 同模具 —— 零出边,只暴露一个冻结对象 HanziPinyin。');
  lines.push('const HanziPinyin = (() => {');
  lines.push("  const ALPHABET = '" + ALPHABET + "';");
  lines.push('  const FROM = 0x' + FROM.toString(16).toUpperCase() + ', TO = 0x' + TO.toString(16).toUpperCase() + ', COUNT = ' + table.size + ';');
  lines.push('  const SYLLABLES = [');
  for (const row of chunk(syllables.join(' '), 150)) lines.push("    '" + row + "',");
  lines.push("  ].join('').split(' ');");
  lines.push('  const PRIMARY = [');
  for (const row of chunk(primary, 160)) lines.push("    '" + row + "',");
  lines.push("  ].join('');");
  lines.push('  const EXTRA = [');
  for (const row of chunk(extra, 160)) lines.push("    '" + row + "',");
  lines.push("  ].join('');");
  lines.push('  const decode = s => { let n = 0; for (const c of s) n = n * 64 + ALPHABET.indexOf(c); return n; };');
  lines.push('  let extraMap = null;   // 码位偏移 → 其余读音的下标;第一次用到才建');
  lines.push('  function extras() {');
  lines.push('    if (extraMap) return extraMap;');
  lines.push('    extraMap = new Map();');
  lines.push('    for (let i = 0; i < EXTRA.length;) {');
  lines.push('      const offset = decode(EXTRA.slice(i, i + 3)), count = decode(EXTRA.slice(i + 3, i + 4));');
  lines.push('      const list = [];');
  lines.push('      for (let k = 0; k < count; k += 1) list.push(decode(EXTRA.slice(i + 4 + k * 2, i + 6 + k * 2)));');
  lines.push('      extraMap.set(offset, list);');
  lines.push('      i += 4 + count * 2;');
  lines.push('    }');
  lines.push('    return extraMap;');
  lines.push('  }');
  lines.push('  // 一个字的全部读音(主读音在前);表外的字(英文、标点、扩展区汉字)回空数组。');
  lines.push('  function readings(ch) {');
  lines.push('    const code = String(ch || \'\').codePointAt(0);   // 不叫 cp:依赖图扫描器会把它认成 00-boot 的 child_process');
  lines.push('    if (!(code >= FROM && code <= TO)) return [];');
  lines.push('    const offset = code - FROM;');
  lines.push('    const first = decode(PRIMARY.slice(offset * 2, offset * 2 + 2));');
  lines.push('    if (!first) return [];');
  lines.push('    return [first, ...(extras().get(offset) || [])].map(i => SYLLABLES[i - 1]);');
  lines.push('  }');
  lines.push('  return Object.freeze({ FROM, TO, COUNT, SYLLABLE_COUNT: SYLLABLES.length, readings });');
  lines.push('})();');
  return lines.join('\n') + '\n';
}

if (require.main === module) {
  const src = process.argv[2];
  if (!src || !fs.existsSync(src)) {
    console.error('用法: node dev-harness/hanzi-pinyin-generate.js <Unihan_Readings.txt> [--write]');
    process.exit(2);
  }
  const table = parse(src);
  const text = render(table);
  const extraCount = [...table.values()].filter(list => list.length > 1).length;
  console.log(`hanzi pinyin: ${table.size} 字,${new Set([...table.values()].flat()).size} 个音节,多音字 ${extraCount} 个,产物 ${Buffer.byteLength(text)} 字节`);
  if (process.argv.includes('--write')) { fs.writeFileSync(OUT, text); console.log('写入 ' + path.relative(ROOT, OUT)); }
  else if (!fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== text) { console.error('04j-hanzi-pinyin.js 与这份 Unihan 生成的结果不一致(加 --write 重写)'); process.exit(1); }
  else console.log('04j-hanzi-pinyin.js 与生成结果逐字节相同');
}

module.exports = { toneless, parse, render };
