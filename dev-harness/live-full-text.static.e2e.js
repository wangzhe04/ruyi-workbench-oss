#!/usr/bin/env node
'use strict';

// 静态契约(第 117 波 117m-A5 · 27 号文 §11.10):「看全文」看得到在途回合的正文。
//   A 后端累加器:full 硬顶 12000、超顶从【头部】丢弃、tools 上限 20 且只存名字与状态;
//   B 信封:白名单式逐字段搬运(不 spread reg 上那份对象)、仍是【条件展开】(回合结束键就消失);
//   C 轮询纪律:经典壳 session-experience.js 恰好一处 setInterval / 一处 clearInterval,
//     且都锁在 syncLivePolling() 这一个单点里,开表条件不少于四道门;
//   D 临时气泡不是消息:带 data-live="1",不写进 state.currentSession.messages,零 innerHTML;
//   E 零新请求:活文本跟着既有那一发 GET /api/sessions/:id 回来;
//   F 样式落在【已注册的所有权层】css/states/chat-live.css,且经典载荷锁已重钉。
// 117o-A7(用户第七轮「为啥这个查看全文,不能像 2.0 那样显示呢?第二张图是 2.0 的」)新增:
//   G 服务端把【有序叙事账本】在途下发:02c 的 liveSnapshot()、三重硬顶、从头部丢弃、
//     toolCalls 四个键且零结果;两条引擎路径都把账本挂在活回合登记项上;13d 两条返回路径都带它;
//     参数摘要的字段挑选口径与前端 TC_ARG_KEYS 【逐字相等】;
//   H 前端不写第二套渲染器:在途回合走的是 renderStaticMessage()(画落盘助手消息的同一个入口),
//     工具卡的截断走同一个 toolArgSummaryText,tc.status 是纯【新增可选】字段;
//   I 一条线程 = 一个 2.0 会话:经典壳的会话列表渲染【没有任何 kind 过滤】,
//     管家开出来的 kind:'mission' 线程不会从列表里消失。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readLayerPayload, LEGACY_STYLES_SHA256 } = require('./read-frontend-css.js');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const read = file => fs.readFileSync(file, 'utf8');
const runtime = read(path.join(SRC, '04-permission-runtime.js'));
const routes = read(path.join(SRC, '13d-core-domain-routes.js'));
const experience = read(path.join(PUBLIC, 'js', 'session-experience.js'));
const chatLive = read(path.join(PUBLIC, 'css', 'states', 'chat-live.css'));
const turnSegments = read(path.join(SRC, '02c-turn-segments.js'));
const workflow = read(path.join(SRC, '09-workflow.js'));
const claudeEngine = read(path.join(SRC, '05-claude-engine.js'));
const primitives = read(path.join(PUBLIC, 'js', 'chat-render-primitives.js'));

// 纪律本身写在注释里(「本模块唯一的 setInterval」这种话),扫计数之前先把注释剥掉 ——
// 否则写下纪律的那一行会把自己判红(与 steward-drawer.static / steward-conversation.static 同款)。
const stripComments = source => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const experienceCode = stripComments(experience);
const count = (source, pattern) => (source.match(pattern) || []).length;

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

/* ─── A 后端累加器 ─────────────────────────────────────────────────────────── */
ok(/const LIVE_FULL_CHARS = 12000;/.test(runtime), 'A1 full 的硬顶是 12000 字');
ok(/const LIVE_TOOLS_MAX = 20;/.test(runtime), 'A2 tools 上限 20 条');
ok(/const LIVE_TAIL_CHARS = 600;/.test(runtime)
  && /tail\.text = \(tail\.text \+ chunk\)\.slice\(-LIVE_TAIL_CHARS\);/.test(runtime),
  'A3 117l 的老语义一字未动:text 仍是最后 600 字');
// 截断方向是本切片的语义核心:用户要看的是「它现在在说什么」,砍掉的必须是最早那段。
ok(/tail\.full = merged\.slice\(merged\.length - LIVE_FULL_CHARS\); tail\.truncated = true;/.test(runtime),
  'A4 超顶时从【头部】丢弃(slice 取的是尾段)并置 truncated:true');
ok(/tail\.tools\.push\(\{ id: String\(evt\.id \|\| ''\), name, startedAt: at, endedAt: '', status: 'running' \}\);/.test(runtime),
  'A5 工具行只记 id/名字/起止/状态');
