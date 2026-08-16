#!/usr/bin/env node
'use strict';

// 20-F1 data-gate report. Reads only the already-redacted runtime_failure_classified records emitted by
// the opt-in shadow flag; it never reads tool arguments/results and never mutates Ruyi state.
const fs = require('fs');
const path = require('path');

function increment(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function sortedCounts(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
}

function summarizeFailureEvents(events) {
  const rows = (Array.isArray(events) ? events : []).filter(e => e && e.kind === 'runtime_failure_classified');
  const byClass = new Map(), byTool = new Map(), byTier = new Map();
  let recoverableCount = 0, deterministicCount = 0, sideEffectUnknownCount = 0;
  for (const row of rows) {
    increment(byClass, String(row.failureClass || 'unknown'));
    increment(byTool, String(row.toolName || 'unknown'));
    increment(byTier, String(row.tier || 'unknown'));
    if (row.recoverableHint === true) recoverableCount++;
    if (row.deterministic === true) deterministicCount++;
    if (row.failureClass === 'side_effect_unknown') sideEffectUnknownCount++;
  }
  const sampleSize = rows.length;
  const recoverableRate = sampleSize ? recoverableCount / sampleSize : 0;
  const deterministicRate = sampleSize ? deterministicCount / sampleSize : 0;
  const checks = {
    enoughSamples: sampleSize >= 30,
    recoverableShare: recoverableRate >= 0.15,
    deterministicShare: deterministicRate >= 0.5,
    enoughRecoverableCases: recoverableCount >= 5,
  };
  const pass = Object.values(checks).every(Boolean);
  let recommendation = 'collect_more';
  if (checks.enoughSamples) recommendation = pass ? 'implement_bounded_recovery' : 'do_not_implement_recovery';
  return {
    schema: 1, generatedAt: new Date().toISOString(), sampleSize, recoverableCount,
    recoverableRate: Number(recoverableRate.toFixed(4)), deterministicCount,
    deterministicRate: Number(deterministicRate.toFixed(4)), sideEffectUnknownCount,
    gate: { pass, checks, recommendation },
    byClass: sortedCounts(byClass), byTool: sortedCounts(byTool), byTier: sortedCounts(byTier),
    note: 'side_effect_unknown is never eligible for automatic replay; this report authorizes no runtime behavior by itself.',
  };
}

function resolveLogDir(input) {
  const target = path.resolve(input || process.env.RUYI_HOME || process.env.WIN_CLAUDE_WORKBENCH_HOME || path.join(require('os').homedir(), '.win-claude-workbench'));
  const nested = path.join(target, 'logs');
  return fs.existsSync(nested) && fs.statSync(nested).isDirectory() ? nested : target;
}

function readFailureEvents(logDir) {
  if (!fs.existsSync(logDir)) return { events: [], files: [], parseErrors: 0 };
  const files = fs.readdirSync(logDir).filter(name => /^workbench-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)).sort();
  const events = []; let parseErrors = 0;
  for (const name of files) {
    const lines = fs.readFileSync(path.join(logDir, name), 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try { const row = JSON.parse(line); if (row && row.kind === 'runtime_failure_classified') events.push(row); }
      catch { parseErrors++; }
    }
  }
  return { events, files, parseErrors };
}

function main() {
  const logDir = resolveLogDir(process.argv[2]);
  const read = readFailureEvents(logDir);
  const report = summarizeFailureEvents(read.events);
  report.source = { logDir, files: read.files, parseErrors: read.parseErrors };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

if (require.main === module) main();
module.exports = { summarizeFailureEvents, resolveLogDir, readFailureEvents };
