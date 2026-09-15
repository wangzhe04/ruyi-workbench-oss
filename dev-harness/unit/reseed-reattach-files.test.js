'use strict';
// 126-111c(25 号文 §1.2 / 44 号文 §4):重播种后把最近读过的文件有界重附回去。
// 真源码、临时存储、零模型请求、**零磁盘读取**。
//
// 现状:L2 把整段历史换成「摘要 user ＋ 一句收到 ＋ 尾部」。摘要里也许写着「改了 a.js 的第 40 行」,
// 但文件长什么样已经不在上下文里 —— 模型下一步要么凭记忆改、要么把同一个文件再读一遍。
//
// 每一条判据都是照「**没有它屏上会有什么不同**」写的(本会话四次反向不红的教训):
//   [A] 开关关 -> recentFiles 恒空,且 reseed 结果与今天**逐字节相同**。
//   [B] 同一个文件读过多次 -> 只带**最新**那一次;已被蒸发/换成指针的读取**跳过**
//       (它本来就不在模型眼前了,重附它是凭空塞回来)。
//   [C] 有界:头部行数、文件数、token 预算三道都真的在收。
//   [D] 形状:文件段**并进摘要那一条 user**,重播种结果里**没有两条连着的 user**。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-reattach-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
const rules = require(path.join(app, 'src', 'context-governance-rules.json')).compactionPlan;
after(() => fs.rmSync(root, { recursive: true, force: true }));

const lines = (tag, n) => Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join('\n');
const readResult = (p, body) => JSON.stringify({ ok: true, path: p, content: body, size: body.length });

function historyWith(reads) {
  const h = [{ role: 'user', content: '读几个文件然后改一处' }];
  reads.forEach(([p, body], i) => {
    h.push({ role: 'assistant', content: null, tool_calls: [{ id: `f${i}`, type: 'function', function: { name: 'file_read', arguments: '{}' } }] });
    // `p === null` = 这一条工具结果**原样**放进去(用来造「已蒸发的占位」「ok:false 的失败读取」
    // 这类夹具)。第一版没有这个口子,失败读取被 readResult 又包了一层 ok:true —— 于是 B5 量的是
    // 「包装之后的东西」,不是失败读取本身(夹具错,不是实现错)。
    h.push({ role: 'tool', tool_call_id: `f${i}`, content: p === null ? body : readResult(p, body) });
  });
  h.push({ role: 'assistant', content: '看完了' });
  return h;
}
const planOf = (history, config, window) => srv.CompactionPlan.create({
  scope: 'main', trigger: 'auto', history, config,
  provider: { id: 'p', model: 'm', contextWindow: window }, model: 'm',
});
const BIG_WINDOW = 400000;

