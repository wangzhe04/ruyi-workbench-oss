'use strict';
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), vm = require('node:vm'), assert = require('node:assert/strict'), { EventEmitter } = require('node:events');
const { loadWorkDataJournals } = require('./work-data-journals-fixture');
const { functionBlock } = require('./source-slice');
function backgroundLedgerFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ledger-source-'));
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const state = { enabled: false, acquires: 0, releases: 0, diagnostics: [], events: [], renames: 0 };
  const io = { ...fsp, rename: async (...args) => {
    state.renames++;
    if (state.onRename) await state.onRename(...args);
    if (state.failRename) throw Object.assign(Error('SECRET DISK FAILURE'), { code: 'EIO' });
    return fsp.rename(...args);
  } };
  const shared = loadWorkDataJournals({ io }), master = crypto.randomBytes(32);
  shared.WorkDataStore.Hooks.keys = { snapshot: async () => {
    state.acquires++; if (state.keyError) throw state.keyError;
    const key = Buffer.from(master);
    return { key, instanceId: state.instance || 'ledger-unit-instance', release() { key.fill(0); state.releases++; } };
  } };
  const events = new EventEmitter(); events.on('background.completed', value => state.events.push(value));
  const sessionPath = id => path.join(root, id + '.json');
  const context = vm.createContext({ ...shared, fs, fsp: io, path, crypto, Buffer, Map, Set, Promise, process, setTimeout,
    paths: { sessions: root }, safeSessionId: id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : null,
    sessionPath, readConfig: async () => {
      if (state.onConfig) await state.onConfig();
      return { workDataEncryptionV1: state.enabled, privacyPolicyRecoveryRequiredV1: state.degraded };
    }, safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
    logEvent: event => state.diagnostics.push(event), activeChildren: new Map(), activeAgentRuns: new Map(),
    sessionDeleteTombstones: new Map(), EventStreamHooks: {}, RUYI_EVENTS: events,
    nowIso: () => '2026-10-24T12:00:00.000Z', neutralizeInjectedPrefixes: value => value, MAIL_TEXT_MAX: 6000 });
  const source = file => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', file), 'utf8');
  const code = functionBlock(source('00-boot.js'), 'runKeyedChain') + '\n'
    + functionBlock(source('01-config.js'), 'atomicWriteJson') + '\n'
    + source('11-native-tools.js').split('function shellIdValid')[0];
  const api = vm.runInContext(code + '\n({readBackgroundJobs,persistBackgroundJob,completeBackgroundJob,backgroundJobFile,backgroundJobChains,withBackgroundJobOperation,EventStreamHooks,activeChildren,activeAgentRuns,sessionDeleteTombstones})', context);
  const session = (id = 'sess_ledger') => { fs.writeFileSync(sessionPath(id), '{}'); return { id, messages: [], providerHistory: [] }; };
  return { api, state, master, root, context, session, file: id => api.backgroundJobFile(id || 'sess_ledger') };
}
module.exports = { backgroundLedgerFixture };
