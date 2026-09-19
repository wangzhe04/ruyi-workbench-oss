// Unit: 第 116 波 116-pre(27 号文 §8.12「递话：交给线程的交互」/ §11.1 第 3 项/ §11.3)——
// 递话预判纯函数 prerouteText 的穷举。零模型、零磁盘、纯函数——每条用例只构造 index/memory 字面量,
// 不起服务、不建会话。
//
// 覆盖(§11.3 116-pre 行「新增 unit/steward-preroute.test.js」列出的用例清单,逐条对应):
//   ① 空串 -> steward
//   ② 定时意图(含交付物原例「明天 9 点提醒我交周报」必须是 schedule,不能因为「周报」命中线程)
//   ③ 问句(交付物原例「现在哪条最烧钱」-> question)
//   ④ 单线程命中(title 命中,3 倍权重)
//   ⑤ 短语命中(「周报-W36」整段,+3 分)
//   ⑥ 记忆加权改变排序(两条本来会打平的线程,记忆条目提到其中一条的标题后不再打平)
//   ⑦ 两名并列 -> unsure(分差 < unsureRatio 阈值)
//   ⑧ 全不命中陈述句 -> new
//   ⑨ 尖括号中和(hit.title/reason 里的 </> 变成 []/[])
//   ⑩ 超长 q(500 字硬顶——夹断点之后的内容不参与打分)
//   ⑪ 116-5b:hit 带 displayTitle(递送候选列表显示它),而打分那一侧仍只吃原话 title
//
// 与既有 dev-harness/unit 件同款约定(见 steward-core.test.js):require server.js 前先把
// WIN_CLAUDE_WORKBENCH_HOME 覆盖到临时目录;PASS/FAIL 逐条打印,process.exit(fail?1:0)。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-preroute-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const repo = path.resolve(__dirname, '../..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const srv = require(path.join(app, 'server.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const { prerouteText, STEWARD_PREROUTE_DEFAULTS } = srv;

const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const RECENT = new Date(NOW - 3600 * 1000).toISOString();          // 1 小时前:算「近期」
const OLD = new Date(NOW - 30 * 24 * 3600 * 1000).toISOString();   // 30 天前:不算「近期」
const opts = { now: NOW };

function row(sessionId, over) {
  return Object.assign({
    sessionId, missionId: sessionId, missionTitle: '', title: '', summary: '', state: 'running', updatedAt: OLD,
  }, over || {});
}

/* ═══════════════════════ ① 空串 -> steward ═══════════════════════ */
{
  const r1 = prerouteText('', [], [], opts);
  ok(r1.kind === 'steward' && Array.isArray(r1.hits) && r1.hits.length === 0, '① 空串 -> steward,hits 为空');
  const r2 = prerouteText('   ', [row('s1', { title: '任意' })], [], opts);
  ok(r2.kind === 'steward', '① 纯空白(去空白后为空)-> steward,不因为 index 非空就走词法');
  ok(prerouteText(null, [], [], opts).kind === 'steward', '① null 入参不抛异常,按空串处理');
  ok(prerouteText(undefined, [], [], opts).kind === 'steward', '① undefined 入参不抛异常,按空串处理');
}

/* ═══════════════════════ ② 定时意图 -> schedule(优先于线程命中) ═══════════════════════ */
{
  const idx = [row('s1', { title: '周报', updatedAt: RECENT })];
  const r = prerouteText('明天9点提醒我交周报', idx, [], opts);
  ok(r.kind === 'schedule' && r.hits.length === 0, '② 交付物原例「明天9点提醒我交周报」-> schedule(不是命中「周报」线程)');
  ok(prerouteText('每天早上八点跑一遍', idx, [], opts).kind === 'schedule', '② 「每天」触发 schedule');
  ok(prerouteText('每周一交周报', idx, [], opts).kind === 'schedule', '② 「每周」触发 schedule(即便「周报」也在句中)');
  ok(prerouteText('每月底对账', idx, [], opts).kind === 'schedule', '② 「每月」触发 schedule');
  ok(prerouteText('定时跑一下这个脚本', idx, [], opts).kind === 'schedule', '② 「定时」触发 schedule');
  ok(prerouteText('后天下午3点开会', idx, [], opts).kind === 'schedule', '② 「后天…点」触发 schedule');
  ok(prerouteText('9点交周报', idx, [], opts).kind === 'schedule', '② 裸「N 点」触发 schedule');
  ok(prerouteText('周报交了吗', idx, [], opts).kind !== 'schedule', '② 不含定时词的句子不误判为 schedule(对照组)');
}

