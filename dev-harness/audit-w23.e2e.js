// 第23波审计回归锁 —— 八镜头审计确认的 3 P1 + 6 S级P2 修复的行为/契约锁。
// 混合三层: (A) 单元 require(server.js) 直调导出函数; (B) 源抽取 + new Function 实跑未导出逻辑; (C) 起真服务打 HTTP。
//
//  P1 #1 GET 鉴权(rebinding): 敏感内容型 GET(/api/sessions、/:id、/api/skills)对【浏览器调用方】补 UI token,
//        非浏览器回环(e2e/CLI,无 Origin/Sec-Fetch 头)照常;/api/status 等非敏感 GET 不受影响。 —— 实弹(C)
//  P1 #2 文件工具敏感路径拒绝: dataRoot 下 config.json(明文密钥)/sessions/memory/generated 等控制面文件,
//        file_read/file_write 一律拒(否则提示注入 + web_fetch 外传密钥/token)。 —— 抽取(B) + 实弹(C)
//  P1 #3 ocr_find_text 不再判 read(它带 click=真点鼠标)→ 落 exec;纯只读 ocr_screen/ocr_image 仍 read。 —— 单元(A)
//  P2 #4 searchBackend 'none' 改【一次性】迁移: 老配置 none→builtin 一次(开箱即用),之后用户显式 none 持久化。 —— 单元(A)
//  P2 #5 runProcess 超时杀进程树 + 单次结算门(不再只 SIGTERM 直接子进程、只在 close resolve)。 —— 源(B)
//  P2 #6 401/403 归 provider_misconfigured(非 tool_error);测试连接把裸 'HTTP 401' 映射为中文人话。 —— 源(B) + 实弹(C)
//  P2 #7 崩溃恢复: 'interrupted' 死状态并入 retry 的 reset 集合(否则被误诊「依赖图存在环」)。 —— 源(B)
//  P2 #8 saveSession/writeConfigAtomic 唯一 tmp 名(pid+随机),不再固定 '.tmp' 被并发写者互踩成 .corrupt。 —— 源(B)
//  P2 #9 DAG 节点透传 sub.degraded → node.degraded(激活前端「降级完成」渲染,残缺结果不再当干净成功)。 —— 源(B)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const cp = require('child_process');

