#!/usr/bin/env node
'use strict';

// 第76波静态契约：Preview 壳与经典 app-shell 同级、默认关闭、只读同一投影、五态单一来源、
// 本机持久切换、零 innerHTML、新资源进入离线 overlay，且用户界面不提前出现 Pretender/3.0 品牌。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');
const html = read('index.html');
const app = read('app.js');
const shell = read('js/preview-shell.js');
const css = read('css/views/preview-shell.css');
const zh = JSON.parse(read('locales/zh-CN.json'));
const en = JSON.parse(read('locales/en-US.json'));
const overlay = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'tools', 'build-overlay.js'), 'utf8');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const appShellStart = html.indexOf('<div class="app-shell">');
const appShellEndMarker = html.indexOf('id="rightResizeHandle"', appShellStart);
const previewStart = html.indexOf('<section id="previewShell"');
ok(appShellStart >= 0 && appShellEndMarker > appShellStart && previewStart > appShellEndMarker,
  'A1 Preview 是经典 app-shell 的同级后置容器，经典骨架未被包入新壳');
ok(/localStorage\.getItem\('wcw\.shellMode'\) === 'preview' \? 'preview' : 'classic'/.test(html)
  && /data-shell-mode', 'classic'/.test(html),
  'A2 预绘偏好严格归一化且默认 classic');
ok(/:root\[data-shell-mode="preview"\] body > \.app-shell \{ display: none !important; \}/.test(css)
  && /body > \.preview-shell[\s\S]{0,180}display: grid/.test(css),
  'A3 CSS 仅在 preview 模式切同级容器');
ok(/grid-template-columns: 72px minmax\(0, 1fr\)/.test(css), 'A4 任务坞物理宽度锁定 72px');

for (const id of [
  'previewShell', 'previewWorkspaceFact', 'previewSafetyFact', 'previewEngineFact', 'previewNeedsFact',
  'previewMissionDock', 'previewMain', 'previewRefreshBtn', 'previewSettingsBtn', 'previewClassicBtn', 'cfgShellMode',
]) ok(new RegExp(`id="${id}"`).test(html), `B ${id} DOM 锚点存在`);
ok(/aria-live="polite"/.test(html) && /role="list"/.test(html) && /tabindex="-1"/.test(html),
  'B1 状态播报、任务列表与主视图焦点锚齐备');

ok(app.includes("from './js/preview-shell.js'") && app.includes('createPreviewShellDomain({')
  && app.includes('bindPreviewShell();'), 'C1 app.js 只做 Preview 领域组合与绑定');
ok(shell.includes("import './mission-state.js'") && shell.includes('missionState.fromCard(card)')
  && !/function\s+deriveMissionState\s*\(/.test(shell), 'C2 五态复用 mission-state.js，未复制状态机');
ok(shell.includes("api('/api/missions?limit=200')") && shell.includes("api('/api/interventions?limit=100')")
  && shell.includes('api(`/api/missions/${sessionId}`)') && shell.includes('api(`/api/sessions/${sessionId}`)')
  && !/api\([^\n]*(?:agent-runs|usage\/summary)/.test(shell), 'C3 壳层只读 Mission/Session/Intervention 聚合 API，不拼装 Agent/usage 散装端点');
ok((shell.match(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)/g) || []).length === 1
  && shell.includes('/interventions/${encodeURIComponent(id)}/decision'),
  'C4 Preview 壳唯一写 API 为统一 Intervention 决策命令');
ok(shell.includes("export const SHELL_MODE_STORAGE_KEY = 'wcw.shellMode'")
  && shell.includes("localStorage.setItem(SHELL_MODE_STORAGE_KEY, mode)"), 'C5 新/经典切换持久化为本机 UI 偏好');
ok(shell.includes("value === 'preview' ? 'preview' : 'classic'")
  && !/state\.(?:currentSession|sessions)\s*=/.test(shell), 'C6 非法偏好回 classic 且不写经典会话状态');
ok(/value === 'needs_you'\) return 'attention'/.test(shell)
  && /value === 'running' \|\| value === 'dispatching'/.test(shell)
  && /return 'quiet'/.test(shell), 'C7 五态事实折算为 attention/active/quiet 三种瓷章表现');
ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(shell)
  && /replaceChildren\(/.test(shell) && /textContent\s*=/.test(shell), 'C8 动态壳零 innerHTML，使用 DOM/textContent 构建');
ok(/setInterval\([\s\S]{0,180}10000\)/.test(shell) && /if \(!document\.hidden && isPreviewMode\(\)\)/.test(shell),
  'C9 轮询仅在 Preview 可见态运行，经典布局零后台维护税');

const zhKeys = Object.keys(zh).filter(key => key.startsWith('previewShell.')).sort();
const enKeys = Object.keys(en).filter(key => key.startsWith('previewShell.')).sort();
ok(zhKeys.length >= 40 && JSON.stringify(zhKeys) === JSON.stringify(enKeys), `D1 Preview i18n 中英键对称(${zhKeys.length})`);
ok(!/Pretender|3\.0/.test(html)
  && zhKeys.every(key => !/Pretender|3\.0/.test(String(zh[key])))
  && enKeys.every(key => !/Pretender|3\.0/.test(String(en[key]))), 'D2 用户界面与发布文案未提前暴露 Pretender/3.0 品牌');
ok(/prefers-reduced-motion: reduce/.test(read('css/base.css')) && /preview-gold-pulse/.test(css),
  'D3 鎏金动效受全局 reduced-motion 门约束');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'D4 Preview CSS 全部使用主题/语义 token，无硬编码色值');

ok(overlay.includes("'app/public/js/preview-shell.js'")
  && overlay.includes("'app/public/css/views/preview-shell.css'"), 'E1 Preview JS/CSS 进入 overlay 载荷');
ok(read('styles.css').includes('@import url("/css/views/preview-shell.css");')
  && html.includes('<link rel="stylesheet" href="/css/views/preview-shell.css" />'), 'E2 兼容样式清单与直载 CSS 同步');

console.log(`\nPRETENDER SHELL STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
