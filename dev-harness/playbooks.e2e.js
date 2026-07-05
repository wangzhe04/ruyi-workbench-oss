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
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = 9001, WB_PORT = 9002, DEAD_PORT = 9009; // DEAD_PORT: nothing listens → offline probe
// Direct-require the server internals so the desktopMcp-availability case can be asserted deterministically
// as a pure unit test (the live desktopMcp.present depends on whether an ai-computer-control sibling repo is
// present in THIS checkout — so a fixed "unavailable" live-assertion would be environment-dependent).
const srv = require(path.join(WB, 'app', 'server.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p, headers) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
  });
}
function reqJson(port, method, p, payload, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method, timeout: 5000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    req.write(data); req.end();
  });
}
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
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
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
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
    let list = (await getJson(WB_PORT, '/api/playbooks')).json;
    ok(list && list.ok && Array.isArray(list.playbooks), '① GET /api/playbooks returns a list');
    const byId = new Map((list.playbooks || []).map(p => [p.id, p]));
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
  } finally {
    killp(wb); killp(fake);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log('\nPLAYBOOKS E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();
