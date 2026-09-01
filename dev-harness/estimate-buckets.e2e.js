// 105e 估算因子分桶 [U]/[H] —— runtimeEstimateBucketsV1(A/B 回放 + 夹具修复后默认 true;显式 false 回退两桶)。
//
// 断言面:
//   a) 开关三态:默认 true / 显式 false 回退 / 字符串 "true" 洗回 false(estimateBucketsEnabled 唯一判定点,
//      严格布尔;sanitize 表邻接由 runtime-optimization.static.e2e.js 静态锁把守)
//   b) 开关关 = 现状两桶逐字节一致 —— 用 autocompact.e2e.js 同款样本对拍(纯 CJK、tool_calls
//      arguments 差值、image +1100);JSON/代码/散文样本与 ascii/3.6 + cjk/1.5 参照公式一致
//      (estimateHistoryTokens 出口有 Math.round,容差 ≤0.5);text 桶样本开/关精确 ===(同一路径)
//   c) 开关开:JSON 样本进 json 桶(÷2.8,同长估算 > text 桶)、代码样本进 code 桶(÷3.2)、
//      散文维持 text 桶;CJK 混合文本各桶 CJK 部分恒 ÷1.5
//   d) 短串/空串/非字符串安全;采样截断(>2×sampleChars)的大 JSON 由结构密度兜底命中 json 桶
//   e) 阈值边界:结构密度恰好 0.05 → json,低一丝 → 非 json;代码评分 2(单信号)→ text、
//      ≥4(双信号)→ code(threshold=3)
//   f) estimateContentTokens/estimateHistoryTokens 走同一入口:tool_calls arguments 命中 json 桶;
//      image part 固定 1100 不受开关影响
const path = require('path');
const os = require('os');
const fs = require('fs');
const zlib = require('zlib');

const HOME = path.join(os.tmpdir(), 'wcw-estimate-buckets-e2e');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.RUYI_HOME = HOME; // 模块装载期数据根解析用(本件不读写磁盘,防御性隔离)

