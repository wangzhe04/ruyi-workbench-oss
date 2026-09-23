'use strict';
/*
 * 静态锁 (第50波50b, UI-DESIGN-V4): 毛玻璃材质纪律。
 *
 *  G1 玻璃令牌族双主题齐(theme.e2e 键集之外的点名锁:blur 三档在 :root);
 *  G2 backdrop-filter 使用点白名单 —— 只允许:token 定义(:root --glass-blur-*)、@supports 回退、
 *     框架族 4 面(.sidebar/.tool-pane/.topbar/.composer)、浮层族 4 面(.modal/.palette/.popover/.toast);
 *     Preview 全局待决抽屉的 scrim/drawer 也是单一互斥浮层；其它选择器出现即红
 *     (模糊预算 §3.2-E 的机械约束:同屏 ≤6,列表卡片一律不叠 blur);
 *  G3 禁散写 blur 字面量 —— 所有 backdrop-filter 值必须走 var(--glass-blur-*),禁 backdrop-filter: blur(Npx) 直写;
 *  G4 body 背景 = var(--scene-bg)(底层有景)且 background-attachment: fixed;
 *  G5 降级路径在:@supports not (backdrop-filter) 实色回退 + prefers-reduced-transparency 关模糊;
 *  G6 阅读区克制:.chat-pane 不叠 blur(注释钉),代码块背景不走玻璃 token(--code-bg 实色);
 *  G7 主题三态:effectiveTheme/toggleTheme 循环 dark→light→system、index.html 预绘解析 system、
 *     matchMedia 监听、i18n navigation.theme.system 双目录四件;
 *  G8 点色化:button.primary 走青花-黛紫渐变;.session-item.active 不再 accent-soft 大片铺底。
 *
 * Run: node dev-harness/ui-v4-glass.static.e2e.js
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CSS = require('./read-frontend-css.js').readFrontendCss();
const APP = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'app.js'), 'utf8');
const WORKSPACE_PREFS = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'js', 'workspace-preferences.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'index.html'), 'utf8');
const readLoc = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const zh = readLoc('ruyi-workbench/app/public/locales/zh-CN.json');
const en = readLoc('ruyi-workbench/app/public/locales/en-US.json');
const dzh = readLoc('docs/i18n/locales/zh-CN.json');
const den = readLoc('docs/i18n/locales/en-US.json');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// ── G1 blur 三档在 :root(非颜色,不进主题键集) ──
ok(/--glass-blur-1:\s*blur\(8px\)/.test(CSS) && /--glass-blur-2:\s*blur\(16px\)/.test(CSS) && /--glass-blur-3:\s*blur\(24px\)/.test(CSS), 'G1 blur 三档 token 在(8/16/24 封顶)');

// ── G2 使用点白名单 ──
// 对每条 backdrop-filter 使用行,向前回溯最近的含 `{` 行取选择器(兼容单行规则 `.modal { ...` 与多行规则)。
const lines = CSS.split('\n');
const offenders = [];
const WHITE = ['.sidebar, .tool-pane', '.topbar', '.composer', '.modal', '.palette', '.popover', '.toast',
  '.mermaid-lightbox', // Single full-screen viewer; shared blur token and transparency fallback.
  '.wb-layer-tag', '.wb-cvtools', // 工作台画布轻层(仅 blur-1,画布视图内,不入框架/浮层预算轴)
  '.preview-deskbar', '.preview-dock', '.preview-error-card', // Wave 76: 与经典框架互斥的 Preview 壳层; 主区三态只会出现一张卡
  '.preview-needs-scrim', '.preview-needs-drawer', // Wave 81: 一个全局、互斥的待决浮层；内部卡片不叠 blur
  // 117i: 管家壳（第三种壳模式）与经典壳／Preview 壳【互斥】——:root[data-shell-mode] 同一时刻只让
  // 一套壳上屏，所以这三面与上面的经典框架四面不会同时存在，模糊预算轴不变（与 Wave 76 给
  // Preview 壳开口子同一条理由）。管家壳里最多两面：居中卡片 + 右侧那一栏（抽屉与「现在这一件」
  // 本身也互斥：同一个 #stewardDrawer 节点在 docked 挂法下不叠自己的玻璃）。
  '.steward-stage', '.steward-drawer', '.steward-now',
  // 121-K6a（34 号文 §7.1 末句「--glass-* 自此只给浮层与安静卡」）：安静卡是工作台里管家唯一的
  // 打扰形态，与 .toast 同族——独立、悬浮、同屏顶多几张（5 分钟同线程同类合并成一张），不叠加
  // 在任何列表卡片上，不挤占框架族/浮层族已有的模糊预算轴。
  '.quiet-card',
  '@supports', '@media', ':root'];
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i];
  if (!/backdrop-filter:/.test(ln) || /^\s*--glass-blur/.test(ln)) continue;
  let sel = '';
  for (let j = i; j >= 0; j--) {
    const bi = lines[j].indexOf('{');
    if (bi >= 0) { sel = lines[j].slice(0, bi).trim(); break; }
  }
  if (!WHITE.some(w => sel.startsWith(w))) offenders.push((sel || '(?)') + ' | ' + ln.trim().slice(0, 60));
}
ok(offenders.length === 0, 'G2 backdrop-filter 使用点全在白名单(经典框架4+浮层4+Preview 互斥壳+管家互斥壳+降级块)' + (offenders.length ? ' → 越界: ' + offenders.join(' ;; ') : ''));

// ── G3 禁散写 blur 字面量(@supports/@media 查询行豁免,它们不是声明) ──
const literals = lines.filter(ln => /backdrop-filter:\s*blur\(/.test(ln) && !/^\s*--/.test(ln.trim()) && !/^\s*@(supports|media)/.test(ln.trim()));
ok(literals.length === 0, 'G3 无 backdrop-filter: blur() 散写字面量(全走 var(--glass-blur-*))');

// ── G4 body scene ──
ok(/body \{[^}]*background: var\(--scene-bg\);[^}]*background-attachment: fixed;/s.test(CSS), 'G4 body = --scene-bg + fixed 附着(底层有景)');

// ── G5 降级路径 ──
ok(/@supports not \(\(backdrop-filter: blur\(1px\)\)/.test(CSS), 'G5a @supports 实色回退在');
ok(/@media \(prefers-reduced-transparency: reduce\)/.test(CSS), 'G5b prefers-reduced-transparency 关模糊在');

// ── G6 阅读区克制 ──
ok(/\.chat-pane \{[^}]*background: transparent;/.test(CSS), 'G6a chat-pane 透明(scene 透出,不叠 blur)');
ok(!/\.chat-pane \{[^}]*backdrop-filter/s.test(CSS), 'G6b chat-pane 无 blur(阅读区克制)');
ok(/--code-bg: #/.test(CSS), 'G6c 代码块保持实色 token(--code-bg)');

// ── G7 主题三态 ──
ok(WORKSPACE_PREFS.includes('function effectiveTheme(') && WORKSPACE_PREFS.includes("prefers-color-scheme: dark"), 'G7a effectiveTheme system 解析在');
ok(/cur === 'dark' \? 'light' : cur === 'light' \? 'system' : 'dark'/.test(WORKSPACE_PREFS), 'G7b toggleTheme dark→light→system 循环');
ok(/addEventListener\('change'/.test(WORKSPACE_PREFS) && WORKSPACE_PREFS.includes("if (cur === 'system') applyTheme('system')"), 'G7c matchMedia 变更监听(system 档随 OS)');
ok(HTML.includes("t === 'system'") && HTML.includes('prefers-color-scheme'), 'G7d index.html 预绘解析 system(防闪)');
ok(!APP.includes("$('themeToggle').textContent = theme === 'dark' ? '🌙' : '☀️'"), 'G7e themeToggle emoji 已换 SVG(emoji 清零首例)');
for (const [name, content] of [['zh', zh], ['en', en], ['docs-zh', dzh], ['docs-en', den]]) {
  ok(content.includes('"navigation.theme.system"'), 'G7f i18n navigation.theme.system 在(' + name + ')');
}

// ── G8 点色化 ──
ok(/button\.primary \{ background: linear-gradient\(135deg, var\(--accent\), color-mix\(in srgb, var\(--accent\) 72%, var\(--accent-2\)\)\)/.test(CSS), 'G8a 主按钮青花-黛紫渐变');
// 121-K4（34 号文 §2.3）：2.0 的会话项（.session-item）随会话列表退役，左栏画的是那枚三面共用的
// 线程卡。「选中」的表达因此换了形状，而且比修前更省一个信号：
//   · 选中 = 一层极淡的点色底（.is-sel，§2.9 表里那条 120ms 背景）；
//   · 左边那道 3px 色条【一直在】，它说的是「这是哪个任务」（F1 纪律：色 ≠ 态、也 ≠ 选中），
//     所以不需要再为选中画第二条竖线。
ok(!/\.session-item/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')),
  'G8b 2.0 会话项那一族规则已随会话列表退役（扫的是剥掉注释的载荷：退役说明本身要写清那个类名）');
ok(/\.steward-board-thread\.is-sel \{ background: var\(--accent-soft\); \}/.test(CSS)
  && /\.steward-tcard-bar \{[\s\S]{0,200}background: var\(--thread-color\);/.test(CSS),
  'G8c 左栏选中是一层点色底；左边那道 3px 色条仍然只说「这是哪个任务」');

console.log('\nUI V4 GLASS STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
