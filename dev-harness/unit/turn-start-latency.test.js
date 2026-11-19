'use strict';
// 150 S4 / S17 / 发送前并行(151 阶段 2「回合启动提速」)的行为锁。进程内跑真 runSessionTurn(09 runOpenAiTurn)+ 假 provider:
//   [A] 能力矩阵冷缓存 + 锚点不应答:回合不再等 3 s 探测;联网类工具这一回合不给(未知 = 不给,只少不多)。
//   [B] 能力矩阵过期:立刻答旧值、后台起一次重探,本回合不等。
//   [C] 桥接目录:某个 MCP 握手挂住时回合不等它的 3.5 s 竞速,先用已起来的那几个;慢的那个起来后在【下一回合】进工具表。
//   [D] 权限不因旧目录放宽:从配置里删掉 / 停用的 MCP,缓存里还有它的目录也不会再进工具表(回合级 + 函数级)。
//   [E] 发送前并行不改变错误传播:排在前面的一步先抛就抛它;work_data 错误照常上抛、provider 一次都不收;非守卫错误照旧降级;
//       已起跑的其余步骤的拒绝不变成 unhandled rejection;回合被停时预检照旧被取消。
//   [F] 开机首批 CLI 路径探测没落定时 provider 回合不等它;要走 CLI 引擎的回合照旧等(拿真路径);
//       createSession 只在「上一次用的 CLI」那一问时才等。
// 反向验证:RUYI_TEST_SERVER_JS 指到修前 server.js 时 [A][C][F] 的时延断言红(修前分别等满 3 s 探测 / 3.5 s 握手 / CLI 探测)。
// 新函数(capabilitiesForTurn 等)一律经 __eval 现取,修前产物里没有它们时只有用到它们的那几条红,其余照跑。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { releaseEnvironment } = require('../lib/release-checks');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-turn-start-latency-'));
const envBefore = { ...process.env };
Object.assign(process.env, releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')), { WCW_TEST_NO_NET_ANCHORS: '1', WCW_BRIDGED_TURN_WAIT_MS: '500' });   // 回合等桥接目录的上限压到 500 ms(产品 1500)
fs.mkdirSync(process.env.RUYI_HOME, { recursive: true });
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });

const { startFakeProvider, textFrames, usageFrame } = require('../lib/fake-openai-provider');
const { loadServerInternals } = require('../lib/server-internals');
const srv = loadServerInternals(['runSessionTurn', 'createSession', 'stopSession', 'killAllMcpClients', 'invalidateCapabilityCache', 'peekCapabilities', 'readConfig'], { withEval: true });
const ev = code => srv.__eval(code);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let unhandled = 0;
const onUnhandled = () => { unhandled++; };
process.on('unhandledRejection', onUnhandled);

// ── 夹具 ─────────────────────────────────────────────────────────────────────────────────────────
const arrivals = [];
let fake = null, hole = null;
function stubMcp(name, initDelayMs) {
  const file = path.join(root, `${name}.js`);
  fs.writeFileSync(file, `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) handle(JSON.parse(l)); } });
const send = o => process.stdout.write(JSON.stringify(o) + '\\n');
function handle(m) {
  if (m.method === 'initialize') { if (${initDelayMs} < 0) return; return setTimeout(() => send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: '${name}' }, capabilities: {} } }), ${Math.max(0, initDelayMs)}); }
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: '${name}_tool', inputSchema: { type: 'object', properties: {} } }] } });
}
`);
  return { id: name, label: name, command: process.execPath, args: [file], enabled: true };
}
const MCP = { fast: stubMcp('fastmcp', 0), hang: stubMcp('hangmcp', -1), slow: stubMcp('slowmcp', 900) };
function writeConfig(extra = {}) {
  fs.writeFileSync(path.join(process.env.RUYI_HOME, 'config.json'), JSON.stringify({
    configSchema: 13, permissionMode: 'bypass', defaultWorkspace: work, autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false,
    desktopMcp: { enabled: false, autodetect: false }, enableMcpDropIn: false, toolbox: { autoDiscover: false }, stewardThreadBriefV1: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake', ...extra,
  }));
}
let seq = 0;
// 跑一回合,回 { ms: runSessionTurn 起 → provider 收到本回合主请求, meta, error, reached }。
async function turn(sessionId, { timeoutMs = 20000, extraBody = {}, onStarted } = {}) {
  const marker = `tsl-${++seq}-tsl`;
  const events = [];
  const t0 = Date.now();
  const p = srv.runSessionTurn({ sessionId, message: `hello [${marker}]`, cwd: work, source: 'http', onEvent: e => events.push(e), ...extraBody });
  if (onStarted) onStarted();
  await Promise.race([p.catch(e => events.push({ type: 'thrown', error: String(e && e.message || e) })), sleep(timeoutMs)]);
  const hit = arrivals.find(a => a.marker === marker);
  return { ms: hit ? hit.at - t0 : null, reached: !!hit, firstUser: hit ? hit.firstUser : '', tools: hit ? hit.tools : [], meta: events.find(e => e.type === 'meta') || null,
    errors: events.filter(e => e.type === 'error' || e.type === 'thrown').map(e => String(e.error || '')), events };
}
async function newSession() { return (await srv.createSession({ title: 'latency', cwd: work })).id; }

