'use strict';
// dev-harness/ui-v3-p1.static.e2e.js — UI v3 P1(设计系统真落地:px→rem 字号 / 语义 -bg·-fg / 圆角合一 /
// SVG 线性图标集)前端契约护栏。零依赖、离线、node 直跑、无端口。纯静态:只读 styles.css / index.html /
// app.js(聚合)/ js/icons.js 做字面量·正则断言。真实渲染由指挥官用 preview 核验。判定行:
// `UI V3 P1 STATIC E2E: ALL PASS`。仿 ui-v3-wave1.static / agent-workflow-monitor-ui 风格。
const fs = require('fs');
const path = require('path');
const { readFrontendSrc, PUB } = require('./read-frontend-src.js');

const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const iconsSrc = fs.readFileSync(path.join(PUB, 'js', 'icons.js'), 'utf8');
const src = readFrontendSrc(); // app.js + js/**(含 icons.js)

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const countRe = (s, re) => (s.match(re) || []).length;

// ═══════════ 1. 字号 px→rem 一刀切(§1.1) ═══════════
// 白名单:仅两处 :root 基线锚点(pro 14px / simple 15px)允许裸 px;vendor 目录不在扫描范围。
const pxFs = css.match(/font-size:\s*[0-9.]+px/g) || [];
ok(pxFs.length === 2, '1.1 styles.css 裸 px 字号仅剩 2 处基线锚点(实际 ' + pxFs.length + (pxFs.length ? ':' + JSON.stringify(pxFs) : '') + ')');
ok(/:root\s*\{[^}]*font-size:\s*14px/.test(css), '1.1 白名单:pro 基线 :root font-size:14px');
ok(/:root\[data-ui-mode="simple"\]\s*\{[^}]*font-size:\s*15px/.test(css), '1.1 白名单:simple 基线 :root font-size:15px');
// --fs-* 阶梯全为 rem(无 px 定义),七级 + 2xl 齐备。
ok(!/--fs-[a-z0-9]+:\s*[0-9.]+px/.test(css), '1.1 --fs-* 阶梯无 px 定义(全 rem)');
for (const [t, v] of [['xs', '0.786'], ['sm', '0.857'], ['md', '0.929'], ['base', '1'], ['lg', '1.143'], ['xl', '1.429'], ['2xl', '1.714']]) {
  ok(new RegExp('--fs-' + t + ':\\s*' + v.replace('.', '\\.') + 'rem').test(css), '1.1 --fs-' + t + ' = ' + v + 'rem');
}
// app.js 内联样式无 px 字号(已 → var(--fs-sm))。
ok(!/font-size:\s*[0-9.]+px/.test(src.replace(/font-size:\s*1[45]px/g, '')), '1.1 app.js/js 内联样式无裸 px 字号');
// 装饰性大 emoji 特例(30/34→rem)与 body-input 特例(palette 15→1.071rem)保留为 rem。
ok(countRe(css, /font-size:\s*[0-9.]+rem/g) >= 3, '1.1 rem 特例 ≥3(装饰大图标 + palette 输入)');

// ═══════════ 2. 语义 -bg/-fg 接线 + 圆角合一(§1.2) ═══════════
const bgRefs = countRe(css, /var\(--(?:ok|warn|danger|info)-bg\)/g);
const fgRefs = countRe(css, /var\(--(?:ok|warn|danger|info)-fg\)/g);
ok(bgRefs + fgRefs >= 25, '1.2 -bg/-fg 引用数 ≥25(bg ' + bgRefs + ' + fg ' + fgRefs + ' = ' + (bgRefs + fgRefs) + ')');
ok(bgRefs >= 20, '1.2 背景 -bg 引用 ≥20(手写 color-mix 背景收敛)');
// 手写 transparent-based 语义背景 color-mix 已全部收敛(panel-2 面豁免除外)。
ok(!/background:\s*color-mix\(in srgb, var\(--(?:ok|warn|danger|info)\) [0-9.]+%, transparent\)/.test(css),
  '1.2 无手写 color-mix(--sem N%, transparent) 背景残留');
ok(/-bg 豁免/.test(css), '1.2 panel-2 面 -bg 豁免有注释存档');
// 圆角双轨合一:--radius/--radius-sm 成 --r-* 别名。
ok(/--radius:\s*var\(--r-md\)/.test(css), '1.2 --radius → var(--r-md) 别名');
ok(/--radius-sm:\s*var\(--r-sm\)/.test(css), '1.2 --radius-sm → var(--r-sm) 别名');

