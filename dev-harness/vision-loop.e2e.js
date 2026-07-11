// E2E (v0.9-S7): 视觉回路 + 操控规程 — provider 引擎, 离线 via fake-openai + fake-mcp. §0.9-S7 / 总纲 §7.5 · §8 D3.
// Ports 9011 (fake-openai) + 9012 (workbench). The fake respawns per scenario on the SAME port段 (serial).
//
// fake 契约 (S0/S7 已加):
//   FAKE_VISION=1        → 当任一请求消息 content 是数组且含 image_url part 时,最终答文本回显 SEEN_IMAGE:<hash>。
//   FAKE_CAPTURE_DIR     → 每个请求体落盘 req-NNN.json(用于断言 user content 形状 / system 规程文案)。
//   FAKE_TOOL_SEQUENCE   → 逐个吐 tool_call(此处用 fake-mcp 桥接的 fake__screenshot_full,返回 {image:...})。
//   FAKE_SEQUENCE_PRIORITY=1 → 让未耗尽的 TOOL_SEQUENCE 优先于 image-echo 分支(保图≤2 需连开 3 张截图)。
// fake-mcp 作为 external MCP 桥入 → 既提供 screenshot_full(返回 image 字段),又令 caps.desktopMcp.present=true
//   (probeDesktopMcp: 任何桥接工具存在即 present),从而 buildProviderSystemPrompt 注入「操控规程」两路径之一。
//
// Scenarios:
//  (a) VISION 路径 · 图片附件:vision:true + FAKE_VISION + 上传一张 png 附件 → 请求体 user content 是数组含
//      image_url part;回复含 SEEN_IMAGE: 证明图到达模型;系统提示词含「桌面操控(视觉路径)」规程。
//  (b) 工具截图入回路:FAKE_TOOL_SEQUENCE=[fake__screenshot_full] + vision:true → tool 消息 content 图字段被剥离
//      为占位、其后紧跟一条 user 图片消息(位置在完整 tool 块之后,连续性校验)、tool_image 事件、SEEN_IMAGE 回显。
//  (c) 保图≤2:连开 3 张截图 → providerHistory 里 image_url part ≤2,最老的被替换为文本占位「[截图已淘汰:…]」。
//  (d) 无 VISION 路径:vision:false + 同样 png 附件 → 请求体 user content 是字符串(纯文本);系统提示词含
//      「桌面操控(文本路径)」规程;工具截图字段保留在 tool 结果里、不转 image 消息。
//  (e) 配对+连续性:全程 providerHistory 每个 assistant.tool_calls 后紧跟连续 tool 应答块,图片 user 消息只在块后。
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_MCP = path.join(HERE, 'fake-mcp.js');
const FAKE_PORT = 9011, WB_PORT = 9012;
const HOME = path.join(os.tmpdir(), 'wcw-vision-e2e');
const CAP_DIR = path.join(HOME, 'capture');
const NODE = process.execPath;
// A tiny valid 1x1 PNG (base64). Used as the image attachment payload.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 12000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let parsed = null; try { parsed = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, body: parsed }); }); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('post timeout')); }); req.write(data); req.end();
  });
}
function streamChat(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}
// vision boolean + whether to bridge fake-mcp (desktop tools) + extra fake env; single active provider.
function writeConfig(vision, bridgeMcp) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.0.0', permissionMode: 'bypass',
    defaultWorkspace: HOME, recentWorkspaces: [],
    externalMcpServers: bridgeMcp ? [{ id: 'fake', label: 'Fake MCP', command: NODE, args: [FAKE_MCP], enabled: true }] : [],
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], vision: !!vision }],
    activeProvider: 'fake',
  }, null, 2));
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
function spawnFake(env) { const p = cp.spawn(NODE, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_CAPTURE_DIR: CAP_DIR, ...env }, windowsHide: true }); p.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim())); return p; }
function fakeUp(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/v1/models', timeout: 800 }, resp => { resp.resume(); res(true); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); }); }
function clearCapture() { try { fs.rmSync(CAP_DIR, { recursive: true, force: true }); } catch { /* ignore */ } try { fs.mkdirSync(CAP_DIR, { recursive: true }); } catch { /* ignore */ } }
function readCaptures() {
  try { return fs.readdirSync(CAP_DIR).filter(f => /^req-\d+\.json$/.test(f)).sort().map(f => { try { return JSON.parse(fs.readFileSync(path.join(CAP_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
// CONTIGUITY check (reused from steering.e2e §连续性铁律): each assistant.tool_calls (N ids) must be followed
// IMMEDIATELY by exactly N role:'tool' replies whose id-set equals the ids — nothing of any other role wedged in.
function checkToolBlockContiguity(ph) {
  for (let i = 0; i < ph.length; i++) {
    const m = ph[i];
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const ids = m.tool_calls.map(t => t.id).slice().sort();
      const replies = ph.slice(i + 1, i + 1 + ids.length);
      if (replies.length !== ids.length) return { ok: false, at: i, why: 'short block' };
      if (!replies.every(r => r && r.role === 'tool')) return { ok: false, at: i, why: 'non-tool wedged in block' };
      const rids = replies.map(r => r.tool_call_id).slice().sort();
      if (JSON.stringify(ids) !== JSON.stringify(rids)) return { ok: false, at: i, why: 'id set mismatch' };
    }
  }
  return { ok: true };
}
// Count image_url parts across a providerHistory (parts arrays only).
function countImageParts(ph) {
  let n = 0;
  for (const m of ph) { const c = m && m.content; if (!Array.isArray(c)) continue; for (const p of c) if (p && (p.type === 'image_url' || p.image_url || p.type === 'image')) n++; }
  return n;
}
// Does any part in the history carry the 「[截图已淘汰:…]」 demotion占位? (保图≤2 evidence.)
function hasEvictedPlaceholder(ph) {
  for (const m of ph) { const c = m && m.content; if (!Array.isArray(c)) continue; for (const p of c) if (p && p.type === 'text' && /截图已淘汰/.test(String(p.text || ''))) return true; }
  return false;
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  let wb = null, fake = null;
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });

  // Boot workbench ONCE; the fake respawns per scenario (config.json is re-read each turn by readConfig).
  const bootWb = () => { wb = cp.spawn(NODE, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true }); wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim()))); procs.push(wb); };

  try {
    // ── (a) VISION path · image attachment ────────────────────────────────────────────────────────────────
    writeConfig(true, true); clearCapture();
    fake = spawnFake({ FAKE_VISION: '1' }); procs.push(fake);
    bootWb();
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    ok(h && h.version === require(require('path').resolve(__dirname,'..','ruyi-workbench','package.json')).version, 'version === package.json'); // 第23波: 动态读
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');
    const hdr = { 'x-wcw-token': token };

    // Upload a real PNG attachment (writes to dataRoot/uploads/<id>/pic.png; returns the record we resend).
    const up = await postJson(WB_PORT, '/api/upload', { name: 'pic.png', data: 'data:image/png;base64,' + PNG_B64 }, hdr);
    const att = up.body && up.body.file;
    ok(att && att.path && /pic\.png$/.test(att.path), '(a) png uploaded → attachment record with path');

    const cA = await postJson(WB_PORT, '/api/sessions', { title: 'vision attach', cwd: HOME }, hdr);
    const sidA = cA.body && cA.body.session && cA.body.session.id;
    ok(!!sidA, '(a) session created');
    const evA = await streamChat(WB_PORT, { sessionId: sidA, message: '看看这张图', cwd: HOME, attachments: [att] });

    // The reply must carry SEEN_IMAGE: (fake echoes it only when an image_url part reached it).
    const textA = evA.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    ok(/SEEN_IMAGE:/.test(textA), '(a) reply carries SEEN_IMAGE: (image reached model) — got: ' + JSON.stringify(textA.slice(0, 60)));
    // The captured request body's user message content is an ARRAY with an image_url part.
    const capsA = readCaptures();
    const userMsgA = capsA.length && [...(capsA[0].messages || [])].reverse().find(m => m && m.role === 'user');
    ok(userMsgA && Array.isArray(userMsgA.content), '(a) user content is a PARTS array (vision)');
    ok(userMsgA && Array.isArray(userMsgA.content) && userMsgA.content.some(p => p && p.type === 'image_url'), '(a) user content has an image_url part');
    ok(userMsgA && Array.isArray(userMsgA.content) && userMsgA.content.some(p => p && p.type === 'text'), '(a) user content still has the text part');
    // System prompt carries the VISION 操控规程 (desktop bridge is present via fake-mcp).
    const sysA = capsA.length && (capsA[0].messages || []).find(m => m && m.role === 'system');
    ok(sysA && /桌面操控\(视觉路径\)/.test(String(sysA.content || '')), '(a) system prompt has 桌面操控(视觉路径) regimen');
    ok(sysA && !/桌面操控\(文本路径\)/.test(String(sysA.content || '')), '(a) vision path does NOT inject the text-path regimen');

    killp(fake);

    // ── (b) tool screenshot into the loop ─────────────────────────────────────────────────────────────────
    writeConfig(true, true); clearCapture();
    fake = spawnFake({ FAKE_VISION: '1', FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'fake__screenshot_full', args: {} }]) }); procs.push(fake);
    for (let i = 0; i < 30 && !(await fakeUp(FAKE_PORT)); i++) await sleep(120);

    const cB = await postJson(WB_PORT, '/api/sessions', { title: 'tool screenshot', cwd: HOME }, hdr);
    const sidB = cB.body && cB.body.session && cB.body.session.id;
    ok(!!sidB, '(b) session created');
    const evB = await streamChat(WB_PORT, { sessionId: sidB, message: '截个图看看', cwd: HOME });

    // a tool_image event fired for the screenshot tool call.
    const toolImgEv = evB.find(e => e.type === 'tool_image');
    ok(!!toolImgEv && !!toolImgEv.toolCallId, '(b) tool_image event fired {toolCallId, note}');
    // SEEN_IMAGE echoed on the follow-up request (the screenshot reached the model as an image part).
    const textB = evB.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
    ok(/SEEN_IMAGE:/.test(textB), '(b) follow-up reply carries SEEN_IMAGE: (tool screenshot reached model)');

    const gotB = await getJson(WB_PORT, '/api/sessions/' + sidB, hdr);
    const phB = (gotB.session && gotB.session.providerHistory) || [];
    // The role:'tool' message for the screenshot has its image field STRIPPED to a占位 (JSON精简).
    const toolMsgB = phB.find(m => m && m.role === 'tool' && /截图见随后的图片消息/.test(String(m.content || '')));
    ok(!!toolMsgB, '(b) tool message content has image stripped → 占位 [截图见随后的图片消息]');
    ok(toolMsgB && !/FAKE_IMAGE_B64/.test(String(toolMsgB.content || '')), '(b) raw base64 image is NOT in the tool message');
    // A user image message sits AFTER the tool block (its predecessor is a role:'tool' message → 连续性).
    const imgUserIdxB = phB.findIndex(m => m && m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p && p.type === 'image_url'));
    ok(imgUserIdxB > 0 && phB[imgUserIdxB - 1] && phB[imgUserIdxB - 1].role === 'tool', '(b) user image message immediately follows the tool block (prev role: ' + (imgUserIdxB > 0 && phB[imgUserIdxB - 1] && phB[imgUserIdxB - 1].role) + ')');
    ok(checkToolBlockContiguity(phB).ok, '(b) providerHistory tool blocks are contiguous (连续性铁律): ' + JSON.stringify(checkToolBlockContiguity(phB)));

    killp(fake);

    // ── (c) 保图≤2: three screenshots ─────────────────────────────────────────────────────────────────────
    writeConfig(true, true); clearCapture();
    const threeShots = JSON.stringify([{ name: 'fake__screenshot_full', args: {} }, { name: 'fake__screenshot_full', args: {} }, { name: 'fake__screenshot_full', args: {} }]);
    fake = spawnFake({ FAKE_VISION: '1', FAKE_TOOL_SEQUENCE: threeShots, FAKE_SEQUENCE_PRIORITY: '1' }); procs.push(fake);
    for (let i = 0; i < 30 && !(await fakeUp(FAKE_PORT)); i++) await sleep(120);

    const cC = await postJson(WB_PORT, '/api/sessions', { title: 'three shots', cwd: HOME }, hdr);
    const sidC = cC.body && cC.body.session && cC.body.session.id;
    ok(!!sidC, '(c) session created');
    const evC = await streamChat(WB_PORT, { sessionId: sidC, message: '连续截三次', cwd: HOME });
    ok(evC.filter(e => e.type === 'tool_image').length === 3, '(c) 3 tool_image events (three screenshots) — got ' + evC.filter(e => e.type === 'tool_image').length);

    const gotC = await getJson(WB_PORT, '/api/sessions/' + sidC, hdr);
    const phC = (gotC.session && gotC.session.providerHistory) || [];
    ok(countImageParts(phC) <= 2, '(c) 保图≤2: image_url parts in history ≤ 2 — got ' + countImageParts(phC));
    ok(hasEvictedPlaceholder(phC), '(c) the oldest image was demoted to 「[截图已淘汰:…]」 text占位');
    ok(checkToolBlockContiguity(phC).ok, '(c) contiguity still holds after pruning (only user-msg parts rewritten, no message deleted)');

    killp(fake);

    // ── (d) NO-vision path ────────────────────────────────────────────────────────────────────────────────
    writeConfig(false, true); clearCapture();
    fake = spawnFake({ FAKE_VISION: '1', FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'fake__screenshot_full', args: {} }]) }); procs.push(fake);
    for (let i = 0; i < 30 && !(await fakeUp(FAKE_PORT)); i++) await sleep(120);

    // (d1) image attachment on a no-vision provider → user content stays a STRING (pure-text injection).
    const cD = await postJson(WB_PORT, '/api/sessions', { title: 'no vision', cwd: HOME }, hdr);
    const sidD = cD.body && cD.body.session && cD.body.session.id;
    ok(!!sidD, '(d) session created');
    await streamChat(WB_PORT, { sessionId: sidD, message: '截个图', cwd: HOME, attachments: [att] });
    const capsD = readCaptures();
    const userMsgD = capsD.length && [...(capsD[0].messages || [])].reverse().find(m => m && m.role === 'user');
    ok(userMsgD && typeof userMsgD.content === 'string', '(d) no-vision: user content is a STRING (no image parts)');
    const sysD = capsD.length && (capsD[0].messages || []).find(m => m && m.role === 'system');
    ok(sysD && /桌面操控\(文本路径\)/.test(String(sysD.content || '')), '(d) system prompt has 桌面操控(文本路径) regimen');
    ok(sysD && !/桌面操控\(视觉路径\)/.test(String(sysD.content || '')), '(d) text path does NOT inject the vision-path regimen');
    // (d2) tool screenshot fields are RETAINED in the tool result (NOT converted to an image message).
    const gotD = await getJson(WB_PORT, '/api/sessions/' + sidD, hdr);
    const phD = (gotD.session && gotD.session.providerHistory) || [];
    const toolMsgD = phD.find(m => m && m.role === 'tool' && /FAKE_IMAGE_B64/.test(String(m.content || '')));
    ok(!!toolMsgD, '(d) no-vision: tool result KEEPS its image field (not stripped)');
    ok(!phD.some(m => m && m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p && p.type === 'image_url')), '(d) no-vision: NO user image message was injected');

    killp(fake); fake = null;

    // Verdict line MUST follow the harness convention "<NAME> E2E: ALL PASS" — the regression runner
    // greps for "E2E:" to collect verdicts (dev-harness/README.md).
    console.log('\nVISION-LOOP E2E: ' + (fail === 0 ? 'ALL PASS' : `FAIL (${fail})`));
  } catch (e) {
    console.error('E2E ERROR', e && e.stack || e); fail++;
  } finally {
    for (const p of procs) killp(p);
    process.exit(fail === 0 ? 0 : 1);
  }
})();
