'use strict';
// Test-only lossless recovery of an isolated malformed-config backup. Never logs recovered contents.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
async function recoverCorruptBackup(data, name = 'config.json.corrupt') {
  const read = file => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', file), 'utf8');
  const context = vm.createContext({ require, Buffer, TextDecoder, process, setTimeout, clearTimeout });
  const api = vm.runInContext(read('01h-privacy-core.js') + '\n' + read('01j-local-crypto.js') + '\n({core:PrivacyCore,dpapi:LocalSecretCrypto});', context);
  const backup = JSON.parse(fs.readFileSync(path.join(data, name), 'utf8'));
  const state = JSON.parse(fs.readFileSync(path.join(data, 'credential-vault-v1.json'), 'utf8'));
  const key = await api.dpapi.run('unprotect', Buffer.from(state.protectedKey, 'base64'), Buffer.from('ruyi.credential-vault.v1:' + state.instanceId));
  try { return api.core.open(backup.envelope, key, { instanceId: state.instanceId, recordId: 'backup-' + crypto.createHash('sha256').update(name).digest('hex'), purpose: 'config-backup' }, 'master-v1'); }
  finally { key.fill(0); }
}
module.exports = { recoverCorruptBackup };
async function createConfigRecoveryReader(data) {
  const vaultFile = path.join(data, 'credential-vault-v1.json');
  if (!fs.existsSync(vaultFile)) return { recover: value => value, close() {} };
  const read = file => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', file), 'utf8');
  const context = vm.createContext({ require, Buffer, TextDecoder, process, setTimeout, clearTimeout });
  const api = vm.runInContext(read('01h-privacy-core.js') + '\n' + read('01j-local-crypto.js') + '\n({core:PrivacyCore,dpapi:LocalSecretCrypto});', context);
  const first = JSON.parse(fs.readFileSync(vaultFile, 'utf8'));
  const key = await api.dpapi.run('unprotect', Buffer.from(first.protectedKey, 'base64'), Buffer.from('ruyi.credential-vault.v1:' + first.instanceId));
  function recover(raw) {
    if (!raw?.credentialRefsV1) return raw;
    const state = JSON.parse(fs.readFileSync(vaultFile, 'utf8')), config = structuredClone(raw);
    for (const ref of config.credentialRefsV1.slots) {
      const record = state.records.find(row => row.id === ref.id);
      const value = JSON.parse(api.core.open(record.envelope, key, { instanceId: state.instanceId, recordId: record.id, purpose: 'credential' }, 'master-v1'));
      const parts = ref.pointer.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
      let parent = config; for (const part of parts.slice(0, -1)) parent = parent[part]; parent[parts.at(-1)] = value;
    }
    delete config.credentialRefsV1; return config;
  }
  // Only test assertions use this reader. Production owner binding/permissions are tested via the app.
  return { recover, close: () => key.fill(0) };
}
module.exports.createConfigRecoveryReader = createConfigRecoveryReader;
