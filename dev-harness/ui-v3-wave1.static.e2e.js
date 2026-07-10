'use strict';
// dev-harness/ui-v3-wave1.static.e2e.js — UI v3 第一波(P0 断裂修复 + P0.5 快赢 + 美观提质)前端契约护栏。
//
// 零依赖、离线、node 直跑、无端口。纯静态:只读前端源码(read-frontend-src.js 聚合 app.js + js/**)、
// styles.css、index.html,以及内置技能 SKILL.md,做字面量/正则断言。真实渲染由指挥官用 preview 核验。
// 仿 agent-workflow-monitor-ui.e2e.js 风格。判定行:`UI V3 WAVE1 STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { readFrontendSrc, PUB } = require('./read-frontend-src.js');

const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const src = readFrontendSrc();
const SKILLS_DIR = path.resolve(__dirname, '..', 'ruyi-workbench', 'resources', 'plugins',
  'win-workbench-offline', 'offline-toolkit', 'skills');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const count = (s, sub) => s.split(sub).length - 1;

// ───────────── A4/A5 令牌清障:无未定义引用 / 无防御字面量 / 无硬编码审计色 ─────────────
ok(!/var\(--fg\)/.test(css), 'A4 styles.css 无 var(--fg) 残留(→ --ink)');
ok(!/var\(--text\)/.test(css), 'A4 styles.css 无 var(--text) 残留(→ --ink)');
ok(!/var\(--(?:danger|ok|warn),\s*#[0-9a-fA-F]{3,6}\)/.test(css), 'A4 无 var(--x,#hex) 防御字面量(工作流区去尾成纯 var())');
ok(!/#2f6fb0/.test(css), 'A5 审计徽标无硬编码 #2f6fb0(→ var(--accent))');
ok(!/#c9772f/.test(css), 'A5 审计徽标无硬编码 #c9772f(→ var(--warn))');
ok(/\.audit-badge\.src-workbench\s*\{[^}]*var\(--accent\)/.test(css), 'A5 工作台审计徽标以 var(--accent) 着色');
ok(/\.audit-badge\.src-desktop\s*\{[^}]*var\(--warn\)/.test(css), 'A5 桌面审计徽标以 var(--warn) 着色');

// ───────────── A5 引擎色统一:Claude 消息徽标/头像用 --accent(青花蓝) ─────────────
ok(/letter:\s*'C',\s*colorVar:\s*'var\(--accent\)'/.test(src), 'A5 app.js engineVisual:Claude 引擎色 = var(--accent)');
ok(/--wf-claude:\s*var\(--accent\)/.test(css) && /--wf-provider:\s*var\(--eng-claude\)/.test(css),
  'A5 工作流 token 未动:--wf-claude=accent / --wf-provider=eng-claude(赭,保持)');

// ───────────── A1 移动端顶栏不裁切(≤760 自适应高度 + 三 chip 降级) ─────────────
ok(/@media \(max-width:\s*760px\)/.test(css), 'A1 存在 ≤760px 媒体查询');
ok(/\.topbar\s*\{[^}]*height:\s*auto[^}]*min-height:\s*54px/.test(css), 'A1 ≤760 顶栏 height:auto + min-height:54px(不定高裁切)');
ok(/\.topbar\s*\{[^}]*flex-wrap:\s*wrap/.test(css), 'A1 ≤760 顶栏允许换行(flex-wrap:wrap)');
ok(/\.workspace-picker \.wp-name\s*\{[^}]*display:\s*none/.test(css), 'A1 工作台 chip 降级只留图标(隐藏 .wp-name)');
ok(/\.model-chip \.mc-model\s*\{[^}]*display:\s*none/.test(css), 'A1 模型 chip 降级隐藏 .mc-model');
ok(/\.perm-chip \.pc-name\s*\{[^}]*max-width/.test(css), 'A1 安全 chip 短名截断(max-width)');

// ───────────── A2 移动端首启折叠侧栏(matchMedia,不污染桌面偏好) ─────────────
ok(/function setSidebarCollapsed\(collapsed,\s*persist\s*=\s*true\)/.test(src), 'A2 setSidebarCollapsed 增 persist 形参');
ok(/matchMedia\('\(max-width:\s*760px\)'\)\.matches\)\s*setSidebarCollapsed\(true,\s*false\)/.test(src),
  'A2 无偏好时 ≤760 首启折叠侧栏(persist=false,不写 localStorage)');

// ───────────── A3 触屏 hover-only 操作常显 ─────────────
ok(/@media \(hover:\s*none\)/.test(css), 'A3 存在 @media (hover:none) 块');
const hoverBlock = (css.match(/@media \(hover:\s*none\)\s*\{[\s\S]*?\n\}/) || [''])[0];
ok(/\.msg-actions/.test(hoverBlock) && /\.s-actions/.test(hoverBlock) && /\.ftree-at/.test(hoverBlock),
  'A3 hover:none 块覆盖 msg-actions / s-actions / ftree-at');
ok(/opacity:\s*\.75/.test(hoverBlock), 'A3 触屏常显透明度 .75');

// ───────────── B1 简单模式技能入口:隐藏规则已删 + 文案 ✨ ─────────────
ok(!/\[data-ui-mode="simple"\][^{]*#skillBtn[^{]*\{[^}]*display:\s*none/.test(css),
  'B1 简单模式 #skillBtn 隐藏规则已删(技能入口显性)');
ok(/✨ 技能/.test(html), 'B1 index.html 技能按钮文案 ✨ 技能');
ok(/✨ 技能/.test(src) && !/⌘ 技能/.test(src), 'B1 app.js 技能徽标文案 ✨(无 ⌘ 残留)');

// ───────────── B2 右栏页签减负(简单 6→4)+ AI 工作聚合入口 ─────────────
ok(/\[data-ui-mode="simple"\][^{]*button\[data-tab="usage"\]/.test(css) &&
   /\[data-ui-mode="simple"\][^{]*button\[data-tab="audit"\]/.test(css),
  'B2 简单模式隐藏「用量」「审计」页签按钮');
ok(/\.agent-runs-subnav/.test(css) && /class="agent-runs-subnav"/.test(html), 'B2 AI 工作面板顶部 mini 链接行(agent-runs-subnav)');
ok(/id="usageMiniLink"/.test(html) && /id="auditMiniLink"/.test(html), 'B2 用量/审计 mini 链接元素存在');
ok(/usageMiniLink'\)[\s\S]{0,60}switchTab\('usage'\)/.test(src) && /auditMiniLink'\)[\s\S]{0,60}switchTab\('audit'\)/.test(src),
  'B2 mini 链接 wire 到 switchTab(usage/audit)');
ok(/data-tab="agent-runs"[\s\S]{0,140}'AI 工作'/.test(src), 'B2 applyUiMode 把 agent-runs 页签文案改「AI 工作」');

// ───────────── B4 tap-min 接线 ─────────────
ok(count(css, 'var(--tap-min)') >= 6, 'B4 var(--tap-min) 出现次数 ≥6(实际 ' + count(css, 'var(--tap-min)') + ')');
ok(/button\s*\{[^}]*min-height:\s*var\(--tap-min\)/.test(css), 'B4 button 基类挂 min-height:var(--tap-min)');
ok(/\.icon-btn\s*\{[^}]*max\(var\(--tap-min\),\s*32px\)/.test(css), 'B4 icon-btn 尺寸随 tap-min(下限 32)');
ok(/\.pool-actions button\s*\{[^}]*min-height:\s*var\(--tap-min\)/.test(css) || /\.pool-actions button[^{]*\{[^}]*var\(--tap-min\)/.test(css),
  'B4 pool-actions 审批按钮补 tap-min');

// ───────────── B5 body 字号解锁 ─────────────
const bodyBlock = (css.match(/\bbody\s*\{[^}]*margin:\s*0[^}]*\}/) || [''])[0];
ok(bodyBlock && !/font-size:\s*\d/.test(bodyBlock), 'B5 body 样式块不再硬编码 font-size');
ok(/:root\s*\{[^}]*font-size:\s*14px/.test(css), 'B5 :root 显式设 font-size:14px(pro 基线)');
ok(/:root\[data-ui-mode="simple"\]\s*\{[^}]*font-size:\s*15px/.test(css), 'B5 简单模式 :root 覆盖 font-size:15px');

// ───────────── C1 投影 elev 接线 ─────────────
for (const t of ['--elev-1', '--elev-2', '--elev-3']) ok(new RegExp(`${t}\\s*:`).test(css), `C1 ${t} 已定义`);
ok(/\.popover\s*\{[^}]*box-shadow:\s*var\(--elev-2\)/.test(css), 'C1 .popover 用 var(--elev-2)');
ok(/\.modal\s*\{[^}]*box-shadow:\s*var\(--elev-3\)/.test(css), 'C1 .modal 用 var(--elev-3)');
ok(/\.pb-card\s*\{[\s\S]{0,340}box-shadow:\s*var\(--elev-1\)/.test(css), 'C1 .pb-card 用 var(--elev-1)');
ok(/\[data-theme="light"\]\s*\{[\s\S]*?--elev-1:/.test(css), 'C1 亮色主题覆写 elev(深浅双主题)');

// ───────────── C2 卡片 hover 提质 ─────────────
ok(/button\.pb-card:hover\s*\{[^}]*translateY\(-2px\)[^}]*var\(--elev-2\)/.test(css), 'C2 .pb-card hover translateY(-2px)+elev-2');

// ───────────── C3 品牌水印 ─────────────
ok(/\.empty-state::before[\s\S]{0,400}opacity:\s*\.07/.test(css), 'C3 云纹水印 opacity .04→.07');

// ───────────── C4 头像 SVG ─────────────
ok(/function buildMsgAvatar\(/.test(src), 'C4 buildMsgAvatar 头像构建器存在');
ok(/buildMsgAvatar\(avatar,\s*role\)/.test(src), 'C4 messageShell 调用 buildMsgAvatar');
ok(!/el\('div',\s*'avatar',\s*role === 'user'/.test(src), 'C4 旧字母方块头像(你/C/S)已移除');
ok(/\.message\.system \.avatar\s*\{[^}]*background:\s*transparent/.test(css), 'C4 系统头像无底色(⚙ 弱化)');

// ───────────── C6 发送按钮运行态 ─────────────
ok(/⏹ 停止/.test(src), 'C6 运行态发送按钮换「⏹ 停止」');

// ───────────── B3 内置技能中文化(读每个 SKILL.md 校验中文 name frontmatter) ─────────────
let skillDirs = [];
try { skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
catch (e) { ok(false, 'B3 能读取 skills 目录:' + e.message); }
ok(skillDirs.length >= 16, 'B3 内置技能目录数 ≥16(实际 ' + skillDirs.length + ')');
const CJK = /[一-鿿]/;
let missing = [];
for (const id of skillDirs) {
  const p = path.join(SKILLS_DIR, id, 'SKILL.md');
  let txt = '';
  try { txt = fs.readFileSync(p, 'utf8'); } catch { missing.push(id + '(读不到)'); continue; }
  const m = txt.match(/^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) { missing.push(id + '(无 frontmatter)'); continue; }
  const nameLine = m[1].split(/\r?\n/).find(l => /^name:\s*/.test(l)) || '';
  const nameVal = nameLine.replace(/^name:\s*/, '').trim();
  const descLine = m[1].split(/\r?\n/).find(l => /^description:\s*/.test(l)) || '';
  if (!CJK.test(nameVal)) { missing.push(id + '(name 非中文:"' + nameVal + '")'); continue; }
  if (!descLine) { missing.push(id + '(缺 description)'); continue; }
}
ok(missing.length === 0, 'B3 全部内置 SKILL.md 均有中文 name + description frontmatter' +
  (missing.length ? '(缺:' + missing.join('、') + ')' : ''));

if (fail === 0) console.log('\nUI V3 WAVE1 STATIC E2E: ALL PASS');
else { console.log(`\nUI V3 WAVE1 STATIC E2E: ${fail} FAIL`); process.exitCode = 1; }
