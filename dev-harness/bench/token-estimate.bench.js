#!/usr/bin/env node
'use strict';
// 性能批基准(不进回归门,只打印):回合起点的整段历史 token 估算。
// 每个 API 迭代前 runOpenAiTurn 至少估两遍整段历史(maybeAutoCompact 里 CompactionPlan.create + calibratedEstimate,
// 之后 lastEstBeforeCall 再估一遍);会话每回合从盘上重读(loadSession = 新对象、新字符串)。本件按这个形状模拟:
//   冷估  —— 进程第一次见到这段历史(记忆表全空)
//   重读  —— 每回合:JSON 往返造一份新对象(同 loadSession),追加 2 条新消息,再走一遍回合起点
//   同回合 —— 不重读,第二个 API 迭代前再走一遍(对象原样)
// 末行打印估算值指纹,改前改后应逐字相同(估算逐位不变的旁证;真正的等价证明在 unit/token-estimate-memo.test.js)。
// 用法: node dev-harness/bench/token-estimate.bench.js [消息数=2000] [回合数=5]
//      node --expose-gc dev-harness/bench/token-estimate.bench.js   (每段计时前先 GC,数字更稳)
//      node --cpu-prof --cpu-prof-dir=<dir> dev-harness/bench/token-estimate.bench.js
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const N = Number(process.argv[2] || 2000), TURNS = Number(process.argv[3] || 5);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-bench-est-'));
process.env.RUYI_HOME = HOME;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));

