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
// 128f-⑫ 重钉 2 → 3：第三处是 reloadCurrentSessionAfterAway —— 管家视角里动过当前这条线程（推送来了、中栏不在屏上），
// 切回工作台那一刻整份重读一次（审计 E：修前要换一次会话才看得见）。它只在「离开期间来过这条线程的推送」时走一次，
// 不是第二条轮询；反向：去掉那一笔标记（pushLiveTurn 里 currentChangedWhileAway = true）→ action-feedback R7 红。
// 134 重钉 3 → 4：第四处是 bindLiveEventStream 里 background.completed 的完成回执 —— 后台命令/子代理跑完那一刻
// 整份重读一次，把台账合并进来的那条 system 消息画上。同样只在推送到达时走一次，不是轮询；未绑定当前线程的直接返回。
ok(count(experienceCode, /api\(`\/api\/sessions\/\$\{encodeURIComponent\(id\)\}`\)/g) === 4
  && /async function reloadCurrentSessionAfterAway\(\)/.test(experienceCode),
  `E4 只有 openSession、那一拍、切回工作台重读、后台完成回执这四处会去取会话(实测 ${count(experienceCode, /api\(`\/api\/sessions\/\$\{encodeURIComponent\(id\)\}`\)/g)} 处)`);

/* ─── F 样式层 ─────────────────────────────────────────────────────────────── */
for (const sel of ['.live-turn-title', '.live-turn-body', '.live-turn-tool', '.live-turn-stop']) {
  ok(chatLive.includes(sel), `F1 ${sel} 落在【已注册的】所有权层 css/states/chat-live.css`);
}
ok(!/#[0-9a-fA-F]{3,8}\b/.test(chatLive.slice(chatLive.indexOf('117m-A5'))),
  'F2 新增规则零硬编码色(全 token / color-mix)');