/* ═══════════════════════ ③ 问句 -> question ═══════════════════════ */
{
  const r = prerouteText('现在哪条最烧钱', [], [], opts);
  ok(r.kind === 'question' && r.hits.length === 0, '③ 交付物原例「现在哪条最烧钱」-> question');
  ok(prerouteText('这周花了多少钱', [], [], opts).kind === 'question', '③ 含「多少」-> question');
  ok(prerouteText('这是不是已经做完了', [], [], opts).kind === 'question', '③ 含「是不是」-> question');
  ok(prerouteText('能不能帮我看看', [], [], opts).kind === 'question', '③ 含「能不能」-> question');
  ok(prerouteText('这个真的靠谱吗', [], [], opts).kind === 'question', '③ 「吗」收尾 -> question');
  ok(prerouteText('还在等着呢', [], [], opts).kind === 'question', '③ 「呢」收尾 -> question');
  ok(prerouteText('这个怎么样？', [], [], opts).kind === 'question', '③ 问号 -> question');
  ok(prerouteText('这个怎么样?', [], [], opts).kind === 'question', '③ 半角问号同样算问句');
}

/* ═══════════════════════ ④ 单线程命中(title 命中,权重 ×3) ═══════════════════════ */
{
  const idx = [
    row('s_target', { title: '支付网关重构', updatedAt: RECENT }),
    row('s_other', { title: '首页改版', updatedAt: OLD }),
  ];
  const r = prerouteText('帮我看看支付网关重构的进度', idx, [], opts);
  ok(r.kind === 'thread', '④ 单线程 title 命中 -> thread');
  ok(r.hits.length === 1 && r.hits[0].sessionId === 's_target', '④ 命中的是 title 匹配的那条线程,不是无关的那条');
  ok(typeof r.hits[0].reason === 'string' && r.hits[0].reason.length > 0, '④ reason 非空');
  ok(r.hits[0].reason.includes('命中词'), '④ reason 说明命中了哪些词');
  ok(r.hits[0].score >= STEWARD_PREROUTE_DEFAULTS.minScore, '④ 命中分数不低于 minScore(能落进 thread 分支的前提)');
}

/* ═══════════════════════ ⑤ 短语命中(「周报-W36」整段,+3 分) ═══════════════════════ */
{
  const idx = [row('s_phrase', { title: '周报-W36', updatedAt: RECENT })];
  const withPhrase = prerouteText('帮我看下「周报-W36」的进度', idx, [], opts);
  ok(withPhrase.kind === 'thread' && withPhrase.hits[0].sessionId === 's_phrase', '⑤ 「」引号短语命中 -> thread');
  ok(withPhrase.hits[0].reason.includes('短语命中'), '⑤ reason 标注短语命中');
  // 对照组:去掉引号,只留词法命中,分数应严格更低(短语加分被拿掉)。
  const withoutPhrase = prerouteText('帮我看下周报-W36的进度', idx, [], opts);
  ok(withoutPhrase.hits[0].score < withPhrase.hits[0].score, '⑤ 短语命中的分数严格高于纯词法命中(证明短语加分生效)');
  // 直双引号也认。
  const straightQuote = prerouteText('帮我看下"周报-W36"的进度', idx, [], opts);
  ok(straightQuote.hits[0].reason.includes('短语命中'), '⑤ 直双引号包裹的短语同样命中');
}

/* ═══════════════════════ ⑥ 记忆加权改变排序 ═══════════════════════ */
{
  const idx = [
    row('s_a', { title: '月报告', updatedAt: RECENT }),
    row('s_b', { title: '周报告', updatedAt: RECENT }),
  ];
  const tie = prerouteText('报告', idx, [], opts);
  ok(tie.kind === 'unsure', '⑥ 前置断言:无记忆时两条线程打平 -> unsure(为下面的「记忆改变排序」做对照)');

  const memory = [{ kind: 'habit', text: '用户每周三整理月报告的进度并发给经理' }];
  const weighted = prerouteText('报告', idx, memory, opts);
  ok(weighted.kind === 'thread', '⑥ 记忆提到「月报告」后不再打平 -> thread(排序被记忆加权改变)');
  ok(weighted.hits[0].sessionId === 's_a', '⑥ 命中的是记忆条目提到的那条线程(月报告),不是另一条');
  ok(weighted.hits[0].reason.includes('记忆加权'), '⑥ reason 标注记忆加权');

  // kind 白名单:非 focus/habit 的记忆条目(如 profile)不参与加权,排序应该维持打平。
  const wrongKind = prerouteText('报告', idx, [{ kind: 'profile', text: '用户每周三整理月报告的进度' }], opts);
  ok(wrongKind.kind === 'unsure', '⑥ 记忆条目 kind 不在 focus/habit 白名单内 -> 不加权,仍然 unsure');
}

