#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// build.js — 第43波 构建期拼接器(零依赖):app/src/*.js → app/server.js
//
//   node app/build.js          拼接并写产物(tmp+rename 原子写,产物过 node --check 才落盘)
//   node app/build.js --check  只校验「产物 == 拼接(src)」(freshness/幂等),不一致退出 1
//
// 铁律(42a 决策·方案A + 43e 对抗轮加固):
//   ① 声明顺序 = 原单体顺序(manifest.modules 顺序拼接,不重排);
//   ② 产物【不注入】任何 banner/包装 —— 字节级可复现,548 条静态锁无感知;
//   ③ 拆分点只许顶层声明边界(装载时逐模块首行自检;尾部半成品由产物语法门兜底);
//   ④ 运行时永远跑产物 app/server.js,不直接跑 src/(src 共享拼接作用域,非独立可执行);
//   ⑤ 模块必须全 LF(43e 对抗轮:CRLF 混入 → 拼接点裸 \n 与模块内 \r\n 的混合 EOL 产物,
//      模板字面量内换行被静默改写;仓库侧 .gitattributes 已钉 *.js eol=lf,此处是第二道铃)。
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const APP = __dirname;
const SRC = path.join(APP, 'src');
const OUT = path.join(APP, 'server.js');

function build() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.modules) || !manifest.modules.length) throw new Error('manifest.modules 为空');
  const parts = [];
  for (const m of manifest.modules) {
    const file = typeof m === 'string' ? m : m.file;
    const body = fs.readFileSync(path.join(SRC, file), 'utf8');
    // 铁律⑤:CR 拒绝(与 codemod 同款守卫 —— 编辑器改 EOL 时响铃,不静默污染)
    if (body.includes('\r')) throw new Error(`模块含 CR(应为全 LF): ${file} —— 检查编辑器 EOL 设置`);
    const first = body.split('\n', 1)[0];
    // 切点自检(43e 加固:空文件/空首行也拒):模块首行顶格、非续行 —— 错刀/半成品编辑在此拦截
    if (!first || /^\s/.test(first) || /^[)\]};,]/.test(first)) throw new Error(`模块首行不安全: ${file}: ${JSON.stringify(first.slice(0, 50))}`);
    parts.push(body);
  }
  return parts.join('\n');
}

function syntaxGate(text, label) {
  // 产物落盘前过 node --check(经 stdin,不落临时文件):模块尾部半成品(缺闭合)在此拦截,
  // 失败不覆盖旧产物(43e 对抗轮:首行自检只守头不守尾)。
  const r = cp.spawnSync(process.execPath, ['--check', '-'], { input: text, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`产物语法校验失败(${label}):\n${r.stderr || r.stdout}`);
}

const out = build();
// `--check` is also the release-packaging gate, so a byte-fresh but syntactically
// broken artifact must fail here instead of being accepted by source-runner builds.
syntaxGate(out, 'concat(src)');
const check = process.argv.includes('--check');
if (check) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur === out) { console.log('build --check: 产物与 src 一致(新鲜)'); process.exit(0); }
  console.error('build --check: 产物落后于 src(或手改了产物)— 跑 node app/build.js 重建');
  process.exit(1);
}
// 原子写(tmp+rename;tmp 带 PID 防并发 build 互踩)。Windows 上 AV/索引器瞬时锁会 EPERM,
// 短退避重试 3 次(43e 对抗轮实测 rename 覆盖已存在目标 OK,EPERM 来自句柄占用)。
const tmp = OUT + '.build-tmp.' + process.pid;
fs.writeFileSync(tmp, out, 'utf8');
let renamed = false, lastErr = null;
for (let i = 0; i < 3 && !renamed; i++) {
  try { fs.renameSync(tmp, OUT); renamed = true; }
  catch (e) { lastErr = e; if (e.code !== 'EPERM' && e.code !== 'EBUSY') break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); }
}
if (!renamed) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw new Error(`产物落盘失败(rename ${lastErr && lastErr.code}): ${lastErr && lastErr.message} —— 可能有程序锁住了 server.js(编辑器/杀软),重试或关闭后重跑`); }
console.log(`build: ${out.split('\n').length} 行 → ${path.relative(process.cwd(), OUT)}`);
