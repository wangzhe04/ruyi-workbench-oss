'use strict';
// Exact source domain owner with owned synthetic keys; no generated runtime or real home.
// Config bytes/normalization are synthetic here; the generated owner probe exercises
// the real normalizer and the repeated empty-config recovery concurrency contract.
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os');
const path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { sliceBlock, functionBlock, constBlock } = require('./source-slice');
const { loadWorkDataJournals } = require('./work-data-journals-fixture');
const source = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
function auditFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-audit-source-'));
  t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
  const logs = path.join(dir, 'logs'), configFile = path.join(dir, 'config.json'); fs.mkdirSync(logs);
  const state = { enabled: true, acquires: 0, releases: 0, now: '2026-10-24T23:59:59.000Z', diagnostics: [], appendBatches: [] };
  const master = crypto.randomBytes(32);
  const io = { ...fsp, readFile: async (file, ...args) => {
    if (file !== configFile) return fsp.readFile(file, ...args);
    if (state.onConfig) await state.onConfig(); if (state.configError) throw state.configError;
    return state.configRaw === undefined ? JSON.stringify({ workDataEncryptionV1: state.enabled, privacyPolicyRecoveryRequiredV1: state.degraded === true }) : state.configRaw;
  }, appendFile: async (...args) => { if (state.failPlain) throw Object.assign(Error('SECRET failure'), { code: 'EIO' }); return fsp.appendFile(...args); },
    truncate: async (...args) => { if (state.failTruncate) throw Object.assign(Error('truncate'), { code: 'EIO' }); return fsp.truncate(...args); },
    open: async (file, mode, ...args) => {
      const handle = await fsp.open(file, mode, ...args); let writes = 0;
      return new Proxy(handle, { get(target, property) {
        if (property === 'stat' && state.freezeFile === file) return async options => options?.bigint ? state.frozenStat : target.stat(options);
        if (mode === 'a' && property === 'write' && state.failAppend) return async (...writeArgs) => { if (++writes > 1) throw Object.assign(Error('SECRET disk'), { code: 'ENOSPC' }); return target.write(...writeArgs); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
    }, stat: async (file, options) => file === state.freezeFile && options?.bigint ? state.frozenStat : fsp.stat(file, options) };
  const shared = loadWorkDataJournals({ io });
  shared.WorkDataStore.Hooks.keys = { snapshot: async () => {
    state.acquires++; if (state.keyError) throw state.keyError;
    const key = Buffer.from(master); return { key, instanceId: state.instance || 'a'.repeat(32), release() { state.releases++; key.fill(0); } };
  } };
  const journals = { ...shared.WorkDataJournals, create(host) {
    const journal = shared.WorkDataJournals.create(host);
    return { ...journal, append: async (rows, ...args) => { state.appendBatches.push(rows.map(row => Buffer.byteLength(row))); return journal.append(rows, ...args); } };
  } };
  const context = vm.createContext({ ...shared, WorkDataJournals: journals, require, Buffer, crypto, fs, fsp: io, path, Date, Set,
    paths: { logs, data: dir, config: configFile }, configMutateChain: Promise.resolve(), configWriteChain: Promise.resolve(), configReadGeneration: 0, configDegraded: false, process: { stderr: { write: value => state.diagnostics.push(value) } },
    readConfig: async () => { throw Error('audit must not enter config recovery'); },
    normalizeConfig: raw => ({ config: { workDataEncryptionV1: false, privacyPolicyRecoveryRequiredV1: false, ...raw } }),
    nowIso: () => state.now, safeJsonParse: (raw, fallback) => { try { return JSON.parse(String(raw).replace(/^\uFEFF/, '')); } catch { return fallback; } }, redact: value => value });
  const runtime = source('04-permission-runtime.js');
  const logCode = sliceBlock(runtime, 'const auditLogContext =', '// --- Active claude child'); assert.ok(logCode.length > 3000);
  const provider = source('06-provider-engine.js');
  const api = vm.runInContext(logCode + '\n' + constBlock(provider, 'AUDIT_SUMMARY_MAP') + '\n' + ['auditSummaryFor', 'readWorkbenchAudit', 'buildOpsMetrics', 'sweepLogsStore'].map(name => functionBlock(provider, name)).join('\n') +
    '\n({logEvent,flushWorkbenchLogs,readLogTailSnapshot,readWorkbenchLogFile,workbenchAuditJournal,recoverWorkbenchAudit,readWorkbenchAudit,buildOpsMetrics,sweepLogsStore})', context);
  return { dir, logs, state, master, api, shared, context, file: day => path.join(logs, `workbench-${day || state.now.slice(0, 10)}.ndjson`) };
}
module.exports = { auditFixture };
