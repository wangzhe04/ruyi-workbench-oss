'use strict';
// 150 S5:canonical 切片快速路径 + 切片缓存的锁。
// FORMAT3 是索引格式:新实现吐出的每一窗(canonicalStart/start/end/text/ranges)必须与修前实现逐字节一致,否则旧索引
// 全部失效或命中错位。
// 快速路径的正确性证明分两半:
//   (1) 性质锁(完全):快速路径只在「尾巴 d1 与来者 d2 都是快码元」时生效,此时原路径的三次切分结果可直接写出,当且仅当
//       d1d2 之间必断、d 再规范化不变、d 是单码元。字素断点在两码元之间只取决于两边的 Grapheme_Cluster_Break 类,所以把每个
//       快码元按「与每一类代表码元的断点签名」(本机 ICU 现算)分类,断言只落在 Other/LF/Control 三类,再断言这三类两两必断。
//       ICU 升级若改了某个快码元的类,这里就红。
//   (2) 差分抽样:与 lib/fulltext-canonical-format3-reference.js(修前代码原样冻结)逐窗比对,同一 Node/ICU。
// 两份副本(13ap 与 06h9 SemanticOriginalWindows)按源码逐块相同、按输出逐窗相同各钉一道。
const { test } = require('node:test');
const a = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionBlock, constBlock } = require('../lib/source-slice');
const format3Reference = require('../lib/fulltext-canonical-format3-reference');

const SRC = path.join(__dirname, '../../ruyi-workbench/app/src');
const fulltextSource = fs.readFileSync(path.join(SRC, '13ap-session-fulltext-index.js'), 'utf8');
const policySource = fs.readFileSync(path.join(SRC, '06h9-semantic-policy.js'), 'utf8');
const FUNCTIONS = ['canonicalUnit', 'canonicalGroups', 'canonicalPieces', 'rangeAt', 'sliceCacheEvict', 'clearSliceCache', 'sweepSliceCache', 'slices', 'cachedSlices', 'sliceWindows'];
const CONSTANTS = ['CANONICAL_UNITS', 'SLICE_CACHE'];
const U = (...points) => String.fromCodePoint(...points);
const SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' });

// 13ap 的切片函数原样切出来,包进闭包(与产品里 IIFE 内的形态一致)。Date/setTimeout/segmenter 可替换。
function loadFulltext({ clock = null, timers = null, override = '', counter = null } = {}) {
  const names = override ? FUNCTIONS.filter(name => name !== 'sliceWindows') : FUNCTIONS;
  const body = [
    "const CHARS=4096,OVERLAP=256;const fail=value=>Object.assign(Error('session_fulltext.'+value),{code:'session_fulltext.'+value});",
    'const segmenter=__segmenter;',
    constBlock(fulltextSource, 'canonicalText'), ...CONSTANTS.map(name => constBlock(fulltextSource, name)), ...names.map(name => functionBlock(fulltextSource, name)), override,
    'return {windows:text=>Array.from(slices(text)),iterate:(text,generation)=>generation===undefined?slices(text):slices(text,generation),canonicalUnit,canonicalText,cache:SLICE_CACHE,clear:clearSliceCache};',
  ].join('\n');
  const segmenter = counter ? { segment: text => { counter.calls++; return SEGMENTER.segment(text); } } : SEGMENTER;
  const context = { Intl, __segmenter: segmenter };
  if (clock) context.Date = { now: () => clock.now };
  if (timers) Object.assign(context, timers);
  return vm.runInNewContext('(()=>{' + body + '\n})()', context);
}
function loadPolicy() {
  const context = vm.createContext({});
  vm.runInContext(policySource + '\nthis.windows=text=>Array.from(SemanticOriginalWindows.canonicalSlices(text));this.api=SemanticOriginalWindows;', context);
  return context;
}
const reference = format3Reference();
const fulltext = loadFulltext();
const policy = loadPolicy();
const same = (label, text) => {
  const expected = JSON.stringify(reference.windows(text));
  if (JSON.stringify(fulltext.windows(text)) !== expected) a.fail(label + ' 13ap differs from FORMAT3 reference for ' + JSON.stringify(text.slice(0, 80)));
  if (JSON.stringify(policy.windows(text)) !== expected) a.fail(label + ' 06h9 differs from FORMAT3 reference for ' + JSON.stringify(text.slice(0, 80)));
};
// 敌意邻居:组合符、ZWJ、CR/LF、韩文 L 与兼容字母、Prepend、区域旗帜、emoji、©、天城文辅音与 virama、VS16、
// 泰文 SpacingMark、空白、全角空白、ß、连字、孤立高/低代理。
const HOSTILE = [U(0x301), U(0x200d), '\r', '\n', '\r\n', U(0x1100), U(0x3131), U(0x314f), U(0x600), U(0x1f1e6), U(0x1f642), U(0xa9), U(0x915), U(0x94d), U(0xfe0f), U(0xe33), ' ', U(0x3000), U(0xdf), U(0xfb03), String.fromCharCode(0xd800), String.fromCharCode(0xdc00), U(0x345), '\t', U(0xa0)];
const HAN = U(0x6f22);

