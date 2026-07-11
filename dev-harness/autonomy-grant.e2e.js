// E2E: 第27波「自主性授权书(Autonomy Grant)」(AUTONOMY-PLAN §27)。
// 端口: WB 9116(已登记 dev-harness/README)。无需 fake provider(授权书路由不触发模型)。
// 三段:
//   [S] 静态源锁 —— 验收锁的结构不变式(签发主权路由、子集律插桩点、R-P1-1 子代理不消耗、exec 不持久、不进 digest)。
//   [P] 纯逻辑源抽取 —— new Function 实跑 grantIssueTierInfo/resolveToolPermissionContext/normalizeGrant/consumeGrant/撤销,
//        穷举 tier×entrypoint×path-glob×cmdAllow×net×metachar×scope×TTL×maxUses×revoke×fail-closed 组合(技术同 scheduler-reducer)。
//   [H] Live HTTP —— 签发主权(body-token 含 body.token===RUNTIME.token 必 403)、签发校验(exec 无 cmdAllow/spawn_agent 拒)、
//        撤销、列举、【纯内存】(grant 不落 session 文件)。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const WB_PORT = 9116;
const HOME = path.join(os.tmpdir(), 'wcw-autonomy-grant-e2e');
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
// [S] 静态源锁
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [S] 静态源锁 ──');

// S1 签发主权律:/api/autonomy/ 在 header-token 白名单(needsToken)里。
const needsTokenLine = (src.match(/const needsToken = pathname\.startsWith[^\n]*/) || [''])[0];
ok(/pathname\.startsWith\('\/api\/autonomy\/'\)/.test(needsTokenLine), 'S1 /api/autonomy/ 在 needsToken 白名单(header-token 门)');

