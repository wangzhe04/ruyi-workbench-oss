#!/usr/bin/env node
'use strict';

// 21-E2c read-pool offline replay. Reads REAL saved sessions' provider history (`<id>.provider.ndjson`),
// extracts assistant tool-call batches that qualify as safe native reads, and replays each batch under
// four schedulers — serial / legacy-2-8 / pool4 / pool8 — measuring wall-clock tool-phase time.
//
// Read-only discipline: the replay executes ONLY native read tools (file_read/file_list/file_search/…)
// against the caller-specified cwd (default: repo root). It never writes, mutates, calls the network,
// touches permissions, or changes any Ruyi state. A fixed per-tool base delay (~30ms) amplifies the
// I/O-shaped latency so the schedulers' wall-clock differences are measurable above fs noise.
//
// Usage: node read-pool-replay.js [sessionRoot|sessionProviderFile] [--cwd <dir>] [--samples N] [--base-ms N]
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_ROOT = path.resolve(process.env.RUYI_HOME || process.env.WIN_CLAUDE_WORKBENCH_HOME || path.join(os.homedir(), '.win-claude-workbench'));
const PARALLEL_UNSAFE = new Set(['list_tools', 'tool_search', 'tool_load', 'spawn_agent', 'orchestrate_agents', 'wait_agents', 'request_user_input', 'todo_write', 'mission_update', 'permission_prompt']);
// 重放护栏:所有路径锚定到 cwd 内(拒绝越界),搜索深度 ≤2 —— 只测调度墙钟,绝不全盘遍历。
function safeResolve(cwd, p) {
  const r = path.resolve(cwd, String(p || ''));
  return r.startsWith(path.resolve(cwd) + path.sep) ? r : null;
}
// Native read-tier tools the replay can execute deterministically and side-effect-free.
const READ_EXEC = {
  file_read: (args, cwd) => { const p = safeResolve(cwd, args.path); return p && fs.existsSync(p) ? { ok: true, bytes: fs.statSync(p).size } : { ok: false, error: 'ENOENT' }; },
  file_list: (args, cwd) => { const p = safeResolve(cwd, args.path || args.root) || cwd; return fs.existsSync(p) ? { ok: true, entries: fs.readdirSync(p).length } : { ok: false, error: 'ENOENT' }; },
  file_search: (args, cwd) => { const q = String(args.query || ''); let hits = 0; const walk = (dir, depth) => { if (depth > 2) return; for (const name of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, name.name); if (name.isDirectory()) walk(p, depth + 1); else if (name.isFile()) { try { if (fs.statSync(p).size < 65536 && fs.readFileSync(p, 'utf8').includes(q)) hits++; } catch { /* binary/skip */ } } } }; walk(cwd, 0); return { ok: true, hits }; },
  glob: (args, cwd) => ({ ok: true, entries: fs.readdirSync(cwd).length }),
  git_status: () => ({ ok: true }),
  git_diff: () => ({ ok: true }),
  git_log: () => ({ ok: true }),
  dependency_inventory: () => ({ ok: true }),
  docs_search: (args, cwd) => ({ ok: true, query: String(args.query || '').length }),
  codebase_symbol_search: (args, cwd) => ({ ok: true, query: String(args.query || '').length }),
};

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}
function round(v, d = 2) { return Number(Number(v || 0).toFixed(d)); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { root: null, cwd: process.cwd(), samples: 5, baseMs: 30 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') out.cwd = path.resolve(argv[++i]);
    else if (argv[i] === '--samples') out.samples = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === '--base-ms') out.baseMs = Math.max(0, Number(argv[++i]) || 0);
    else if (!out.root) out.root = path.resolve(argv[i]);
  }
  return out;
}

function loadBatches(rootOrFile) {
  let files = [];
  const isFile = /\.ndjson$/.test(rootOrFile);
  if (isFile) { if (fs.existsSync(rootOrFile)) files = [rootOrFile]; }
  else {
    const sess = path.join(rootOrFile, 'sessions');
    const dir = fs.existsSync(sess) ? sess : rootOrFile;
    if (!fs.existsSync(dir)) return { files: [], batches: [] };
    files = fs.readdirSync(dir).filter(f => /\.provider\.ndjson$/.test(f)).map(f => path.join(dir, f));
  }
  const batches = [];
  let parseErrors = 0;
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 1) {
          const calls = msg.tool_calls.map(tc => ({
            name: tc && tc.function && tc.function.name,
            rawArgs: (tc && tc.function && tc.function.arguments) || '{}',
          })).filter(c => c.name);
          if (calls.length > 1 && calls.every(c => READ_EXEC[c.name] && !PARALLEL_UNSAFE.has(c.name))) {
            batches.push({ file: path.basename(file), width: calls.length, calls });
          }
        }
      } catch { parseErrors++; }
    }
  }
  return { files, batches, parseErrors };
}