test('source copies in 13ap and 06h9 are byte-identical (fast path, cache, slicer)', () => {
  for (const name of FUNCTIONS) {
    const left = functionBlock(fulltextSource, name), right = functionBlock(policySource, name);
    a.ok(left.length > 60, '13ap ' + name + ' sliced');
    a.equal(right, left, name + ' differs between 13ap and 06h9');
  }
  for (const name of CONSTANTS) {
    const left = constBlock(fulltextSource, name).trim(), right = constBlock(policySource, name).trim();
    a.ok(left.length > 20, '13ap ' + name + ' sliced');
    a.equal(right, left, name + ' differs between 13ap and 06h9');
  }
  a.equal(typeof policy.api.clearSliceCache, 'function', '06h9 exposes its cache clear for 13ap');
});

// 每一个 Grapheme_Cluster_Break 类的代表码元。两码元之间的断点只取决于两边的类(InCB 与 Extended_Pictographic 只在
// 三码元以上的序列里起作用,快速路径只拼两码元,不需要它们的代表)。
const CLASS_PROBES = { CR: '\r', LF: '\n', Control: U(1), Extend: U(0x301), ZWJ: U(0x200d), RI: U(0x1f1e6), Prepend: U(0x600), SpacingMark: U(0x903), L: U(0x1100), V: U(0x1161), T: U(0x11a8), LV: U(0xac00), LVT: U(0xac01), Other: 'A' };
const SEPARATOR = U(1); // Control:GB4/GB5 两侧必断,把各探针对隔开
const signature = unit => {
  let text = '';
  for (const probe of Object.values(CLASS_PROBES)) text += SEPARATOR + unit + probe + SEPARATOR + probe + unit;
  let out = ''; for (const part of SEGMENTER.segment(text)) out += part.segment.length + ',';
  return out;
};
const splitsInTwo = (x, y) => { let n = 0; for (const _ of SEGMENTER.segment(x + y)) n++; return n === 2; };

test('every fast-path unit is stable and belongs to a grapheme class that always breaks against any other fast unit (ICU-checked)', () => {
  const allowed = new Map([[signature('A'), 'Other'], [signature('\n'), 'LF'], [signature('\t'), 'Control']]);
  // 探针本身必须能区分各类:除 Other/LF/Control 外,每一类代表码元都不得落进允许的签名。
  for (const [name, probe] of Object.entries(CLASS_PROBES)) if (!['Other', 'LF', 'Control'].includes(name) && probe.length === 1) a.equal(allowed.has(signature(probe)), false, 'probe ' + name + ' must not look like an allowed class');
  const members = new Map([['Other', []], ['LF', []], ['Control', []]]);
  let fast = 0, mapped = 0;
  for (let code = 0; code <= 0xffff; code++) {
    const unit = fulltext.canonicalUnit(code);
    if (unit < 0) continue;
    fast++; if (unit !== code) mapped++;
    const char = String.fromCharCode(unit);
    a.equal(fulltext.canonicalText(String.fromCharCode(code)), char, 'U+' + code.toString(16) + ' normalizes to its fast unit');
    if (unit !== code) continue; // 每个输出码元只在它自己那一格查一次类(输出码元必然也是自身的快码元)
    a.equal(fulltext.canonicalUnit(unit), unit, 'stable U+' + unit.toString(16));
    a.equal(fulltext.canonicalText(char), char, 'idempotent U+' + unit.toString(16));
    const cls = allowed.get(signature(char));
    if (!cls) a.fail('fast unit U+' + unit.toString(16) + ' is not in an always-breaking grapheme class on ICU ' + process.versions.icu);
    members.get(cls).push(char);
  }
  // 三类之间(含同类)两两必断:取每类前 48 个与末 16 个成员做完全两两。
  const reps = [...members.values()].flatMap(list => [...list.slice(0, 48), ...list.slice(-16)]);
  for (const x of reps) for (const y of reps) if (!splitsInTwo(x, y)) a.fail('fast units U+' + x.charCodeAt(0).toString(16) + ' U+' + y.charCodeAt(0).toString(16) + ' do not break');
  a.ok(fast > 25000 && mapped > 300, `fast ${fast}, mapped ${mapped}`);
  for (const code of [0x301, 0x200d, 0x0d, 0x1100, 0x3131, 0x600, 0xa9, 0x915, 0xfe0f, 0xe33, 0x3030, 0x303d, 0x203c, 0x2028, 0xd800, 0xdc00, 0xdf, 0xfb03, 0x345])
    a.equal(fulltext.canonicalUnit(code), -1, 'U+' + code.toString(16) + ' must take the original path');
});