ok(crypto.createHash('sha256').update(readLayerPayload()).digest('hex') === LEGACY_STYLES_SHA256,
  'F3 经典样式载荷锁已按本波的有意新增重钉');
{
  // 117r-D4(用户第八轮走查④「2.0 视窗,为啥在运行时会显示这段对话是在一个框里」):117o-A7 之后
  // 在途正文与落盘消息已经逐像素同源,于是 A5 那圈虚线边框成了唯一的差别 —— 它不再读作「草稿」,
  // 而读作「一个嵌在页面里的窗口」;max-height + overflow:auto 那条内滚动条更把它坐实成子窗口。
  // 两条都撤掉。扫 CSS 之前【先剥注释】:上面那段注释里就写着 border / max-height 这些字,
  // 不剥就会匹配到自己写下的说明而假绿(117q-B3b 踩过同款)。
  const liveCss = stripComments(chatLive);
  const rule = sel => {
    const at = liveCss.indexOf(`${sel} {`);
    return at >= 0 ? liveCss.slice(at, liveCss.indexOf('}', at) + 1) : '';
  };
  const mainRule = rule('.message.live-turn .msg-main');
  ok(!/(border|background|padding)\s*:/.test(mainRule),
    `F4 在途气泡的正文列与普通助手消息【同形】:没有自己的边框/底色/内边距(实测规则「${mainRule || '整条已删'}」)`);
  // overflow-wrap 不是内滚动,所以锁的是「overflow 后面紧跟冒号」而不是裸的 overflow 三个字。
  const scrolls = sel => /max-height\s*:/.test(rule(sel)) || /overflow\s*:/.test(rule(sel));
  ok(!scrolls('.live-turn-narrative') && !scrolls('.live-turn-body'),
    'F5 正文没有自己的滚动上限:靠整页滚动来看,不是窗中窗(narrative / body 两处 max-height + overflow 都已撤)');
  // 正向锁:去掉内滚动之后页面高度每拍都在变,重绘必须自己兜住阅读位置(否则用户滚上去看历史会被顶飞)。
  // 位置在 paintLiveTurnCard() 而不是 paintLiveTurnNarrative():cut/body/tool/iter 四处文本也在同一拍改,
  // 且没有账本时 body 就是全部正文 —— 括号开在外层才盖得住两条路。
  const start = experienceCode.indexOf('function paintLiveTurnCard(');
  const body = start >= 0 ? experienceCode.slice(start, experienceCode.indexOf('\n}', start) + 2) : '';
  ok(/captureScrollAnchor\(box\)/.test(body) && /restoreScrollAnchor\(box, scroll\)/.test(body),
    'F6 每拍重绘前后用 captureScrollAnchor / restoreScrollAnchor 兜住 #messages 的阅读位置');
}

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
  // 121-K4（34 号文 §2.3 末条）：2.0 的会话列表由左栏的任务索引取代 —— 渲染只剩那一处
  // （js/steward-board.js 的 renderRail／renderThreadRow）。钉的那件事一个字没变，而且比修前更强：
  // 修前钉的是「经典壳那一份不过滤」，现在钉的是「全仓唯一的那一份不过滤」。
  const railSrc = fs.readFileSync(path.join(PUBLIC, 'js', 'steward-board.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const railStart = railSrc.indexOf('function renderRail()');
  const railBody = railStart >= 0 ? railSrc.slice(railStart, railSrc.indexOf('\n  }', railStart) + 4) : '';
  ok(railStart >= 0 && !/\bkind\b/.test(railBody), 'I1 左栏（两视角共用的那一份）的渲染里没有任何 kind 过滤');
  const rowStart = railSrc.indexOf('function renderThreadRow(');
  const rowBody = rowStart >= 0 ? railSrc.slice(rowStart, railSrc.indexOf('\n  }', rowStart) + 4) : '';
  ok(rowStart >= 0 && !/kind !==|kind ===/.test(rowBody),
    'I2 单条行也不按 kind 分叉(管家开的线程与手工建的会话一视同仁；K3 之后 kind 对两者同样返回 quick_ask，身份改读 row.quick)');
  // renderSessions 自此只是「叫左栏重画一次」的转接口：它不许自己长出第二份行渲染。
  const bridgeStart = experienceCode.indexOf('function renderSessions()');
  const bridgeBody = bridgeStart >= 0 ? experienceCode.slice(bridgeStart, experienceCode.indexOf('\n}', bridgeStart) + 2) : '';
  ok(bridgeStart >= 0 && /railRenderer\(\)/.test(bridgeBody) && !/createElement|innerHTML|appendChild/.test(bridgeBody),
    'I2b renderSessions 只剩一个转接口（调注入的左栏渲染），它自己一行都不画');
}

// ── J 125-P2(42 号文 §5 P2):缓存徽标的数据源只有结构化字段,两条路都画 ──────────────────
// 这枚徽标要说的是「这一段不是刚抓的」。它一旦开始猜(去正文里找关键词、或按 staleReason 的
// 措辞判断),就会在两个方向上说谎:该印的不印、不该印的乱印。与 124-P3 的回执徽标同一条纪律 ——
// **判回执／判时效的那几段里,一个正文字段都不许读。**
{
  const streamRuntime = read(path.join(PUBLIC, 'js', 'chat-stream-runtime.js'));
  const codeOnly = text => String(text).split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  const at = primitives.indexOf('function staleCacheDays(name, result) {');
  const end = at < 0 ? -1 : primitives.indexOf('\n  }', at);
  const judge = at < 0 ? '' : (end < 0 ? primitives.slice(at) : primitives.slice(at, end));
  ok(judge.length > 120, `J0 staleCacheDays 函数体切得到(切不到 = 本组静默失效;实得 ${judge.length})`);
  ok(/r\.fromCache !== true/.test(judge) && /Date\.parse\(String\(r\.ts \|\| ''\)\)/.test(judge),
    'J1 判据只读 fromCache 与 ts 两个结构化字段');
  for (const forbidden of ['.text', 'staleReason', 'includes(', 'match(', 'indexOf(']) {
    ok(!codeOnly(judge).includes(forbidden), `J2 判据里不出现 ${forbidden}(它一读正文就开始猜)`);
  }
  ok(/name !== 'web_fetch'/.test(judge), 'J3 只认 web_fetch 这一个工具(别的工具没有「缓存」这回事)');
  // 两条路都画:回放那支在 toolCard() 里,live 那支在流式 tool_result 里,少一支就有一条路不说话。
  ok(/if \(settled && tc\.result !== undefined\) renderStaleBadgeInto\(staleHost, tc\.name, tc\.result\);/.test(primitives),
    'J4 回放路径(toolCard)画它');
  ok(/renderStaleBadgeInto\(card\.staleHost, card\.name, evt\.content\);/.test(streamRuntime),
    'J5 live 路径(流式 tool_result)画它');
  ok(!/isError \?[^\n]*renderStaleBadgeInto|if \(!evt\.isError\) renderStaleBadgeInto/.test(streamRuntime),
    'J6 live 那一支【不】按 isError 分叉 —— 回落缓存时 web_fetch 回的正是 ok:true,按错误分叉等于永远不画');
  ok(/\.tool-card \.tc-stale \{ display: none; \}/.test(chatLive) && /\.tc-stale\[data-stale\]/.test(chatLive),
    'J7 样式落在已注册的所有权层 chat-live.css,且没有 data-stale 时整枚不占位(其余工具卡逐像素不变)');
}

console.log(fail === 0 ? 'LIVE FULL TEXT STATIC: ALL PASS' : `LIVE FULL TEXT STATIC: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
