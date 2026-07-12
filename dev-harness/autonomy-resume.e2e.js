// E2E: 第29波「监控与运营 §29b 自动恢复分级」(AUTONOMY-PLAN §29)。端口 WB 9121(已登记,同端口串行多次 boot)。
// [P] 纯逻辑源抽取 classifyNodeResumeRisk / classifyRunResumeTier(注入 NODE_WRITE_FAMILY):tier×证据×gate×wait×权限面 穷举。
// [S] 静态锁:opt-in 默认 false、boot 挂点在标死之后、崩溃环护栏先落盘(fail-closed)、boot 防炸 catch、resume 清分级戳。
// [H] Live 三次 boot:①默认关=零行为变化(interrupted 停住,只盖分级戳);②开=安全 run 自动续跑到 succeeded +
//     危险 run 停 paused(manual_resume_required)+ run_resume_deferred 事件;③崩溃环 autoResumeCount≥2 → 降 manual。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const WB_PORT = 9121;
const HOME = path.join(os.tmpdir(), 'wcw-autonomy-resume-e2e');
const WS = path.join(HOME, 'ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let buf = ''; res.on('data', c => (buf += c)); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function up() { for (let i = 0; i < 60; i++) { try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {} await sleep(150); } return false; }
const src = fs.readFileSync(SERVER, 'utf8');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [S] 静态锁
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [S] 静态锁 ──');
ok(/autonomyAutoResume: false,/.test(src) && /config\.autonomyAutoResume = config\.autonomyAutoResume === true;/.test(src), 'S opt-in 默认 false(===true 归一,boot 自动续跑烧 token 必须显式开)');
const markIdx = src.indexOf('await markInterruptedAgentRuns();');
const autoIdx = src.indexOf('void autoResumeInterruptedRuns().catch');
ok(markIdx > 0 && autoIdx > markIdx, 'S boot 挂点:自动恢复在诚实标死【之后】且 fire-and-forget');
ok(/const AUTO_RESUME_MAX = 2;/.test(src), 'S 崩溃环上限 AUTO_RESUME_MAX=2');
ok(/try \{ await saveAgentRun\(run\); \} catch \{ guardPersisted = false; \}/.test(src) && /if \(!guardPersisted\) continue;/.test(src), 'S 崩溃环护栏先落盘,写不进就不启动(fail-closed)');
ok((src.match(/await saveAgentRun\(run\)\.catch\(\(\) => \{\}\); \/\/ 29b 顺手修/g) || []).length >= 1 && /if \(dirty\) await saveAgentRun\(run\)\.catch\(\(\) => \{\}\);/.test(src), 'S boot 标死写盘防炸(磁盘故障不再放倒 startServer)');
ok(/if \(interventionKind\) bumpRunIntervention\(run, interventionKind\);/.test(src) && /interventionKind: 'resume'/.test(src) && /interventionKind: 'retry_node'/.test(src), 'S 冷 resume/retry 计干预;boot 自动续跑不传(不计)');
ok(/delete run\.resumeTier; delete run\.resumeTierReasons;/.test(src) && /delete run\.pendingReview;/.test(src), 'S resume 清分级戳 + 顺手清 28d pendingReview(此前只设不清)');
ok(/if \(bootConfig\) \{ const cls = classifyRunResumeTier\(run, bootConfig\.permissionMode\);/.test(src), 'S 中断标记时盖分级戳(展示用;决策时重算)');
ok(/permissionModeAtLaunch: String\(permModeOverride \|\| config\.permissionMode \|\| ''\)/.test(src), 'S run 创建存档首跑权限面');
ok(/type: 'run_resume_deferred'/.test(src) && /type: 'run_auto_resume'/.test(src), 'S 恢复决策入事件日志(取证)');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [P] 纯逻辑:classifyNodeResumeRisk / classifyRunResumeTier
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [P] 分级纯函数 ──');
const m1 = src.match(/function classifyNodeResumeRisk\(node\) \{[\s\S]*?\n\}/);
const m2 = src.match(/function classifyRunResumeTier\(run, currentPermissionMode\) \{[\s\S]*?\n\}/);
ok(!!m1 && !!m2, 'P 源抽取两分级函数');
const NODE_WRITE_FAMILY = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// 对抗轮修引入 CLAUDE_EXEC_TOOLS/CLAUDE_WRITE_TOOLS 两个模块级 const,源抽取需一并注入(与被测函数同源定义)。
const mExec = src.match(/const CLAUDE_EXEC_TOOLS = new Set\(\[[^\]]*\]\);/);
const mWrite = src.match(/const CLAUDE_WRITE_TOOLS = new Set\(\[[^\]]*\]\);/);
ok(!!mExec && !!mWrite, 'P 源抽取 CLAUDE_EXEC_TOOLS/CLAUDE_WRITE_TOOLS');
const PRELUDE = mExec[0] + '\n' + mWrite[0] + '\n';
const classifyNodeResumeRisk = new Function('NODE_WRITE_FAMILY', PRELUDE + m1[0] + '\nreturn classifyNodeResumeRisk;')(NODE_WRITE_FAMILY);
const classifyRunResumeTier = new Function('NODE_WRITE_FAMILY', PRELUDE + m1[0] + '\n' + m2[0] + '\nreturn classifyRunResumeTier;')(NODE_WRITE_FAMILY);
ok(classifyNodeResumeRisk({ wait: { mode: 'timer' } }).safe === true, 'P wait 节点=safe(零副作用)');
ok(classifyNodeResumeRisk({ gate: { mode: 'vote' } }).safe === true && classifyNodeResumeRisk({ gate: { mode: 'dedupe' } }).safe === true, 'P 确定性门 vote/dedupe=safe');
ok(classifyNodeResumeRisk({ toolTier: 'read' }).safe === true && classifyNodeResumeRisk({}).safe === true, 'P read/缺省 tier=safe');
ok(classifyNodeResumeRisk({ toolTier: 'exec' }).safe === false && classifyNodeResumeRisk({ toolTier: 'exec' }).reason === 'exec_tier', 'P exec 一律 manual(不可审计不可回滚)');
ok(classifyNodeResumeRisk({ toolTier: 'exec', isolationMode: 'worktree' }).safe === false, 'P exec×worktree 仍 manual(worktree 圈不住 shell)');
// OpenAI 引擎(默认):tier 运行时硬enforce,edit 证据逻辑生效。
ok(classifyNodeResumeRisk({ toolTier: 'edit' }).safe === true, 'P openai edit 无证据=safe(journal 回滚 + 幂等写兜底)');
ok(classifyNodeResumeRisk({ toolTier: 'edit', artifacts: [{ tool: 'file_write', ref: 'a.txt' }] }).safe === false, 'P openai edit+artifacts 证据=manual');
ok(classifyNodeResumeRisk({ toolTier: 'edit', continuation: { steps: [{ tool: 'file_write', ok: true }] } }).reason === 'edit_confirmed_writes', 'P openai edit+续点写族 ok 步=manual');
ok(classifyNodeResumeRisk({ toolTier: 'edit', continuation: { steps: [{ tool: 'file_write', ok: false }] } }).safe === true, 'P openai edit+写步 ok:false(未落地)=safe');
ok(classifyNodeResumeRisk({ toolTier: 'edit', continuation: { steps: [{ tool: 'file_read', ok: true }] } }).safe === true, 'P openai edit+只读步=safe');
// 对抗轮 P2(#18): openai edit 也扫 continuation.pending(在途写)——崩溃瞬间 tool_use 已发、tool_result 未回。
ok(classifyNodeResumeRisk({ toolTier: 'edit', continuation: { pending: { e1: { tool: 'file_write' } } } }).safe === false, 'P openai edit+continuation.pending 在途写=manual(#18)');
// 对抗轮 P1(#17): Claude 引擎按真实工具面(role.claudeTools)判,不看 toolTier —— field-shadow 同类根因。
ok(classifyNodeResumeRisk({ engine: 'claude', toolTier: 'edit', roleSnapshot: { claudeTools: ['Read', 'Edit', 'Bash'] } }).safe === false, 'P【#17】Claude edit 但 claudeTools 携 Bash → manual(claude_exec_tool)');
ok(classifyNodeResumeRisk({ engine: 'claude', toolTier: 'edit', roleSnapshot: { claudeTools: ['Read', 'Edit', 'Bash'] } }).reason === 'claude_exec_tool', 'P【#17】理由=claude_exec_tool');
ok(classifyNodeResumeRisk({ engine: 'claude', toolTier: 'read', roleSnapshot: { claudeTools: ['Read', 'Write'] } }).safe === false, 'P【#17】Claude read 但 claudeTools 携 Write → manual(claude_write_no_journal,CLI 写无 journal)');
ok(classifyNodeResumeRisk({ engine: 'claude', toolTier: 'edit', roleSnapshot: { claudeTools: [] } }).safe === false, 'P【#18】Claude edit + claudeTools 空 → 落 tier 默认含 Write/Edit → manual(claude_tier_writes)');
ok(classifyNodeResumeRisk({ engine: 'claude', toolTier: 'read', roleSnapshot: { claudeTools: [] } }).safe === true, 'P Claude read + 空 claudeTools(纯读 tier 默认)=safe');
ok(classifyNodeResumeRisk({ engine: 'claude', toolTier: 'read', roleSnapshot: { claudeTools: ['Read', 'Grep', 'WebFetch'] } }).safe === true, 'P Claude 纯读 claudeTools=safe(claude_read)');
// run 级聚合
const mk = (nodes, mode) => ({ nodes, permissionModeAtLaunch: mode });
ok(classifyRunResumeTier(mk([{ toolTier: 'read', status: 'interrupted' }]), 'bypass').tier === 'auto_resumable', 'P 全安全 → auto_resumable');
ok(classifyRunResumeTier(mk([{ toolTier: 'read', status: 'interrupted' }, { toolTier: 'exec', status: 'blocked' }]), '').tier === 'manual_resume_required', 'P 任一危险节点 → 整 run manual(reset 集会重排它)');
ok(classifyRunResumeTier(mk([{ toolTier: 'exec', status: 'succeeded' }, { toolTier: 'read', status: 'interrupted' }]), '').tier === 'auto_resumable', 'P 已 succeeded 的 exec 不进 reset 集 → 不拖累');
{
  const r = classifyRunResumeTier({ nodes: [{ toolTier: 'read', status: 'interrupted' }], permissionModeAtLaunch: 'default' }, 'bypass');
  ok(r.tier === 'manual_resume_required' && r.reasons.some(x => x.reason === 'permission_mode_changed'), 'P 权限面变化(default→bypass)→ manual');
}
// 对抗轮 P2(#19): 缺 permissionModeAtLaunch 的旧 run —— 有副作用面(edit/exec 节点)则 fail-safe manual;纯读可自动。
ok(classifyRunResumeTier({ nodes: [{ toolTier: 'read', status: 'interrupted' }] }, 'bypass').tier === 'auto_resumable', 'P【#19】老 run 缺字段 + 纯读节点 → 仍 auto(无副作用面)');
{
  const r = classifyRunResumeTier({ nodes: [{ toolTier: 'edit', engine: 'openai', status: 'interrupted' }] }, 'bypass');
  ok(r.tier === 'manual_resume_required' && r.reasons.some(x => x.reason === 'permission_mode_unknown'), 'P【#19】老 run 缺字段 + edit 副作用面 → manual(permission_mode_unknown)');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [H] Live 三次 boot
// ══════════════════════════════════════════════════════════════════════════════════════════════════
const writeConfig = (autoResume) => fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, permissionMode: 'bypass', defaultWorkspace: WS, autonomyAutoResume: autoResume,
  providers: [{ id: 'dummy', label: 'Dummy', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', models: [{ id: 'm', label: 'm' }] }], activeProvider: 'dummy',
}, null, 2));
const bootWb = () => { const p = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true }); p.stdout.on('data', () => {}); p.stderr.on('data', () => {}); return p; };
const craftRun = (dir, rid, extra) => fs.writeFileSync(path.join(dir, rid + '.json'), JSON.stringify({
  schemaVersion: 4, id: rid, sessionId: extra.sessionId, status: extra.status || 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  concurrency: 2, taskPool: [], messages: [], poolPolicy: 'manual', poolAutoCap: 3, permissionModeAtLaunch: 'bypass', metrics: { interventions: {} }, ...extra.top,
  nodes: extra.nodes,
}));
let wb = null;
(async () => {
  try {
    console.log('\n── [H] Live ──');
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.mkdirSync(WS, { recursive: true });
    writeConfig(false);
    // boot#0:建会话(launchPersistedAgentRun 需要真实父会话)。
    wb = bootWb();
    ok(await up(), 'H boot#0 up');
    // token 每次 boot 随机重生(runtime.json)—— 每个 boot 段用时须重读,拿旧 token 会 403。
    const freshH = () => ({ 'x-wcw-token': (readJson(path.join(HOME, 'runtime.json')) || {}).token || '' });
    const s = (await req('POST', '/api/sessions', { title: 'resume', cwd: WS }, freshH())).json.session;
    const sid = s.id;
    const runsDir = path.join(HOME, 'agent-runs', sid);
    fs.mkdirSync(runsDir, { recursive: true });
    kill(wb); await sleep(600);

    const waitNode = { id: 'w1', task: '', wait: { mode: 'timer', durationMs: 500, pollMs: 500, timeoutMs: 20000 }, dependsOn: [], status: 'running', attempts: 1, result: '', error: '', progressLog: [] };
    const execNode = { id: 'x1', task: 'echo hi', toolTier: 'exec', engine: 'openai', dependsOn: [], status: 'running', attempts: 1, result: '', error: '', progressLog: [] };

    // ── boot#1:默认关(autonomyAutoResume:false)= 零行为变化,只盖分级戳。──
    craftRun(runsDir, 'run_aaa0000000000001', { sessionId: sid, status: 'running', nodes: [JSON.parse(JSON.stringify(waitNode))] });
    wb = bootWb();
    ok(await up(), 'H boot#1 up(默认关)');
    await sleep(1500);
    let r = readJson(path.join(runsDir, 'run_aaa0000000000001.json'));
    ok(r && r.status === 'interrupted', 'H1 默认关:run 停在 interrupted(零行为变化,不自动续跑)');
    ok(r && r.resumeTier === 'auto_resumable', 'H1 默认关:仍盖分级戳(展示用)resumeTier=auto_resumable');
    kill(wb); await sleep(600);

    // ── boot#2:开(autonomyAutoResume:true)——安全 run 自动续跑到 succeeded;危险 run 停 paused。──
    writeConfig(true);
    craftRun(runsDir, 'run_bbb0000000000001', { sessionId: sid, status: 'running', nodes: [JSON.parse(JSON.stringify(waitNode))] });
    craftRun(runsDir, 'run_ccc0000000000001', { sessionId: sid, status: 'running', nodes: [JSON.parse(JSON.stringify(execNode))] });
    // 对抗轮 P1(#17) 端到端:toolTier='edit' 但 Claude 角色 claudeTools 携 Bash —— 旧实现判 safe 会自动续跑重放 shell。
    const claudeBashNode = { id: 'cb1', task: 'deploy', toolTier: 'edit', engine: 'claude', roleSnapshot: { id: 'builder', label: 'B', claudeTools: ['Read', 'Edit', 'Bash'], permissionMode: 'inherit' }, dependsOn: [], status: 'running', attempts: 1, result: '', error: '', progressLog: [] };
    craftRun(runsDir, 'run_eee0000000000001', { sessionId: sid, status: 'running', nodes: [claudeBashNode] });
    // run_aaa... 遗留自 boot#1(已 interrupted + safe)→ 本次 boot 也该被自动续跑,一并断言。
    wb = bootWb();
    ok(await up(), 'H boot#2 up(开)');
    let safeDone = null, aDone = null;
    for (let i = 0; i < 75; i++) { // ≤15s
      safeDone = readJson(path.join(runsDir, 'run_bbb0000000000001.json'));
      aDone = readJson(path.join(runsDir, 'run_aaa0000000000001.json'));
      if (safeDone && safeDone.status === 'succeeded' && aDone && aDone.status === 'succeeded') break;
      await sleep(200);
    }
    ok(safeDone && safeDone.status === 'succeeded', 'H2 【验收锁】安全 run 重启自动续跑到 succeeded(实 ' + (safeDone && safeDone.status) + ')');
    ok(safeDone && Number(safeDone.autoResumeCount) === 1, 'H2 autoResumeCount=1(崩溃环护栏落盘)');
    ok(aDone && aDone.status === 'succeeded', 'H2 上次 boot 遗留的 interrupted 安全 run 也被续跑');
    const evSafe = fs.readFileSync(path.join(runsDir, 'run_bbb0000000000001.events.ndjson'), 'utf8');
    ok(/"type":"run_auto_resume"/.test(evSafe) && /"type":"run_resumed"/.test(evSafe) && /"type":"run_end"/.test(evSafe), 'H2 事件链:run_auto_resume→run_resumed→…→run_end');
    let danger = readJson(path.join(runsDir, 'run_ccc0000000000001.json'));
    ok(danger && danger.status === 'paused', 'H2 【验收锁】危险 run(exec)停在暂停态(实 ' + (danger && danger.status) + ')');
    ok(danger && danger.resumeTier === 'manual_resume_required' && (danger.resumeTierReasons || []).some(x => x.reason === 'exec_tier'), 'H2 危险 run 带 manual_resume_required + exec_tier 理由');
    const evDanger = fs.readFileSync(path.join(runsDir, 'run_ccc0000000000001.events.ndjson'), 'utf8');
    ok(/"type":"run_resume_deferred"/.test(evDanger), 'H2 危险 run 留 run_resume_deferred 取证事件');
    // 对抗轮 P1(#17) 端到端断言:Claude+Bash 伪装 edit 节点【必须】停在暂停态(旧实现会误判 safe 自动续跑重放 shell)。
    let claudeBashRun = null;
    for (let i = 0; i < 40; i++) { claudeBashRun = readJson(path.join(runsDir, 'run_eee0000000000001.json')); if (claudeBashRun && claudeBashRun.status === 'paused') break; await sleep(200); }
    ok(claudeBashRun && claudeBashRun.status === 'paused', 'H2【#17】Claude+Bash 伪装 edit 节点停在暂停态(不自动重放 shell,实 ' + (claudeBashRun && claudeBashRun.status) + ')');
    ok(claudeBashRun && (claudeBashRun.resumeTierReasons || []).some(x => x.reason === 'claude_exec_tool'), 'H2【#17】理由=claude_exec_tool(按真实工具面判,非 toolTier)');
    // 危险 run 人工 resume 仍可用(paused 冷恢复路径)——resume 后跑不动 exec 节点没关系,只验证入口不被分级封死。
    const rr = (await req('POST', '/api/agent-runs/run_ccc0000000000001', { sessionId: sid, action: 'resume' }, freshH())).json;
    ok(rr && rr.ok === true, 'H2 危险 run 人工 resume 入口不受分级限制(accepted)');
    kill(wb); await sleep(600);

    // ── boot#3:崩溃环 —— autoResumeCount 已 2 的安全 run 不再自动续跑,降 manual(auto_resume_loop)。──
    craftRun(runsDir, 'run_ddd0000000000001', { sessionId: sid, status: 'interrupted', top: { autoResumeCount: 2 }, nodes: [{ ...JSON.parse(JSON.stringify(waitNode)), status: 'interrupted' }] });
    wb = bootWb();
    ok(await up(), 'H boot#3 up');
    await sleep(1500);
    const loopRun = readJson(path.join(runsDir, 'run_ddd0000000000001.json'));
    ok(loopRun && loopRun.status === 'paused' && loopRun.resumeTier === 'manual_resume_required' && (loopRun.resumeTierReasons || []).some(x => x.reason === 'auto_resume_loop'), 'H3 崩溃环截断:第 3 次不再自动续跑,降 manual(auto_resume_loop)');
  } catch (e) { ok(false, 'H 异常:' + (e && e.stack || e)); }
  finally {
    kill(wb);
    console.log('');
    if (fail) { console.log('AUTONOMY-RESUME E2E: FAIL (' + fail + ')'); process.exit(1); }
    console.log('AUTONOMY-RESUME E2E: ALL PASS');
  }
})();