// S2 R-P2-2:/api/autonomy 【不】在 mutating 豁免名单(那行只豁免 permission/request·todo·launch·mission)。
const exemptLine = (src.match(/if \(mutating && pathname !== '\/api\/permission\/request'[^\n]*/) || [''])[0];
ok(exemptLine && !/autonomy/.test(exemptLine), 'S2 /api/autonomy 不在 mutating 豁免名单(不可 body-token 绕过)');

// S3 R-P2-2:三个 autonomy handler 各自 tokenOk(req) 自查,且授权书路由区【无】body-token 兜底。
const autonomyRegion = (src.match(/\/\/ ── 第27波:自主性授权书 API[\s\S]*?if \(req\.method === 'POST' && pathname === '\/api\/agent-workflow\/launch'\)/) || [''])[0];
ok(autonomyRegion.length > 200, 'S3 授权书路由区可定位');
ok((autonomyRegion.match(/if \(!tokenOk\(req\)\) return send\(res, json\(\{ ok: false, error: 'missing or invalid workbench token' \}, 403\)\)/g) || []).length >= 3, 'S3 三路由各自 tokenOk 自查(≥3 处 403)');
ok(!/bodyTokenOk|body\.token === RUNTIME\.token|RUNTIME\.token &&/.test(autonomyRegion), 'S3 授权书路由区【无】body-token 兜底(R-P2-2)');

// S4 子集律插桩:provider 主 gate 仅在 gate==='ask' && !bridge 时 consumeGrant('native');CLI 桥 consumeGrant('cli')。
ok(/if \(gate === 'ask' && !bridge\) \{\s*\n\s*const grantHit = consumeGrant\(session, tc\.name, args, 'native', workingDir\)/.test(src), 'S4 provider 主 gate 消耗点(ask+!bridge, native)');
ok(/const grantHit = consumeGrant\(\{ id: sessionId \}, String\(body\.toolName \|\| ''\), body\.input \|\| \{\}, 'cli', null\)/.test(src), 'S4 CLI 桥消耗点(cli, 命中直接 allow)');
// 对抗轮 P3:CLI 桥消耗点须裹在 nativeToolGate(...)==='ask' 天花板复检内(与 native 对称,plan 模式不放行)。
ok(/if \(nativeToolGate\(config\.permissionMode, bridgeTier\) === 'ask'\) \{\s*\n\s*const grantHit = consumeGrant\(\{ id: sessionId \}/.test(src), 'S4 CLI 桥消耗前复检 permissionMode 天花板(P3 对称)');
// 主 gate 消耗点必须落在 gate==='block' 判定【之前】(子集律:只作用于 ask 分支)。
const nativeConsumeIdx = src.indexOf("consumeGrant(session, tc.name, args, 'native'");
const blockCheckIdx = src.indexOf("if (gate === 'block') {", nativeConsumeIdx - 2000);
ok(nativeConsumeIdx > 0 && blockCheckIdx > nativeConsumeIdx, 'S4 native 消耗点在 gate===block 判定之前(只降 ask,永不碰 block)');

// S5 R-P1-1:runSubAgentCore 内【绝不】调用 consumeGrant(子代理不消耗父授权)。
const subCore = (src.match(/async function runSubAgentCore\([\s\S]*?\nasync function runSubAgent\(opts\)/) || [''])[0];
ok(subCore.length > 1000, 'S5 runSubAgentCore 可定位');
ok(!/consumeGrant/.test(subCore), 'S5 子代理执行体【无】consumeGrant(R-P1-1:不消耗父授权)');

// S6 exec 永不持久:saveSession / normalizeConfig 体内【不】触碰 autonomyGrants。
const saveSessionBody = (src.match(/async function saveSession\(session\) \{[\s\S]*?\n\}/) || [''])[0];
ok(saveSessionBody.length > 100 && !/autonomyGrants/.test(saveSessionBody), 'S6 saveSession 不落 autonomyGrants(不进会话文件)');
const normConfigBody = (src.match(/function normalizeConfig\(raw\) \{[\s\S]*?\n\}\nfunction/) || [''])[0];
ok(!/autonomyGrants/.test(normConfigBody), 'S6 normalizeConfig 不含 autonomyGrants(不进 config)');

// S7 不进 digest/系统提示:任务账本 digest 与系统提示构建体内【无】grant 字段泄漏。
const missionDigest = (src.match(/function buildMissionPromptSection\([\s\S]*?\n\}/) || [''])[0];
ok(missionDigest.length > 50 && !/autonomyGrant|grantRoot|cmdAllow/.test(missionDigest), 'S7 任务账本 digest 不含授权书字段(不进上下文)');

// S8 红线#4:签发路径禁 spawn_agent/orchestrate_agents(grantIssueTierInfo 返 null)。
ok(/if \(t === 'spawn_agent' \|\| t === 'orchestrate_agents' \|\| t === '\*' \|\| !t\) return null/.test(src), 'S8 grantIssueTierInfo 禁 spawn_agent/orchestrate_agents/通配');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [P] 纯逻辑源抽取
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [P] 纯逻辑源抽取(new Function 实跑)──');

// 抽真 globToRegExp / pathWithinRoot(保真,不重写)。
const gm = src.match(/function globToRegExp\(glob\) \{[\s\S]*?\n\}/);
const globToRegExp = new Function(gm[0] + '\nreturn globToRegExp;')();
const pm = src.match(/function pathWithinRoot\(target, root\) \{[\s\S]*?\n\}/);
const pathWithinRoot = new Function('path', pm[0] + '\nreturn pathWithinRoot;')(path);

// 抽授权书核心块(autonomyGrants 声明 → listGrantsView 结束)。
const mm = src.match(/const autonomyGrants = new Map\(\);[\s\S]*?\nfunction listGrantsView\(sessionId\) \{[\s\S]*?\n\}/);
ok(!!mm, 'P 源抽取授权书核心块');
if (!mm) { console.log('\nAUTONOMY-GRANT E2E: FAIL (源抽取失败)'); process.exit(1); }

const NATIVE_TOOL_TIER_STUB = {
  file_read: 'read', file_list: 'read', file_write: 'edit', file_edit: 'edit', file_delete: 'edit',
  file_move: 'edit', file_copy: 'edit', archive_zip: 'edit', archive_unzip: 'edit', http_download: 'edit',
  powershell_run: 'exec', script_run: 'exec', git_commit: 'exec', spawn_agent: 'exec', orchestrate_agents: 'exec',
};
const nativeToolTier = name => NATIVE_TOOL_TIER_STUB[name] || 'exec';
const isSensitiveDataPath = p => /SENSITIVE_MARK/.test(String(p || ''));
const normalizeCwd = (cwd, fb) => path.resolve(cwd || fb || '.');
let _idc = 0; const makeId = pfx => pfx + '_' + (++_idc);
const crypto = require('crypto');
const factory = new Function(
  'NATIVE_TOOL_TIER', 'nativeToolTier', 'globToRegExp', 'isSensitiveDataPath', 'pathWithinRoot', 'normalizeCwd', 'makeId', 'crypto', 'logEvent', 'path',
  mm[0] + '\nreturn { autonomyGrants, activeDriverRuns, grantIssueTierInfo, resolveToolPermissionContext, normalizeGrant, consumeGrant, revokeGrant, revokeAllGrants, revokeGrantsForRun, bindDriverRun, listGrantsView, GRANT_EXEC_METACHARS, GRANT_NET_PATTERN, GRANT_EDIT_AUTOEXEC_DENY };'
);
const G = factory(NATIVE_TOOL_TIER_STUB, nativeToolTier, globToRegExp, isSensitiveDataPath, pathWithinRoot, normalizeCwd, makeId, crypto, () => {}, path);

const ROOT = path.resolve(os.tmpdir(), 'gr-e2e-root');
const SESS = { id: 's1', cwd: ROOT };
const CFG = { defaultWorkspace: ROOT };
const NOW = Date.now();   // 签发用真实钟(consumeGrant 用 Date.now();固定过去值会全判过期)
// helper:签发一张 grant 并入 Map(scope 默认改 'session' 以便无 run 也可测消耗;run scope 单列测)。
function issue(overrides) {
  G.autonomyGrants.clear(); G.activeDriverRuns.clear();
  const norm = G.normalizeGrant({ scope: 'session', ...overrides }, SESS, CFG, NOW);
  if (!norm.ok) return norm;
  G.autonomyGrants.set('s1', [norm.grant]);
  return norm;
}

// P1 grantIssueTierInfo:tier/entrypoint 推断 + 禁令。
ok(G.grantIssueTierInfo('spawn_agent') === null, 'P1 spawn_agent → null(禁签)');
ok(G.grantIssueTierInfo('orchestrate_agents') === null, 'P1 orchestrate_agents → null(禁签)');
ok(G.grantIssueTierInfo('*') === null, 'P1 通配 * → null');
ok(G.grantIssueTierInfo('file_write').entrypoint === 'native' && G.grantIssueTierInfo('file_write').tier === 'edit', 'P1 file_write → native/edit');
ok(G.grantIssueTierInfo('file_read').tier === 'read', 'P1 file_read → read');
ok(G.grantIssueTierInfo('powershell_run').tier === 'exec', 'P1 powershell_run → exec');
ok(G.grantIssueTierInfo('Edit').entrypoint === 'cli' && G.grantIssueTierInfo('Edit').tier === 'edit', 'P1 Edit → cli/edit');
ok(G.grantIssueTierInfo('Bash').entrypoint === 'cli' && G.grantIssueTierInfo('Bash').tier === 'exec', 'P1 Bash → cli/exec');
ok(G.grantIssueTierInfo('nonexistent_tool') === null, 'P1 未知工具 → null(不可签)');
// 对抗轮 P1(field-shadow):script_run 执行 args.code(非可前缀化命令)→ 不可签 exec 授权;git_commit 同理。
ok(G.grantIssueTierInfo('script_run') === null, 'P1 script_run → null(field-shadow:执行 code≠校验字段,禁签 exec)');
ok(G.grantIssueTierInfo('git_commit') === null, 'P1 git_commit → null(触发 .git/hooks,禁签 exec)');
{
  // powershell_run 命令按【真正执行字段 command】取,忽略夹带的 code —— 否则「校验 command、执行 code」= 绕过 cmdAllow 的 RCE。
  const c = G.resolveToolPermissionContext('powershell_run', { command: 'npm run build', code: 'rm -rf /' }, 'native');
  ok(c.cmdArg === 'npm run build', 'P1 field-exact:powershell_run 只取 command,忽略夹带 code');
  const n = G.normalizeGrant({ tool: 'script_run', cmdAllow: ['^npm'], scope: 'session' }, SESS, CFG, NOW);
  ok(n.ok === false, 'P1 script_run 签发被拒(不可签 exec 授权)');
}

// P2 resolveToolPermissionContext:entrypoint 感知参数形状(R-P1-2)。
const cNative = G.resolveToolPermissionContext('file_write', { path: 'C:/x/a.js' }, 'native');
ok(cNative.tier === 'edit' && cNative.pathArgs[0] === 'C:/x/a.js' && cNative.fileFamily, 'P2 native file_write 抽 path');
const cCliEdit = G.resolveToolPermissionContext('Edit', { file_path: 'C:/x/a.js' }, 'cli');
ok(cCliEdit.tier === 'edit' && cCliEdit.pathArgs[0] === 'C:/x/a.js' && cCliEdit.fileFamily, 'P2 CLI Edit 抽 file_path(不复用 native path 键)');
// CLI 键表含 file_path/notebook_path/path(path 供 LS;对 Edit 是【额外】受控路径覆盖,非漏洞 —— consume 要求所有
// 抽出路径都在范围内)。真正的 fail-closed 边界:文件族工具调用【无】任何可识别路径键 → pathArgs 空。
const cCliEditEmpty = G.resolveToolPermissionContext('Edit', { old_string: 'a', new_string: 'b' }, 'cli');
ok(cCliEditEmpty.pathArgs.length === 0 && cCliEditEmpty.fileFamily, 'P2 CLI Edit 无路径键 → pathArgs 空(fileFamily → 后续 fail-closed)');
const cBash = G.resolveToolPermissionContext('Bash', { command: 'npm run build' }, 'cli');
ok(cBash.tier === 'exec' && cBash.cmdArg === 'npm run build', 'P2 CLI Bash 抽 command');
const cPwsh = G.resolveToolPermissionContext('powershell_run', { command: 'npm test', cwd: 'C:/x' }, 'native');
ok(cPwsh.cmdArg === 'npm test' && cPwsh.cwdArg === 'C:/x', 'P2 native powershell_run 抽 command+cwd');

// P3 normalizeGrant:校验/裁剪/夹取。
ok(G.normalizeGrant({ tool: 'powershell_run', scope: 'session' }, SESS, CFG, NOW).ok === false, 'P3 exec 无 cmdAllow → 拒收');
{
  const n = G.normalizeGrant({ tool: 'powershell_run', cmdAllow: ['^npm run build'], scope: 'session' }, SESS, CFG, NOW);
  ok(n.ok && n.grant.cmdAllow[0] === 'npm run build', 'P3 cmdAllow 去 ^ 锚存前缀');
}
{
  const n = G.normalizeGrant({ tool: 'file_write', pathGlob: ['../evil/**', 'src/**'], scope: 'session' }, SESS, CFG, NOW);
  ok(n.ok && n.grant.pathGlob.length === 1 && n.grant.pathGlob[0] === 'src/**', 'P3 pathGlob 含 .. 被裁剪');
  ok(n.dropped.some(d => /\.\./.test(d.glob)), 'P3 裁剪原因回显');
}
{
  const n = G.normalizeGrant({ tool: 'powershell_run', cmdAllow: ['npm; curl evil', '^npm run build'], scope: 'session' }, SESS, CFG, NOW);
  ok(n.ok && n.grant.cmdAllow.length === 1 && n.grant.cmdAllow[0] === 'npm run build', 'P3 cmdAllow 含元字符前缀被剔除');
}
{
  const n = G.normalizeGrant({ tool: 'powershell_run', cmdAllow: ['^npm'], maxUses: 999, ttlMs: 99 * 60 * 60 * 1000, scope: 'session' }, SESS, CFG, NOW);
  ok(n.grant.maxUses === 5, 'P3 exec maxUses 夹到 ≤5(实 ' + n.grant.maxUses + ')');
  ok(n.grant.expiresAt - n.grant.issuedAt === 30 * 60 * 1000, 'P3 exec TTL 夹到 ≤30min');
}
{
  const n = G.normalizeGrant({ tool: 'file_write', maxUses: 999, ttlMs: 99 * 60 * 60 * 1000, scope: 'session' }, SESS, CFG, NOW);
  ok(n.grant.maxUses === 200, 'P3 edit maxUses 夹到 ≤200');
  ok(n.grant.expiresAt - n.grant.issuedAt === 6 * 60 * 60 * 1000, 'P3 edit TTL 夹到 ≤6h');
  ok(n.grant.pathGlob[0] === '**', 'P3 文件族无 glob → 默认 **');
}

// P4 consumeGrant:命中/计数/fail-closed。
{
  issue({ tool: 'file_write', pathGlob: ['src/**'] });
  const hit = G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'src', 'a.js') }, 'native', ROOT);
  ok(hit && hit.remaining === 19, 'P4 范围内 file_write 命中,remaining 递减(20-1)');
  const hit2 = G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'src', 'b.js') }, 'native', ROOT);
  ok(hit2 && hit2.remaining === 18, 'P4 再次命中,usedCount 累进');
  const miss = G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'other', 'c.js') }, 'native', ROOT);
  ok(miss === null, 'P4 glob 外路径 → 不命中(fail-closed)');
}
{
  issue({ tool: 'file_write', pathGlob: ['**'] });
  const miss = G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'SENSITIVE_MARK', 'config.json') }, 'native', ROOT);
  ok(miss === null, 'P4 敏感 denylist 路径 → 不命中(denylist 先行)');
}
{
  issue({ tool: 'file_write', pathGlob: ['**'] });
  const abs = path.resolve(ROOT, '..', 'escape.js');
  const miss = G.consumeGrant(SESS, 'file_write', { path: abs }, 'native', ROOT);
  ok(miss === null, 'P4 越 grantRoot 路径 → 不命中');
}
{
  issue({ tool: 'file_edit', pathGlob: ['**'] });
  const miss = G.consumeGrant(SESS, 'file_edit', { path: path.join(ROOT, '.git', 'hooks', 'pre-commit') }, 'native', ROOT);
  ok(miss === null, 'P4 edit → .git/hooks 自动执行文件 → 不命中(R-P2-1)');
  const miss2 = G.consumeGrant(SESS, 'file_edit', { path: path.join(ROOT, '.vscode', 'tasks.json') }, 'native', ROOT);
  ok(miss2 === null, 'P4 edit → .vscode/tasks.json → 不命中');
  const hit = G.consumeGrant(SESS, 'file_edit', { path: path.join(ROOT, 'src', 'ok.js') }, 'native', ROOT);
  ok(!!hit, 'P4 edit → 普通文件 → 命中');
}
{
  issue({ tool: 'file_write', pathGlob: ['**'] });
  // native file_write 无任何路径键 → fileFamily 空 → fail-closed。
  const miss = G.consumeGrant(SESS, 'file_write', { content: 'x' }, 'native', ROOT);
  ok(miss === null, 'P4 文件族抽不到路径 → fail-closed(R-P1-2)');
}