// 反向锁:累加器里不许出现任何搬运工具【参数】或【结果】的字样。
ok(!/tail\.tools\.push\([^)]*(input|args|arguments|content|result)/.test(runtime),
  'A6 工具行不存参数、不存结果(那可能含密钥)');
ok(/while \(tail\.tools\.length > LIVE_TOOLS_MAX\) tail\.tools\.shift\(\);/.test(runtime),
  'A7 超过 20 条从最早的开始丢');

/* ─── B 信封 ───────────────────────────────────────────────────────────────── */
ok(/\.\.\.\(liveTail \? \{ liveTail \} : \{\}\)/.test(routes),
  'B1 liveTail 仍是【条件展开】(回合一结束这个键就不在了 —— 前端据此收尾)');
ok(count(routes, /\.\.\.\(liveTail \? \{ liveTail \} : \{\}\)/g) === 2,
  `B1b 两条返回路径(带 since 的与不带的)都带上它(实测 ${count(routes, /\.\.\.\(liveTail \? \{ liveTail \} : \{\}\)/g)} 处)`);
for (const key of ['full', 'truncated', 'startedAt', 'iterations', 'tools']) {
  ok(new RegExp(`\\n\\s+${key}:`).test(routes.slice(routes.indexOf('const liveTail = liveReg'), routes.indexOf('const liveTail = liveReg') + 1400)),
    `B2 信封带上了 ${key}`);
}
{
  const block = routes.slice(routes.indexOf('const liveTail = liveReg'), routes.indexOf('const liveTail = liveReg') + 1400);
  // 白名单式搬运:不许 spread 累加器上那份对象(它上面还有 batchMark/lastKind 这类内部游标,
  // tools 里还有工具调用 id)。这条锁的是「以后有人图省事改成 { ...liveReg.liveTail }」。
  ok(!/\.\.\.\s*liveReg\.liveTail/.test(block), 'B3 不 spread 累加器对象,逐字段白名单搬运');
  ok(/tools: \(Array\.isArray\(liveReg\.liveTail\.tools\) \? liveReg\.liveTail\.tools : \[\]\)\.slice\(-20\)\.map\(row => \(\{/.test(block),
    'B4 tools 在路由处再截一次 20 条并逐字段重建');
  const toolsPart = block.slice(block.indexOf('tools:'));
  ok(!/(input|args|arguments|content|result)\s*:/.test(toolsPart),
    'B5 下发的工具行只有 name/status/startedAt/endedAt —— 零参数、零结果');
  ok(!/\bid\s*:/.test(toolsPart), 'B6 连工具调用 id 都不下发(信封只回答「它在用什么」)');
}

/* ─── C 轮询纪律 ───────────────────────────────────────────────────────────── */
ok(count(experienceCode, /setInterval\(/g) === 1,
  `C1 session-experience.js 恰好一处 setInterval(实测 ${count(experienceCode, /setInterval\(/g)})`);
ok(count(experienceCode, /clearInterval\(/g) === 1,
  `C2 session-experience.js 恰好一处 clearInterval(实测 ${count(experienceCode, /clearInterval\(/g)})`);
{
  const start = experienceCode.indexOf('function syncLivePolling()');
  const body = start >= 0 ? experienceCode.slice(start, experienceCode.indexOf('\n}', start) + 2) : '';
  ok(start >= 0, 'C3 开关表的单点叫 syncLivePolling()');
  ok(/setInterval\(/.test(body) && /clearInterval\(/.test(body),
    'C4 那唯一的一对 setInterval/clearInterval 就在 syncLivePolling() 里');
}
ok(/const LIVE_TURN_POLL_MS = 3000;/.test(experience), 'C5 节拍 3s');
{
  const start = experienceCode.indexOf('function liveTurnPollable()');
  const body = start >= 0 ? experienceCode.slice(start, experienceCode.indexOf('\n}', start) + 2) : '';
  ok(/liveTurnVisible\(\)/.test(body), 'C6 开表前提之一:这张气泡确实该画');
  ok(/doc\.hidden/.test(body), 'C7 开表前提之二:页面可见');
  ok(/data-shell-mode/.test(body), 'C8 开表前提之三:人在经典壳里(管家壳有它自己的节拍,零后台活动)');
}
{
  const start = experienceCode.indexOf('function liveTurnVisible()');
  const body = start >= 0 ? experienceCode.slice(start, experienceCode.indexOf('\n}', start) + 2) : '';
  ok(/liveTurnSessionId !== id/.test(body), 'C9 画之前先认会话:A 的活文本不许画到 B 上');
  ok(/activeTurns\.has\(id\)/.test(body), 'C10 自己的流在跑就不画这张(实时那一张已经在画了,别画两遍)');
  ok(/liveTurnLive/.test(body), 'C11 「在不在跑」以服务端的 resumable.live 为准');
}
ok(count(experienceCode, /syncLivePolling\(\)/g) >= 4,
  `C12 开关只走这一个函数(实测 ${count(experienceCode, /syncLivePolling\(\)/g)} 处调用点)`);

/* ─── D 临时气泡不是消息 ───────────────────────────────────────────────────── */
ok(/row\.dataset\.live = '1';/.test(experience), 'D1 气泡带 data-live="1"(与真消息一眼可分)');
ok(!/messages\.push\(/.test(experienceCode) && !/currentSession\.messages\s*=/.test(experienceCode),
  'D2 气泡不进 state.currentSession.messages(正文数据面只认落盘的)');
{
  const start = experienceCode.indexOf('function buildLiveTurnCard()');
  const body = start >= 0 ? experienceCode.slice(start, experienceCode.indexOf('\n}', start) + 2) : '';
  ok(start >= 0 && !/innerHTML/.test(body), 'D3 气泡全 el()/textContent 建节点,零 innerHTML');
  ok(/el\('article', 'message assistant live-turn'\)/.test(body), 'D4 复用既有 .message.assistant 骨架,不另造一套壳');
}
{
  // 117m-A6：定位用的字面从 paintLiveTurnCard() 放宽成 paintLiveTurnCard( —— 函数多了一个 opts
  // 参数（首帧要能在挂载前填内容）。D5/D6 两条断言本身一字未改，只是定位器不再钉参数表。
  const start = experienceCode.indexOf('function paintLiveTurnCard(');
  const body = start >= 0 ? experienceCode.slice(start, experienceCode.indexOf('\n}', start) + 2) : '';
  ok(/truncated\) \? `…\$\{full\}`/.test(body), 'D5 truncated 时省略号标在【开头】(后端砍的就是头)');
  ok(/tools\[tools\.length - 1\]/.test(body), 'D6 「正在用」读 tools 的最后一条');
  // 伴随断言（比旧那两条强）：气泡刚造出来、还没 append 进文档时也得把内容填上。
  // 修前 isConnected 守卫把首次填充退了回去，首帧正文区一片空白，要等 3 秒下一拍才自愈。
  ok(experienceCode.includes("paintLiveTurnCard({ mounted: false })"),
    'D7 首帧在挂载前就填内容(mounted:false 跳过 isConnected 守卫)');
  ok(body.includes("if (!(opts && opts.mounted === false) && !els.row.isConnected) return false;"),
    'D8 守卫本身还在(气泡被整份重绘换掉时仍返回 false 让调用方重绘)');
  ok(!/innerHTML/.test(body), 'D7 刷新也走 textContent');
}
ok(/if \(liveTurnVisible\(\)\) fragment\.appendChild\(buildLiveTurnCard\(\)\);/.test(experience),
  'D8 气泡挂在会话末尾(renderCurrentSession 的 fragment 尾巴)');
ok(/!session\.messages\?\.length && !liveForSession && !liveTurnVisible\(\)/.test(experience),
  'D9 一条落盘消息都没有但回合在跑时不落空态(否则空态把气泡整个吞掉)');

/* ─── E 零新请求 ───────────────────────────────────────────────────────────── */
ok(/captureLiveTurn\(id, res\);/.test(experience),
  'E1 活文本跟着 openSession 那一发既有 GET /api/sessions/:id 回来');
ok(/liveTurnTail = res && res\.liveTail && typeof res\.liveTail === 'object' \? res\.liveTail : null;/.test(experience),
  'E2 只读信封上那个键,没有第二个数据源');
ok(/api\('\/api\/stop', \{ method: 'POST', body: JSON\.stringify\(\{ sessionId: id \}\) \}\)/.test(experience),
  'E3 「停止」走既有 /api/stop,不新开面');
ok(count(experienceCode, /api\(`\/api\/sessions\/\$\{encodeURIComponent\(id\)\}`\)/g) === 2,
  `E4 只有 openSession 与那一拍两处会去取会话(实测 ${count(experienceCode, /api\(`\/api\/sessions\/\$\{encodeURIComponent\(id\)\}`\)/g)} 处)`);

/* ─── F 样式层 ─────────────────────────────────────────────────────────────── */
for (const sel of ['.live-turn-title', '.live-turn-body', '.live-turn-tool', '.live-turn-stop']) {
  ok(chatLive.includes(sel), `F1 ${sel} 落在【已注册的】所有权层 css/states/chat-live.css`);
}
ok(!/#[0-9a-fA-F]{3,8}\b/.test(chatLive.slice(chatLive.indexOf('117m-A5'))),
  'F2 新增规则零硬编码色(全 token / color-mix)');
ok(crypto.createHash('sha256').update(readLayerPayload()).digest('hex') === LEGACY_STYLES_SHA256,
  'F3 经典样式载荷锁已按本波的有意新增重钉');

/* ─── G 117o-A7 服务端:把叙事账本在途下发 ─────────────────────────────────── */
ok(/const liveSnapshot = \(\) => \{/.test(turnSegments) && /return \{ consume, snapshot, liveSnapshot, createBatchId, finalizeAll \};/.test(turnSegments),
  'G1 02c 多了一个【在途只读】快照 liveSnapshot(),并从构建器上导出');
ok(/const LIVE_TURN_SEGMENTS_MAX = 200;/.test(turnSegments)
  && /const LIVE_TURN_SEGMENT_CHARS = 12000;/.test(turnSegments)
  && /const LIVE_TURN_TEXT_BUDGET = 24000;/.test(turnSegments),
  'G2 三重硬顶都写死在常量里(段数 / 单段文本 / 总文本预算)');
ok(/copy\[key\] = value\.slice\(value\.length - room\); copy\.truncated = true; truncated = true;/.test(turnSegments),
  'G3 单段超顶时从【头部】丢弃(slice 取的是尾段)并置 truncated:true');
{
  const start = turnSegments.indexOf('const liveSnapshot = () => {');
  const body = start >= 0 ? turnSegments.slice(start, turnSegments.indexOf('\n  };', start) + 4) : '';
  // 本切片的安全线:在途信封里不许出现工具【结果】。这条锁的是「以后有人图省事把 result 也带上」。
  ok(start >= 0 && !/\b(result|output|content)\s*:/.test(body),
    'G4 liveSnapshot 只组 {id,name,inputPreview,status},零结果字段');
  ok(/inputPreview: String\(toolPreviews\.get\(toolCallId\) \|\| ''\)/.test(body),
    'G5 参数摘要从【旁挂表】取,不从段上取');
}
// 落盘形状零漂移:参数摘要不许写进段(否则 session JSON 里会多出一份工具参数副本)。
ok(!/segments\.push\([^)]*inputPreview/.test(turnSegments),
  'G6 参数摘要不进 segments —— 落盘的 snapshot() 形状一个字节没变');
ok(/liveSegments: turnSegments,/.test(workflow) && /liveSegments: turnSegments \}/.test(claudeEngine),
  'G7 两条引擎路径(provider / Claude CLI)都把这一份账本挂在活回合登记项上');
ok(count(routes, /\.\.\.\(liveTurn \? \{ liveTurn \} : \{\}\)/g) === 2,
  `G8 liveTurn 与 liveTail 同款【条件展开】,两条返回路径都带(实测 ${count(routes, /\.\.\.\(liveTurn \? \{ liveTurn \} : \{\}\)/g)} 处)`);
ok(/liveReg\.liveSegments\.liveSnapshot === 'function'/.test(routes),
  'G9 路由只调只读快照,不把构建器本身交出去');
{
  // 口径对齐锁:服务端挑「工具卡那一行显示哪个参数」的字段顺序,必须与前端 TC_ARG_KEYS 逐字相等。
  // 两处各自维护是本切片留下的唯一一处重复(服务端拿不到前端 ES 模块),这条断言把它变成【受检不变量】。
  const serverKeys = (turnSegments.match(/const LIVE_TURN_ARG_KEYS = (\[[^\]]*\]);/) || [])[1] || '';
  const clientKeys = (primitives.match(/const TC_ARG_KEYS = (\[[^\]]*\]);/) || [])[1] || '';
  ok(Boolean(serverKeys) && serverKeys === clientKeys,
    `G10 参数字段挑选口径两端逐字相等(server ${serverKeys} / client ${clientKeys})`);
}

/* ─── H 117o-A7 前端:同一个渲染器,不写第二套 ───────────────────────────────── */
{
  const start = experienceCode.indexOf('function paintLiveTurnNarrative(');
  const body = start >= 0 ? experienceCode.slice(start, experienceCode.indexOf('\n}', start) + 2) : '';
  ok(start >= 0, 'H1 在途回合的正文有一个单独的绘制点 paintLiveTurnNarrative()');
  ok(/renderStaticMessage\(/.test(body),
    'H2 它画正文用的就是 renderStaticMessage() —— 经典壳画一条【落盘助手消息】的那个入口');
  ok(/role: 'assistant', segments, toolCalls/.test(body),
    'H3 组装出来的对象与落盘助手消息【同形】(role/segments/toolCalls)');
  ok(/readonly: true, idScope: 'live'/.test(body),
    'H4 只读(在途回合没有重跑/回退这些动作)+ 独立锚点作用域(不与落盘消息的工具卡撞 id)');
  ok(/captureOpenDetails\(/.test(body) && /restoreOpenDetails\(/.test(body),
    'H5 3 秒一拍重画之前先记下哪些工具卡/思考块是展开的,画完照原样开回去');
  ok(/els\.narrativeSig === signature/.test(body),
    'H6 内容没变就整拍不重画(既省事也不打断用户的展开态)');
}
// 反向锁:本模块【不许】自己长出第二套渲染器。经典壳以后怎么改,在途回合当场跟着改。
ok(!/\btoolCard\(/.test(experienceCode) && !/\bthinkingPanel\(/.test(experienceCode)
  && !/'turn-narrative'/.test(experienceCode) && !/'tool-card'/.test(experienceCode),
  'H7 session-experience.js 里没有任何自建的工具卡/思考块/叙事容器(零仿制品)');
{
  const start = experienceCode.indexOf('function paintLiveTurnCard(');
  const body = start >= 0 ? experienceCode.slice(start, experienceCode.indexOf('\n}', start) + 2) : '';
  ok(/els\.narrative\.hidden = !narrated;/.test(body) && /els\.body\.hidden = narrated;/.test(body),
    'H8 有账本走 2.0 那一套、没有才回落 A5 的纯文本 —— 两条路互斥,同一段话不会出现两遍');
}
{
  // 工具卡的截断口径:静态与在途走同一个函数。tc.status 是【新增可选】字段,既有调用点不带它。
  ok(/function toolArgSummaryText\(raw, max = 44\)/.test(primitives)
    && /return toolArgSummaryText\(raw, max\);/.test(primitives),
    'H9 「归一空白 + 中间省略」收敛成唯一的 toolArgSummaryText(静态卡也改走它)');
  ok(/const arg = argSource \? toolArgSummaryText\(argSource\) : toolArgSummary\(tc\.input\);/.test(primitives),
    'H10 在途卡的那一行走同一个截断函数,不另写一套口径');
  ok(/const liveStatus = typeof tc\.status === 'string' \? tc\.status : '';/.test(primitives)
    && /const settled = liveStatus \? liveStatus !== 'running' : tc\.result !== undefined;/.test(primitives),
    'H11 tc.status 是纯新增的可选字段:不带它时判据仍是「结果在不在」,既有三个调用点逐字节不变');
  ok(/t\('chat\.liveTurn\.resultOffEnvelope'\)/.test(primitives),
    'H12 在途卡的结果区如实写「结果不随在途信封下发」,不留空框让人以为丢了东西');
}

/* ─── I 117o-A7 一条线程 = 一个 2.0 会话 ───────────────────────────────────── */
{
  // 用户原话:「我希望 3.0 的每一条线程,都能对应 2.0 的一个会话」。架构上已经成立(steward_thread_new
  // 走的就是 createSession),但从来没有断言看着它。以后谁给经典壳的会话列表加 kind 过滤,这条当场红。
  const start = experienceCode.indexOf('function renderSessions()');
  const body = start >= 0 ? experienceCode.slice(start, experienceCode.indexOf('\n}', start) + 2) : '';
  ok(start >= 0 && !/\bkind\b/.test(body), 'I1 经典壳会话列表的渲染里没有任何 kind 过滤');
  const itemStart = experienceCode.indexOf('function sessionItem(');
  const itemBody = itemStart >= 0 ? experienceCode.slice(itemStart, experienceCode.indexOf('\n}', itemStart) + 2) : '';
  ok(itemStart >= 0 && !/kind !==|kind ===/.test(itemBody),
    'I2 单条会话项也不按 kind 分叉(管家开的线程与手工建的会话一视同仁)');
}

console.log(fail === 0 ? 'LIVE FULL TEXT STATIC: ALL PASS' : `LIVE FULL TEXT STATIC: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
