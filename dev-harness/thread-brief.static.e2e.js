#!/usr/bin/env node
'use strict';

// 静态锁(第 116 波 116-5b · 27 号文 §11.8.5「消费面」):线程自动摘要的【显示名单点】纪律。
//
// 本件看住的是一条结构性约定,而不是某个行为 —— 行为由 thread-brief.e2e.js / session-search.e2e.js /
// unit/steward-preroute.test.js 三件跑出来验:
//
//   ① 判据只有一处:`sessionDisplayTitle` 在 src/ 里只定义一次(02-session-store.js),
//      其余模块一律只【调用】。这条是 112 波摸底那个教训的直接产物(服务端发 54 种、前端认 34 种)——
//      「哪个名字该显示」只要有第二个判定点,两个面迟早各说各话。
//   ② 消费面各自读的是【服务端算好的结果】,不是自己拼:六个装配点必须都在。
//   ③ public/ 下算这条判据的只有一处(经典壳的 session-experience.js,因为「未命名 → 本地化占位」
//      那条规则依赖 t(),服务端不认识它);管家壳那一侧只读 displayTitle,不许再出现第二份判据。
//   ④ 红线:摘要不改写 session.title。06-provider-engine 的摘要块只经 updateSessionMeta 写
//      threadBrief,绝不给 title 赋值。
//   ⑤ 设置开关三件套齐(HTML 控件 + 填充 + 接线 + 中英两条文案),且默认开(判 `!== false` 而不是
//      `=== true`),不随 stewardEnabledV1。
//   ⑥ 分级:stewardThreadBriefV1 在 06i 的 confirm 档(它开着就在每条新线程上花钱,
//      且记的是 aux 不进 stewardMaxCostPerDay)。
//
// 判定行:`THREAD BRIEF STATIC E2E: ALL PASS`。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const readSrc = name => fs.readFileSync(path.join(SRC, name), 'utf8');
const readPub = rel => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

let failures = 0;
function ok(condition, label) {
  if (condition) console.log('PASS ' + label);
  else { failures += 1; console.log('FAIL ' + label); }
}

const store = readSrc('02-session-store.js');
const provider = readSrc('06-provider-engine.js');
const core = readSrc('06i-steward-core.js');
const config = readSrc('01-config.js');
const domain = readSrc('13d-core-domain-routes.js');
// 117 波 T1(32 号文 §2.1):13g 拆成 13j/13k/13l/13g 四个文件(纯搬家),steward_threads_search
// 现在住 13k-steward-threads.js。这里要钉的事实是「threads_search 的结果带 brief」,与它住哪个
// 文件无关,故改读整个 13g 族 —— 拆分再动一次也不会假红。
const steward = ['13g-steward.js', '13j-steward-tool-base.js', '13k-steward-threads.js', '13l-steward-ops.js']
  .map(readSrc).join('\n');
const runner = readSrc('13h-steward-runner.js');

