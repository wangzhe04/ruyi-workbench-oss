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
  ...srcModules,
  'app/public/index.html',
  'app/public/app.js',
  // v1.3-FE1 前端模块化的全部 5 个模块 —— 43e 对抗轮擒获存量 bug:只发 icons.js 会让 base 安装
  // 的 state/util/net/i18n 停在旧版(overlay 只覆写不删除),app.js 顶部 import 全 5 个 → 版本偏斜,
  // 第42波 fmtBytes 收编后旧 util.js 缺导出 = ES module 实例化失败白屏。全量列出。
  'app/public/js/state.js',
  'app/public/js/util.js',
  'app/public/js/net.js',
  'app/public/js/i18n.js',
  'app/public/js/icons.js',
  'app/public/locales/zh-CN.json',
  'app/public/locales/en-US.json',
  'app/public/styles.css',
  'app/public/vendor/marked.min.js',
  'app/public/vendor/highlight.min.js',
  'app/public/vendor/github-dark.min.css',
  'app/public/vendor/github.min.css',
  'Start-Workbench.cmd',
  'resources/scripts/install-workbench.ps1',
  'tools/fake-claude.js',
  'tools/dev-serve.cmd',
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
for (const rel of OVERLAY_FILES) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) { console.error(`MISSING overlay file: ${rel}`); process.exit(1); }
  copy(src, path.join(outRoot, path.basename(rel)));
}

// Generate the manifest over the payload.
cp.execFileSync(process.execPath, [path.join(root, 'tools', 'gen-manifest.js'), payload, version, `overlay-${version}`, pkgVersion], { stdio: 'inherit' });

console.log(`Overlay assembled at ${outRoot}`);
console.log(`Payload files: ${PAYLOAD_FILES.length}`);
