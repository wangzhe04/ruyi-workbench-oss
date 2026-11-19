'use strict';
// 151 阶段 2B(审查 应改 1):桌面组件(ACC)冷启动慢、赶不上桥接扫描的起动竞速时,能力矩阵不能把它记成「不在」并缓存 60 s、
// 会话快照也不能把这个「不在」冻住 —— 那等于重新引入审计 A3 的症状(首几个回合模型看不到任何桌面工具)。
//   [S1] 起动竞速超时但起动还在进行 = pending:能力缓存只留短 TTL;ACC 起来之后的回合拿得到 ACC 工具,能力行的桌面工具数与工具表一致。
//   [S2] 同一会话:第一回合快照是 pending,全局矩阵定下来之后下一回合升级一次,桌面那一格照旧与工具表一致。
//   [S3] 真起不来(进程直接退出,留下失败记录)才是确定的 present:false,不给 ACC 工具。
// 反向验证:RUYI_TEST_SERVER_JS 指到修前产物(2B v4)时 [S1] 红在 bridgedTools(实得 0)。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { releaseEnvironment } = require('../lib/release-checks');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-turn-slow-acc-'));
const envBefore = { ...process.env };
Object.assign(process.env, releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')),
  { WCW_TEST_NO_NET_ANCHORS: '1', WCW_BRIDGED_ENTRY_START_TIMEOUT_MS: '400' });   // ACC 起动 900 ms > 竞速 400 ms
fs.mkdirSync(process.env.RUYI_HOME, { recursive: true });
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });

const { startFakeProvider, textFrames, usageFrame } = require('../lib/fake-openai-provider');
const { loadServerInternals } = require('../lib/server-internals');
const srv = loadServerInternals(['runSessionTurn', 'createSession', 'killAllMcpClients', 'invalidateCapabilityCache', 'readConfig', 'getCapabilities', 'peekCapabilities'], { withEval: true });
const ev = code => srv.__eval(code);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stubMcp(name, script) {
  const file = path.join(root, `${name}.js`);
  fs.writeFileSync(file, script);
  return file;
}
const SLOW_ACC = stubMcp('slow-acc', `let buf='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(l.trim())h(JSON.parse(l));}});
const send=o=>process.stdout.write(JSON.stringify(o)+'\\n');
function h(m){if(m.method==='initialize')return setTimeout(()=>send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',serverInfo:{name:'acc'},capabilities:{}}}),900);
if(m.method==='tools/list')return send({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'screenshot',inputSchema:{type:'object',properties:{}}}]}});}`);
// [S2] 用更慢的一份(2.5 s),保证负载下第一回合也一定落在它起来之前(只测「升级一次」,不测起动快慢)。
const SLOWER_ACC = stubMcp('slower-acc', require('node:fs').readFileSync(SLOW_ACC, 'utf8').replace('}),900);', '}),2500);'));
const DEAD_ACC = stubMcp('dead-acc', 'process.exit(3);');

let fake = null;
const requests = [];
function writeConfig(accScript) {
  fs.writeFileSync(path.join(process.env.RUYI_HOME, 'config.json'), JSON.stringify({
    configSchema: 13, permissionMode: 'bypass', defaultWorkspace: work, autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false,
    desktopMcp: { enabled: false, autodetect: false }, enableMcpDropIn: false, toolbox: { autoDiscover: false }, stewardThreadBriefV1: false,
    externalMcpServers: [{ id: 'ai-computer-control', label: 'acc', command: process.execPath, args: [accScript], enabled: true }],
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake',
  }));
}
const capLine = text => (String(text).match(/当前能力：[^。\n]*。/) || [''])[0];
async function turn(sessionId) {
  const events = [];
  const before0 = requests.length;
  await srv.runSessionTurn({ sessionId, message: 'hi', cwd: work, source: 'http', onEvent: e => events.push(e) });
  const req = requests.slice(before0).find(r => r.stream);
  const first = req ? (req.messages || []).find(m => m && m.role === 'user') : null;
  const firstText = first ? (Array.isArray(first.content) ? first.content.map(x => x && x.text || '').join('') : String(first.content || '')) : '';
  return { meta: events.find(e => e.type === 'meta') || null, capLine: capLine(firstText) };
}