test('sampled BMP units in hostile and fast contexts match the FORMAT3 reference byte-for-byte', () => {
  let text = '', units = 0;
  for (let code = 0; code <= 0xffff; code++) {
    const unit = fulltext.canonicalUnit(code);
    // 抽样:每 149 个取一个,外加全部「规范化后换了码元」的快码元(全角、小写、兼容汉字等)与 CJK 标点区。
    if (code % 149 !== 0 && !(unit >= 0 && unit !== code) && !(code >= 0x3000 && code <= 0x303f)) continue;
    text += HOSTILE[units++ % HOSTILE.length] + String.fromCharCode(code) + HAN + String.fromCharCode(code, code);
    if (text.length > 6000) { same('bmp@' + code.toString(16), text); text = ''; }
  }
  same('bmp-tail', text);
  a.ok(units > 1000, 'sampled units ' + units);
});

test('curated, boundary and seeded fuzz corpora match the FORMAT3 reference byte-for-byte', () => {
  const cases = [
    '中文与English混排, 含数字123和标点。“引号”(括号)、顿号;冒号:问号?感叹号!',
    '全角:ＡＢＣ　ａｂｃ１２３，。！？＠＃［］ｶﾞｷﾞ' + U(0xff9e) + '兼容:' + U(0x3231, 0x2460, 0x338f, 0xbd, 0x2126, 0x212b, 0xfdfa),
    'e' + U(0x301) + ' a' + U(0x300, 0x315, 0x327) + ' ' + U(0x1e9b, 0x323) + ' 漢' + U(0x301) + '字',
    U(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466) + '家庭' + U(0x1f3f3, 0xfe0f, 0x200d, 0x1f308) + '旗' + U(0x1f44d, 0x1f3fd) + '赞',
    U(0x1f1e8, 0x1f1f3, 0x1f1fa, 0x1f1f8, 0x1f1e6) + '中' + U(0x1f1e6, 0x1f1e6, 0x1f1e6) + '国',
    U(0x20000, 0x2a6d6) + '代理对' + U(0x1d400, 0x1d41a) + '数学' + String.fromCharCode(0xd83d) + '孤' + String.fromCharCode(0xde00) + '立',
    'İstanbul ıi' + U(0x307) + ' İ' + U(0x307) + ' ß ẞ STRASSE straße',
    'ΟΔΟΣ οδος σ ς Σ ΐ ᾳ ᾼ ' + U(0x345) + ' Ωμέγα',
    U(0x3131, 0x314f, 0x11a8) + '漢' + U(0x3131) + '한국어' + U(0x1100, 0x1161, 0x11a8) + '조합' + U(0xffa1, 0xffc2),
    '行一\r\n行二\r行三\n\n\t制表\v\f' + U(0x2028) + '段' + U(0x2029) + '尾' + U(0x85),
    '漢' + U(0x200d) + '字' + U(0x200c) + '词' + U(0xfe00) + '葛' + U(0xe0100) + '异体',
    U(0x915, 0x94d, 0x937) + '中' + U(0x915, 0x94d, 0x200d, 0x937) + U(0x600) + '漢' + U(0x600, 0x661),
    'ไทย' + U(0xe33) + '漢' + U(0xe33) + 'ລາວ' + U(0xeb3),
    U(0xa0) + '不换行' + U(0x3000) + '全角空' + U(0x2002, 0x2003, 0x200b) + '窄',
    U(0xfb01, 0xfb03) + '連字' + U(0x2f00, 0x2e9f, 0xf900, 0xfa0e) + '部首与兼容汉字',
    '〰〽︎' + U(0x303d, 0xfe0f) + '‼⁉' + U(0x203c, 0xfe0f) + '标点表情',
    '‐‑‒–—―‖‗‘’‚‛“”„‟†‡•‣․‥…‧' + '、。〃〄々〆〇〈〉《》「」『』【】〒〓〔〕〖〗〘〙〚〛〜〝〞〟〠〡〢〣〤〥〦〧〨〩',
  ];
  for (const [n, text] of cases.entries()) { same('curated#' + n, text); same('curated-pair#' + n, text + text); }
  const han = n => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(0x4e00 + (i * 7919) % 20000); return s; };
  // 窗口边界:切点上的代理对(end-- 与 count-- 两处调整)、切点上的组合符与展开、空白跨窗、重叠区里的代理对。
  const boundaries = [han(4095) + U(0x1f642) + han(4) + U(0x301) + U(0xfb03, 0xfdfa) + han(10), han(4094) + '  \n\t ' + 'e' + U(0x301).repeat(8) + han(30),
    han(3840) + U(0x20000) + han(300) + String.fromCharCode(0xd800) + U(0x3131, 0x314f), ('漢 字\n').repeat(1100)];
  for (const [n, text] of boundaries.entries()) same('boundary#' + n, text);
  const alphabet = [...'漢字中文的一是ABCxyz09 ,.;:!?，。、：；！？（）“”—…全角ＡＢ１', ...HOSTILE, U(0x1f469), U(0x20000), U(0x1100), U(0x1161), U(0x11a8), U(0x130), U(0x131), U(0x3a3), U(0x3c2), U(0x390)];
  let seed = 0x5a5d2d;
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let n = 0; n < 160; n++) {
    let text = '';
    const length = 1 + next(120), fastBias = next(4);
    for (let j = 0; j < length; j++) text += next(10) < 3 + fastBias * 2 ? alphabet[next(36)] : alphabet[next(alphabet.length)];
    same('fuzz#' + n, text);
  }
  for (let n = 0; n < 1; n++) { let text = ''; while (text.length < 4600) text += next(40) === 0 ? alphabet[next(alphabet.length)] : alphabet[next(36)]; same('fuzz-long#' + n, text); }
});