/* ═══════════════════════ ⑦ 两名并列 -> unsure ═══════════════════════ */
{
  const idx = [
    row('s_x', { title: '周报告', updatedAt: RECENT }),
    row('s_y', { title: '月报告', updatedAt: RECENT }),
  ];
  const r = prerouteText('报告', idx, [], opts);
  ok(r.kind === 'unsure', '⑦ 两条线程分数打平 -> unsure');
  ok(r.hits.length === 2, '⑦ unsure 给前两名');
  ok(r.hits[0].score === r.hits[1].score, '⑦ 两名分数相等(打平场景)');
  // 确定性:同分按 sessionId 升序,s_x < s_y。
  ok(r.hits[0].sessionId === 's_x' && r.hits[1].sessionId === 's_y', '⑦ 同分排序按 sessionId 升序,结果确定');
}

/* ═══════════════════════ ⑧ 全不命中陈述句 -> new ═══════════════════════ */
{
  const idx = [row('s1', { title: '支付网关重构', updatedAt: OLD })];
  const r = prerouteText('今天天气不错适合出门散步', idx, [], opts);
  ok(r.kind === 'new' && r.hits.length === 0, '⑧ 与任何线程都不相关的陈述句 -> new');
  ok(prerouteText('随便写点笔记留着以后看', [], [], opts).kind === 'new', '⑧ 空 index 时的陈述句同样 -> new');
}

/* ═══════════════════════ ⑨ 尖括号中和 ═══════════════════════ */
{
  const idx = [row('s_xss', { title: '<script>alert(1)</script>', updatedAt: RECENT })];
  const r = prerouteText('script alert', idx, [], opts);
  ok(r.kind === 'thread', '⑨ 前置:确实命中了那条恶意标题的线程');
  ok(!r.hits[0].title.includes('<') && !r.hits[0].title.includes('>'), '⑨ hit.title 里的尖括号已被中和');
  ok(r.hits[0].title.includes('＜script＞') && !/[<>]/.test(r.hits[0].title), '⑨ 尖括号中和成全角尖括号(与 stewardSanitizeText 同一纪律;128f 起不再是方括号)');
  ok(!r.hits[0].reason.includes('<') && !r.hits[0].reason.includes('>'), '⑨ reason 里也不含尖括号');
}

/* ═══════════════════════ ⑩ 超长 q(500 字硬顶) ═══════════════════════ */
{
  const idx = [row('s_far', { title: '罕见关键词零点七', updatedAt: RECENT })];
  // 把命中词塞在第 600 个字符处(超出 500 字硬顶),前 500 字全是无关噪声。
  const noise = '噪'.repeat(500);
  const longQ = noise + '罕见关键词零点七';
  const r = prerouteText(longQ, idx, [], opts);
  ok(r.kind !== 'thread', '⑩ 超长 q 里 500 字硬顶之后的内容不参与打分(命中词被夹断)');
  // 对照组:命中词放在前 500 字以内,应该正常命中。
  const shortEnoughQ = '罕见关键词零点七' + '噪'.repeat(500);
  const r2 = prerouteText(shortEnoughQ, idx, [], opts);
  ok(r2.kind === 'thread' && r2.hits[0].sessionId === 's_far', '⑩ 命中词在 500 字硬顶以内时正常命中(对照组证明夹断确实发生在裁切点而不是算法本身失效)');
  // 纯粹超长但无意义(10000 字)不应抛异常。
  let threw = false;
  try { prerouteText('无'.repeat(10000), idx, [], opts); } catch { threw = true; }
  ok(!threw, '⑩ 10000 字的 q 不抛异常');
}

