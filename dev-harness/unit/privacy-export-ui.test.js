'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/privacy-export.js'), 'utf8');
function fixture(respond) {
  const state = { currentSession: { id: 'session-one' }, config: { privacyModeV1: 'enhanced' } }, downloads = [], blobs = [], notices = [], calls = [];
  const api = async (route, options) => { const body = JSON.parse(options.body); calls.push(body); return respond(body, state, calls); };
  const run = vm.runInNewContext(source.replace(/^import .*;\r?\n/gm, '').replace('export async function', 'async function') + '\ndownloadPrivacyExport', {
    api, apiErrorInfo: error => ({ code: error.code || '' }), state, Blob, URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:export-' + blobs.length; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() { downloads.push({ href: this.href, filename: this.download }); } }) },
    t: key => key, toast: (...args) => notices.push(args), setTimeout: fn => { fn(); },
  });
  return { run, state, downloads, blobs, notices, calls };
}
const artifact = (content = 'protected final bytes') => ({ ok: true, content, filename: 'protected.json', mime: 'application/json', protected: true, proof: 'proof-one', hash: 'hash-one' });
test('one default action downloads exact prepared bytes after validation without dialogs', async () => {
  const f = fixture(body => body.op === 'validate' ? { ok: true } : artifact());
  await f.run({ kind: 'session', format: 'json', sessionId: 'session-one' });
  assert.equal(f.downloads.length, 1); assert.equal(f.calls.length, 2);
  assert.equal(await f.blobs[0].text(), 'protected final bytes');
  assert.equal(f.downloads[0].filename, 'protected.json');
  assert.equal(f.calls[0].plaintext, undefined);
});
test('parallel learning transparently rebuilds the Blob from refreshed actual bytes', async () => {
  let validations = 0;
  const f = fixture(body => body.op !== 'validate' ? artifact('first') : ++validations === 1 ? { ...artifact('refreshed'), proof: 'proof-two', hash: 'hash-two' } : { ok: true });
  await f.run({ kind: 'memory' });
  assert.equal(f.downloads.length, 1); assert.equal(f.blobs.length, 2);
  assert.equal(await f.blobs[1].text(), 'refreshed'); assert.equal(f.calls[2].proof, 'proof-two');
});
test('known settings, active-source or same-session content changes during validation prevent download', async () => {
  for (const change of [state => { state.config.privacyModeV1 = 'strict'; }, state => { state.currentSession.id = 'session-two'; }, state => { state.currentSession.messages = [{ role: 'user', content: 'edited same session' }]; }]) {
    const f = fixture((body, state) => { if (body.op === 'validate') { change(state); return { ok: true }; } return artifact(); });
    assert.equal(await f.run({ kind: 'session' }), null); assert.equal(f.downloads.length, 0);
    assert.match(f.notices[0][0], /privacy.export.failed/);
  }
});
test('explicit plaintext is sent for one action and does not become a preference', async () => {
  const f = fixture(body => body.op === 'validate' ? { ok: true } : artifact());
  await f.run({ kind: 'session', plaintext: true }); await f.run({ kind: 'session' });
  assert.equal(f.calls[0].plaintext, true); assert.equal(f.calls[2].plaintext, undefined);
  assert.deepEqual(f.state.config, { privacyModeV1: 'enhanced' });
});