test('slice cache: equal output, fresh objects, lazy sharing, exact-text keys, bounds and idle expiry', () => {
  const clock = { now: 1000 };
  const api = loadFulltext({ clock });
  const text = ('缓存测试正文,' + 'abc ').repeat(400);
  const expected = JSON.stringify(reference.windows(text));
  const first = api.windows(text);
  a.equal(JSON.stringify(first), expected);
  first[0].ranges[0][1] = -1; first[0].text = 'mutated';
  a.equal(JSON.stringify(api.windows(text)), expected, 'consumer mutation never reaches the cache');
  a.notEqual(api.windows(text)[0], api.windows(text)[0], 'every consumer gets fresh window objects');
  const other = '另一段' + text, otherExpected = JSON.stringify(reference.windows(other));
  const early = api.iterate(other); early.next(); early.return();
  const left = api.iterate(other), right = api.iterate(other), lefts = [], rights = [];
  for (;;) { const l = left.next(), r = right.next(), r2 = right.next(); if (!l.done) lefts.push(l.value); if (!r.done) rights.push(r.value); if (!r2.done) rights.push(r2.value); if (l.done && r.done) break; }
  for (let l = left.next(); !l.done; l = left.next()) lefts.push(l.value);
  a.equal(JSON.stringify(lefts), otherExpected); a.equal(JSON.stringify(rights), otherExpected);
  const changed = text.slice(0, 1000) + '变' + text.slice(1001);
  a.equal(JSON.stringify(api.windows(changed)), JSON.stringify(reference.windows(changed)));
  const before = api.cache.entries.size;
  api.windows('短文本'.repeat(100));
  a.equal(api.cache.entries.size, before, 'short texts are not cached');
  for (let n = 0; n < 160; n++) api.windows(String.fromCharCode(0x4e00 + n) + '条目'.repeat(520));
  a.ok(api.cache.entries.size <= api.cache.maxEntries, 'entries bounded: ' + api.cache.entries.size);
  let accounted = 0; for (const entry of api.cache.entries.values()) accounted += entry.bytes;
  a.equal(api.cache.bytes, accounted, 'byte accounting matches live entries');
  clock.now += api.cache.idleMs + 1;
  api.windows(text);
  a.equal(api.cache.entries.size, 1, 'idle entries expire on the next call');
  api.clear();
  a.equal(api.cache.entries.size, 0); a.equal(api.cache.bytes, 0);
});