test('126-111c · 重播种后重附最近读过的文件', () => {
  let fail = 0;
  const ok = (cond, label) => { if (cond) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

  const H = historyWith([['a.js', lines('A', 200)], ['b.js', lines('B', 200)], ['a.js', lines('A2', 200)]]);

  // ── [A] 开关关 = 零注入,逐字节等价今天 ──────────────────────────────────────────────
  ok(srv.reseedReattachFilesEnabled({}) === false, 'A1 缺省不生效');
  ok(srv.reseedReattachFilesEnabled({ runtimeReseedReattachFilesV1: 'true' }) === false, 'A2 字符串 "true" 不生效');
  {
    const off = planOf(H, {}, BIG_WINDOW);
    ok(Array.isArray(off.recentFiles) && off.recentFiles.length === 0, `A3 开关关:recentFiles 恒空(实得 ${off.recentFiles.length})`);
    const offReseed = srv.CompactionPlan.reseed(off, 'SUMMARY');
    const offExplicit = srv.CompactionPlan.reseed(planOf(H, { runtimeReseedReattachFilesV1: false }, BIG_WINDOW), 'SUMMARY');
    ok(JSON.stringify(offReseed) === JSON.stringify(offExplicit), 'A4 显式 false 与缺省逐字节相同');
    ok(!offReseed[0].content.includes('最近读过的文件'), 'A5 开关关时重播种结果里**一个字**都没多');
  }

  // ── [B] 最新那一次 ＋ 跳过已经不在眼前的 ───────────────────────────────────────────
  {
    const on = planOf(H, { runtimeReseedReattachFilesV1: true }, BIG_WINDOW);
    const paths = on.recentFiles.map(f => f.path);
    ok(paths.length === 2 && new Set(paths).size === 2, `B1 同一个文件读过两次也只占一格(实得 ${JSON.stringify(paths)})`);
    const a = on.recentFiles.find(f => f.path === 'a.js');
    ok(a && a.head.startsWith('A2 line 0'), `B2 带的是**最新**那一次的内容,不是最早那次(实得「${a && a.head.slice(0, 12)}」)`);
    ok(paths[0] === 'a.js', `B3 最近读的排最前(实得 ${paths[0]})`);
  }
  {
    // 已被蒸发的读取:内容是占位符,不是 JSON —— 必须跳过。没跳过的话,重播种里会出现一段
    // 「[已省略:…」的垃圾,那既不是文件也不是摘要。
    const evaporated = historyWith([[null, '[已省略:{"ok":true,"path":"c.js","content":"xxx"']]);
    const on = planOf(evaporated, { runtimeReseedReattachFilesV1: true }, BIG_WINDOW);
    ok(on.recentFiles.length === 0, `B4 已蒸发的读取跳过(实得 ${on.recentFiles.length} 个)`);
  }
  {
    // 失败的读取(ok:false)也不算 —— 重附一个「文件不存在」没有意义。
    const failed = historyWith([[null, JSON.stringify({ ok: false, error: '文件不存在', path: 'd.js' })]]);
    const on = planOf(failed, { runtimeReseedReattachFilesV1: true }, BIG_WINDOW);
    ok(on.recentFiles.length === 0, `B5 失败的读取不参与重附(实得 ${on.recentFiles.length} 个)`);
  }

  // ── [C] 有界 ─────────────────────────────────────────────────────────────────────
  {
    const on = planOf(H, { runtimeReseedReattachFilesV1: true }, BIG_WINDOW);
    const a = on.recentFiles.find(f => f.path === 'a.js');
    const headLines = a.head.split('\n').length;
    ok(headLines === rules.reattachHeadLines, `C1 每个文件只带头部 ${rules.reattachHeadLines} 行(实得 ${headLines};不截的话整份文件会被塞回去)`);
    ok(!a.head.includes(`A2 line ${rules.reattachHeadLines}`), 'C1b 第 41 行确实没带进来(反过来验 C1 不是空断言)');
  }
  {
    // 文件数上限:读 20 个不同文件,只带得下 reattachMaxFiles 个。
    const many = historyWith(Array.from({ length: 20 }, (_, i) => [`f${i}.js`, lines('X', 5)]));
    const on = planOf(many, { runtimeReseedReattachFilesV1: true }, BIG_WINDOW);
    ok(on.recentFiles.length === rules.reattachMaxFiles, `C2 文件数封顶 ${rules.reattachMaxFiles}(实得 ${on.recentFiles.length})`);
  }
  {
    // token 预算:窗口压到很小时,整块要跟着缩(但至少带一个,不能一紧就整块消失)。
    const tiny = planOf(H, { runtimeReseedReattachFilesV1: true }, 2000);
    const roomy = planOf(H, { runtimeReseedReattachFilesV1: true }, BIG_WINDOW);
    ok(tiny.recentFiles.length >= 1, `C3 预算再紧也至少带一个(实得 ${tiny.recentFiles.length})`);
    ok(tiny.recentFiles.length <= roomy.recentFiles.length, `C4 预算小时带得不比预算大时多(${tiny.recentFiles.length} ≤ ${roomy.recentFiles.length})`);
  }

  // ── [D] 形状 ─────────────────────────────────────────────────────────────────────
  {
    const on = planOf(H, { runtimeReseedReattachFilesV1: true }, BIG_WINDOW);
    const reseeded = srv.CompactionPlan.reseed(on, 'SUMMARY');
    ok(reseeded[0].role === 'user' && reseeded[0].content.includes('最近读过的文件'),
      'D1 文件段**并进摘要那一条 user**(不单列一条)');
    ok(reseeded[0].content.includes('--- a.js ---') && reseeded[0].content.includes('--- b.js ---'),
      'D1b 两个文件都带了路径小标题(模型看得出哪段是哪个文件)');
    ok(reseeded[1].role === 'assistant', 'D2 第二条仍是那句「收到」(形状没被挪位)');
    let consecutiveUsers = 0;
    for (let i = 1; i < reseeded.length; i++) {
      if (reseeded[i].role === 'user' && reseeded[i - 1].role === 'user') consecutiveUsers++;
    }
    ok(consecutiveUsers === 0, `D3 重播种结果里**没有两条连着的 user**(实得 ${consecutiveUsers} 处)`);
  }
  {
    // D3 单独用上面那个夹具是**不承重**的:那一档 boundary===0 -> kept 为空,于是「单列一条 user」
    // 的反向也排不出两条连续 user(反向当场逮到,本会话第五次同一族)。这里补一个 **kept 非空** 的
    // 夹具:多个 user 回合 ＋ 窗口卡在中间,保留段以 user 打头 —— 这时文件段一旦单列,
    // 它后面紧跟着的就是 kept 的首条 user,两条连续 user 立刻出现。
    const multi = [];
    for (let t = 0; t < 6; t++) {
      multi.push({ role: 'user', content: `第 ${t} 件事` });
      multi.push({ role: 'assistant', content: null, tool_calls: [{ id: `g${t}`, type: 'function', function: { name: 'file_read', arguments: '{}' } }] });
      multi.push({ role: 'tool', tool_call_id: `g${t}`, content: readResult(`g${t}.js`, lines('G', 60)) });
      multi.push({ role: 'assistant', content: `第 ${t} 件做完了` });
    }
    const window = Math.floor(srv.estimateHistoryTokens(multi) * 0.8);
    const plan = planOf(multi, { runtimeReseedReattachFilesV1: true }, window);
    const reseeded = srv.CompactionPlan.reseed(plan, 'SUMMARY');
    ok(plan.kept.length > 0 && plan.kept[0].role === 'user',
      `D4 夹具自检:这一档 kept 非空且以 user 打头(kept ${plan.kept.length} 条、首条 ${plan.kept[0] && plan.kept[0].role})`);
    ok(plan.recentFiles.length > 0, `D4b 夹具自检:这一档确实带了文件(实得 ${plan.recentFiles.length} 个)`);
    let consec = 0;
    for (let i = 1; i < reseeded.length; i++) {
      if (reseeded[i].role === 'user' && reseeded[i - 1].role === 'user') consec++;
    }
    ok(consec === 0, `D4c **kept 非空时也没有两条连着的 user**(实得 ${consec} 处;文件段一旦单列一条,这里立刻红)`);
  }

  console.log('\nRESEED REATTACH FILES UNIT: ' + (fail ? `${fail} FAILURE(S)` : 'ALL PASS'));
  assert.equal(fail, 0, `${fail} 条判据未通过`);
});
