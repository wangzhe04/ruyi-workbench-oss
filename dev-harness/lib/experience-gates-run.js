'use strict';
// 体验门量具的【进程编排】:给每个工作进程造一份独立的临时家 + 数据根,拉起 experience-gates-worker.js,
// 收它的 XG_* 行,收尾时趁根进程还活着按创建时间认子孙、只杀自己的树(lib/kill-own-tree.js),最后再核一遍
// 「起过的进程都不在了」。不按名字杀任何进程,不自造收尸器。
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { releaseEnvironment } = require('./release-checks');
const { killOwnTree, snapshotProcessTable, ownDescendants } = require('./kill-own-tree');
const { isolationProblems } = require('./experience-gates-worker');

const WORKER = path.join(__dirname, 'experience-gates-worker.js');

// 宿主侧的 CPU 忙闲采样(Windows 上 os.loadavg() 恒为 0,只能用 os.cpus() 的时间片差)。
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.irq + t.idle; }
  return { idle, total };
}
function startCpuSampler(intervalMs = 1000) {
  const samples = [];
  let prev = cpuTimes();
  const timer = setInterval(() => {
    const now = cpuTimes();
    const dt = now.total - prev.total;
    if (dt > 0) samples.push(100 * (1 - (now.idle - prev.idle) / dt));
    prev = now;
  }, intervalMs);
  return {
    stop() { clearInterval(timer); return summarizeCpu(samples); },
    peek() { return summarizeCpu(samples); },
  };
}
function summarizeCpu(samples) {
  if (!samples.length) return { samples: 0, avgBusyPct: null, maxBusyPct: null };
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { samples: samples.length, avgBusyPct: Number(avg.toFixed(1)), maxBusyPct: Number(Math.max(...samples).toFixed(1)) };
}
async function sampleCpuFor(ms) {
  const s = startCpuSampler(500);
  await new Promise(resolve => setTimeout(resolve, ms));
  return s.stop();
}

function jobEnv(root) {
  const home = path.join(root, 'home'), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const env = releaseEnvironment(home, data);
  Object.assign(env, {
    WCW_TEST_NO_NET_ANCHORS: '1', WCW_NO_BROWSER: '1',
    XG_RUN_ROOT: root, XG_REAL_HOME: os.homedir(), RUYI_REAL_HOME: os.homedir(),
  });
  return env;
}

// 宿主只核它自己能核的那一半(环境变量);os.homedir()/os.tmpdir()/cwd 由工作进程起来后自己再核一遍。
function hostIsolationProblems(env) {
  return isolationProblems(env).filter(p => !/^(os\.homedir|os\.tmpdir|cwd)/.test(p));
}

function runJob({ base, name, mode, opts = {}, timeoutMs = 300000, onLine }) {
  const root = path.join(base, name.replace(/[^A-Za-z0-9_.-]/g, '_'));
  fs.mkdirSync(root, { recursive: true });
  const env = jobEnv(root);
  const problems = hostIsolationProblems(env);
  const record = { name, mode, opts, startedAt: new Date().toISOString(), pid: null, tree: [], killed: null, exit: null, reason: null, result: null, partial: null, refused: null };
  if (problems.length) { record.reason = 'host-refused'; record.refused = problems; return Promise.resolve(record); }
  const t0 = Date.now();
  const cpu = startCpuSampler(1000);
  return new Promise(resolve => {
    const child = cp.spawn(process.execPath, [WORKER, mode, JSON.stringify(opts)], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    record.pid = child.pid;
    let buf = '', finished = false, stderrTail = '';
    const finish = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      record.reason = reason;
      // 根还活着时认子孙(创建时间不早于父亲),记下来,收尾后再核一遍它们都不在了。
      try {
        const table = snapshotProcessTable();
        const tree = table ? ownDescendants(table, child.pid) : { root: null, descendants: [] };
        record.tree = [tree.root, ...tree.descendants].filter(Boolean).map(r => ({ pid: r.pid, name: r.name, created: r.created.toString() }));
      } catch { /* 快照失败:killOwnTree 自己会再取一次 */ }
      record.killed = killOwnTree(child);
      record.wallMs = Date.now() - t0;
      record.cpu = cpu.stop();
      record.stderrTail = stderrTail.slice(-1500);
      // 等 exit 事件(句柄关掉)再交回,免得下一件起来时这一件还在收尾。
      const settle = () => resolve(record);
      if (child.exitCode !== null || child.signalCode !== null) settle();
      else { const t = setTimeout(settle, 5000); child.once('exit', () => { clearTimeout(t); settle(); }); }
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        const m = /^(XG_[A-Z]+)(?: (.*))?$/.exec(line);
        if (!m) continue;
        let value = null; try { value = m[2] ? JSON.parse(m[2]) : null; } catch { value = null; }
        if (m[1] === 'XG_RESULT') record.result = value;
        else if (m[1] === 'XG_PARTIAL') record.partial = value;
        else if (m[1] === 'XG_REFUSED') record.refused = value && value.problems;
        if (onLine) onLine(m[1], value);
        if (m[1] === 'XG_DONE' || m[1] === 'XG_REFUSED') setImmediate(() => finish(m[1] === 'XG_DONE' ? 'done' : 'worker-refused'));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-8000); if (process.env.XG_VERBOSE) process.stderr.write(chunk); });
    child.on('exit', (code, signal) => {
      record.exit = { code, signal };
      if (!finished) finish('exited-early');
    });
  });
}

// 收工核对:起过的每个进程(根 + 收尾那一刻认出的子孙)按「pid + 创建时间」都已不在进程表里。
function verifyGone(records) {
  const table = snapshotProcessTable();
  if (!table) return { checked: false, reason: 'process snapshot failed' };
  const alive = [];
  let tracked = 0;
  for (const r of records) {
    for (const p of r.tree || []) {
      tracked++;
      const now = table.find(row => row.pid === p.pid);
      if (now && now.created.toString() === p.created) alive.push({ job: r.name, pid: p.pid, name: p.name });
    }
  }
  return { checked: true, tracked, alive };
}

module.exports = { runJob, verifyGone, sampleCpuFor, startCpuSampler, jobEnv, hostIsolationProblems };
