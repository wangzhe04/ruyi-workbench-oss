// dev-harness/read-frontend-src.js — 前端源码聚合读取小工具（零依赖、CommonJS）。
//
// 背景（v1.3-FE1 前端渐进模块化 Phase 1）:app.js 正从 4400+ 行单文件渐进拆成
// `public/app.js` + `public/js/*.js` 原生 ES Modules。此前多个 source-grep 类 e2e
// （theme / onboard / ia / perf / git 等)把「读单个 app.js 做正则断言」写死。拆分后
// 被搬走的函数/常量若仍在别的 .js 文件里,单读 app.js 会误判「函数消失」。
//
// 本模块提供 readFrontendSrc():把 public/app.js 与 public/js/ 下全部 .js 聚合成一个
// 字符串,各 e2e 只需把「读 app.js」改为「readFrontendSrc()」,以后再拆(Phase 2+)也
// 无需逐个改 e2e —— 聚合口径统一在此。
//
// 契约:纯静态文件聚合,不执行任何前端代码;仅供源文本正则断言使用。
'use strict';

const fs = require('fs');
const path = require('path');

// 前端 public 目录:dev-harness 的兄弟目录 ruyi-workbench/app/public。
const PUB = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'public');
const JS_DIR = path.join(PUB, 'js');

// 递归列出 dir 下全部 .js 文件的绝对路径(文件名升序,聚合顺序稳定可复现)。
// 目录不存在(Phase 1 之前 / js/ 尚未建)时返回空数组 —— 调用方仍能只拿到 app.js。
function listJsFiles(dir) {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; } // 目录不存在
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out = out.concat(listJsFiles(full));
    else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// 返回聚合后的前端源码字符串:public/app.js 在前,随后是 public/js/**/*.js(文件名序)。
// 各文件之间以带路径注释的分隔行拼接,便于断言失败时人工定位来源文件。
function readFrontendSrc() {
  const parts = [];
  const files = [path.join(PUB, 'app.js'), ...listJsFiles(JS_DIR)];
  for (const f of files) {
    let src = '';
    try { src = fs.readFileSync(f, 'utf8'); }
    catch { continue; } // 缺文件(如 app.js 不存在)不致命,跳过
    const rel = path.relative(PUB, f).replace(/\\/g, '/');
    parts.push(`/* ==== dev-harness aggregate: ${rel} ==== */\n${src}`);
  }
  return parts.join('\n');
}

// 返回参与聚合的文件绝对路径清单(供契约 e2e 报告/自检用)。
function frontendSrcFiles() {
  return [path.join(PUB, 'app.js'), ...listJsFiles(JS_DIR)].filter(f => {
    try { fs.accessSync(f); return true; } catch { return false; }
  });
}

module.exports = { readFrontendSrc, frontendSrcFiles, PUB, JS_DIR };
