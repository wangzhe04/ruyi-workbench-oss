require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// E2E: 配对铁律自愈(用户线上事故回归:DeepSeek HTTP 400 "insufficient tool messages following
// tool_calls",会话永久卡死)。事故形状 = 持久化 providerHistory 里 assistant.tool_calls 有未应答 id
// (进程在工具块中途被杀/崩溃,abort 路径的 skip 填充来不及跑);下一回合 runOpenAiTurn 无条件 push
// 新 user 消息 -> 请求体即孤儿 -> strict provider 每次重发同一份历史每次都 400。
// [U] 单元:repairProviderHistoryPairing 五种形状(完整不动/尾部部分应答补 1/零应答补 N/中段原地位补/无 tool_calls 不动)。
// [L] Live:FAKE_STRICT_PAIRING 假 provider(DeepSeek 同款校验与措辞)+ 真实工作台;播种孤儿历史后
//     发新回合 -> 回合完成、发到线上的请求体配对完整(合成 tool 占位在案)、会话出现 🛠 修复系统消息。
// 第117波(同一模具的第二个毒源:参数而非配对。用户线上事故 Qwen HTTP 400 invalid_parameter_error
// "The \"function.arguments\" parameter of the code model must be in JSON format."):
// [U2] 单元:repairProviderHistoryToolArgs 五种形状 + 精确计数 + 合法历史逐字节 no-op;
// [L2] Live:FAKE_STRICT_JSON_ARGS(Qwen 口径)+ FAKE_TRUNCATE_TOOL_ARGS(流被截断)两条路 ——
//      存量毒历史自愈、现场截断当场收口,断言【假 provider 实际收到的请求体】arguments 全能 parse。
'use strict';
(async () => {
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');
const { repairProviderHistoryPairing, repairProviderHistoryToolArgs } = require(path.join(WB, 'app', 'server.js'));
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();

const HOME = path.join(os.tmpdir(), 'wcw-provider-pairing-e2e');
const SESSDIR = path.join(HOME, 'sessions');
const BODY_LOG = path.join(HOME, 'bodies.ndjson');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(SESSDIR, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'bypass',
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key',
    model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }],
  }],
  activeProvider: 'fake',
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
let wb2 = null, fake2 = null; // [L2] 第二组进程(参数铁律),与第一组【串行】起停
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { killOwnTree(p); } catch { /* ignore */ } }
function health(port) {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
  });
}
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
  });
}
function postJson(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode, json: null, text: b }); } });
    });
    r.on('error', reject); r.write(data); r.end();
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
// v1.9 存储 v2 播种(recipe 同 resume-dangling.e2e.js):providerHistory 正文在 <id>.provider.ndjson,
// 头只带 providerHistoryCount;旧版头才直接内联 providerHistory。
function writeProviderHistory(id, entries) {
  const file = path.join(SESSDIR, id + '.json');
  const head = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (head.storageVersion === 2 || Number.isInteger(head.providerHistoryCount)) {
    fs.writeFileSync(path.join(SESSDIR, id + '.provider.ndjson'), entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
    head.providerHistoryCount = entries.length;
  } else {
    head.providerHistory = entries;
  }
  fs.writeFileSync(file, JSON.stringify(head, null, 2));
}

// ─── [U] 单元:repairProviderHistoryPairing 形状 ───
console.log('── [U] repairProviderHistoryPairing 单元 ──');
if (typeof repairProviderHistoryPairing !== 'function') {
  fail++; console.log('FAIL U0 repairProviderHistoryPairing 已从 server.js 导出(修复未落地)');
} else {
  const tc = (id, name) => ({ id, type: 'function', function: { name: name || 'file_read', arguments: '{}' } });
  // a) 完整配对:不动,返回 0
  const a = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', tool_calls: [tc('call_1')] },
    { role: 'tool', tool_call_id: 'call_1', content: 'r1' },
    { role: 'assistant', content: 'done' },
  ];
  ok(repairProviderHistoryPairing(a) === 0 && a.length === 4, 'U-a 完整配对不动(返回 0,长度不变)');
  // b) 尾部部分应答:call_a 已答 call_b 丢失 -> 块尾补 1 条 call_b
  const b = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', tool_calls: [tc('call_a'), tc('call_b')] },
    { role: 'tool', tool_call_id: 'call_a', content: 'ra' },
  ];
  const rb = repairProviderHistoryPairing(b);
  ok(rb === 1 && b.length === 4 && b[3].role === 'tool' && b[3].tool_call_id === 'call_b' && /丢失/.test(b[3].content),
    'U-b 尾部部分应答块尾补 call_b(实 repaired=' + rb + ')');
  // c) 零应答:两条全丢 -> 块尾(下一条 user 之前)补 2 条,保持相邻
  const c = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', tool_calls: [tc('call_1'), tc('call_2')] },
    { role: 'user', content: 'u2' },
  ];
  const rc = repairProviderHistoryPairing(c);
  ok(rc === 2 && c.length === 5 && c[2].tool_call_id === 'call_1' && c[3].tool_call_id === 'call_2' && c[4].role === 'user',
    'U-c 零应答补 2 条且插入在 user 之前(实 repaired=' + rc + ')');
  // d) 中段孤儿 + 后段完整回合:原位补中段,后段不动
  const d = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', tool_calls: [tc('call_x')] },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: '', tool_calls: [tc('call_y')] },
    { role: 'tool', tool_call_id: 'call_y', content: 'ry' },
    { role: 'assistant', content: 'done' },
  ];
  const rd = repairProviderHistoryPairing(d);
  ok(rd === 1 && d.length === 7 && d[2].role === 'tool' && d[2].tool_call_id === 'call_x' && d[3].role === 'user' && d[5].tool_call_id === 'call_y',
    'U-d 中段孤儿原位补,后段完整回合不动(实 repaired=' + rd + ')');
  // e) 无 tool_calls:不动
  const e = [{ role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }];
  ok(repairProviderHistoryPairing(e) === 0 && e.length === 2, 'U-e 无 tool_calls 不动');
  // f) 修后全历史过 DeepSeek 式校验(与 fake 同一口径)
  const viol = msgs => {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
      const ans = new Set();
      for (let j = i + 1; j < msgs.length && msgs[j] && msgs[j].role === 'tool'; j++) if (msgs[j].tool_call_id != null) ans.add(String(msgs[j].tool_call_id));
      if (m.tool_calls.some(t => t && t.id != null && !ans.has(String(t.id)))) return true;
    }
    return false;
  };
  ok(!viol(b) && !viol(c) && !viol(d), 'U-f 修复后 b/c/d 全历史过 strict 配对校验');
}

