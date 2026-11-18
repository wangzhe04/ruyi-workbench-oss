'use strict';

const GROUP = 'external-bots-group-decisions.e2e.js';
const HUMAN = 'external-bots-human-decisions.e2e.js';
const ACTIONS = Object.freeze(['permission/allow', 'permission/deny', 'question/answer',
  'plan/approve', 'plan/reject', 'pool/approve', 'pool/reject', 'replan/approve', 'replan/reject']);
const GROUP_CHECKS = Object.freeze([
  'PASS qq: signed group owner reaches the worker and fails closed before message dispatch',
  'PASS feishu: signed group owner reaches the worker and fails closed before message dispatch',
  'PASS the same original live permission is offerable to its direct owner and remains unapplied',
  'PASS original fixture child and loopback listeners closed',
]);
const pid = value => Number.isSafeInteger(value) && value > 0;
const timestamp = value => Number.isSafeInteger(value) && value > 0;
const action = v => v?.type + '/' + v?.action;

function businessAssertions(fixture, stdout, report) {
  const lines = stdout.split(/\r?\n/);
  if (lines.some(line => /^FAIL\b| E2E: FAIL\b/.test(line))) return false;
  const passes = lines.filter(line => line.startsWith('PASS '));
  if (fixture === GROUP) return passes.length === GROUP_CHECKS.length &&
    GROUP_CHECKS.every((check, i) => check === passes[i]) &&
    lines.includes('EXTERNAL BOTS GROUP DECISIONS E2E: ALL PASS');
  if (fixture !== HUMAN || !lines.includes('EXTERNAL BOTS C2 ACTUAL HTTP E2E: ALL PASS') ||
      passes.length !== ACTIONS.length ||
      !ACTIONS.every((name, i) => passes[i] === 'PASS ' + name + ': actual HTTP/callback/original consumer/terminal once')) return false;
  const selected = report?.selectedJourneys;
  return report?.status === 'passed-selected-journeys-and-known-cleanup' && report.browser === false &&
    report.cleanup?.status === 'known-held-actors-closed' && Array.isArray(report.diagnosticErrors) &&
    report.diagnosticErrors.length === 0 && selected?.status === 'completed' && selected.requested === ACTIONS.length &&
    Array.isArray(selected.completed) && selected.completed.length === ACTIONS.length &&
    Array.isArray(report.cases) && report.cases.length === ACTIONS.length &&
    ACTIONS.every((name, i) => {
      const entry = report.cases[i];
      return action(selected.completed[i]) === name && action(entry) === name &&
        entry.business === 'completed' && entry.cleanup?.status === 'known-held-actors-closed';
    });
}

function guardLifecycles(fixture, serverEvents, flushEvents, fixturePid) {
  const count = fixture === GROUP ? 1 : fixture === HUMAN ? ACTIONS.length : 0;
  if (!count || !pid(fixturePid) || !Array.isArray(serverEvents) || serverEvents.length !== count * 2 ||
      !Array.isArray(flushEvents) || flushEvents.length % 3 !== 0) return false;
  const servers = new Map(), seen = new Set([fixturePid]), flushed = new Set();
  let last = 0;
  for (let i = 0; i < serverEvents.length; i += 2) {
    const [start, end] = serverEvents.slice(i, i + 2);
    const exited = end?.exit, closed = end?.close;
    if (start?.schema !== 1 || end?.schema !== 1 || start.kind !== 'guard-issued-server' ||
        end.kind !== 'guard-server-close' || start.parentPid !== fixturePid || end.parentPid !== fixturePid ||
        !pid(start.pid) || end.pid !== start.pid || seen.has(start.pid) || !timestamp(start.at) || !timestamp(end.at) ||
        start.at < last || end.at < start.at || end.processError !== false ||
        !timestamp(exited?.at) || exited.at < start.at || exited.at > end.at ||
        !closed || exited.code !== closed.code || exited.signal !== closed.signal ||
        !((exited.code === 0 && exited.signal === null) || (exited.code === null && exited.signal === 'SIGTERM'))) return false;
    servers.set(start.pid, { start: start.at, exit: exited.at });
    seen.add(start.pid);
    last = end.at;
  }
  for (let i = 0; i < flushEvents.length; i += 3) {
    const [start, end, close] = flushEvents.slice(i, i + 3);
    const server = servers.get(start?.parentPid);
    if (!server || start?.schema !== 1 || end?.schema !== 1 || close?.schema !== 1 ||
        start.kind !== 'spawn' || end.kind !== 'exit' || close.kind !== 'close' || start.inputAccepted !== true ||
        !pid(start.pid) || start.pid !== end.pid || start.pid !== close.pid || seen.has(start.pid) ||
        end.parentPid !== start.parentPid || close.parentPid !== start.parentPid ||
        ![start.at, end.at, close.at].every(timestamp) || start.at < server.start ||
        end.at < start.at || close.at < end.at || close.at > server.exit ||
        end.code !== 0 || close.code !== 0 || end.signal !== null || close.signal !== null) return false;
    seen.add(start.pid);
    flushed.add(start.parentPid);
  }
  return flushed.size === servers.size;
}

module.exports = Object.freeze({ businessAssertions, guardLifecycles });
