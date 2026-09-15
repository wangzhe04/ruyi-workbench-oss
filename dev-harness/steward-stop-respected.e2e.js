require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(第 125 波 P0 · 42 号文 §1 ① / §5 P0):**喊停就是喊停**。
//
// 取证(4543510):管家的确定性自理有六道闸(小时窗 / 无进展 / 自理清单 / 目标线程权限 / 续跑分级 /
// 停机),**没有一道问「这东西是不是刚被停下来的」**;而 failed 事件的默认处置就是重开 —— 班组
// retry_node、线程一句「继续」。再加上 13d 的 retry_node 只在「run 还活着」时回 409,它的另一面
// 正是「刚被停掉时恰好允许」。于是用户按下的停,会被管家撤销。
//
// 本件钉的是修后的保证(不是那条竞态本身 —— 事件从哪条路迟到进来都一样):
//   (A) 班组面:被停的班组 + 用户不在跟前 -> retry_node / resume 一律 propose_required(target_stopped);
//       收紧类 pause 不受影响;trigger:'user'(= 用户亲手按那枚按钮)不被这道闸挡;
//   (B) 线程面:末回合被停的线程 -> 自动递话 propose_required;trigger:'user' 照旧递得进去;
//   (C) 账过期不算数:头上那条 stewardLastTurn 盖不住当前回合(last.seq < head.turnSeq)-> 不拦
//       (否则一条很久以前被停过的线程会被永久挡住);
//   (D) 自己挂了 ≠ 被停下来:run.status:'failed' / lastTurn{ok:false,aborted:false} 照旧可自理重试;
//   (E) 自理预闸(13p ③b):收件箱一条 failed 事件指向被停的班组 -> 自理结果是 propose_required、
//       **没有 acted**(不白占小时窗名额)、班组快照仍是 stopped、且降级成的那枚按钮还在;
//   (F) 对照:目标没被停时,自理照旧真的动手(acted === true)—— 证明这道闸没把整条路封死。
//
// 判据全部走进程内直调(srv.toolCall / srv.runStewardTurn):这一刀改的是「动手之前问哪一句」,
// HTTP 面一个字节没动,起真服务证不了更多,反而把一件确定性夹具做成了浏览器件。
// 判定行:`STEWARD STOP RESPECTED E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-stop-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const PROVIDER_PORT = await getFreePort();
const sessionsDir = path.join(HOME, 'sessions');
const runsDir = path.join(HOME, 'agent-runs');
const configFile = path.join(HOME, 'config.json');
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(runsDir, { recursive: true });

