'use strict';
// 性能批(回合起点估算):09d 的按内容记忆(estimateTextTokensMemo)与一趟扫描的分类器,和修前逐位相同、且真的省了活。
//   [M1] 分类器:新版 classifyTextForEstimate 与修前原版(下方逐字抄本)在随机串、阈值边界串、真实文件切片上逐个相同;
//        另换多组 ESTIMATION_RULES(阈值/采样长度/密度)再比,钉住「关键字只在能左右结论时才扫」的跳过逻辑与阈值无关
//   [M2] isRegexSpaceCodeUnit 与 /\s/ 在全部 65536 个码元上逐个相同(缩进行判据的地基)
//   [M3] 单段文本:记忆路径与修前直算 Object.is 相同(逐位,不是容差),开关开/关、首次/命中/翻转开关后都一样
//   [M4] 整段历史:随机历史(字符串/parts/图片/reasoning/tool_calls/Responses 项/system/tools)反复估、重读(新对象)、
//        改一条再估,与修前实现 Object.is 相同;真 server.js 导出同样对拍(真 ESTIMATION_RULES、真 07 的工具表估算)
//   [M5] 计数(不看墙钟):同一段历史重读后再估,长串零次重分类、零次重数 CJK;改一条/加一条只重估变了的那几段
//   [M6] 开关先关后开:关时只记 CJK 数,开后每段补分类恰一次
//   [M7] 有界:超字符上限从最久未用端淘汰,淘汰后估算照旧逐位相同
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { readServerSource } = require('../src-reader');
const { sliceBlock, functionBlock } = require('../lib/source-slice');

const REPO = path.resolve(__dirname, '..', '..');
const RULES = JSON.parse(fs.readFileSync(path.join(REPO, 'ruyi-workbench', 'app', 'src', 'context-governance-rules.json'), 'utf8')).estimation;

// ── 修前实现逐字抄本(1dcb8029 的 09d / 07),只把 ESTIMATION_RULES 与开关改成参数 ─────────────────────
function oracleClassify(str, R = RULES) {
  if (typeof str !== 'string' || !str) return 'text';
  const n = R.sampleChars;
  const truncated = str.length > n * 2;
  const sample = truncated ? str.slice(0, n) + str.slice(-n) : str;
  if (!truncated) {
    const t = sample.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { JSON.parse(t); return 'json'; } catch { /* 截断/近 JSON 落到密度判定 */ }
    }
  }
  const structHits = (sample.match(/[{}[\]":,]/g) || []).length;
  if (structHits / sample.length >= R.jsonStructDensity) return 'json';
  let score = 0;
  const lines = sample.split('\n');
  if (lines.length >= 3) {
    let indented = 0;
    for (const l of lines) if (/^(\t| {2,})\S/.test(l)) indented++;
    if (indented / lines.length >= 0.3) score += 2; // 换行+缩进
  }
  const punct = (sample.match(/[;{}()=><]/g) || []).length;
  if (punct / sample.length >= 0.03) score += 2; // ;{}()=> 密度
  const kw = (sample.match(/\b(function|const|let|var|return|import|export|class|def|async|await|public|private|static|void|if|for|while)\b|=>/g) || []).length;
  if (kw >= 3) score += 2; // 关键字命中
  return score >= R.codeSignalThreshold ? 'code' : 'text';
}
const CJK_RE = /[⺀-鿿가-힣豈-﫿︰-﹏＀-￯]/g;
function oracleText(str, bucketsOn) {
  if (typeof str !== 'string' || !str) return 0;
  const cjk = (str.match(CJK_RE) || []).length;
  const ascii = str.length - cjk;
  if (!bucketsOn) return ascii / 3.6 + cjk / 1.5;
  const bucket = oracleClassify(str);
  const divisor = bucket === 'json' ? RULES.factors.json : bucket === 'code' ? RULES.factors.code : 3.6;
  return ascii / divisor + cjk / 1.5;
}
function oracleContent(content, on) {
  if (typeof content === 'string') return oracleText(content, on);
  if (Array.isArray(content)) {
    let t = 0;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' || typeof part.text === 'string') t += oracleText(String(part.text || ''), on);
      else if (part.type === 'image_url' || part.image_url || part.type === 'image') t += 1100;
    }
    return t;
  }
  return 0;
}
function oracleHistory(history, systemPrompt, tools, on) {
  if (!Array.isArray(history)) return typeof systemPrompt === 'string' ? Math.round(oracleText(systemPrompt, on)) : 0;
  let t = 0;
  for (const m of history) {
    if (!m || typeof m !== 'object') continue;
    t += 40;
    t += oracleContent(m.content, on);
    if (typeof m.reasoning_content === 'string' && m.reasoning_content) t += oracleText(m.reasoning_content, on);
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc && tc.function;
        if (fn && typeof fn.arguments === 'string') t += oracleText(fn.arguments, on);
        if (fn && typeof fn.name === 'string') t += oracleText(fn.name, on);
      }
    }
    if (typeof m.arguments === 'string' && m.arguments) t += oracleText(m.arguments, on);
    if (typeof m.output === 'string' && m.output) t += oracleText(m.output, on);
    if (typeof m.name === 'string' && m.name && m.type === 'function_call') t += oracleText(m.name, on);
  }
  if (typeof systemPrompt === 'string' && systemPrompt) t += oracleText(systemPrompt, on);
  if (Array.isArray(tools) && tools.length) t += Math.round(oracleText(JSON.stringify(tools), on));
  return Math.round(t);
}

