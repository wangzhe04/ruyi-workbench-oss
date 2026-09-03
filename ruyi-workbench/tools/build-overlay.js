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
  'app/public/js/agent-workflows.js',
  'app/public/js/navigation-controls.js',
  'app/public/js/session-experience.js',
  'app/public/js/interaction-prompts.js',
  'app/public/js/tool-runtime.js',
  'app/public/js/workspace-preferences.js',
  // 第56波:任务单五态派生纯函数(Pretender P0;PoC 与将来新壳层共用,须随离线包发布)
  'app/public/js/mission-state.js',
  // 第83波:现场纪要纯折算 + 本地通知状态策略(均为浏览器/Node 双导出)。
  'app/public/js/preview-narrative.js',
  'app/public/js/preview-notifications.js',
  // 第76波:默认关闭的新任务台 Preview 壳层（与经典 app-shell 同级，读同一 Mission API）。
  'app/public/js/preview-shell.js',
  // 第100波:Preview 壳按 store / 坞与首页 / 任务单 / 镜头 / 收工域拆分，均为运行时依赖。
  'app/public/js/preview-store.js',
  'app/public/js/preview-dock-home.js',
  'app/public/js/preview-task-sheet.js',
  'app/public/js/preview-lenses.js',
  'app/public/js/preview-finish.js',
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
  'app/public/css/views/preview-shell.css',
  'app/public/styles.css',
  'app/public/vendor/marked.min.js',
  'app/public/vendor/highlight.min.js',
  'app/public/vendor/github-dark.min.css',
  'app/public/vendor/github.min.css',
  'Start-Workbench.cmd',
  // The launcher prefers the native shell. Overlay releases must ship both files together so a native
  // hotfix (for example per-monitor DPI recovery) reaches existing offline installations as well.
  'RuyiDesktop.exe',
  'WebView2Loader.dll',
  'resources/scripts/install-workbench.ps1',
  'resources/kimi-acp-compat-register.mjs',
  'resources/kimi-acp-compat-loader.mjs',
  'tools/fake-claude.js',
  'tools/dev-serve.cmd',
];
// 109a: 可选载荷: 存在才随包发布,缺失不是错误。
// mermaid.min.js 是上游 MIT 发布物(约 2.8 MB),由维护者手工放入 app/public/vendor/。
// 前端对它做懒加载并在缺失时降级为普通代码块,所以「没放」是正式支持的形态,
// 不能像 PAYLOAD_FILES 那样缺文件就让打包失败。
const OPTIONAL_PAYLOAD_FILES = [
  'app/public/vendor/mermaid.min.js',
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
