#!/usr/bin/env node
'use strict';
// 静态锁（第121波 K8，34 号文 §2.10.4「文案规范：术语表与措辞」）：**禁用词零命中**。
//
// 事实源是 §2.10.4 的两句话：「术语只剩这几个」与「禁用词（界面上一个都不许出现）」。
// 这一件把那张表钉成一道门，扫两个面：
//   ① 四份 locale（ruyi-workbench/app/public/locales/{zh-CN,en-US}.json 与 docs/i18n/locales/ 的镜像）的【值】；
//   ② public/ 的模板（index.html）里【真的会画到屏幕上】的那些字：文本节点与
//      placeholder／title／aria-label／data-i18n 兜底文案。
//
// 为什么要有这一件：K1 删了交办台、K4 删了「2.0 视窗」按钮、K5 收了配置 chip、K8 把「会话」
// 归一成「线程」—— 每一步都清过一遍词，但没有一道门拦「下一次又写回去」。33/34 号文里
// 「同一个东西两个名字」这类账已经记过三轮，每一轮都是靠人眼发现的。
//
// **注释不算界面**（与 copy-path-guard.static 同一条口径）：为什么删掉「2.0 视窗」这件事，
// 必须能写在代码注释里说清楚，否则后人只会把它加回来。所以 index.html 扫描前先剥掉
// <!-- --> 与 <script> 里的 // 行注释；locale 里没有注释，值就是界面。
//
// 判定行：`COPY TERMS STATIC E2E: ALL PASS`
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const DOCS_LOCALES = path.join(ROOT, 'docs', 'i18n', 'locales');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };

const LOCALES = [
  path.join(PUBLIC, 'locales', 'zh-CN.json'),
  path.join(PUBLIC, 'locales', 'en-US.json'),
  path.join(DOCS_LOCALES, 'zh-CN.json'),
  path.join(DOCS_LOCALES, 'en-US.json'),
];

// ── 禁用词（§2.10.4）。每条都写清楚「界面上该说什么」——门红的时候看这一行就知道怎么改。 ──
const BANNED = [
  ['会话', '线程'],
  ['2.0 视窗', '在工作台打开'],
  ['经典模式', '工作台（视角名）'],
  ['交办台', '（已退役，不提）'],
  ['去线程里看', '打开／在工作台打开'],
  ['Enter 发送', '（占位不带快捷键提示）'],
  ['『', '「'],
  ['』', '」'],
];

// ── 「会话」白名单：这几条说的【不是线程】，是别的东西各自的技术名词。逐条写理由。 ──
// 判据统一：这个「会话」指的是【引擎／协议／进程／浏览器】自己那一头的东西，改成「线程」反而说错。
const SESSION_ALLOW = new Map([
  ['error.api.authToken', '「工作台会话令牌」＝ HTTP 鉴权 token（runtime.json 里那一枚），不是线程'],
  ['settings.browserTarget.system', '「复用用户会话」＝ 浏览器里的登录态，说的是系统浏览器'],
  ['settings.agentCli.hint.kimi', '「会话续接／原生会话」＝ Kimi ACP 协议自己的名词，改了就对不上它的文档'],
  ['settings.resumeClaude', '「自动续接 Claude 会话」＝ 引擎侧 resume（claude --resume 那一层）'],
  ['settings.resumeAgentCli', '同上，Agent CLI 侧的 resume'],
  ['ctx.compact.hintExternal', '「从摘要重建原生会话」＝ 引擎侧上下文，不是如意这一层的线程'],
  ['turnActivity.notice.resumeRecovery', '「引擎会话已失效」＝ 引擎那一头断了，正是要说清是哪一层'],
  ['toast.shellCreated', '「shell 会话」＝ 一个 PowerShell 进程'],
  ['toast.shellEnded', '同上'],
]);

// ── 省略号：禁的是【占位与按钮】上的省略号（§2.10.4「空状态与占位……不带省略号」）。 ──
// 「压缩中…」这一类【进行态】提示不在此列：那三个点是「还在动」这件事本身的信号，不是占位。
// 判据不靠键名猜，靠一份显式清单：所有占位／按钮键在下面这张表里，表外的键不查省略号。
const NO_ELLIPSIS_KEYS = [
  'ask.otherPlaceholder', 'ask.textPlaceholder', 'chat.placeholder', 'palette.placeholder',
  'plan.card.notePlaceholder', 'session.search', 'session.rename.placeholder', 'session.name',
  'skills.searchPlaceholder', 'workflow.steerBox.placeholder',
  'stewardShell.compose.placeholder', 'stewardShell.compose.placeholderChange',
  'stewardShell.drawer.askPlaceholder', 'stewardShell.drawer.composerPlaceholder',
  'modelMenu.manageProviders', 'workspace.browse', 'common.custom',
  'settings.update.browse', 'settings.mcp.import', 'settings.externalMcpServer.import',
];

