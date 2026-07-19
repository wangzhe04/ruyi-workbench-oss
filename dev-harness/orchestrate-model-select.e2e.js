(async () => {
// E2E: 第30波「AI 自主编排按难度选模型」(含对抗轮修订)。端口 WB 9122(已登记)。
// [S] 静态锁:config 键 + 三写入点/spawn/池 用 resolveNodeModel + propose_task model 通道 + 两引擎注入 buildModelHint
//     (引擎分组)+ Claude 钳拆分 + 【不】白名单丢弃 + inherit→空 归一。
// [P] 纯逻辑源抽取:modelCapabilityTier / buildModelHint(引擎分组) / tierModelForNode(引擎感知+池拓宽) / resolveNodeModel(尊重显式+inherit归空)。
// [H] Live:哑 provider 起 DAG,验证节点 model 在【物化(执行前)】即:显式(合法/未知都尊重原样)/ inherit→空 / 省略→空。
'use strict';
const { readServerSource } = require('./src-reader');
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-orch-model-e2e');
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
const src = readServerSource();

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [S] 静态锁
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [S] 静态锁 ──');
ok(/agentAutoModelTiering: false,/.test(src) && /config\.agentAutoModelTiering = config\.agentAutoModelTiering === true;/.test(src), 'S config agentAutoModelTiering 默认 false(===true 归一,opt-in)');
ok(/function modelCapabilityTier\(id, label\)/.test(src), 'S 能力档位启发式 modelCapabilityTier');
ok(/const MODEL_PRESET_IDS = new Set\(MODEL_PRESETS\.map/.test(src), 'S MODEL_PRESET_IDS(引擎归属判定)');
ok(/function buildModelHint\(config, provider\)/.test(src), 'S 模型档位提示 buildModelHint(引擎分组,2 参带 provider)');
ok(/OpenAI 引擎节点\(engine:openai\)可选/.test(src) && /Claude 引擎节点\(engine:claude\)可选/.test(src), 'S buildModelHint 按引擎分组(防选错)');
ok(/function tierModelForNode\(toolTier, engine, config, provider\)/.test(src), 'S tier 兜底 tierModelForNode(引擎感知)');
ok(/function resolveNodeModel\(rawModel, roleModel, toolTier, engine, config, provider\)/.test(src), 'S 统一解析 resolveNodeModel(带 engine)');
// 对抗轮修:去掉白名单丢弃 + inherit 归空。
ok(!/isKnownModelId/.test(src), 'S 白名单丢弃已移除(isKnownModelId 不再存在 —— 消除误杀真实模型的回归)');
ok(/if \(m === 'inherit'\) m = '';/.test(src), 'S resolveNodeModel: inherit 归一为空(修 OpenAI 把字面量当模型发失败)');
ok(/if \(m\) return m;\s*\/\/ 显式非空 → 原样尊重/.test(src), 'S resolveNodeModel: 显式 model 原样尊重(不白名单丢弃)');
// tier 兜底引擎感知 + 池拓宽。
ok(/if \(engine === 'claude'\) return '';/.test(src), 'S tier 兜底:claude 引擎继承 CLI 默认(不猜)');
ok(/for \(const id of \(config\.knownModels \|\| \[\]\)\) if \(id\) ids\.push\(String\(id\)\);/.test(src) && /\.filter\(id => !MODEL_PRESET_IDS\.has\(id\)\)/.test(src), 'S tier 池拓宽 knownModels/config.model 且排除 Claude 预设别名(修 provider.models=[] 静默失效)');
// 三写入点都走 resolveNodeModel(engine 参)。
ok(/engine, model: resolveNodeModel\(raw\.model, roleModel, explicitTier \|\| \(role && role\.toolTier\) \|\| 'read', engine, config, provider\)/.test(src), 'S 主 DAG 写入点用 resolveNodeModel(带 engine)');
ok(/const poolModel = resolveNodeModel\(item\.model, poolRoleModel \|\| \(proposer && proposer\.model\), toolTier, engine, opts\.config, opts\.provider\);/.test(src), 'S 池物化用 resolveNodeModel');
ok(/model: resolveNodeModel\(sargs\.model, roleDefinition && roleDefinition\.models && roleDefinition\.models\.openai, sargs\.toolTier \|\| \(roleDefinition && roleDefinition\.toolTier\) \|\| 'read', 'openai', config, provider\)/.test(src), 'S spawn_agent 用 resolveNodeModel(engine=openai)');
// propose_task model 通道。
ok(/model: \{ type: 'string', description: '可选。为新节点按任务难易指定模型/.test(src) && /model: String\(args && args\.model \|\| ''\)\.trim\(\)\.slice\(0, 160\), \/\/ 第30波/.test(src), 'S propose_task model 通道(schema + item)');
// 两引擎注入 buildModelHint(带 provider)+ Claude 侧索引信道(第35波 P2: stdin indexSecs)。
ok(/sys \+= buildModelHint\(config, provider\);/.test(src), 'S provider 引擎注入 buildModelHint(带 provider)');
ok(/const oh = buildOrchestrateHint\(wfs\);/.test(src) && /if \(oh\) indexSecs\.push\(oh\);/.test(src) && /const mh = buildModelHint\(config, activeOpenAiProvider\(config\)\);/.test(src) && /if \(mh\) indexSecs\.push\(mh\);/.test(src), 'S Claude 引擎:编排提示与模型提示各自独立进 stdin 索引段(第35波 P2:indexSecs 注入,不再连坐丢弃、不走命令行故无需 % ! 中和)');
// schema 描述改为"填错会失败"(不再宣称"忽略回落")。
ok(/a wrong\/unknown id makes the node fail/.test(src) && /Omit to use the role\/default model/.test(src), 'S orchestrate model 描述改为引擎匹配+填错失败');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [P] 纯逻辑源抽取
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [P] 纯逻辑 ──');
const grab = (re, name) => { const m = src.match(re); ok(!!m, 'P 源抽取 ' + name); return m ? m[0] : ''; };
const offList = grab(/function offlineModelList\(config\) \{[\s\S]*?\n\}/, 'offlineModelList');
const mpresets = grab(/const MODEL_PRESETS = \[[\s\S]*?\];/, 'MODEL_PRESETS');
const presetIds = grab(/const MODEL_PRESET_IDS = new Set\([^;]*\);/, 'MODEL_PRESET_IDS');
const tier = grab(/function modelCapabilityTier\(id, label\) \{[\s\S]*?\n\}/, 'modelCapabilityTier');
const tierLbl = grab(/const MODEL_TIER_LABEL = \{[^}]*\};/, 'MODEL_TIER_LABEL');
const tierUse = grab(/const MODEL_TIER_USE = \{[^}]*\};/, 'MODEL_TIER_USE');
const hint = grab(/function buildModelHint\(config, provider\) \{[\s\S]*?\n\}/, 'buildModelHint');
const tierModel = grab(/function tierModelForNode\(toolTier, engine, config, provider\) \{[\s\S]*?\n\}/, 'tierModelForNode');
const resolve = grab(/function resolveNodeModel\(rawModel, roleModel, toolTier, engine, config, provider\) \{[\s\S]*?\n\}/, 'resolveNodeModel');
const M = new Function(mpresets + '\n' + presetIds + '\n' + tierLbl + '\n' + tierUse + '\n' + offList + '\n' + tier + '\n' + hint + '\n' + tierModel + '\n' + resolve + '\nreturn {modelCapabilityTier,buildModelHint,tierModelForNode,resolveNodeModel};')();

// 能力档位分类。
ok(M.modelCapabilityTier('deepseek-v4-flash', '') === 'fast', 'P flash→快');
ok(M.modelCapabilityTier('qwen3.7-max-preview', '') === 'strong', 'P max→强');
ok(M.modelCapabilityTier('glm-5-2-260617', '') === 'balanced', 'P 无档位词→均衡');
ok(M.modelCapabilityTier('qwen-plus', '') === 'balanced', 'P 对抗轮 P3:plus→均衡(不再误判强)');
ok(M.modelCapabilityTier('deepseek-reasoner', '') === 'strong', 'P reasoner→强');
ok(M.modelCapabilityTier('claude-haiku-4-5', '') === 'fast' && M.modelCapabilityTier('claude-opus-4-8', '') === 'strong', 'P claude haiku/opus 档位');
ok(M.modelCapabilityTier('x', '自定义【快】') === 'fast', 'P 用户标签(快)参与分类');

const cfg = { knownModels: ['deepseek-v4-flash', 'qwen3.7-max-preview'], extraModels: [], model: 'glm-5-2-260617' };
const prov = { id: 'deepseek', model: 'deepseek-v4-flash', models: [{ id: 'deepseek-v4-flash' }, { id: 'qwen3.7-max-preview' }] };
// resolveNodeModel:显式尊重(合法/未知都不丢)+ inherit 归空 + 优先级链。
ok(M.resolveNodeModel('qwen3.7-max-preview', '', 'read', 'openai', cfg, prov) === 'qwen3.7-max-preview', 'P 显式合法→尊重');
ok(M.resolveNodeModel('some-real-but-unlisted', '', 'read', 'openai', cfg, prov) === 'some-real-but-unlisted', 'P 对抗轮:显式【未列出】也尊重(不误杀真实模型 —— 消除回归)');
ok(M.resolveNodeModel('inherit', 'role-x', 'read', 'openai', cfg, prov) === 'role-x', 'P 对抗轮:显式 inherit→归空→落角色(两引擎"用默认"都用空;OpenAI 不发字面量 inherit)');
ok(M.resolveNodeModel('inherit', '', 'read', 'openai', cfg, prov) === '', 'P inherit + 无角色 + tier关 → 空(继承)');
ok(M.resolveNodeModel('', 'role-x', 'read', 'openai', cfg, prov) === 'role-x', 'P 空→角色默认');
ok(M.resolveNodeModel('', '', 'read', 'openai', cfg, prov) === '', 'P 全空+tier关→继承');
const cfgT = Object.assign({}, cfg, { agentAutoModelTiering: true });
ok(M.resolveNodeModel('', '', 'read', 'openai', cfgT, prov) === 'deepseek-v4-flash', 'P tier开:read→快模型');
ok(M.resolveNodeModel('', '', 'exec', 'openai', cfgT, prov) === 'qwen3.7-max-preview', 'P tier开:exec→强模型');
ok(M.resolveNodeModel('', 'role-x', 'exec', 'openai', cfgT, prov) === 'role-x', 'P tier开但角色有默认→角色优先');
ok(M.resolveNodeModel('', '', 'exec', 'claude', cfgT, prov) === '', 'P claude 节点 tier开也继承(不给每个 exec 挑贵模型)');
// tier 兜底:引擎感知 + 池拓宽(provider.models=[] 时仍能从 knownModels 挑)+ 排除预设别名。
ok(M.tierModelForNode('read', 'openai', cfgT, prov) === 'deepseek-v4-flash', 'P tierModelForNode openai/read→快');
ok(M.tierModelForNode('exec', 'openai', cfgT, prov) === 'qwen3.7-max-preview', 'P tierModelForNode openai/exec→强');
ok(M.tierModelForNode('exec', 'claude', cfgT, prov) === '', 'P tierModelForNode claude→空(继承)');
ok(M.tierModelForNode('exec', 'openai', cfgT, { models: [] }) === 'qwen3.7-max-preview', 'P 对抗轮 P3:provider.models=[] 时从 knownModels 挑(不再静默失效)');
ok(M.tierModelForNode('exec', 'openai', { knownModels: [], extraModels: [], model: '' }, { models: [] }) === '', 'P 真无可选自定义模型→空(不从 Claude 预设别名乱挑)');
// 对抗轮 live 修:provider 声明了 models → 优先用它(不混入跨 provider 的 knownModels)。
{
  const provDeep = { id: 'deepseek', model: 'ds-flash', models: [{ id: 'ds-flash' }, { id: 'ds-pro-max' }] };
  const cfgCross = { knownModels: ['qwen-plus', 'ds-flash'], extraModels: [], model: 'glm-x', agentAutoModelTiering: true };
  ok(M.tierModelForNode('exec', 'openai', cfgCross, provDeep) === 'ds-pro-max', 'P live修:provider 声明 models 时 exec 从【当前 provider】挑强(ds-pro-max),不选跨 provider 的 qwen/glm');
  const hCross = M.buildModelHint(cfgCross, provDeep);
  const oa = hCross.slice(hCross.indexOf('OpenAI 引擎节点'), hCross.indexOf('Claude 引擎节点') >= 0 ? hCross.indexOf('Claude 引擎节点') : hCross.length);
  ok(/ds-flash/.test(oa) && /ds-pro-max/.test(oa) && !/qwen-plus/.test(oa) && !/glm-x/.test(oa), 'P live修:OpenAI 组只列当前 provider 声明的模型(不混 knownModels/config.model 的跨 provider 模型)');
}
// buildModelHint 引擎分组。
const h = M.buildModelHint(cfg, prov);
ok(/OpenAI 引擎节点/.test(h) && /Claude 引擎节点/.test(h), 'P buildModelHint 按引擎分组');
ok(/deepseek-v4-flash【快/.test(h) && /qwen3\.7-max-preview【强/.test(h), 'P openai 组含 provider 模型带档位');
// deepseek(openai)清单不应把 Claude 别名 opus 放进 openai 组;opus 应在 Claude 组。
const oaSeg = h.slice(h.indexOf('OpenAI 引擎节点'), h.indexOf('Claude 引擎节点') >= 0 ? h.indexOf('Claude 引擎节点') : h.length);
ok(!/opus|sonnet|haiku/.test(oaSeg), 'P 对抗轮:Claude 预设别名不进 OpenAI 组(防 openai 节点选 claude 别名必失败)');
ok(/须与节点 engine 匹配/.test(h) && /填与引擎不符或不存在的模型会让该节点失败/.test(h), 'P buildModelHint 含引擎匹配 + 填错失败声明');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [H] Live:哑 provider 起 DAG,验证节点 model 在物化(执行前)即正确写盘
// ══════════════════════════════════════════════════════════════════════════════════════════════════
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, permissionMode: 'bypass', defaultWorkspace: WS,
  knownModels: ['fast-mini', 'strong-max-pro'], model: 'balanced-base',
  providers: [{ id: 'dummy', label: 'Dummy', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'fast-mini', models: [{ id: 'fast-mini' }, { id: 'strong-max-pro' }, { id: 'balanced-base' }] }], activeProvider: 'dummy',
}, null, 2));
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
(async () => {
  try {
    console.log('\n── [H] Live ──');
    ok(await up(), 'H workbench up on :' + WB_PORT);
    const token = (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
    const H = { 'x-wcw-token': token };
    const s = (await req('POST', '/api/sessions', { title: 'model', cwd: WS }, H)).json.session;
    const launch = async (nodes) => (await req('POST', '/api/agent-workflow/launch', { token, sessionId: s.id, nodes, async: true }, H)).json;
    const getRun = async (runId) => (await req('GET', '/api/agent-runs/' + runId + '?sessionId=' + encodeURIComponent(s.id), null, H)).json;
    const modelsOf = async (runId) => { for (let i = 0; i < 40; i++) { const j = await getRun(runId); if (j && j.run && Array.isArray(j.run.nodes) && j.run.nodes.length) return Object.fromEntries(j.run.nodes.map(n => [n.id, n.model])); await sleep(150); } return null; };

    const l1 = await launch([
      { id: 'a', task: '简单节点', model: 'fast-mini', engine: 'openai' },
      { id: 'b', task: '复杂节点', model: 'strong-max-pro', engine: 'openai' },
      { id: 'c', task: '未列出但真实的模型', model: 'user-real-model', engine: 'openai' },
      { id: 'd', task: 'inherit 节点', model: 'inherit', engine: 'openai' },
      { id: 'e', task: '省略模型节点', engine: 'openai' },
    ]);
    ok(l1 && l1.runId, 'H1 DAG 启动');
    const m1 = await modelsOf(l1.runId);
    ok(m1 && m1.a === 'fast-mini', 'H1 显式合法(fast-mini)落盘');
    ok(m1 && m1.b === 'strong-max-pro', 'H1 显式合法(strong-max-pro)落盘');
    ok(m1 && m1.c === 'user-real-model', 'H1 对抗轮:显式【未列出】模型原样尊重(不误杀 → 消除回归)');
    ok(m1 && m1.d === '', 'H1 对抗轮:显式 inherit → 归空(OpenAI 不会把字面量 inherit 当模型发失败)');
    ok(m1 && m1.e === '', 'H1 省略 model → 继承(空)');
  } catch (e) { ok(false, 'H 异常:' + (e && e.stack || e)); }
  finally {
    kill(wb);
    console.log('');
    if (fail) { console.log('ORCHESTRATE-MODEL-SELECT E2E: FAIL (' + fail + ')'); process.exit(1); }
    console.log('ORCHESTRATE-MODEL-SELECT E2E: ALL PASS');
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