test('slice cache enforces its byte budget while filling and drops an entry that outgrows the per-entry cap', () => {
  const api = loadFulltext();
  api.cache.maxBytes = 300000; api.cache.maxEntryBytes = 200000;
  const big = ('段落 正文 ' + 'word ').repeat(3600); // ≤ maxEntryBytes/5 chars, so admitted, but its windows outgrow the per-entry cap
  a.ok(big.length * 5 <= api.cache.maxEntryBytes);
  let peak = 0;
  for (const window of api.iterate(big)) { peak = Math.max(peak, api.cache.bytes); a.ok(window.text.length > 0); }
  a.ok(peak <= api.cache.maxEntryBytes + 70000, 'entry dropped as soon as it outgrew the cap: peak ' + peak);
  a.equal(api.cache.entries.has(big), false, 'oversized entry is not retained');
  a.equal(JSON.stringify(api.windows(big)), JSON.stringify(fulltext.windows(big)), 'output unaffected');
  for (let n = 0; n < 20; n++) { for (const _ of api.iterate(String.fromCharCode(0x4e00 + n) + '预算'.repeat(4000))) a.ok(api.cache.bytes <= api.cache.maxBytes + 70000, 'budget held mid-fill: ' + api.cache.bytes); }
  a.ok(api.cache.bytes <= api.cache.maxBytes, 'budget held: ' + api.cache.bytes);
});

const MEMORY_CORPORA = {
  english: 'The quick brown fox jumps over the lazy dog; it was the best of times. ',
  crlf: '  if (value) { return other; }' + String.fromCharCode(13, 10) + String.fromCharCode(9) + 'x = y + 1;' + String.fromCharCode(13, 10),
  spacedChinese: '中文 正文 含 空格 与 标点， 再 来 一句。 ',
};
const corpusText = (unit, lead, length) => { let s = String.fromCharCode(lead); while (s.length < length) s += unit; return JSON.parse(JSON.stringify(s)); };
// 字符串真实占用的下界:含 U+0100 以上码元的串在 V8 里是双字节串,否则单字节。
const stringBytes = text => (/[^\x00-\xff]/.test(text) ? 2 : 1) * text.length;

test('slice cache byte estimate covers a computed lower bound of what it retains (English prose, CRLF code, spaced Chinese)', () => {
  // 确定性:不量 heapUsed,按结构算出缓存真正持有的字节下界(键正文 + 每窗正文串 + 每窗 Int32 平铺 ranges),估算必须不低于它。
  for (const [name, unit] of Object.entries(MEMORY_CORPORA)) {
    const api = loadFulltext();
    for (const n of [0, 1]) for (const _ of api.iterate(corpusText(unit, 0x4e00 + n, 30000)));
    a.equal(api.cache.entries.size, 2, name + ' cached');
    let lower = 0;
    for (const [key, entry] of api.cache.entries) {
      lower += stringBytes(key);
      for (const window of entry.windows) { a.ok(ArrayBuffer.isView(window.flat), 'ranges are stored as a typed array'); lower += stringBytes(window.text) + window.flat.byteLength; }
    }
    a.ok(lower <= api.cache.bytes, `${name}: retained lower bound ${lower} B must not exceed estimate ${api.cache.bytes} B`);
    a.ok(api.cache.bytes <= 4 * lower, `${name}: estimate ${api.cache.bytes} B stays within 4x of the lower bound ${lower} B`);
    a.ok(api.cache.bytes <= api.cache.maxBytes);
  }
  a.ok(loadFulltext().cache.maxBytes * 2 <= 64 * 1024 * 1024, 'two caches (13ap + 06h9) together stay within 64 MB');
});

// 真实堆留存只在进程以 --expose-gc 启动时量(node --expose-gc --test dev-harness/unit/fulltext-canonical-fast-path.test.js);
// 快通道里不改 V8 标志、不依赖 GC 时机,跳过。
test('slice cache byte estimate is an upper bound of the real retained heap (only with --expose-gc)', { skip: typeof globalThis.gc !== 'function' && 'start node with --expose-gc to measure the real heap' }, () => {
  const gc = globalThis.gc;
  for (const [name, unit] of Object.entries(MEMORY_CORPORA)) {
    const api = loadFulltext();
    for (const _ of api.iterate(corpusText(unit, 0x4e10, 20000))); api.clear(); // 预热:JIT 代码与 64K 表的一次性分配不算进留存
    gc(); gc();
    const before = process.memoryUsage();
    for (const _ of api.iterate(corpusText(unit, 0x4e00, 130000))); // 正文在基线之后分配、调用方随即丢掉:留存含键正文
    gc(); gc();
    const after = process.memoryUsage();
    const retained = (after.heapUsed - before.heapUsed) + (after.arrayBuffers - before.arrayBuffers);
    a.equal(api.cache.entries.size, 1, name + ' cached');
    a.ok(retained <= api.cache.bytes, `${name}: retained ${retained} B must not exceed estimate ${api.cache.bytes} B`);
  }
});

