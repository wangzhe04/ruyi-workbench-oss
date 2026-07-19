#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// claude-compact-probe-live.e2e.js — 第42c波:CLI print 模式压缩行为探针(LIVE,一次性决策用)
//
//   node dev-harness/claude-compact-probe-live.e2e.js
//
// 要回答的问题(44c「Claude 引擎超窗兜底」的设计依据,此前从未真机验证):
//   P1) print 模式(-p)是否接受 /compact 作为 prompt(手动压缩退路是否存在)?
//   P2) print + --resume 多轮累积超窗时,CLI 是否自己 auto-compact,还是直接报错?
// 探法:
//   P1: 小会话打底 → resume 发 "/compact" → 看 result 与事件流是否发生压缩
//   P2: turn1 灌 ~150K tokens(haiku 窗口 200K)→ turn2 resume 再灌 ~80K(累计 ~230K > 窗口)
//       → turn2 成功(带压缩痕迹)= CLI 自管;报错(prompt too long 类)= 工作台须自己做 44c 兜底
// 成本:haiku,输入 ~230K tokens + 若干小回合,一次 ≈ $0.2-0.3。【非回归件,结果写进路线图即使命完成】
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));

function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function runCli(exe, args, cwd, timeoutMs, stdinText) {
  return new Promise(resolve => {
    const child = cp.spawn(exe, args, { windowsHide: true, cwd, env: process.env });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { kill(child); resolve({ status: null, out, err, timeout: true }); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); resolve({ status: -1, out, err: err + String(e) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ status: code, out, err }); });
    if (stdinText) child.stdin.write(stdinText); // 大 prompt 走 stdin(argv 有 Windows 命令行长度上限)
    child.stdin.end();
  });
}
const eventsOf = out => out.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const typeSummary = evs => evs.map(e => e.type + (e.subtype ? '/' + e.subtype : '')).join(' ');

// 生成 ≈targetTokens 的可复现填充文本(ASCII 为主,~3.5 chars/token;行号防「全同内容」优化路径)
function filler(targetTokens, tag) {
  const chars = Math.floor(targetTokens * 3.5);
  const line = i => `${tag}-L${i}: the quick brown fox jumps over the lazy dog ${i} pack my box with five dozen liquor jugs\n`;
  let s = '', i = 0;
  while (s.length < chars) { s += line(i++); }
  return s;
}

(async () => {
  console.log('CLAUDE COMPACT PROBE (LIVE · 一次性 · 真实 token 消耗 ≈$0.2-0.3)');
  const exe = srv.resolveClaudeLauncher('claude.cmd');
  if (!/claude\.exe$/i.test(exe) || !fs.existsSync(exe)) { console.log('SKIP: 未安装 claude CLI'); return; }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-compact-probe-'));
  const findings = {};

  // ── P1: print 模式是否接受 /compact ──────────────────────────────────────
  {
    const t1 = await runCli(exe, ['-p', 'Remember the codeword PINEAPPLE-42. Reply with just: stored', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], cwd, 120000);
    const r1 = eventsOf(t1.out).find(e => e.type === 'result');
    if (!r1 || r1.subtype !== 'success') { console.log('SKIP: CLI 未登录或首回合失败 —— ' + String(r1 && r1.result || t1.err).slice(0, 200)); return; }
    const sid = r1.session_id;
    const t2 = await runCli(exe, ['-p', '--resume', sid, '/compact', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], cwd, 180000);
    const evs2 = eventsOf(t2.out);
    const r2 = evs2.find(e => e.type === 'result');
    findings.p1 = {
      exitOk: t2.status === 0,
      resultSubtype: r2 && r2.subtype,
      isError: r2 && r2.is_error,
      resultText: String(r2 && r2.result || '').slice(0, 300),
      hadCompactEvent: evs2.some(e => /compact/i.test(String(e.type) + String(e.subtype || ''))),
      eventTypes: typeSummary(evs2).slice(0, 400),
    };
  }

  // ── P2: print + resume 超窗,CLI 是否 auto-compact ────────────────────────
  {
    const big1 = filler(150000, 'TURN1');
    const t1 = await runCli(exe, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], cwd, 300000, big1 + '\n\nAbove is filler data. Reply with exactly: ACK1');
    const evs1 = eventsOf(t1.out);
    const r1 = evs1.find(e => e.type === 'result');
    if (!r1 || r1.subtype !== 'success') {
      findings.p2 = { aborted: true, reason: 'turn1(150K)未成功,无法构造超窗场景', detail: String(r1 && r1.result || t1.err).slice(0, 300), usage: r1 && r1.usage };
    } else {
      const sid = r1.session_id;
      const big2 = filler(80000, 'TURN2');
      const t2 = await runCli(exe, ['-p', '--resume', sid, '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], cwd, 300000, big2 + '\n\nAbove is more filler. Reply with exactly: ACK2');
      const evs2 = eventsOf(t2.out);
      const r2 = evs2.find(e => e.type === 'result');
      findings.p2 = {
        turn1Usage: r1.usage,
        turn2ExitOk: t2.status === 0,
        turn2Subtype: r2 && r2.subtype,
        turn2IsError: r2 && r2.is_error,
        turn2Text: String(r2 && r2.result || '').slice(0, 400),
        turn2HadCompactEvent: evs2.some(e => /compact/i.test(String(e.type) + String(e.subtype || ''))),
        turn2EventTypes: typeSummary(evs2).slice(0, 500),
        stderr: t2.err.slice(0, 300),
      };
    }
  }

  fs.rmSync(cwd, { recursive: true, force: true });
  console.log('\n════════ 探针结论 ════════');
  console.log(JSON.stringify(findings, null, 2));
  // 判读辅助
  if (findings.p2 && !findings.p2.aborted) {
    const selfManaged = findings.p2.turn2ExitOk && findings.p2.turn2Subtype === 'success';
    console.log('\n判读: print+resume 超窗 → ' + (selfManaged
      ? 'CLI 自管(auto-compact 或内部处理),44c 缩水为「只修子代理重试」'
      : 'CLI 不自管(直接报错)—— 44c 全量做:工作台须检测超窗并自动 /compact 重试'));
  }
  if (findings.p1) {
    console.log('判读: print 模式 /compact → ' + (findings.p1.exitOk && findings.p1.resultSubtype === 'success'
      ? '可用作手动压缩退路(44c 可直接复用)' : '不可用作 print 模式压缩手段(' + findings.p1.resultSubtype + ')'));
  }
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