let seed = 20260930;
const rnd = () => { // mulberry32:可复现、分布均匀(LCG 低位周期短,会让消息体长短跟着消息序号起伏)
  seed = (seed + 0x6D2B79F5) >>> 0; let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = a => a[Math.floor(rnd() * a.length)];
const CJK = '上下文压缩估算会话历史工具结果模型回合预算窗口文件路径修改测试通过失败重试说明继续执行';
const WORDS = ['the', 'session', 'history', 'estimate', 'token', 'budget', 'window', 'tool', 'result', 'file', 'path', 'model', 'turn', 'compact', 'summary'];
const cjkText = n => { let s = ''; while (s.length < n) s += CJK[Math.floor(rnd() * CJK.length)] + (rnd() < 0.08 ? '，' : ''); return s; };
const prose = n => { let s = ''; while (s.length < n) s += pick(WORDS) + (rnd() < 0.1 ? '. ' : ' '); return s; };
const code = n => {
  const lines = []; let len = 0, i = 0;
  while (len < n) {
    const l = pick([
      `function f${i}(a, b) {`, `  const x${i} = a + b * ${i};`, `  if (x${i} > 10) return x${i};`, '  for (let k = 0; k < n; k++) acc += k;',
      `  await load('${pick(WORDS)}');`, '}', `export const k${i} = () => ${i};`, `// ${prose(30)}`, `class C${i} extends Base {}`,
    ]);
    lines.push(l); len += l.length + 1; i++;
  }
  return lines.join('\n');
};
function makeHistory(n) {
  const h = [];
  for (let i = 0; i < n; i++) {
    const r = i % 4;
    if (r === 0) h.push({ role: 'user', content: rnd() < 0.6 ? cjkText(200 + rnd() * 600) : prose(200 + rnd() * 800) });
    else if (r === 1) {
      const id = 'call_' + i;
      h.push({ role: 'assistant', content: prose(300 + rnd() * 1500) + '\n```js\n' + code(400 + rnd() * 1600) + '\n```\n' + cjkText(100 + rnd() * 300),
        reasoning_content: rnd() < 0.3 ? prose(500 + rnd() * 1500) : undefined,
        tool_calls: [{ id, type: 'function', function: { name: pick(['file_read', 'bash', 'file_write', 'grep']), arguments: JSON.stringify({ path: 'src/' + pick(WORDS) + '/' + i + '.js', command: prose(40) }) } }] });
    } else if (r === 2) {
      const body = rnd() < 0.5 ? code(5000 + rnd() * 32000) : prose(1000 + rnd() * 6000) + cjkText(200 + rnd() * 1500);
      h.push({ role: 'tool', tool_call_id: 'call_' + (i - 1), content: JSON.stringify({ ok: true, path: 'src/x' + i + '.js', content: body }) });
    } else h.push({ role: 'assistant', content: cjkText(100 + rnd() * 400) + '\n' + prose(200 + rnd() * 800) });
  }
  return h;
}

srv.setEstimateBucketsV1(srv.estimateBucketsEnabled(srv.defaultConfig())); // 默认开(与 runOpenAiTurn 入口同)
const config = srv.defaultConfig();
const provider = { id: 'bench', label: 'bench', model: 'bench-model', contextWindow: 1000000 };
const sys = 'You are a coding agent. ' + prose(20000) + cjkText(4000);
const tools = Array.from({ length: 40 }, (_, i) => ({ type: 'function', function: { name: 'tool_' + i, description: prose(300), parameters: { type: 'object', properties: { path: { type: 'string', description: prose(60) }, n: { type: 'number' } }, required: ['path'] } } }));

// 预热:先在另一段(内容不同的)历史上估几遍,让估算函数进 JIT —— 常驻服务里它们早就热了;
// 「冷估」要量的是【第一次见到这段内容】,不是解释器首跑。
{ const warm = makeHistory(400); for (let i = 0; i < 5; i++) srv.estimateHistoryTokens(JSON.parse(JSON.stringify(warm)), 'warm', []); }
let history = makeHistory(N);
const bytes = Buffer.byteLength(JSON.stringify(history));
const values = [];
function turnStart(h) {
  const t0 = performance.now();
  const plan = srv.CompactionPlan.create({ scope: 'main', trigger: 'auto', history: h, provider, model: provider.model, config, conversationWindow: true });
  const t1 = performance.now();
  const a = srv.calibratedEstimate(provider, provider.model, [{ role: 'system', content: sys }, ...h], tools);
  const t2 = performance.now();
  const b = srv.estimateHistoryTokens([{ role: 'system', content: sys }, ...h], '', tools);
  const t3 = performance.now();
  values.push(plan.boundary, a, b);
  return { plan: t1 - t0, calibrated: t2 - t1, beforeCall: t3 - t2, total: t3 - t0 };
}
const fmt = r => `total ${r.total.toFixed(1)} ms (plan ${r.plan.toFixed(1)} · calibratedEstimate ${r.calibrated.toFixed(1)} · lastEstBeforeCall ${r.beforeCall.toFixed(1)})`;
console.log(`history: ${history.length} msgs, ${(bytes / 1048576).toFixed(1)} MB JSON, system ${sys.length} chars, ${tools.length} tools`);
const settle = () => { if (typeof global.gc === 'function') global.gc(); }; // --expose-gc 时先把造数据的垃圾收掉,冷估数字不被 GC 抖动淹没
settle();
console.log('cold            ' + fmt(turnStart(history)));
const steady = [];
for (let t = 0; t < TURNS; t++) {
  history = JSON.parse(JSON.stringify(history)); // loadSession:新对象、新字符串
  history.push({ role: 'user', content: cjkText(300) + ' turn ' + t }, { role: 'assistant', content: prose(800) + '\n' + code(600) });
  settle();
  const r1 = turnStart(history);
  const r2 = turnStart(history); // 同回合第二个 API 迭代
  steady.push(r1.total);
  console.log(`turn ${t} reload  ${fmt(r1)}`);
  console.log(`turn ${t} iter2   ${fmt(r2)}`);
}
steady.sort((x, y) => x - y);
if (steady.length) console.log(`steady reload-turn median: ${steady[Math.floor(steady.length / 2)].toFixed(1)} ms`);
console.log('estimate fingerprint: ' + crypto.createHash('sha256').update(values.join(',')).digest('hex').slice(0, 16) + ' [' + values.slice(0, 3).join(',') + ']');
fs.rmSync(HOME, { recursive: true, force: true });