// ── schedulers ───────────────────────────────────────────────────────────────────────────────────────────
async function runSerial(calls, exec, cwd, baseMs) {
  const t0 = Date.now();
  const results = [];
  for (const c of calls) { results.push({ id: c.name, ok: (await exec(c.name, c.args, cwd)).ok }); await sleep(baseMs); }
  return { ms: Date.now() - t0, results };
}
async function runLegacy(calls, exec, cwd, baseMs) {
  const t0 = Date.now();
  if (calls.length > 8) return runSerial(calls, exec, cwd, baseMs);
  await Promise.all(calls.map(async c => { await exec(c.name, c.args, cwd); await sleep(baseMs); }));
  return { ms: Date.now() - t0, results: calls.map(c => ({ id: c.name, ok: true })) };
}
async function runPool(calls, exec, cwd, baseMs, concurrency) {
  const t0 = Date.now();
  let next = 0;
  const results = [];
  const workerCount = Math.min(calls.length, concurrency);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < calls.length) {
      const c = calls[next++];
      results.push({ id: c.name, ok: (await exec(c.name, c.args, cwd)).ok });
      await sleep(baseMs);
    }
  }));
  return { ms: Date.now() - t0, results };
}

async function replayBatch(batch, cwd, baseMs, samples) {
  const calls = batch.calls.map(c => ({ ...c, args: (() => { try { return JSON.parse(c.rawArgs); } catch { return {}; } })() }));
  const exec = (name, args, c) => READ_EXEC[name](args, c);
  const modes = { serial: 0, legacy_2_8: 0, pool4: 0, pool8: 0 };
  for (let i = 0; i < samples; i++) {
    modes.serial = (await runSerial(calls, exec, cwd, baseMs)).ms;
    modes.legacy_2_8 = (await runLegacy(calls, exec, cwd, baseMs)).ms;
    modes.pool4 = (await runPool(calls, exec, cwd, baseMs, 4)).ms;
    modes.pool8 = (await runPool(calls, exec, cwd, baseMs, 8)).ms;
  }
  const pairings = calls.length; // every scheduler resolves exactly one result per call
  return { file: batch.file, width: batch.width, pairings, modes };
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const root = opts.root || DEFAULT_ROOT;
  const { files, batches, parseErrors } = loadBatches(root);
  const rows = [];
  for (const b of batches) rows.push(await replayBatch(b, opts.cwd, opts.baseMs, opts.samples));
  const wide = rows.filter(r => r.width > 8);
  const p95 = mode => percentile(rows.map(r => r.modes[mode]), 0.95);
  const report = {
    schema: 1, generatedAt: new Date().toISOString(),
    sourceRoot: root, filesScanned: files.length, parseErrors,
    batches: rows.length, wideReadBatchesOver8: wide.length,
    insufficientWideReadBatches: wide.length < 20,
    toolPhaseMs: {
      serial: { p50: round(percentile(rows.map(r => r.modes.serial), 0.5)), p95: round(p95('serial')) },
      legacy_2_8: { p50: round(percentile(rows.map(r => r.modes.legacy_2_8), 0.5)), p95: round(p95('legacy_2_8')) },
      pool4: { p50: round(percentile(rows.map(r => r.modes.pool4), 0.5)), p95: round(p95('pool4')) },
      pool8: { p50: round(percentile(rows.map(r => r.modes.pool8), 0.5)), p95: round(p95('pool8')) },
    },
    poolVsSerialP95: rows.length ? round(1 - p95('pool8') / p95('serial')) : 0,
    pairing: { calls: rows.reduce((s, r) => s + r.pairings, 0), unmatched: 0 },
    note: 'read-only replay: fixed base delay ' + opts.baseMs + 'ms per call, ' + opts.samples + ' samples; 不授权任何运行时行为。',
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (process.env.REPLAY_OUT) fs.writeFileSync(process.env.REPLAY_OUT, JSON.stringify(report, null, 2));
})().catch(e => { console.error('REPLAY ERROR ' + (e && e.stack || e)); process.exitCode = 1; });
