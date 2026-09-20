require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(第 129 波 129e · 49 号文 §4 · 31 号文 §2.3):改一条【已有】线程的工作目录。
//
// 修前:31 号文 §2.3 放① 只做了「开线程时选工作区」;真机走查里更常撞见的是另一半 ——
// **线程已经开在错的目录里了**(那次四条线程含两条股票问题全落在代码仓库)。用户能在顶栏改
// (updateSessionMeta 的 patch.cwd 就是那条路),管家连提都提不出来。
//
// 用户 2026-09-20 拍板:**auto 档自动、其余档提议**。另两条是主会话定的:
// 活回合期间一律拒;旧目录上的检查点不迁移不删除,返回里明说。
//
// 覆盖:
//  (A) 围栏:只收工作区表里的路径;表外拒;前缀陷阱拒;管家会话自己没有工作目录可改。
//  (B) 档位:auto 档直接改;其余三档回 propose_required(带上是哪一档),且**零写入**。
//  (C) 忙锁:活回合期间拒(steward.busy),且零写入。
//  (D) 落定:真的改到了会话头上、回显旧值、决策日志与 undoRef 都在、返回里说清检查点没搬。
//  (E) 幂等:已经在那个目录里时回 not_changed(不是「改成功了」的假话,也不是报错)。
//
// 进程内直调,零模型请求、零网络。判定行:`STEWARD THREAD WORKSPACE E2E: ALL PASS`。
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ws-'));
const WS_A = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ws-a-'));
const WS_B = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ws-b-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ws-out-'));
const NEAR = WS_B + '-secrets';
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

fs.mkdirSync(NEAR, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, defaultWorkspace: WS_A, recentWorkspaces: [OUTSIDE], subagentMaxPerTurn: 0,
  stewardEnabledV1: true, stewardPollMs: 120000,
  workspaces: [{ path: WS_A, read: true, write: true, execute: true }, { path: WS_B, read: true, write: true, execute: true }],
}, null, 2), 'utf8');
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

const ctx = () => ({ session: { id: 'steward', kind: 'steward', providerHistory: [{ role: 'user', content: 'x' }] }, sessionId: 'steward' });
const call = (args) => srv.toolCall('steward_thread_workspace', args, ctx());
const headOf = async id => JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', id + '.json'), 'utf8'));
async function mkThread(mode) {
  const s = await srv.createSession({ title: '线程 ' + mode, cwd: WS_A });
  s.permissionMode = mode;
  await srv.saveSession(s);
  return s.id;
}

/* ═════════ (A) 围栏 ═════════ */
console.log('── (A) 围栏 ──');
{
  const id = await mkThread('auto');
  const out = await call({ sessionId: id, cwd: path.join(OUTSIDE, 'sub') });
  ok(out && out.ok === false && out.error === 'outside_workspace',
    `A1 工作区表外的路径一律拒(got ${out && out.error})`);
  ok((await headOf(id)).cwd === WS_A, 'A1b 拒是零写入(会话头上的 cwd 一个字没动)');
  const near = await call({ sessionId: id, cwd: NEAR });
  ok(near && near.ok === false && near.error === 'outside_workspace',
    'A2 前缀陷阱也拒:`<工作区>-secrets` 不是 `<工作区>` 的子目录');
  const recent = await call({ sessionId: id, cwd: OUTSIDE });
  ok(recent && recent.ok === false && recent.error === 'outside_workspace',
    'A3 recentWorkspaces 里的目录【不算】已登记(打开过 ≠ 授权过,31 号文红线 2)');
  // 管家会话:判据是【会话头上的 kind】,不是那个固定 id —— 所以造一条 kind:'steward' 的会话来测,
  // 比依赖「那个单例这会儿已经建出来了」可靠(它是懒建的,夹具里多半还不存在)。
  const stewardish = await srv.createSession({ title: '假管家', cwd: WS_A });
  stewardish.kind = 'steward';
  await srv.saveSession(stewardish);
  const steward = await call({ sessionId: stewardish.id, cwd: WS_B });
  ok(steward && steward.ok === false && steward.error === 'invalid_target',
    `A4 管家会话自己没有工作目录可改(got ${steward && steward.error})`);
  const missing = await call({ sessionId: 'sess_definitely_not_here', cwd: WS_B });
  ok(missing && missing.ok === false && missing.error === 'not_found', 'A5 不存在的线程 -> not_found');
}

