// Unit: 第 117 波 117l-A1(27 号文 §11.9 D5「id 人话化」/ D7「新线程模型分档」/ D4「它在问你」)——
// 三个纯函数的真值表。它们只吃入参:零磁盘、零配置、零全局状态,所以每条用例都是字面量。
//
// 为什么要单测而不是只靠 e2e:D5 的替换规则是【确定性文本处理】,错一个字符类就会
//   · 把不认识的 id 换成别的线程的名字(张冠李戴,比露一个 id 严重得多),或者
//   · 把机器字段里的 id 也删掉(前端的按钮从此点不开)。
// 这两种坏法在 e2e 里都不容易被一条断言撞上,真值表能。
//
// 覆盖:
//   ① stewardHumanizeIds:命中替换 / 未命中原样保留 / 孤立机器 id 删除 + 标点收尾 /
//      多 id 混排 / titleOf 抛错或不是函数 / 空输入 / 机器字段(JSON 串)不受影响的证明
//   ② stewardThreadEngineRoute:两档 × {没配 / 配了且 provider 在 / 配了但 provider 不在} ×
//      {model 给了 / model 空回落 provider.model};tier 非法值一律当 strong
//   ③ stewardAsksYou:三态与优先级(question > 活回合 > soft),末段截取与 300 字上限
//
// 与既有 dev-harness/unit 件同款约定(见 steward-wait-reason.test.js):require server.js 前先把
// WIN_CLAUDE_WORKBENCH_HOME 覆盖到临时目录;PASS/FAIL 逐条打印,process.exit(fail?1:0)。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-humanize-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const srv = require(path.join(app, 'server.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const { stewardHumanizeIds, stewardThreadEngineRoute, stewardAsksYou } = srv;

/* ═══════════ ① stewardHumanizeIds ═══════════ */
{
  ok(typeof stewardHumanizeIds === 'function', '① 导出了 stewardHumanizeIds');

  const TITLES = { sess_a50604717960006a: '美股预判', sess_00112233445566aa: '季度收尾' };
  const titleOf = id => TITLES[id] || '';

  // 用户真机上那一句(§11.9 证据):收件箱事件行原样进了 why。
  const real = '收件箱事件 [1] needs_you:线程 sess_a50604717960006a 有待决 question_77ef30898760f07a,我先去看看';
  const out = stewardHumanizeIds(real, titleOf);
  ok(out.includes('美股预判'), '①a 命中的会话 id 换成显示名');
  ok(!/sess_/.test(out), '①b 换完之后一个 sess_ 都不剩');
  ok(!/question_/.test(out), '①c 孤立的 question_ 被删掉');
  ok(out.includes('我先去看看'), '①d 其余原话一个字不丢');
  ok(!/\s,/.test(out) && !/,\s*,/.test(out), `①e 删除后的标点被收紧(got ${JSON.stringify(out)})`);

  // 查不到名字:【原样保留】。宁可露一个 id,也不能张冠李戴。
  const miss = stewardHumanizeIds('线程 sess_ffffffffffffffff 停住了', titleOf);
  ok(miss.includes('sess_ffffffffffffffff'), '①f titleOf 查不到时 id 原样保留(绝不换成别的线程的名字)');

  // 多个 id 混排,各归各的。
  const many = stewardHumanizeIds('sess_a50604717960006a 在等你,sess_00112233445566aa 收工了', titleOf);
  ok(many.includes('美股预判') && many.includes('季度收尾') && !/sess_/.test(many), '①g 多个 id 各自换成各自的名字');

  // titleOf 缺席 / 抛错:不崩,退化成「都查不到」。
  ok(stewardHumanizeIds('线程 sess_a50604717960006a', null).includes('sess_a50604717960006a'), '①h titleOf 不是函数时不崩、id 保留');
  ok(stewardHumanizeIds('线程 sess_a50604717960006a', () => { throw new Error('boom'); }).includes('sess_a50604717960006a'),
    '①i titleOf 抛错时不崩、id 保留');

  // 空输入。
  ok(stewardHumanizeIds('', titleOf) === '' && stewardHumanizeIds(null, titleOf) === '' && stewardHumanizeIds(undefined, titleOf) === '',
    '①j 空/null/undefined 一律回空串');

  // 机器字段不该过这个函数 —— 这里证明的是「如果谁误用了,后果是可见的」:JSON 串里的 id 会被换掉,
  // 所以调用点必须只喂 say/why(13h 里就是这么调的:acts/actions 走的是另一条路)。
  const asJson = JSON.stringify({ sessionId: 'sess_a50604717960006a' });
  ok(stewardHumanizeIds(asJson, titleOf) !== asJson,
    '①k 反证:机器字段的 JSON 串如果误喂进来会被改写 —— 所以调用点只喂 say/why');

  // 其它内部 id 前缀也删。
  const others = stewardHumanizeIds('run_9a8b7c6d5e4f3a2b 跑完了,intv_1122334455667788 也决了', titleOf);
  ok(!/run_|intv_/.test(others) && others.includes('跑完了'), '①l run_ / intv_ 这类机器把手一并删掉,人话留下');

  // 幂等:再跑一遍不会把已经换好的名字弄坏。
  ok(stewardHumanizeIds(out, titleOf) === out, '①m 幂等:对已经人话化过的文本再跑一遍结果不变');
}

