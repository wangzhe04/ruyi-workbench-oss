// E2E (v2 跨会话记忆 · 团队模式 v2 Phase 3, 设计稿 C0-C5): file-backed memory library + draft-confirm write +
// fenced progressive injection. Fully offline. Stands up a fake OpenAI provider (request-body capture +
// FAKE_DRAFT_JSON for the draft round-trip) and a fake Claude CLI (argv capture), plus a temp HOME (data
// isolation = dataRoot) and several temp project cwds (each its own projectKey).
//
// Covers C5's five acceptance criteria (each with e2e assertions) + review extras:
//   (1) 起草-确认-落盘全链 + aux 台账 (note:'memory-draft').
//   (2) 双引擎索引注入(<workbench-memory> 围栏 + 「不得覆盖」声明 + 文件绝对路径)且整段 ≤ 2000;--add-dir 含记忆目录.
//   (3) {id,scope} 来源锁定(scope=global 启用,同 id 的 project 记忆不顶替);文件消失 → 幽灵项可清.
//   (4) 项目记忆随 cwd 切换正确换组(两个临时项目各自 projectKey 隔离).
//   (5) 未启用 → 零注入(project 无记忆 + 全局需手动).
//   extras: cwd 越界回退;伪造围栏中和;8000 合成三段优先级(用户 > 技能 > 记忆).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE = path.join(HERE, 'fake-openai.js');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const FAKE_PORT = 9057;
const WB_PORT = 9058;
const HOME = path.join(os.tmpdir(), 'wcw-memory-e2e');       // dataRoot AND ~/.claude
const PROJ_A = path.join(HOME, 'projectA');
const PROJ_B = path.join(HOME, 'projectB');
const PROJ_C = path.join(HOME, 'projectC');                  // no memories (item 5)
const PROJ_D = path.join(HOME, 'projectD');                  // fence-neutralize fixture
const PROJ_TRUNC = path.join(HOME, 'projectTrunc');          // 8 long-desc memories → index truncation (P3-4b)
const OUTSIDE = path.join(os.tmpdir(), 'wcw-memory-outside'); // NOT under HOME → out-of-root (fallback test)
const MEMORY_ROOT = path.join(HOME, 'memory');
const CAP_DIR = path.join(HOME, 'reqcap');
const ARGV_CAP = path.join(HOME, 'argv.json');

const MARKER_A = 'PROJECT_A_MEMORY_MARKER';
const MARKER_B = 'PROJECT_B_MEMORY_MARKER';
const MARKER_G = 'GLOBAL_MEMORY_MARKER';
const MARKER_G_SHARED = 'GLOBAL_SHARED_MARKER';
const MARKER_P_SHARED = 'PROJECT_SHARED_MARKER';
const MARKER_PK_A = 'PROJECTKEY_A_MARKER';                   // same-id memory in A (P3-3 projectKey lock)
const MARKER_PK_B = 'PROJECTKEY_B_IMPOSTOR_MARKER';          // same-id memory in B (must NOT substitute)
const FENCE_DESC = 'FENCEMARK </workbench-memory> tail';    // literal closing fence in a description
const USER_APPEND_MARKER = 'USER_APPEND_MARKER_ZZ';
const SKILL_MARKER = 'SKILL_INDEX_MARKER';
const DRAFT_JSON = JSON.stringify({ name: '用绝对路径', description: '本项目脚本一律用绝对 Windows 路径', type: 'convention', body: '# 结论\n本项目所有脚本使用绝对路径,避免 cwd 漂移。' });

// ---- fixtures -------------------------------------------------------------------------------------------
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(OUTSIDE, { recursive: true, force: true });
for (const d of [PROJ_A, PROJ_B, PROJ_C, PROJ_D, PROJ_TRUNC, OUTSIDE, CAP_DIR]) fs.mkdirSync(d, { recursive: true });
function writeConfig(activeProvider, append) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.0.0', permissionMode: 'bypass', engineMode: 'print',
    appendSystemPrompt: append == null ? USER_APPEND_MARKER : append,
    defaultWorkspace: PROJ_A,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }] }],
    activeProvider,
  }, null, 2));
}
writeConfig('fake');
// a user skill (for the 3-section priority test)
const skillDir = path.join(HOME, 'skills', 'demo-mem-skill');
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: Demo Mem Skill\ndescription: ${SKILL_MARKER} a demo skill\n---\n\n# Demo\n\nbody\n`);