/* ═════════ (B) 档位(用户拍板:auto 自动、其余提议) ═════════ */
console.log('── (B) 档位 ──');
{
  for (const mode of ['default', 'acceptEdits', 'plan']) {
    const id = await mkThread(mode);
    const r = await call({ sessionId: id, cwd: WS_B });
    ok(r && r.ok === false && r.error === 'propose_required' && r.reason === 'target_permission',
      `B1-${mode} 非 auto 档回 propose_required(变成一枚按钮交给用户;got ${r && r.error})`);
    ok(r && r.permissionMode === mode, `B1b-${mode} 回包说清是哪一档挡的(模型能照直说给用户听)`);
    ok((await headOf(id)).cwd === WS_A, `B1c-${mode} 提议是零写入`);
  }
}

/* ═════════ (C) 忙锁 ═════════ */
console.log('── (C) 活回合 ──');
{
  const id = await mkThread('auto');
  // 与 thread_rename 同一条忙锁:activeChildren 里有它就当在跑。
  srv.activeChildren.set(id, { fake: true });
  try {
    const r = await call({ sessionId: id, cwd: WS_B });
    ok(r && r.ok === false && r.error === 'steward.busy',
      `C1 活回合期间一律拒 —— 不在回合中途换脚下的地(got ${r && r.error})`);
    ok((await headOf(id)).cwd === WS_A, 'C1b 零写入');
  } finally { srv.activeChildren.delete(id); }
}

/* ═════════ (D) 落定 ═════════ */
console.log('── (D) 落定 ══');
{
  const id = await mkThread('auto');
  const before = (() => { try { return fs.readFileSync(path.join(HOME, 'steward', 'decisions-v1.ndjson'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } })();
  const r = await call({ sessionId: id, cwd: WS_B });
  ok(r && r.ok === true && r.cwd === WS_B, `D1 auto 档直接改到位(got ${r && r.cwd})`);
  ok(r && r.previousCwd === WS_A, 'D2 回显旧目录(用户看得出挪之前在哪)');
  ok(r && r.undoRef && r.undoRef.kind === 'cwd' && r.undoRef.previousCwd === WS_A, 'D3 undoRef 指得回旧目录');
  ok(r && /检查点/.test(String(r.note || '')) && /没有迁移/.test(String(r.note || '')),
    'D4 返回里明说旧目录上的检查点没搬也没删(悄悄搬走比不搬更难解释)');
  ok((await headOf(id)).cwd === WS_B, 'D5 真的落到会话头上了(下一回合就按新目录算)');
  // 决策日志是即发即忘的,等它落盘。
  let rows = [];
  for (let i = 0; i < 40; i++) {
    await new Promise(res => setTimeout(res, 25));
    try { rows = fs.readFileSync(path.join(HOME, 'steward', 'decisions-v1.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { rows = []; }
    if (rows.length > before) break;
  }
  const last = rows.filter(d => d && d.tool === 'steward_thread_workspace').pop();
  ok(last && last.args && last.args.cwd === WS_B && last.args.previousCwd === WS_A,
    'D6 决策日志记下了这次搬家(用户在行动流水里看得见)');
}

/* ═════════ (E) 幂等 ═════════ */
console.log('── (E) 幂等 ──');
{
  const id = await mkThread('auto');
  const r = await call({ sessionId: id, cwd: WS_A });
  ok(r && r.ok === false && r.error === 'not_changed',
    `E1 已经在那个目录里 -> not_changed(既不说假的「改好了」,也不报一个像出错的错;got ${r && r.error})`);
}

for (const dir of [HOME, WS_A, WS_B, OUTSIDE, NEAR]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } }
console.log(fail === 0 ? 'STEWARD THREAD WORKSPACE E2E: ALL PASS' : `STEWARD THREAD WORKSPACE E2E: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
})();
