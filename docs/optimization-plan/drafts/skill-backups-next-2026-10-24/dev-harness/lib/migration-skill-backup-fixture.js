'use strict';
// Real owner, broker, crypto, archive codec and atomic writer. Only keys, the
// external discovery list and explicit storage/crash seams belong to the fixture.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { constBlock, functionBlock } = require('./source-slice');
const { loadWorkDataChunks } = require('./work-data-chunks-fixture');
const sourceRoot = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const source = name => fs.readFileSync(path.join(sourceRoot, name), 'utf8');

function createMigrationSkillBackupFixture(parent, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(parent, 'case-'));
  const paths = { data: dir, skills: path.join(dir, 'skills') };
  const state = { enabled: true, missing: false, instance: 'skill-backup-unit', acquires: 0, releases: 0, rows: [], ...overrides };
  const master = crypto.randomBytes(32);
  const fx = loadWorkDataChunks();
  fx.store.Hooks.keys = { snapshot: async () => {
    state.acquires++;
    if (state.missing) throw Object.assign(new Error('work_data_key.absent'), { code: 'work_data_key.absent', apiCode: 'work_data_key.absent', statusCode: 503 });
    const key = Buffer.from(master);
    return { key, instanceId: state.instance, release: async () => { state.releases++; key.fill(0); } };
  } };
  const context = {
    require, Buffer, process, console, crypto, fs, fsp, path, paths, WorkDataStore: fx.store,
    os: { homedir: () => path.join(dir, 'home') },
    SKILL_ID_RE: /^[A-Za-z0-9_-]{1,64}$/, MigrationHooks: {}, VERSION: 'unit',
    safeJsonParse: (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } },
    readConfig: async () => ({ workDataEncryptionV1: state.enabled }),
    atomicWriteJson: async (...args) => {
      if (state.failLog && /^\d.*\.json$/.test(path.basename(args[0]))) throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      if (state.failStorage) throw state.failStorage;
      return fx.atomicWriteJson(...args);
    },
    samePathKey: file => path.resolve(file).toLowerCase(), nowIso: () => new Date().toISOString(),
    tildePath: file => file, externalRoot: () => dir, logEvent: () => {}, __state: state,
    getCapabilities: async () => { if (state.capabilityGate) await state.capabilityGate(); return null; },
    claudePluginSkillDirs: async () => [], agentCliHomes: () => ({ kimi: path.join(dir, 'kimi'), codex: path.join(dir, 'codex') }),
    readSkillDir: async (base, source) => {
      if (source !== 'user') return new Map();
      if (state.skillReadGate) await state.skillReadGate();
      const entries = new Map();
      for (const name of await fsp.readdir(base).catch(() => [])) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) continue;
        entries.set(name, { id: name, name, kind: 'skill', source: 'user', dir: path.join(base, name) });
      }
      return entries;
    },
    loadAllPlaybooks: async () => [], effectiveSkillSelection: session => session?.skills || [],
    normalizeCwd: value => value || '', realpathForContainment: file => fsp.realpath(file),
  };
  const tool = source('12-tool-dispatch.js');
  const helpers = ['skillImportRecordStore', 'writeSkillImportRecord', 'readSkillImportRecord', 'loadSkillRegistry', 'readEnabledSkill'];
  let migration = source('13u-migration-center.js');
  if (typeof overrides.nativeSourceTransform === 'function') migration = overrides.nativeSourceTransform(migration);
  const names = ['migrationCopyOneSkill', 'migrationCopySkills', 'migrationUndo', 'migrationUndoSkillCopy', 'migrationSkillTree',
    'migrationTreeHash', 'migrationRecoverSkillBackups', 'migrationCapsuleDescriptor', 'migrationCapsuleArchive', 'migrationCapsuleRead',
    'migrationCapsuleDecode', 'migrationCapsuleShape', 'migrationCapsuleIntent', 'migrationCapsuleWriteIntent', 'migrationCapsulePresent',
    'migrationCapsulePrepare', 'migrationCapsuleBroker', 'migrationCapsuleCapture', 'migrationCapsuleFingerprint',
    'migrationCapsuleRestore', 'migrationCapsuleAssertTree', 'migrationCapsuleVerifyReady'];
  const code = constBlock(tool, 'SKILL_IMPORT_RECORD') + '\n' + constBlock(tool, 'SKILL_IMPORT_SOURCES') + '\n'
    + helpers.map(name => functionBlock(tool, name)).join('\n') + '\n' + migration
    + '\nmigrationSkillRows = async () => __state.rows;\n({ ' + [...helpers, ...names].join(',') + ', hooks: MigrationHooks });';
  const api = vm.runInNewContext(code, context);
  const skill = (id, files = { 'SKILL.md': '# ORIGINAL PRIVATE NAME\n', 'sub/binary.bin': Buffer.from([0, 255, 13, 10, 128, 42]) }) => {
    const root = path.join(paths.skills, id);
    fs.mkdirSync(root, { recursive: true });
    for (const [relative, bytes] of Object.entries(files)) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    return root;
  };
  const row = (id = 'one') => {
    const root = path.join(dir, 'external', id);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'SKILL.md'), '# REPLACEMENT\n');
    return { id, key: 'codex:' + id, _dir: root, source: 'codex', plugin: '', status: 'source-updated' };
  };
  const replace = (name, replacement) => { context.__replacement = replacement; vm.runInNewContext(name + ' = __replacement;', context); delete context.__replacement; };
  return { dir, paths, state, master, fx, api, context, skill, row, replace,
    backup: (stamp = '2026-10-23T00-00-00-000Z', id = 'one') => path.join(dir, 'migrations', 'skill-backups', stamp, id),
    close: () => master.fill(0) };
}
module.exports = { createMigrationSkillBackupFixture, source };