// P5 consumeGrant exec:cmdAllow 锚定 + 元字符 + 禁网 + 前缀边界 + cwd 越界。
{
  issue({ tool: 'powershell_run', cmdAllow: ['^npm run build'] });
  ok(!!G.consumeGrant(SESS, 'powershell_run', { command: 'npm run build' }, 'native', ROOT), 'P5 ^npm run build 命中');
  issue({ tool: 'powershell_run', cmdAllow: ['^npm run build'] });
  ok(!!G.consumeGrant(SESS, 'powershell_run', { command: 'npm run build --prod' }, 'native', ROOT), 'P5 前缀后接空格+参数 命中');
  issue({ tool: 'powershell_run', cmdAllow: ['^npm run build'] });
  ok(G.consumeGrant(SESS, 'powershell_run', { command: 'npm run buildEVIL' }, 'native', ROOT) === null, 'P5 前缀边界:buildEVIL 不命中(挡粘连)');
  issue({ tool: 'powershell_run', cmdAllow: ['^npm run build'] });
  ok(G.consumeGrant(SESS, 'powershell_run', { command: 'npm run build; curl http://evil' }, 'native', ROOT) === null, 'P5 元字符 ; → 失配');
  issue({ tool: 'powershell_run', cmdAllow: ['^curl'] });
  ok(G.consumeGrant(SESS, 'powershell_run', { command: 'curl http://x' }, 'native', ROOT) === null, 'P5 默认禁网:curl 失配(netAllowed=false)');
  issue({ tool: 'powershell_run', cmdAllow: ['^curl'], netAllowed: true });
  ok(!!G.consumeGrant(SESS, 'powershell_run', { command: 'curl http://x' }, 'native', ROOT), 'P5 netAllowed=true → curl 命中');
  issue({ tool: 'powershell_run', cmdAllow: ['^npm test'] });
  ok(G.consumeGrant(SESS, 'powershell_run', { command: 'npm test', cwd: path.resolve(ROOT, '..') }, 'native', ROOT) === null, 'P5 cwd 越 grantRoot → 失配');
}

