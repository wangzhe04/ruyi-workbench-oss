// E2E: 配对铁律自愈(用户线上事故回归:DeepSeek HTTP 400 "insufficient tool messages following
// tool_calls",会话永久卡死)。事故形状 = 持久化 providerHistory 里 assistant.tool_calls 有未应答 id
// (进程在工具块中途被杀/崩溃,abort 路径的 skip 填充来不及跑);下一回合 runOpenAiTurn 无条件 push
// 新 user 消息 -> 请求体即孤儿 -> strict provider 每次重发同一份历史每次都 400。
// [U] 单元:repairProviderHistoryPairing 五种形状(完整不动/尾部部分应答补 1/零应答补 N/中段原地位补/无 tool_calls 不动)。
// [L] Live:FAKE_STRICT_PAIRING 假 provider(DeepSeek 同款校验与措辞)+ 真实工作台;播种孤儿历史后
//     发新回合 -> 回合完成、发到线上的请求体配对完整(合成 tool 占位在案)、会话出现 🛠 修复系统消息。
'use strict';
(async () => {
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');
const { repairProviderHistoryPairing } = require(path.join(WB, 'app', 'server.js'));
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
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
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
} catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
finally {
  for (const c of [wb, fake]) kill(c);
  await sleep(300);
  console.log('\nPROVIDER-PAIRING-REPAIR E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
}
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