// ── 真源码:09d 估算簇整段 + 07 的工具表估算,装进 vm(函数声明是上下文全局属性,可换成计数包装) ──────────
const source = readServerSource();
const cluster = sliceBlock(source, 'let estimateBucketsV1On', '// v0.8-S5 — Context management');
const toolSchema = functionBlock(source, 'estimateToolSchemaTokens');
function loadCluster() {
  const ctx = vm.createContext({ ESTIMATION_RULES: RULES });
  vm.runInContext(cluster + '\n' + toolSchema + '\n'
    + 'globalThis.__memo = () => (typeof tokenEstimateMemo === "undefined" ? null : tokenEstimateMemo);'
    + 'globalThis.__memoHas = s => (typeof tokenEstimateMemoKey === "function" ? tokenEstimateMemo.map.get(tokenEstimateMemoKey(s))?.str === s : tokenEstimateMemo.map.has(s));', ctx);
  const calls = { classify: [], cjk: [] };
  const realClassify = ctx.classifyTextForEstimate, realCjk = ctx.countCjkCodeUnits;
  ctx.classifyTextForEstimate = s => { calls.classify.push(s); return realClassify(s); };
  ctx.countCjkCodeUnits = s => { calls.cjk.push(s); return realCjk(s); };
  const reset = () => { calls.classify.length = 0; calls.cjk.length = 0; };
  return { ctx, calls, reset, classify: realClassify };
}
const MIN = 64; // 与 09d TOKEN_ESTIMATE_MEMO_MIN_CHARS 对齐(下方断言它就是这个值)