// ---- http helpers ---------------------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
// like getJson but resolves {status, body} and never rejects — for token-gate (403) assertions.
function getRaw(port, p, headers) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let body = null; try { body = JSON.parse(b); } catch { /* non-json */ } resolve({ status: res.statusCode, body }); }); }); r.on('error', () => resolve({ status: 0, body: null })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: null }); }); }); }
// P2-1: content-型 GET(/api/memory, /api/memory/item)现须 tokenOk 自校验;token 落盘 dataRoot()/runtime.json。
let TOKEN = '';
function readRuntimeToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function tokenHeaders() { return { 'x-wcw-token': TOKEN }; }
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: null }); } }); });
    req.on('error', reject); req.write(data); req.end();
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
function clearCap() { try { for (const f of fs.readdirSync(CAP_DIR)) fs.rmSync(path.join(CAP_DIR, f), { force: true }); } catch { /* ignore */ } }
function readCapBodies() { try { return fs.readdirSync(CAP_DIR).filter(f => f.endsWith('.json')).sort().map(f => { try { return JSON.parse(fs.readFileSync(path.join(CAP_DIR, f), 'utf8')); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function sysOfLastStreamBody() { const cap = readCapBodies(); const streamed = cap.filter(b => b.stream !== false); const b = streamed[streamed.length - 1] || cap[cap.length - 1] || {}; return (b.messages && b.messages[0] && b.messages[0].content) || ''; }
function memorySection(sys) { const start = sys.indexOf('以下为本会话已启用的「工作台记忆」索引'); if (start < 0) return ''; const close = sys.indexOf('</workbench-memory>', start); if (close < 0) return ''; return sys.slice(start, close + '</workbench-memory>'.length); }
function readLedgerRows() { try { const dir = path.join(HOME, 'usage'); return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)); } catch { return []; } }

let fake = null;
function startFake(extraEnv) { return new Promise(resolve => { fake = cp.spawn(process.execPath, [FAKE, String(FAKE_PORT)], { windowsHide: true, env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_CAPTURE_DIR: CAP_DIR, FAKE_DRAFT_JSON: DRAFT_JSON, ...extraEnv } }); fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim())); fake.stderr.on('data', d => String(d).trim() && console.log('[fake!] ' + String(d).trim())); setTimeout(resolve, 400); }); }
function stopFake() { return new Promise(resolve => { if (fake && fake.pid) { try { cp.execFileSync('taskkill', ['/PID', String(fake.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } fake = null; setTimeout(resolve, 200); }); }

// save a memory via the API; returns the saved {id,scope,file,...}
async function saveMem(id, scope, name, description, body, cwd) {
  const r = await postJson(WB_PORT, '/api/memory', { memory: { id, scope, name, description, type: 'convention', body }, cwd });
  return r.body && r.body.memory;
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  await startFake({});
  const env = { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, USERPROFILE: HOME, HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_ARGV_CAPTURE: ARGV_CAP };
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);
    TOKEN = readRuntimeToken();
    ok(!!TOKEN, 'read workbench token from runtime.json (for content-GET token gate)');

    // seed base memories
    const gNote = await saveMem('g-note', 'global', 'Global Note', MARKER_G + ' a global memory', 'global body', PROJ_A);
    const aConv = await saveMem('proja-conv', 'project', 'Project A Convention', MARKER_A + ' project A memory', 'A body', PROJ_A);
    const bConv = await saveMem('projb-conv', 'project', 'Project B Convention', MARKER_B + ' project B memory', 'B body', PROJ_B);
    const fenceNote = await saveMem('fence-note', 'project', 'Fence Note', FENCE_DESC, 'fence body', PROJ_D);
    ok(gNote && aConv && bConv && fenceNote, 'seed: saved 4 memories via POST /api/memory');
    ok(gNote && fs.existsSync(gNote.file) && gNote.file.includes(path.join('memory', 'global')), '(1) global memory file lands under memory/global/');
    ok(aConv && fs.existsSync(aConv.file) && aConv.file.includes(path.join('memory', 'project')), '(1) project memory file lands under memory/project/<key>/');

    // ---------- (4) 项目记忆随 cwd 切换换组 ----------
    const regA = await getJson(WB_PORT, '/api/memory?cwd=' + encodeURIComponent(PROJ_A), tokenHeaders());
    const regB = await getJson(WB_PORT, '/api/memory?cwd=' + encodeURIComponent(PROJ_B), tokenHeaders());
    const aIds = new Set((regA.memories || []).filter(m => m.scope === 'project').map(m => m.id));
    const bIds = new Set((regB.memories || []).filter(m => m.scope === 'project').map(m => m.id));
    ok(aIds.has('proja-conv') && !aIds.has('projb-conv'), '(4) cwd=A sees only project A memory');
    ok(bIds.has('projb-conv') && !bIds.has('proja-conv'), '(4) cwd=B sees only project B memory');
    ok(regA.projectKey && regB.projectKey && regA.projectKey !== regB.projectKey && /^[a-f0-9]{16}$/.test(regA.projectKey), '(4) A/B have distinct 16-hex projectKeys (' + regA.projectKey + ' vs ' + regB.projectKey + ')');
    ok((regA.memories || []).some(m => m.scope === 'global' && m.id === 'g-note'), '(4) global memory shows in every cwd');

    // ---------- P2-1: content-型 GET 须带 workbench token(DNS-rebinding 加固,同 /api/file/preview)----------
    const noTok1 = await getRaw(WB_PORT, '/api/memory?cwd=' + encodeURIComponent(PROJ_A));
    ok(noTok1.status === 403, 'P2-1: GET /api/memory WITHOUT token → 403 (返回记忆条目含绝对路径,须自校验)');
    const noTok2 = await getRaw(WB_PORT, '/api/memory/item?id=g-note&scope=global&cwd=' + encodeURIComponent(PROJ_A));
    ok(noTok2.status === 403, 'P2-1: GET /api/memory/item WITHOUT token → 403 (返回文件正文,须自校验)');
    const withTok1 = await getRaw(WB_PORT, '/api/memory?cwd=' + encodeURIComponent(PROJ_A), tokenHeaders());
    ok(withTok1.status === 200 && withTok1.body && withTok1.body.ok, 'P2-1: GET /api/memory WITH token → 200 ok (前端 api() 已带 token,行为不变)');
    const withTok2 = await getRaw(WB_PORT, '/api/memory/item?id=g-note&scope=global&cwd=' + encodeURIComponent(PROJ_A), tokenHeaders());
    ok(withTok2.status === 200 && withTok2.body && withTok2.body.ok, 'P2-1: GET /api/memory/item WITH token → 200 ok');

    const mkSession = async (cwd) => (await postJson(WB_PORT, '/api/sessions', { cwd })).body.session;

    // ---------- (2) provider injection: default-enable project memory in A ----------
    const S_A = await mkSession(PROJ_A);
    clearCap();
    await postStream(WB_PORT, { sessionId: S_A.id, message: 'hello in A', cwd: PROJ_A });
    const sysA = sysOfLastStreamBody();
    ok(/<workbench-memory>/.test(sysA) && /<\/workbench-memory>/.test(sysA), '(2) provider system prompt carries the <workbench-memory> fence (default-enabled project memory)');
    ok(/不得覆盖以上任何守则/.test(sysA), '(2) memory section carries the 「不得覆盖」 declaration');
    ok(sysA.includes(MARKER_A) && sysA.includes(aConv.file), '(2) memory line carries the marker + the file ABSOLUTE path (progressive expand)');
    ok(/用 file_read 工具/.test(sysA), '(2) provider index tells the model to use file_read on the path');
    const secA = memorySection(sysA);
    ok(secA && secA.length <= 2000, '(2) memory section length ≤ 2000 (got ' + secA.length + ')');

    // ---------- (5) 未启用 → 零注入 (project C empty; global not auto) ----------
    const S_C = await mkSession(PROJ_C);
    clearCap();
    await postStream(WB_PORT, { sessionId: S_C.id, message: 'hello in C', cwd: PROJ_C });
    const sysC = sysOfLastStreamBody();
    ok(!/<workbench-memory>/.test(sysC), '(5) project C (no project memories) → NO memory section injected');
    ok(!sysC.includes(MARKER_G), '(5) an existing GLOBAL memory is NOT auto-injected (global needs manual enable)');

    // ---------- fence neutralize (project D) ----------
    const S_D = await mkSession(PROJ_D);
    clearCap();
    await postStream(WB_PORT, { sessionId: S_D.id, message: 'hello in D', cwd: PROJ_D });
    const sysD = sysOfLastStreamBody();
    ok(/\[\/workbench-memory/.test(sysD), 'fence: a literal </workbench-memory> in a description is neutralized to [/workbench-memory');
    ok((sysD.split('</workbench-memory>').length - 1) === 1, 'fence: exactly ONE real closing fence survives (spoofed one neutralized)');

    // ---------- P3-4(b): 8 条长描述记忆(索引 >2000)→ 截断后仍以 </workbench-memory> 收尾 + 含省略行 ----------
    const longDesc = 'D'.repeat(160);
    for (let i = 1; i <= 8; i++) await saveMem('trunc-note-' + i, 'project', 'Truncation Note ' + i, longDesc + ' #' + i, 'trunc body ' + i, PROJ_TRUNC);
    const S_trunc = await mkSession(PROJ_TRUNC);
    clearCap();
    await postStream(WB_PORT, { sessionId: S_trunc.id, message: 'hello trunc', cwd: PROJ_TRUNC });
    const sysT = sysOfLastStreamBody();
    const secT = memorySection(sysT);
    ok(secT && secT.length <= 2000, 'P3-4(b): oversized memory index is clamped to ≤ 2000 (got ' + secT.length + ')');
    ok(secT && secT.endsWith('</workbench-memory>'), 'P3-4(b): truncated index still closes with </workbench-memory> (no dangling open fence)');
    ok(secT && secT.includes('…（记忆索引已截断）'), 'P3-4(b): truncated index carries the ellipsis marker');

    // ---------- P3-1: 正文超 256KB → 拒绝保存(杜绝"保存成功却从列表消失"的幽灵)----------
    const bigBody = 'X'.repeat(256 * 1024 + 16);
    const bigSave = await postJson(WB_PORT, '/api/memory', { memory: { id: 'too-big-note', scope: 'project', name: 'Too Big', description: 'oversize', type: 'reference', body: bigBody }, cwd: PROJ_A });
    ok(bigSave.status === 400 && bigSave.body && bigSave.body.ok === false && /256KB/.test(bigSave.body.error || ''), 'P3-1: saving a body > 256KB is rejected with a clear 「超过 256KB 上限」 error');
    const regAfterBig = await getJson(WB_PORT, '/api/memory?cwd=' + encodeURIComponent(PROJ_A), tokenHeaders());
    ok(!(regAfterBig.memories || []).some(m => m.id === 'too-big-note'), 'P3-1: the rejected oversized memory did NOT land on disk (no ghost)');
    // just-under the limit still saves (boundary sanity)
    const okBody = 'Y'.repeat(256 * 1024 - 64);
    const okSave = await postJson(WB_PORT, '/api/memory', { memory: { id: 'big-ok-note', scope: 'project', name: 'Big OK', description: 'at limit', type: 'reference', body: okBody }, cwd: PROJ_A });
    ok(okSave.status === 200 && okSave.body && okSave.body.ok, 'P3-1: a body just under 256KB still saves fine');

    // ---------- P2-4: migrate 同 id 冲突 → 409(不覆盖、不删源)----------
    await saveMem('dup-note', 'project', 'Dup in A', 'dup A', 'A DUP BODY MARKER', PROJ_A);
    await saveMem('dup-note', 'project', 'Dup in B', 'dup B', 'B dup body', PROJ_B);
    const migConflict = await postJson(WB_PORT, '/api/memory/migrate', { id: 'dup-note', fromKey: regB.projectKey, cwd: PROJ_A });
    ok(migConflict.status === 409 && migConflict.body && migConflict.body.conflict === true, 'P2-4: migrating an id that already exists in the target group → 409 conflict');
    const regBafter = await getJson(WB_PORT, '/api/memory?cwd=' + encodeURIComponent(PROJ_B), tokenHeaders());
    ok((regBafter.memories || []).some(m => m.id === 'dup-note' && m.scope === 'project'), 'P2-4: conflict did NOT delete the SOURCE memory (still in B)');
    const dupItemA = await getJson(WB_PORT, '/api/memory/item?id=dup-note&scope=project&cwd=' + encodeURIComponent(PROJ_A), tokenHeaders());
    ok(dupItemA && dupItemA.ok && /A DUP BODY MARKER/.test(dupItemA.memory.body), 'P2-4: TARGET memory was NOT overwritten by the rejected migration');
    // contrast: migrating a UNIQUE id from B → A still succeeds (200)
    await saveMem('uniq-b-note', 'project', 'Unique B', 'uniq', 'uniq b body', PROJ_B);
    const migOk = await postJson(WB_PORT, '/api/memory/migrate', { id: 'uniq-b-note', fromKey: regB.projectKey, cwd: PROJ_A });
    ok(migOk.status === 200 && migOk.body && migOk.body.ok, 'P2-4: migrating a non-conflicting id still succeeds (200)');

    // ---------- P3-3: 换 cwd → project 记忆 projectKey 失配 → 跳过注入 + stderr 通知(防同 id 顶替调包)----------
    await saveMem('pk-note', 'project', 'PK in A', MARKER_PK_A + ' the A one', 'A pk body', PROJ_A);
    await saveMem('pk-note', 'project', 'PK in B', MARKER_PK_B + ' the B impostor', 'B pk body', PROJ_B);
    const S_pk = await mkSession(PROJ_A); // session cwd = A → 启用时锁定 projectKey = keyA
    const enPk = await postJson(WB_PORT, '/api/session/memories', { sessionId: S_pk.id, memories: [{ id: 'pk-note', scope: 'project' }] });
    ok(enPk.body && enPk.body.ok && enPk.body.memories[0] && enPk.body.memories[0].projectKey === regA.projectKey, 'P3-3: enabling a project memory stamps the current projectKey (lock to source project)');
    clearCap();
    const pkEvents = await postStream(WB_PORT, { sessionId: S_pk.id, message: 'pk turn in B', cwd: PROJ_B }); // 换到 cwd=B
    const sysPk = sysOfLastStreamBody();
    ok(!sysPk.includes(MARKER_PK_A) && !sysPk.includes(MARKER_PK_B), 'P3-3: projectKey mismatch → NEITHER the original nor the same-id B impostor is injected');
    ok(pkEvents.some(e => e && e.type === 'stderr' && /来源项目已变化/.test(String(e.text || '')) && /pk-note/.test(String(e.text || ''))), 'P3-3: a stderr notice fires — 记忆 pk-note 来源项目已变化,已暂停注入');

    // ---------- (1) draft → confirm → persist + aux ledger ----------
    const S_draft = await mkSession(PROJ_A);
    await postStream(WB_PORT, { sessionId: S_draft.id, message: '请把本项目的路径规范整理成一条记忆', cwd: PROJ_A });
    const draftR = await postJson(WB_PORT, '/api/memory/draft', { sessionId: S_draft.id });
    ok(draftR.body && draftR.body.ok && draftR.body.draft && draftR.body.draft.name === '用绝对路径' && draftR.body.draft.type === 'convention', '(1) POST /api/memory/draft returns a parsed {name,description,type,body} draft');
    ok(draftR.body.draft.sourceSessionId === S_draft.id, '(1) draft carries sourceSessionId of the session');
    const saveDraft = await postJson(WB_PORT, '/api/memory', { memory: { ...draftR.body.draft, id: 'drafted-conv', scope: 'global' }, cwd: PROJ_A });
    ok(saveDraft.body && saveDraft.body.ok && saveDraft.body.memory && fs.existsSync(saveDraft.body.memory.file), '(1) confirming the draft persists the memory file to disk');
    ok(readLedgerRows().some(r => r.kind === 'aux' && r.note === 'memory-draft'), '(1) an aux ledger row (note:memory-draft) was written for the draft call');

    // ---------- (3) {id,scope} source lock + ghost cleanup ----------
    const gShared = await saveMem('shared-note', 'global', 'Shared Global', MARKER_G_SHARED + ' the GLOBAL one', 'g shared body', PROJ_A);
    const pShared = await saveMem('shared-note', 'project', 'Shared Project', MARKER_P_SHARED + ' the PROJECT one', 'p shared body', PROJ_A);
    ok(gShared && pShared && gShared.file !== pShared.file, '(3) same-id memory can exist in BOTH global and project scope (distinct files)');
    const S_lock = await mkSession(PROJ_A);
    const enLock = await postJson(WB_PORT, '/api/session/memories', { sessionId: S_lock.id, memories: [{ id: 'shared-note', scope: 'global' }] });
    ok(enLock.body && enLock.body.ok && JSON.stringify(enLock.body.memories) === JSON.stringify([{ id: 'shared-note', scope: 'global' }]), '(3) explicit enable {shared-note, scope:global} accepted (existence-checked)');
    clearCap();
    await postStream(WB_PORT, { sessionId: S_lock.id, message: 'lock turn', cwd: PROJ_A });
    const sysLock = sysOfLastStreamBody();
    ok(sysLock.includes(gShared.file) && sysLock.includes(MARKER_G_SHARED), '(3) scope lock: the GLOBAL shared-note is injected (its file path)');
    ok(!sysLock.includes(pShared.file) && !sysLock.includes(MARKER_P_SHARED), '(3) scope lock: the same-id PROJECT shared-note does NOT substitute (scope mismatch skipped)');
    // delete the global file → the enabled {shared-note,global} becomes a ghost; project one must NOT fill in
    const del = await postJson(WB_PORT, '/api/memory/shared-note', { scope: 'global', cwd: PROJ_A }, { 'x-http-method': 'DELETE' });
    ok(del.body && del.body.ok, '(3) DELETE (via POST + x-http-method) removes the global shared-note file');
    clearCap();
    await postStream(WB_PORT, { sessionId: S_lock.id, message: 'ghost turn', cwd: PROJ_A });
    const sysGhost = sysOfLastStreamBody();
    ok(!/<workbench-memory>/.test(sysGhost), '(3) file gone → ghost enabled entry injects nothing (project same-id NOT substituted)');
    // ghost cleanup via explicit set
    const clean = await postJson(WB_PORT, '/api/session/memories', { sessionId: S_lock.id, memories: [] });
    ok(clean.body && clean.body.ok && clean.body.memories.length === 0, '(3) ghost cleanup: POST /api/session/memories [] clears the stale entry');

    // ---------- cwd out-of-root fallback ----------
    const regOutside = await getJson(WB_PORT, '/api/memory?cwd=' + encodeURIComponent(OUTSIDE), tokenHeaders());
    ok(regOutside && regOutside.ok && regOutside.projectKey === regA.projectKey, 'extra: cwd outside allowed roots → silently falls back to defaultWorkspace (projectKey == A)');

    // ---------- (2b) Claude engine injection + --add-dir + (extra) 3-section priority ----------
    // enable a skill on a fresh A session, keep the default project memory enabled → user append + skill + memory
    const S_claude = await mkSession(PROJ_A);
    await postJson(WB_PORT, '/api/session/skills', { sessionId: S_claude.id, skills: ['demo-mem-skill'] });
    writeConfig('', USER_APPEND_MARKER); // switch to Claude engine (activeProvider empty), small user append
    await sleep(200);
    try { fs.rmSync(ARGV_CAP, { force: true }); } catch { /* ignore */ }
    await postStream(WB_PORT, { sessionId: S_claude.id, message: 'hello claude with memory', cwd: PROJ_A });
    let argv = []; for (let i = 0; i < 25 && !fs.existsSync(ARGV_CAP); i++) await sleep(100);
    try { argv = JSON.parse(fs.readFileSync(ARGV_CAP, 'utf8')); } catch { /* empty */ }
    const ai = argv.indexOf('--append-system-prompt');
    const appendVal = ai >= 0 ? String(argv[ai + 1] || '') : '';
    ok(ai >= 0 && /<workbench-memory>/.test(appendVal), '(2b) Claude --append-system-prompt carries the <workbench-memory> index');
    ok(appendVal.includes(aConv.file) && /用 Read 工具/.test(appendVal), '(2b) Claude memory index gives the file path + tells the model to use Read');
    ok(appendVal.length <= 8000, '(2b) Claude combined append ≤ 8000 (got ' + appendVal.length + ')');
    const iUser = appendVal.indexOf(USER_APPEND_MARKER), iSkill = appendVal.indexOf('<skill-index>'), iMem = appendVal.indexOf('<workbench-memory>');
    ok(iUser >= 0 && iSkill > iUser && iMem > iSkill, 'extra: 3-section priority — user append < skill index < memory index (got ' + iUser + ',' + iSkill + ',' + iMem + ')');
    // P2-2: --add-dir 最小授权 —— 只加「当前项目组」记忆目录(project 记忆已启用),不再暴露整个记忆根(其它项目组 + meta.json)。
    const addDirIdxs = argv.map((a, i) => a === '--add-dir' ? argv[i + 1] : null).filter(Boolean);
    const PROJ_A_MEM_DIR = path.join(MEMORY_ROOT, 'project', regA.projectKey);
    ok(addDirIdxs.some(d => path.resolve(d) === path.resolve(PROJ_A_MEM_DIR)), 'P2-2: main-round Claude spawn adds --add-dir <当前项目组记忆目录> when project memory enabled');
    ok(!addDirIdxs.some(d => path.resolve(d) === path.resolve(MEMORY_ROOT)), 'P2-2: minimal authorization — the BARE memory root is NOT added (no cross-project/meta exposure)');

    // ---------- (extra) near-max user append → memory section dropped, marker kept, ≤ 8000 ----------
    const longAppend = 'Q'.repeat(3950) + USER_APPEND_MARKER + 'Q'.repeat(3950);
    writeConfig('', longAppend); // still Claude
    await sleep(200);
    try { fs.rmSync(ARGV_CAP, { force: true }); } catch { /* ignore */ }
    await postStream(WB_PORT, { sessionId: S_claude.id, message: 'hello claude long append', cwd: PROJ_A });
    let argv2 = []; for (let i = 0; i < 25 && !fs.existsSync(ARGV_CAP); i++) await sleep(100);
    try { argv2 = JSON.parse(fs.readFileSync(ARGV_CAP, 'utf8')); } catch { /* empty */ }
    const ai2 = argv2.indexOf('--append-system-prompt');
    const appendVal2 = ai2 >= 0 ? String(argv2[ai2 + 1] || '') : '';
    ok(appendVal2.includes(USER_APPEND_MARKER) && appendVal2.length <= 8000, 'extra: near-max user append keeps user marker + total ≤ 8000 (got ' + appendVal2.length + ')');
    // P3-4(a): 双向断言 —— 整体丢弃(既无闭合围栏也无开围栏),区分「整体丢弃」与「悬空开围栏」两种失败。
    ok(!/<\/workbench-memory>/.test(appendVal2), 'P3-4(a): near-max append → NO closing </workbench-memory>');
    ok(!/<workbench-memory>/.test(appendVal2), 'P3-4(a): near-max append → NO opening <workbench-memory> either (whole section dropped, not a dangling open fence)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    await stopFake();
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(OUTSIDE, { recursive: true, force: true });
    console.log('\nWORKBENCH-MEMORY E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