/* ═══════════ ② stewardThreadEngineRoute ═══════════ */
{
  ok(typeof stewardThreadEngineRoute === 'function', '② 导出了 stewardThreadEngineRoute');

  const CONFIG = {
    providers: [
      { id: 'strong-ep', model: 'big-model' },
      { id: 'fast-ep', model: 'small-model' },
    ],
    stewardThreadModels: {
      strong: { providerId: 'strong-ep', model: 'big-pro' },
      fast: { providerId: 'fast-ep', model: '' },
    },
  };

  // 本函数【只判不造】:engineRoute 的构造要 02 的归一器,而 06i 这一层不向 00/02/04 伸手
  // (103b 依赖债务上限)。构造与落盘在 13h 的 stewardApplyThreadTier(e2e 那一侧盯住结果)。
  const strong = stewardThreadEngineRoute('strong', CONFIG);
  ok(strong.found === true && strong.providerId === 'strong-ep' && strong.model === 'big-pro',
    `②a strong 档:providerId + 显式 model(got ${JSON.stringify(strong)})`);
  ok(strong.fallback === false && strong.tier === 'strong', '②b strong 档没有回落');

  const fast = stewardThreadEngineRoute('fast', CONFIG);
  ok(fast.found === true && fast.providerId === 'fast-ep' && fast.model === 'small-model',
    `②c fast 档 model 留空 → 用该 provider 自己的模型(got ${JSON.stringify(fast)})`);

  const empty = stewardThreadEngineRoute('strong', { providers: CONFIG.providers, stewardThreadModels: { strong: { providerId: '', model: '' }, fast: { providerId: '', model: '' } } });
  ok(empty.found === false && empty.fallback === false && empty.providerId === '',
    '②d 没配端点 → found:false 且【不是】回落(跟随全局,不该记审计)');

  const ghost = stewardThreadEngineRoute('fast', { providers: CONFIG.providers, stewardThreadModels: { strong: { providerId: '', model: '' }, fast: { providerId: 'deleted-ep', model: 'x' } } });
  ok(ghost.found === false && ghost.fallback === true && ghost.providerId === 'deleted-ep',
    `②e 配了但 provider 已经不在 → found:false + fallback:true + 带上那个 id(给审计用)(got ${JSON.stringify(ghost)})`);

  for (const bad of ['', 'STRONG', 'quick', null, undefined, 0, {}]) {
    const r = stewardThreadEngineRoute(bad, CONFIG);
    if (r.tier !== 'strong') { fail++; console.log(`FAIL ②f tier 非法值(${JSON.stringify(bad)})应当归一成 strong,got ${r.tier}`); }
  }
  ok(true, '②f tier 的非法值一律归一成 strong(缺省档)');

  ok(stewardThreadEngineRoute('strong', null).found === false && stewardThreadEngineRoute('strong', {}).found === false,
    '②g config 缺席/空对象不崩,回 found:false');
}

/* ═══════════ ③ stewardAsksYou ═══════════ */
{
  ok(typeof stewardAsksYou === 'function', '③ 导出了 stewardAsksYou');

  const q = stewardAsksYou({ question: { questionId: 'question_abc123', text: '走 A 还是走 B?' }, activeTurn: false, lastAssistantText: '随便说点什么。' });
  ok(q && q.kind === 'question' && q.questionId === 'question_abc123' && q.text === '走 A 还是走 B?',
    `③a 有正式待决 → question 态,带 questionId 与问题原文(got ${JSON.stringify(q)})`);

  const qWhileRunning = stewardAsksYou({ question: { questionId: 'question_abc123', text: '选哪个?' }, activeTurn: true, lastAssistantText: '' });
  ok(qWhileRunning && qWhileRunning.kind === 'question', '③b 待决优先于「在跑」:回合活着也照样报 question');

  const running = stewardAsksYou({ question: null, activeTurn: true, lastAssistantText: '要不要我接着做?' });
  ok(running === null, '③c 无待决但回合在跑 → null(在跑就不算在问你)');

  const soft = stewardAsksYou({ question: null, activeTurn: false, lastAssistantText: '我看了一遍。华南那张表还缺。要不要我把汇总也做了?' });
  ok(soft && soft.kind === 'soft' && soft.text === '要不要我把汇总也做了?' && !('questionId' in soft),
    `③d 末句问号 → soft 态,只取最后一段、不带 questionId(got ${JSON.stringify(soft)})`);

  const half = stewardAsksYou({ question: null, activeTurn: false, lastAssistantText: 'Shall I also do the summary?' });
  ok(half && half.kind === 'soft', '③e 半角问号同样算软问句');

  ok(stewardAsksYou({ question: null, activeTurn: false, lastAssistantText: '已经做完了。' }) === null, '③f 不是问句 → null');
  ok(stewardAsksYou({ question: null, activeTurn: false, lastAssistantText: '' }) === null, '③g 没有助手消息 → null');
  ok(stewardAsksYou(null) === null && stewardAsksYou(undefined) === null, '③h 入参缺席不崩,回 null');

  const long = stewardAsksYou({ question: null, activeTurn: false, lastAssistantText: '甲'.repeat(500) + '?' });
  ok(long && long.text.length <= 300, `③i soft 文本上限 300 字(got ${long && long.text.length})`);

  const longQ = stewardAsksYou({ question: { questionId: 'question_x1', text: '乙'.repeat(500) }, activeTurn: false, lastAssistantText: '' });
  ok(longQ && longQ.text.length <= 300, `③j question 文本同样 300 字上限(got ${longQ && longQ.text.length})`);

  // 换行分段:最后一行是问句时只取那一行。
  const multiline = stewardAsksYou({ question: null, activeTurn: false, lastAssistantText: '第一行做完了。\n第二行也做完了。\n还要不要继续?' });
  ok(multiline && multiline.text === '还要不要继续?', `③k 多行时只取最后一行(got ${JSON.stringify(multiline && multiline.text)})`);
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort tmpdir cleanup */ }

console.log('');
if (fail) { console.log(`STEWARD-HUMANIZE UNIT: FAIL (${fail})`); process.exit(1); }
console.log('STEWARD-HUMANIZE UNIT: ALL PASS');