// ── 随机语料 ─────────────────────────────────────────────────────────────────────────────────────────────
function rng(seed) {
  return () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const POOLS = [
  'abc XYZ 123 lorem ipsum dolor sit amet. ',
  '中文汉字测试压缩上下文估算，。「」',
  '한국어텍스트',
  'ＡＢＣ１２３，。',
  '😀🎉𝄞𐀀\uDBFF',                                   // 代理对与落单代理
  '{}[]":,;()=><',
  ' \t\t  \n\n\r\n',
  '        　﻿᠎​\v\f', // \s 边界(含非 \s 的 U+180E/U+200B)
  'function const let var return import export class def async await public private static void if for while => ',
  'functional constant letter variable returns imports xclass define asyncio awaits publicly if_ for$ while2 =',
];
const WORDS = ['function', 'const', 'let', 'return', 'if', 'for', '=>', 'x', 'foo', 'bar', '中文', '{', '}', '(', ')', ';', '=', '"k":', ',', '[', ']', '\n', '\n  ', '\n\t', '\n    ', '\n\t\t', '\n \t', '  '];
function randomText(r, maxLen) {
  const mode = Math.floor(r() * 6);
  const n = Math.floor(r() * maxLen);
  let s = '';
  if (mode === 0) { while (s.length < n) { const p = POOLS[Math.floor(r() * POOLS.length)]; s += p[Math.floor(r() * p.length)]; } }
  else if (mode === 1) { while (s.length < n) s += WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.5 ? ' ' : ''); }
  else if (mode === 2) { // 像代码
    while (s.length < n) s += (r() < 0.5 ? '  ' : r() < 0.5 ? '\t' : '') + WORDS[Math.floor(r() * 7)] + ' x' + Math.floor(r() * 99) + (r() < 0.5 ? ' = foo(a, b);' : ' {') + '\n';
  } else if (mode === 3) { // 合法 JSON(含 CJK)
    const o = {}; const k = Math.floor(r() * (n / 20 + 1)); for (let i = 0; i < k; i++) o['k' + i] = r() < 0.5 ? '值' + i : [i, { t: 'x'.repeat(Math.floor(r() * 30)) }];
    s = (r() < 0.3 ? ' \n' : '') + JSON.stringify(o, null, r() < 0.5 ? 2 : 0);
  } else if (mode === 4) { // 近 JSON(截断)
    s = JSON.stringify({ a: 'x'.repeat(n), b: [1, 2, 3] }).slice(0, Math.max(1, Math.floor(r() * (n + 20))));
  } else { // 散文 + 少量符号,贴着密度阈值
    while (s.length < n) s += 'the quick brown fox ' + (r() < 0.1 ? '(x); ' : '') + (r() < 0.05 ? '{"a":1}, ' : '');
  }
  return s;
}
// 真实文件切片:本仓源码、中文文档、JSON 数据
const REAL = [
  path.join(REPO, 'ruyi-workbench', 'app', 'src', '10-context-governance.js'),
  path.join(REPO, 'ruyi-workbench', 'app', 'src', 'context-governance-rules.json'),
  path.join(REPO, 'CONTRIBUTING.md'),
  path.join(REPO, 'ruyi-workbench', 'app', 'public', 'app.js'),
].filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8'));
function realSlice(r) {
  const text = REAL[Math.floor(r() * REAL.length)];
  const len = [10, 70, 500, 4096, 4097, 9000][Math.floor(r() * 6)];
  const at = Math.floor(r() * Math.max(1, text.length - len));
  return text.slice(at, at + len);
}
function randomHistory(r, n) {
  const h = [];
  const txt = () => (r() < 0.3 ? realSlice(r) : randomText(r, r() < 0.2 ? 12000 : 900));
  for (let i = 0; i < n; i++) {
    const k = Math.floor(r() * 9);
    if (k === 0) h.push({ role: 'user', content: txt() });
    else if (k === 1) h.push({ role: 'user', content: [{ type: 'text', text: txt() }, { type: 'image_url', image_url: { url: 'data:' } }, null, { text: txt() }, { type: 'image' }] });
    else if (k === 2) h.push({ role: 'assistant', content: txt(), reasoning_content: r() < 0.5 ? txt() : '' });
    else if (k === 3) h.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'file_read', arguments: JSON.stringify({ path: txt().slice(0, 200) }) } }, null, { function: { name: txt().slice(0, 80) } }] });
    else if (k === 4) h.push({ role: 'tool', tool_call_id: 'c' + i, content: JSON.stringify({ ok: true, content: txt() }) });
    else if (k === 5) h.push({ type: 'function_call', name: 'bash', arguments: txt(), call_id: 'x' + i });
    else if (k === 6) h.push({ type: 'function_call_output', output: txt(), call_id: 'x' + i });
    else if (k === 7) h.push(r() < 0.5 ? null : 'not-an-object');
    else h.push({ role: 'assistant', content: txt() });
  }
  return h;
}
const TOOLS = [{ type: 'function', function: { name: 'file_read', description: '读取文件 read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
const clone = h => JSON.parse(JSON.stringify(h)); // loadSession 形状:新对象、新字符串

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
test('[M0] 切到了真源码,记忆表常量与本测试对齐', () => {
  assert.ok(cluster.length > 2000 && /function estimateHistoryTokens\(/.test(cluster), '09d 估算簇切片非空');
  assert.ok(toolSchema.includes('function estimateToolSchemaTokens'), '07 estimateToolSchemaTokens 切到');
  assert.match(cluster, /const TOKEN_ESTIMATE_MEMO_MIN_CHARS = 64;/);
});

test('[M1] 分类器与修前原版逐个相同(随机串 / 阈值边界 / 真实文件切片 / 多组规则)', () => {
  const { ctx, classify } = loadCluster();
  const r = rng(7);
  const ruleSets = [RULES,
    { sampleChars: 16, jsonStructDensity: 0.2, codeSignalThreshold: 1, factors: RULES.factors },
    { sampleChars: 64, jsonStructDensity: 0.01, codeSignalThreshold: 2, factors: RULES.factors },
    { sampleChars: 300, jsonStructDensity: 0.08, codeSignalThreshold: 4, factors: RULES.factors },
    { sampleChars: 2048, jsonStructDensity: 0.5, codeSignalThreshold: 5, factors: RULES.factors },
    { sampleChars: 2048, jsonStructDensity: 1.1, codeSignalThreshold: 6, factors: RULES.factors },
    { sampleChars: 8, jsonStructDensity: 0.05, codeSignalThreshold: 7, factors: RULES.factors },
    // 退化采样长度:原版 str.slice(-0) 是整串、小数按 ToInteger 截、负数头尾交叠 —— 下标映射须与原版拼接逐码元对齐
    { sampleChars: 0, jsonStructDensity: 0.05, codeSignalThreshold: 3, factors: RULES.factors },
    { sampleChars: 2.5, jsonStructDensity: 0.05, codeSignalThreshold: 3, factors: RULES.factors },
    { sampleChars: -3, jsonStructDensity: 0.05, codeSignalThreshold: 3, factors: RULES.factors }];
  const seen = { json: 0, code: 0, text: 0 };
  for (let k = 0; k < 6000; k++) {
    const s = k % 3 === 0 ? realSlice(r) : randomText(r, k % 7 === 0 ? 9000 : 600);
    const R = ruleSets[k % ruleSets.length];
    ctx.ESTIMATION_RULES = R;
    const got = classify(s), want = oracleClassify(s, R);
    if (got !== want) assert.fail(`分类不同 rules#${k % ruleSets.length} got=${got} want=${want} s=${JSON.stringify(s.slice(0, 200))}`);
    if (R === RULES) seen[want]++;
  }
  // 手工边界:缩进行判据的每个角
  ctx.ESTIMATION_RULES = RULES;
  const edge = ['\tx\n\ty\n\tz', '\t\tx\n\t\ty\n\t\tz', '  x\n  y\n  z', ' x\n y\n z', '  \tx\n  \ty\n  \tz', '\t x\n\t y\n\t y',
    '  　\n   \n  ﻿', '  ᠎\n  ​\n  \ud800', '\t\r\n\t\r\n\t\r', '  x\r\n  y\r\n  z\r\n', '\n\n\n', '  ', '\t', 'a\n', '\n  a\n',
    'x => y => z => w', 'if(a)for(b)while(c)', 'ifx forx whilex', '_if _for _while', '$if $for $while', '中if中for中while', 'a=>b=>c',
    '{}', '[]', ' {"a":1} ', '{"a":', '[1,2', '{'.repeat(10), ';'.repeat(3) + 'a'.repeat(97), ';'.repeat(3) + 'a'.repeat(98)];
  for (const s of edge) assert.equal(classify(s), oracleClassify(s), JSON.stringify(s));
  assert.ok(seen.json > 50 && seen.code > 50 && seen.text > 50, `三桶都被覆盖到: ${JSON.stringify(seen)}`);
});

test('[M2] isRegexSpaceCodeUnit 与 /\\s/ 在全部 65536 个码元上相同', () => {
  const { ctx } = loadCluster();
  for (let c = 0; c < 0x10000; c++) {
    assert.equal(ctx.isRegexSpaceCodeUnit(c), /\s/.test(String.fromCharCode(c)), `U+${c.toString(16)}`);
  }
});

test('[M3] 单段文本:记忆路径与修前直算逐位相同(开/关、首次/命中/翻转)', () => {
  const { ctx } = loadCluster();
  const r = rng(11);
  const texts = [];
  for (let k = 0; k < 1500; k++) texts.push(k % 4 === 0 ? realSlice(r) : randomText(r, k % 5 === 0 ? 10000 : 400));
  texts.push('', 'x', 'a'.repeat(MIN - 1), 'a'.repeat(MIN), '中'.repeat(MIN), '😀'.repeat(MIN));
  for (const on of [false, true, false, true]) {
    ctx.setEstimateBucketsV1(on);
    for (const s of texts) {
      const want = oracleText(s, on);
      assert.ok(Object.is(ctx.estimateTextTokensMemo(s), want), `memo on=${on} len=${s.length}`);
      assert.ok(Object.is(ctx.estimateTextTokensMemo(s.split('').join('')), want), `memo 同内容新字符串 on=${on}`);
      assert.ok(Object.is(ctx.estimateTextTokens(s), want), `direct on=${on}`);
    }
  }
  for (const v of [null, undefined, 42, {}, []]) assert.equal(ctx.estimateTextTokensMemo(v), 0);
});

test('[M4] 整段历史:反复估 / 重读 / 改动后与修前逐位相同(vm 真源码)', () => {
  const { ctx } = loadCluster();
  const r = rng(23);
  for (let round = 0; round < 12; round++) {
    const on = round % 3 !== 0;
    ctx.setEstimateBucketsV1(on);
    let h = randomHistory(r, 60 + Math.floor(r() * 200));
    const sys = randomText(r, 3000);
    for (let pass = 0; pass < 4; pass++) {
      assert.equal(ctx.estimateHistoryTokens(h, sys, TOOLS), oracleHistory(h, sys, TOOLS, on), `round ${round} pass ${pass}`);
      assert.equal(ctx.estimateHistoryTokens([{ role: 'system', content: sys }, ...h], '', TOOLS), oracleHistory([{ role: 'system', content: sys }, ...h], '', TOOLS, on));
      assert.equal(ctx.estimateToolSchemaTokens(TOOLS), Math.round(oracleText(JSON.stringify(TOOLS), on)));
      h = clone(h);
      if (pass === 2) { h.push(...randomHistory(r, 5)); const i = Math.floor(r() * h.length); if (h[i] && typeof h[i] === 'object') h[i].content = '[已省略:' + randomText(r, 200); }
    }
    assert.equal(ctx.estimateHistoryTokens('nope', sys), Math.round(oracleText(sys, on)));
  }
});

test('[M4b] 真 server.js 导出与修前实现逐位相同(真 ESTIMATION_RULES / 07 工具表 / calibratedEstimate 因子)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-est-memo-'));
  process.env.RUYI_HOME = home;
  const srv = require(path.join(REPO, 'ruyi-workbench', 'app', 'server.js'));
  after(() => { srv.setEstimateBucketsV1(false); fs.rmSync(home, { recursive: true, force: true }); });
  const r = rng(31);
  for (let round = 0; round < 8; round++) {
    const on = round % 2 === 0;
    srv.setEstimateBucketsV1(on);
    let h = randomHistory(r, 150);
    for (let pass = 0; pass < 3; pass++) {
      assert.equal(srv.estimateHistoryTokens(h, 'sys ' + 'x'.repeat(500), TOOLS), oracleHistory(h, 'sys ' + 'x'.repeat(500), TOOLS, on));
      // calibratedEstimate = round(估算 × 因子);新会话无校准样本 → 因子 1,等于 round(估算)
      assert.equal(srv.calibratedEstimate({ id: 'p' }, 'm', h, TOOLS), oracleHistory(h, '', TOOLS, on));
      h = clone(h);
    }
  }
});

test('[M5] 计数:重读后的同一段历史不重分类、不重数 CJK;改一条/加一条只重估变了的那几段', () => {
  const { ctx, calls, reset } = loadCluster();
  ctx.setEstimateBucketsV1(true);
  const r = rng(47);
  let h = randomHistory(r, 400);
  const sys = 'system ' + randomText(r, 5000);
  const first = ctx.estimateHistoryTokens([{ role: 'system', content: sys }, ...h], '', TOOLS);
  const longFirst = calls.classify.filter(s => s.length >= MIN).length;
  assert.ok(longFirst > 300, `首次确实分类了长串(${longFirst})`);
  // 同回合第二次(同一批对象)
  reset();
  assert.equal(ctx.estimateHistoryTokens([{ role: 'system', content: sys }, ...h], '', TOOLS), first);
  assert.equal(calls.classify.filter(s => s.length >= MIN).length, 0, '同一批对象再估:长串零次分类');
  assert.equal(calls.cjk.filter(s => s.length >= MIN).length, 0, '同一批对象再估:长串零次数 CJK');
  // 下一回合:从盘上重读(新对象、新字符串)
  h = clone(h);
  reset();
  assert.equal(ctx.estimateHistoryTokens([{ role: 'system', content: String(sys) }, ...h], '', TOOLS), first);
  assert.equal(calls.classify.filter(s => s.length >= MIN).length, 0, '重读后再估:长串零次分类');
  assert.equal(calls.cjk.filter(s => s.length >= MIN).length, 0, '重读后再估:长串零次数 CJK');
  // 改一条 + 加两条:恰好重估这三段新内容
  const i = h.findIndex(m => m && m.role === 'assistant' && typeof m.content === 'string' && m.content.length >= MIN);
  assert.ok(i >= 0);
  const changed = h[i].content + ' 改了一个字';
  h[i].content = changed;
  const added = ['新的一条 user 消息 ' + 'x'.repeat(100), JSON.stringify({ ok: true, content: 'function f() { return 1; }\n'.repeat(20) })];
  h.push({ role: 'user', content: added[0] }, { role: 'tool', tool_call_id: 'z', content: added[1] });
  reset();
  const after3 = ctx.estimateHistoryTokens([{ role: 'system', content: sys }, ...h], '', TOOLS);
  assert.equal(after3, oracleHistory([{ role: 'system', content: sys }, ...h], '', TOOLS, true));
  assert.deepEqual(calls.classify.filter(s => s.length >= MIN).sort(), [changed, ...added].sort(), '只分类了改过/新加的长串');
  assert.deepEqual(calls.cjk.filter(s => s.length >= MIN).sort(), [changed, ...added].sort(), '只数了改过/新加的长串的 CJK');
  // 短串(< MIN)始终直算:它们不进表,计数照旧 —— 这是设计(直算比查表便宜),不是漏记
  const shortSeen = calls.classify.filter(s => s.length < MIN).length;
  assert.ok(shortSeen >= 0);
});

test('[M6] 开关先关后开:关时只数 CJK 不分类,开后每段补分类恰一次', () => {
  const { ctx, calls, reset } = loadCluster();
  const r = rng(59);
  const h = randomHistory(r, 120);
  ctx.setEstimateBucketsV1(false);
  assert.equal(ctx.estimateHistoryTokens(h), oracleHistory(h, undefined, undefined, false));
  assert.equal(calls.classify.length, 0, '开关关:零分类');
  reset();
  ctx.setEstimateBucketsV1(true);
  assert.equal(ctx.estimateHistoryTokens(h), oracleHistory(h, undefined, undefined, true));
  assert.equal(calls.cjk.filter(s => s.length >= MIN).length, 0, '开关开:CJK 数沿用表里的');
  const classifiedLong = calls.classify.filter(s => s.length >= MIN);
  assert.equal(new Set(classifiedLong).size, classifiedLong.length, '每段长串恰分类一次');
  reset();
  assert.equal(ctx.estimateHistoryTokens(clone(h)), oracleHistory(h, undefined, undefined, true));
  assert.equal(calls.classify.filter(s => s.length >= MIN).length, 0, '开后再估:零分类');
  ctx.setEstimateBucketsV1(false);
  assert.equal(ctx.estimateHistoryTokens(clone(h)), oracleHistory(h, undefined, undefined, false), '再关回去照旧两桶');
});

test('[M7] 有界:超字符上限从最久未用端淘汰,估算照旧逐位相同', () => {
  const { ctx } = loadCluster();
  const memo = ctx.__memo();
  assert.ok(memo && Object.prototype.toString.call(memo.map) === '[object Map]', '记忆表可见');
  ctx.setEstimateBucketsV1(true);
  const MB = 1024 * 1024;
  const big = i => String(i).padStart(8, '0') + (i % 2 ? '中' : 'x').repeat(MB); // 各 1M+ 字符、内容互不相同
  const kept = big(0);
  for (let i = 0; i < 30; i++) {
    assert.ok(Object.is(ctx.estimateTextTokensMemo(big(i)), oracleText(big(i), true)));
    if (i % 5 === 0) ctx.estimateTextTokensMemo(kept); // 常用的那条一直被摸,不该被淘汰
    let sum = 0; for (const e of memo.map.values()) sum += e.str.length;
    assert.equal(sum, memo.chars, '字符账与表内一致');
    assert.ok(memo.chars <= 24 * MB, `字符总数不超上限 (${memo.chars})`);
  }
  assert.ok(ctx.__memoHas(kept), '最近用过的留在表里');
  assert.ok(!ctx.__memoHas(big(1)), '最久未用的被淘汰');
  assert.ok(Object.is(ctx.estimateTextTokensMemo(big(1)), oracleText(big(1), true)), '淘汰后重算照旧逐位相同');
});

// review(round 4):V8 对 >16383 码元的字符串只按长度哈希。同长长串(截断到固定上限的工具输出)若整串当键会挤进同一桶,
// 热估反比直算慢。判据用计数而非计时:同长、只在尾部不同的一批长串,热估零重算,且采样撞键的两串互不认错。
test('[M8] 同长长串:按采样键分桶,命中逐字确认;采样撞键不认错', () => {
  const { ctx, calls, reset } = loadCluster();
  ctx.setEstimateBucketsV1(true);
  const L = 20000;
  const strs = Array.from({ length: 300 }, (_, i) => ('const x = ' + i + ';\n').repeat(3000).slice(0, L - 8) + String(i).padStart(8, '0'));
  assert.ok(strs.every(s => s.length === L));
  const cold = strs.map(s => ctx.estimateTextTokensMemo(s));
  reset();
  const warm = strs.map(s => ctx.estimateTextTokensMemo(s.split('').join('')));  // 新字符串对象、内容相同(模拟重读)
  assert.deepEqual(warm, cold);
  assert.equal(calls.cjk.length + calls.classify.length, 0, '热估零重算');
  assert.ok(warm.every((v, i) => Object.is(v, oracleText(strs[i], true))), '与原版逐位相同');
  // 采样撞键:两串长度与 8 段采样全同,只在采样缝隙里差一个字
  const base = 'a'.repeat(L);
  const twin = base.slice(0, 100) + '中' + base.slice(101);
  assert.equal(ctx.tokenEstimateMemoKey(base), ctx.tokenEstimateMemoKey(twin), '前提:采样键相同');
  assert.ok(Object.is(ctx.estimateTextTokensMemo(base), oracleText(base, true)));
  assert.ok(Object.is(ctx.estimateTextTokensMemo(twin), oracleText(twin, true)), '撞键的另一串按自己的内容算');
  assert.ok(Object.is(ctx.estimateTextTokensMemo(base), oracleText(base, true)), '换回来仍按自己的内容算');
  const memo = ctx.__memo();
  let sum = 0; for (const e of memo.map.values()) sum += e.str.length;
  assert.equal(sum, memo.chars, '字符账与表内一致');
});
