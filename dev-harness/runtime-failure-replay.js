#!/usr/bin/env node
'use strict';

// Offline F1 taxonomy replay. It joins already-redacted failure events to their local provider tool-result
// records by sessionId/toolCallId, runs the CURRENT deterministic classifier, and emits aggregate counts only.
// No raw query, arguments, stdout, stderr, path, or error text is printed or written.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { classifyRuntimeToolFailure } = require('../ruyi-workbench/app/server.js');

function increment(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function sortedCounts(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count }));
}
function resolveDataRoot(input) {
  return path.resolve(input || process.env.RUYI_HOME || process.env.WIN_CLAUDE_WORKBENCH_HOME || path.join(os.homedir(), '.win-claude-workbench'));
}
function parseLines(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* malformed unrelated rows are reported by the normal log reader */ }
  }
  return rows;
}
function readFailureEvents(dataRoot) {
  const logDir = path.join(dataRoot, 'logs');
  if (!fs.existsSync(logDir)) return [];
  const rows = [];
  for (const name of fs.readdirSync(logDir).filter(value => /^workbench-\d{4}-\d{2}-\d{2}\.ndjson$/.test(value)).sort()) {
    for (const row of parseLines(path.join(logDir, name))) if (row && row.kind === 'runtime_failure_classified') rows.push(row);
  }
  return rows;
}
function replayFailureEvents(dataRoot, classify = classifyRuntimeToolFailure) {
  const events = readFailureEvents(dataRoot);
  const pending = new Map();
  for (const event of events) {
    const key = `${String(event.sessionId || '')}\0${String(event.toolCallId || '')}`;
    if (!event.sessionId || !event.toolCallId) continue;
    if (!pending.has(key)) pending.set(key, []);
    pending.get(key).push(event);
  }
  const sessions = new Set(events.map(event => String(event.sessionId || '')).filter(Boolean));
  const before = new Map(), after = new Map(), repairs = new Map(), versions = new Map();
  for (const event of events) increment(before, String(event.failureClass || 'unknown'));
  let matched = 0, recoverableCount = 0, deterministicCount = 0, mutatingRetryOnce = 0;
  for (const sessionId of sessions) {
    const file = path.join(dataRoot, 'sessions', `${sessionId}.provider.ndjson`);
    for (const message of parseLines(file)) {
      if (!message || message.role !== 'tool' || !message.tool_call_id) continue;
      const key = `${sessionId}\0${String(message.tool_call_id)}`;
      const targets = pending.get(key);
      if (!targets || !targets.length) continue;
      let toolResult;
      try { toolResult = typeof message.content === 'string' ? JSON.parse(message.content) : message.content; }
      catch { continue; }
      for (const event of targets) {
        const next = classify(event.toolName, toolResult, { tier: event.tier, disposition: event.disposition });
        if (!next) continue;
        matched += 1;
        increment(after, String(next.failureClass || 'unknown'));
        increment(repairs, String(next.allowedRepair || 'diagnose_only'));
        increment(versions, String(next.classifierVersion || 'unversioned'));
        if (next.recoverableHint === true) recoverableCount += 1;
        if (next.deterministic === true) deterministicCount += 1;
        if ((next.tier === 'edit' || next.tier === 'exec') && next.allowedRepair === 'retry_once') mutatingRetryOnce += 1;
      }
      pending.delete(key);
    }
  }
  return {
    schema: 1,
    mode: 'runtime-failure-offline-replay',
    totalEvents: events.length,
    matchedEvents: matched,
    unmatchedEvents: events.length - matched,
    beforeByClass: sortedCounts(before),
    afterByClass: sortedCounts(after),
    afterByAllowedRepair: sortedCounts(repairs),
    classifierVersions: sortedCounts(versions),
    recoverableCount,
    recoverableRate: matched ? Number((recoverableCount / matched).toFixed(4)) : 0,
    deterministicCount,
    deterministicRate: matched ? Number((deterministicCount / matched).toFixed(4)) : 0,
    safety: { mutatingRetryOnce, pass: mutatingRetryOnce === 0 },
    privacy: { rawToolResultsEmitted: false, userStateWrites: 0 },
  };
}

function main() {
  const dataRoot = resolveDataRoot(process.argv[2]);
  const report = replayFailureEvents(dataRoot);
  report.source = { dataRoot, logs: path.join(dataRoot, 'logs'), sessions: path.join(dataRoot, 'sessions') };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

if (require.main === module) main();
module.exports = { resolveDataRoot, readFailureEvents, replayFailureEvents };
