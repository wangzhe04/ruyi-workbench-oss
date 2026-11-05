'use strict';
// Real process: the private successor entry must reject malformed handshakes before
// touching the data root. Valid-handoff coverage is a later slice.
require('./lib/self-isolate-home');
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness'), { releaseEnvironment } = require('./lib/release-checks'), { getFreePort } = require('./free-port');
const t = createRunner('WORK DATA SUCCESSOR HANDSHAKE'), { ok } = t;
const WB = path.resolve(__dirname, '../ruyi-workbench');
function runSuccessor({ env, input, timeoutMs = 20000 }) {
  return new Promise(resolve => {
    const child = cp.spawn(process.execPath, ['app/server.js', 'work-data-successor'], { cwd: WB, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    let out = '', err = '', settled = false;
    const done = code => { if (settled) return; settled = true; try { child.kill(); } catch {} if (code !== 0 && code !== 'timeout') console.log('[handshake-exit]', code, String(err || out).trim().split('\\n')[0]); resolve({ code, out, err }); };
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    child.stdout.on('data', chunk => { out += chunk.toString(); });
    child.stderr.on('data', chunk => { err += chunk.toString(); });
    child.on('close', code => { clearTimeout(timer); done(code); });
    child.on('error', () => { clearTimeout(timer); done('spawn-error'); });
    if (input !== undefined) child.stdin.end(JSON.stringify(input));
    else child.stdin.end();
  });
}
(async () => {
  if (process.platform !== 'win32') { console.log('SKIP Windows private successor handshake'); return; }
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ruyi-successor-handshake-')), base = path.join(root, 'data'), home = path.join(root, 'home');
  try {
    await fsp.mkdir(base, { recursive: true });
    await fsp.writeFile(path.join(base, 'config.json'), '{"configSchema":9,"workDataEncryptionV1":false}');
    const env = releaseEnvironment(home, base);
    const port = await getFreePort();
    const expectedAuthority = { generation: 0, id: null, mode: 'plain', sha256: null };
    const common = { schema: 1, id: 'a'.repeat(24), parentPid: process.pid, base, serve: { port, host: '127.0.0.1' }, expectedAuthority };

    const empty = await runSuccessor({ env, input: undefined });
    ok(empty.code === 1 && /successor|work_data/i.test(empty.err + empty.out), 'an empty handshake is rejected without hanging');

    const badNonce = await runSuccessor({ env, input: { ...common, nonce: 'not-hex' } });
    ok(badNonce.code === 1 && /successor|work_data/i.test(badNonce.err + badNonce.out), 'a malformed nonce is rejected before any handoff');

    const staleAuthority = await runSuccessor({ env, input: { ...common, nonce: 'b'.repeat(32), expectedAuthority: { generation: 9, id: 'c'.repeat(48), mode: 'plain', sha256: null } } });
    ok(staleAuthority.code === 1 && /successor|work_data/i.test(staleAuthority.err + staleAuthority.out), 'a stale expected authority is rejected');

    const extra = await runSuccessor({ env, input: { ...common, nonce: 'd'.repeat(32), activation: { kind: 'separate-fresh-root', resultSha256: 'e'.repeat(64) } } });
    ok(extra.code === 1 && /successor|work_data/i.test(extra.err + extra.out), 'an activation receipt without a fresh-root restore is rejected');

    ok(fs.existsSync(path.join(base, 'work-data-key-v1.json')) === false, 'no key material was created by rejected handshakes');
    ok(fs.existsSync(path.join(base, '.work-data', 'active-v1.json')) === false, 'no active generation was published by rejected handshakes');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
})().catch(error => t.fail(error.stack || String(error))).finally(() => t.done({ exit: true }));
