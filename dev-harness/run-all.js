#!/usr/bin/env node
// CI / 本地共用串行/并行 e2e runner(零依赖,Windows-first)。
//
// 遍历 dev-harness/*.e2e.js,排除 live 件(真 key/真子进程),串行或并行跑,汇总。
// 每件超时 taskkill /F /T /PID 杀整进程树(防 server.js 孙进程残留占端口)。
// 退出码:任一失败 -> 1。
// 第46波: 开跑前先过 unit 快通道(node --test dev-harness/unit/*.test.js,挂即拒跑);
// 失败件自动重跑一次,二跑通过记 [flaky](汇总可见),仍失败才算红。
//
// 用法:
//   node dev-harness/run-all.js                  # 全量串行
//   node dev-harness/run-all.js --parallel 4     # 全量并行(4路)
//   node dev-harness/run-all.js --fast           # 仅快通道(.static 纯静态锁,秒级)
//   node dev-harness/run-all.js foo.e2e.js       # 仅指定件(可多个,空格分隔)
//
// 设计依据见 docs/OPTIMIZATION-ROADMAP.md 第34波(CI 基建) + 第38波(V1.8-A 并行化)。
'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const HARNESS = __dirname;
const TIMEOUT_MS = 120000; // 单件超时;最硬的 autonomy-durability 实测 ~15s,留 8x 余量

// 第46波46b: 按件超时表(默认 120s 之外的特例)。只收"实测稳定超过默认 60%"的件,
// 每条附实测依据 —— 表不是兜底借口,能优化掉的慢件应优化而非加薪。
const TIMEOUT_OVERRIDES = {
  // scheduler-ready-queue: 时序敏感(等调度器 tick),慢机器上偶发贴边
  'scheduler-ready-queue.e2e.js': 180000,
};
function timeoutFor(file) { return TIMEOUT_OVERRIDES[file] || TIMEOUT_MS; }

// 显式排除清单(不靠文件名猜测,让"为什么跳过"可审计)。判断依据 = 需真 key/真外部子进程:
//   grep -lE "argv\[2\].*KEY|KEY\s*=\s*process\.argv" *.e2e.js  ->  deepseek-live / deepseek-tools
//   - deepseek-live:        真调 DeepSeek API,需 DEEPSEEK_API_KEY(argv[2])
//   - deepseek-tools:       真调 DeepSeek v4-pro function-calling,需 key(argv[2]);头部标 LIVE
//   - desktop-bridge-live:  真起 Python MCP 子进程(ai-computer-control),CI 无 Python 环境
//   - claude-binary-live:   第42b波 真身 claude.exe 冒烟(解析/直启/stream-json/权限桥;真实 API 小额消耗)
//   - claude-compact-probe-live: 第42c波 print 模式压缩行为探针(真实 API,大额 token;手工决策用)
const SKIP = new Set([
  'deepseek-live.e2e.js',
  'deepseek-tools.e2e.js',
  'desktop-bridge-live.e2e.js',
  // 第42b波: 真身 claude 二进制冒烟(真实 API 调用,需本机已登录 CLI;手工 node 直跑)
  'claude-binary-live.e2e.js',
  // 第42c波: CLI print 模式压缩行为探针(真实 API,大额 token 消耗;手工 node 直跑)
  'claude-compact-probe-live.e2e.js',
  // 第45波45e: 压缩质量评测(真实 provider API,读真实 config 拿凭据;手工 node 直跑)
  'compact-quality-live.e2e.js',
]);

// 已知失败件(积压回归,CI 全量暴露,后续波修)。失败不计红(不挂 CI),但报告标 [known-fail];
// 若 PASS 则标 [unexpected-pass] 提醒清理名单。每条附原因 -- 名单不能成永久豁免,修好即删。
// 第36波(v1.7): capabilities 毕业 —— 挂账的 identity bleed 断言实测已过;真正失败的是 W1a 主动检索
// 指引(自适应装载后 web_search 不进首批 schema,D6 行按旧"已 offer"口径永不渲染),已修为目录可用口径。
// 第40波(v1.9): ui-v3-p1 毕业 —— ghost-danger hover 补 --danger-veil 令牌(两主题对称);发送⇄停止锁
// 迁移到 i18n 形状。名单清零,机制保留(空表 = 全绿无例外)。
const KNOWN_FAILURE = {};

