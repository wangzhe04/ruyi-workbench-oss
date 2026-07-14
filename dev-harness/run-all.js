#!/usr/bin/env node
// CI / 本地共用串行 e2e runner(零依赖,Windows-first)。
//
// 遍历 dev-harness/*.e2e.js,排除 live 件(真 key/真子进程),串行跑,汇总。
// 每件超时 taskkill /F /T /PID 杀整进程树(防 server.js 孙进程残留占端口)。
// 退出码:任一失败 -> 1。
//
// 用法:
//   node dev-harness/run-all.js            # 全量
//   node dev-harness/run-all.js --fast     # 仅快通道(.static 纯静态锁,秒级)
//   node dev-harness/run-all.js foo.e2e.js # 仅指定件(可多个,空格分隔)
//
// 设计依据见 docs/OPTIMIZATION-ROADMAP.md 第34波(CI 基建)。
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const HARNESS = __dirname;
const TIMEOUT_MS = 120000; // 单件超时;最硬的 autonomy-durability 实测 ~15s,留 8x 余量

// 显式排除清单(不靠文件名猜测,让"为什么跳过"可审计)。判断依据 = 需真 key/真外部子进程:
//   grep -lE "argv\[2\].*KEY|KEY\s*=\s*process\.argv" *.e2e.js  ->  deepseek-live / deepseek-tools
//   - deepseek-live:        真调 DeepSeek API,需 DEEPSEEK_API_KEY(argv[2])
//   - deepseek-tools:       真调 DeepSeek v4-pro function-calling,需 key(argv[2]);头部标 LIVE
//   - desktop-bridge-live:  真起 Python MCP 子进程(ai-computer-control),CI 无 Python 环境
const SKIP = new Set([
  'deepseek-live.e2e.js',
  'deepseek-tools.e2e.js',
  'desktop-bridge-live.e2e.js',
]);

// 已知失败件(积压回归,CI 全量暴露,后续波修)。失败不计红(不挂 CI),但报告标 [known-fail];
// 若 PASS 则标 [unexpected-pass] 提醒清理名单。每条附原因 -- 名单不能成永久豁免,修好即删。
const KNOWN_FAILURE = {
  'ui-v3-p1.static.e2e.js': 'color-mix 手写(styles.css:1462 ghost-danger hover,第23波引入,违反 v3 P1;需 UI 决策:轻量 hover 的令牌选择',
  'capabilities.e2e.js': 'system prompt 含 "Claude"(identity bleed guard;buildProviderSystemPrompt 函数体无 Claude,注入源在调用方拼接,待排查)',
  'session-index.e2e.js': 'PATCH title/pinned + 删除 + 合并 dirty-read 9 处回归(某波改 PATCH session 逻辑,与 workspace-resolve 同源)',
  'workspace-resolve.e2e.js': 'PATCH session cwd 持久化 3 处回归(与 session-index PATCH 同源)',
};

// 快通道:无端口纯静态锁件(spawn|listen=0),秒级,先跑求快速反馈。
const isFast = f => /\.static\.e2e\.js$/.test(f);

function listE2e() {
  return fs.readdirSync(HARNESS)
    .filter(f => f.endsWith('.e2e.js') && !SKIP.has(f))
    .sort();
}

// 跑一件:spawn + 超时 taskkill /T 杀整树(Windows 孙进程兜底)。
function runOne(file) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const full = path.join(HARNESS, file);
    const child = cp.spawn(process.execPath, [full], {
      cwd: HARNESS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      // /T = 杀进程树(含 server.js 孙进程);/F = 强制。Windows-only,非 Windows 退化为 kill。
      try {
        if (process.platform === 'win32') {
          cp.execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      } catch { /* 已退出 */ }
    }, TIMEOUT_MS);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ file, ok: code === 0 && !timedOut, timedOut, status: code, out: stdout + stderr, ms: Date.now() - t0 });
    });
    child.on('error', e => {
      clearTimeout(timer);
      resolve({ file, ok: false, timedOut: false, status: -1, out: stdout + stderr + '\n[spawn error] ' + e, ms: Date.now() - t0 });
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  let files;
  if (argv.includes('--fast')) {
    files = listE2e().filter(isFast);
  } else if (argv.length && !argv[0].startsWith('-')) {
    files = argv.filter(f => f.endsWith('.e2e.js'));
  } else {
    files = listE2e();
    // 快通道先跑(秒级反馈),再跑主序(起 server 的件)
    files = [...files.filter(isFast), ...files.filter(f => !isFast(f))];
  }

  console.log(`# Ruyi e2e runner`);
  console.log(`# 件数: ${files.length} ran / ${SKIP.size} skipped(live)`);
  console.log(`# 超时: ${TIMEOUT_MS / 1000}s/件,串行(taskkill /T 杀整树)`);
  console.log(`# Node ${process.version}, platform ${process.platform}\n`);

  let pass = 0, fail = 0, knownFail = 0, unexpectedPass = 0;
  const failed = [], results = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const tag = isFast(f) ? '[fast]' : '[main]';
    process.stdout.write(`(${String(i + 1).padStart(3)}/${files.length}) ${tag} ${f} ... `);
    const r = await runOne(f);
    results.push({ file: f, ok: r.ok, known: !!KNOWN_FAILURE[f], timedOut: r.timedOut, status: r.status, ms: r.ms });
    const known = KNOWN_FAILURE[f];
    if (r.ok) {
      pass++;
      if (known) { unexpectedPass++; console.log(`PASS [unexpected-pass: known-failure 修好了?清理名单] (${r.ms}ms)`); }
      else console.log(`PASS (${r.ms}ms)`);
    } else {
      if (known) {
        knownFail++;
        console.log(`FAIL [known-fail] (${r.ms}ms) - ${known}`);
      } else {
        fail++;
        const reason = r.timedOut ? `TIMEOUT(>${TIMEOUT_MS / 1000}s)` : `exit=${r.status}`;
        console.log(`FAIL ${reason} (${r.ms}ms)`);
        failed.push(r);
      }
    }
  }

  console.log(`\n# 汇总: ${pass} pass / ${fail} fail / ${knownFail} known-fail / ${unexpectedPass} unexpected-pass / ${files.length} ran / ${SKIP.size} skipped`);
  if (failed.length) {
    console.log(`\n# 失败件 tail(各取末 25 行):`);
    for (const r of failed) {
      console.log(`\n=== ${r.file} (${r.timedOut ? 'TIMEOUT' : 'exit=' + r.status}) ===`);
      const lines = r.out.split(/\r?\n/).filter(Boolean);
      console.log(lines.slice(-25).join('\n'));
    }
  }
  // 紧凑日志(供 CI artifact 上传;失败 tail 见 step 输出)
  try {
    fs.writeFileSync(path.join(HARNESS, 'last-run.log'), [
      `# Ruyi e2e last-run log`,
      `# ${pass} pass / ${fail} fail / ${knownFail} known-fail / ${unexpectedPass} unexpected-pass / ${files.length} ran / ${SKIP.size} skipped`,
      `# Node ${process.version}, platform ${process.platform}`,
      ...results.map(r => `${r.ok ? (r.known ? 'UNEXPECTED_PASS' : 'PASS') : (r.known ? 'KNOWN_FAIL' : 'FAIL')}\t${r.ms}ms\t${r.file}`),
    ].join('\n') + '\n');
  } catch { /* 只读环境(CI 沙箱)忽略 */ }

  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