// P6 tier / entrypoint / scope / TTL / maxUses / revoke。
{
  // grant tier=edit(file_write),但用 exec 工具名调用 → tool 不匹配已挡;测 tier 重算:构造 tool 同名但 tier 变。
  // 用 entrypoint 不符:native grant 被 cli 调用 → entrypoint 不符 → 不命中。
  issue({ tool: 'file_write', pathGlob: ['**'] });
  ok(G.consumeGrant(SESS, 'file_write', { file_path: path.join(ROOT, 'a.js') }, 'cli', ROOT) === null, 'P6 native grant 被 cli 入口调用 → entrypoint 不符,不命中');
}
{
  // scope='run':未绑定 run(activeDriverRuns 空)→ 不命中;绑定后命中。
  G.autonomyGrants.clear(); G.activeDriverRuns.clear();
  const n = G.normalizeGrant({ tool: 'file_write', pathGlob: ['**'], scope: 'run' }, SESS, CFG, NOW);
  G.autonomyGrants.set('s1', [n.grant]);
  ok(G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'a.js') }, 'native', ROOT) === null, 'P6 scope=run 无活动 run → 不命中');
  G.bindDriverRun('s1', 'drun_1');
  ok(!!G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'a.js') }, 'native', ROOT), 'P6 bindDriverRun 补绑后 → 命中');
  G.activeDriverRuns.set('s1', 'drun_2');
  ok(G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'a.js') }, 'native', ROOT) === null, 'P6 换 run(drun_2)→ 旧 run 授权不命中(scope 隔离)');
}
{
  // TTL 过期:issuedAt 很久前 → expiresAt < Date.now()。用极短 ttl 造过期(normalizeGrant now 参数控制)。
  G.autonomyGrants.clear(); G.activeDriverRuns.clear();
  const past = Date.now() - 10 * 60 * 60 * 1000; // 10h 前
  const n = G.normalizeGrant({ tool: 'file_write', pathGlob: ['**'], scope: 'session', ttlMs: 60 * 1000 }, SESS, CFG, past);
  G.autonomyGrants.set('s1', [n.grant]);
  ok(G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'a.js') }, 'native', ROOT) === null, 'P6 TTL 过期 → 不命中');
}
{
  // maxUses 耗尽:exec maxUses 夹到 5,连消 5 次后第 6 次不命中。
  issue({ tool: 'file_write', pathGlob: ['**'], maxUses: 2 });
  ok(!!G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'a.js') }, 'native', ROOT), 'P6 maxUses=2 第1次命中');
  ok(!!G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'a.js') }, 'native', ROOT), 'P6 第2次命中');
  ok(G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'a.js') }, 'native', ROOT) === null, 'P6 第3次耗尽 → 不命中');
}
{
  // revoke:撤销后下一次必失配。
  const n = issue({ tool: 'file_write', pathGlob: ['**'] });
  ok(!!G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'a.js') }, 'native', ROOT), 'P6 撤销前命中');
  G.revokeGrant('s1', n.grant.grantId);
  ok(G.consumeGrant(SESS, 'file_write', { path: path.join(ROOT, 'a.js') }, 'native', ROOT) === null, 'P6 撤销后 → 不命中(现读无缓存)');
}
{
  // revokeGrantsForRun:只撤匹配 run。
  G.autonomyGrants.clear(); G.activeDriverRuns.clear(); G.bindDriverRun('s1', 'drun_X');
  const a = G.normalizeGrant({ tool: 'file_write', pathGlob: ['**'], scope: 'run' }, SESS, CFG, NOW).grant;
  const b = G.normalizeGrant({ tool: 'file_read', pathGlob: ['**'], scope: 'session' }, SESS, CFG, NOW).grant;
  G.autonomyGrants.set('s1', [a, b]);
  G.revokeGrantsForRun('s1', 'drun_X');
  const live = G.listGrantsView('s1');
  ok(live.length === 1 && live[0].tool === 'file_read', 'P6 revokeGrantsForRun 只撤 scope=run 匹配项,session 授权存活');
}

