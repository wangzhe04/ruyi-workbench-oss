'use strict';
require('./lib/self-isolate-home.js');
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port');
const { killOwnTree } = require('./lib/kill-own-tree');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-background-push-'));
  const port = await getFreePort();
  const events = [];
  let token = '', child, sse;
  function request(method, url, body) {
    return new Promise((resolve, reject) => {
      const raw = body == null ? '' : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port, path: url, method, timeout: 30000,
        headers: { 'x-wcw-token': token, 'content-type': 'application/json', ...(raw ? { 'content-length': Buffer.byteLength(raw) } : {}) } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; });
        res.on('end', () => { try { resolve(JSON.parse(text)); } catch { resolve(text); } });
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('request timeout')));
      req.end(raw);
    });
  }
  async function completion(jobId) {
    // Test-side event wait, NOT shell_poll or model requests.
    for (let i = 0; i < 300; i++) {
      const event = events.find(e => e.jobId === jobId);
      if (event) return event;
      await sleep(100);
    }
    throw new Error('completion push missing for ' + jobId);
  }
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'bypass', defaultWorkspace: root,
      desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [] }));
    child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
      cwd: path.resolve(__dirname, '../ruyi-workbench'), windowsHide: true, env: { ...process.env, RUYI_HOME: root }, stdio: 'ignore',
    });
    let up = false;
    for (let i = 0; i < 300; i++) { try { if (await request('GET', '/health')) { up = true; break; } } catch {} await sleep(100); }
    assert(up, 'server ready');
    const html = await request('GET', '/');
    token = (String(html).match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
    const session = (await request('POST', '/api/sessions', { title: 'background push', cwd: root })).session;
    assert(session?.id);
    const other = (await request('POST', '/api/sessions', { title: 'unrelated', cwd: root })).session;
    await new Promise((resolve, reject) => {
      sse = http.get({ host: '127.0.0.1', port, path: '/api/events/stream?lens=classic&sessionId=' + session.id, headers: { 'x-wcw-token': token } }, res => {
        assert.equal(res.statusCode, 200);
        let buffer = '';
        res.on('data', chunk => {
          buffer += chunk;
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            if (block.includes('event: presence.ack')) resolve();
            if (block.includes('event: background.completed')) {
              const line = block.split('\n').find(l => l.startsWith('data: '));
              if (line) events.push(JSON.parse(line.slice(6)));
            }
          }
        });
      });
      sse.on('error', reject);
    });
    const start = async (command, extra = {}) => {
      const response = await request('POST', '/api/tools/shell_start', { sessionId: session.id, cwd: root, command, ...extra });
      assert.equal(response.result?.ok, true, JSON.stringify(response));
      assert.equal(response.result.notification, 'session_push');
      return response.result;
    };
    const success = await start('Start-Sleep -Seconds 2; Write-Output BACKGROUND_RESULT');
    assert.equal(success.running, true, 'returns while command is alive');
    const notice = await completion(success.jobId);
    assert.equal(notice.status, 'succeeded');
    assert.equal(notice.sessionId, session.id);
    assert(!JSON.stringify(notice).includes('BACKGROUND_RESULT'), 'global bus carries no tool output');
    const loaded = (await request('GET', '/api/sessions/' + session.id)).session;
    assert.equal(loaded.messages.filter(m => m.backgroundJobId === success.jobId).length, 1);
    assert(loaded.messages.some(m => /BACKGROUND_RESULT/.test(m.content || '')));
    const unrelated = (await request('GET', '/api/sessions/' + other.id)).session;
    assert(!unrelated.messages.some(m => m.backgroundJobId), 'no cross-session result leak');
    const failed = await start('throw "BACKGROUND_FAILURE"');
    assert.equal((await completion(failed.jobId)).status, 'failed');
    const timed = await start('Start-Sleep -Seconds 30', { timeoutMs: 1000 });
    assert.equal((await completion(timed.jobId)).status, 'timed_out');
    const cancel = await start('Start-Sleep -Seconds 30');
    await request('POST', '/api/tools/shell_kill', { sessionId: session.id, shellId: cancel.shellId });
    assert.equal((await completion(cancel.jobId)).status, 'cancelled');
    assert.equal(events.filter(e => e.jobId === cancel.jobId).length, 1);
    const final = (await request('GET', '/api/sessions/' + session.id)).session;
    assert.equal(final.messages.filter(m => m.backgroundJobId).length, 4, 'all terminal receipts survive reload without polling');
    console.log('BACKGROUND COMPLETION PUSH: ALL PASS (success, failure, timeout, cancel, session isolation, reload)');
  } finally {
    if (sse) sse.destroy();
    http.globalAgent.destroy();
    if (child) killOwnTree(child);
    await sleep(250);
    fs.rmSync(root, { recursive: true, force: true });
  }
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
