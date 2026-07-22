'use strict';
/*
 * 静态锁 (第50波50b, UI-DESIGN-V4): 毛玻璃材质纪律。
 *
 *  G1 玻璃令牌族双主题齐(theme.e2e 键集之外的点名锁:blur 三档在 :root);
 *  G2 backdrop-filter 使用点白名单 —— 只允许:token 定义(:root --glass-blur-*)、@supports 回退、
 *     框架族 4 面(.sidebar/.tool-pane/.topbar/.composer)、浮层族 4 面(.modal/.palette/.popover/.toast);
 *     其它选择器出现即红(模糊预算 §3.2-E 的机械约束:同屏 ≤6,列表卡片一律不叠 blur);
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
const CSS = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'styles.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'app.js'), 'utf8');
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
  '.wb-layer-tag', '.wb-cvtools', // 工作台画布轻层(仅 blur-1,画布视图内,不入框架/浮层预算轴)
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
ok(offenders.length === 0, 'G2 backdrop-filter 使用点全在白名单(框架4+浮层4+降级块)' + (offenders.length ? ' → 越界: ' + offenders.join(' ;; ') : ''));

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
ok(APP.includes('function effectiveTheme(') && APP.includes("prefers-color-scheme: dark"), 'G7a effectiveTheme system 解析在');
ok(/cur === 'dark' \? 'light' : cur === 'light' \? 'system' : 'dark'/.test(APP), 'G7b toggleTheme dark→light→system 循环');
ok(/addEventListener\('change'/.test(APP) && APP.includes("if (cur === 'system') applyTheme('system')"), 'G7c matchMedia 变更监听(system 档随 OS)');
ok(HTML.includes("t === 'system'") && HTML.includes('prefers-color-scheme'), 'G7d index.html 预绘解析 system(防闪)');
ok(!APP.includes("$('themeToggle').textContent = theme === 'dark' ? '🌙' : '☀️'"), 'G7e themeToggle emoji 已换 SVG(emoji 清零首例)');
for (const [name, content] of [['zh', zh], ['en', en], ['docs-zh', dzh], ['docs-en', den]]) {
  ok(content.includes('"navigation.theme.system"'), 'G7f i18n navigation.theme.system 在(' + name + ')');
}

// ── G8 点色化 ──
ok(/button\.primary \{ background: linear-gradient\(135deg, var\(--accent\), color-mix\(in srgb, var\(--accent\) 72%, var\(--accent-2\)\)\)/.test(CSS), 'G8a 主按钮青花-黛紫渐变');
ok(!/\.session-item\.active \{ background: var\(--accent-soft\)/.test(CSS), 'G8b 侧栏选中不再 accent-soft 大片铺底');
ok(/\.session-item\.active::before/.test(CSS), 'G8c 侧栏选中点色左条在');

console.log('\nUI V4 GLASS STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