// ─── [U2] 单元:repairProviderHistoryToolArgs 形状(第117波 参数铁律)───
console.log('── [U2] repairProviderHistoryToolArgs 单元 ──');
if (typeof repairProviderHistoryToolArgs !== 'function') {
  fail++; console.log('FAIL U2-0 repairProviderHistoryToolArgs 已从 server.js 导出(修复未落地)');
} else {
  const tcArgs = (id, args, name) => ({ id, type: 'function', function: { name: name || 'file_read', arguments: args } });
  // a) 五种形状一网打尽:空串 / 半截 JSON(流被截断)/ 非 JSON / 合法 JSON 但不是对象 / 完好。
  //    只有前四条被改写成 '{}',完好那条一个字节都不动,返回值必须精确等于 4。
  const g = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: '', tool_calls: [
      tcArgs('c_empty', '', 'file_read'),
      tcArgs('c_trunc', '{"a":1', 'file_write'),
      tcArgs('c_notjson', 'not json', 'shell_run'),
      tcArgs('c_array', '[1,2]', 'web_search'),
      tcArgs('c_good', '{"a":1}', 'file_list'),
    ] },
    { role: 'tool', tool_call_id: 'c_good', content: 'r' },
  ];
  const rg = repairProviderHistoryToolArgs(g);
  const argsOf = i => g[1].tool_calls[i].function.arguments;
  ok(rg === 4, 'U2-a 返回值精确 = 4(空串/半截/非JSON/数组 各一;实 repaired=' + rg + ')');
  ok(argsOf(0) === '{}' && argsOf(1) === '{}' && argsOf(2) === '{}' && argsOf(3) === '{}',
    'U2-b 四条坏参数全改写成 {}(实 ' + JSON.stringify([argsOf(0), argsOf(1), argsOf(2), argsOf(3)]) + ')');
  ok(argsOf(4) === '{"a":1}', 'U2-c 合法对象参数一个字节不动(实 ' + JSON.stringify(argsOf(4)) + ')');
  ok(g.length === 3 && g[2].role === 'tool' && g[1].tool_calls.length === 5,
    'U2-d 不增不删任何消息/任何 tool_call(实 len=' + g.length + ' calls=' + g[1].tool_calls.length + ')');
  // b) 幂等:修过的历史再修一遍返回 0。
  ok(repairProviderHistoryToolArgs(g) === 0, 'U2-e 幂等(修过的历史再修返回 0)');
  // c) no-op 铁证:全合法历史 —— 修复前后 JSON 序列化【逐字节】相同,且返回 0。
  const clean = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'think', reasoning_content: 'r', tool_calls: [tcArgs('c1', '{"path":"a.txt"}'), tcArgs('c2', '{}')] },
    { role: 'tool', tool_call_id: 'c1', content: 'ra' },
    { role: 'tool', tool_call_id: 'c2', content: 'rb' },
    { role: 'assistant', content: 'done' },
  ];
  const beforeBytes = JSON.stringify(clean);
  const rc2 = repairProviderHistoryToolArgs(clean);
  const afterBytes = JSON.stringify(clean);
  ok(rc2 === 0 && beforeBytes === afterBytes && Buffer.byteLength(beforeBytes) === Buffer.byteLength(afterBytes),
    'U2-f 合法历史逐字节 no-op(repaired=' + rc2 + ',bytes ' + Buffer.byteLength(beforeBytes) + '→' + Buffer.byteLength(afterBytes) + ')');
  // d) 非 assistant / 无 tool_calls / 空历史:不动。
  const other = [{ role: 'user', content: 'u' }, { role: 'tool', tool_call_id: 'x', content: 'bad' }, { role: 'assistant', content: 'a' }];
  ok(repairProviderHistoryToolArgs(other) === 0 && repairProviderHistoryToolArgs([]) === 0 && repairProviderHistoryToolArgs(null) === 0,
    'U2-g 无 tool_calls / 空 / 非数组 一律返回 0');
  // e) 修后全历史过 Qwen 式 arguments 校验(与 fake 的 toolArgsViolation 同一口径)。
  const argsViol = msgs => {
    for (const m of msgs || []) {
      if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (const tc of m.tool_calls) {
        const a = tc && tc.function ? tc.function.arguments : undefined;
        if (typeof a !== 'string' || a === '') return true;
        let p; try { p = JSON.parse(a); } catch { return true; }
        if (!p || typeof p !== 'object' || Array.isArray(p)) return true;
      }
    }
    return false;
  };
  ok(!argsViol(g) && !argsViol(clean), 'U2-h 修复后全历史过 strict arguments 校验(Qwen 口径)');
}

