#!/usr/bin/env node
// 第36波(v1.7): node --check 语法门(零依赖)。CI 在 e2e 套件之前先跑本门 —— 语法错误秒级 fail,
// 不必等全量串行套件跑完才发现。覆盖产品/测试/工具全部一手 JS(不含 node_modules/dist/第三方 vendor)。
//
// 需要 Node >= 22(–check 自动探测 ESM;app/public 是 ES Module,Node 20 的 –check 按 CJS 解析会误报)。
// 与 CI 的 node-version 轴对齐(见 .github/workflows/e2e.yml)。
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_MODULE_ROOT = path.join(ROOT, 'ruyi-workbench', 'app', 'public') + path.sep;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.venv', '__pycache__', 'python_embed', 'playwright_browsers']);

// vendor/ 是第三方资产(marked/highlight),非一手代码,不在本门范围(它坏了有 e2e 兜底,语义无从断言)。
const SCOPES = [
  { dir: 'ruyi-workbench/app', depth: 1 },          // server.js
  { dir: 'ruyi-workbench/app/public', depth: 2 },   // app.js + js/*.js(跳过 vendor/)
  { dir: 'ruyi-workbench/tools', depth: 1 },        // build-overlay / gen-manifest / fake-claude
  { dir: 'dev-harness', depth: 1 },                 // run-all + fakes + 全部 *.e2e.js
];

function collect() {
  const out = [];
  const walk = (dir, depth) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth > 0 && !SKIP_DIRS.has(ent.name) && ent.name !== 'vendor') walk(full, depth - 1);
        continue;
      }
      if (ent.name.endsWith('.js')) out.push(full);
    }
  };
  for (const s of SCOPES) walk(path.join(ROOT, s.dir), s.depth);
  return out.sort();
}

const files = collect();
let bad = 0;
for (const f of files) {
  // `node --check file.js` can miss ES Module early errors when the nearest
  // package.json does not declare `type: module` (for example, an imported
  // binding redeclared in app.js). Parse browser modules explicitly via stdin.
  const isFrontendModule = f.startsWith(FRONTEND_MODULE_ROOT);
  const r = cp.spawnSync(
    process.execPath,
    isFrontendModule ? ['--check', '--input-type=module'] : ['--check', f],
    {
      encoding: 'utf8',
      windowsHide: true,
      input: isFrontendModule ? fs.readFileSync(f) : undefined,
    },
  );
  if (r.status !== 0) {
    bad++;
    console.error(`SYNTAX FAIL: ${path.relative(ROOT, f)}`);
    console.error(String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(0, 6).join('\n'));
  }
}
console.log(`# syntax-gate: ${files.length} files checked, ${bad} failed (node ${process.version})`);
process.exit(bad ? 1 : 0);