/* ═══════════ 补充:needs_you/stopped 状态加权(+0.5,§8.12「等你」优先) ═══════════ */
{
  const base = { title: '同名事项', summary: '', updatedAt: OLD }; // updatedAt=OLD -> 不吃「近期」的 +0.5,便于隔离状态加权
  const runningRow = row('s_running', Object.assign({}, base, { state: 'running' }));
  const needsYouRow = row('s_needsyou', Object.assign({}, base, { state: 'needs_you' }));
  const stoppedRow = row('s_stopped', Object.assign({}, base, { state: 'stopped' }));
  const doneRow = row('s_done', Object.assign({}, base, { state: 'done' }));
  const rNeeds = prerouteText('同名事项', [runningRow, needsYouRow], [], opts);
  ok(rNeeds.kind === 'unsure' || rNeeds.kind === 'thread', '状态加权:前置——两条同标题线程至少产出候选');
  const scoreOf = (result, sid) => (result.hits.find(h => h.sessionId === sid) || {}).score;
  // 直接用单线程场景量化分差,不依赖 unsure/thread 分支判定,更直白。
  const soloRunning = prerouteText('同名事项', [runningRow], [], opts).hits[0].score;
  const soloNeedsYou = prerouteText('同名事项', [needsYouRow], [], opts).hits[0].score;
  const soloStopped = prerouteText('同名事项', [stoppedRow], [], opts).hits[0].score;
  const soloDone = prerouteText('同名事项', [doneRow], [], opts).hits[0].score;
  ok(Math.abs((soloNeedsYou - soloRunning) - STEWARD_PREROUTE_DEFAULTS.stateBonus) < 1e-9,
    `needs_you 比 running 恰好多 stateBonus(=${STEWARD_PREROUTE_DEFAULTS.stateBonus})分(实测差值 ${soloNeedsYou - soloRunning})`);
  ok(Math.abs((soloStopped - soloRunning) - STEWARD_PREROUTE_DEFAULTS.stateBonus) < 1e-9,
    `stopped 比 running 恰好多 stateBonus 分(实测差值 ${soloStopped - soloRunning})`);
  ok(soloDone === soloRunning, 'done 状态不吃状态加权(与 running 同分)');
}

/* ═══════════ 补充:近期加权(24 小时内 +0.5,§8.12) ═══════════ */
{
  const recentRow = row('s_recent', { title: '近期事项', updatedAt: RECENT });
  const oldRow = row('s_old', { title: '近期事项', updatedAt: OLD });
  const recentScore = prerouteText('近期事项', [recentRow], [], opts).hits[0].score;
  const oldScore = prerouteText('近期事项', [oldRow], [], opts).hits[0].score;
  ok(Math.abs((recentScore - oldScore) - STEWARD_PREROUTE_DEFAULTS.recentBonus) < 1e-9,
    `24 小时内更新恰好多 recentBonus(=${STEWARD_PREROUTE_DEFAULTS.recentBonus})分(实测差值 ${recentScore - oldScore})`);
}

/* ═══════════ 补充:missionTitle(×2)与 summary(×1)权重低于 title(×3) ═══════════ */
{
  const titleHitRow = row('s_title', { title: '库存对账', updatedAt: OLD });
  const missionHitRow = row('s_mission', { missionTitle: '库存对账', updatedAt: OLD });
  const summaryHitRow = row('s_summary', { summary: '库存对账', updatedAt: OLD });
  const titleScore = prerouteText('库存对账', [titleHitRow], [], opts).hits[0].score;
  const missionScore = prerouteText('库存对账', [missionHitRow], [], opts).hits[0].score;
  const summaryScore = prerouteText('库存对账', [summaryHitRow], [], opts).hits[0].score;
  ok(titleScore > missionScore && missionScore > summaryScore,
    `title(×3) > missionTitle(×2) > summary(×1)权重梯度正确(实测 ${titleScore} > ${missionScore} > ${summaryScore})`);
}

/* ═══════ ⑪ 116-5b:hit.displayTitle 供递送候选列表显示,打分仍只看原话 title ═══════ */
{
  const RAW_TITLE = '帮我分析一下AMD——按美股超威半导体,今天收盘怎么样';
  const withBrief = row('s_brief', { title: RAW_TITLE, displayTitle: 'AMD 收盘分析', updatedAt: RECENT });
  const r = prerouteText('超威半导体', [withBrief], [], opts);
  ok(r.kind === 'thread' && r.hits[0].sessionId === 's_brief',
    '⑪ 用户打的是原话里的词(「超威半导体」)——它必须还能命中(打分吃的是 title,不是压过的名字)');
  ok(r.hits[0].title === RAW_TITLE, '⑪ hit.title 仍是原话');
  ok(r.hits[0].displayTitle === 'AMD 收盘分析', '⑪ hit.displayTitle 是显示名(输入区候选列表显示它)');
  const noBrief = row('s_plain', { title: '支付网关重构', updatedAt: RECENT });
  const r2 = prerouteText('支付网关重构', [noBrief], [], opts);
  ok(r2.hits[0].displayTitle === '支付网关重构',
    '⑪ 没有摘要时 displayTitle 逐字等于 title(壳层那句 displayTitle || title 的回落永远有值)');
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort tmpdir cleanup */ }

console.log('');
if (fail) { console.log(`STEWARD-PREROUTE UNIT: FAIL (${fail})`); process.exit(1); }
console.log('STEWARD-PREROUTE UNIT: ALL PASS');
