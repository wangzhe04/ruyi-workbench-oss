require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(2026-10 工具走查第二轮 · 管家组):第一轮走查之后「确认存在、当时没修」的那批管家工具缺陷,本件逐条钉住。
// 每一条都是【修前真调复现过】的现场,断言写的是修后该有的行为(修前在这里会红;反向验证见提交说明)。
//
//  R1  失败的回合在【没标 stewardWatch】的线程上也记成败账:thread_status / threads_search / missions 不再把它说成「已收工」。
//  R2  steward_missions 有 limit(默认 50,上限 200)+ total + truncated。
//  R3  steward_audit_tail:默认排除纯遥测、kinds 过滤、同毫秒后写的在前、最近日志文件不够时往前读。
//  R4  steward_threads_search 一个字的查询 → 空结果 + query_too_short;includeClosed 进了 schema。
//  R5  类型/枚举校验:usage 的 day、config_get 的 keys 字符串、self_status 的 section、rename 的 title 对象、
//      continue 的 message 数字、thread_new / schedule_create 的 tier 枚举;运行器注入的 basis 等不被拒。
//  R6  config_get 的外部 MCP env 掩码不露末 4 位。
//  R7  steward_file_read 拒凭据文件(.env / id_rsa / .pem / .git/config)与二进制;模板 .env.example 放行;artifact_read 拒二进制。
//  R8  steward_thread_read 对正文脱敏、工具行带 ok、普通线程的 kind 不是 quick_ask。
//  R9  steward_thread_prioritize 回包里的 wait.ahead 是插队【之后】的。
//  R10 run_action 的 runId 格式非法 → invalid_request(缺 runId 的收紧类仍是 no_agent_run)。
//  R11 playbook_draft 没调模型就失败不占本回合的名额。
//  R12 memory_veto 重复否决 / schedule_pause·resume 已在目标状态 → 幂等(unchanged,不写盘不记决策);已过去的 expiresAt 拒。
//  R13 steward_decide 的 deny / reject 不受永久豁免与权限档闸限制,allow 仍受限。
//  R14 thread_new 的 missionId 不存在 → not_found;quick_ask 的 question 逐字(尖括号不被换成全角)。
//  R15 schedule_create:永不触发的 cron、不存在 / 管家自己的 existing-session 目标、prompt 分钟级 cron 拒;
//      静默归一进 notes;到点目标线程没了记 failed 而不是悄悄新开。
//  R16 schedule_run_now:无人值守(inbox)→ propose_required;暂停中的任务能跑但如实带 wasPaused。
//  R17 管家发起的用户消息带 meta.origin:'steward',steward_memory_write 拒以它为来源。
//
// 判定行:`TOOL AUDIT R2 STEWARD E2E: ALL PASS`。
(async () => {
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames, usageFrame } = require('./lib/fake-openai-provider');
const t = createRunner('TOOL AUDIT R2 STEWARD');
const { ok } = t;
const ROOT = path.resolve(__dirname, '..');
const HOME = process.env.RUYI_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2-steward-'));
process.env.RUYI_HOME = HOME; process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-r2-steward-ws-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.writeFileSync(path.join(WS, 'a.txt'), 'line1\nline2\n');
fs.writeFileSync(path.join(WS, '.env'), 'API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz\n');
fs.writeFileSync(path.join(WS, '.env.example'), 'API_KEY=changeme\n');
fs.mkdirSync(path.join(WS, '.git')); fs.writeFileSync(path.join(WS, '.git', 'config'), '[remote "o"]\n url = https://u:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y.git\n');
fs.mkdirSync(path.join(WS, '.ssh')); fs.writeFileSync(path.join(WS, '.ssh', 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
fs.writeFileSync(path.join(WS, 'server.pem'), '-----BEGIN CERTIFICATE-----\nabc\n');
fs.writeFileSync(path.join(WS, 'bin.dat'), Buffer.from([0, 1, 2, 255, 254, 0, 10]));
for (const d of ['b', 'c', 'd']) fs.mkdirSync(path.join(WS, d));

// ── 假 provider:按用户消息里的暗号分支 ──────────────────────────────────────────────
const fake = await startFakeProvider({
  handler(req) {
    const lastUser = [...req.messages].reverse().find(m => m.role === 'user');
    const txt = String(lastUser && (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content)) || '');
    const hasToolResult = req.messages.some(m => m.role === 'tool');
    if (txt.includes('FAILME')) return { status: 500, json: { error: { message: 'boom upstream' } } };
    if (txt.includes('SLOW')) return new Promise(() => {});
    if (txt.includes('READOK') && !hasToolResult) return toolCallFrames('file_read', { path: path.join(WS, 'a.txt') }, 'call_ok');
    if (txt.includes('READBAD') && !hasToolResult) return toolCallFrames('file_read', { path: path.join(WS, 'no-such-file.txt') }, 'call_bad');
    return [...textFrames('已完成:' + txt.slice(0, 20)), usageFrame({ prompt_tokens: 100, completion_tokens: 50 })];
  },
});
const baseConfig = {
  configSchema: 7, permissionMode: 'default', engineMode: 'interactive', defaultWorkspace: WS, recentWorkspaces: [WS],
  workspaces: [{ path: WS, read: true, write: true, execute: true }],
  includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, killOnDisconnect: false,
  stewardEnabledV1: true, schedulerEnabledV1: true, stewardPollMs: 120000, subagentMaxPerTurn: 0,
  stewardMaxParallelThreads: 5,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  activeProvider: 'fake',
  externalMcpServers: [{ id: 'r2mcp', command: 'node', args: ['-e', '0'], enabled: false, env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789cdef' } }],
};
const writeConfig = patch => fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ ...baseConfig, ...(patch || {}) }, null, 2));
writeConfig();
const srv = require(path.join(ROOT, 'ruyi-workbench', 'app', 'server.js'));
let turn = 1000;
const S = async (name, args, extra) => {
  const { turn: forced, ctx: ectx, ...rest } = extra || {};
  const ctx = { session: { id: 'steward', kind: 'steward', turnSeq: forced != null ? forced : ++turn, providerHistory: [] }, sessionId: 'steward', ...(ectx || {}), ...rest };
  try { return await srv.toolCall(name, args, ctx); } catch (e) { return { threw: String((e && e.message) || e) }; }
};
const runTurn = (id, msg, cwd) => srv.runSessionTurn({ sessionId: id, message: msg, cwd: cwd || WS, source: 'http', onEvent: () => {} });
const mk = async (title, cwd) => (await srv.createSession({ title, cwd: cwd || WS })).id;
const decisions = () => { try { return fs.readFileSync(path.join(HOME, 'steward', 'decisions-v1.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

try {
  /* ═════════ R1 失败回合在未盯的线程上也记账 ═════════ */
  const bad = await mk('未盯-失败线程');
  const r1 = await runTurn(bad, 'FAILME 请失败');
  ok(r1 && r1.result && r1.result.ok === false, 'R1a 前提:假 provider 回 500,这一回合 ok:false');
  await sleep(300);   // 成败账是旁路写,等它落盘
  const st = await S('steward_thread_status', { sessionId: bad });
  ok(st.ok === true && st.state === 'stopped' && st.stateSources && st.stateSources.lastTurnFailed === true,
    `R1b 没标 stewardWatch 的线程失败后 thread_status 是 stopped / lastTurnFailed(修前 done;got ${st.state}/${JSON.stringify(st.stateSources && st.stateSources.lastTurnFailed)})`);
  const head = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', bad + '.json'), 'utf8'));
  ok(head.stewardLastTurn && head.stewardLastTurn.ok === false, 'R1c 成败账落在会话头上');
  const srch = await S('steward_threads_search', { q: '失败线程' });
  const hit = (srch.results || []).find(r => r.sessionId === bad);
  ok(hit && hit.state === 'stopped', `R1d threads_search 里同样是 stopped(got ${hit && hit.state})`);
  const ms = await S('steward_missions', {});
  const row = (ms.missions || []).find(m => (m.threads || []).some(th => th.sessionId === bad));
  ok(row && row.aggregateState === 'stopped', `R1e missions 聚合态是 stopped(got ${row && row.aggregateState})`);
  const good = await mk('未盯-成功线程');
  await runTurn(good, '你好 成功'); await sleep(300);
  const st2 = await S('steward_thread_status', { sessionId: good });
  ok(st2.state === 'done', `R1f 成功的未盯线程仍是 done(got ${st2.state})`);

  /* ═════════ R8 thread_read 脱敏 / ok 标 / kind(顺手用同一批线程)═════════ */
  const SECRET = 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456';
  const rd = await mk('读线程');
  await runTurn(rd, `READOK 请读文件,顺便我的 key 是 ${SECRET}`); await sleep(300);
  const rdBad = await mk('读线程失败工具');
  await runTurn(rdBad, 'READBAD 读一个不存在的文件'); await sleep(300);
  const tr = await S('steward_thread_read', { sessionId: rd });
  ok(tr.ok === true && !JSON.stringify(tr).includes(SECRET) && /«redacted»/.test(JSON.stringify(tr)),
    `R8a 用户正文里的密钥已脱敏(修前原样交出;got ${JSON.stringify(tr.rows && tr.rows[0] && tr.rows[0].text).slice(0, 120)})`);
  const toolRow = (tr.rows || []).find(r => r.role === 'tool');
  ok(toolRow && toolRow.ok === true && / ✓/.test(toolRow.text), `R8b 成功的工具行 ok:true(got ${JSON.stringify(toolRow)})`);
  const trBad = await S('steward_thread_read', { sessionId: rdBad });
  const toolRowBad = (trBad.rows || []).find(r => r.role === 'tool');
  ok(toolRowBad && toolRowBad.ok === false && /失败/.test(toolRowBad.text), `R8c 失败的工具行 ok:false 且文本带失败标(got ${JSON.stringify(toolRowBad)})`);
  const st3 = await S('steward_thread_status', { sessionId: rd });
  ok(st3.kind === 'mission', `R8d 普通线程的 kind 不是 quick_ask(got ${st3.kind})`);
  const srch3 = await S('steward_threads_search', { q: '读线程' });
  ok((srch3.results || []).some(r => r.sessionId === rd && r.kind === 'mission'), 'R8e threads_search 的 kind 同样是 mission');

  /* ═════════ R2 missions limit ═════════ */
  for (let i = 0; i < 60; i += 1) await mk('批量事项 ' + i);
  const mAll = await S('steward_missions', {});
  ok(mAll.ok === true && mAll.missions.length === 50 && mAll.total >= 60 && mAll.truncated === true && mAll.count === 50,
    `R2a 默认 limit 50:返回 50 条、total≥60、truncated:true(got ${mAll.missions && mAll.missions.length}/${mAll.total}/${mAll.truncated})`);
  const m5 = await S('steward_missions', { limit: 5 });
  ok(m5.missions.length === 5 && m5.limit === 5, 'R2b limit:5 → 5 条');
  const m999 = await S('steward_missions', { limit: 999 });
  ok(m999.limit === 200 && m999.missions.length <= 200, 'R2c limit 夹取到 200');
  const mFull = await S('steward_missions', { limit: 200 });
  ok(mFull.truncated === (mFull.total > 200) && mFull.missions.length === Math.min(200, mFull.total), 'R2d 不够 limit 时 truncated:false');

  /* ═════════ R3 audit_tail ═════════ */
  const logsDir = path.join(HOME, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const todayFile = path.join(logsDir, `workbench-${today}.ndjson`);
  const ts0 = '2999-01-01T00:00:00.000Z';   // 比真实日志都晚,排在最前
  const lines = [];
  lines.push({ ts: ts0, kind: 'intervention', source: 'ui', sessionId: 'sess_x', action: 'allow', marker: 'APPROVED-1' });
  for (let i = 0; i < 30; i += 1) lines.push({ ts: '2999-01-01T00:00:01.000Z', kind: i % 2 ? 'model_call_started' : 'layout_shadow', i });
  lines.push({ ts: '2999-01-01T00:00:02.000Z', kind: 'turn_start', marker: 'T-A' });
  lines.push({ ts: '2999-01-01T00:00:02.000Z', kind: 'turn_end', marker: 'T-B' });   // 同一毫秒,后写
  fs.appendFileSync(todayFile, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const tail1 = await S('steward_audit_tail', { limit: 5 });
  ok(tail1.ok === true && tail1.entries.every(e => !/^(model_call_|layout_shadow|econ_)/.test(e.type)), `R3a 默认排除遥测(types ${JSON.stringify(tail1.entries.map(e => e.type))})`);
  ok(tail1.entries[0] && tail1.entries[0].detail && tail1.entries[0].detail.marker === 'T-B', `R3b 同一毫秒:后写的 turn_end 在前(修前 limit 1 拿到先写的;got ${JSON.stringify(tail1.entries[0] && tail1.entries[0].detail && tail1.entries[0].detail.marker)})`);
  const one = await S('steward_audit_tail', { limit: 1 });
  ok(one.entries.length === 1 && one.entries[0].detail.marker === 'T-B', 'R3c limit:1 取到的就是最新那条');
  const iv = await S('steward_audit_tail', { kinds: ['intervention'] });
  ok(iv.entries.length >= 1 && iv.entries.every(e => e.type === 'intervention') && iv.entries.some(e => e.detail && e.detail.marker === 'APPROVED-1'),
    `R3d kinds:['intervention'] 能回答「我批准过什么」,哪怕它被 30 条遥测盖在后面(got ${JSON.stringify(iv.entries.map(e => e.type))})`);
  const ivStr = await S('steward_audit_tail', { kinds: 'intervention' });
  ok(ivStr.entries.length >= 1 && ivStr.entries.every(e => e.type === 'intervention'), 'R3e kinds 给单个字符串也认');
  const withTel = await S('steward_audit_tail', { includeTelemetry: true, limit: 100 });
  ok(withTel.entries.some(e => /^(model_call_|layout_shadow)/.test(e.type)), 'R3f includeTelemetry:true 把遥测放回来');
  // 跨日:今天的文件只有 1 条非遥测,往前读昨天的凑够 limit。
  const yesterdayFile = path.join(logsDir, `workbench-${new Date(Date.now() - 86400000 * 2).toISOString().slice(0, 10)}.ndjson`);
  fs.writeFileSync(yesterdayFile, [1, 2, 3].map(i => JSON.stringify({ ts: '2000-01-01T00:00:0' + i + '.000Z', kind: 'mission_start', marker: 'OLD-' + i })).join('\n') + '\n');
  const cross = await S('steward_audit_tail', { kinds: ['mission_start'], limit: 3 });
  ok(cross.entries.length === 3 && cross.entries.every(e => e.type === 'mission_start'), `R3g 最近一个日志文件里不够时往前读(got ${cross.entries.length})`);
  const sch = srv.buildOpenAiTools(await srv.readConfig(), null, { stewardSession: true }).map(x => x.function);
  const auditSchema = sch.find(f => f.name === 'steward_audit_tail');
  ok(auditSchema && auditSchema.parameters.properties.kinds && auditSchema.parameters.properties.includeTelemetry, 'R3h 过滤参数进了 schema');

  /* ═════════ R4 threads_search ═════════ */
  const one1 = await S('steward_threads_search', { q: 'x' });
  ok(one1.ok === true && one1.results.length === 0 && one1.reason === 'query_too_short', `R4a 一个字符的查询 → 空结果 + query_too_short(got ${one1.results && one1.results.length}/${one1.reason})`);
  const searchSchema = sch.find(f => f.name === 'steward_threads_search');
  ok(searchSchema && searchSchema.parameters.properties.includeClosed, 'R4b includeClosed 进了 schema');
  const two = await S('steward_threads_search', { q: '读线' });
  ok(two.ok === true && two.results.length >= 1 && !two.reason, 'R4c 两个字的查询照常');

  /* ═════════ R5 类型 / 枚举校验 ═════════ */
  const uy = await S('steward_usage', { day: 'yesterday' });
  ok(uy.ok === true && /^\d{4}-\d{2}-\d{2}$/.test(uy.scope.day), `R5a usage day:'yesterday' 认成昨天的日期(修前静默回全期累计;got ${JSON.stringify(uy.scope)})`);
  const ub = await S('steward_usage', { day: '2026/13/45 bogus' });
  ok(ub.ok === false && ub.error === 'invalid_request' && /YYYY-MM-DD/.test(ub.message), `R5b usage 非法 day → invalid_request 并列出写法(got ${ub.error})`);
  const uok = await S('steward_usage', { day: '2026-01-02' });
  ok(uok.ok === true && uok.scope.day === '2026-01-02', 'R5c 合法 YYYY-MM-DD 照常');
  const cg = await S('steward_config_get', { keys: 'activeProvider' });
  ok(cg.ok === true && Object.keys(cg.values).join(',') === 'activeProvider', `R5d config_get keys 给字符串 → 当成 [key](修前返回全部键;got ${Object.keys(cg.values || {}).length} 个)`);
  const cgBad = await S('steward_config_get', { keys: 5 });
  ok(cgBad.ok === false && cgBad.error === 'invalid_request', `R5e config_get keys 既不是数组也不是字符串 → invalid_request(got ${cgBad.error})`);
  const ss = await S('steward_self_status', { section: 'bogus' });
  ok(ss.ok === false && ss.error === 'invalid_request' && /identity/.test(ss.message), `R5f self_status 非法 section → invalid_request 并列出可选值(got ${ss.error})`);
  const ssOk = await S('steward_self_status', { section: 'identity' });
  ok(ssOk.ok === true, 'R5g 合法 section 照常');
  const renameTarget = await mk('改名目标');
  const rn = await S('steward_thread_rename', { sessionId: renameTarget, title: { a: 1 } });
  const afterTitle = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', renameTarget + '.json'), 'utf8')).title;
  ok(rn.ok === false && rn.error === 'invalid_request' && afterTitle === '改名目标', `R5h rename title:{a:1} → invalid_request,标题没被改成 [object Object](got ${rn.error}/${afterTitle})`);
  const rnOk = await S('steward_thread_rename', { sessionId: renameTarget, title: '新名字', basis: { origin: 'x' }, stewardBasis: { a: 1 } });
  ok(rnOk.ok === true, `R5i 运行器注入的 basis 等未声明字段不被拒(got ${rnOk.error || 'ok'})`);
  const cont = await S('steward_thread_continue', { sessionId: renameTarget, message: 12345 });
  ok(cont.ok === false && cont.error === 'invalid_request', `R5j continue message:12345 → invalid_request(got ${cont.error})`);
  const tnew = await S('steward_thread_new', { brief: { userText: 'x' }, tier: 'ultra' });
  ok(tnew.ok === false && tnew.error === 'invalid_request', `R5k thread_new tier:'ultra' → invalid_request(修前静默按 strong;got ${tnew.error})`);
  const sc = await S('steward_schedule_create', { title: 'tier 枚举', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'prompt', text: 'x' }, tier: 'ultra' });
  ok(sc.ok === false && sc.error === 'invalid_request', `R5l schedule_create tier:'ultra' → invalid_request(修前静默丢;got ${sc.error})`);

  /* ═════════ R6 config_get MCP env 掩码 ═════════ */
  const cfgGet = await S('steward_config_get', { keys: ['externalMcpServers'] });
  const envVal = cfgGet.values && cfgGet.values.externalMcpServers && cfgGet.values.externalMcpServers[0] && cfgGet.values.externalMcpServers[0].env && cfgGet.values.externalMcpServers[0].env.GITHUB_TOKEN;
  ok(typeof envVal === 'string' && envVal.length > 0 && !/cdef/.test(envVal) && !JSON.stringify(cfgGet).includes('abcdefghijklmnopqrstuvwxyz0123456789'),
    `R6 外部 MCP 的 env 值全遮,不露末 4 位(got ${JSON.stringify(envVal)})`);

  /* ═════════ R7 file_read 凭据 / 二进制 ═════════ */
  for (const rel of ['.env', '.git/config', '.ssh/id_rsa', 'server.pem']) {
    const r = await S('steward_file_read', { path: path.join(WS, rel) });
    ok(r.ok === false && r.error === 'sensitive_path' && !JSON.stringify(r).includes('abcdefghijklmnopqrstuvwxyz'), `R7a ${rel} → sensitive_path(got ${r.error})`);
  }
  const winForm = await S('steward_file_read', { path: WS + '\\.env' });
  ok(winForm.ok === false, 'R7b 反斜杠写法同样拒(按 Windows 形判)');
  const tpl = await S('steward_file_read', { path: path.join(WS, '.env.example') });
  ok(tpl.ok === true && /changeme/.test(tpl.content), `R7c .env.example 模板放行(got ${tpl.error || 'ok'})`);
  const binRead = await S('steward_file_read', { path: path.join(WS, 'bin.dat') });
  ok(binRead.ok === false && binRead.error === 'binary_file', `R7d 含 NUL 的 bin.dat → binary_file(修前回乱码文本;got ${binRead.error})`);
  const plain = await S('steward_file_read', { path: path.join(WS, 'a.txt') });
  ok(plain.ok === true && /line1/.test(plain.content), 'R7e 普通文本照常读');
  const art = await mk('产物线');
  const artFile = path.join(HOME, 'sessions', art + '.json');
  const artHead = JSON.parse(fs.readFileSync(artFile, 'utf8'));
  artHead.mission = { result: { status: 'done', artifacts: [{ path: path.join(WS, 'bin.dat') }, { path: path.join(WS, 'a.txt') }] } };
  fs.writeFileSync(artFile, JSON.stringify(artHead));
  const artBin = await S('steward_thread_artifact_read', { sessionId: art, path: path.join(WS, 'bin.dat') });
  ok(artBin.ok === false && artBin.error === 'binary_file', `R7f artifact_read 二进制同样拒(got ${artBin.error})`);
  const artTxt = await S('steward_thread_artifact_read', { sessionId: art, path: path.join(WS, 'a.txt') });
  ok(artTxt.ok === true, 'R7g artifact_read 文本照常');

  /* ═════════ R10 run_action runId ═════════ */
  const raTarget = await mk('班组目标');
  const ra1 = await S('steward_run_action', { sessionId: raTarget, runId: '../../x', action: 'pause' });
  ok(ra1.ok === false && ra1.error === 'invalid_request' && /runId/.test(ra1.message), `R10a runId 格式非法 → invalid_request(修前 no_agent_run「没有班组可暂停」;got ${ra1.error})`);
  const ra2 = await S('steward_run_action', { sessionId: raTarget, action: 'pause' });
  ok(ra2.ok === false && ra2.error === 'no_agent_run', `R10b 没给 runId 的收紧类仍是 no_agent_run(got ${ra2.error})`);

  /* ═════════ R11 playbook_draft 不为没调模型的失败扣名额 ═════════ */
  const empty = await mk('空线程(没有用户消息)');
  const sameTurn = 4242;
  const d1 = await S('steward_playbook_draft', { sessionId: empty }, { turn: sameTurn });
  ok(d1.ok === false && d1.error === 'draft_failed', `R11a 没有用户消息 → draft_failed(got ${d1.error})`);
  const d2 = await S('steward_playbook_draft', { sessionId: rd }, { turn: sameTurn });
  ok(d2.error !== 'quota_exceeded', `R11b 同一回合再起草一条有用户消息的线程,不被配额挡(修前 quota_exceeded;got ${d2.error})`);
  const d3 = await S('steward_playbook_draft', { sessionId: rd }, { turn: sameTurn });
  ok(d3.error === 'quota_exceeded', `R11c 真调过模型之后名额照旧用掉(got ${d3.error})`);

  /* ═════════ R12 幂等 / expiresAt ═════════ */
  // 走查 #14:来源要带 quote(原话)且写进库的话要与它有共同用词 —— 为这组幂等/时效断言造一条真实的用户消息当来源,
  // 三条记忆文本都出自这句话(不再借用「你好 成功」那条与它们毫无关系的线程)。
  const memSess = await srv.createSession({ title: '记忆来源', cwd: WS });
  const MEM_SAID = '我喜欢先看结论再看过程,这两周在赶一个新项目的交付';
  memSess.messages = [{ role: 'user', content: MEM_SAID, turnSeq: 1, createdAt: new Date().toISOString() }];
  memSess.turnSeq = 1;
  await srv.saveSession(memSess);
  const memSrc = { sessionId: memSess.id, turnSeq: 1, quote: MEM_SAID };
  const w = await S('steward_memory_write', { kind: 'preference', text: '用户喜欢先看结论再看过程', sourceRef: memSrc });
  ok(w.ok === true, `R12a 前提:真实用户消息作来源能写记忆(got ${w.error})`);
  const v1 = await S('steward_memory_veto', { id: w.id });
  await sleep(300);
  const nVeto1 = decisions().filter(d => d.tool === 'steward_memory_veto').length;
  const v2 = await S('steward_memory_veto', { id: w.id });
  await sleep(300);
  const nVeto2 = decisions().filter(d => d.tool === 'steward_memory_veto').length;
  ok(v1.ok === true && v1.undoRef && v1.undoRef.prev === 'active', 'R12b 第一次否决:undoRef.prev 是 active');
  ok(v2.ok === true && v2.unchanged === true && !v2.undoRef && nVeto1 === 1 && nVeto2 === nVeto1, `R12c 第二次否决:unchanged、没有 undoRef、不多一行决策日志(修前 prev:'vetoed' + 多一行;got ${JSON.stringify(v2)} rows ${nVeto1}->${nVeto2})`);
  const wPast = await S('steward_memory_write', { kind: 'focus', text: '这两周在赶一个新项目的交付', sourceRef: memSrc, expiresAt: '2020-01-01T00:00:00Z' });
  ok(wPast.ok === false && wPast.error === 'invalid_request' && /expiresAt/.test(wPast.message), `R12d 已过去的 expiresAt → 拒(修前静默收下;got ${wPast.error})`);
  const wFuture = await S('steward_memory_write', { kind: 'focus', text: '这两周在赶一个新项目的交付', sourceRef: memSrc, expiresAt: '2999-01-01T00:00:00Z' });
  ok(wFuture.ok === true, `R12e 将来的 expiresAt 照常(got ${wFuture.error})`);
  const remind = await S('steward_schedule_create', { title: '幂等检查', schedule: { kind: 'daily', at: '09:30' }, payload: { kind: 'reminder', text: '喝水' } });
  ok(remind.ok === true, `R12f 前提:建一条 reminder(got ${remind.error})`);
  const schedId = remind.task && remind.task.id;
  const p1 = await S('steward_schedule_pause', { id: schedId });
  await sleep(300);   // 决策日志是排队写盘
  const nPause1 = decisions().filter(d => d.tool === 'steward_schedule_pause').length;
  const p2 = await S('steward_schedule_pause', { id: schedId });
  await sleep(300);
  const nPause2 = decisions().filter(d => d.tool === 'steward_schedule_pause').length;
  ok(p1.ok === true && !p1.unchanged && p2.ok === true && p2.unchanged === true && nPause1 === 1 && nPause2 === nPause1, `R12g 已暂停再暂停:unchanged、不多决策行(got ${JSON.stringify(p2).slice(0, 80)} rows ${nPause1}->${nPause2})`);
  const rev = JSON.parse(fs.readFileSync(path.join(HOME, 'scheduler', 'tasks-v1.json'), 'utf8')).tasks.find(x => x.id === schedId).revision;
  const rs1 = await S('steward_schedule_resume', { id: schedId });
  const rs2 = await S('steward_schedule_resume', { id: schedId });
  const rev2 = JSON.parse(fs.readFileSync(path.join(HOME, 'scheduler', 'tasks-v1.json'), 'utf8')).tasks.find(x => x.id === schedId).revision;
  ok(rs1.ok === true && !rs1.unchanged && rs2.unchanged === true && rev2 === rev + 1, `R12h 已在运行再 resume:unchanged,revision 只因第一次 +1(${rev}->${rev2})`);

  /* ═════════ R13 decide 拒绝类 ═════════ */
  const dTarget = await mk('待决目标');
  const ivFile = path.join(HOME, 'sessions', dTarget + '.interventions.ndjson');
  const putIv = (id, extra) => fs.appendFileSync(ivFile, JSON.stringify({
    id, type: 'permission', sessionId: dTarget, status: 'pending', requestedAt: new Date().toISOString(),
    decidedAt: '', decidedBy: '', interventionVersion: 0, ...extra,
  }) + '\n', 'utf8');
  putIv('perm_exempt_a', { toolName: 'send_email', tier: 'read' });
  putIv('perm_exempt_b', { toolName: 'send_email', tier: 'read' });
  putIv('perm_exec_a', { toolName: 'powershell_run', tier: 'exec' });
  const allowExempt = await S('steward_decide', { missionId: dTarget, interventionId: 'perm_exempt_a', action: 'allow' });
  ok(allowExempt.error === 'propose_required' && allowExempt.reason === 'permanently_exempt', `R13a allow 命中永久豁免仍 propose_required(got ${allowExempt.error}/${allowExempt.reason})`);
  const denyExempt = await S('steward_decide', { missionId: dTarget, interventionId: 'perm_exempt_b', action: 'deny' });
  ok(denyExempt.error !== 'propose_required', `R13b deny 命中永久豁免不再被挡(修前 propose_required「必须用户亲自决定」;got ${denyExempt.error}/${denyExempt.reason})`);
  const allowExec = await S('steward_decide', { missionId: dTarget, interventionId: 'perm_exec_a', action: 'allow' });
  ok(allowExec.error === 'propose_required' && allowExec.reason === 'permission_mode', `R13c default 档下 allow 仍 propose_required(got ${allowExec.error}/${allowExec.reason})`);
  const denyExec = await S('steward_decide', { missionId: dTarget, interventionId: 'perm_exec_a', action: 'deny' });
  ok(denyExec.error !== 'propose_required', `R13d default 档下 deny 不再被挡(got ${denyExec.error}/${denyExec.reason})`);
  const denyMissing = await S('steward_decide', { missionId: dTarget, interventionId: 'iv_nope', action: 'deny' });
  ok(denyMissing.error === 'not_found', `R13e 目标待决不存在仍 not_found(got ${denyMissing.error})`);

  /* ═════════ R14 thread_new missionId / quick_ask 逐字 ═════════ */
  const before = fs.readdirSync(path.join(HOME, 'sessions')).filter(f => /^sess_.*\.json$/.test(f)).length;
  const ghost = await S('steward_thread_new', { brief: { userText: '挂到幽灵事项' }, missionId: 'sess_0000000000000000' });
  const after = fs.readdirSync(path.join(HOME, 'sessions')).filter(f => /^sess_.*\.json$/.test(f)).length;
  ok(ghost.ok === false && ghost.error === 'not_found' && after === before, `R14a missionId 不存在 → not_found 且没建出线程(修前建出幽灵事项;got ${ghost.error}, 会话 ${before}->${after})`);
  const real = await S('steward_thread_new', { brief: { userText: '挂到真事项' }, missionId: good });
  ok(real.ok === true && real.missionId === good, `R14b missionId 是一条真实线程的 id(未归类事项)照常归入(got ${real.error || 'ok'})`);
  const QUESTION = '请解释 List<String> 与 a<b 的区别\n第二行';
  const qa = await S('steward_quick_ask', { question: QUESTION });
  ok(qa.ok === true, `R14c quick_ask 起得来(got ${qa.error})`);
  await sleep(1500);
  const qaSess = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', qa.sessionId + '.json'), 'utf8'));
  ok(qaSess.stewardQuick && qaSess.stewardQuick.question === QUESTION, `R14d 存下的速查问题逐字(尖括号/换行不改;got ${JSON.stringify(qaSess.stewardQuick && qaSess.stewardQuick.question)})`);
  const qaFull = await srv.loadSession(qa.sessionId);
  const firstUser = (qaFull.messages || []).find(m => m.role === 'user');
  ok(firstUser && firstUser.content === QUESTION, `R14e 递给线程的首条用户消息逐字(修前是 List＜String＞;got ${JSON.stringify(firstUser && firstUser.content)})`);

  /* ═════════ R17 管家发起的消息不能当记忆来源 ═════════ */
  const viaSteward = await S('steward_thread_new', { brief: { userText: '管家转述给线程的一句话,并不是用户本人说的' } });
  ok(viaSteward.ok === true, 'R17a 前提:thread_new 起得来');
  let relayed = null;
  for (let i = 0; i < 40 && !relayed; i += 1) {
    await sleep(150);
    const full = await srv.loadSession(viaSteward.sessionId);
    relayed = (full && full.messages || []).find(m => m.role === 'user') || null;
  }
  ok(relayed && relayed.meta && relayed.meta.origin === 'steward', `R17b 管家发起的用户消息落盘带 meta.origin:'steward'(got ${JSON.stringify(relayed && relayed.meta)})`);
  const memViaSteward = await S('steward_memory_write', { kind: 'preference', text: '用户其实喜欢把所有事情都交给管家办理', sourceRef: { sessionId: viaSteward.sessionId, turnSeq: relayed ? relayed.turnSeq : 1, quote: '管家转述给线程的一句话' } });
  ok(memViaSteward.ok === false && memViaSteward.error === 'source_not_user', `R17c 以管家转述的消息为来源 → source_not_user(修前写得进去;got ${memViaSteward.error})`);
  const memViaUser = await S('steward_memory_write', { kind: 'preference', text: '用户常让助手先读文件', sourceRef: { sessionId: rd, turnSeq: 1, quote: 'READOK 请读文件' } });
  ok(memViaUser.ok === true, `R17d 用户本人在界面上发的消息仍能当来源(got ${memViaUser.error})`);

  /* ═════════ R15 / R16 schedule ═════════ */
  const base = { title: '校验', schedule: { kind: 'daily', at: '09:00' }, payload: { kind: 'reminder', text: 'x' } };
  const never = await S('steward_schedule_create', { ...base, schedule: { kind: 'cron', expr: '0 0 31 2 *' } });
  ok(never.ok === false && never.error === 'invalid_request' && /never fires/.test(never.message), `R15a 永不触发的 cron → 拒(修前收下且 nextRunAt:'';got ${never.error})`);
  const ghostTarget = await S('steward_schedule_create', { ...base, payload: { kind: 'prompt', text: '做事' }, target: { mode: 'existing-session', sessionId: 'sess_0123456789abcdef' } });
  ok(ghostTarget.ok === false && ghostTarget.error === 'not_found', `R15b existing-session 指向不存在的线程 → not_found(got ${ghostTarget.error})`);
  const stewTarget = await S('steward_schedule_create', { ...base, payload: { kind: 'prompt', text: '做事' }, target: { mode: 'existing-session', sessionId: 'steward' } });
  ok(stewTarget.ok === false && stewTarget.error === 'not_found', `R15c existing-session 指向 steward → not_found(got ${stewTarget.error})`);
  const fastPrompt = await S('steward_schedule_create', { ...base, payload: { kind: 'prompt', text: '做事' }, schedule: { kind: 'cron', expr: '* * * * *' } });
  ok(fastPrompt.ok === false && fastPrompt.error === 'invalid_request' && fastPrompt.reason === 'interval_too_short', `R15d prompt + 每分钟 cron → 拒(got ${fastPrompt.error}/${fastPrompt.reason})`);
  const irregular = await S('steward_schedule_create', { ...base, payload: { kind: 'prompt', text: '做事' }, schedule: { kind: 'cron', expr: '0,5 * * * *' } });
  ok(irregular.ok === false && irregular.reason === 'interval_too_short', 'R15e 不规则 cron(间隔 5、55 交替)按最小间隔判,同样拒');
  const slowPrompt = await S('steward_schedule_create', { ...base, payload: { kind: 'prompt', text: '做事' }, schedule: { kind: 'cron', expr: '*/20 * * * *' } });
  ok(slowPrompt.ok === true, `R15f 每 20 分钟的 prompt 放行(got ${slowPrompt.error})`);
  const fastReminder = await S('steward_schedule_create', { ...base, schedule: { kind: 'cron', expr: '* * * * *' } });
  ok(fastReminder.ok === true, `R15g reminder 仍可每分钟(提醒不调模型;got ${fastReminder.error})`);
  const longText = await S('steward_schedule_create', { ...base, payload: { kind: 'reminder', text: 'y'.repeat(5000) }, tier: 'fast', permissionMode: 'bypass' });
  ok(longText.ok === true && longText.normalized === true && Array.isArray(longText.notes) && longText.notes.length === 3
    && /5000/.test(longText.notes[0]) && /tier/.test(longText.notes.join('|')) && /permissionMode/.test(longText.notes.join('|')),
    `R15h 静默归一列进 notes:截断 / tier 被忽略 / permissionMode 没生效(got ${JSON.stringify(longText.notes)})`);
  const clean = await S('steward_schedule_create', { ...base, title: '无归一' });
  ok(clean.ok === true && !clean.notes && !clean.normalized, 'R15i 没有被改动的创建不带 notes');
  // 到点目标线程没了:run_now 记 failed,不悄悄新开线程
  const tgt = await mk('定时目标线程');
  const ex = await S('steward_schedule_create', { ...base, title: '指向既有线程', payload: { kind: 'prompt', text: '继续做' }, target: { mode: 'existing-session', sessionId: tgt } });
  ok(ex.ok === true, `R15j 前提:指向真实线程的任务建得出来(got ${ex.error})`);
  fs.rmSync(path.join(HOME, 'sessions', tgt + '.json'), { force: true });
  const countSessions = () => fs.readdirSync(path.join(HOME, 'sessions')).filter(f => /^sess_.*\.json$/.test(f)).length;
  const sBefore = countSessions();
  const runGone = await S('steward_schedule_run_now', { id: ex.task.id });
  ok(runGone.ok === true && runGone.outcome === 'failed' && countSessions() === sBefore, `R15k 目标线程没了 → outcome:failed 且没有悄悄新开线程(修前 succeeded + 新线程;got ${runGone.outcome}, 会话 ${sBefore}->${countSessions()})`);

  const runUnattended = await S('steward_schedule_run_now', { id: schedId }, { ctx: { trigger: 'inbox' } });
  ok(runUnattended.ok === false && runUnattended.error === 'propose_required' && runUnattended.reason === 'unattended', `R16a 无人值守(inbox)run_now → propose_required(got ${runUnattended.error})`);
  await S('steward_schedule_pause', { id: schedId });
  const runPaused = await S('steward_schedule_run_now', { id: schedId });
  ok(runPaused.ok === true && runPaused.wasPaused === true && /暂停/.test(runPaused.note), `R16b 暂停中的任务手动跑一次:照跑,但如实带 wasPaused(got ${JSON.stringify(runPaused).slice(0, 140)})`);
  const stillPaused = JSON.parse(fs.readFileSync(path.join(HOME, 'scheduler', 'tasks-v1.json'), 'utf8')).tasks.find(x => x.id === schedId);
  ok(stillPaused.state.enabled === false, 'R16c 手动跑一次不会把它恢复');
  const runNormal = await S('steward_schedule_run_now', { id: remind.task.id === schedId ? clean.task.id : remind.task.id });
  ok(runNormal.ok === true && !runNormal.wasPaused, 'R16d 没暂停的任务照常,不带 wasPaused');

  /* ═════════ R9 prioritize 回包里的 wait ═════════ */
  writeConfig({ stewardMaxParallelThreads: 1, stewardGlobalMaxTurnsPerHour: 2000, stewardGlobalMaxCostPerDay: 0 });
  await sleep(200);
  const pa = await mk('占位A', path.join(WS, 'b')), pb = await mk('排队B', path.join(WS, 'c')), pc = await mk('排队C', path.join(WS, 'd'));
  void runTurn(pa, 'SLOW 占着位子', path.join(WS, 'b')).catch(() => {});
  await sleep(500);
  void runTurn(pb, '先排', path.join(WS, 'c')).catch(() => {});
  await sleep(300);
  void runTurn(pc, '后排', path.join(WS, 'd')).catch(() => {});
  await sleep(500);
  const pri = await S('steward_thread_prioritize', { sessionId: pc });
  ok(pri.ok === true && pri.prioritized === true && pri.wait && pri.wait.reason === 'slot' && pri.wait.ahead === 0,
    `R9 插队后回包的 wait.ahead 是 0(修前是插队前的 1;got ${JSON.stringify(pri.wait)})`);
} catch (e) {
  t.fail('fatal: ' + ((e && e.stack) || e));
}
t.done({ exit: true });
})();