test('slice cache arms an unref()d sweep only while non-empty and the sweep evicts idle plaintext without another call', () => {
  const clock = { now: 5000 }, armed = [];
  const timers = { setTimeout: (fn, ms) => { const timer = { fn, ms, unrefed: false, unref() { this.unrefed = true; } }; armed.push(timer); return timer; }, clearTimeout: timer => { timer.cleared = true; } };
  const api = loadFulltext({ clock, timers });
  a.equal(armed.length, 0, 'loading the slicer arms no timer');
  api.windows('定时清扫'.repeat(400));
  a.equal(armed.length, 1); a.equal(armed[0].unrefed, true, 'sweep timer is unref()d');
  a.ok(armed[0].ms <= api.cache.idleMs);
  clock.now += api.cache.idleMs + 1;
  armed[0].fn();
  a.equal(api.cache.entries.size, 0, 'idle entry swept without any further slicing call');
  a.equal(armed.length, 1, 'no timer re-armed for an empty cache');
  api.windows('再清空'.repeat(400));
  a.equal(armed.length, 2);
  api.clear();
  a.equal(armed[1].cleared, true, 'clear cancels the pending sweep');
});

test('slice cache clear generation: text read before a clear is never put back afterwards', () => {
  const api = loadFulltext();
  const text = '清空世代'.repeat(3000), expected = JSON.stringify(reference.windows(text));
  // ① 清空发生在某个消费者迭代中途:它照常读完,但条目不再留在缓存里。
  const midway = api.iterate(text), seen = [midway.next().value];
  a.equal(api.cache.entries.size, 1);
  api.clear();
  for (let step = midway.next(); !step.done; step = midway.next()) seen.push(step.value);
  a.equal(JSON.stringify(seen), expected, 'the in-flight consumer still gets every window');
  a.equal(api.cache.entries.size, 0, 'mid-iteration clear leaves nothing cached');
  // ② 生成器在清空前创建、清空后才开始迭代(世代在调用那一刻取)。
  const early = api.iterate(text);
  api.clear();
  a.equal(JSON.stringify(Array.from(early)), expected);
  a.equal(api.cache.entries.size, 0, 'a generator created before the clear does not insert after it');
  // ③ 调用方在读正文之前取了世代,清空后才切片(搜索回读的形态):只现算,不读不写缓存。
  const before = api.cache.generation;
  api.windows(text); a.equal(api.cache.entries.size, 1);
  api.clear();
  a.equal(JSON.stringify(Array.from(api.iterate(text, before))), expected);
  a.equal(api.cache.entries.size, 0, 'a stale-generation caller neither reads nor re-inserts');
  a.equal(api.cache.bytes, 0);
  // 当前世代的调用照常缓存。
  api.windows(text); a.equal(api.cache.entries.size, 1);
});

test('06h9 policy requests slice with the generation they were created in, so a request from before a clear never reads the refilled cache', () => {
  const context = vm.createContext({});
  vm.runInContext(policySource + "\nthis.api=SemanticOriginalWindows;this.calls=0;const segment=Intl.Segmenter.prototype.segment;Intl.Segmenter.prototype.segment=function(value){this_calls();return segment.call(this,value);};function this_calls(){globalThis.calls++;}", context);
  const api = context.api, text = '请求世代'.repeat(2000);
  const open = request => { const r = api.createRequest({ query: 'q', scopeId: 's', modelFingerprint: 'm' }); return { r, token: r.captureField({ sourceId: 'x', field: 'content', revision: 'r', epoch: 'e', sourceRevision: 'v' }, text, 'canonical-message-v3') }; };
  const drain = ({ r, token }) => { context.calls = 0; const out = JSON.stringify(Array.from(r.canonicalSlices(token))); return { out, calls: context.calls }; };
  const stale = open();
  const first = drain(open());
  a.ok(first.calls > 0, 'cold slicing segments the text');
  api.clearSliceCache();
  const refill = drain(open());
  a.ok(refill.calls > 0, 'after the clear the cache starts empty');
  a.equal(drain(open()).calls, 0, 'a current-generation request reads the refilled cache');
  const old = drain(stale);
  a.equal(old.out, first.out);
  a.ok(old.calls > 0, 'the request created before the clear recomputes instead of reading the refilled cache');
});

