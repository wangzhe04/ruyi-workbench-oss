'use strict';
// 02 readInterventions 读自己的写(Windows CI kimi-agent-cli 偶发「permission_request 之后 30 s 无事件」的根因)。
// registerIntervention 把「待决」这一行【发出去不等】地排进会话写链,而待决事件在排队那一刻就推给了前端;
// 用户紧接着作答时,13d decideIntervention 从 readInterventions 读账。修前读不等写链:注册行还没落盘就判
// not_found,作答回 404 unknown or expired request,回合干等。Linux 上 append 快、几乎撞不上;这里把 append
// 人为放慢,稳定复现。
//   [W1] 注册之后立刻读:读得到这一条(修前:空);
//   [W2] 连着注册两条、立刻读:两条都在(修前:一条都没有);
//   [W3] 读盘撞 EPERM(压实 rename 那一瞬):有界重试后读到,而不是当成空。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-iv-ryw-'));
process.env.RUYI_HOME = home;
process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
const srv = require(path.join(__dirname, '..', '..', 'ruyi-workbench', 'app', 'server.js'));

const realAppend = fsp.appendFile;
const realRead = fsp.readFile;
function slowAppends(ms) {
  fsp.appendFile = async function (...args) { await new Promise(r => setTimeout(r, ms)); return realAppend.apply(this, args); };
}
function restore() { fsp.appendFile = realAppend; fsp.readFile = realRead; }

async function newSession() {
  const s = await srv.createSession({ title: 'iv ryw', cwd: home });
  return s.id;
}

test('[W1] 注册之后立刻读得到这一条(append 慢也一样)', async () => {
  const sid = await newSession();
  slowAppends(250);
  try {
    srv.registerIntervention(sid, 'permission', 'perm_w1', { toolName: 'Bash' });
    const rows = await srv.readInterventions(sid);
    const hit = rows.find(r => r && r.id === 'perm_w1');
    assert.ok(hit, 'freshly registered intervention must be readable: got ' + JSON.stringify(rows.map(r => r.id)));
    assert.equal(hit.status, 'pending');
  } finally { restore(); }
});

test('[W2] 连着注册两条、立刻读:两条都在(写链排队的每一行都等到)', async () => {
  const sid = await newSession();
  slowAppends(150);
  try {
    srv.registerIntervention(sid, 'question', 'q_w2a', {});
    srv.registerIntervention(sid, 'permission', 'perm_w2b', { toolName: 'Bash' });
    const ids = (await srv.readInterventions(sid)).map(r => r && r.id);
    assert.ok(ids.includes('q_w2a') && ids.includes('perm_w2b'), 'both queued registrations must be readable: ' + JSON.stringify(ids));
  } finally { restore(); }
});

test('[W3] 读盘撞 EPERM(压实 rename 的瞬间)时有界重试,不当成空账', async () => {
  const sid = await newSession();
  srv.registerIntervention(sid, 'plan', 'plan_w3', {});
  await srv.readInterventions(sid);   // 等写链落定
  let failures = 2;
  fsp.readFile = async function (file, ...rest) {
    if (String(file).includes(sid) && failures > 0) { failures--; const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; }
    return realRead.call(this, file, ...rest);
  };
  try {
    const rows = await srv.readInterventions(sid);
    assert.ok(rows.some(r => r && r.id === 'plan_w3'), 'transient EPERM must be retried, got ' + JSON.stringify(rows));
  } finally { restore(); }
});