/* ── ① 判据只有一处 ─────────────────────────────────────────────────────────── */
{
  const defs = fs.readdirSync(SRC).filter(f => f.endsWith('.js'))
    .filter(f => /function\s+sessionDisplayTitle\s*\(/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
  ok(defs.length === 1 && defs[0] === '02-session-store.js',
    `① sessionDisplayTitle 在 src/ 里只定义一次,且住 02-session-store.js(实得 ${JSON.stringify(defs)})`);
  ok(/if \(!o \|\| o\.titleSource === 'user'\) return raw;/.test(store),
    '① 优先级第一条:人起的名字压过一切(titleSource === \'user\' 直接回原话)');
  ok(/return generated \|\| raw;/.test(store),
    '① 优先级第二、三条:生成的名字 > 原话');
  // 117l-A1-fix ②:第四档兜底 —— 原话是占位符('New session' / '新会话' / 'New chat')且手上真有
  // 正文时,退一档用首条用户消息的摘录。上面那两条断言【一条没改】:优先级前三档逐字不变,
  // 摘录只是「原话恰好是占位符」这一种情况的兜底(行为由 thread-brief.e2e.js 的 (L) 段跑出来验)。
  ok(/if \(generated \|\| !isUntitledSessionTitle\(raw\)\) return generated \|\| raw;/.test(store),
    '① 117l-A1-fix companion:占位符判据复用既有的 isUntitledSessionTitle(中英占位集单点),不另立一张表');
  ok(/return sessionFirstUserExcerpt\(o\) \|\| raw;/.test(store),
    '① 117l-A1-fix companion:第四档是首条用户消息的摘录,取不到仍旧回落原话(绝不返回空标题)');
  {
    const excerptDefs = fs.readdirSync(SRC).filter(f => f.endsWith('.js'))
      .filter(f => /function\s+sessionFirstUserExcerpt\s*\(/.test(fs.readFileSync(path.join(SRC, f), 'utf8')));
    ok(excerptDefs.length === 1 && excerptDefs[0] === '02-session-store.js',
      `① 117l-A1-fix companion:摘录函数也只定义一次,且与判据住同一处(实得 ${JSON.stringify(excerptDefs)})`);
  }
  ok(/const rows = \(o && Array\.isArray\(o\.messages\)\) \? o\.messages : null;\s*\n\s*if \(!rows\) return '';/.test(store),
    '① 117l-A1-fix companion:只在入参【自己带着正文】时才走(会话头/索引条目的调用面不去多读一次正文文件)');
}

/* ── ② 消费面六个装配点 ─────────────────────────────────────────────────────── */
{
  ok(/displayTitle: sessionDisplayTitle\(head\),/.test(domain),
    '② 事项卡片(13d buildMissionCard)带 displayTitle —— 看板/抽屉/「现在这一件」读它');
  ok(/briefTitle: sessionBriefOf\(row\.meta\)\.title, briefGist: sessionBriefOf\(row\.meta\)\.gist/.test(domain),
    '② 113b 会话搜索结果带 briefTitle/briefGist');
  // 【117l 重钉】旧断言把 `displayTitle: sessionDisplayTitle(session) }));` 整段(含收尾的 `}));`)
  // 钉成了字面量 —— 它实际钉住的是「这个键在信封里,而且它正好是最后一个键」。后半句不是契约:
  // 117l D4 在同一个信封上追加了 liveTail(活回合的尾巴,只在真有活回合时出现)。改成只钉这个键本身,
  // 并补一条 companion 钉住新契约的另一半:liveTail 必须是【条件展开】,不能无条件出现在信封里
  // (无条件 = 空回合也下发一个空对象,抽屉就会把「它正在说」一直挂在那儿)。
  ok(/displayTitle: sessionDisplayTitle\(session\)/.test(domain),
    '② GET /api/sessions/:id 的信封带 displayTitle(抽屉标题读它)');
  ok(/\.\.\.\(liveTail \? \{ liveTail \} : \{\}\)/.test(domain),
    '② 117l companion:liveTail 在同一个信封上【条件】展开(没有活回合时这个键不存在)');
  // 117l-A1-fix2:抽屉 isLive() 第一判据是 resumable.live === true,而【活回合】分支修前没有这个
  // 键,判据从没走通过。钉住活回合分支带 live:true,且悬挂检测(detectDanglingTurn)那一支原样不动
  // —— 只加了这一个键,没有顺手改别的。
  ok(/\{ dangling: false, kind: null, turnSeq: Math\.max\(0, Number\(session\.turnSeq\) \|\| 0\), historyLength: Array\.isArray\(session\.providerHistory\) \? session\.providerHistory\.length : 0, live: true \}/.test(domain),
    '② 117l-A1-fix2:GET /api/sessions/:id 活回合分支的 resumable 带 live:true(抽屉 isLive() 靠它)');
  ok(/: detectDanglingTurn\(session\);/.test(domain),
    '② 117l-A1-fix2 companion:非活回合分支仍是 detectDanglingTurn(session) 原样,没被顺手改动');
  ok(/\{ brief: sessionBriefOf\(head\) \|\| sessionBriefOf\(meta\) \}/.test(steward),
    '② steward_threads_search 结果带 brief');
  ok(/displayTitle: sessionDisplayTitle\(head\),/.test(runner),
    '② 管家总览行带 displayTitle(preroute 与「现在这一件」的 focus 都读它)');
  ok(/displayTitle: stewardSanitizeText\(\(candidate\.row && candidate\.row\.displayTitle\)/.test(core),
    '② 递送预判 hit 带 displayTitle');
  // 打分那一侧仍吃原话:把 title 换成压过的名字,会让用户当时打的词从索引里消失。
  ok(/title: stewardSanitizeText\(\(candidate\.row && candidate\.row\.title\) \|\| ''\),/.test(core),
    '② hit.title 仍是原话(打分吃它;显示名是【多】给的一个键,不是替换)');
  ok(/title: \(row\.digest && row\.digest\.title\) \|\| '',/.test(runner),
    '② preroute 索引行的 title 仍是原话(同上)');
}

/* ── ③ public/ 下只有一处算这条判据 ────────────────────────────────────────── */
{
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'vendor' && entry.name !== 'locales') walk(full); continue; }
      if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(PUBLIC);
  const judging = files
    .filter(f => /titleSource/.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.relative(PUBLIC, f).replace(/\\/g, '/'));
  ok(judging.length === 1 && judging[0] === 'js/session-experience.js',
    `③ public/ 下读 titleSource 的只有经典壳那一处(实得 ${JSON.stringify(judging)})`);
  const experience = readPub('js/session-experience.js');
  ok(/function sessionGeneratedTitle\(s\) \{/.test(experience)
    && /if \(!s \|\| s\.titleSource === 'user'\) return '';/.test(experience),
    '③ 经典壳那一处与服务端逐条同优先级');
  // 管家壳四个消费点只读服务端算好的 displayTitle。
  for (const [rel, needle] of [
    ['js/steward-board.js', 'row.displayTitle || row.title || sessionId'],
    ['js/steward-drawer.js', 'row.displayTitle || row.title || row.sessionId'],
    ['js/steward-composer.js', 'hit.displayTitle || hit.title || hit.sessionId'],
    ['js/steward-conversation.js', 'hit.displayTitle || hit.title || hit.sessionId'],
  ]) ok(readPub(rel).includes(needle), `③ ${rel} 只读服务端算好的 displayTitle`);
  ok(readPub('js/steward-drawer.js').includes('displayTitle = String(sessionRes.displayTitle'),
    '③ 抽屉标题读 GET /api/sessions/:id 信封里的 displayTitle,不自己拼');
}

/* ── ④ 红线:摘要不改写 session.title ───────────────────────────────────────── */
{
  const block = provider.slice(provider.indexOf('function threadBriefEnabled'), provider.indexOf('function threadBriefOnce') + 4000);
  ok(block.length > 1000, '④ 定位到了 06-provider-engine 的摘要块(锚点没漂)');
  ok(!/\.title\s*=\s*/.test(block),
    '④ 红线:摘要块里没有任何给 title 赋值的语句(原话是权威,brief 只是【多】给的一个名字)');
  ok(/updateSessionMeta\(sid, \{ threadBrief: brief \}\)/.test(block),
    '④ 落盘只经 updateSessionMeta 的白名单,写的只有 threadBrief');
}

/* ── ⑤ 设置开关三件套 ──────────────────────────────────────────────────────── */
{
  const html = readPub('index.html');
  const settings = readPub('js/steward-settings.js');
  const zh = JSON.parse(readPub('locales/zh-CN.json'));
  const en = JSON.parse(readPub('locales/en-US.json'));
  ok(html.includes('id="cfgStewardThreadBrief"'), '⑤ 设置页有这个控件');
  ok(html.includes('data-i18n="settings.steward.threadBrief"')
    && html.includes('data-i18n="settings.steward.threadBriefHint"'), '⑤ 控件与说明都走 i18n 键');
  ok(/brief\.checked = c\.stewardThreadBriefV1 !== false;/.test(settings),
    '⑤ 填充判的是 !== false —— 它【默认开】,缺字段不等于关');
  ok(/onChange\('cfgStewardThreadBrief', event => saveConfig\(\{ stewardThreadBriefV1: event\.target\.checked === true \}\)\);/.test(settings),
    '⑤ 改动即存,落的是布尔真值');
  for (const key of ['settings.steward.threadBrief', 'settings.steward.threadBriefHint']) {
    ok(typeof zh[key] === 'string' && zh[key].length > 0, `⑤ zh-CN 有 ${key}`);
    ok(typeof en[key] === 'string' && en[key].length > 0, `⑤ en-US 有 ${key}`);
  }
  // §11.8.6:消费面一半在经典壳,所以文案里必须说清楚「管家关着它也在用」。
  ok(/经典壳的会话列表/.test(zh['settings.steward.threadBriefHint'] || ''),
    '⑤ 中文说明写明经典壳的会话列表也用它(它不随管家总开关)');
  ok(/classic session list/i.test(en['settings.steward.threadBriefHint'] || ''),
    '⑤ 英文说明同口径');
  ok(/const b = config\.stewardThreadBriefV1 !== false;/.test(config),
    '⑤ 服务端归一同口径(默认开)');
}

/* ── ⑥ 分级 ────────────────────────────────────────────────────────────────── */
{
  const tier = core.slice(core.indexOf('STEWARD_CONFIG_TIER_CONFIRM'), core.indexOf('STEWARD_CONFIG_TIER_CONFIRM') + 1600);
  ok(/'stewardThreadBriefV1'/.test(tier),
    "⑥ stewardThreadBriefV1 在 confirm 档(开着就在每条新线程上花钱,且记 aux 不进 stewardMaxCostPerDay)");
}

console.log('');
if (failures) { console.log(`THREAD BRIEF STATIC E2E: ${failures} FAILURE(S)`); process.exit(1); }
console.log('THREAD BRIEF STATIC E2E: ALL PASS');
process.exit(0);