test('slice cache never turns a generator failure into a truncated success', () => {
  const api = loadFulltext({ override: "function* sliceWindows(text){yield {canonicalStart:0,start:0,end:1,text:text.slice(0,1),ranges:[[0,1,0]]};throw fail('shard_invalid');}" });
  const text = '失败'.repeat(800);
  const a1 = api.iterate(text), a2 = api.iterate(text);
  a.equal(a1.next().value.text, '失');
  a.equal(a2.next().value.text, '失');
  a.throws(() => a1.next(), /shard_invalid/);
  a.throws(() => a2.next(), /shard_invalid/, 'a concurrent consumer sees the same failure, not done');
  a.equal(api.cache.entries.size, 0, 'failed entry dropped');
  a.equal(api.cache.bytes, 0);
  a.throws(() => api.windows(text), /shard_invalid/);
});

test('production build path: FORMAT3 rows match the reference, yields to the event loop, stops on revocation after a yield, and lifecycle events clear both caches', async t => {
  const { fixture } = require('../lib/fulltext-owned-producer-fixture');
  const f = await fixture(); t.after(() => f.close());
  let yields = 0, onYield = null, policyClears = 0;
  f.hookContext.setImmediate = callback => { yields++; const hook = onYield; onYield = null; if (hook) hook(); return setImmediate(callback); };
  f.hookContext.SemanticOriginalWindows = { clearSliceCache: () => { policyClears++; } };
  const namespace = vm.runInContext('SessionFullTextIndex', f.hookContext);
  let big = '', seed = 11;
  const han = '索引正文的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经';
  const extra = ['，', '。', '\n', ' ', 'Node.js', 'ｆｕｌｌ', U(0xfb03), 'e' + U(0x301), U(0x1f642), U(0x3131, 0x314f)];
  while (big.length < 150000) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; big += seed % 100 < 92 ? han[seed % han.length] : extra[seed % extra.length]; }
  const small = big.slice(0, 9000);
  await f.put('Small', [{ role: 'user', id: 'm0', content: small }]);
  await f.index.prepare(null);
  const root = path.join(f.sessions, '_fulltext-index-v1', 'Small');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const rows = manifest.shards.flatMap(shard => JSON.parse(fs.readFileSync(path.join(root, manifest.generation + '.' + shard.ordinal + '.json'), 'utf8')).rows).filter(row => row.source === 'content');
  a.equal(JSON.stringify(rows.map(row => ({ canonicalStart: row.canonicalStart, start: row.start, end: row.end, text: row.text, ranges: row.ranges }))), JSON.stringify(reference.windows(small)));
  a.ok(namespace.canonicalCacheSize() > 0, 'build populated the slice cache');
  // 生命周期:撤销、暂停、进出维护都清空两份缓存(本模块 + 06h9)。
  let clears = policyClears;
  await f.index.invalidate('Small', true);
  a.equal(namespace.canonicalCacheSize(), 0, 'invalidate clears'); a.ok(policyClears > clears, 'invalidate clears the 06h9 copy too');
  await f.put('Small', [{ role: 'user', id: 'm0', content: small }]); await f.index.prepare(null);
  a.ok(namespace.canonicalCacheSize() > 0);
  clears = policyClears; await f.index.pause();
  a.equal(namespace.canonicalCacheSize(), 0, 'pause clears'); a.ok(policyClears > clears);
  await f.index.resume(); await f.put('Small', [{ role: 'user', id: 'm1', content: small }]); await f.index.prepare(null);
  a.ok(namespace.canonicalCacheSize() > 0);
  clears = policyClears; f.index.setMaintenancePaused(true);
  a.equal(namespace.canonicalCacheSize(), 0, 'entering maintenance clears'); a.ok(policyClears > clears);
  f.index.setMaintenancePaused(false);
  await f.put('Small', [{ role: 'user', id: 'm2', content: small }]); await f.index.prepare(null);
  a.ok(namespace.canonicalCacheSize() > 0);
  // 撤权发生在让出期间:回来后的 check() 必须截住,之后不再切出任何窗口,也不写 manifest。
  await f.put('Revoked', [{ role: 'user', id: 'm0', content: big }]);
  f.catalog.splice(0, f.catalog.length, 'Revoked');
  let revokedAt = -1;
  onYield = () => { f.allowed.set('Revoked', false); revokedAt = yields; };
  await a.rejects(f.index.prepare(null), error => /disclosure_changed|source_denied/.test(String(error && error.code)));
  a.ok(revokedAt > 0, 'large source slicing yielded and the revocation was injected at that yield');
  a.equal(yields, revokedAt, 'the check right after the yield stops slicing; no further window is produced');
  a.equal(fs.existsSync(path.join(f.sessions, '_fulltext-index-v1', 'Revoked', 'manifest.json')), false);
  // 写入策略变化(明文 → 加密):下一次建索引在切片前清空两份缓存,旧策略下缓存的正文不留。
  a.ok(namespace.canonicalCacheSize() > 0);
  clears = policyClears; f.enable(true);
  await f.put('Policy', [{ role: 'user', id: 'm0', content: '策略变化' + small.slice(0, 1500) }]);
  f.catalog.splice(0, f.catalog.length, 'Policy');
  await f.index.prepare(null);
  a.ok(policyClears > clears, 'a work-data policy change clears both caches before slicing');
  a.equal(namespace.canonicalCacheSize(), 1, 'only the post-change text remains cached');
});