const WB = path.join(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');

// 端口登记(第23波,均在既有 8792-8999 段之外,避免撞车): WB=8751, fake401=8752。
const WB_PORT = 8751;
const FAKE401_PORT = 8752;

let failures = 0;
function ok(cond, label) { if (cond) console.log('PASS ' + label); else { failures++; console.log('FAIL ' + label); } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 最小 HTTP 客户端: 返回 {status, json}。headers 里可注入 sec-fetch-* 模拟浏览器调用方 / x-wcw-token。
function httpReq(port, method, p, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const opts = { host: '127.0.0.1', port, method, path: p, headers: { ...headers } };
    if (data) { opts.headers['content-type'] = 'application/json'; opts.headers['content-length'] = data.length; }
    const r = http.request(opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* non-json */ } resolve({ status: res.statusCode, json: j, raw: buf }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
async function health(port) { try { const r = await httpReq(port, 'GET', '/api/status'); return r.status === 200; } catch { return null; } }
const BROWSER = { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }; // rebinding 攻击页的浏览器指纹

(async () => {
  // ============ PART A — 单元(require server.js,不起服务) ============
  const mod = require(SERVER);

  // ---- P1 #3: ocr_find_text 不是 read 级(能点鼠标) ----
  ok(typeof mod.bridgedToolTier === 'function', 'bridgedToolTier exported');
  ok(mod.bridgedToolTier('ocr_find_text', null) === 'exec', "P1#3 ocr_find_text → exec(带 click 物理点击,read 子代理不得拿到、非 bypass 点击前弹窗)");
  ok(mod.bridgedToolTier('ocr_screen', null) === 'read' && mod.bridgedToolTier('ocr_image', null) === 'read', "P1#3 ocr_screen/ocr_image 仍 read(纯只读文本定位保留)");
  ok(mod.bridgedToolTier('screenshot', null) === 'read' && mod.bridgedToolTier('find_on_screen', null) === 'read', 'P1#3 screenshot/find_on_screen 仍 read(无 click)');
  ok(mod.bridgedToolTier('mouse_click', null) === 'exec' && mod.bridgedToolTier('ocr_click', null) === 'exec', 'P1#3 明确点击类工具仍 exec');
  ok(mod.bridgedToolTier('ocr_find_text', { bridgedToolTiers: { ocr_find_text: 'read' } }) === 'read', 'P1#3 用户显式 config.bridgedToolTiers 覆盖仍生效(知情自担风险)');

  // ---- P2 #4: searchBackend 'none' 一次性迁移 + 之后持久化 ----
  ok(typeof mod.normalizeConfig === 'function', 'normalizeConfig exported');
  {
    const legacy = mod.normalizeConfig({ searchBackend: { type: 'none' } }).config;
    ok(legacy.searchBackend.type === 'builtin', 'P2#4 老配置(无迁移标记)的 none → builtin(开箱即用一次性迁移)');
    ok(legacy.searchBackendMigrated === true, 'P2#4 迁移后置 searchBackendMigrated=true');
    const explicit = mod.normalizeConfig({ searchBackend: { type: 'none' }, searchBackendMigrated: true }).config;
    ok(explicit.searchBackend.type === 'none', 'P2#4 已迁移后用户显式选 none 正常持久化(气隙产品能真关掉联网)');
    const other = mod.normalizeConfig({ searchBackend: { type: 'searxng', baseUrl: 'http://x' } }).config;
    ok(other.searchBackend.type === 'searxng', 'P2#4 其它 backend 从不被折叠');
    ok(mod.defaultConfig().searchBackend.type === 'builtin' && mod.defaultConfig().searchBackendMigrated === undefined, 'P2#4 defaultConfig 仍 builtin 且【不】预置迁移标记(否则老配置 none 永不迁移)');
  }

  // ============ PART B — 源抽取 / 源形状(未导出逻辑) ============

  // ---- P1 #2: isSensitiveDataPath 抽出实跑(含对抗轮补漏: runtime.json + realpath 对称) ----
  {
    const fnM = src.match(/function isSensitiveDataPath\(p\) \{[\s\S]*?\n\}/);
    const pwM = src.match(/function pathWithinRoot\(target, root\) \{[\s\S]*?\n\}/);
    ok(!!(fnM && pwM), 'P1#2 isSensitiveDataPath + pathWithinRoot 可抽取');
    if (fnM && pwM) {
      const D = path.join('C:', 'data');
      // isSensitiveDataPath 依赖 dataRoot()、_dataRootReal(module let)、pathWithinRoot、path —— 注入/本地声明。
      const make = new Function('path', 'dataRoot', 'let _dataRootReal = null;\n' + pwM[0] + '\n' + fnM[0] + '\nreturn isSensitiveDataPath;');
      const sens = make(path, () => D);
      ok(sens(path.join(D, 'config.json')) === true, 'P1#2 config.json(明文 provider 密钥)拒');
      ok(sens(path.join(D, 'runtime.json')) === true, 'P1#2 runtime.json(明文 WCW_TOKEN)拒 ← 对抗轮补漏');
      ok(sens(path.join(D, 'sessions', 's1.json')) === true, 'P1#2 sessions/ 完整 transcript 拒');
      ok(sens(path.join(D, 'memory', 'global', 'm.md')) === true, 'P1#2 memory/ 跨会话记忆 拒');
      ok(sens(path.join(D, 'generated', 'workbench.mcp.sess.json')) === true, 'P1#2 generated/ 会话 MCP 配置(含 token)拒');
      ok(sens(path.join(D, 'uploads', 'u.png')) === false, 'P1#2 uploads/ 产物 允许(不误伤合法读)');
      ok(sens(path.join(D, 'checkpoints', 'c.gz')) === false, 'P1#2 checkpoints/ 内容 允许');
      // realpath 对称: 注入一个把 junction 根 L 解析到真实根 D 的 _dataRootReal,验证以真实根表达的敏感文件仍被命中。
      const L = path.join('C:', 'link');
      const make2 = new Function('path', 'dataRoot', 'let _dataRootReal = ' + JSON.stringify(D) + ';\n' + pwM[0] + '\n' + fnM[0] + '\nreturn isSensitiveDataPath;');
      const sens2 = make2(path, () => L); // 词法根=L(junction),realpath 根=D
      ok(sens2(path.join(D, 'config.json')) === true, 'P1#2 junction 部署: 以 realpath 后根表达的 config.json 仍拒 ← 对抗轮补漏');
      ok(sens2(path.join(L, 'config.json')) === true, 'P1#2 junction 部署: 以词法根表达的 config.json 仍拒(双根前缀)');
    }
  }

  // ---- P2 #5: runProcess 超时杀进程树 + 单次结算门 ----
  {
    const i = src.indexOf('const finish = payload => {'); // runProcess 内唯一
    const slice = i > 0 ? src.slice(i - 200, i + 1400) : '';
    ok(/killChildTree\(child\.pid\)/.test(slice), 'P2#5 超时用 killChildTree(taskkill /T /F 整树杀),不再只 SIGTERM 直接子进程');
    ok(/let settled = false/.test(slice) && /if \(settled\) return/.test(slice), 'P2#5 单次结算门 finish() 防重复 resolve(close/error/超时兜底共用)');
    ok(/killGraceTimer = setTimeout/.test(slice), 'P2#5 超时后设二次硬兜底(整树杀后 close 仍不触发也不悬挂 promise)');
  }

  // ---- P2 #6a: 回合级 401/403 归 provider_misconfigured(源形状) ----
  {
    const i = src.indexOf("else if (!ok && errorMsg) {");
    const slice = i > 0 ? src.slice(i, i + 700) : '';
    ok(/provider_misconfigured/.test(slice), 'P2#6a 回合失败分类新增 provider_misconfigured 分支');
    ok(/HTTP 401[\s\S]*provider_misconfigured/.test(slice), 'P2#6a 401/403 命中鉴权分支(在 network/tool_error 之前)');
  }

  // ---- P2 #7: interrupted 并入 retry reset ----
  ok(/for \(const n of nodes\) if \(n\.status === 'interrupted'\) reset\.add\(n\.id\);/.test(src),
    "P2#7 续跑把 'interrupted' 死状态并入 reset 重新入队(修「依赖图存在环」误诊)");

  // ---- P2 #8: 唯一 tmp 名 —— 第25波 25.1 后不变量【中心化】到 atomicWriteJson,saveSession/writeConfigAtomic
  //      改为委托调用。锁形态随之迁移:①两处委托在;②中心实现里 pid+随机 tmp + rename 失败 unlink 都在。
  //      (深度断言:并发/无孤儿由 autonomy-durability.e2e 的 A 段实跑覆盖。)----
  {
    const ss = src.slice(src.indexOf('async function saveSession('), src.indexOf('async function saveSession(') + 1400);
    const wc = src.slice(src.indexOf('let configWriteChain'), src.indexOf('let configWriteChain') + 600);
    ok(/atomicWriteJson\(finalPath, payload\)/.test(ss) && /sessionWriteChains/.test(ss), 'P2#8 saveSession 委托 atomicWriteJson + per-id 写链(对抗轮:防重试窗口旧覆新)');
    ok(/atomicWriteJson\(paths\.config, data\)/.test(wc) && /configWriteChain/.test(wc), 'P2#8 writeConfigAtomic 委托 atomicWriteJson + 全局写链');
    const awj = src.slice(src.indexOf('async function atomicWriteJson('), src.indexOf('async function atomicWriteJson(') + 1200);
    ok(/finalPath \+ '\.' \+ process\.pid \+ '\.' \+ crypto\.randomBytes/.test(awj), 'P2#8 atomicWriteJson 用 pid+随机 tmp 名(不变量中心化)');
    ok(/fsp\.unlink\(tmpPath\)/.test(awj), 'P2#8 atomicWriteJson 失败清 tmp(唯一名无覆写自愈路径)');
  }

  // ---- P2 #9: degraded 透传 ----
  ok(/node\.degraded = !!\(sub && sub\.degraded\);/.test(src), 'P2#9 DAG 节点透传 sub.degraded → node.degraded(激活前端「降级完成」渲染)');

  // ---- 节点数上限 bug(回合内 orchestrate 误用 subagentMaxPerTurn)+ 迁移 + 上限放宽 ----
  {
    // 修:in-turn orchestrate 的 maxNodes 用 agentWorkflowMaxNodes,不再用 subagentTurnCap(=subagentMaxPerTurn)
    ok(!/maxNodes: subagentTurnCap - subagentTotal/.test(src), 'BUG 修: 回合内 orchestrate 不再用 subagentTurnCap(=subagentMaxPerTurn)做节点数上限');
    ok((src.match(/maxNodes: Math\.max\(0, Number\(config\.agentWorkflowMaxNodes\)/g) || []).length >= 2, 'BUG 修: in-turn 与 launch 两条 orchestrate 路径都用 agentWorkflowMaxNodes 作节点上限(口径统一,内置模板不再被卡)');
    // 迁移:旧默认 4 → 32(带 flag);deliberate 低值不动;clamp 上限 64;默认 agentWorkflowMaxNodes=48
    const legacy = mod.normalizeConfig({ subagentMaxPerTurn: 4, agentWorkflowMaxNodes: 32 }).config;
    ok(legacy.subagentMaxPerTurn === 32 && legacy.subagentBudgetMigrated === true, '迁移: 存量 subagentMaxPerTurn=4(旧默认)→ 32 + 置 migrated 标记');
    ok(mod.normalizeConfig({ subagentMaxPerTurn: 2 }).config.subagentMaxPerTurn === 2, '迁移: 用户显式低值(2)不被误迁(仅迁恰为旧默认 4 的)');
    ok(mod.normalizeConfig({ subagentMaxPerTurn: 4, subagentBudgetMigrated: true }).config.subagentMaxPerTurn === 4, '迁移: 置位后显式 4 被尊重(不重复迁)');
    ok(mod.normalizeConfig({ agentWorkflowMaxNodes: 100, subagentMaxPerTurn: 100 }).config.agentWorkflowMaxNodes === 64, '上限放宽: 节点数 clamp 上限 32→64');
    ok(mod.defaultConfig().agentWorkflowMaxNodes === 48, '默认 agentWorkflowMaxNodes 调高至 48');
  }

  // ---- 新增节点角色 + 模板拓宽(角色引用必须都在角色库内) ----
  {
    const roles = mod.BUILTIN_AGENT_ROLES.map(r => r.id);
    const roleSet = new Set(roles);
    ok(roles.length === 10, '角色库共 10 个内置角色(含 Coder 与 planner/researcher/critic/synthesizer/analyst),实 ' + roles.length);
    ok(roleSet.has('coder'), '新角色存在: coder');
    for (const nr of ['planner', 'researcher', 'critic', 'synthesizer', 'analyst']) ok(roleSet.has(nr), '新角色存在: ' + nr);
    const wfs = mod.BUILTIN_AGENT_WORKFLOWS;
    ok(wfs.length === 8, '内置模板 8 个(含新 data-insights),实 ' + wfs.length);
    let missing = 0;
    for (const raw of wfs) {
      const wf = mod.normalizeAgentWorkflow(raw, { source: 'builtin', builtin: true });
      if (!wf) { missing++; continue; }
      for (const n of wf.nodes) if (n.role && !roleSet.has(n.role)) { missing++; console.log('  ROLE-MISS', wf.id, n.id, n.role); }
    }
    ok(missing === 0, '每个模板节点引用的 role 都在角色库内(否则运行时「引用了不存在的角色」)');
    // data-insights 用到了新角色
    const di = wfs.find(w => w.id === 'data-insights');
    ok(di && di.nodes.some(n => n.role === 'analyst') && di.nodes.some(n => n.role === 'critic'), 'data-insights 模板用到 analyst + critic 等新角色');
  }

  // ============ PART C — 实弹(起真服务打 HTTP) ============
  const HOME = path.join(os.tmpdir(), 'wcw-audit-w23-e2e');
  const WS = path.join(HOME, 'workspace');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(WS, 'hello.txt'), 'hello from workspace', 'utf8');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-secret-should-never-leak', model: 'm', models: [{ id: 'm', label: 'm' }] }],
    activeProvider: 'fake', defaultWorkspace: WS,
  }, null, 2));

  // fake provider: 任何请求都回 401(供 /api/provider/test 人话化测试)
  const fake401 = http.createServer((rq, rs) => { rs.writeHead(401, { 'content-type': 'application/json' }); rs.end('{"error":{"message":"invalid api key"}}'); });
  await new Promise(r => fake401.listen(FAKE401_PORT, '127.0.0.1', r));

  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  const wbLog = [];
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && wbLog.push(l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && wbLog.push('[!] ' + l.trim())));

  try {
    let up = null; for (let k = 0; k < 40 && !up; k++) { await sleep(150); up = await health(WB_PORT); }
    ok(!!up, 'workbench listening on :' + WB_PORT);
    const rt = JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8'));
    const TOK = rt.token;
    ok(!!TOK, 'runtime.json token 读到');

    // ---- P1 #1: GET 鉴权(rebinding) ----
    const sGuestBrowser = await httpReq(WB_PORT, 'GET', '/api/sessions', { headers: BROWSER });
    ok(sGuestBrowser.status === 403, 'P1#1 GET /api/sessions + 浏览器指纹 + 无 token → 403(挡住 DNS-rebinding 页读走 transcript)');
    const sGuestLoopback = await httpReq(WB_PORT, 'GET', '/api/sessions', {});
    ok(sGuestLoopback.status === 200, 'P1#1 GET /api/sessions 无浏览器头(e2e/CLI 回环)→ 200(本地工具照常,不破坏)');
    const sTokenBrowser = await httpReq(WB_PORT, 'GET', '/api/sessions', { headers: { ...BROWSER, 'x-wcw-token': TOK } });
    ok(sTokenBrowser.status === 200, 'P1#1 GET /api/sessions + 浏览器指纹 + 合法 token → 200(真 UI 照常)');
    const skGuest = await httpReq(WB_PORT, 'GET', '/api/skills', { headers: BROWSER });
    ok(skGuest.status === 403, 'P1#1 GET /api/skills + 浏览器指纹 + 无 token → 403(技能注册表含项目路径)');
    const idGuest = await httpReq(WB_PORT, 'GET', '/api/sessions/anything', { headers: BROWSER });
    ok(idGuest.status === 403, 'P1#1 GET /api/sessions/<id>(完整 transcript)+ 浏览器指纹 + 无 token → 403');
    const statusGuest = await httpReq(WB_PORT, 'GET', '/api/status', { headers: BROWSER });
    ok(statusGuest.status === 200, 'P1#1 对照: /api/status(非敏感)+ 浏览器指纹无 token → 200(不误伤非敏感 GET)');

    // ---- P1 #2: file_read 拒敏感控制面文件(端到端过 guardFileToolPath) ----
    const readCfg = await httpReq(WB_PORT, 'POST', '/api/tools/file_read', { headers: { 'x-wcw-token': TOK }, body: { path: path.join(HOME, 'config.json') } });
    const cfgRes = readCfg.json && readCfg.json.result;
    ok(cfgRes && cfgRes.ok === false, 'P1#2 file_read 读 <dataRoot>/config.json(明文密钥)被拒');
    ok(cfgRes && !String(cfgRes.raw || cfgRes.text || readCfg.raw || '').includes('sk-secret-should-never-leak'), 'P1#2 密钥内容确未随响应外泄');
    const readOk = await httpReq(WB_PORT, 'POST', '/api/tools/file_read', { headers: { 'x-wcw-token': TOK }, body: { path: path.join(WS, 'hello.txt') } });
    const okRes = readOk.json && readOk.json.result;
    ok(okRes && okRes.ok === true, 'P1#2 对照: file_read 读工作区内普通文件 → 成功(不误伤合法读)');

    // ---- P1 #2 对抗轮补漏: runtime.json / 遍历类工具 / preview 全覆盖 ----
    const readRt = await httpReq(WB_PORT, 'POST', '/api/tools/file_read', { headers: { 'x-wcw-token': TOK }, body: { path: path.join(HOME, 'runtime.json') } });
    ok(readRt.json && readRt.json.result && readRt.json.result.ok === false, 'P1#2 file_read 读 runtime.json(明文 WCW_TOKEN)被拒 ← 补漏');
    // file_search 递归进 dataRoot: 不得漏出 config.json 的密钥内容(root=dataRoot,walkFiles 跳过敏感子树)
    const srch = await httpReq(WB_PORT, 'POST', '/api/tools/file_search', { headers: { 'x-wcw-token': TOK }, body: { root: HOME, pattern: 'sk-secret-should-never-leak' } });
    const sm = (srch.json && srch.json.result && srch.json.result.matches) || [];
    ok(Array.isArray(sm) && !sm.some(m => /sk-secret-should-never-leak/.test((m && m.text) || '') || /config\.json$/i.test((m && m.path) || '')), 'P1#2 file_search 遍历 dataRoot 不漏 config.json 密钥内容 ← 补漏(blocker)');
    // 对照: file_search 仍能搜到工作区内普通文件(证明只跳敏感、遍历本身正常)
    const srch2 = await httpReq(WB_PORT, 'POST', '/api/tools/file_search', { headers: { 'x-wcw-token': TOK }, body: { root: HOME, pattern: 'hello from workspace' } });
    const sm2 = (srch2.json && srch2.json.result && srch2.json.result.matches) || [];
    ok(Array.isArray(sm2) && sm2.some(m => /hello\.txt$/i.test((m && m.path) || '')), 'P1#2 对照: file_search 仍能命中工作区内普通文件(遍历未被过度阻断)');
    // file_list dataRoot: 敏感子项不出现在列表
    const lst = await httpReq(WB_PORT, 'POST', '/api/tools/file_list', { headers: { 'x-wcw-token': TOK }, body: { root: HOME } });
    const lf = (lst.json && lst.json.result && lst.json.result.files) || [];
    ok(Array.isArray(lf) && !lf.some(f => /(^|[\\/])(config|runtime)\.json$/i.test((f && f.path) || '') || /[\\/]sessions$/i.test((f && f.path) || '')), 'P1#2 file_list dataRoot 不列出 config/runtime/sessions ← 补漏');
    // /api/file/preview 拒 config.json —— 切断「file_read runtime.json 拿 token → 用 token 打 preview 读密钥」链
    const prev = await httpReq(WB_PORT, 'GET', '/api/file/preview?path=' + encodeURIComponent(path.join(HOME, 'config.json')), { headers: { 'x-wcw-token': TOK } });
    ok(prev.status === 403, 'P1#2 /api/file/preview 拒 config.json(切断 runtime.json→token→preview 读密钥链)← 补漏');

    // ---- P2 #6b: 测试连接把裸 401 映射为中文人话 + errorClass ----
    const test401 = await httpReq(WB_PORT, 'POST', '/api/provider/test', { headers: { 'x-wcw-token': TOK }, body: { provider: { id: 'p', baseUrl: 'http://127.0.0.1:' + FAKE401_PORT, apiKey: 'x' } } });
    const t = test401.json || {};
    ok(t.ok === false && t.errorClass === 'provider_misconfigured', 'P2#6b provider/test 遇 401 → errorClass=provider_misconfigured');
    ok(t.error?.code === 'api.request_failed' && /密钥无效或无权限/.test(String(t.error?.message || '')), 'P2#6b provider/test 401 返回结构化的人话错误');
  } catch (e) {
    failures++; console.log('ERROR(C) ' + (e && e.stack || e));
    if (wbLog.length) console.log('--- wb log tail ---\n' + wbLog.slice(-15).join('\n'));
  } finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    try { fake401.close(); } catch { /* ignore */ }
    await sleep(300);
  }

  console.log('');
  if (failures) { console.log(`AUDIT W23 E2E: ${failures} FAILURE(S)`); process.exit(1); }
  console.log('AUDIT W23 E2E: ALL PASS');
})();