// ═══════════ 3. SVG 线性图标集(§2.15) ═══════════
ok(/export function icon\(/.test(iconsSrc), '3 icons.js 导出 icon()');
ok(/export function hydrateIcons\(/.test(iconsSrc), '3 icons.js 导出 hydrateIcons()');
ok(/createElementNS/.test(iconsSrc) && !/\.innerHTML\s*=/.test(iconsSrc), '3 icons.js 用 createElementNS 构建(无 innerHTML 赋值,XSS 安全)');
ok(/setAttribute\('stroke', 'currentColor'\)/.test(iconsSrc), '3 icons.js stroke=currentColor(随文字/引擎色)');
ok(/setAttribute\('stroke-width', '1\.5'\)/.test(iconsSrc), '3 icons.js stroke-width 1.5');
const iconKeys = iconsSrc.match(/^ {2}[a-z0-9]+: \[/gm) || [];
ok(iconKeys.length >= 20, '3 icons.js 图标数 ≥20(实际 ' + iconKeys.length + ')');
for (const need of ['folder', 'shield', 'toolbox', 'paperclip', 'sparkles', 'send', 'stop', 'settings', 'stethoscope', 'menu', 'more', 'close', 'pin', 'edit', 'trash', 'plus']) {
  ok(new RegExp('^ {2}' + need + ': \\[', 'm').test(iconsSrc), '3 图标齐备:' + need);
}

// ═══════════ 4. chrome 层 emoji 已换 SVG(index.html + app.js) ═══════════
// index.html 静态 chrome 按钮/徽标带 data-icon(启动时 hydrateIcons 注入 SVG)。
for (const [id, name] of [['workspacePicker...folder', 'folder'], ['perm...shield', 'shield'], ['tools...toolbox', 'toolbox'],
  ['sidebar...menu', 'menu'], ['more', 'more'], ['send', 'send'], ['plus', 'plus'], ['paperclip', 'paperclip'],
  ['settings', 'settings'], ['stethoscope', 'stethoscope'], ['collapse', 'collapse'], ['help', 'help'], ['close', 'close']]) {
  ok(new RegExp('data-icon="' + name + '"').test(html), '4 index.html data-icon="' + name + '" 就位');
}
ok(/id="skillBtn"[^>]*\bbtn-ic\b/.test(html), '4 技能按钮 btn-ic(sparkles 由 app.js 重建)');
ok(/hydrateIcons\(\)/.test(src), '4 app.js boot 调用 hydrateIcons()');
// 顶栏/侧栏/composer/模态 chrome emoji 已从 index.html 移除(🔧/🌙 模式·主题切换态 emoji 与 importMcp 📁 属豁免)。
for (const gone of ['🛡', '🧰', '☰', '✨', '📎', '▷', '✕']) {
  ok(!new RegExp(gone).test(html), '4 index.html 无 chrome emoji ' + gone + ' 残留');
}
// app.js 动态 chrome 按钮改用 icon():旧 emoji 字面量已清。
ok(/iconTextBtn\(btn, 'sparkles'/.test(src), '4 app.js 技能徽标 sparkles SVG');
// 第40波: 锁迁移到 i18n 形状(文案键 t('common.stop')/t('chat.send'),zh-CN 解析为 停止/发送 已核验);
// 语义不变 —— 运行态 stop 图标 + 停止文案,完成还原 send 图标 + 发送文案。
ok(/iconTextBtn\(btn, 'stop', t\('common\.stop'\)\)/.test(src) && /iconTextBtn\(btn, 'send', t\('chat\.send'\)\)/.test(src), '4 app.js 发送⇄停止 SVG 切换');
ok(/icon\('pin', 15\)/.test(src) && /icon\('edit', 15\)/.test(src) && /icon\('trash', 15\)/.test(src), '4 app.js 会话项操作(置顶/改名/删)SVG');
ok(/icon\(isDesktopTool \? 'monitor' : 'wrench'/.test(src), '4 app.js 工具卡 tc-icon SVG(monitor/wrench)');
ok(!/\? '🖥' : '🔧'/.test(src), '4 app.js 旧 tc-icon emoji 三元已清');
ok(!/el\('button', '', '✕'\)/.test(src) && !/el\('button', 'icon-btn', '✕'\)/.test(src), '4 app.js 动态关闭 ✕ emoji 已换 close SVG');
ok(!/el\('button', '', s\.pinned \? '📌'/.test(src), '4 app.js 会话项 pin/删 emoji 字面量已清');
// 保留区(playbook 卡 icon / toast / 消息正文)不误伤:onboard-drop-icon 仍是 📁(装饰,用户心智)。
ok(/onboard-drop-icon', '📁'\)/.test(src), '4 保留区:onboard-drop-icon 📁 未被误换(装饰 emoji)');

// ═══════════ 5. theme 键集对称约束勿破(两 [data-theme] 块令牌键集一致) ═══════════
function tokenKeys(selector) {
  const idx = css.indexOf(selector); if (idx < 0) return null;
  const open = css.indexOf('{', idx); const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const keys = new Set(); const re = /(--[a-z0-9-]+)\s*:/gi; let m;
  while ((m = re.exec(body))) { const k = m[1].toLowerCase(); if (!k.startsWith('--eng-')) keys.add(k); }
  return keys;
}
const dk = tokenKeys(':root[data-theme="dark"]');
const lk = tokenKeys(':root[data-theme="light"]');
ok(dk && lk && dk.size > 0, '5 解析到 dark/light 主题令牌块');
if (dk && lk) {
  const onlyDark = [...dk].filter(k => !lk.has(k));
  const onlyLight = [...lk].filter(k => !dk.has(k));
  ok(onlyDark.length === 0 && onlyLight.length === 0,
    '5 两主题令牌键集对称(dark 独有 ' + JSON.stringify(onlyDark) + ' / light 独有 ' + JSON.stringify(onlyLight) + ')');
  for (const t of ['--ok-bg', '--ok-fg', '--warn-bg', '--warn-fg', '--danger-bg', '--danger-fg', '--info-bg', '--info-fg']) {
    ok(dk.has(t) && lk.has(t), '5 语义 ' + t + ' 两主题均定义');
  }
}

if (fail === 0) console.log('\nUI V3 P1 STATIC E2E: ALL PASS');
else { console.log(`\nUI V3 P1 STATIC E2E: ${fail} FAIL`); process.exitCode = 1; }