test('a search that read a session before invalidate does not put its text back into the slice cache after the clear', async t => {
  const { fixture } = require('../lib/fulltext-owned-producer-fixture');
  const f = await fixture(); t.after(() => f.close());
  const namespace = vm.runInContext('SessionFullTextIndex', f.hookContext);
  let body = '检索世代 zqxgenerationneedle ';
  for (let n = 0; body.length < 6000; n++) body += String.fromCharCode(0x4e00 + (n * 131) % 20000);
  await f.put('G', [{ role: 'user', id: 'm0', content: body }]);
  await f.index.prepare(null);
  a.ok(namespace.canonicalCacheSize() > 0, 'build cached the body');
  // 搜索回读这条消息时(正文已读出、尚未切片)插入 invalidate:清空在前,回读切片在后。
  let fired = 0;
  f.scan(async id => { if (id === 'G' && !fired) { fired++; await f.index.invalidate('G', true); a.equal(namespace.canonicalCacheSize(), 0, 'invalidate cleared'); } });
  try { await f.index.search('zqxgenerationneedle'); } catch { /* 会话已退役,搜索失败与否都不影响本断言 */ }
  f.scan(null);
  a.equal(fired, 1, 'the search re-read the session while invalidate ran');
  a.equal(namespace.canonicalCacheSize(), 0, 'text read before the clear was not re-inserted after it');
});

test('fast path cuts Intl.Segmenter.segment() calls by more than 20x on Chinese text (deterministic count, not wall time)', () => {
  let text = '', seed = 7;
  const han = '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经';
  const punct = ['，', '。', '、', '：', '“', '”', '\n', ' ', 'API', 'v2'];
  while (text.length < 8192) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; text += seed % 100 < 88 ? han[seed % han.length] : punct[seed % punct.length]; }
  const counter = { calls: 0 }, api = loadFulltext({ counter });
  const original = Intl.Segmenter.prototype.segment;
  let referenceCalls = 0;
  Intl.Segmenter.prototype.segment = function (value) { referenceCalls++; return original.call(this, value); };
  let expected;
  try { expected = JSON.stringify(reference.windows(text)); } finally { Intl.Segmenter.prototype.segment = original; }
  counter.calls = 0;
  const actual = JSON.stringify(api.windows(text));
  a.equal(actual, expected);
  a.ok(referenceCalls > 2 * text.length, 'reference calls segment() ~3x per grapheme: ' + referenceCalls);
  a.ok(counter.calls * 20 < referenceCalls, `fast path ${counter.calls} segment() calls vs reference ${referenceCalls}`);
});

test('short Han and ASCII windows preserve all original ranges at the fast path boundaries',()=>{
  for(const text of [' ', '   ', ' a  B ', '\u4e00 a  \u9fff', 'A \u4e00 b '.repeat(682),
    'x'.repeat(4095)+' ', ' '.repeat(4096), 'a'.repeat(4096)+'\u4e00',
    '\u4e00\u0301', '\uf900 \u4e00', '\u4e00\r\nx', '\u4e00\ufe0f']){
    same('short linear window',text);
  }
});
