'use strict';

// Offline regression for Claude CLI native resume recovery:
//   A) an existing --resume target disappears -> retry the same logical turn once without duplicating it;
//   B) model switch -> proactively detach the old native transcript;
//   C) cwd switch -> proactively detach because Claude stores transcripts in cwd-scoped project buckets.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-claude-resume-recovery');
const WS_A = path.join(HOME, 'workspace-a');
const WS_B = path.join(HOME, 'workspace-b');
const FAKE = path.join(HOME, 'fake-resume-cli.js');
const INVOCATIONS = path.join(HOME, 'invocations.ndjson');
const MISS_MARKER = path.join(HOME, 'resume-missed.once');
const COUNTER = path.join(HOME, 'counter.txt');
let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures++; console.error('FAIL ' + label); }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function stop(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {}
}
function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function waitHealth(port) {
  for (let i = 0; i < 60; i++) { const h = await health(port); if (h) return h; await sleep(100); }
  return null;
}
function stream(port, body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
    }, res => {
      let buf = ''; const events = [];
      res.on('data', chunk => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          try { if (line.trim()) events.push(JSON.parse(line)); } catch {}
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}
function getSession(port, id) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/sessions/' + encodeURIComponent(id), timeout: 3000 }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => { try { resolve(JSON.parse(body).session); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}
function patchSessionRoute(port, id, route) {
  const raw = JSON.stringify({ engineRoute: route });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/sessions/' + encodeURIComponent(id), method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-http-method': 'PATCH' } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}
function invocations() {
  if (!fs.existsSync(INVOCATIONS)) return [];
  return fs.readFileSync(INVOCATIONS, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

(async () => {
  const port = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WS_A, { recursive: true });
  fs.mkdirSync(WS_B, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 9,
    activeProvider: '',
    defaultWorkspace: WS_A,
    permissionMode: 'bypass',
    engineMode: 'interactive',
    includePartialMessages: false,
    autoResumeClaudeSessions: true,
    model: 'model-a',
  }, null, 2));
  fs.writeFileSync(FAKE, `#!/usr/bin/env node
'use strict';
const fs=require('fs');
const args=process.argv.slice(2);
fs.appendFileSync(process.env.RESUME_INVOCATIONS,JSON.stringify({args,cwd:process.cwd()})+'\\n');
if(args.includes('--resume')&&!fs.existsSync(process.env.RESUME_MISS_MARKER)){
  fs.writeFileSync(process.env.RESUME_MISS_MARKER,'1');
  process.stderr.write('No conversation found with session ID: fake-session-0001\\n');
  process.exit(1);
}
let n=Number(fs.existsSync(process.env.RESUME_COUNTER)?fs.readFileSync(process.env.RESUME_COUNTER,'utf8'):0)+1;
fs.writeFileSync(process.env.RESUME_COUNTER,String(n));
const sid='fake-session-'+String(n).padStart(4,'0');
let started=false;
process.stdin.on('data',()=>{
  if(started)return;started=true;
  const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');
  emit({type:'system',subtype:'init',session_id:sid,tools:[],model:'fake'});
  emit({type:'assistant',session_id:sid,message:{role:'assistant',content:[{type:'text',text:'ok-'+n}]}});
  emit({type:'result',subtype:'success',is_error:false,result:'ok-'+n,session_id:sid,duration_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});
  setTimeout(()=>process.exit(0),10);
});
`);

  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB,
    env: {
      ...process.env,
      RUYI_HOME: HOME,
      WCW_FAKE_CLAUDE: FAKE,
      RESUME_INVOCATIONS: INVOCATIONS,
      RESUME_MISS_MARKER: MISS_MARKER,
      RESUME_COUNTER: COUNTER,
    },
    windowsHide: true,
  });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(line => line.trim() && console.error('[workbench] ' + line.trim())));
  try {
    ok(!!(await waitHealth(port)), 'workbench starts');

    const first = await stream(port, { message: 'first', cwd: WS_A });
    const sid = (first.find(e => e.type === 'session') || {}).session?.id;
    ok(!!sid && first.some(e => e.type === 'result' && e.ok === true), 'initial Claude turn succeeds');
    const afterFirst = await getSession(port, sid);
    ok(afterFirst.claudeSessionId === 'fake-session-0001', 'initial native session binding persisted');

    const second = await stream(port, { sessionId: sid, message: 'second', cwd: WS_A });
    const afterSecond = await getSession(port, sid);
    const callsAfterSecond = invocations();
    ok(callsAfterSecond.length === 3, 'missing transcript causes exactly one automatic retry');
    ok(callsAfterSecond[1].args.includes('--resume') && !callsAfterSecond[2].args.includes('--resume'), 'retry removes the stale --resume argument');
    ok(second.some(e => e.type === 'resume_recovery' && e.reason === 'transcript-missing'), 'stream reports automatic transcript recovery');
    ok(second.some(e => e.type === 'result' && e.ok === true), 'retried logical turn succeeds');
    ok(afterSecond.turnSeq === 2 && afterSecond.messages.filter(m => m.role === 'user').length === 2, 'retry does not duplicate user message or turn sequence');
    ok(afterSecond.claudeSessionId === 'fake-session-0002', 'retry binds the fresh native session id');

    const cfgPath = path.join(HOME, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.model = 'model-b';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    // 109b905 protocol: model changes are pinned per-session (engineRoute); re-pin explicitly.
    await patchSessionRoute(port, sid, { engine: 'agent', agentCliType: 'claude', model: 'model-b' });
    const third = await stream(port, { sessionId: sid, message: 'third', cwd: WS_A });
    const thirdMeta = third.find(e => e.type === 'meta');
    const callsAfterThird = invocations();
    ok(thirdMeta && thirdMeta.resumeResetReason === 'model-changed', 'model switch proactively resets the native binding');
    ok(!callsAfterThird.at(-1).args.includes('--resume') && third.some(e => e.type === 'result' && e.ok === true), 'model-switch turn starts fresh and succeeds');

    const fourth = await stream(port, { sessionId: sid, message: 'fourth', cwd: WS_B });
    const fourthMeta = fourth.find(e => e.type === 'meta');
    const callsAfterFourth = invocations();
    ok(fourthMeta && fourthMeta.resumeResetReason === 'cwd-changed', 'working-directory switch proactively resets the cwd-scoped binding');
    ok(callsAfterFourth.at(-1).cwd === WS_B && !callsAfterFourth.at(-1).args.includes('--resume'), 'cwd-switch turn runs in the new workspace without stale resume');
    ok(fourth.some(e => e.type === 'result' && e.ok === true), 'cwd-switch turn succeeds');
  } catch (err) {
    failures++;
    console.error(err && err.stack || err);
  } finally {
    stop(wb);
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nCLAUDE RESUME RECOVERY E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(err => { console.error(err && err.stack || err); process.exitCode = 1; });