before(async () => {
  fake = await startFakeProvider({ handler(req) {
    if (req.stream) {
      const last = [...(req.messages || [])].reverse().find(m => m && m.role === 'user');
      const text = last ? (Array.isArray(last.content) ? last.content.map(x => x && x.text || '').join('') : String(last.content || '')) : '';
      const marker = (text.match(/tsl-\d+-tsl/) || [''])[0];
      const userText = m => (Array.isArray(m.content) ? m.content.map(x => x && x.text || '').join('') : String(m.content || ''));
      const firstUser = (req.messages || []).find(m => m && m.role === 'user');
      if (marker && !arrivals.some(a => a.marker === marker)) arrivals.push({ marker, at: Date.now(), firstUser: firstUser ? userText(firstUser) : '', tools: (req.tools || []).map(x => x && x.function && x.function.name).filter(Boolean) });
    }
    return [...textFrames('ok'), usageFrame(5, 1)];
  } });
  const sockets = new Set();
  const server = net.createServer(s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  hole = { url: `http://127.0.0.1:${server.address().port}/`, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
  writeConfig();
});
after(async () => {
  try { srv.killAllMcpClients(); } catch { /* ignore */ }
  try { if (fake) await fake.close(); } catch { /* ignore */ }
  try { if (hole) hole.close(); } catch { /* ignore */ }
  await sleep(200);
  process.off('unhandledRejection', onUnhandled);
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── [A][B] 能力矩阵 ───────────────────────────────────────────────────────────────────────────────
test('[A] 冷缓存 + 锚点不应答:回合不等 3 s 探测,联网类工具这一回合不给', async () => {
  writeConfig({ capabilityProbeUrl: hole.url });
  const sid = await newSession();
  srv.invalidateCapabilityCache();
  const r = await turn(sid);
  assert.equal(r.reached, true, 'provider 收到了本回合请求');
  assert.ok(r.ms < 2500, `修前回合入口等满锚点探测(≥3000 ms);实测 ${r.ms} ms`);
  // 同一个冷缓存状态直接问回合口:临时矩阵的联网格是未知/离线,web_fetch / http_download 不满足(只少不多)。
  srv.invalidateCapabilityCache();
  const config = await srv.readConfig();
  const t0 = Date.now();
  const caps = await ev('capabilitiesForTurn')(config);
  assert.ok(Date.now() - t0 < 1500, '冷缓存回合口至多等一小会儿');
  assert.notEqual(caps && caps.network && caps.network.online, true, '锚点没应答前不能报在线');
  for (const name of ['web_fetch', 'http_download']) assert.equal(ev('toolRequirementsMet')(name, caps, false, config).met, false, `${name} 这一回合不给`);
  // 后台那次探测照常跑完、写进缓存(锚点不应答 → 离线),下一回合拿到的是完整矩阵,联网类工具仍不给。
  for (let i = 0; i < 60 && !srv.peekCapabilities(); i++) await sleep(100);
  const full = srv.peekCapabilities();
  assert.ok(full && full.network.online === false, '后台探测写回了缓存(离线)');
  assert.equal(ev('toolRequirementsMet')('web_fetch', full, false, config).met, false);
});

test('[B] 矩阵过期:立刻答旧值并在后台重探,本回合不等', async () => {
  writeConfig({ capabilityProbeUrl: hole.url });
  for (let i = 0; i < 60 && !srv.peekCapabilities(); i++) await sleep(100);
  const stale = srv.peekCapabilities();
  assert.ok(stale, '先有一份缓存');
  ev('_capCache.at -= 10 * 60 * 1000');
  const config = await srv.readConfig();
  const t0 = Date.now();
  const caps = await ev('capabilitiesForTurn')(config);
  assert.ok(Date.now() - t0 < 200, '过期旧值立刻答');
  assert.equal(caps.network, stale.network, '答的就是那份旧值(探测格原样,配置派生格按本回合 config 现算)');
  assert.equal(ev('_capInflight !== null'), true, '后台起了一次重探');
  const sid = await newSession();
  ev('_capCache.at -= 10 * 60 * 1000');
  const r = await turn(sid);
  assert.ok(r.reached && r.ms < 2500, `过期后的回合不等重探;实测 ${r.ms} ms`);
  for (let i = 0; i < 60 && ev('_capInflight !== null'); i++) await sleep(100);
  writeConfig();
});

// ── [C][D] 桥接目录 ───────────────────────────────────────────────────────────────────────────────
test('[G] 按会话冻结能力快照:冷启动的临时矩阵在完整矩阵落定后的下一回合边界升级一次,之后冻结满 60 s;新会话拿新的', async () => {
  writeConfig({ capabilityProbeUrl: hole.url, enableToolRequiresProbe: true });   // http_request 的 network 要求只在这个测试开关下生效
  const capLine = text => (String(text).match(/当前能力：[^。\n]*。/) || [''])[0];
  srv.invalidateCapabilityCache();
  const sid = await newSession();
  const t1 = await turn(sid);   // 冷缓存:锚点 3 s 才超时,这一回合拿到临时矩阵(联网未知)
  assert.equal(t1.reached, true);
  assert.ok(capLine(t1.firstUser).includes('联网状态未知'), capLine(t1.firstUser));
  for (let i = 0; i < 60 && !srv.peekCapabilities(); i++) await sleep(100);   // 后台探测落定(离线)
  assert.equal(srv.peekCapabilities().network.online, false);
  // 升级一次:下一个回合边界换上完整矩阵(不等 60 s)。
  const t2 = await turn(sid);
  assert.ok(capLine(t2.firstUser).includes('离线'), `临时矩阵在下一回合升级为完整矩阵:${capLine(t2.firstUser)}`);
  const t3 = await turn(sid);
  assert.equal(t2.firstUser, t3.firstUser, '升级之后第二、第三回合的首条 user 逐字节相同');
  // 工具可用性与能力行出自同一份快照。
  assert.deepEqual(t2.tools, t3.tools);
  // 升级只有一次:全局矩阵再变(这里直接换成「在线」的一份),这条会话照旧冻结。
  ev('_capCache = { at: Date.now(), ttl: 60000, value: { ..._capCache.value, network: { online: true, checkedAt: new Date().toISOString() } } }');
  const t4 = await turn(sid);
  assert.equal(capLine(t4.firstUser), capLine(t3.firstUser), '升级过一次之后不再升级,冻结到满 60 s');
  // 新会话拿当前那份(在线)。
  const other = await turn(await newSession());
  assert.ok(capLine(other.firstUser).includes('在线'), capLine(other.firstUser));
  // 这条会话的快照满 60 s 后换成新的。
  ev(`_capSessionSnapshots.get(${JSON.stringify(sid)}).at -= 61000`);
  const t5 = await turn(sid);
  assert.ok(capLine(t5.firstUser).includes('在线'), capLine(t5.firstUser));
  // 冻结不放宽权限:当前 config 关掉的工具(allowCommandTools:false 去掉 shell 类)即便快照没变也当回合就不给。
  writeConfig({ capabilityProbeUrl: hole.url, enableToolRequiresProbe: true, allowCommandTools: false });
  const t6 = await turn(sid);
  assert.ok(t5.tools.includes('powershell_run'), '夹具自检:开着命令工具时本回合有 powershell_run');
  assert.ok(!t6.tools.includes('powershell_run'), '快照没变,当前 config 关掉的命令工具当回合就不给(冻结不放宽权限)');
  writeConfig();
});

test('[G4] 冷启动会话 ≥4 回合、完整矩阵在中途任一点落定:首条 user 全程至多变一次、只从临时变完整,变之后相邻回合逐字节相同', async () => {
  writeConfig({ capabilityProbeUrl: hole.url });
  const saved = ev('probeAny');
  let landAll = () => {};
  try {
    for (const landAfter of [1, 2, 3, 4]) {
      // 联网探测由测试决定何时落定(确定性,不依赖负载):落定前回合入口只能拼临时矩阵。
      // 每次被调到都记下它的 resolve:落定时一并放行,收尾时也一并放行(不留永不落定的在飞探测给后面的件)。
      const pendingLands = [];
      const land = () => { while (pendingLands.length) pendingLands.shift()(false); };
      globalThis.__tslProbe = () => new Promise(resolve => { pendingLands.push(resolve); });
      landAll = land;
      ev('probeAny = globalThis.__tslProbe');
      srv.invalidateCapabilityCache();
      const sid = await newSession();
      const firsts = [];
      for (let i = 1; i <= 7; i++) {
        firsts.push((await turn(sid)).firstUser);
        if (i === landAfter) {
          land();
          for (let k = 0; k < 50 && !srv.peekCapabilities(); k++) await sleep(50);
          assert.ok(srv.peekCapabilities(), '完整矩阵已落定');
        }
        // 再往后全局矩阵又变一次(在线):冻结期内这条会话不许再跟着变。
        if (i === landAfter + 2) ev('_capCache = { at: Date.now(), ttl: 60000, value: { ..._capCache.value, network: { online: true, checkedAt: new Date().toISOString() } } }');
      }
      // 能力行(全部回合,含第一回合):至多变一次,且只从「联网状态未知」(临时)变成「离线」(完整),不会变回去。
      const capLine = text => (String(text).match(/当前能力：[^。\n]*。/) || [''])[0];
      const caps = firsts.map(capLine);
      const capChanges = [];
      for (let i = 1; i < caps.length; i++) if (caps[i] !== caps[i - 1]) capChanges.push(i);
      assert.ok(capChanges.length <= 1, `落定于第 ${landAfter} 回合后:能力行变了 ${capChanges.length} 次`);
      assert.ok(caps[0].includes('联网状态未知'), '冷启动第一回合是临时矩阵');
      if (capChanges.length) assert.ok(caps[capChanges[0] - 1].includes('联网状态未知') && caps[capChanges[0]].includes('离线'), '唯一的一次变化只从临时变完整');
      // 整条首条 user(第二回合起;第一回合首条 user 就是末条 user,带着只贴末条的回执尾巴,本来就与之后不同):
      // 至多变一次,且只在能力行升级的那一回合变;变之后相邻回合逐字节相同。
      const tail = firsts.slice(1);
      const changes = [];
      for (let i = 1; i < tail.length; i++) if (tail[i] !== tail[i - 1]) changes.push(i + 1);
      assert.ok(changes.length <= 1, `落定于第 ${landAfter} 回合后:首条 user 变了 ${changes.length} 次(位置 ${changes.join(',')})`);
      if (changes.length) {
        assert.equal(changes[0], capChanges[0], '首条 user 只在能力行升级那一回合变');
        for (let i = changes[0] + 1; i < firsts.length; i++) assert.equal(firsts[i], firsts[i - 1], `变化之后第 ${i} 与第 ${i + 1} 回合逐字节相同`);
      }
      assert.ok(!firsts.slice(-1)[0].includes('联网状态未知'), '最终用上了完整矩阵(不会一直停在临时矩阵)');
    }
  } finally {
    landAll();
    globalThis.__tslProbe = saved; ev('probeAny = globalThis.__tslProbe'); delete globalThis.__tslProbe;
    for (let k = 0; k < 40 && ev('_capInflight !== null'); k++) await sleep(50);
    srv.invalidateCapabilityCache();
    writeConfig();
  }
});

test('[G3] 一开始就拿到完整矩阵的会话不升级;采用全局矩阵时 60 s 从它自己的探测时刻起算', async () => {
  writeConfig({ capabilityProbeUrl: hole.url });
  await ev('getCapabilities')(await srv.readConfig());   // 先有一份完整的全局矩阵(锚点不应答,约 3 s 后判离线)
  ev('_capCache.at = Date.now() - 50000');   // 全局那份已探了 50 s
  const sid = await newSession();
  await turn(sid);
  const snap = ev(`_capSessionSnapshots.get(${JSON.stringify(sid)})`);
  assert.ok(Date.now() - snap.at >= 49000, `窗口从矩阵的探测时刻起算(实得已过 ${Date.now() - snap.at} ms),陈旧度不超过约一个 TTL`);
  assert.equal(snap.upgraded, true, '第一份就是完整矩阵:此后不升级,只按冻结规则换');
  writeConfig();
});

test('[G2] 快照说桌面组件不在:桥接目录里已经起来的 ACC 工具这一回合也不给(能力行与工具表一致);快照说在才给', async () => {
  // 用一个 id 为 ai-computer-control 的外部条目充当桌面组件(desktopMcp 关着,不会撞 id)。
  writeConfig({ externalMcpServers: [{ ...MCP.fast, id: 'ai-computer-control' }] });
  const sid = await newSession();
  const first = await turn(sid);
  assert.equal(first.reached, true);
  const base = ev(`_capSessionSnapshots.get(${JSON.stringify(sid)})`).value;
  globalThis.__tslSnap = { ...base, desktopMcp: { present: false, toolCount: 0, optional: { ocr: false, uia: false, cv2: false, playwright: false } } };
  ev(`_capSessionSnapshots.set(${JSON.stringify(sid)}, { at: Date.now(), value: globalThis.__tslSnap })`);
  const hidden = await turn(sid);
  assert.equal(hidden.meta && hidden.meta.bridgedTools, 0, '快照说不在 → ACC 工具不进本回合工具表');
  globalThis.__tslSnap = { ...base, desktopMcp: { present: true, toolCount: 1, optional: { ocr: false, uia: false, cv2: false, playwright: false } } };
  ev(`_capSessionSnapshots.set(${JSON.stringify(sid)}, { at: Date.now(), value: globalThis.__tslSnap })`);
  const shown = await turn(sid);
  assert.equal(shown.meta && shown.meta.bridgedTools, 1, '快照说在 → 照常给');
  delete globalThis.__tslSnap;
  writeConfig();
});

test('[D3] 作废(invalidateMcpRuntime)之前起跑、之后收尾的扫描不把旧清单写回缓存', async () => {
  writeConfig({ externalMcpServers: [{ ...MCP.slow, id: 'slow-gen' }] });
  const config = await srv.readConfig();
  const entries = ev('resolveExternalMcpServers')(config);
  const key = JSON.stringify(entries.map(e => [e.id, ev('mcpEntryFingerprint')(e)]));
  const scan = ev('collectBridgedTools')(config, false, entries);
  await sleep(100);
  ev('invalidateMcpRuntime')();
  await scan;
  const main = ev('bridgedCatalogCache');
  assert.ok(!(main.value && main.key === key) && !ev('bridgedTurnCatalogs').has(key), '修前:作废之前的扫描收尾时把旧清单写回了缓存');
  writeConfig();
});

test('[C] 某个 MCP 握手挂住:回合不等它,先用已起来的;过期 / 残缺目录立刻答旧值', async () => {
  writeConfig({ externalMcpServers: [MCP.fast, MCP.hang] });
  const sid = await newSession();
  const r = await turn(sid);
  assert.equal(r.reached, true);
  assert.ok(r.ms < 2500, `修前回合入口等挂住那个 MCP 的 3.5 s 握手竞速;实测 ${r.ms} ms`);
  const config = await srv.readConfig();
  for (let i = 0; i < 80 && ev('bridgedCatalogInflights.size > 0'); i++) await sleep(100);   // 后台那次扫描收尾(残缺目录短缓存 1 s)
  await sleep(1100);
  const t0 = Date.now();
  const catalog = await ev('collectBridgedToolsForTurn')(config);
  // 残缺目录过了短缓存:回合入口重扫一次、至多等 300 ms(审查 应改 1:缺的那个可能已经起来了),挂住的那个照旧跳过。
  assert.ok(Date.now() - t0 < 1000, `残缺目录过期后只做一次有界重扫(实测 ${Date.now() - t0} ms)`);
  assert.deepEqual(catalog.tools.map(t => t.function.name), ['fastmcp__fastmcp_tool'], '已起来的那个在,挂住的那个不在');
});

test('[C2] 慢 MCP 只在回合边界补进工具表', async () => {
  writeConfig({ externalMcpServers: [MCP.slow] });
  const sid = await newSession();
  const first = await turn(sid);
  assert.equal(first.reached, true);
  assert.equal(first.meta && first.meta.bridgedTools, 0, '本回合开头它还没起来,不进本回合工具表');
  await sleep(1600);
  const second = await turn(sid);
  assert.equal(second.meta && second.meta.bridgedTools, 1, '起来之后的下一回合就有它');
});

test('[D] 删掉 / 停用的 MCP 不会因缓存继续可用', async () => {
  writeConfig({ externalMcpServers: [MCP.fast] });
  const sid = await newSession();
  const on = await turn(sid);
  assert.equal(on.meta && on.meta.bridgedTools, 1, '在配置里时有它');
  writeConfig({ externalMcpServers: [] });
  const removed = await turn(sid);
  assert.equal(removed.meta && removed.meta.bridgedTools, 0, '从配置里删掉:缓存里的旧目录不再进工具表');
  writeConfig({ externalMcpServers: [{ ...MCP.fast, enabled: false }] });
  const disabled = await turn(sid);
  assert.equal(disabled.meta && disabled.meta.bridgedTools, 0, '停用:同上');
  // 函数级:同一时刻缓存里还留着含它的目录,换成不含它的配置去问,答案里没有它。
  writeConfig({ externalMcpServers: [MCP.fast] });
  const withIt = await ev('collectBridgedToolsForTurn')(await srv.readConfig());
  assert.ok(withIt.route['fastmcp__fastmcp_tool']);
  writeConfig({ externalMcpServers: [] });
  const without = await ev('collectBridgedToolsForTurn')(await srv.readConfig());
  assert.equal(Object.keys(without.route).length, 0);
  assert.equal(without.tools.length, 0);
  writeConfig();
});

test('[C3] 两把 key 交替(桌面探测在飞 / 能力探测那一路)时,回合入口各自命中自己的缓存,不互相顶掉', async () => {
  const forTurn = ev('collectBridgedToolsForTurn');
  writeConfig({ externalMcpServers: [MCP.fast] });
  const k1 = await forTurn(await srv.readConfig());
  writeConfig({ externalMcpServers: [MCP.fast, { ...MCP.slow, id: 'slow2' }] });
  const k2 = await forTurn(await srv.readConfig());
  for (let i = 0; i < 60 && ev('bridgedCatalogInflights.size > 0'); i++) await sleep(100);
  writeConfig({ externalMcpServers: [MCP.fast] });
  const t0 = Date.now();
  const again = await forTurn(await srv.readConfig());
  assert.ok(Date.now() - t0 < 200);
  assert.equal(again, k1, '修前单槽缓存被另一把 key 顶掉,这里要重扫一遍(新对象)');
  assert.notEqual(k2, k1);
  writeConfig();
});

test('[C4] 桌面探测落定让 key 多出桌面条目:回合接着用不带它的那份目录、不等它起动;新配上的 MCP 仍给起动窗口', async () => {
  const forTurn = ev('collectBridgedToolsForTurn');
  const savedPending = ev('desktopMcpDetectionPending');
  try {
    // 桌面条目用挂住的桩(显式 command,走 resolveExternalMcpServers 的显式分支),外加一个起得来的普通 MCP。
    writeConfig({ desktopMcp: { enabled: true, autodetect: false, command: process.execPath, args: [MCP.hang.args[0]] }, externalMcpServers: [MCP.fast] });
    const config = await srv.readConfig();
    ev('desktopMcpDetectionPending = () => true');   // 探测在飞:这一回合按「桌面组件还没起来」
    const pendingCatalog = await forTurn(config);
    assert.deepEqual(pendingCatalog.tools.map(t => t.function.name), ['fastmcp__fastmcp_tool']);
    ev('desktopMcpDetectionPending = () => false');  // 探测落定:key 里多出桌面条目(它握手挂住)
    const t0 = Date.now();
    const next = await forTurn(config);
    assert.ok(Date.now() - t0 < 300, `不为刚有答案的桌面条目再等起动窗口(实测 ${Date.now() - t0} ms)`);
    assert.equal(next, pendingCatalog, '接着用不带它的那份(当前 key 的真子集,只少不多)');
  } finally {
    globalThis.__tslStub = savedPending; ev('desktopMcpDetectionPending = globalThis.__tslStub'); delete globalThis.__tslStub;
    writeConfig();
  }
});

test('[D2] 拼「已起来的部分」时,还在握手的条目先占住自己的前缀(撞前缀的后来者不抢裸前缀)', async () => {
  // pfx-a 与 pfx_a 归一后同为 pfx_a;排在前面的 pfx-a 挂住。部分目录里后来者只能拿带哈希的前缀,
  // 否则下一回合原主人起来把裸前缀拿回去,历史里的 pfx_a__… 调用会被送到另一个服务器。
  writeConfig({ externalMcpServers: [{ ...MCP.hang, id: 'pfx-a' }, { ...MCP.fast, id: 'pfx_a' }] });
  const catalog = await ev('collectBridgedToolsForTurn')(await srv.readConfig());
  const names = catalog.tools.map(t => t.function.name);
  assert.equal(names.length, 1, JSON.stringify(names));
  assert.notEqual(names[0], 'pfx_a__fastmcp_tool', '后来者不拿裸前缀');
  assert.match(names[0], /^pfx_a_[0-9a-f]{6}__fastmcp_tool$/);
  assert.equal(catalog.route[names[0]].serverId, 'pfx_a');
  writeConfig();
});

// ── [E] 发送前并行:错误传播与取消 ──────────────────────────────────────────────────────────────────
function withStubs(stubs, fn) {
  const saved = {};
  for (const name of Object.keys(stubs)) { saved[name] = ev(name); globalThis.__tslStub = stubs[name]; ev(`${name} = globalThis.__tslStub`); }
  delete globalThis.__tslStub;
  return Promise.resolve().then(fn).finally(() => {
    for (const name of Object.keys(saved)) { globalThis.__tslStub = saved[name]; ev(`${name} = globalThis.__tslStub`); }
    delete globalThis.__tslStub;
  });
}
const wdError = (message, code) => Object.assign(new Error(message), { code });

test('[E1] 两步都抛 work_data:抛的是原顺序里排在前面的那一步,provider 一次都不收,无 unhandled rejection', async () => {
  const sid = await newSession();
  const before0 = unhandled;
  let preflightCalls = 0;
  await withStubs({
    resolveEnabledSkillEntries: async () => { await sleep(60); throw wdError('skills-first', 'work_data.key_unavailable'); },
    resolveMemoryPreflight: async () => { preflightCalls++; throw wdError('memory-second', 'work_data.read_failed'); },
  }, async () => {
    const r = await turn(sid);
    assert.equal(preflightCalls, 0, '有副作用的记忆预检不提前起跑:前面一步抛了,它根本没开始(同修前)');
    assert.equal(r.reached, false, 'work_data 错误照常上抛,请求不发');
    assert.ok(r.errors.some(e => e.includes('skills-first')), `原顺序里技能在前:${JSON.stringify(r.errors)}`);
    assert.ok(!r.errors.some(e => e.includes('memory-second')));
  });
  await sleep(100);
  assert.equal(unhandled, before0, '已起跑那一步的拒绝没有变成 unhandled rejection');
});

test('[E4] 技能一步抛 work_data 的回合不为它拉起新的 MCP 子进程(桥接目录排在可能抛错的步骤之后起跑)', async () => {
  const marker = path.join(root, 'spawned-e4.txt');
  const spawnProbe = path.join(root, 'spawn-probe-mcp.js');
  fs.writeFileSync(spawnProbe, `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`);
  // 能力矩阵先热好(不含这个 MCP 的配置下探一次,60 s 内回合不重探):这样本件只量回合入口自己的桥接扫描,
  // 不把能力探测那一路(它为数桌面工具也会扫一遍桥接目录,修前修后同一行为)算进来。
  writeConfig();
  srv.invalidateCapabilityCache();
  await ev('getCapabilities')(await srv.readConfig());
  writeConfig({ externalMcpServers: [{ id: 'spawn-probe-e4', label: 'probe', command: process.execPath, args: [spawnProbe], enabled: true }] });
  const sid = await newSession();
  await withStubs({ resolveEnabledSkillEntries: async () => { throw wdError('skills-wd-e4', 'work_data.key_unavailable'); } }, async () => {
    const r = await turn(sid);
    assert.ok(r.errors.some(e => e.includes('skills-wd-e4')));
  });
  await sleep(800);
  assert.equal(fs.existsSync(marker), false, '修前:桥接扫描先起跑,回合抛错之前已经拉起了 MCP 子进程');
  writeConfig();
});

test('[I] CLI 子代理:开机视图里手填的 npm 垫片(claude.cmd)起子进程前换成核验过的真身', { skip: process.platform !== 'win32' }, async () => {
  const saved = ev('existsExecutableAsync');
  let asked = '';
  globalThis.__tslStub = async command => { asked = command; return false; };
  ev('existsExecutableAsync = globalThis.__tslStub');
  ev("_launcherResolveCache.set('configured-claude.cmd', { at: Date.now(), value: 'verified-claude.exe' })");
  const savedFake = process.env.WCW_FAKE_CLAUDE; delete process.env.WCW_FAKE_CLAUDE;
  try {
    const config = { ...(await srv.readConfig()), claudePath: 'configured-claude.cmd' };   // provider 回合的开机视图配置:垫片原样
    const r = await ev('runClaudeSubAgentOnce')({ config, parentSession: { id: 'sess_tsl_i', cwd: work }, task: 't', displayTask: 't', agentKey: 'k', toolTier: 'read', onEvent: () => {}, subagentId: 'sa', ctrl: new AbortController(), cwd: work });
    assert.equal(r.ok, false);
    assert.equal(asked, 'verified-claude.exe', `修前:子代理拿开机视图里的垫片 ${asked} 去起,经 cmd.exe 撞 8191 上限`);
  } finally {
    globalThis.__tslStub = saved; ev('existsExecutableAsync = globalThis.__tslStub'); delete globalThis.__tslStub;
    ev("_launcherResolveCache.delete('configured-claude.cmd')");
    if (savedFake !== undefined) process.env.WCW_FAKE_CLAUDE = savedFake;
  }
});

test('[E2] 预检 work_data / 隐私错误照常上抛;普通错误照旧降级', async () => {
  const sid = await newSession();
  await withStubs({ resolveMemoryPreflight: async () => { throw wdError('wd-preflight', 'work_data.key_unavailable'); } }, async () => {
    const r = await turn(sid);
    assert.equal(r.reached, false);
    assert.ok(r.errors.some(e => e.includes('wd-preflight')));
  });
  await withStubs({ resolveMemoryPreflight: async () => { throw wdError('privacy-preflight', 'privacy.vault_locked'); } }, async () => {
    const r = await turn(sid);
    assert.equal(r.reached, false);
    assert.ok(r.errors.some(e => e.includes('privacy-preflight')));
  });
  await withStubs({ resolveMemoryPreflight: async () => { throw new Error('ordinary-preflight-failure'); } }, async () => {
    const r = await turn(sid);
    assert.equal(r.reached, true, '非守卫错误:回落空记忆,回合照常');
    assert.equal(r.meta && r.meta.memoryCheck && r.meta.memoryCheck.mode, 'unavailable');
  });
});

test('[E3] 回合被停时预检照旧被取消,请求不发', async () => {
  const sid = await newSession();
  let sawSignal = false;
  await withStubs({
    resolveMemoryPreflight: (session, cwd, ctx, mismatch, config, opts) => new Promise((resolve, reject) => {
      const signal = opts && opts.signal;
      sawSignal = !!signal;
      if (!signal) return;
      signal.addEventListener('abort', () => reject(Object.assign(new Error('preflight aborted'), { name: 'AbortError' })), { once: true });
    }),
  }, async () => {
    const r = await turn(sid, { timeoutMs: 8000, onStarted: () => { setTimeout(() => srv.stopSession(sid, 'stopped'), 400); } });
    assert.equal(sawSignal, true, '预检拿到了本回合的取消信号');
    assert.equal(r.reached, false, '停了就不发');
  });
});

// ── [F] 开机首批 CLI 路径探测 ───────────────────────────────────────────────────────────────────────
function holdBootCliProbes() {
  return ev(`(() => {
    bootCliPathProbes = { beforeListen: false, pending: new Set() };
    let release;
    const job = new Promise(resolve => { release = resolve; });
    bootCliPathProbes.pending.add(job);
    return () => { bootCliPathProbes.pending.delete(job); release(); };
  })()`);
}

test('[F1] provider 回合不等开机 CLI 探测', async () => {
  writeConfig();
  const sid = await newSession();
  const release = holdBootCliProbes();
  const timer = setTimeout(release, 4000);
  try {
    const r = await turn(sid);
    if (!r.reached) console.log('[F1 diag]', JSON.stringify({ capInflight: ev('_capInflight !== null'), bridgedInflights: ev('bridgedCatalogInflights.size'), events: r.events.map(e => e.type).slice(0, 20), errors: r.errors }));
    assert.equal(r.reached, true);
    assert.ok(r.ms < 2500, `修前 runSessionTurn 的配置读等到探测落定(本件 4000 ms 后才放);实测 ${r.ms} ms`);
  } finally { clearTimeout(timer); release(); }
});

test('[F3] 新线程走 CLI 引擎:探测落定之前不建会话(同修前次序),落定之后照常起 CLI 回合', async () => {
  writeConfig({ activeProvider: '' });
  const sessionsDir = path.join(process.env.RUYI_HOME, 'sessions');
  const heads = () => (fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).filter(n => /^sess_[^.]+\.json$/.test(n)).length : 0);
  const before0 = heads();
  const release = holdBootCliProbes();
  let cliTurns = 0;
  try {
    await withStubs({ runClaudeTurn: async () => { cliTurns++; } }, async () => {
      const p = srv.runSessionTurn({ message: 'new cli thread', cwd: work, source: 'http', onEvent: () => {} });
      await sleep(600);
      assert.equal(heads(), before0, '探测落定之前不落新会话');
      assert.equal(cliTurns, 0);
      release();
      await p;
      assert.equal(heads(), before0 + 1, '落定之后建了一条会话');
      assert.equal(cliTurns, 1, 'CLI 回合照常起了一次');
    });
  } finally { release(); writeConfig(); }
});

test('[F2] CLI 引擎回合照旧等探测落定;作用域内显式 wait 照旧等', async () => {
  writeConfig({ activeProvider: '' });
  const sid = await newSession();
  const release = holdBootCliProbes();
  let cliTurnAt = 0;
  try {
    await withStubs({ runClaudeTurn: async () => { cliTurnAt = Date.now(); } }, async () => {
      const t0 = Date.now();
      const p = srv.runSessionTurn({ sessionId: sid, message: 'cli turn', cwd: work, source: 'http', onEvent: () => {} });
      await sleep(600);
      assert.equal(cliTurnAt, 0, 'CLI 回合在探测落定前不起');
      release();
      await p;
      assert.ok(cliTurnAt - t0 >= 550, 'CLI 回合在探测落定之后才起');
    });
    // 作用域里:不带参数的读不等,带 cliPaths:'wait' 的读等;关掉作用域之后不带参数的读也等。
    const release2 = holdBootCliProbes();
    try {
      await ev('runWithProvisionalCliPaths')(async () => {
        const quick = await Promise.race([srv.readConfig().then(() => 'read'), sleep(1500).then(() => 'blocked')]);
        assert.equal(quick, 'read');
        const waited = await Promise.race([srv.readConfig({ cliPaths: 'wait' }).then(() => 'read'), sleep(400).then(() => 'blocked')]);
        assert.equal(waited, 'blocked');
        ev('endProvisionalCliPaths')();
        const after = await Promise.race([srv.readConfig().then(() => 'read'), sleep(400).then(() => 'blocked')]);
        assert.equal(after, 'blocked');
      });
    } finally { release2(); }
    // createSession:只有「上一次用的 CLI」那一问才等。
    writeConfig({ newThreadEngine: 'last', lastUsedEngineRoute: { engine: 'agent', agentCliType: 'claude' } });
    const release3 = holdBootCliProbes();
    try {
      await ev('runWithProvisionalCliPaths')(async () => {
        const r = await Promise.race([srv.createSession({ title: 'x', cwd: work }).then(() => 'created'), sleep(400).then(() => 'blocked')]);
        assert.equal(r, 'blocked', '新线程要按上一次用的 CLI 定引擎:等探测');
      });
      writeConfig({ newThreadEngine: 'last', lastUsedEngineRoute: { engine: 'openai', providerId: 'fake' } });
      await ev('runWithProvisionalCliPaths')(async () => {
        const r = await Promise.race([srv.createSession({ title: 'y', cwd: work }).then(() => 'created'), sleep(1500).then(() => 'blocked')]);
        assert.equal(r, 'created', '上一次用的是 provider:不必等');
      });
    } finally { release3(); }
  } finally { release(); writeConfig(); }
});
