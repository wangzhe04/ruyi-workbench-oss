#!/usr/bin/env node
'use strict';
/*
 * build-overlay.js [version] — assemble the incremental overlay package under dist/overlay/.
 * Produces dist/overlay/{Manage-Overlay.cmd,Manage-Overlay.ps1,APPLY-OVERLAY.md,payload/...}
 * then you zip dist/overlay -> workbench-overlay-<version>.zip.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const version = process.argv[2] || '0.3.0';
// EC-A: 真实宿主版本(package.json),作为 overlay manifest 的 minHostVersion(apply 前兼容预检用)。
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const outRoot = path.join(root, 'dist', 'overlay');
const payload = path.join(outRoot, 'payload');

// Files that land in the deployed folder (path relative to deployed root == relative to `root`).
// 第43波: src 模块清单改 manifest.json 驱动(单一真相 —— 增删模块不用同步两处;43e 对抗轮裁决)。
// 第43波(freshness): 打包前强制「产物 == 拼接(src)」—— 陈旧产物进发行包是静默事故,此处拦截。
cp.execFileSync(process.execPath, [path.join(root, 'app', 'build.js'), '--check'], { stdio: 'inherit' });
const srcModules = JSON.parse(fs.readFileSync(path.join(root, 'app', 'src', 'manifest.json'), 'utf8')).modules
  .map(m => 'app/src/' + (typeof m === 'string' ? m : m.file));
const PAYLOAD_FILES = [
  'app/server.js',
  // 第43波: 模块化源码 + 拼接器随包发布(运行时只用产物,src 保气隙审计面)
  'app/build.js',
  'app/src/manifest.json',
  // 103b:拼接作用域契约与架构债务上限随源码发布，保持离线审计面完整。
  'app/src/module-contracts.json',
  'app/src/module-dependency-policy.json',
  'app/src/context-governance-rules.json',
  ...srcModules,
  'app/public/index.html',
  'app/public/app.js',
  // 前端模块化的全部领域模块 —— 43e 对抗轮擒获存量 bug:只发 icons.js 会让 base 安装
  // 的 state/util/net/i18n 停在旧版(overlay 只覆写不删除),app.js 顶部 import 模块 → 版本偏斜,
  // 第42波 fmtBytes 收编后旧 util.js 缺导出 = ES module 实例化失败白屏。全量列出。
  'app/public/js/state.js',
  'app/public/js/util.js',
  'app/public/js/net.js',
  'app/public/js/i18n.js',
  'app/public/js/icons.js',
  'app/public/js/turn-narrative.js',
  'app/public/js/chat-scroll.js',
  'app/public/js/chat-render-primitives.js',
  'app/public/js/chat-static-renderer.js',
  'app/public/js/chat-stream-runtime.js',
  // 109a: mermaid 图表运行时(懒加载 vendor/mermaid.min.js;vendor 缺失时原样降级)。
  'app/public/js/mermaid-runtime.js',
  'app/public/js/settings-operations.js',
  'app/public/js/file-browser.js',
  'app/public/js/artifact-changes.js',
  'app/public/js/operations-observability.js',
  'app/public/js/workbench.js',
  'app/public/js/usage-dashboard.js',
  'app/public/js/agent-roles.js',
  'app/public/js/skills-memory.js',
  'app/public/js/provider-settings.js',
  // 134 波:模型目录统一件(agent-roles/navigation-controls/provider-settings/steward-chips/steward-settings
  // 五处静态 import)—— 漏登记即离线包白屏(43e 同款),overlay-payload-lock ③ 当场擒获。
  'app/public/js/model-catalog.js',
  'app/public/js/agent-workflows.js',
  // 32 号文 §4：2.0 顶栏模型弹层与 3.0 管家壳的模型菜单行【共用】的构造件 —— 两壳都在 import，
  // 漏登记即离线包白屏（43e 同款事故）。
  'app/public/js/model-menu.js',
  // 32 号文 §4（M1-b）：浮层原语（open/close/Esc/点外/定位/焦点归还）搬成的叶子模块 ——
  // 两壳都在 import，同样漏登记即白屏。
  'app/public/js/popover.js',
  // 32 号文 §4（M2-b）：暂停／继续的判据与文案键（2.0 的 run 卡 + 3.0 的看板行／抽屉共用）——
  // 两壳都在 import，同样漏登记即白屏。
  'app/public/js/run-state.js',
  // 32 号文 §4（M2-a）：模态原语（2.0 动态模态 + 3.0 危险操作确认共用）搬成的叶子模块。
  'app/public/js/modal.js',
  // 33 号文 §4（M3-a）：3.0 管家壳危险操作确认的统一件与文案键登记表（建在 modal.js 之上；
  // 看板／抽屉／盾牌菜单／设置页四处都在用）。漏登记即离线包白屏。
  'app/public/js/confirm-panel.js',
  'app/public/js/navigation-controls.js',
  'app/public/js/session-experience.js',
  'app/public/js/interaction-prompts.js',
  'app/public/js/prompt-queue.js', // 135:interaction-prompts.js 静态 import 它,漏发即提问/权限弹窗全挂
  'app/public/js/background-tray.js', // 135c:app.js 静态 import 它,漏发即整页白屏
  'app/public/js/tool-runtime.js',
  'app/public/js/workspace-preferences.js',
  // 第56波:任务单五态派生纯函数(Pretender P0;PoC 与将来新壳层共用,须随离线包发布)
  'app/public/js/mission-state.js',
  // 121-K1:一台两视的视角登记表(data-shell-mode 的唯一常规写者)。缺文件会让离线包的 app.js
  // import 整条挂掉 —— 两个视角都起不来。
  'app/public/js/shell-mode.js',
  // 121-K4:应用外框的框架件(顶栏视角分段钮/齿轮菜单、左栏密度与 Ctrl+K、右栏抽屉开合)。
  // 缺文件同 shell-mode.js:app.js 的 import 整条挂掉,两个视角都起不来。
  'app/public/js/app-frame.js',
  // 128f-①:启动故障卡(用户首启走查改造后从 app.js 搬出)。缺文件同 shell-mode.js:app.js 的 import 整条挂掉,
  // 连「启动失败」这张卡本身都画不出来。
  'app/public/js/boot-failure.js',
  // 121-K1:线程/任务的事实折算纯函数(看板、抽屉与新开任务的验收里程碑共用)。
  'app/public/js/thread-facts.js',
  // 121-K1:「需要你」本地提醒的纯策略层 + 设置块绑定(交办台退役后改名搬家)。
  'app/public/js/notify-policy.js',
  // 121-K2b:事件流客户端(GET /api/events/stream 的 fetch+ReadableStream 读法)。缺文件会让离线包的
  // app.js import 整条挂掉 —— 两个视角都起不来(同 shell-mode.js 的理由)。
  'app/public/js/event-stream.js',
  'app/public/js/onboarding-wizard.js', // 118a
  'app/public/js/help-viewer.js', // 118a-fix
  'app/public/js/health-i18n.js', // 118b
  'app/public/js/turn-activity.js', // 112c
  'app/public/js/help-menu.js', // 118d
  // 117a:管家壳(第三种壳模式)的模式与容器骨架;缺文件会让离线包在设置里选中管家后无法准入。
  'app/public/js/steward-shell.js',
  // 117b:管家 avatar 的纯投影 derivePresence()/presenceLabelKey();缺文件会让离线包的管家壳头像永远
  // 停在初始 data-state,状态文字也读不到 i18n 键。
  'app/public/js/steward-presence.js',
  // 117c:管家对话区与递话。缺任一文件都会让 steward-shell.js 的 import 整条挂掉(ESM 静态依赖),
  // 管家壳连骨架都绑不上 —— 离线包必须收全这两件。
  'app/public/js/steward-conversation.js',
  'app/public/js/steward-composer.js',
  // 117d:线程抽屉与三处复用的快切 chip(steward-shell.js 静态 import 它们,缺任一都会整条挂掉)。
  'app/public/js/steward-drawer.js',
  'app/public/js/steward-settings.js',   // 117e
  'app/public/js/steward-chips.js',
  // 117h/121-K5:工作台线程头与左栏(steward-shell.js 静态 import 它们)。
  'app/public/js/thread-head.js',
  'app/public/js/steward-board.js',
  // 121-K6a:安静卡(§4.3,工作台里管家的唯一打扰形态)。steward-shell.js 静态 import 它,
  // 缺文件同 thread-head.js 的理由 —— 整条挂掉。
  'app/public/js/quiet-card.js',
  // 121-K7:左栏栏底的口袋(§2.3 末段)。app.js 静态 import 它,而 steward-drawer.js 与
  // steward-settings.js 又从它拿定时任务的读口 —— 缺文件三条链一起挂,同 quiet-card.js 的理由。
  'app/public/js/rail-pocket.js',
  // 127-⑦:输入框麦克风(两个视角共用)。app.js 与 steward-composer.js 都静态 import 它 —— 缺文件
  // 两个视角的输入区一起挂掉,同 rail-pocket.js 的理由。
  'app/public/js/composer-voice.js',
  'app/public/locales/zh-CN.json',
  'app/public/locales/en-US.json',
  'app/public/css/tokens.css',
  'app/public/css/themes/color-schemes.css',
  'app/public/css/base.css',
  'app/public/css/layout.css',
  'app/public/css/views/chat.css',
  'app/public/css/views/chat-shell.css',
  'app/public/css/components/chat-primitives.css',
  'app/public/css/views/chat-narrative.css',
  'app/public/css/states/chat-live.css',
  'app/public/css/components/chat-composer.css',
  'app/public/css/components/tool-pane.css',
  'app/public/css/themes/ui-modes.css',
  'app/public/css/views/workspace.css',
  'app/public/css/views/usage.css',
  'app/public/css/views/workbench.css',
  'app/public/css/components/onboarding.css', // 118a
  'app/public/css/views/steward-shell.css', // 117a
  'app/public/css/views/steward-avatar.css', // 117b
  'app/public/css/views/steward-conversation.css', // 117c
  'app/public/css/views/steward-drawer.css', // 117d
  'app/public/css/views/steward-settings.css', // 117e
  'app/public/css/views/settings.css', // 123-S1
  'app/public/css/views/steward-board.css', // 117g/117h
  'app/public/css/views/quiet-card.css', // 121-K6a
  'app/public/css/views/prompt-dock.css', // 135
  'app/public/css/views/background-tray.css', // 135c
  'app/public/styles.css',
  'app/public/vendor/marked.min.js',
  'app/public/vendor/highlight.min.js',
  'app/public/vendor/github-dark.min.css',
  'app/public/vendor/github.min.css',
  // 128g(用户 2026-09-19 拍板「覆盖包只打同版本补丁」):通用启动器 Start-Workbench.cmd 【不再】随覆盖包发 ——
  // Full 包的启动器是 package-offline.ps1 另写的(多一步 ACC 的 install.py --ensure),覆盖包套上去会把它盖成通用版,
  // Full 安装从此不再自检 ACC(47 号文 §4.2 第 25 条)。启动器要改就发完整包。
  // The launcher prefers the native shell. Overlay releases must ship both files together so a native
  // hotfix (for example per-monitor DPI recovery) reaches existing offline installations as well.
  'RuyiDesktop.exe',
  'WebView2Loader.dll',
  'resources/scripts/install-workbench.ps1',
  'resources/kimi-acp-compat-register.mjs',
  'resources/kimi-acp-compat-loader.mjs',
  // 107-P0(46 号文 §1.1 ③):内置 playbook 是【运行时】从 resources/playbooks/*.json 逐个读的
  // (06-provider-engine.js builtinPlaybooksDir → readPlaybooksFromDir,整目录 readdir)。修前这里一条都没登记,
  // 127-S01 改了 13 个模板(加 service)并新增 scheduled-digest.json —— 覆盖升级的老用户拿不到。
  // 逐条列、不按目录收:overlay-payload-lock.static ③ 扫这个目录,新模板忘登记当场红;按目录收会让那条判据对
  // 这个目录恒真,目录里混进一个临时文件也会被静默发出去。
  'resources/playbooks/archive-by-content.json',
  'resources/playbooks/batch-rename.json',
  'resources/playbooks/clean-csv.json',
  'resources/playbooks/clean-downloads.json',
  'resources/playbooks/compare-documents.json',
  'resources/playbooks/desktop-open-app.json',
  'resources/playbooks/folder-inventory.json',
  'resources/playbooks/meeting-minutes.json',
  'resources/playbooks/merge-excel.json',
  'resources/playbooks/ocr-scan.json',
  'resources/playbooks/pdf-summarize.json',
  'resources/playbooks/presentation-outline.json',
  'resources/playbooks/scheduled-digest.json',
  'resources/playbooks/translate-document.json',
  'resources/playbooks/web-form-fill.json',
  'resources/playbooks/weekly-report.json',
  // 107-P0 同一次普查(grep 服务端所有 externalRoot()/resources 读口):内置技能与内置斜杠命令也是运行时读的 ——
  // 12-tool-dispatch.js loadSkillRegistry 从 offline-toolkit/skills/<id>/SKILL.md 与 offline-toolkit/commands/*.md
  // 建技能库(/api/skills、提示词里的技能索引)。同一个漏法,一并登记。同插件下的 agents/*.md 与 .claude-plugin/*.json
  // 服务端不读(只有 install-workbench.ps1 把整个 marketplace 交给 Claude CLI 装),不在本表。
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/api-debugger/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/browser-debug/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/claude-md-management/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/code-review-offline/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/code-simplifier/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/commit-workflow/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/devops-ci-local/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/document-workflow/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/feature-development/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/frontend-design-craft/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/local-docs-context/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/lsp-local-setup/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/office-automation/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/offline-packaging/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/plugin-development/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/research-synthesis/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/security-guidance/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/spreadsheet-analysis/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/structured-writing/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/skills/windows-control/SKILL.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/api-probe.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/claude-md-audit.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/commit-message.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/dependency-inventory.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/explain-project.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/fix-tests.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/frontend-audit.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/offline-code-review.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/release-checklist.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/security-check.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/summarize-changes.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/test-changes.md',
  'resources/plugins/win-workbench-offline/offline-toolkit/commands/workbench-doctor.md',
  // 128g:tools/fake-claude.js(测试替身)与 tools/dev-serve.cmd(开发起服)不再随覆盖包发 —— 它们不属于部署面。
];
// 109a: 可选载荷: 存在才随包发布,缺失不是错误。
// mermaid.min.js 是上游 MIT 发布物(约 2.8 MB),由维护者手工放入 app/public/vendor/。
// 前端对它做懒加载并在缺失时降级为普通代码块,所以「没放」是正式支持的形态,
// 不能像 PAYLOAD_FILES 那样缺文件就让打包失败。
// rg.exe 同理(ripgrep 上游 MIT 发布物):11-native-tools.js probeRg 优先探测
// appRoot()/vendor-bin/rg.exe,缺失时 file_search 静默回退 JS 扫描器。
const OPTIONAL_PAYLOAD_FILES = [
  'app/public/vendor/mermaid.min.js',
  'app/vendor-bin/rg.exe',
];
// Files that live at the overlay-package root (the applicator + docs).
const OVERLAY_FILES = ['tools/Manage-Overlay.cmd', 'tools/Manage-Overlay.ps1', 'tools/APPLY-OVERLAY.md'];

function copy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(payload, { recursive: true });

for (const rel of PAYLOAD_FILES) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) { console.error(`MISSING payload file: ${rel}`); process.exit(1); }
  copy(src, path.join(payload, rel));
}
let optionalShipped = 0;
for (const rel of OPTIONAL_PAYLOAD_FILES) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) { console.log(`optional payload absent (feature degrades gracefully): ${rel}`); continue; }
  copy(src, path.join(payload, rel));
  optionalShipped += 1;
}
for (const rel of OVERLAY_FILES) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) { console.error(`MISSING overlay file: ${rel}`); process.exit(1); }
  copy(src, path.join(outRoot, path.basename(rel)));
}

// Generate the manifest over the payload.
cp.execFileSync(process.execPath, [path.join(root, 'tools', 'gen-manifest.js'), payload, version, `overlay-${version}`, pkgVersion], { stdio: 'inherit' });

console.log(`Overlay assembled at ${outRoot}`);
console.log(`Payload files: ${PAYLOAD_FILES.length} (+${optionalShipped} optional)`);