// ── P7) 对抗验证轮修复(archive_zip 源受控 + move/copy/unzip 可消耗 + .git 尾点)──
console.log('\n── [P7] 对抗验证修复回归 ──');
{
  // P2 GapA:archive_zip 数组源 paths[] 现全部被抽出并逐条校验。
  const c = G.resolveToolPermissionContext('archive_zip', { paths: ['a.txt', 'b.txt'], dest: 'out.zip' }, 'native');
  ok(c.pathArgs.includes('a.txt') && c.pathArgs.includes('b.txt') && c.pathArgs.includes('out.zip'), 'P7 archive_zip 抽全部源(paths[])+dest');
}
{
  // file_move/file_copy 用 from/to;archive_unzip 用 src/destDir —— 现均可抽出。
  const mv = G.resolveToolPermissionContext('file_move', { from: 'x', to: 'y' }, 'native');
  ok(mv.pathArgs.length === 2 && mv.pathArgs.includes('x') && mv.pathArgs.includes('y'), 'P7 file_move 抽 from+to');
  const uz = G.resolveToolPermissionContext('archive_unzip', { src: 's.zip', destDir: 'd' }, 'native');
  ok(uz.pathArgs.includes('s.zip') && uz.pathArgs.includes('d'), 'P7 archive_unzip 抽 src+destDir');
}
{
  // archive_zip 授权:一个源越界 → 整体不命中(源受约束,P2 GapA 闭合)。
  issue({ tool: 'archive_zip', pathGlob: ['**'] });
  const inScope = G.consumeGrant(SESS, 'archive_zip', { paths: [path.join(ROOT, 'a.txt'), path.join(ROOT, 'b.txt')], dest: path.join(ROOT, 'o.zip') }, 'native', ROOT);
  ok(!!inScope, 'P7 archive_zip 全源在范围内 → 命中');
  issue({ tool: 'archive_zip', pathGlob: ['**'] });
  const outSrc = G.consumeGrant(SESS, 'archive_zip', { paths: [path.join(ROOT, 'a.txt'), path.resolve(ROOT, '..', 'secret')], dest: path.join(ROOT, 'o.zip') }, 'native', ROOT);
  ok(outSrc === null, 'P7 archive_zip 有源越 grantRoot → 不命中(源受约束)');
  issue({ tool: 'archive_zip', pathGlob: ['**'] });
  const sensSrc = G.consumeGrant(SESS, 'archive_zip', { paths: [path.join(ROOT, 'SENSITIVE_MARK', 'config.json')], dest: path.join(ROOT, 'o.zip') }, 'native', ROOT);
  ok(sensSrc === null, 'P7 archive_zip 源命中敏感 denylist → 不命中');
}
{
  // file_move:两端都在范围命中;写目标越界不命中。
  issue({ tool: 'file_move', pathGlob: ['**'] });
  ok(!!G.consumeGrant(SESS, 'file_move', { from: path.join(ROOT, 'a'), to: path.join(ROOT, 'b') }, 'native', ROOT), 'P7 file_move 两端在范围 → 命中(不再永久 fail-closed)');
  issue({ tool: 'file_move', pathGlob: ['**'] });
  ok(G.consumeGrant(SESS, 'file_move', { from: path.join(ROOT, 'a'), to: path.resolve(ROOT, '..', 'b') }, 'native', ROOT) === null, 'P7 file_move 目标越界 → 不命中');
}
{
  // .git 尾点/尾空格:组件归一后命中 denylist → 不放行。
  issue({ tool: 'file_edit', pathGlob: ['**'] });
  ok(G.consumeGrant(SESS, 'file_edit', { path: path.join(ROOT, '.git.', 'hooks', 'pre-commit') }, 'native', ROOT) === null, 'P7 .git. 尾点组件 → 归一后仍拦(自动执行文件)');
  issue({ tool: 'file_edit', pathGlob: ['**'] });
  ok(G.consumeGrant(SESS, 'file_edit', { path: path.join(ROOT, '.git ', 'hooks', 'x') }, 'native', ROOT) === null, 'P7 .git␠ 尾空格组件 → 归一后仍拦');
}

