require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const { getFreePort } = require('./free-port.js');
// E2E for v0.9-S2 (C2 / §7.8): Playbooks. Backend-testable slices only; the empty-state card grid + form
// modal are verified via the preview self-check (see delivery notes), not headless DOM here.
//
// Ports 9001 (fake-openai) + 9002 (workbench).
//
// Scenarios:
//   ① GET /api/playbooks lists the 8 built-ins with a complete schema (id/title/icon/desc/inputs/
//      promptTemplate/requires/engineHint/uiMode + available/unavailableReason), inputs typed.
//   ② requires:['network'] availability — with capabilityProbeUrl at a DEAD port (offline), a network-
//      requiring playbook is available:false with a reason. The desktopMcp-requiring built-in (ocr-scan)
//      is likewise unavailable when no desktop bridge is present.
//   ③ POST a user playbook round-trips (GET shows it) + a user id OVERRIDES a built-in + DELETE removes the
//      user-level file + DELETE a built-in → 403. Also: POST without token → 403.
//   ④ draft — FAKE_DRAFT_JSON makes the fake play the drafter (non-stream call returns the JSON as content);
//      POST /api/playbooks/draft {sessionId} returns a draft with all fields present.
//   ⑤ form assembly — the pure {key} substitution logic (assemblePlaybookPrompt mirror) + an end-to-end
//      proof that an assembled prompt reaches the fake (FAKE_CAPTURE_DIR) via /api/chat/stream.
//   ⑥ 45号文③ A-S01 service 分类 — 每条带 service;15 条内置映射 + 新增 scheduled-digest 与 §1.4 实盘表
//      逐条相同;六类计数(含 coding/watch=0);未分类两条空且 available 不受影响;编造的一类被钳成 ''。
//   ⑦ 45号文⑥ A-S02 服务入口 — POST /api/playbooks/service-match:query → 六类匹配;可用引导 0 条;
//      双缺失夹具引导硬顶 1(dropped=1);no_template;无关/单字 → null;承诺词扫描 0;无 token 403。
//   ⑧ 45号文⑧ A-F01 服务状态 — evalPlaybookAvailability 每条带 status 四态(进程内单测:未知/离线/需配置/可用
//      与多项取最重);available/unavailableReason/missingCaps 与 HEAD 7d10312 的旧实现在能力形状矩阵上逐字节相同;
//      matchServiceEntry 整体序(可用 > 需配置 > 未知 > 暂无模板);第二个实例(无 provider、无探测地址、
//      WCW_TEST_NO_NET_ANCHORS=1 → online:null)里要联网的用户模板 status=unknown、服务入口 state=unknown、引导 0 条、零承诺词。
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort(), DEAD_PORT = await getFreePort(); // DEAD_PORT: nothing listens → offline probe
// Direct-require the server internals so the desktopMcp-availability case can be asserted deterministically
// as a pure unit test (the live desktopMcp.present depends on whether an ai-computer-control sibling repo is
// present in THIS checkout — so a fixed "unavailable" live-assertion would be environment-dependent).
const srv = require(path.join(WB, 'app', 'server.js'));