const srv = require(path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js'));

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const { estimateHistoryTokens: est, estimateBucketsEnabled, setEstimateBucketsV1, classifyTextForEstimate } = srv;
ok(typeof est === 'function', 'estimateHistoryTokens is exported');
ok(typeof estimateBucketsEnabled === 'function', 'estimateBucketsEnabled is exported (唯一判定点)');
ok(typeof setEstimateBucketsV1 === 'function', 'setEstimateBucketsV1 is exported (镜像 setter)');
ok(typeof classifyTextForEstimate === 'function', 'classifyTextForEstimate is exported (三桶分类器)');

// 单条 user 消息的文本估算(剥掉 +40 结构开销),等价于直接调 estimateTextTokens;
// 出口 Math.round 引入 ≤0.5 取整误差,涉及小数的断言统一用 ROUND 容差。
const ROUND = 0.5;
const estText = s => est([{ role: 'user', content: s }]) - 40;
const legacy = s => { // 两桶公式参照:ascii ÷3.6、CJK ÷1.5(与 09-workflow.js 注释同款)
  const cjk = (String(s).match(/[⺀-鿿가-힣豈-﫿︰-﹏＀-￯]/g) || []).length;
  return (String(s).length - cjk) / 3.6 + cjk / 1.5;
};

// ── (a) 开关三态 ─────────────────────────────────────────────────────────────
const cfgDefault = srv.defaultConfig();
ok(estimateBucketsEnabled(cfgDefault) === true, 'a 默认 config → true(A/B 回放 + 夹具修复后默认开启)');
ok(estimateBucketsEnabled({ runtimeEstimateBucketsV1: false }) === false, 'a 显式 false → false(完整回退两桶)');
ok(estimateBucketsEnabled({ runtimeEstimateBucketsV1: true }) === true, 'a 显式 true → true');
ok(estimateBucketsEnabled({ runtimeEstimateBucketsV1: 'true' }) === false, 'a 字符串 "true" 洗回 false(严格布尔)');
ok(estimateBucketsEnabled({}) === false && estimateBucketsEnabled(null) === false && estimateBucketsEnabled(undefined) === false, 'a 未归一化/null/undefined config 安全(裸判定,非默认归并)');

// ── 样本(与 autocompact.e2e.js:106-123 同款) ────────────────────────────────
const CJK300 = '中'.repeat(300);
const BIG_ARGS = JSON.stringify({ path: 'p'.repeat(1000) }); // ~1011 ascii,JSON.parse 可成 → json 桶
const CODE_SAMPLE = [
  'function fib(n) {',
  '  if (n <= 1) return n;',
  '  return fib(n - 1) + fib(n - 2);',
  '}',
  'const result = fib(10);',
].join('\n');
const PROSE = 'lorem ipsum dolor sit amet '.repeat(10); // autocompact bigfile 同款散文
const CJK_JSON = '{"key":"值值值","n":1}'; // CJK 混合 JSON(17 ascii + 3 CJK)
const BIG_JSON = '[' + Array.from({ length: 400 }, (_, i) => `{"id":${i},"name":"item-${i}"}`).join(',') + ']'; // >4096 字符,采样截断后靠密度命中

// ── (b) 开关关 = 两桶逐字节一致 ──────────────────────────────────────────────
setEstimateBucketsV1(false); // 显式回退路径(镜像默认亦是 false,双保险)
ok(estText(CJK300) === 300 / 1.5, 'b 关:纯 CJK 估算精确 = len/1.5(autocompact 同款)');
ok(Math.abs(estText(BIG_ARGS) - legacy(BIG_ARGS)) <= ROUND, 'b 关:JSON 样本仍走两桶(= 参照公式 ±取整)');
ok(Math.abs(estText(CODE_SAMPLE) - legacy(CODE_SAMPLE)) <= ROUND, 'b 关:代码样本仍走两桶(= 参照公式 ±取整)');
ok(estText(PROSE) === legacy(PROSE), 'b 关:散文样本与两桶精确一致(整数值 ===)');
{
  const withArgs = est([{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: BIG_ARGS } }] }]);
  const noArgs = est([{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{}' } }] }]);
  const delta = withArgs - noArgs;
  const expectedDelta = (BIG_ARGS.length - 2) / 3.6; // '{}' baseline,两桶口径(autocompact 同款 ±15%)
  ok(delta > expectedDelta * 0.85 && delta < expectedDelta * 1.15, `b 关:tool_calls arguments 按 ÷3.6 换算(delta ${delta} ≈ ${Math.round(expectedDelta)})`);
}
{
  const withImg = est([{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:x' } }] }]);
  const noImg = est([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  ok(withImg - noImg === 1100, 'b 关:image part 固定 +1100(autocompact 同款)');
}

// ── (c) 开关开:分桶生效 ─────────────────────────────────────────────────────
setEstimateBucketsV1(true);
ok(estText(PROSE) === legacy(PROSE), 'b/c text 桶样本开/关逐字节一致(===,同一 ÷3.6 路径)');
ok(classifyTextForEstimate(BIG_ARGS) === 'json', 'c JSON.parse 成功 → json 桶');
ok(classifyTextForEstimate(CODE_SAMPLE) === 'code', 'c 代码信号(缩进+标点+关键字)→ code 桶');
ok(classifyTextForEstimate(PROSE) === 'text', 'c 散文 → text 桶');
ok(classifyTextForEstimate(BIG_JSON) === 'json', 'd 采样截断的大 JSON 由结构密度兜底 → json 桶');
ok(classifyTextForEstimate(CJK_JSON) === 'json', 'c CJK 混合 JSON → json 桶');
{
  const jsonEst = estText(BIG_ARGS), codeEst = estText(CODE_SAMPLE);
  ok(Math.abs(jsonEst - BIG_ARGS.length / 2.8) <= ROUND, 'c json 桶 ascii ÷2.8(±取整)');
  ok(Math.abs(codeEst - CODE_SAMPLE.length / 3.2) <= ROUND, 'c code 桶 ascii ÷3.2(±取整)');
  ok(jsonEst > BIG_ARGS.length / 3.6, 'c 同长 JSON 估算 > text 桶(JSON token 密度更高)');
}
ok(Math.abs(estText(CJK_JSON) - ((CJK_JSON.length - 3) / 2.8 + 3 / 1.5)) <= ROUND, 'c CJK 混合:ascii 部分走 json ÷2.8、CJK 部分恒 ÷1.5');
ok(estText(CJK300) === 300 / 1.5, 'c 纯 CJK 开时仍精确 = len/1.5(各桶 CJK 一致)');
{
  const withImg = est([{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:x' } }] }]);
  const noImg = est([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  ok(withImg - noImg === 1100, 'f 开时 image part 仍固定 +1100(不受开关影响)');
}
{
  // f) 同一入口:tool_calls arguments(JSON)在开关开时命中 json 桶,差值按 ÷2.8 而非 ÷3.6。
  const withArgs = est([{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: BIG_ARGS } }] }]);
  const noArgs = est([{ role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file_read', arguments: '{}' } }] }]);
  const delta = withArgs - noArgs; // '{}' 也进 json 桶,差值 = (|BIG_ARGS| - 2) / 2.8(±双端取整)
  const expectedDelta = (BIG_ARGS.length - 2) / 2.8;
  ok(Math.abs(delta - expectedDelta) <= 1, `f tool_calls arguments 命中 json 桶(delta ${delta} ≈ ${expectedDelta.toFixed(1)},按 ÷2.8)`);
}

// ── (d) 短串/空串/非字符串安全 ──────────────────────────────────────────────
ok(classifyTextForEstimate('') === 'text', 'd 空串 → text');
ok(classifyTextForEstimate(null) === 'text' && classifyTextForEstimate(123) === 'text' && classifyTextForEstimate({}) === 'text', 'd 非字符串 → text');
ok(classifyTextForEstimate('{}') === 'json', 'd 短串 "{}" JSON.parse 成 → json');
ok(est([{ role: 'user', content: null }, { role: 'user' }, null, { role: 'user', content: '' }]) >= 0, 'd 异常形态历史估算不抛错');
ok(est('not-an-array') === 0, 'd 非数组历史 → 0(现状语义不动)');

// ── (e) 阈值边界 ────────────────────────────────────────────────────────────
{
  const atThreshold = '{}'.repeat(10) + 'a'.repeat(380); // 结构密度 20/400 = 0.05(恰好阈值)
  const belowThreshold = '{}'.repeat(9) + 'bb' + 'a'.repeat(380); // 结构密度 18/400 = 0.045(低一丝)
  ok(atThreshold.length === 400 && (atThreshold.match(/[{}[\]":,]/g) || []).length === 20, 'e 边界样本构造自检(400 字符 / 20 结构符)');
  ok(classifyTextForEstimate(atThreshold) === 'json', 'e 结构密度恰好 0.05 → json(≥ 阈值)');
  ok(classifyTextForEstimate(belowThreshold) === 'text', 'e 结构密度低一丝 → 落穿评分(仅标点信号 2 < 3)→ text');
}
{
  // 代码评分:缩进/标点/关键字各 +2,threshold=3 → 单信号(2)不判 code,双信号(≥4)判 code。
  const kwOnly = 'function return const'; // 3 关键字、单行无缩进、无代码标点 → score 2
  const kwAndIndent = 'function f() {\n  return 1;\n  const x = 2;\n}'; // 缩进 + 标点 + 关键字 → score 6
  ok(classifyTextForEstimate(kwOnly) === 'text', 'e 代码评分 2(单信号)< 3 → text');
  ok(classifyTextForEstimate(kwAndIndent) === 'code', 'e 代码评分 6(三信号)≥ 3 → code');
}

// ── (H) 项目真实历史 A/B 回放 ────────────────────────────────────────────────
// 历史 checkpoint 不保存 provider usage，故本段验证确定性估算行为（分桶命中与单调上调），
// 不把它误表述为真实 token 误差结论。固定样本覆盖 24/25/26/27/28/30/31/32/33 九个快照。
{
  const histDir = path.resolve(__dirname, 'realhist-fixtures', 'checkpoints', 'sess_fe3de15dfc3b8354');
  const histFiles = [24, 25, 26, 27, 28, 30, 31, 32, 33].map(n => path.join(histDir, `history-${n}.json.gz`));
  if (!histFiles.every(fs.existsSync)) {
    console.log('SKIP H 项目真实历史夹具缺失(不影响白盒门)');
  } else {
    let oldTotal = 0, newTotal = 0, jsonFields = 0, parsed = 0;
    const everyRaised = histFiles.every(file => {
      const history = JSON.parse(zlib.gunzipSync(fs.readFileSync(file), 'utf8'));
      parsed++;
      setEstimateBucketsV1(false); const oldEstimate = est(history);
      setEstimateBucketsV1(true); const newEstimate = est(history);
      for (const message of history) {
        if (!message || typeof message !== 'object') continue;
        for (const value of [message.content, message.reasoning_content, message.arguments, message.output]) {
          if (typeof value === 'string' && classifyTextForEstimate(value) === 'json') jsonFields++;
        }
        for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
          const fn = call && call.function;
          if (fn && typeof fn.arguments === 'string' && classifyTextForEstimate(fn.arguments) === 'json') jsonFields++;
        }
      }
      oldTotal += oldEstimate; newTotal += newEstimate;
      return newEstimate >= oldEstimate;
    });
    ok(parsed === 9, 'H1 读取 9 份项目真实历史 checkpoint');
    ok(everyRaised, 'H2 每份真实历史开启分桶后估算不低于两桶基线');
    ok(jsonFields > 0, 'H3 真实历史中的结构化载荷命中 json 桶');
    ok(newTotal > oldTotal && (newTotal - oldTotal) / oldTotal >= 0.10,
      `H4 汇总估算上调结构化缺口(${oldTotal} → ${newTotal}, +${(((newTotal - oldTotal) / oldTotal) * 100).toFixed(1)}%)`);
  }
}

setEstimateBucketsV1(false); // 复位镜像(同进程后续 require 方不受污染)

console.log('');
if (fail) { console.log(`ESTIMATE-BUCKETS E2E: FAIL (${fail})`); process.exit(1); }
console.log('ESTIMATE-BUCKETS E2E: ALL PASS');