function flatten(object, prefix, out) {
  for (const key of Object.keys(object)) {
    const value = object[key];
    const full = prefix ? prefix + '.' + key : key;
    if (value && typeof value === 'object') flatten(value, full, out);
    else out[full] = String(value);
  }
  return out;
}

// ═══════════ 1. 四份 locale 的值 ═══════════
for (const file of LOCALES) {
  const name = path.relative(ROOT, file).split(path.sep).join('/');
  const flat = flatten(JSON.parse(fs.readFileSync(file, 'utf8')), '', {});
  for (const [word, instead] of BANNED) {
    const hits = Object.entries(flat)
      .filter(([key, value]) => value.includes(word))
      .filter(([key]) => !(word === '会话' && SESSION_ALLOW.has(key)));
    ok(hits.length === 0,
      '1 ' + name + ' 无「' + word + '」（该说「' + instead + '」）'
      + (hits.length ? ' —— 命中 ' + hits.length + ' 条：' + hits.slice(0, 4).map(h => h[0]).join('、') : ''));
  }
  // 白名单必须【真的还在命中】：某一条哪天被改掉了，白名单就该跟着删，否则它会悄悄放行下一条同名键。
  // 只对 zh 查 —— 白名单管的是中文「会话」这个词，en 侧那几条本来就不含它。
  if (/zh-CN\.json$/.test(name)) {
    const stale = [...SESSION_ALLOW.keys()].filter(key => flat[key] != null && !flat[key].includes('会话'));
    ok(stale.length === 0,
      '1 ' + name + ' 「会话」白名单无过期条目' + (stale.length ? '（该删：' + stale.join('、') + '）' : ''));
  }
  // 占位与按钮不带省略号。
  const withDots = NO_ELLIPSIS_KEYS.filter(key => flat[key] != null && /…|\.\.\./.test(flat[key]));
  ok(withDots.length === 0,
    '1 ' + name + ' 占位与按钮不带省略号' + (withDots.length ? ' —— ' + withDots.join('、') : ''));
}

// ═══════════ 2. index.html 里真的画出来的字 ═══════════
// 剥注释：<!-- --> 与 <script> 里的整行 // 注释。注释是工程说明，不是界面（同 copy-path-guard 口径）。
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const visible = html.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');
// 白名单的两条在 index.html 里是 data-i18n 的兜底文案，与 locale 同源同理由。
const HTML_SESSION_ALLOW = [
  'data-i18n="settings.resumeAgentCli"',   // 引擎侧 resume，同 locale 白名单
  'data-i18n="settings.browserTarget.system"', // 浏览器登录态，同 locale 白名单
];
for (const [word, instead] of BANNED) {
  const hits = visible.split('\n').map((line, index) => [index + 1, line])
    .filter(([, line]) => line.includes(word))
    .filter(([, line]) => !(word === '会话' && HTML_SESSION_ALLOW.some(allow => line.includes(allow))));
  ok(hits.length === 0,
    '2 index.html 可见文案无「' + word + '」（该说「' + instead + '」）'
    + (hits.length ? ' —— 行 ' + hits.map(h => h[0]).join('、') : ''));
}

// ═══════════ 3. 术语表本身：五态词只一份、线程/任务/视角名各只一个说法 ═══════════
const zh = flatten(JSON.parse(fs.readFileSync(LOCALES[0], 'utf8')), '', {});
// 「启动默认视角」的两个选项就是两个视角名，不许再叫「经典」。
ok(zh['shell.settingClassic'] === '工作台' && zh['shell.settingSteward'] === '管家（默认）',
  '3 启动默认视角两项 = 管家（默认）／工作台（§2.7 末条；不再叫「经典」）');
// §13.12 K8 ①②
ok(zh['stewardShell.drawer.lastSay'] === '它最后说', '3 焦点卡收工那一段说「它最后说」（§2.6 口径）');
ok(zh['stewardShell.drawer.classicView'] === '在工作台打开'
  && zh['stewardShell.board.classicView'] === '在工作台打开'
  && zh['stewardShell.openClassic'] === '在工作台打开',
  '3 「在工作台打开」三处逐字相同（一个动作只有一个说法）');
// §13.7 ⑤：未命名线程的标题回落不再是视角名。
ok(zh['session.untitled'] === '未命名线程',
  '3 未命名线程的标题回落是「未命名线程」，不是视角名「工作台」');

console.log('\nCOPY TERMS STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
