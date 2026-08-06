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
const workspacePreferences = read('js/workspace-preferences.js');
const providerSettings = read('js/provider-settings.js');
const navigationControls = read('js/navigation-controls.js');
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
  'previewMissionDock', 'previewMain', 'previewRefreshBtn', 'previewSettingsBtn', 'previewClassicBtn', 'previewNewMissionBtn', 'openPreviewBtn', 'cfgShellMode',
]) ok(new RegExp(`id="${id}"`).test(html), `B ${id} DOM 锚点存在`);
ok(/aria-live="polite"/.test(html) && /role="list"/.test(html) && /tabindex="-1"/.test(html),
  'B1 状态播报、任务列表与主视图焦点锚齐备');

ok(app.includes("from './js/preview-shell.js'") && app.includes('createPreviewShellDomain({')
  && app.includes('bindPreviewShell();'), 'C1 app.js 只做 Preview 领域组合与绑定');
ok(shell.includes("import './mission-state.js'") && shell.includes('missionState.fromCard(card)')
  && !/function\s+deriveMissionState\s*\(/.test(shell), 'C2 五态复用 mission-state.js，未复制状态机');
ok(shell.includes("api('/api/missions?limit=200')") && shell.includes("api('/api/interventions?limit=100')")
  && shell.includes('api(`/api/missions/${sessionId}`)') && shell.includes('api(`/api/sessions/${sessionId}`)')
  && !/api\([^\n]*usage\/summary/.test(shell)
  && shell.includes('api(`/api/agent-runs/${encodeURIComponent(run.id)}`'),
  'C3 读模型仍走 Mission/Session/Intervention 聚合；Run 只经既有单 Run 控制端点');
ok(shell.includes('/interventions/${encodeURIComponent(id)}/decision')
  && shell.includes('/api/missions/${encodeURIComponent(sessionId)}/control')
  && shell.includes("api('/api/checkpoints/rollback'")
  && shell.includes('api(`/api/agent-runs/${encodeURIComponent(run.id)}`')
  && !shell.includes("api('/api/mission'"),
  'C4 Preview 写动作只走统一 Intervention、Mission 控制、checkpoint 与 Run 权威命令');
ok(shell.includes("export const SHELL_MODE_STORAGE_KEY = 'wcw.shellMode'")
  && shell.includes("localStorage.setItem(SHELL_MODE_STORAGE_KEY, mode)"), 'C5 新/经典切换持久化为本机 UI 偏好');
ok(shell.includes("value === 'preview' ? 'preview' : 'classic'")
  && !/state\.(?:currentSession|sessions)\s*=/.test(shell), 'C6 非法偏好回 classic 且不写经典会话状态');
ok(/value === 'needs_you'\) return 'attention'/.test(shell)
  && /value === 'running' \|\| value === 'dispatching'/.test(shell)
  && /return 'quiet'/.test(shell), 'C7 五态事实折算为 attention/active/quiet 三种瓷章表现');
ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(shell)
  && /replaceChildren\(/.test(shell) && /textContent\s*=/.test(shell), 'C8 动态壳零 innerHTML，使用 DOM/textContent 构建');
// 性能波：交办台全量轮询从 10s 降频到 30s（多历史任务时每轮数百 KB 载荷 + 首页/码头全量重建，
// 10s 是进入卡顿的主放大器）；C9 其余契约（默认零后台税、显式通知才保留待决轮询）不变。
ok(/setInterval\([\s\S]{0,320}30000\)/.test(shell)
  && /isPreviewMode\(\) && \(!document\.hidden \|\| notificationSettings\.enabled\)/.test(shell)
  && /else if \(notificationSettings\.enabled\) void refreshNotificationInbox\(\)/.test(shell)
  && /if \(isPreviewMode\(\) \|\| notificationSettings\.enabled\) startPolling\(\)/.test(shell),
  'C9 默认关闭时经典布局零后台税；显式开启通知后才保留轻量待决轮询');

ok(shell.includes('workspace.onclick = () => openWorkspaceControl(workspace)')
  && shell.includes('safety.onclick = () => openSafetyControl(safety)')
  && shell.includes('engine.onclick = () => openEngineControl(engine)')
  && shell.includes("settings.onclick = () => openSettings('basic')")
  && !/workspace\) workspace\.onclick = \(\) => openSettings/.test(shell)
  && !/safety\) safety\.onclick = \(\) => openSettings/.test(shell)
  && !/engine\) engine\.onclick = \(\) => openSettings/.test(shell),
  'C10 Preview facts route to workspace, safety, and engine controls; only Settings opens Settings');
