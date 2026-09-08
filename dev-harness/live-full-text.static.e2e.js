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

console.log(fail === 0 ? 'LIVE FULL TEXT STATIC: ALL PASS' : `LIVE FULL TEXT STATIC: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