// ── 最小 fake 管家模型:只回一句结构化的 {say,why,acts},自理动作根本不经它 ────────────────
let providerReply = JSON.stringify({ say: '看过了。', why: '总览', acts: [] });
const providerServer = http.createServer(async (req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  await new Promise(r => req.on('end', r));
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frame = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  frame({ choices: [{ index: 0, delta: { content: providerReply } }] });
  frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  frame({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

function writeConfig(patch) {
  fs.writeFileSync(configFile, JSON.stringify({
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
    permissionMode: 'auto', permissionTimeoutMs: 120000,
    includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
    subagentMaxPerTurn: 0, killOnDisconnect: false,
    stewardEnabledV1: true, stewardPollMs: 120000, stewardReadBudgetChars: 4000,
    stewardMaxTurnsPerHour: 500, stewardMaxCostPerDay: 0,
    stewardGlobalMaxTurnsPerHour: 500, stewardGlobalMaxCostPerDay: 0,
    // 117z-E2b 债 ④ 同款:缺省根读 os.homedir(),显式钉进临时 HOME,任何读 homedir 的缺省值都落不到真机。
    stewardWorkspaceRoot: path.join(HOME, 'Ruyi'),
    stewardAutoActions: { retry: true, resume: true, relay: true, newThread: false },
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    ...patch,
  }, null, 2), 'utf8');
}
writeConfig({});

// ── 进程内直调:env 四处都指向临时 HOME(与 guardrails 同一道守卫) ──────────────────────────
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
const srv = require(SERVER);
const ctxOf = trigger => ({ session: { id: 'steward', kind: 'steward', providerHistory: [] }, ...(trigger ? { trigger } : {}) });
const inbox = ctxOf('inbox');
const user = ctxOf('user');
const call = (name, args, ctx) => srv.toolCall(name, args || {}, ctx);

// 合成线程(存储 v2:头是提交点,两个正文文件必须在,否则头不可信)。
function craftThread(id, patch) {
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(sessionsDir, id + '.json'), JSON.stringify({
    id, schemaVersion: 3, storageVersion: 2, turnSeq: 2, title: '线程 ' + id, summary: '上一步在等你',
    pinned: false, cwd: HOME, createdAt: now, updatedAt: now, claudeSessionId: null, attachments: [],
    messageCount: 0, providerHistoryCount: 0, mission: null, missionId: id, kind: 'mission', ...(patch || {}),
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(sessionsDir, id + '.messages.ndjson'), '', 'utf8');
  fs.writeFileSync(path.join(sessionsDir, id + '.provider.ndjson'), '', 'utf8');
}
function craftRun(sessionId, runId, patch) {
  const dir = path.join(runsDir, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, runId + '.json'), JSON.stringify({
    schemaVersion: 4, id: runId, sessionId, status: 'stopped',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    concurrency: 2, taskPool: [], messages: [], poolPolicy: 'manual', poolAutoCap: 3,
    permissionModeAtLaunch: 'auto', metrics: { interventions: {} }, nodes: [], ...(patch || {}),
  }, null, 2), 'utf8');
}
const runStatusOf = (sessionId, runId) => {
  try { return String(JSON.parse(fs.readFileSync(path.join(runsDir, sessionId, runId + '.json'), 'utf8')).status || ''); }
  catch { return ''; }
};

// 末回合【被停】的线程(aborted:true 且这条账盖得住当前回合 seq===turnSeq)。
const SID_STOPPED = 'sess_stopped00000001';
craftThread(SID_STOPPED, { turnSeq: 3, stewardLastTurn: { seq: 3, ok: false, aborted: true, errorClass: '', at: new Date().toISOString() } });
// 末回合【自己挂了】的线程(ok:false 但 aborted:false)。
const SID_FAILED = 'sess_failed000000001';
craftThread(SID_FAILED, { turnSeq: 3, stewardLastTurn: { seq: 3, ok: false, aborted: false, errorClass: 'tool_error', at: new Date().toISOString() } });
// 账过期:被停的那一回合是 2,可线程已经跑到第 5 回合(用户自己又发过话)。
const SID_STALE = 'sess_stale0000000001';
craftThread(SID_STALE, { turnSeq: 5, stewardLastTurn: { seq: 2, ok: false, aborted: true, errorClass: '', at: new Date().toISOString() } });

craftRun(SID_FAILED, 'run_stopped', { status: 'stopped' });          // 被停的班组(线程本身没被停)
craftRun(SID_FAILED, 'run_failed', { status: 'failed' });            // 自己挂了的班组
craftRun(SID_FAILED, 'run_press', { status: 'stopped' });            // 给「用户亲手按」那一条用

let turnFail = 0;
try {
  /* ═════════ (A) 班组面:被停的班组不自动重开 ═════════ */
  console.log('── (A) 班组面 ──');
  {
    const retry = await call('steward_run_action', { sessionId: SID_FAILED, runId: 'run_stopped', action: 'retry_node', nodeId: 'n1' }, inbox);
    ok(retry && retry.ok === false && retry.error === 'propose_required' && retry.reason === 'target_stopped',
      `A1 被停的班组 + 用户不在跟前 -> retry_node 只提议(got ${retry && (retry.reason || retry.error || 'ok')})`);
    ok(retry && retry.stopped === 'run' && /被停下来/.test(String(retry.message || '')) && /按这枚按钮/.test(String(retry.message || '')),
      `A1b 拒绝理由自己说清「按钮还在」(got ${retry && JSON.stringify(retry.message || '')})`);
    ok(runStatusOf(SID_FAILED, 'run_stopped') === 'stopped', 'A1c 班组快照一个字没动(没有被重新拉起)');

    const resume = await call('steward_run_action', { sessionId: SID_FAILED, runId: 'run_stopped', action: 'resume' }, inbox);
    ok(resume && resume.error === 'propose_required' && resume.reason === 'target_stopped',
      `A2 同一道闸也挡自动续跑(且排在续跑分级之前;got ${resume && (resume.reason || resume.error || 'ok')})`);

    // 收紧类永远放行:把事情停下来比让它跑下去保守(§11.3 116c 行)。
    const pause = await call('steward_run_action', { sessionId: SID_FAILED, runId: 'run_stopped', action: 'pause' }, inbox);
    ok(pause && pause.reason !== 'target_stopped', `A3 收紧类 pause 不受这道闸约束(got ${pause && (pause.reason || pause.error || 'ok')})`);

    // 反向的反向:用户亲手按那枚按钮(trigger:'user',/api/steward/act 与 /api/steward/relay 都给它)。
    const pressed = await call('steward_run_action', { sessionId: SID_FAILED, runId: 'run_press', action: 'resume' }, user);
    ok(pressed && pressed.reason !== 'target_stopped',
      `A4 用户自己按仍然照做(这一刀是「不自动重开」,不是「不许重开」;got ${pressed && (pressed.reason || pressed.error || 'ok')})`);
  }

  /* ═════════ (B) 线程面:末回合被停就别自动递话 ═════════ */
  console.log('── (B) 线程面 ──');
  {
    const relay = await call('steward_thread_continue', { sessionId: SID_STOPPED, message: '继续' }, inbox);
    ok(relay && relay.ok === false && relay.error === 'propose_required' && relay.reason === 'target_stopped',
      `B1 末回合被停 + 用户不在跟前 -> 自动递话只提议(got ${relay && (relay.reason || relay.error || 'ok')})`);
    ok(relay && /被停下来/.test(String(relay.message || '')), 'B1b 线程面用的是线程那一句(两句各说各的)');

    const pressed = await call('steward_thread_continue', { sessionId: SID_STOPPED, message: '接着办' }, user);
    ok(pressed && pressed.reason !== 'target_stopped',
      `B2 用户自己按那枚按钮照旧递得进去(got ${pressed && (pressed.reason || pressed.error || 'ok')})`);
  }

  /* ═════════ (C) 账过期不算数 ═════════ */
  console.log('── (C) 账过期 ──');
  {
    const relay = await call('steward_thread_continue', { sessionId: SID_STALE, message: '继续' }, inbox);
    ok(relay && relay.reason !== 'target_stopped',
      `C1 头上那条账盖不住当前回合(seq 2 < turnSeq 5)-> 不拦,否则被停过一次的线程永远挡住(got ${relay && (relay.reason || relay.error || 'ok')})`);
  }

  /* ═════════ (D) 自己挂了 ≠ 被停下来 ═════════ */
  console.log('── (D) 自己挂了照旧能自理 ──');
  {
    const runRetry = await call('steward_run_action', { sessionId: SID_FAILED, runId: 'run_failed', action: 'retry_node', nodeId: 'n1' }, inbox);
    ok(runRetry && runRetry.reason !== 'target_stopped',
      `D1 班组是自己挂的(status:'failed')-> 这道闸不管(got ${runRetry && (runRetry.reason || runRetry.error || 'ok')})`);
    const relay = await call('steward_thread_continue', { sessionId: SID_FAILED, message: '继续' }, inbox);
    ok(relay && relay.reason !== 'target_stopped',
      `D2 线程末回合是自己挂的(aborted:false)-> 照旧可以自动递话(got ${relay && (relay.reason || relay.error || 'ok')})`);
  }

  /* ═════════ (E) 自理预闸:收件箱一条 failed 指向被停的班组 ═════════ */
  console.log('── (E) 自理预闸 ──');
  {
    const events = [{
      inboxSeq: 1, kind: 'failed', sessionId: SID_FAILED, missionId: SID_FAILED, runId: 'run_stopped',
      seq: 3, at: new Date().toISOString(), payload: { summary: '节点 n1 失败', nodeId: 'n1' }, count: 1,
    }];
    const reply = await srv.runStewardTurn({ trigger: 'inbox', events });
    ok(reply && reply.ok !== false, `E0 收件箱回合跑通(got ${reply && (reply.error || 'ok')})`);
    const row = (reply && Array.isArray(reply.actions) ? reply.actions : []).find(r => r && r.auto === true && r.tool === 'steward_run_action') || null;
    ok(row && row.result && row.result.error === 'propose_required',
      `E1 自理没有动手,降级成提议(got ${row && row.result && (row.result.reason || row.result.error || 'ok')})`);
    ok(row && row.acted !== true, 'E2 被停的目标不白占一个小时窗名额(acted 没有被置 true)');
    ok(runStatusOf(SID_FAILED, 'run_stopped') === 'stopped', 'E3 走完一整个收件箱回合,班组快照仍然是 stopped');
    ok((reply && Array.isArray(reply.acts) ? reply.acts : []).some(a => a && a.tool === 'steward_run_action'),
      'E4 降级成的那枚按钮还在(用户自己按得到 —— 这一刀不夺走用户的选择)');
    ok((reply && Array.isArray(reply.actions) ? reply.actions : []).every(r => !(r && r.result && r.result.ok === true && r.tool === 'steward_run_action')),
      'E5 这一回合里零成功的班组动作');
  }

  /* ═════════ (F) 对照:没被停的目标,自理照旧真的动手 ═════════ */
  console.log('── (F) 对照 ──');
  {
    const events = [{
      inboxSeq: 2, kind: 'failed', sessionId: SID_FAILED, missionId: SID_FAILED,
      seq: 4, at: new Date().toISOString(), payload: { summary: '会话第 4 回合失败' }, count: 1,
    }];
    const reply = await srv.runStewardTurn({ trigger: 'inbox', events });
    const row = (reply && Array.isArray(reply.actions) ? reply.actions : []).find(r => r && r.auto === true && r.tool === 'steward_thread_continue') || null;
    // 判「真的动手了」看 acted 与「不是被这道闸挡的」两条,不看 result.ok:递话有四条通道(117l D2),
    // 目标此刻没有在跑,它走的是排队那条(steward.queued)—— 那也是动过手了,配额已经计出去了。
    ok(row && row.acted === true && !(row.result && row.result.reason === 'target_stopped'),
      `F1 目标没被停(末回合 aborted:false)-> 自理照旧递「继续」(got ${row && (row.acted === true ? 'acted' : 'not-acted') + '/' + (row.result && (row.result.reason || row.result.error || 'ok'))})`);
    await sleep(200);
  }
} catch (error) {
  turnFail++;
  console.log('FAIL 夹具自身抛了:' + String((error && error.stack) || error));
} finally {
  try { providerServer.close(); } catch { /* already down */ }
  await sleep(150);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 临时目录,下次冷启动会清 */ }
}

console.log(`\nSTEWARD STOP RESPECTED E2E: ${fail + turnFail ? `FAIL (${fail + turnFail})` : 'ALL PASS'}`);
process.exit(fail + turnFail ? 1 : 0);
})().catch(e => { console.log('FAIL 顶层异常:' + String((e && e.stack) || e)); process.exit(1); });