// S9 对抗轮 P2 GapB 静态锁:archive_zip/archive_unzip 处理体现调用 guardFileToolPath(源/目标护栏)。
ok(/guardFileToolPath\(path\.resolve\(String\(raw\)\), ctx, \{ tool: 'archive_zip', write: false \}\)/.test(src) && /guardFileToolPath\(dest, ctx, \{ tool: 'archive_zip', write: true \}\)/.test(src), 'S9 archive_zip 源(读)+dest(写)过 guardFileToolPath(Gap B)');
ok(/guardFileToolPath\(src, ctx, \{ tool: 'archive_unzip', write: false \}\)/.test(src) && /guardFileToolPath\(destDir, ctx, \{ tool: 'archive_unzip', write: true \}\)/.test(src), 'S9 archive_unzip src(读)+destDir(写)过 guardFileToolPath(Gap B)');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [H] Live HTTP
// ══════════════════════════════════════════════════════════════════════════════════════════════════
(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(path.join(WS, 'src'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'src', 'a.js'), '// a', 'utf8');
  fs.writeFileSync(path.join(WS, 'src', 'b.js'), '// b', 'utf8');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'default', defaultWorkspace: WS }, null, 2));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  try {
    console.log('\n── [H] Live HTTP ──');
    ok(await up(), 'H workbench up on :' + WB_PORT);
    const token = (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
    const H = { 'x-wcw-token': token };
    const s = (await req('POST', '/api/sessions', { title: 'grant', cwd: WS }, H)).json.session;
    ok(!!s && !!s.id, 'H 建会话');

    // H1 R-P2-2:body-token(含 body.token===RUNTIME.token)【必】403 —— 无 header token。
    const noHdr = await req('POST', '/api/autonomy/grant', { sessionId: s.id, tool: 'file_write', pathGlob: ['src/**'] });
    ok(noHdr.status === 403, 'H1 无 header token → 403');
    const bodyTok = await req('POST', '/api/autonomy/grant', { sessionId: s.id, tool: 'file_write', pathGlob: ['src/**'], token });
    ok(bodyTok.status === 403, 'H1 body.token===RUNTIME.token 但无 header → 仍 403(签发主权律)');

    // H2 签发校验:exec 无 cmdAllow → 400;spawn_agent → 400。
    const execNoCmd = await req('POST', '/api/autonomy/grant', { sessionId: s.id, tool: 'powershell_run' }, H);
    ok(execNoCmd.status === 400, 'H2 exec 无 cmdAllow → 400');
    const spawnGrant = await req('POST', '/api/autonomy/grant', { sessionId: s.id, tool: 'spawn_agent', pathGlob: ['**'] }, H);
    ok(spawnGrant.status === 400, 'H2 spawn_agent 签发 → 400(红线#4)');

    // H3 header-token 签发成功 + dry-run 命中文件 + 列举。
    const good = await req('POST', '/api/autonomy/grant', { sessionId: s.id, tool: 'file_write', pathGlob: ['src/**'], scope: 'session', maxUses: 10 }, H);
    ok(good.status === 200 && good.json.ok && good.json.grant, 'H3 header-token 签发 file_write@src/** 成功');
    ok(good.json.dryRun && good.json.dryRun.count === 2, 'H3 dry-run 命中 2 个 src 文件(所见即所授)实 ' + (good.json.dryRun && good.json.dryRun.count));
    const gid = good.json.grant.grantId;
    const listed = await req('GET', '/api/autonomy/grants?sessionId=' + s.id, null, H);
    ok(listed.json.ok && listed.json.grants.length === 1 && listed.json.grants[0].grantId === gid, 'H3 列举含该 grant');

    // H4 【纯内存】:grant 不落 session 文件(exec 永不持久 §③)。
    const sessFile = readJson(path.join(HOME, 'sessions', s.id + '.json'));
    ok(sessFile && !JSON.stringify(sessFile).includes(gid) && !JSON.stringify(sessFile).includes('autonomyGrants'), 'H4 grant 不落 session 文件(纯内存)');

    // H5 撤销即时生效 + 列举清空。
    const rev = await req('POST', '/api/autonomy/revoke', { sessionId: s.id, grantId: gid }, H);
    ok(rev.json.ok && rev.json.revoked === 1, 'H5 撤销成功');
    const after = await req('GET', '/api/autonomy/grants?sessionId=' + s.id, null, H);
    ok(after.json.grants.length === 0, 'H5 撤销后列举清空');

    // H6 审计:签发/撤销留痕 NDJSON(header token 才可读 /api/audit)。
    const audit = await req('GET', '/api/audit?limit=200', null, H);
    const kinds = (audit.json && audit.json.entries || []).map(e => e.type);
    ok(kinds.includes('autonomy_grant_issued') && kinds.includes('autonomy_grant_revoked'), 'H6 审计含 签发/撤销 事件');
  } catch (e) {
    ok(false, 'H 异常:' + (e && e.message));
  } finally {
    kill(wb);
    console.log('');
    if (fail) { console.log('AUTONOMY-GRANT E2E: FAIL (' + fail + ')'); process.exit(1); }
    console.log('AUTONOMY-GRANT E2E: ALL PASS');
  }
})();