// 快通道:无端口纯静态锁件(spawn|listen=0),秒级,先跑求快速反馈。
const isFast = f => /\.static\.e2e\.js$/.test(f);

// ─── 第36波(v1.7): 端口唯一性审计 ─────────────────────────────────────────────────────────────
// 串行时代跨文件撞端口无痛,但它是未来并行化的前置条件;且让"端口登记表"从人肉维护升级为机制断言
// (第34波亲验:README 登记 26 个、实际用 116 个,纯靠约定防撞)。占用即声明、撞车即红,新文件无需
// 任何登记动作。实现住 dev-harness/lib/port-audit.js(第46波46a 抽出真身,unit 测试同源 require,
// 杜绝"测复制副本"的 E2 漂移坑)。判定口径详见该模块头注。
const { portAuditFromDir } = require('./lib/port-audit');
function portAudit() { return portAuditFromDir(HARNESS); }

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
    }, timeoutFor(file));
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

// 第46波46b: 失败自动重跑一次。首跑失败 -> 原地重跑;二跑通过记 [flaky](计时累加,日志可见),
// 二跑仍失败才算真 fail(保留两次输出 tail,重跑的那次为准)。KNOWN_FAILURE 名单件不重试 ——
// 已知失败重试是浪费;flaky 计数进汇总,>0 时退出码仍为 0 但报告必须可见(沉默的 flaky 是明天的红)。
async function runWithRetry(file) {
  const first = await runOne(file);
  if (first.ok || KNOWN_FAILURE[file]) return { r: first, flaky: false };
  const second = await runOne(file);
  if (second.ok) return { r: { ...second, ms: first.ms + second.ms }, flaky: true };
  return { r: { ...second, out: `[retry] 首跑 tail:\n${tailLines(first.out, 8)}\n[retry] 重跑 tail:\n${second.out}`, ms: first.ms + second.ms }, flaky: false };
}
function tailLines(s, n) {
  return String(s || '').split(/\r?\n/).filter(Boolean).slice(-n).join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  // --parallel N: 并行路数(默认1=串行)
  const parallelIdx = argv.indexOf('--parallel');
  const PARALLEL = parallelIdx >= 0 ? Math.max(1, parseInt(argv[parallelIdx + 1], 10) || 4) : 1;
  // 第46波修复:无 --parallel 时 parallelIdx=-1,旧过滤式 i!==parallelIdx+1 会误删 argv[0]
  // —— `--fast` 被吞跑全量、指定件清单丢第一件。仅当旗标真实存在时才剔除它的两个槽位。
  const argvClean = parallelIdx >= 0 ? argv.filter((_, i) => i !== parallelIdx && i !== parallelIdx + 1) : argv;

  let files;
  if (argvClean.includes('--fast')) {
    files = listE2e().filter(isFast);
  } else if (argvClean.length && !argvClean[0].startsWith('-')) {
    files = argvClean.filter(f => f.endsWith('.e2e.js'));
  } else {
    files = listE2e();
    // 快通道先跑(秒级反馈),再跑主序(起 server 的件)
    files = [...files.filter(isFast), ...files.filter(f => !isFast(f))];
  }

  console.log(`# Ruyi e2e runner`);
  console.log(`# 件数: ${files.length} ran / ${SKIP.size} skipped(live)`);
  console.log(`# 超时: ${TIMEOUT_MS / 1000}s/件,${PARALLEL > 1 ? `并行(${PARALLEL}路)` : '串行(taskkill /T 杀整树)'}`);
  console.log(`# Node ${process.version}, platform ${process.platform}`);
  // 第36波: 端口唯一性审计(见 stripJsComments 上方说明)。撞车即拒跑 —— 带病跑完全量也是浪费。
  const audit = portAudit();
  if (audit.collisions.length) {
    console.error(`#\n# 端口唯一性审计失败(${audit.collisions.length} 处跨文件撞车),请先改端口再跑:`);
    for (const c of audit.collisions) console.error('#   ' + c);
    process.exit(2);
  }
  console.log(`# 端口审计: ${audit.count} 个带内端口,跨文件零撞车\n`);
  // 第46波46a: unit/ 不再是孤儿 —— 快通道最前跑 node --test(秒级),挂即拒跑。
  // 单测测的是 runner/安全关键逻辑(端口审计/注释剥离/XSS 规则),先挂先知道,别等 25 分钟全量。
  {
    const unitDir = path.join(HARNESS, 'unit');
    if (fs.existsSync(unitDir) && fs.readdirSync(unitDir).some(f => f.endsWith('.test.js'))) {
      // 注意:传目录会被 Node 当作入口模块(MODULE_NOT_FOUND),--test 要吃 glob 串(正斜杠)。
      const unitGlob = (unitDir + '/*.test.js').replace(/\\/g, '/');
      const u = cp.spawnSync(process.execPath, ['--test', unitGlob], { encoding: 'utf8', windowsHide: true });
      const tail = String(u.stdout + u.stderr).split(/\r?\n/).filter(l => /^# (pass|fail|tests)/.test(l));
      if (u.status !== 0) {
        console.error('# unit 测试失败(node --test dev-harness/unit),拒跑 e2e:\n' + String(u.stdout + u.stderr).split(/\r?\n/).slice(-40).join('\n'));
        process.exit(2);
      }
      console.log('# unit 测试: ' + (tail.join(' / ') || 'ALL PASS'));
    }
  }
  // 第43波: 构建 freshness 门 —— 测试永远跑【新鲜产物】。src/ 被改过而产物未重建时,
  // 自动重建(确定性操作,静默跑陈旧代码才是真风险);重建失败(切点自检不过)即拒跑。
  // build.js 不存在(部分检出/回滚到 43 波前的单体时代)则跳门,保持向后兼容。
  {
    const buildJs = path.join(HARNESS, '..', 'ruyi-workbench', 'app', 'build.js');
    if (!fs.existsSync(buildJs)) {
      console.log('# build freshness: app/build.js 不存在(单体时代树)— 跳门');
    } else {
      const b = cp.spawnSync(process.execPath, [buildJs, '--check'], { encoding: 'utf8', windowsHide: true });
      if (b.status !== 0) {
        console.log('# build freshness: 产物落后于 src —— 自动重建(node app/build.js)');
        const r = cp.spawnSync(process.execPath, [buildJs], { encoding: 'utf8', windowsHide: true });
        if (r.status !== 0) { console.error('# build 重建失败:\n' + (r.error && r.error.stack || r.stderr || r.stdout || '(无输出)')); process.exit(2); }
        console.log('# ' + String(r.stdout).trim());
      } else {
        console.log('# build freshness: 产物与 src 一致');
      }
    }
  }

  let pass = 0, fail = 0, knownFail = 0, unexpectedPass = 0, flakyCount = 0;
  const failed = [], results = [], flakyFiles = [];

  if (PARALLEL <= 1) {
    // ── 串行模式（原有逻辑）──
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const tag = isFast(f) ? '[fast]' : '[main]';
      process.stdout.write(`(${String(i + 1).padStart(3)}/${files.length}) ${tag} ${f} ... `);
      const { r, flaky } = await runWithRetry(f);
      results.push({ file: f, ok: r.ok, known: !!KNOWN_FAILURE[f], flaky, timedOut: r.timedOut, status: r.status, ms: r.ms });
      const known = KNOWN_FAILURE[f];
      if (r.ok) {
        pass++;
        if (flaky) { flakyCount++; flakyFiles.push(f); console.log(`PASS [flaky: 首跑失败,重跑通过 —— 需查时序] (${r.ms}ms)`); }
        else if (known) { unexpectedPass++; console.log(`PASS [unexpected-pass: known-failure 修好了?清理名单] (${r.ms}ms)`); }
        else console.log(`PASS (${r.ms}ms)`);
      } else {
        if (known) {
          knownFail++;
          console.log(`FAIL [known-fail] (${r.ms}ms) - ${known}`);
        } else {
          fail++;
          const reason = r.timedOut ? `TIMEOUT(>${timeoutFor(f) / 1000}s)` : `exit=${r.status}`;
          console.log(`FAIL ${reason} (重跑仍失败, ${r.ms}ms)`);
          failed.push(r);
        }
      }
    }
  } else {
    // ── 并行模式 ──
    // 将文件分成 PARALLEL 个桶,桶间并行,桶内串行
    const buckets = Array.from({ length: PARALLEL }, () => []);
    for (let i = 0; i < files.length; i++) buckets[i % PARALLEL].push(files[i]);

    console.log(`# 并行模式: ${PARALLEL} 路,每桶 ~${Math.ceil(files.length / PARALLEL)} 件\n`);

    const bucketPromises = buckets.map(async (bucket, bi) => {
      const bucketResults = [];
      for (const f of bucket) {
        const tag = isFast(f) ? '[fast]' : '[main]';
        const prefix = `[B${bi}]`;
        process.stdout.write(`${prefix} (${tag}) ${f} ... `);
        const { r, flaky } = await runWithRetry(f);
        bucketResults.push({ file: f, ok: r.ok, known: !!KNOWN_FAILURE[f], flaky, timedOut: r.timedOut, status: r.status, ms: r.ms });
        const known = KNOWN_FAILURE[f];
        if (r.ok) {
          if (flaky) console.log(`${prefix} PASS [flaky: 重跑通过] (${r.ms}ms)`);
          else if (known) console.log(`${prefix} PASS [unexpected-pass] (${r.ms}ms)`);
          else console.log(`${prefix} PASS (${r.ms}ms)`);
        } else {
          const reason = r.timedOut ? `TIMEOUT(>${timeoutFor(f) / 1000}s)` : `exit=${r.status}`;
          if (known) console.log(`${prefix} FAIL [known-fail] (${r.ms}ms) - ${known}`);
          else console.log(`${prefix} FAIL ${reason} (重跑仍失败, ${r.ms}ms)`);
        }
      }
      return bucketResults;
    });

    const allBuckets = await Promise.allSettled(bucketPromises);
    for (const settled of allBuckets) {
      // 审计教训(第39波): bucket 驳回时静默 [] 会把整桶结果从汇总里抹掉 —— 失败不可见即"假绿"。驳回必须入账。
      const bucketResults = settled.status === 'fulfilled' ? settled.value
        : [{ file: '(bucket-runner)', ok: false, timedOut: false, status: -1, out: '[bucket rejected] ' + (settled.reason && settled.reason.stack || settled.reason), ms: 0 }];
      for (const r of bucketResults) {
        results.push(r);
        const known = KNOWN_FAILURE[r.file];
        if (r.ok) {
          pass++;
          if (r.flaky) { flakyCount++; flakyFiles.push(r.file); }
          if (known) unexpectedPass++;
        } else {
          if (known) knownFail++;
          else { fail++; failed.push(r); }
        }
      }
    }
  }

  console.log(`\n# 汇总: ${pass} pass / ${fail} fail / ${knownFail} known-fail / ${unexpectedPass} unexpected-pass / ${flakyCount} flaky / ${files.length} ran / ${SKIP.size} skipped`);
  if (flakyFiles.length) {
    console.log(`# [flaky] 名单(首跑失败重跑通过,时序可疑,建议后续波治理):`);
    for (const f of flakyFiles) console.log('#   ' + f);
  }
  if (failed.length) {
    console.log(`\n# 失败件 tail(各取末 25 行):`);
    for (const r of failed) {
      console.log(`\n=== ${r.file} (${r.timedOut ? 'TIMEOUT' : 'exit=' + r.status}) ===`);
      const lines = String(r.out || '').split(/\r?\n/).filter(Boolean);
      console.log(lines.slice(-25).join('\n'));
    }
  }
  // 紧凑日志(供 CI artifact 上传;失败 tail 见 step 输出)
  try {
    fs.writeFileSync(path.join(HARNESS, 'last-run.log'), [
      `# Ruyi e2e last-run log`,
      `# ${pass} pass / ${fail} fail / ${knownFail} known-fail / ${unexpectedPass} unexpected-pass / ${flakyCount} flaky / ${files.length} ran / ${SKIP.size} skipped`,
      `# Node ${process.version}, platform ${process.platform}, parallel=${PARALLEL}`,
      ...results.map(r => `${r.ok ? (r.known ? 'UNEXPECTED_PASS' : (r.flaky ? 'FLAKY_PASS' : 'PASS')) : (r.known ? 'KNOWN_FAIL' : 'FAIL')}\t${r.ms}ms\t${r.file}`),
    ].join('\n') + '\n');
  } catch { /* 只读环境(CI 沙箱)忽略 */ }

  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