before(async () => {
  fake = await startFakeProvider({ handler(req) { requests.push(req); return [...textFrames('ok'), usageFrame(5, 1)]; } });
  ev('probeAny = async () => false');   // 离线、当场就有答案:网络那一格是确定值,TTL 只看桌面那一格
});
after(async () => {
  try { srv.killAllMcpClients(); } catch { /* ignore */ }
  try { if (fake) await fake.close(); } catch { /* ignore */ }
  await sleep(300);
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('[S1] ACC 赶不上起动竞速 = pending(短 TTL);起来之后的回合拿得到 ACC 工具,能力行与工具表一致', async () => {
  writeConfig(SLOW_ACC);
  srv.invalidateCapabilityCache();
  const caps = await srv.getCapabilities(await srv.readConfig());   // 开机那一趟探测:ACC 还在起
  assert.equal(caps.desktopMcp.present, false);
  assert.equal(caps.desktopMcp.pending, true, '起动竞速超时但起动还在进行:记 pending,不是确定的「不在」');
  assert.ok(ev('_capCache.ttl') <= 5000, `pending 只缓存几秒(实得 ttl ${ev('_capCache.ttl')})`);
  await sleep(1500);   // ACC 已起来
  for (let i = 0; i < 2; i++) {
    const s = await srv.createSession({ title: 'acc', cwd: work });
    const r = await turn(s.id);
    assert.equal(r.meta && r.meta.bridgedTools, 1, `修前:ACC 起来之后的新会话回合仍拿不到 ACC 工具(第 ${i + 1} 个会话)`);
    assert.ok(r.capLine.includes('桌面操控工具 1 个'), `能力行的桌面工具数与工具表一致:${r.capLine}`);
  }
});

test('[S2] 同一会话:pending 快照在全局矩阵定下来之后升级一次,桌面那一格始终与工具表一致', async () => {
  writeConfig(SLOWER_ACC);
  ev("invalidateMcpRuntime('ai-computer-control')");   // 收掉上一件的 ACC 客户端与目录缓存,从冷起动重来
  ev('mcpClientFailures.clear()');
  srv.invalidateCapabilityCache();
  await srv.getCapabilities(await srv.readConfig());
  const s = await srv.createSession({ title: 'acc2', cwd: work });
  const t1 = await turn(s.id);   // ACC 还没起来:桌面 0 个,工具表里也没有它
  assert.equal(t1.meta && t1.meta.bridgedTools, 0);
  assert.ok(t1.capLine.includes('桌面操控工具 0 个'), t1.capLine);
  await sleep(3200);
  ev('_capCache.at -= 10000');   // 让 pending 的短 TTL 过期,下一次调用重探到真值
  await srv.getCapabilities(await srv.readConfig());
  assert.equal(srv.peekCapabilities().desktopMcp.present, true, '重探之后全局矩阵定了:ACC 在');
  const t2 = await turn(s.id);
  assert.equal(t2.meta && t2.meta.bridgedTools, 1);
  assert.ok(t2.capLine.includes('桌面操控工具 1 个'), `pending 快照升级一次,桌面那一格与工具表一致:${t2.capLine}`);
  const t3 = await turn(s.id);
  assert.equal(t3.capLine, t2.capLine, '升级之后冻结');
});

test('[S4] 桥接关着(bridgeExternalToolsToProvider:false)、ACC 配了但没人去起它:是确定的「不在」,不是 pending,能力缓存照常 60 s', async () => {
  ev("invalidateMcpRuntime('ai-computer-control')");
  ev('mcpClientFailures.clear()');
  const cfgFile = path.join(process.env.RUYI_HOME, 'config.json');
  writeConfig(SLOW_ACC);
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')), bridgeExternalToolsToProvider: false }));
  for (let i = 0; i < 3; i++) {
    srv.invalidateCapabilityCache();
    const caps = await srv.getCapabilities(await srv.readConfig());
    assert.equal(caps.desktopMcp.present, false);
    assert.notEqual(caps.desktopMcp.pending, true, '修前:没有任何起动在进行也记 pending,矩阵永远不定、每 5 s 重探一整轮');
    assert.equal(ev('_capCache.ttl'), 60000);
  }
});

test('[S3] 真起不来(进程直接退出、留下失败记录)才是确定的「不在」,不给 ACC 工具', async () => {
  writeConfig(DEAD_ACC);
  ev("invalidateMcpRuntime('ai-computer-control')");   // 收掉上一件的 ACC 客户端与目录缓存,从冷起动重来
  ev('mcpClientFailures.clear()');
  srv.invalidateCapabilityCache();
  const caps = await srv.getCapabilities(await srv.readConfig());
  assert.equal(caps.desktopMcp.present, false);
  assert.notEqual(caps.desktopMcp.pending, true, '起不来不是 pending');
  const s = await srv.createSession({ title: 'dead', cwd: work });
  const r = await turn(s.id);
  assert.equal(r.meta && r.meta.bridgedTools, 0);
});