const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
// 107 前置 flaky 治理第四批（45 号文 §9.5 ①）：服务起来后【第一个】要读能力矩阵的请求，合法地要付一整趟冷探测 ——
// getCapabilities → probeDesktopMcp → collectBridgedTools → resolveExternalMcpServers → detectDesktopMcp。
// python 探针的磁盘缓存（os.tmpdir() 下 ruyi-desktop-python-probe.v1.json，肯定结果 TTL 5 分钟）过期时，这一路走的是
// 【同步】兜底 pickPython → spawnSync（实测 2.5–2.7 s 钉住事件循环，13-http-router 启动段注释里写明「首个请求最多付
// 一次探针,这是接受的」），之后还要起 ai-computer-control 的 python MCP、listTools、调一发 diagnostics。空闲时
// 这个首请求实测 4.5 s，并行负载下越过旧的 5 s 客户端超时 → 这里收到 status 0、json null → 原 :132 TypeError。
//「距上一次跑 e2e 超过 5 分钟」正是「改完 server.js 重建后的第一跑」，所以三次都落在那一跑上。
// 探针取证：负载下冷缓存首请求 kind=timeout 5004／5011 ms，紧接着的重试 195／608 ms 拿到 200 ＋ 完整清单。
// 所以首请求给启动预算（等的是【这一发的答复】，不是 sleep），其余请求命中 60 s 能力缓存，仍按 5 s。
// 超时／连不上／非 JSON 三种结局分开记在 err 与 ms 上，断言标签原样打出来，下次再红自己说得出是哪一种。
const FIRST_CAPS_REQUEST_TIMEOUT_MS = 30000;
function getJson(port, p, headers, timeoutMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: timeoutMs || 5000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b, err: j === null ? 'non-json' : '', ms: Date.now() - t0 }); }); });
    r.on('error', e => resolve({ status: 0, json: null, raw: '', err: 'error:' + ((e && e.code) || 'unknown'), ms: Date.now() - t0 })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '', err: 'timeout', ms: Date.now() - t0 }); });
  });
}
const shapeOf = r => `status=${r.status}${r.err ? ' ' + r.err : ''} ${r.ms}ms`;
function reqJson(port, method, p, payload, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 5000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    req.write(data); req.end();
  });
}
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); } // 117q-§8.14:抓 token 这一次原给 1500,重载下 GET / p90=2083ms 被击穿(不是竞态,见 30 号文 §8.14)
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
function readCaptures(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^req-\d+\.json$/.test(f)).sort()
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}
function clearCaptures(dir) {
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return; }
  for (const f of fs.readdirSync(dir)) { if (/^req-\d+\.json$/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } } }
}
function lastUserTextOf(reqBody) {
  const msgs = (reqBody && Array.isArray(reqBody.messages)) ? reqBody.messages : [];
  const u = [...msgs].reverse().find(m => m && m.role === 'user');
  return (u && typeof u.content === 'string') ? u.content : '';
}
function killp(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* ignore */ } } }
function seedConfig(home, extra) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }] }],
    activeProvider: 'fake',
    // capabilityProbeUrl at a DEAD port → getCapabilities.network.online === false (deterministic offline).
    capabilityProbeUrl: 'http://127.0.0.1:' + DEAD_PORT,
    ...(extra || {}),
  }, null, 2));
}
// The valid draft JSON the fake will return (non-stream) so the drafter round-trips deterministically.
const DRAFT_JSON = JSON.stringify({
  id: 'ignored-by-fresh-id', title: '整理下载文件夹', icon: '🧹',
  desc: '清点并按建议清理下载目录', inputs: [{ key: 'folder', label: '目录', type: 'folder' }],
  promptTemplate: '请清理 {folder} 并给出建议清单。', requires: [], engineHint: '', uiMode: 'both',
});

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  const HOME = path.join(os.tmpdir(), 'wcw-playbooks-e2e');
  const CAP_DIR = path.join(HOME, 'captures');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  seedConfig(HOME);

  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], { windowsHide: true, env: { ...process.env, FAKE_CAPTURE_DIR: CAP_DIR, FAKE_DRAFT_JSON: DRAFT_JSON } });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening');
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');
    const hdr = { 'x-wcw-token': token };

    // ── ① GET list: 8 built-ins, complete schema ─────────────────────────────────────────────────────
    const firstList = await getJson(WB_PORT, '/api/playbooks', {}, FIRST_CAPS_REQUEST_TIMEOUT_MS);
    let list = firstList.json;
    ok(list && list.ok && Array.isArray(list.playbooks), '① GET /api/playbooks returns a list（首请求 ' + shapeOf(firstList) + '）');
    const byId = new Map(((list && list.playbooks) || []).map(p => [p.id, p]));
    const expected8 = ['merge-excel', 'batch-rename', 'pdf-summarize', 'ocr-scan', 'archive-by-content', 'weekly-report', 'clean-downloads', 'folder-inventory'];
    ok(expected8.every(id => byId.has(id)), '① all 8 built-in playbooks present (' + [...byId.keys()].length + ' total)');
    const merge = byId.get('merge-excel');
    const schemaOk = merge && typeof merge.id === 'string' && typeof merge.title === 'string' && typeof merge.icon === 'string'
      && typeof merge.desc === 'string' && Array.isArray(merge.inputs) && typeof merge.promptTemplate === 'string'
      && Array.isArray(merge.requires) && typeof merge.engineHint === 'string' && typeof merge.uiMode === 'string'
      && typeof merge.available === 'boolean' && typeof merge.unavailableReason === 'string';
    ok(schemaOk, '① built-in has complete schema (all §7.8 fields + available/unavailableReason)');
    ok(merge && merge.inputs.some(i => i.key === 'folder' && i.type === 'folder'), '① inputs are typed (folder input present)');
    ok(merge && merge.builtin === true, '① built-in flagged builtin:true');

    // ── ② availability evaluation ────────────────────────────────────────────────────────────────────
    // desktopMcp: assert the LIVE ocr-scan availability AGREES with the actual capability matrix (present
    // depends on whether an ai-computer-control sibling is in this checkout — so we compare, not hardcode).
    const liveCaps = (await getJson(WB_PORT, '/api/capabilities')).json;
    const desktopPresent = !!(liveCaps && liveCaps.desktopMcp && liveCaps.desktopMcp.present);
    const ocr = byId.get('ocr-scan');
    ok(ocr && ocr.available === desktopPresent, '② ocr-scan (requires desktopMcp) availability agrees with caps.desktopMcp.present (' + desktopPresent + ')');
    if (!desktopPresent) ok(/桌面控制/.test(ocr.unavailableReason || ''), '② ocr-scan unavailable reason mentions 桌面控制');
    // Deterministic UNIT proof of the desktopMcp-unavailable path (env-independent): eval with present:false.
    const unitOcr = srv.normalizePlaybook({ id: 'u-ocr', title: 'T', promptTemplate: 'x', requires: ['desktopMcp'] });
    const unitEval = srv.evalPlaybookAvailability(unitOcr, { desktopMcp: { present: false }, network: { online: true }, provider: null });
    ok(unitEval.available === false && /桌面控制/.test(unitEval.unavailableReason), '② evalPlaybookAvailability(desktopMcp, present:false) → unavailable + reason (unit)');
    // Non-requiring built-ins are available even offline (network:false only gates network-requiring ones).
    ok(merge && merge.available === true, '② merge-excel (no requires) available');
    // Save a user playbook requiring network → with the dead-port probe (offline), it must be unavailable.
    const netPb = { id: 'test-net', title: '联网任务', icon: '🌐', desc: 'x', inputs: [], promptTemplate: '搜索 {q}', requires: ['network'], uiMode: 'both' };
    const saveNet = await reqJson(WB_PORT, 'POST', '/api/playbooks', { playbook: netPb }, hdr);
    ok(saveNet.status === 200 && saveNet.json && saveNet.json.ok, '② POST network-requiring user playbook ok');
    list = (await getJson(WB_PORT, '/api/playbooks')).json;
    const net = (list.playbooks || []).find(p => p.id === 'test-net');
    ok(net && net.available === false && /联网|离线/.test(net.unavailableReason || ''), '② requires:[network] + dead probe → available:false + reason');
    // 127-⑧:每条都带 status;离线的联网模板是 unavailable(不是 needs_config —— 改配置补不回网)。
    ok((list.playbooks || []).every(p => ['available', 'needs_config', 'unavailable', 'unknown'].includes(p.status)), '② (⑧) 每条 playbook 都带 status 四态之一');
    ok(net && net.status === 'unavailable', '② (⑧) requires:[network] + 离线 → status:unavailable(实得 ' + JSON.stringify(net && net.status) + ')');

    // ── ③ user round-trip / override / delete / built-in delete 403 / no-token 403 ───────────────────
    // POST without token → 403.
    const noTok = await reqJson(WB_PORT, 'POST', '/api/playbooks', { playbook: netPb }, {});
    ok(noTok.status === 403, '③ POST /api/playbooks without token → 403');
    // A user playbook whose id equals a built-in overrides it.
    const override = { id: 'merge-excel', title: '我的合并表格', icon: '🧩', desc: '自定义版本', inputs: [{ key: 'folder', label: '目录', type: 'folder' }], promptTemplate: '自定义:合并 {folder}', requires: [], uiMode: 'both' };
    const saveOv = await reqJson(WB_PORT, 'POST', '/api/playbooks', { playbook: override }, hdr);
    ok(saveOv.status === 200 && saveOv.json && saveOv.json.ok, '③ POST override of built-in id ok');
    list = (await getJson(WB_PORT, '/api/playbooks')).json;
    const ov = (list.playbooks || []).find(p => p.id === 'merge-excel');
    ok(ov && ov.title === '我的合并表格' && ov.builtin === false, '③ user override wins over built-in (title changed, builtin:false)');
    ok((list.playbooks || []).filter(p => p.id === 'merge-excel').length === 1, '③ override does not duplicate the id');
    // DELETE the user override → reverts to built-in.
    const delOv = await reqJson(WB_PORT, 'POST', '/api/playbooks/merge-excel', {}, { ...hdr, 'x-http-method': 'DELETE' });
    ok(delOv.status === 200 && delOv.json && delOv.json.ok, '③ DELETE user override ok');
    list = (await getJson(WB_PORT, '/api/playbooks')).json;
    const reverted = (list.playbooks || []).find(p => p.id === 'merge-excel');
    ok(reverted && reverted.builtin === true && reverted.title === '合并多个 Excel 表格', '③ after delete, id reverts to the built-in');
    // DELETE a pure built-in (no user file) → 403.
    const delBuiltin = await reqJson(WB_PORT, 'POST', '/api/playbooks/pdf-summarize', {}, { ...hdr, 'x-http-method': 'DELETE' });
    ok(delBuiltin.status === 403 && delBuiltin.json && delBuiltin.json.builtin === true, '③ DELETE built-in → 403 (builtin:true)');
    // DELETE the user network playbook → gone.
    const delNet = await reqJson(WB_PORT, 'POST', '/api/playbooks/test-net', {}, { ...hdr, 'x-http-method': 'DELETE' });
    ok(delNet.status === 200 && delNet.json && delNet.json.ok, '③ DELETE user playbook ok');
    list = (await getJson(WB_PORT, '/api/playbooks')).json;
    ok(!(list.playbooks || []).some(p => p.id === 'test-net'), '③ deleted user playbook is gone');
    // Invalid playbook (missing promptTemplate) → 400.
    const badSave = await reqJson(WB_PORT, 'POST', '/api/playbooks', { playbook: { id: 'x', title: 'X' } }, hdr);
    ok(badSave.status === 400, '③ POST invalid playbook (no promptTemplate) → 400');

    // ── ④ draft ──────────────────────────────────────────────────────────────────────────────────────
    // Create a session with a completed turn, then ask the server to draft a playbook from it.
    const sess = (await reqJson(WB_PORT, 'POST', '/api/sessions', {}, hdr)).json;
    const sid = sess && sess.session && sess.session.id;
    ok(!!sid, '④ session created');
    await postStream(WB_PORT, { sessionId: sid, message: '把 D:\\报表 下的表格合并成一个' });
    await sleep(300);
    const noTokDraft = await reqJson(WB_PORT, 'POST', '/api/playbooks/draft', { sessionId: sid }, {});
    ok(noTokDraft.status === 403, '④ draft without token → 403');
    const draftRes = await reqJson(WB_PORT, 'POST', '/api/playbooks/draft', { sessionId: sid }, hdr);
    ok(draftRes.status === 200 && draftRes.json && draftRes.json.ok && draftRes.json.draft, '④ draft returns ok + draft');
    const dr = draftRes.json && draftRes.json.draft;
    const draftFieldsOk = dr && dr.id && dr.title === '整理下载文件夹' && dr.promptTemplate.includes('{folder}')
      && Array.isArray(dr.inputs) && dr.inputs.some(i => i.key === 'folder' && i.type === 'folder')
      && Array.isArray(dr.requires) && typeof dr.uiMode === 'string';
    ok(draftFieldsOk, '④ draft has all fields (title/promptTemplate/inputs typed/requires/uiMode)');

    // ── ⑤ form assembly ──────────────────────────────────────────────────────────────────────────────
    // Pure substitution logic (mirrors the front-end assemblePlaybookPrompt). Substitute only declared keys.
    const assemble = (tmpl, inputs, values) => {
      let out = String(tmpl || '');
      for (const inp of inputs) { const v = values[inp.key] != null ? String(values[inp.key]) : ''; out = out.split('{' + inp.key + '}').join(v); }
      return out;
    };
    const assembled = assemble('合并 {folder} 到 {output}', [{ key: 'folder' }, { key: 'output' }], { folder: 'D:\\表格', output: 'all.xlsx' });
    ok(assembled === '合并 D:\\表格 到 all.xlsx', '⑤ placeholder substitution replaces every {key}');
    ok(assemble('留 {unknown}', [{ key: 'folder' }], {}) === '留 {unknown}', '⑤ undeclared {key} left as-is');
    // End-to-end: an assembled prompt reaches the fake (proves the same string the UI sends lands upstream).
    clearCaptures(CAP_DIR);
    const marker = 'PLAYBOOK-ASSEMBLED::合并 D:\\表格 到 all.xlsx';
    await postStream(WB_PORT, { sessionId: sid, message: marker });
    await sleep(300);
    const caps = readCaptures(CAP_DIR);
    ok(caps.some(b => lastUserTextOf(b).includes('PLAYBOOK-ASSEMBLED')), '⑤ assembled prompt reaches the provider via /api/chat/stream');

    // ── ⑥ 45号文③ A-S01:service 分类字段(六类白名单 + 空) ─────────────────────────────────
    // 判据(45号文§4③):GET 每条带 service;六类计数与 §1.4 实盘表 + 本刀新增定时汇总模板逐条相同;
    // 未分类两条 service 为空且 available 不受影响;编造的一类被枚举钳制丢成 ''(反向闸)。
    list = (await getJson(WB_PORT, '/api/playbooks')).json;
    const pbs = list.playbooks || [];
    ok(pbs.length > 0 && pbs.every(p => typeof p.service === 'string'), '⑥ every playbook carries a service field (string)');
    const svcById = new Map(pbs.map(p => [p.id, p.service]));
    const expectedSvc = {
      'compare-documents': 'research', 'pdf-summarize': 'research',
      'archive-by-content': 'organize', 'batch-rename': 'organize', 'clean-csv': 'organize',
      'clean-downloads': 'organize', 'folder-inventory': 'organize', 'merge-excel': 'organize', 'ocr-scan': 'organize',
      'weekly-report': 'writing', 'meeting-minutes': 'writing', 'presentation-outline': 'writing', 'translate-document': 'writing',
      'scheduled-digest': 'scheduled',
      'desktop-open-app': '', 'web-form-fill': '',
    };
    const svcMismatch = Object.entries(expectedSvc).filter(([id, s]) => svcById.get(id) !== s)
      .map(([id, s]) => id + '(期望"' + s + '",实得"' + svcById.get(id) + '")');
    ok(svcMismatch.length === 0, '⑥ 六类映射与 §1.4 实盘表 + 新增模板逐条相同' + (svcMismatch.length ? ' — 不符: ' + svcMismatch.join(', ') : ''));
    const counts = {};
    for (const p of pbs) counts[p.service] = (counts[p.service] || 0) + 1;
    const expectCounts = { research: 2, organize: 7, writing: 4, scheduled: 1, coding: 0, watch: 0 };
    const countBad = Object.entries(expectCounts).filter(([k, v]) => (counts[k] || 0) !== v).map(([k, v]) => k + '=' + (counts[k] || 0) + '(期望' + v + ')');
    ok(countBad.length === 0 && (counts[''] || 0) === 2, '⑥ 六类计数 research=2 organize=7 writing=4 scheduled=1 coding=0 watch=0 未分类=2' + (countBad.length ? ' — 不符: ' + countBad.join(', ') : ''));
    const unclassified = pbs.filter(p => p.id === 'desktop-open-app' || p.id === 'web-form-fill');
    ok(unclassified.length === 2 && unclassified.every(p => p.service === '' && typeof p.available === 'boolean'),
      '⑥ 未分类两条 service 为空且 available 不受影响');
    // 枚举钳制:编造的一类 → ''(本刀反向就摘这道钳制,此条应变红并打出实得值)。
    const fakeSvc = { id: 'test-fake-service', title: '分类钳制测试', icon: '🧪', desc: 'x', inputs: [], promptTemplate: '做 {q}', requires: [], uiMode: 'both', service: '编造的一类' };
    const saveFake = await reqJson(WB_PORT, 'POST', '/api/playbooks', { playbook: fakeSvc }, hdr);
    ok(saveFake.status === 200 && saveFake.json && saveFake.json.ok, '⑥ POST fabricated-service user playbook ok');
    list = (await getJson(WB_PORT, '/api/playbooks')).json;
    const fakeEntry = (list.playbooks || []).find(p => p.id === 'test-fake-service');
    ok(fakeEntry && fakeEntry.service === '', '⑥ service:"编造的一类" 被枚举钳制丢成 ""(实得 ' + JSON.stringify(fakeEntry && fakeEntry.service) + ')');
    // 合法值保留(用户 playbook 可选填分类,拍板项 2)。
    const okSvc = { id: 'test-ok-service', title: '分类保留测试', icon: '🧪', desc: 'x', inputs: [], promptTemplate: '做 {q}', requires: [], uiMode: 'both', service: 'research' };
    const saveOk = await reqJson(WB_PORT, 'POST', '/api/playbooks', { playbook: okSvc }, hdr);
    ok(saveOk.status === 200 && saveOk.json && saveOk.json.ok, '⑥ POST valid-service user playbook ok');
    list = (await getJson(WB_PORT, '/api/playbooks')).json;
    const okEntry = (list.playbooks || []).find(p => p.id === 'test-ok-service');
    ok(okEntry && okEntry.service === 'research', '⑥ 合法 service:"research" 用户模板保留(实得 ' + JSON.stringify(okEntry && okEntry.service) + ')');
    await reqJson(WB_PORT, 'POST', '/api/playbooks/test-fake-service', {}, { ...hdr, 'x-http-method': 'DELETE' });
    await reqJson(WB_PORT, 'POST', '/api/playbooks/test-ok-service', {}, { ...hdr, 'x-http-method': 'DELETE' });

    // ── ⑦ 45号文⑥ A-S02:自然语言 → 服务入口(六类匹配,≤1 次必要配置引导,无成功承诺) ─────────
    // 判据(45号文§4⑥):可用服务配置引导 ≤1 次(计数断言);不可用服务不出现成功承诺(承诺词扫描)。
    // 反向闸:双缺失夹具(离线+无桌面)不封顶会出 2 条引导 —— 本刀反向就把上限提到 2,此条实得变 2 → 红。
    const postMatch = (query, headers) => reqJson(WB_PORT, 'POST', '/api/playbooks/service-match', { query }, headers || hdr);
    const noAuth = await reqJson(WB_PORT, 'POST', '/api/playbooks/service-match', { query: '整理' }, { Origin: 'http://127.0.0.1:' + WB_PORT });
    ok(noAuth.status === 403, '⑦ service-match browser-context without token → 403(token-browser 档:浏览器须 token)');
    const mAvail = (await postMatch('帮我整理下载文件夹')).json;
    ok(mAvail && mAvail.ok && mAvail.match && mAvail.match.service === 'organize' && mAvail.match.state === 'available', '⑦ 「整理下载」→ organize/available');
    ok(mAvail.match.guidance.length === 0 && mAvail.match.guidanceDropped === 0, '⑦ 可用服务配置引导 0 条(≤1 判据)');
    ok(mAvail.match.playbooks.length === 7 && mAvail.match.playbooks[0].available === true, '⑦ organize 类 7 条模板可用在前');
    // needs_config 双缺失夹具:coding 用户模板 requires[network,vision],本夹具离线(死 probe)+fake 无视觉
    // → 缺两类(注意 desktopMcp 在本夹具 present:true,不能拿它凑第二个缺失 —— ② 的 ocr-scan 行可证)。
    const codePb = { id: 'test-nl-coding', title: '代码任务甲', icon: '🧪', desc: 'x', inputs: [], promptTemplate: '做 {q}', requires: ['network', 'vision'], uiMode: 'both', service: 'coding' };
    const saveCode = await reqJson(WB_PORT, 'POST', '/api/playbooks', { playbook: codePb }, hdr);
    ok(saveCode.status === 200 && saveCode.json && saveCode.json.ok, '⑦ POST coding user playbook ok');
    const mCfg = (await postMatch('帮我写代码修 bug')).json;
    ok(mCfg && mCfg.match && mCfg.match.service === 'coding' && mCfg.match.state === 'needs_config', '⑦ 「写代码修 bug」→ coding/needs_config');
    ok(mCfg.match.guidance.length === 1 && mCfg.match.guidanceDropped === 1, '⑦ 双缺失夹具引导硬顶 1 条(dropped=1;实得 ' + mCfg.match.guidance.length + '+' + mCfg.match.guidanceDropped + ' ' + JSON.stringify(mCfg.match.guidance) + ')');
    ok(mCfg.match.guidance[0] === 'network' || mCfg.match.guidance[0] === 'vision', '⑦ 引导带结构化能力键(前端 i18n 出人话)');
    const mNone = (await postMatch('帮我守望这个文件夹的变化')).json;
    ok(mNone && mNone.match && mNone.match.service === 'watch' && mNone.match.state === 'no_template' && mNone.match.guidance.length === 0, '⑦ 「守望变化」→ watch/no_template,引导 0 条(配不出不存在的模板)');
    const mNull = (await postMatch('zzzqx 无关')).json;
    ok(mNull && mNull.ok && mNull.match === null, '⑦ 无关查询 → match:null(零行为)');
    const mShort = (await postMatch('整')).json;
    ok(mShort && mShort.match === null, '⑦ 单字查询 → null(防误吸)');
    // 承诺词扫描(判据第二半):不可用/暂无模板服务的返回文案不得出现成功承诺词。
    const PROMISE_WORDS = ['保证', '一定能', '帮你完成', '可以帮你', '包你', '放心', '确保'];
    const scanTarget = JSON.stringify(mCfg.match) + JSON.stringify(mNone.match);
    const promised = PROMISE_WORDS.filter(w => scanTarget.includes(w));
    ok(promised.length === 0, '⑦ 不可用/暂无模板服务零成功承诺词' + (promised.length ? ' — 命中: ' + promised.join(',') : ''));
    await reqJson(WB_PORT, 'POST', '/api/playbooks/test-nl-coding', {}, { ...hdr, 'x-http-method': 'DELETE' });

    // ── ⑧ 45号文⑧ A-F01:服务状态四态(可用/需配置/不可用/未知)与离线降级 ─────────────────────────
    // 判据(45号文§4⑧,41号文§5.9):能力未知时如实给 unknown,不得并进 available;反向 = 把未知并进可用 → 本块红并打出实得。
    const ev = (requires, caps) => srv.evalPlaybookAvailability({ requires }, caps);
    const stOf = (requires, caps) => { const r = ev(requires, caps); return r.status + '/' + r.available; };
    ok(stOf(['network'], { network: { online: undefined } }) === 'unknown/true', '⑧ network online:undefined → status unknown 且 available 仍 true(实得 ' + stOf(['network'], { network: { online: undefined } }) + ')');
    ok(stOf(['network'], { network: { online: null } }) === 'unknown/true', '⑧ network online:null → unknown/true(实得 ' + stOf(['network'], { network: { online: null } }) + ')');
    ok(stOf(['network'], { network: { online: false } }) === 'unavailable/false', '⑧ network online:false → unavailable/false(实得 ' + stOf(['network'], { network: { online: false } }) + ')');
    ok(stOf(['network'], { network: { online: true } }) === 'available/true', '⑧ network online:true → available/true(实得 ' + stOf(['network'], { network: { online: true } }) + ')');
    ok(stOf(['network'], null) === 'unknown/true' && stOf(['network'], {}) === 'unknown/true', '⑧ caps 为 null / 缺 network 子对象 → unknown(实得 ' + stOf(['network'], null) + ' ' + stOf(['network'], {}) + ')');
    ok(stOf(['desktopMcp'], { desktopMcp: { present: false } }) === 'needs_config/false', '⑧ desktopMcp present:false → needs_config(实得 ' + stOf(['desktopMcp'], { desktopMcp: { present: false } }) + ')');
    ok(stOf(['desktopMcp'], { network: { online: true } }) === 'unknown/false' && stOf(['desktopMcp'], null) === 'unknown/false',
      '⑧ desktopMcp 子对象缺席 / caps null → unknown(available 照旧 false,不改放行)(实得 ' + stOf(['desktopMcp'], { network: { online: true } }) + ' ' + stOf(['desktopMcp'], null) + ')');
    ok(stOf(['desktopMcp'], { desktopMcp: { present: true } }) === 'available/true', '⑧ desktopMcp present:true → available');
    ok(stOf(['vision'], { provider: null }) === 'needs_config/false' && stOf(['vision'], { provider: { vision: false } }) === 'needs_config/false',
      '⑧ vision:provider null(CLI 引擎,配置层事实)/ vision:false → needs_config(实得 ' + stOf(['vision'], { provider: null }) + ' ' + stOf(['vision'], { provider: { vision: false } }) + ')');
    ok(stOf(['vision'], { provider: { vision: true } }) === 'available/true' && stOf(['vision'], null) === 'unknown/false' && stOf(['vision'], {}) === 'unknown/false',
      '⑧ vision:true → available;caps null / provider 缺席 → unknown(实得 ' + stOf(['vision'], null) + ' ' + stOf(['vision'], {}) + ')');
    ok(stOf([], null) === 'available/true' && stOf([], { network: { online: false } }) === 'available/true', '⑧ 无 requires → available(caps null 或离线都一样)');
    // 多项取最重:unavailable > needs_config > unknown > available。
    ok(stOf(['network', 'desktopMcp'], { network: { online: null }, desktopMcp: { present: false } }) === 'needs_config/false', '⑧ 未知+需配置 → needs_config(实得 ' + stOf(['network', 'desktopMcp'], { network: { online: null }, desktopMcp: { present: false } }) + ')');
    ok(stOf(['vision', 'network'], { network: { online: false }, provider: null }) === 'unavailable/false', '⑧ 需配置+离线 → unavailable(实得 ' + stOf(['vision', 'network'], { network: { online: false }, provider: null }) + ')');
    ok(stOf(['desktopMcp', 'network'], { network: { online: null }, desktopMcp: { present: true } }) === 'unknown/true', '⑧ 可用+未知 → unknown,绝不是 available(实得 ' + stOf(['desktopMcp', 'network'], { network: { online: null }, desktopMcp: { present: true } }) + ')');
    // 逐字节锁:三个老字段与 HEAD 7d10312 的旧实现(下面原样抄录)在能力形状矩阵上逐一相同 —— status 是纯增量。
    const legacyEval = (pb, caps) => {
      const req = Array.isArray(pb.requires) ? pb.requires : [];
      const missingCaps = [];
      let reason = '';
      for (const r of req) {
        if (r === 'network') {
          if (caps && caps.network && caps.network.online === false) { missingCaps.push('network'); if (!reason) reason = '需要联网(当前离线)'; }
        } else if (r === 'desktopMcp') {
          if (!caps || !caps.desktopMcp || !caps.desktopMcp.present) { missingCaps.push('desktopMcp'); if (!reason) reason = '需要桌面控制(未检测到 ai-computer-control)'; }
        } else if (r === 'vision') {
          if (!caps || !caps.provider || caps.provider.vision !== true) { missingCaps.push('vision'); if (!reason) reason = '需要视觉模型(当前引擎未开启视觉)'; }
        }
      }
      return { available: !reason, unavailableReason: reason, missingCaps };
    };
    const shapes = [null, undefined, {}];
    for (const online of ['absent', true, false, null, undefined, 'yes']) for (const present of ['absent', true, false, undefined, 1]) for (const provider of ['absent', null, { vision: true }, { vision: false }, {}, 'x']) {
      const c = {};
      if (online !== 'absent') c.network = { online };
      if (present !== 'absent') c.desktopMcp = { present };
      if (provider !== 'absent') c.provider = provider;
      shapes.push(c);
    }
    const combos = [[], ['network'], ['desktopMcp'], ['vision'], ['network', 'desktopMcp'], ['vision', 'network'], ['desktopMcp', 'vision'], ['network', 'desktopMcp', 'vision']];
    const legacyDrift = [];
    const statusSeen = new Set();
    let unknownLeak = 0;
    for (const caps of shapes) for (const requires of combos) {
      const now = ev(requires, caps);
      const { status, ...rest } = now;
      statusSeen.add(status);
      if (JSON.stringify(rest) !== JSON.stringify(legacyEval({ requires }, caps))) legacyDrift.push(JSON.stringify({ requires, caps }));
      const allTrue = requires.every(r => caps && (r === 'network' ? caps.network && caps.network.online === true
        : r === 'desktopMcp' ? caps.desktopMcp && caps.desktopMcp.present === true
          : caps.provider && typeof caps.provider === 'object' && caps.provider.vision === true));
      if (status === 'available' && !allTrue) unknownLeak++;
    }
    ok(legacyDrift.length === 0, '⑧ available/unavailableReason/missingCaps 与 HEAD 旧实现在 ' + (shapes.length * combos.length) + ' 个形状上逐字节相同' + (legacyDrift.length ? ' — 漂移: ' + legacyDrift.slice(0, 3).join(' ') : ''));
    ok(unknownLeak === 0 && statusSeen.size === 4, '⑧ 矩阵里 status=available 只出现在所需能力全是布尔 true 时(越界 ' + unknownLeak + ' 处;见到的状态 ' + JSON.stringify([...statusSeen].sort()) + ')');
    // 服务入口整体序(进程内):未知类不许被数成可用;有需配置就引导,只剩未知就零引导。
    const pbRow = (id, service, requires, caps) => ({ id, title: id, service, ...ev(requires, caps) });
    const capsNull = { network: { online: null }, desktopMcp: { present: false }, provider: { vision: false } };
    const onlyUnknown = srv.matchServiceEntry('帮我写代码', [pbRow('u1', 'coding', ['network'], capsNull)]);
    ok(onlyUnknown && onlyUnknown.state === 'unknown' && onlyUnknown.guidance.length === 0 && onlyUnknown.guidanceDropped === 0,
      '⑧ 类下只有未知模板 → state unknown、引导 0 条(实得 ' + JSON.stringify(onlyUnknown && [onlyUnknown.state, onlyUnknown.guidance, onlyUnknown.guidanceDropped]) + ')');
    const mixedAvail = srv.matchServiceEntry('帮我写代码', [pbRow('u1', 'coding', ['network'], capsNull), pbRow('a1', 'coding', [], capsNull)]);
    ok(mixedAvail && mixedAvail.state === 'available' && mixedAvail.playbooks.filter(p => p.status === 'available').length === 1 && mixedAvail.playbooks.every(p => typeof p.status === 'string'),
      '⑧ 可用+未知 → available,条目带 status、可用数 1(实得 ' + JSON.stringify(mixedAvail && mixedAvail.playbooks.map(p => p.status)) + ')');
    const cfgOverUnknown = srv.matchServiceEntry('帮我写代码', [pbRow('u1', 'coding', ['network'], capsNull), pbRow('d1', 'coding', ['desktopMcp', 'network'], capsNull)]);
    ok(cfgOverUnknown && cfgOverUnknown.state === 'needs_config' && JSON.stringify(cfgOverUnknown.guidance) === '["desktopMcp"]',
      '⑧ 需配置+未知 → needs_config,引导只取需配置那条的缺项(实得 ' + JSON.stringify(cfgOverUnknown && [cfgOverUnknown.state, cfgOverUnknown.guidance]) + ')');
    const offlineCaps = { network: { online: false }, desktopMcp: { present: true }, provider: { vision: false } };
    const offlineDouble = srv.matchServiceEntry('帮我写代码', [pbRow('o1', 'coding', ['network', 'vision'], offlineCaps)]);
    ok(offlineDouble && offlineDouble.playbooks[0].status === 'unavailable' && offlineDouble.state === 'needs_config' && JSON.stringify(offlineDouble.guidance) === '["network"]' && offlineDouble.guidanceDropped === 1,
      '⑧ 离线双缺失(status unavailable)→ 服务入口仍 needs_config、引导 network、dropped 1(⑦ 形状不变;实得 ' + JSON.stringify(offlineDouble && [offlineDouble.state, offlineDouble.guidance, offlineDouble.guidanceDropped]) + ')');
    // 新文案零承诺词,且「未知」那几句不含「可用」(不经文案升级)。
    const zhCatalog = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
    const f01Keys = ['skills.status.unknown', 'skills.status.needsConfig', 'skills.status.offline', 'skills.serviceMatch.unknown', 'skills.serviceMatch.unknownMore'];
    const f01Copy = f01Keys.map(k => String(zhCatalog[k] || ''));
    ok(f01Copy.every(Boolean) && PROMISE_WORDS.every(w => !f01Copy.join('|').includes(w)), '⑧ 新增状态文案 ' + f01Keys.length + ' 条齐全且零承诺词');
    ok(/未知/.test(zhCatalog['skills.status.unknown']) && /未知/.test(zhCatalog['skills.serviceMatch.unknown']) && ![zhCatalog['skills.status.unknown'], zhCatalog['skills.serviceMatch.unknown'], zhCatalog['skills.serviceMatch.unknownMore']].some(s => /可用|可直接用/.test(s)),
      '⑧ 未知文案说「未知」、不含「可用」');
    ok(/联网/.test(zhCatalog['skills.status.offline']) && /离线/.test(zhCatalog['skills.status.offline']) && /本地|恢复/.test(zhCatalog['skills.status.offline']),
      '⑧ 离线降级文案:说要联网、现在离线,并给下一步(本地文件/恢复网络)');

    // 第二个实例:无 provider、无 capabilityProbeUrl、WCW_TEST_NO_NET_ANCHORS=1 → network.online === null(真未知)。
    const HOME2 = path.join(os.tmpdir(), 'wcw-playbooks-e2e-unknown');
    fs.rmSync(HOME2, { recursive: true, force: true });
    fs.mkdirSync(HOME2, { recursive: true });
    fs.writeFileSync(path.join(HOME2, 'config.json'), JSON.stringify({ configSchema: 6, version: '1.0.0', permissionMode: 'bypass', activeProvider: '' }, null, 2));
    const WB2_PORT = await getFreePort();
    const wb2 = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB2_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME2, WCW_TEST_NO_NET_ANCHORS: '1' }, windowsHide: true });
    wb2.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb2!] ' + l.trim())));
    try {
      let h2 = null; for (let i = 0; i < 200 && !h2; i++) { await sleep(150); h2 = await health(WB2_PORT); }
      ok(!!h2, '⑧ 第二实例(未知网络)listening');
      const token2 = await getToken(WB2_PORT);
      const hdr2 = { 'x-wcw-token': token2 };
      // 第二实例的首个能力请求付的是同一趟冷探测（见 getJson 头注），同一份启动预算。
      const firstCaps2 = await getJson(WB2_PORT, '/api/capabilities', {}, FIRST_CAPS_REQUEST_TIMEOUT_MS);
      const caps2 = firstCaps2.json;
      ok(caps2 && caps2.network && caps2.network.online === null, '⑧ 夹具前提:network.online === null(实得 ' + JSON.stringify(caps2 && caps2.network && caps2.network.online) + ';首请求 ' + shapeOf(firstCaps2) + ')');
      const unkPb = { id: 'test-f01-unknown', title: '联网代码体检', icon: '🧪', desc: 'x', inputs: [], promptTemplate: '做 {q}', requires: ['network'], uiMode: 'both', service: 'coding' };
      const saveUnk = await reqJson(WB2_PORT, 'POST', '/api/playbooks', { playbook: unkPb }, hdr2);
      ok(saveUnk.status === 200 && saveUnk.json && saveUnk.json.ok, '⑧ POST 要联网的 coding 用户模板 ok');
      const list2 = (await getJson(WB2_PORT, '/api/playbooks')).json;
      const rows2 = (list2 && list2.playbooks) || [];
      ok(rows2.length > 0 && rows2.every(p => ['available', 'needs_config', 'unavailable', 'unknown'].includes(p.status)), '⑧ 第二实例 GET 每条带 status(' + rows2.length + ' 条)');
      const unkRow = rows2.find(p => p.id === 'test-f01-unknown');
      ok(unkRow && unkRow.status === 'unknown' && unkRow.available === true && unkRow.unavailableReason === '' && JSON.stringify(unkRow.missingCaps) === '[]',
        '⑧ 网络未知的模板:status unknown,available/unavailableReason/missingCaps 照旧 true/""/[](实得 ' + JSON.stringify(unkRow && [unkRow.status, unkRow.available, unkRow.unavailableReason, unkRow.missingCaps]) + ')');
      const mUnk = (await reqJson(WB2_PORT, 'POST', '/api/playbooks/service-match', { query: '帮我写代码修 bug' }, hdr2)).json;
      ok(mUnk && mUnk.match && mUnk.match.service === 'coding' && mUnk.match.state === 'unknown',
        '⑧ 「写代码修 bug」→ coding/unknown(实得 ' + JSON.stringify(mUnk && mUnk.match && [mUnk.match.service, mUnk.match.state]) + ')');
      ok(mUnk && mUnk.match && mUnk.match.guidance.length === 0 && mUnk.match.guidanceDropped === 0, '⑧ 未知服务引导 0 条(不知道缺什么就不教人去配)');
      const promisedUnk = PROMISE_WORDS.filter(w => JSON.stringify(mUnk && mUnk.match).includes(w));
      ok(promisedUnk.length === 0, '⑧ 未知服务返回零承诺词' + (promisedUnk.length ? ' — 命中: ' + promisedUnk.join(',') : ''));
      const skills2 = (await getJson(WB2_PORT, '/api/skills')).json;
      const regRow = ((skills2 && skills2.skills) || []).find(s => s.id === 'pb:test-f01-unknown');
      ok(regRow && regRow.status === 'unknown' && regRow.available === true, '⑧ /api/skills 注册表 playbook 行同样带 status unknown(实得 ' + JSON.stringify(regRow && [regRow.status, regRow.available]) + ')');
      ok(((skills2 && skills2.skills) || []).filter(s => s.kind !== 'playbook').every(s => !('status' in s)), '⑧ 技能/命令条目形状不变(不带 status)');
    } finally {
      killp(wb2);
      await sleep(300);
      fs.rmSync(HOME2, { recursive: true, force: true });
    }
  } finally {
    killp(wb); killp(fake);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log('\nPLAYBOOKS E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
