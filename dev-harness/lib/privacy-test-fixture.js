const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { constBlock } = require('./source-slice');
const read = name => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', name), 'utf8');
const source = read('01i-privacy-rules.js') + '\n' + read('01h-privacy-core.js') + '\n' + read('01m-privacy-regex.js') + '\n' + constBlock(read('01k-credential-vault.js'), 'CredentialVault') + '\n' + constBlock(read('01l-credential-recovery.js'), 'CredentialRecovery');
const primitives = vm.runInNewContext(source + '\n({PrivacyCore,PrivacyRegex,CredentialVault,CredentialRecovery})', { require, Buffer, URL, structuredClone, setTimeout, clearTimeout });
const clone = value => structuredClone(value);
function fixture() {
  let state = primitives.CredentialVault.empty(), serial = 0;
  const host = { core: primitives.PrivacyCore, size: async () => Buffer.byteLength(JSON.stringify(state)), supportedDefault: () => true,
    store: { read: async () => clone(state), write: async value => { state = clone(value); serial++; }, invalidate() {} },
    protector: { supported: () => true, run: async (op, value) => Buffer.from(value) },
    stamp: async () => String(serial) };
  return { ...primitives, vault: primitives.CredentialVault.create(host), restartVault: () => primitives.CredentialVault.create(host), state: () => clone(state) };
}
function gateway(root, f) {
  return vm.runInNewContext(read('03a-privacy-gateway.js') + '\nPrivacyGateway.setHost({ data: paths.data, makeStore: file => ({ read: async () => JSON.parse(await fsp.readFile(file, "utf8")), write: value => atomicWriteJson(file, value) }) }); PrivacyGateway', {
    require, Buffer, structuredClone, URL, PrivacyRegex: f.PrivacyRegex, PrivacyCore: { ...f.PrivacyCore, configHooks: { sealLocal: f.vault.sealLocal, openLocal: f.vault.openLocal } },
    fsp: fs.promises, path, paths: { data: root }, atomicWriteJson: async (file, value) => { await fs.promises.writeFile(file, JSON.stringify(value)); },
  });
}
module.exports = { fixture, gateway, clone };
