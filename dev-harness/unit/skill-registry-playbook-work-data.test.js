'use strict';
require('../lib/self-isolate-home');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { functionBlock } = require('../lib/source-slice');
const base = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(base, 'ruyi-registry-playbook-unit-'));
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const api = require('../lib/server-internals').loadServerInternals([
  'readConfig', 'writeConfig', 'saveUserPlaybook', 'WorkDataStore', 'handleApi', 'paths', 'RUNTIME',
], { withEval: true });
// Only the edited registry helper comes from current source. Its actual readers,
// Playbook store, crypto, filesystem and HTTP route retain their runtime wiring.
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/12-tool-dispatch.js'), 'utf8');
api.__eval('loadSkillRegistry = (' + functionBlock(source, 'loadSkillRegistry') + ');');
api.__eval('getCapabilities = async () => null;'); // unrelated desktop detection is outside this fixture
const registry = api.__eval('loadSkillRegistry');
const master = crypto.randomBytes(32);
let absent = false;
api.WorkDataStore.Hooks.keys = {
  snapshot: async () => {
    if (absent) throw Object.assign(Error('missing synthetic key'), { code: 'work_data_key.absent' });
    const key = Buffer.from(master);
    return { key, instanceId: 'registry-playbook-unit', release: () => key.fill(0) };
  },
};
after(() => {
  master.fill(0);
  assert.equal(path.dirname(root), base);
  fs.rmSync(root, { recursive: true, force: true });
});

test('actual sealed Playbook errors propagate through registry and GET /api/skills instead of returning an incomplete list', async () => {
  const config = await api.readConfig();
  config.workDataEncryptionV1 = true;
  await api.writeConfig(config);
  const playbook = { id: 'registry_private', title: 'Private registry fixture', promptTemplate: 'PRIVATE PLAYBOOK BODY' };
  await api.saveUserPlaybook(playbook);
  const file = path.join(api.paths.playbooks, playbook.id + '.json'), before = fs.readFileSync(file);
  assert.equal(JSON.parse(before.toString('utf8').split('\n')[0]).workData, 3);
  assert.equal(before.includes(Buffer.from(playbook.promptTemplate)), false);
  assert.ok((await registry('', config, null)).some(row => row.id === 'pb:' + playbook.id));

  const request = { method: 'GET', url: '/api/skills', headers: { host: '127.0.0.1:' + api.RUNTIME.port }, socket: { remoteAddress: '127.0.0.1' } };
  const response = () => ({
    writableEnded: false, statusCode: 0, body: '',
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = String(body); this.writableEnded = true; },
  });
  const readable = response();
  await api.handleApi(request, readable, '/api/skills');
  assert.equal(readable.statusCode, 200);
  assert.ok(JSON.parse(readable.body).skills.some(row => row.id === 'pb:' + playbook.id));

  absent = true;
  await assert.rejects(() => registry('', config, null), { code: 'work_data_key.absent' });
  const locked = response();
  await assert.rejects(() => api.handleApi(request, locked, '/api/skills'), { code: 'work_data_key.absent' });
  assert.equal(locked.writableEnded, false, 'the route must not publish an incomplete successful skills list');
  assert.deepEqual(fs.readFileSync(file), before);
});