ok(app.includes('openWorkspaceControl: anchor => pickWorkspace(anchor)')
  && app.includes('openSafetyControl: anchor => openPermPopover(anchor)')
  && app.includes('openEngineControl: anchor => openModelChipPopover(anchor)')
  && /function pickWorkspace\(anchor\)[\s\S]{0,360}anchor\.nodeType === 1/.test(workspacePreferences)
  && /function openPermPopover\(anchor\)[\s\S]{0,360}anchor\.nodeType === 1/.test(providerSettings)
  && /function openModelChipPopover\(anchor\)[\s\S]{0,360}anchor\.nodeType === 1/.test(navigationControls),
  'C11 shared popovers anchor to the visible Preview control without duplicating authority');

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

// ─── 第86波：现场速报 / 原始镜头新鲜度 / 成果列名 / 配色统一 契约锁 ──────────────
const schemes = read('css/themes/color-schemes.css');
ok(shell.includes('function activityBrief(snapshot, derived)')
  && /pendingTotal\(snapshot && snapshot\.pending\)/.test(shell)
  && /nodes\.find\(node => node\.status === 'running'\)/.test(shell)
  && /snapshot\.controls && snapshot\.controls\.activeTurn/.test(shell)
  && /derived\.state === 'dispatching'/.test(shell),
  'W86-1 现场速报只从权威快照派生(待决>班组当前工序>活回合>五态兜底),不读 assistant 文本');
ok(/activity\.dataset\.state = derived\.state/.test(shell)
  && /setSlot\(article, 'activity', activityBrief\(snapshot, derived\)\)/.test(shell)
  && zh['previewShell.activity.needsYou'] && en['previewShell.activity.needsYou']
  && zh['previewShell.activity.quiet'] && en['previewShell.activity.quiet'],
  'W86-2 现场速报 data-state 跟随五态、文案经 activityBrief 写入、i18n 中英齐备');
ok(/let rawDirty = false/.test(shell)
  && /\(rawDirty && selectedLens === 'raw'\)/.test(shell)
  && /sessionResponse\.session; rawDirty = false/.test(shell)
  && /rawDirty = true;/.test(shell),
  'W86-3 原始镜头 rawDirty 脏标记:回合中流事件置脏、刷新重取会话后清脏、needsSession 据此连会话重取');
ok(/tab\.id === 'raw'[\s\S]{0,240}scheduleDetailRefresh\(true\)/.test(shell),
  'W86-4 切入原始镜头强制连会话重取一次,回合中途从别的镜头切过来也看最新现场');
ok(/Array\.isArray\(changes\.artifacts\)[\s\S]{0,400}basename\(item\.path\)/.test(shell)
  && /preview-intake-artifacts/.test(css)
  && /\.slice\(0, 4\)/.test(shell)
  && /row\.title = String\(item\.path\)/.test(shell),
  'W86-5 成果面板直接列产物文件名(前4,悬停看全路径),不再只给抽象计数');
ok(!/--preview-accent: #63cbbd/.test(schemes) && !/--preview-hot: #ef8d72/.test(schemes)
  && !/--preview-accent: #217397/.test(schemes) && !/--preview-hot: #b24736/.test(schemes)
  && /--preview-accent: #6b8ff2/.test(schemes) && /--preview-hot: #dcba75/.test(schemes)
  && /--preview-accent: #2050c8/.test(schemes) && /--preview-hot: #82631b/.test(schemes),
  'W86-6 preview 配色统一为青花蓝+鎏金,旧青绿(#63cbbd/#217397)与橙红(#ef8d72/#b24736)外挂色退役');

console.log(`\nPRETENDER SHELL STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
