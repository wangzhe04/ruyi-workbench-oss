#!/usr/bin/env node
'use strict';

// 第78波静态契约：交办台首页、确认卡、共享启动 command、速问逃生舱，以及本次执行链安全档。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const read = file => fs.readFileSync(file, 'utf8');
const shell = read(path.join(PUBLIC, 'js', 'preview-shell.js'));
const app = read(path.join(PUBLIC, 'app.js'));
const stream = read(path.join(PUBLIC, 'js', 'chat-stream-runtime.js'));
const session = read(path.join(PUBLIC, 'js', 'session-experience.js'));
const context = read(path.join(SRC, '10-context-governance.js'));
const claude = read(path.join(SRC, '05-claude-engine.js'));
const html = read(path.join(PUBLIC, 'index.html'));
const css = read(path.join(PUBLIC, 'css', 'views', 'preview-shell.css'));
const zh = JSON.parse(read(path.join(PUBLIC, 'locales', 'zh-CN.json')));
const en = JSON.parse(read(path.join(PUBLIC, 'locales', 'en-US.json')));

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

ok(html.includes('id="previewHomeBtn"') && shell.includes("let activeView = 'home'"), 'A1 任务坞有交办台入口且 Preview 首视图为首页');
for (const [name, style] of [['preview-dispatch-home', 'preview-dispatch-home'], ['preview-dispatch-box', 'preview-dispatch-box'],
  ['preview-continue-section', 'preview-continue-rail'], ['preview-playbook-section', 'preview-playbook-shelf'], ['preview-recent-section', 'preview-recent-grid']]) {
  ok(shell.includes(name) && css.includes('.' + style), `A2 ${name} 结构/样式双锚`);
}
ok(shell.includes("main.dataset.view = 'home'") && shell.includes("if (activeView === 'home') { renderHome(); return; }"), 'A3 首页与任务单保持单主视图互斥');
ok(shell.includes('openMissionCard(card)') && shell.includes("activeView = 'mission'"), 'A4 续办/最近收活/瓷章统一打开任务单');
ok(shell.includes("['dispatching', 'running', 'needs_you']") && shell.includes("['done', 'stopped']"), 'A5 续办条与最近收活严格按五态派生分组');
ok(shell.includes("missionState.fromCard(card)"), 'A6 首页任务状态继续复用唯一 mission-state 派生层');

ok(shell.includes("text('section', 'preview-dispatch-confirm'") && shell.includes("card.dataset.estimateVisible = 'false'"), 'B1 确认卡存在且无依据时不伪造估计');
for (const fact of ['confirmPurpose', 'confirmWorkspace', 'confirmSafety', 'confirmNoEstimate']) {
  ok(shell.includes(`previewShell.${fact}`), `B2 确认卡字段 ${fact} 在`);
}
ok(shell.includes("select.id = 'previewDispatchSafety'") && shell.includes('dispatchPermissionModes()'), 'B3 确认卡可选择本次执行链安全档');
ok(shell.includes("/^[?？]/.test(prompt)") && shell.includes("submitDispatch('quick_ask'"), 'B4 ?/？ 前缀与速问按钮共用逃生舱');
ok(shell.includes("if (kind === 'quick_ask')") && shell.includes("applyShellMode('classic')") && shell.includes('await openSession(result.sessionId)'), 'B5 速问直接回经典对话呈现结果，不硬套任务单');

ok(app.includes('async function startPreviewDispatchCommand(') && app.includes('dispatchCommand: request => startPreviewDispatchCommand(request)'), 'C1 两种交办入口只调用组合根单一 command');
ok(app.includes("const session = await newSession({ cwd: cwd || currentWorkspace(), focus: false })"), 'C2 command 复用既有 Session 创建链');
ok(app.includes("api('/api/mission'") && app.includes("action: 'start'") && app.includes("autoMode: 'until-done'"), 'C3 开工经权威 Mission start 立单并进入可离场驱动');
ok(app.includes("milestones: [{ id: 'delivery', desc: message, status: 'pending' }]"), 'C3 首单自带待验收里程碑，首回合即可注入任务账本');
ok(app.includes("if (kind === 'mission')") && app.includes("const completion = sendPrompt(message, { permissionMode })"), 'C4 Mission 才立单，Mission/速问均复用同一 chat stream');
ok(!/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)/.test(shell), 'C5 Preview 领域不直接写 API，写权限止于注入 command');
ok(session.includes('async function newSession(options = {})') && session.includes('return res.session;'), 'C6 经典 newSession 只扩为可组合返回值，默认调用保持兼容');

ok(stream.includes("...(options.permissionMode ? { permissionMode: options.permissionMode } : {})"), 'D1 chat request 显式携带可选 turn-local 安全档');
ok(context.includes('PERMISSION_MODES.includes(requestedPermissionMode)')
  && context.includes('{ ...storedConfig, permissionMode: requestedPermissionMode }'), 'D2 后端按唯一枚举校验并只创建局部配置副本');
ok(context.includes('runOpenAiTurn({ session') && context.includes('provider, config, driverAuto')
  && context.includes('runClaudeTurn({ session') && context.includes('onEvent: emit, config, driverAuto'), 'D3 Provider/Claude 首回合消费同一局部安全档');
ok(context.includes('runMissionDriver({ session, config, provider') && claude.includes('config: turnConfig')
  && claude.includes('const config = turnConfig || await readConfig()'), 'D4 until-done 与 Claude 恢复链保持同一安全档');
ok(claude.includes('onEvent: downstreamEvent, config, driverAuto'), 'D5 Claude transcript 恢复重试不丢安全档');
ok(!context.includes('writeConfig') && !context.includes('saveConfig'), 'D6 turn-local 安全档不回写全局配置');

ok(shell.includes("api('/api/playbooks')") && shell.includes('playbookName(pb)') && shell.includes('pb.promptTemplate'), 'E1 熟活架复用既有 Playbook 只读目录并填回交办箱');
ok(shell.includes('buildFirstRunGuide()') && shell.includes('pickWorkspace()') && shell.includes("openSettings('providers')"), 'E2 首跑态原位覆盖工作圈与引擎准备');
ok(shell.includes('firstRunSafety') && shell.includes('permissionLabel()'), 'E3 首跑态原位展示默认安全档');
ok(shell.includes("playbooksLoaded ? Promise.resolve(null)") && shell.includes("api('/api/playbooks').catch(() => null)"), 'E4 10秒任务轮询不重复拉熟活目录且目录失败不拖垮任务台');

ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(shell), 'F1 Wave 78 动态首页继续零 HTML 字符串注入');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'F2 Wave 78 CSS 继续全部使用主题/语义 token');
ok(css.includes('@media (max-width: 920px)') && css.includes('.preview-first-run-steps { grid-template-columns: minmax(0, 1fr); }')
  && css.includes('@media (max-width: 620px)'), 'F3 首跑/确认/首页卡片有平板与窄屏收敛');
const zhKeys = Object.keys(zh).filter(key => key.startsWith('previewShell.')).sort();
const enKeys = Object.keys(en).filter(key => key.startsWith('previewShell.')).sort();
ok(zhKeys.length >= 115 && JSON.stringify(zhKeys) === JSON.stringify(enKeys), `F4 Wave 78 中英键完全对称(${zhKeys.length})`);
ok(!/Pretender|3\.0/.test(zhKeys.map(key => zh[key]).join(' ')) && !/Pretender|3\.0/.test(enKeys.map(key => en[key]).join(' ')), 'F5 Preview UI 继续冻结内部代号与版本号');

console.log(`\nPRETENDER DISPATCH HOME STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
