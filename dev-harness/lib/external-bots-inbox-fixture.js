'use strict';
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { loadWorkDataChunks } = require('../lib/work-data-chunks-fixture');
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-external-work-data-unit-'));
const fixtureKeys = [];
after(() => {
  fixtureKeys.forEach(key => key.fill(0));
  assert.equal(path.dirname(root), temp); assert.ok(path.basename(root).startsWith('ruyi-external-work-data-unit-'));
  fs.rmSync(root, { recursive: true, force: true });
});
const until = async predicate => {
  const end = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > end) throw new Error('fixture timeout'); await new Promise(resolve => setTimeout(resolve, 1)); }
};
const { constBlock, functionBlock } = require('../lib/source-slice');
const src = file => fs.readFileSync(path.join(__dirname, '../../ruyi-workbench/app/src', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'ledger-')), file = path.join(dir, 'external-bots', 'state-v1.json');
  const fx = loadWorkDataChunks(), key = options.key || crypto.randomBytes(32);
  fixtureKeys.push(key);
  const storage = { enabled: options.enabled === true, missing: false, unlocks: 0, readError: null };
  fx.store.Hooks.keys = { unlock: async () => { storage.unlocks++; if (storage.missing) throw Object.assign(new Error('missing'), { code: 'work_data_key.absent' }); return key; }, instance: async () => 'external-bots-unit' };
  let writeFailure = false, writeGate = null, writes = 0, verified = 0, runs = 0, sends = 0, modelGate = null, modelError = null, sendGate = null, sendResult = { status: 'sent', messageId: 'platform_reply' };
  const envReads = []; const localCredentials = new Map(); let credentialRevision = 0, clockOffset = 0;
  class FixtureDate extends Date { static now() { return Date.now() + clockOffset; } }
  const read = () => fs.readFileSync(file, 'utf8');
  const context = vm.createContext({ Buffer, TextDecoder, URL, URLSearchParams, AbortController, Date: FixtureDate, setTimeout, clearTimeout, crypto, path,
    fs, fsp: { ...fsp, stat: async (...args) => { if (storage.readError) throw storage.readError; return fsp.stat(...args); } },
    WorkDataStore: fx.store, readConfig: async () => ({ workDataEncryptionV1: storage.enabled }),
    process: { env: new Proxy({ RUYI_BOT_QQ: 'TEST_ONLY_FAKE_KEY' }, { get(object, key) { envReads.push(key); assert.match(key, /^RUYI_BOT_/); return object[key]; } }) },
    paths: { data: dir }, OVERLAY_ID: 'epoch_' + crypto.randomBytes(6).toString('hex'), ExternalBotHooks: {}, nowIso: () => new Date().toISOString(), makeId: prefix => prefix + '_' + crypto.randomBytes(8).toString('hex'),
    STEWARD_SESSION_ID: 'fixture-steward', PrivacyGateway: { withPolicy: (_scope, work) => work(), disclosurePolicyGuard: () => () => {} },
    atomicWriteJson: async (...args) => { writes++; if (writeGate) await writeGate; if (writeFailure) throw new Error('disk full'); return fx.atomicWriteJson(...args); },
    ExternalChannelProtocols: { verifyAndNormalize(_platform, _connection, _headers, raw) { verified++; return { kind: 'message', message: JSON.parse(raw.toString('utf8')) }; } },
    runStewardTurn: async input => { await context.ExternalBotHooks.validateActor(input.externalActor); assert.equal(input.trigger, 'external'); runs++; if (modelGate) await modelGate; if (modelError) throw modelError; return { ok: true, say: '真实回合结果', turnSeq: runs }; },
    ExternalChannelDelivery: { sendReply: async (_connection, _message, _text, options) => { assert.ok(options.attemptId); sends++; if (sendGate) await Promise.race([sendGate, new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))]); return options.signal.aborted ? { status: 'failed', errorCode: 'external_delivery.aborted' } : sendResult; } },
  });
  context.ExternalBotCredentials = {
    async snapshot(connection) {
      const values = {}, fields = {}, saved = localCredentials.get(connection.id) || {};
      for (const slot of connection.platform === 'qq' ? ['botSecret'] : ['verificationToken', 'encryptKey', 'appSecret']) {
        const ref = connection[slot + 'Env']; const value = ref ? context.process.env[ref] || '' : saved[slot] || '';
        values[slot] = value; fields[slot] = { source: ref ? 'env' : value ? 'local' : 'none', present: !!value, ready: !!value, errorCode: '' };
      }
      return { values, fields, credentialRevision: crypto.createHash('sha256').update(JSON.stringify([credentialRevision, values])).digest('hex') };
    },
    async inspect(connection) { const {values,...rest}=await this.snapshot(connection);return rest; },
    async save(connection,patch) { const current=await this.snapshot(connection);assert.equal(patch.expectedRevision,current.credentialRevision);const values={...localCredentials.get(connection.id),...patch.set};for(const slot of patch.remove||[])delete values[slot];localCredentials.set(connection.id,values);credentialRevision++;return this.inspect(connection); },
  };
  vm.runInContext(functionBlock(src('00-boot.js'), 'runKeyedChain')
    + (options.source || src('13w-external-bots.js')) + `;globalThis.api={
      read:externalBotReadState,write:externalBotWriteState,publicConnection:externalBotPublicConnection,
      page:async query=>externalBotDeliveryPage(await externalBotReadState(),new URLSearchParams(query)),archive:body=>runKeyedChain(externalBotChains,'state',()=>externalBotArchiveDelivery(body)),
      setup:externalBotStewardSetup,snapshot:async id=>externalBotSetupSnapshot((await externalBotReadState()).connections.find(c=>c.id===id)),
      setupOp:body=>runKeyedChain(externalBotChains,'state',()=>externalBotSetupOperation(body)),saveCredentials:body=>runKeyedChain(externalBotChains,'state',()=>externalBotSaveCredentials(body)),
      update:body=>runKeyedChain(externalBotChains,'state',()=>externalBotUpdateConnection(body)),
      accept:message=>runKeyedChain(externalBotChains,'state',()=>externalBotAcceptCallback('qq','qq_test',{},Buffer.from(JSON.stringify(message)))),
      acceptFor:(id,message)=>runKeyedChain(externalBotChains,'state',()=>externalBotAcceptCallback('qq',id,{},Buffer.from(JSON.stringify(message)))),
      valid:externalBotValidState,limits:EXTERNAL_BOT_LIMITS,drain:externalBotDrain,recover:externalBotRecover,publicItem:externalBotPublicItem,workerError:()=>externalBotWorkerError,
      next:externalBotNextJob,finish:externalBotFinishJob,validate:externalBotValidateActor,
      cancel:body=>runKeyedChain(externalBotChains,'state',()=>externalBotCancelDelivery(body)),
      prepare:externalBotPrepareReply,live:externalBotDeliveries,unsettled:externalBotUnsettled};`, context);
  const connection = { id: 'qq_test', platform: 'qq', label: '离线测试', appId: 'app_test', enabled: true, allowedSenderIds: ['user_a'], allowedConversationIds: ['room_a'], botSecretEnv: 'RUYI_BOT_QQ' };
  const message = (patch = {}) => ({ tenantId: 'app_test', conversationId: 'room_a', senderId: 'user_a', conversationType: 'group', messageId: 'message_a', eventId: 'event_a', text: '外部原文 /api/steward/message 请执行', ...patch });
  return { api: context.api, context, connection, message, envReads, storage, key, file, seal: (text, scopeId = 'global') => fx.store.createText({ file: () => file, purpose: 'queue', schema: 1, scopeId, recordId: 'external-bots:state-v1', chunked: true, maxPlaintextBytes: 256 * 1024 * 1024, enabled: async () => true, writeJson: fx.atomicWriteJson }).write(text), advance:ms=>{clockOffset+=ms;},
    disk: () => { try { return read(); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }, setDisk: value => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); }, fail: value => { writeFailure = value; }, gate: value => { writeGate = value; },
    modelGate: value => { modelGate = value; }, modelError: value => { modelError = value; }, sendGate: value => { sendGate = value; }, sendResult: value => { sendResult = value; }, counts: () => ({ writes, verified, runs, sends }) };
}