// ─── [L] Live:strict 假 provider + 孤儿历史会话发新回合 ───
console.log('── [L] Live:孤儿 tool_calls 历史 + 新回合 ──');
const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(FAKE_PORT)], {
  env: { ...process.env, FAKE_STRICT_PAIRING: '1', FAKE_LOG_BODY: BODY_LOG },
  windowsHide: true,
});
fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
try {
  let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
  ok(!!h, 'L0 workbench listening on :' + WB_PORT);

  const mk = await postJson(WB_PORT, '/api/sessions', { title: 'orphan-pairing', cwd: HOME });
  const sid = mk.json && mk.json.session && mk.json.session.id;
  ok(!!sid, 'L1 会话已建(' + sid + ')');

  // 播种事故形状:两条并行 tool_calls,只有 call_a 的结果落盘(进程在 call_b 完成前被杀)。
  writeProviderHistory(sid, [
    { role: 'user', content: '读一下 a.txt 和 b.txt' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_a', type: 'function', function: { name: 'file_read', arguments: '{"path":"a.txt"}' } },
      { id: 'call_b', type: 'function', function: { name: 'file_read', arguments: '{"path":"b.txt"}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_a', content: 'a.txt 的内容' },
  ]);
  const get0 = await getJson(WB_PORT, '/api/sessions/' + encodeURIComponent(sid));
  ok(get0 && get0.resumable && get0.resumable.dangling === true, 'L2 播种后 detectDanglingTurn 报 dangling(' + JSON.stringify(get0 && get0.resumable) + ')');

  // 新回合:修复前 -> strict fake 400(用户事故原样);修复后 -> 补齐 call_b 占位,回合完成。
  const events = await postStream(WB_PORT, { message: '继续', sessionId: sid });
  const result = events.find(e => e.type === 'result');
  ok(result && result.ok === true, 'L3 回合完成 result.ok=true(修复前此处为 DeepSeek 400;实 ' + JSON.stringify(result && { ok: result.ok, error: result.error }) + ')');

  // 发到线上的请求体:配对完整 + call_b 有合成占位(不删不改既有消息)。
  const bodies = fs.readFileSync(BODY_LOG, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const last = bodies[bodies.length - 1].messages;
  const idxA = last.findIndex(m => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some(t => t.id === 'call_a'));
  const followToolIds = [];
  for (let j = idxA + 1; j < last.length && last[j] && last[j].role === 'tool'; j++) followToolIds.push(String(last[j].tool_call_id));
  ok(idxA >= 0 && followToolIds.includes('call_a') && followToolIds.includes('call_b'),
    'L4 线上请求体里 call_a/call_b 均有紧随的 tool 回复(实紧随块=' + followToolIds.join(',') + ')');
  const fillB = last.find(m => m && m.role === 'tool' && String(m.tool_call_id) === 'call_b');
  ok(fillB && /丢失/.test(fillB.content || ''), 'L5 call_b 的合成占位声明结果丢失(勿重放)');

  // 会话可见修复说明(诚实告知,同 🗜 压缩消息先例)。
  const get1 = await getJson(WB_PORT, '/api/sessions/' + encodeURIComponent(sid));
  const msgs1 = (get1 && get1.session && get1.session.messages) || [];
  ok(msgs1.some(m => m && m.source === 'repair' && /补 1 条丢失的工具结果/.test(m.content || '')), 'L6 会话出现 🛠 修复系统消息(补 1 条)');

  // 第二回合:历史已愈合,strict fake 依旧放行(不反弹)。
  const events2 = await postStream(WB_PORT, { message: '再确认一下', sessionId: sid });
  const result2 = events2.find(e => e.type === 'result');
  ok(result2 && result2.ok === true, 'L7 第二回合照常(修复不反弹)');

  // ─── [L2] Live(第117波 参数铁律):Qwen 式 strict-arguments 假 provider ───
  // 先收掉第一组进程,再起第二组 —— 同机串行,不叠并发负载(并行起服务是本仓库已知的 ECONNREFUSED 源)。
  console.log('── [L2] Live:参数不是合法 JSON 的两条路(存量毒历史 / 流被截断)──');
  for (const c of [wb, fake]) kill(c);
  await sleep(400);
  const FAKE_PORT2 = await getFreePort(), WB_PORT2 = await getFreePort();
  const HOME2 = path.join(os.tmpdir(), 'wcw-provider-toolargs-e2e');
  const SESSDIR2 = path.join(HOME2, 'sessions');
  const BODY_LOG2 = path.join(HOME2, 'bodies.ndjson');
  fs.rmSync(HOME2, { recursive: true, force: true });
  fs.mkdirSync(SESSDIR2, { recursive: true });
  fs.writeFileSync(path.join(HOME2, 'config.json'), JSON.stringify({
    configSchema: 4, version: '1.0.0', permissionMode: 'bypass',
    providers: [{
      id: 'fake', label: 'Fake', type: 'openai-compat',
      baseUrl: 'http://127.0.0.1:' + FAKE_PORT2, apiKey: 'test-key',
      model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }],
    }],
    activeProvider: 'fake',
  }, null, 2));
  const writeProviderHistory2 = (id, entries) => {
    const file = path.join(SESSDIR2, id + '.json');
    const head = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (head.storageVersion === 2 || Number.isInteger(head.providerHistoryCount)) {
      fs.writeFileSync(path.join(SESSDIR2, id + '.provider.ndjson'), entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
      head.providerHistoryCount = entries.length;
    } else { head.providerHistory = entries; }
    fs.writeFileSync(file, JSON.stringify(head, null, 2));
  };
  const readLogRecords = kind => {
    const dir = path.join(HOME2, 'logs');
    let out = [];
    for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
      if (!f.endsWith('.ndjson')) continue;
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        const t = line.trim(); if (!t) continue;
        let r = null; try { r = JSON.parse(t); } catch { continue; }
        if (r && r.kind === kind) out.push({ rec: r, line: t });
      }
    }
    return out;
  };
  // 请求体里所有 assistant.tool_calls 的 arguments 是否全都 parse 成对象(= 发到线上不会 400)。
  const bodyArgsAllJson = body => {
    const seen = [];
    for (const m of (body.messages || [])) {
      if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (const tc of m.tool_calls) {
        const a = tc && tc.function ? tc.function.arguments : undefined;
        let p = null, okParse = false;
        if (typeof a === 'string' && a !== '') { try { p = JSON.parse(a); okParse = !!p && typeof p === 'object' && !Array.isArray(p); } catch { okParse = false; } }
        seen.push({ name: (tc.function && tc.function.name) || '', args: a, okParse });
      }
    }
    return seen;
  };

  fake2 = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(FAKE_PORT2)], {
    env: {
      ...process.env,
      FAKE_STRICT_JSON_ARGS: '1',            // Qwen/DashScope 口径:arguments 不是 JSON 对象 -> 400
      FAKE_TRUNCATE_TOOL_ARGS: '1',          // 流被截断:参数尾片永不到达
      FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'file_read', args: { path: 'seed.txt' } }]),
      FAKE_LOG_BODY: BODY_LOG2,
    },
    windowsHide: true,
  });
  fake2.stdout.on('data', d => String(d).trim() && console.log('[fake2] ' + String(d).trim()));
  wb2 = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT2)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME2 }, windowsHide: true });
  wb2.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb2] ' + l.trim())));
  wb2.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb2!] ' + l.trim())));
  let h2 = null; for (let i = 0; i < 40 && !h2; i++) { await sleep(150); h2 = await health(WB_PORT2); }
  ok(!!h2, 'L8 workbench up on :' + WB_PORT2);

  // ── (甲)存量毒历史:用户手上那条【已经卡死】的会话,靠 repairProviderHistoryToolArgs 自愈 ──
  const mk2 = await postJson(WB_PORT2, '/api/sessions', { title: 'wedged-tool-args', cwd: HOME2 });
  const sid2 = mk2.json && mk2.json.session && mk2.json.session.id;
  ok(!!sid2, 'L9 会话已建(' + sid2 + ')');
  // 配对是完整的(不触发配对自愈),只有 arguments 是半截 JSON —— 精确复现事故形状。
  writeProviderHistory2(sid2, [
    { role: 'user', content: '读一下 a.txt' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'call_t', type: 'function', function: { name: 'file_read', arguments: '{"path":"a.tx' } },
    ] },
    { role: 'tool', tool_call_id: 'call_t', content: 'a.txt 的内容' },
  ]);
  const ev2 = await postStream(WB_PORT2, { message: '继续', sessionId: sid2 });
  const res2 = ev2.find(e => e.type === 'result');
  ok(res2 && res2.ok === true, 'L10 毒历史会话回合完成(修复前此处为 Qwen 400 invalid_parameter_error;实 ' + JSON.stringify(res2 && { ok: res2.ok, error: res2.error }) + ')');
  const bodies2 = fs.readFileSync(BODY_LOG2, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const seenA = bodyArgsAllJson(bodies2[0]);
  ok(seenA.length === 1 && seenA[0].args === '{}' && seenA[0].okParse === true,
    'L11 发到线上的第一条请求体里 call_t 的 arguments 已是可解析对象(实 ' + JSON.stringify(seenA) + ')');
  const repRecs = readLogRecords('provider_tool_args_repair');
  ok(repRecs.length === 1 && repRecs[0].rec.tool === 'file_read' && repRecs[0].rec.bytes === 13 && repRecs[0].rec.sessionId === sid2,
    'L12 自愈落了一条 provider_tool_args_repair(tool/bytes/sessionId;实 ' + JSON.stringify(repRecs.map(r => r.rec)) + ')');
  ok(repRecs.length === 1 && !repRecs[0].line.includes('"path"') && !repRecs[0].line.includes('a.tx'),
    'L13 日志不含原始片段(只带工具名与字节数 —— 片段可能含密钥)');
  const get2 = await getJson(WB_PORT2, '/api/sessions/' + encodeURIComponent(sid2));
  const msgs2 = (get2 && get2.session && get2.session.messages) || [];
  ok(msgs2.some(m => m && m.source === 'repair' && /工具参数被截断/.test(m.content || '')), 'L14 会话出现 🛠 参数修正系统消息');

  // ── (乙)流被截断:本回合【现场】产生半截参数,写侧不变量必须当场收口 ──
  const mk3 = await postJson(WB_PORT2, '/api/sessions', { title: 'truncated-stream', cwd: HOME2 });
  const sid3 = mk3.json && mk3.json.session && mk3.json.session.id;
  ok(!!sid3, 'L15 会话已建(' + sid3 + ')');
  const beforeCount = fs.readFileSync(BODY_LOG2, 'utf8').trim().split('\n').length;
  const ev3 = await postStream(WB_PORT2, { message: '读一下种子文件', sessionId: sid3 });
  const res3 = ev3.find(e => e.type === 'result');
  ok(res3 && res3.ok === true, 'L16 截断流回合完成(修复前:回放半截参数 -> 下一次请求 Qwen 400;实 ' + JSON.stringify(res3 && { ok: res3.ok, error: res3.error }) + ')');
  const bodies3 = fs.readFileSync(BODY_LOG2, 'utf8').trim().split('\n').map(l => JSON.parse(l)).slice(beforeCount);
  // 唯一能证明 400 消失的断言:假 provider【实际收到】的那份请求体。
  const withCalls = bodies3.map(bodyArgsAllJson).filter(s => s.length);
  const flatCalls = withCalls.flat();
  ok(withCalls.length >= 1 && flatCalls.every(s => s.okParse === true),
    'L17 工具回合后的每一条请求体 arguments 均 parse 成对象(实 ' + JSON.stringify(flatCalls) + ')');
  ok(flatCalls.length >= 1 && flatCalls.every(s => s.name === 'file_read' && s.args === '{}'),
    'L18 半截参数被收口成 {} —— 与执行方 catch → {} 完全一致(实 ' + JSON.stringify(flatCalls.map(s => s.args)) + ')');
  const coRecs = readLogRecords('provider_tool_args_coerced');
  ok(coRecs.length >= 1 && coRecs.every(r => r.rec.tool === 'file_read' && r.rec.bytes === 10 && r.rec.sessionId === sid3),
    'L19 写侧收口落了 provider_tool_args_coerced(tool=file_read,bytes=10 = 半截片段真实长度;实 ' + JSON.stringify(coRecs.map(r => r.rec)) + ')');
  ok(coRecs.every(r => !r.line.includes('"path"') && !r.line.includes('seed')),
    'L20 收口日志同样不含原始片段');
} catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
finally {
  for (const c of [wb, fake, wb2, fake2]) kill(c);
  await sleep(300);
  console.log('\nPROVIDER-PAIRING-REPAIR E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
}
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