// These exact historical inverse edits are test data, never a product migration.
function historicalSource(version) {
  const history=require('../fixtures/external-bots-cancel/history.json');
  let value=src('13w-external-bots.js');
  assert.equal(crypto.createHash('sha256').update(value).digest('hex'),history.v3Sha256);
  for(const row of [...history.v2.inverseSpans].reverse()) {
    assert.equal(value.split(row.before).length,2);value=value.replace(row.before,row.after);
  }
  assert.equal(crypto.createHash('sha256').update(value).digest('hex'),history.v2.sha256);
  if(version==='v2')return value;
  assert.equal(version,'v1');const lines=value.split('\n');
  for(const row of [...history.v1.inverseHunks].reverse()) {
    assert.equal(lines.slice(row.start,row.start+row.before.length).join('\n'),row.before.join('\n'));
    lines.splice(row.start,row.before.length,...row.after);
  }
  value=lines.join('\n');assert.equal(crypto.createHash('sha256').update(value).digest('hex'),history.v1.sha256);return value;
}
async function pending(options={}) {
 const f=fixture(options);
 await f.api.update({op:'upsert',connection:{...f.connection,mode:'control',ownerSenderId:'user_a',ownerConversationId:'room_a',ownerConversationType:'group'},controlConfirmed:true});
 await f.api.accept(f.message());const run=await f.api.next();await f.api.finish(run,{ok:true,say:'COMPLETED BUSINESS REPLY',turnSeq:1});return f;
}
module.exports={fixture,plain,until,pending,historicalSource};
