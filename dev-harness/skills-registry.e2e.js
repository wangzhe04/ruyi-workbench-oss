// E2E (v1 技能体系): unified skill registry + session enable + progressive prompt injection + skill_read tool.
// Fully offline. Stands up a fake OpenAI-compatible provider (request-body capture + tool sequence) and a fake
// Claude CLI (argv capture), plus a temp HOME (data isolation) and a temp cwd project with a .ruyi/skills fixture.
//
// Asserts:
//   (a) GET /api/skills?cwd= merges FOUR sources (builtin skill / user skill / project skill / command / playbook)
//       and a project skill OVERRIDES a same-id user skill.
//   (b) POST /api/session/skills: enable valid ids (each stored as {id, source} — P2-2), cap at 8 (send 10 →
//       keep exactly the first 8), reject invalid/non-skill ids.
//   (c) A provider turn with skills enabled: captured request body's system prompt carries the skill index line
//       AND the tools array carries skill_read.
//   (d) With FAKE_TOOL_SEQUENCE the model calls skill_read{id:demo-skill} → tool_result carries the SKILL.md full
//       text + a files list; a follow-up skill_read for a NON-enabled id → tool_result ok:false (whitelist guard);
//       skill_read{id:demo-skill,file:helper.md} → returns that file's content (P3-1); an out-of-dir file → ok:false.
//   (e) Claude engine turn: --append-system-prompt carries BOTH config.appendSystemPrompt AND the skill index,
//       total length ≤ 8000. (e2) with a ~7900-char user append the skill section is dropped/truncated but the
//       user marker survives and the total stays ≤ 8000 (P3-8).
//   (f) Regression: a session with NO skills enabled → provider system has no skill section + tools has no skill_read.
//   (g) P2-2 source lock: a skill enabled from the original cwd (source=builtin) is NOT injected after a turn runs
//       in a different cwd where a same-id PROJECT skill shadows it (source mismatch → injection skipped).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE = path.join(HERE, 'fake-openai.js');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const FAKE_PORT = 9103;
const WB_PORT = 9104;
const HOME = path.join(os.tmpdir(), 'wcw-skills-registry-e2e');   // isolated data home AND ~/.claude
const CWD = path.join(HOME, 'project');                          // isolated project cwd (holds .ruyi/skills)
const CAP_DIR = path.join(HOME, 'reqcap');                       // fake-openai request-body capture dir
const ARGV_CAP = path.join(HOME, 'argv.json');                   // fake-claude argv capture
const USER_APPEND_MARKER = 'USER_APPEND_MARKER_ZZ';
const PROJECT_DEMO_MARKER = 'PROJECT_DEMO_MARKER';
const PROJECT_SKILL_BODY = 'PROJECT_DEMO_SKILL_BODY_XYZ';

// ---- fixtures -------------------------------------------------------------------------------------------
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(CAP_DIR, { recursive: true });
// config: fake provider active (provider scenarios) + a user append prompt (Claude scenario).
function writeConfig(activeProvider, append) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.0.0', permissionMode: 'bypass', engineMode: 'print',
    appendSystemPrompt: append == null ? USER_APPEND_MARKER : append,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }] }],
    activeProvider,
  }, null, 2));
}
writeConfig('fake');
// user skill: id 'user-only-skill' (unique) + id 'demo-skill' (will be overridden by the project one).
function writeSkill(baseDir, id, name, desc, body, extraFiles) {
  const dir = path.join(baseDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n\n${body}\n`);
  for (const [fn, content] of Object.entries(extraFiles || {})) fs.writeFileSync(path.join(dir, fn), content);
}
// dataRoot() === WIN_CLAUDE_WORKBENCH_HOME (here HOME) — same convention e2-append-system-prompt relies on
// (it reads config from HOME/config.json). So paths.skills === HOME/skills; user skills live there.
const USER_SKILLS_DIR = path.join(HOME, 'skills');
writeSkill(USER_SKILLS_DIR, 'user-only-skill', 'User Only Skill', 'USER_ONLY_MARKER a user-defined skill', 'user body');
writeSkill(USER_SKILLS_DIR, 'demo-skill', 'Demo User Version', 'USER_VERSION_MARKER should be overridden by project', 'user demo body');
// project skill: .ruyi/skills/demo-skill (overrides the user demo-skill by id).
writeSkill(path.join(CWD, '.ruyi', 'skills'), 'demo-skill', 'Demo Project Skill', PROJECT_DEMO_MARKER + ' a project-scoped skill', PROJECT_SKILL_BODY, { 'helper.md': 'HELPER FILE BODY' });

// ---- http helpers ---------------------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000 }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function postJson(port, p, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: null }); } }); });
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

// ---- fake-openai spawn (restartable with different env) --------------------------------------------------
let fake = null;
function startFake(extraEnv) {
  return new Promise(resolve => {
    fake = cp.spawn(process.execPath, [FAKE, String(FAKE_PORT)], { windowsHide: true, env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_CAPTURE_DIR: CAP_DIR, ...extraEnv } });
    fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
    fake.stderr.on('data', d => String(d).trim() && console.log('[fake!] ' + String(d).trim()));
    setTimeout(resolve, 400);
  });
}
function stopFake() { return new Promise(resolve => { if (fake && fake.pid) { try { cp.execFileSync('taskkill', ['/PID', String(fake.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } fake = null; setTimeout(resolve, 250); }); }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  await startFake({}); // plain fake (no tool sequence) for scenarios (a)(b)(c)(f)
  const env = { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, USERPROFILE: HOME, HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_ARGV_CAPTURE: ARGV_CAP };
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);

    // ---------- (a) registry: four sources + project overrides user ----------
    const reg = await getJson(WB_PORT, '/api/skills?cwd=' + encodeURIComponent(CWD));
    const skills = (reg && reg.skills) || [];
    const byId = new Map(skills.map(s => [s.id, s]));
    const kinds = new Set(skills.map(s => s.kind));
    ok(skills.some(s => s.kind === 'skill' && s.source === 'builtin'), '(a) registry has builtin skills (' + skills.filter(s => s.kind === 'skill' && s.source === 'builtin').length + ')');
    ok(byId.has('user-only-skill') && byId.get('user-only-skill').source === 'user', '(a) user skill present with source=user');
    ok(byId.has('demo-skill') && byId.get('demo-skill').source === 'project', '(a) demo-skill resolved to source=project (override)');
    ok(byId.has('demo-skill') && /PROJECT_DEMO_MARKER/.test(byId.get('demo-skill').description) && !/USER_VERSION_MARKER/.test(byId.get('demo-skill').description), '(a) demo-skill carries the PROJECT description, not the USER one (override)');
    ok(skills.filter(s => s.id === 'demo-skill').length === 1, '(a) demo-skill appears exactly once (user version shadowed)');
    ok(kinds.has('command'), '(a) registry includes commands');
    const builtinCommand = skills.find(s => s.kind === 'command' && s.source === 'builtin');
    ok(builtinCommand && typeof builtinCommand.prompt === 'string' && builtinCommand.prompt.length > 20, '(a) commands expose a provider-compatible full prompt template');
    const builtinDetailedSkill = skills.find(s => s.kind === 'skill' && s.source === 'builtin');
    ok(builtinDetailedSkill && typeof builtinDetailedSkill.detail === 'string' && builtinDetailedSkill.detail.length > 20, '(a) skill cards expose the full authored guide');
    ok(kinds.has('playbook'), '(a) registry includes playbooks');
    ok(skills.some(s => s.kind === 'playbook' && s.id.startsWith('pb:')), '(a) playbook ids carry the pb: prefix');
    // pick 10 skill ids for the cap test; P2-2: enabled skills come back as {id, source} — helper to extract ids.
    const builtinSkillIds = skills.filter(s => s.kind === 'skill').map(s => s.id).slice(0, 10);
    const idsOf = arr => (Array.isArray(arr) ? arr : []).map(x => (typeof x === 'string' ? x : (x && x.id))).filter(Boolean);
    const aBuiltinSkill = skills.find(s => s.kind === 'skill' && s.source === 'builtin'); // for the (g) source-lock test

    // ---------- helper: create a session ----------
    const mkSession = async () => (await postJson(WB_PORT, '/api/sessions', { cwd: CWD })).body.session;
    const S1 = await mkSession();
    const S2 = await mkSession();
    const S3 = await mkSession();

    // ---------- (b) enable API: valid / cap 8 / reject invalid ----------
    const enDemo = await postJson(WB_PORT, '/api/session/skills', { sessionId: S1.id, skills: ['demo-skill'] });
    ok(enDemo.status === 200 && enDemo.body && enDemo.body.ok && JSON.stringify(idsOf(enDemo.body.skills)) === JSON.stringify(['demo-skill']), '(b) enable valid skill → ["demo-skill"] (got ' + JSON.stringify(enDemo.body && enDemo.body.skills) + ')');
    ok(enDemo.body && enDemo.body.skills && enDemo.body.skills[0] && enDemo.body.skills[0].source === 'project', '(b) P2-2: enabled skill is stored as {id, source} with the registry source (project) (got ' + JSON.stringify(enDemo.body && enDemo.body.skills) + ')');
    const enMany = await postJson(WB_PORT, '/api/session/skills', { sessionId: S3.id, skills: builtinSkillIds });
    ok(enMany.body && enMany.body.ok && Array.isArray(enMany.body.skills) && enMany.body.skills.length === 8, '(b) enabling 10 skills caps at 8 (got ' + (enMany.body && enMany.body.skills && enMany.body.skills.length) + ')');
    ok(JSON.stringify(idsOf(enMany.body && enMany.body.skills)) === JSON.stringify(builtinSkillIds.slice(0, 8)), '(b) P3-8: the cap keeps exactly the first 8 ids (got ' + JSON.stringify(idsOf(enMany.body && enMany.body.skills)) + ')');
    const enBad = await postJson(WB_PORT, '/api/session/skills', { sessionId: S2.id, skills: ['demo-skill', 'no-such-skill', 'api-probe', 'pb:merge-excel', 'demo-skill'] });
    ok(enBad.body && JSON.stringify(idsOf(enBad.body.skills)) === JSON.stringify(['demo-skill']), '(b) invalid/non-skill/duplicate ids rejected → only ["demo-skill"] (got ' + JSON.stringify(enBad.body && enBad.body.skills) + ')');
    const enMissing = await postJson(WB_PORT, '/api/session/skills', { sessionId: 'nope_' + Date.now(), skills: ['demo-skill'] });
    ok(enMissing.status === 404, '(b) unknown sessionId → 404 (got ' + enMissing.status + ')');
    // reset S2 to no skills for the regression test
    await postJson(WB_PORT, '/api/session/skills', { sessionId: S2.id, skills: [] });

    // ---------- (c) provider turn WITH skills → system + tools carry skills ----------
    clearCap();
    await postStream(WB_PORT, { sessionId: S1.id, message: 'hello with skills', cwd: CWD });
    const capC = readCapBodies();
    const reqC = capC.find(b => Array.isArray(b.tools)) || capC[0] || {};
    const sysC = (reqC.messages && reqC.messages[0] && reqC.messages[0].content) || '';
    ok(/已启用的技能/.test(sysC), '(c) provider system prompt carries the skill index header');
    ok(sysC.includes('[demo-skill]') && sysC.includes(PROJECT_DEMO_MARKER), '(c) skill index line has the demo-skill id + description marker');
    ok(Array.isArray(reqC.tools) && reqC.tools.some(t => t.function && t.function.name === 'skill_read'), '(c) tools array includes skill_read when a skill is enabled');

    // ---------- (f) regression: provider turn WITHOUT skills → no skill section, no skill_read ----------
    clearCap();
    await postStream(WB_PORT, { sessionId: S2.id, message: 'hello no skills', cwd: CWD });
    const capF = readCapBodies();
    const reqF = capF.find(b => Array.isArray(b.tools)) || capF[0] || {};
    const sysF = (reqF.messages && reqF.messages[0] && reqF.messages[0].content) || '';
    ok(!/已启用的技能/.test(sysF), '(f) no-skills session: system prompt has NO skill index section');
    ok(Array.isArray(reqF.tools) && !reqF.tools.some(t => t.function && t.function.name === 'skill_read'), '(f) no-skills session: tools array has NO skill_read');

    // ---------- (f2) resident skill: config-level selection is effective without a session toggle ----------
    const cfgResident = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    cfgResident.residentSkills = [{ id: 'user-only-skill', source: 'user' }];
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(cfgResident, null, 2));
    clearCap();
    await postStream(WB_PORT, { sessionId: S2.id, message: 'hello resident skill', cwd: CWD });
    const capR = readCapBodies();
    const reqR = capR.find(b => Array.isArray(b.tools)) || capR[0] || {};
    const sysR = (reqR.messages && reqR.messages[0] && reqR.messages[0].content) || '';
    ok(sysR.includes('[user-only-skill]') && /USER_ONLY_MARKER/.test(sysR), '(f2) resident skill is injected into a chat with no session skills');
    ok(Array.isArray(reqR.tools) && reqR.tools.some(t => t.function && t.function.name === 'skill_read'), '(f2) resident skill enables skill_read');
    cfgResident.residentSkills = [];
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(cfgResident, null, 2));

    // ---------- (g) P2-2 source lock: same-id project skill after a cwd change → injection skipped ----------
    // Build an ALTERNATE cwd whose .ruyi/skills holds a project skill with the SAME id as a builtin skill.
    const ALT_CWD = path.join(HOME, 'project2');
    fs.mkdirSync(ALT_CWD, { recursive: true });
    const lockId = aBuiltinSkill && aBuiltinSkill.id;
    writeSkill(path.join(ALT_CWD, '.ruyi', 'skills'), lockId, 'Hijacked Project Skill', 'HIJACK_MARKER masquerading project skill', 'hijack body');
    const S4 = await mkSession(); // cwd = CWD (no same-id project skill there) → enabling locks source=builtin
    const enLock = await postJson(WB_PORT, '/api/session/skills', { sessionId: S4.id, skills: [lockId] });
    ok(enLock.body && enLock.body.skills && enLock.body.skills[0] && enLock.body.skills[0].source === 'builtin', '(g) skill enabled from original cwd locks source=builtin (got ' + JSON.stringify(enLock.body && enLock.body.skills) + ')');
    clearCap();
    await postStream(WB_PORT, { sessionId: S4.id, message: 'turn in alt cwd', cwd: ALT_CWD }); // now the id resolves to source=project → mismatch
    const capG = readCapBodies();
    const reqG = capG.find(b => Array.isArray(b.tools)) || capG[0] || {};
    const sysG = (reqG.messages && reqG.messages[0] && reqG.messages[0].content) || '';
    ok(!/已启用的技能/.test(sysG), '(g) source mismatch (builtin locked, project now shadows it) → skill index NOT injected');
    ok(!/HIJACK_MARKER/.test(sysG), '(g) the shadowing project skill is not injected');
    ok(Array.isArray(reqG.tools) && !reqG.tools.some(t => t.function && t.function.name === 'skill_read'), '(g) source mismatch → no skill_read tool offered');

    // ---------- (d) skill_read round-trip (enabled ok + non-enabled rejected + file param + out-of-dir file) ----------
    await stopFake();
    await startFake({ FAKE_TOOL_SEQUENCE: JSON.stringify([
      { name: 'skill_read', args: { id: 'demo-skill' } },
      { name: 'skill_read', args: { id: 'windows-control' } },
      { name: 'skill_read', args: { id: 'demo-skill', file: 'helper.md' } },
      { name: 'skill_read', args: { id: 'demo-skill', file: '../../../secret.txt' } },
    ]) });
    const evD = await postStream(WB_PORT, { sessionId: S1.id, message: 'read the demo skill', cwd: CWD });
    const results = evD.filter(e => e.type === 'tool_result').map(e => e.content).filter(Boolean);
    const rDemo = results.find(r => r && r.id === 'demo-skill' && !r.file); // manifest read (no file field)
    const rWin = results.find(r => r && r.id === 'windows-control');
    const rFile = results.find(r => r && r.file === 'helper.md');
    const rBad = results.find(r => r && r.file === '../../../secret.txt');
    ok(rDemo && rDemo.ok === true, '(d) skill_read{demo-skill} → ok:true');
    ok(rDemo && typeof rDemo.content === 'string' && rDemo.content.includes(PROJECT_SKILL_BODY), '(d) skill_read result carries the SKILL.md full text');
    ok(rDemo && Array.isArray(rDemo.files) && rDemo.files.includes('helper.md') && rDemo.files.includes('SKILL.md'), '(d) skill_read result lists directory files (got ' + JSON.stringify(rDemo && rDemo.files) + ')');
    ok(rWin && rWin.ok === false, '(d) skill_read{windows-control} (NOT enabled in this session) → ok:false (whitelist/path guard)');
    ok(rFile && rFile.ok === true && typeof rFile.content === 'string' && rFile.content.includes('HELPER FILE BODY'), '(d) P3-1: skill_read{demo-skill,file:helper.md} → returns that file content (got ' + JSON.stringify(rFile && { ok: rFile.ok, len: (rFile.content || '').length }) + ')');
    ok(rBad && rBad.ok === false, '(d) P3-1: skill_read with an out-of-dir file (../../../secret.txt) → ok:false (path guard)');

    // ---------- (e) Claude engine: append-system-prompt carries user append + skill index, ≤8000 ----------
    await stopFake();
    writeConfig(''); // switch engine to Claude CLI (activeProvider empty)
    await sleep(200);
    try { fs.rmSync(ARGV_CAP, { force: true }); } catch { /* ignore */ }
    await postStream(WB_PORT, { sessionId: S1.id, message: 'hello claude with skills', cwd: CWD });
    let argv = [];
    for (let i = 0; i < 20 && !fs.existsSync(ARGV_CAP); i++) await sleep(100);
    try { argv = JSON.parse(fs.readFileSync(ARGV_CAP, 'utf8')); } catch { /* left empty */ }
    const ai = argv.indexOf('--append-system-prompt');
    const appendVal = ai >= 0 ? String(argv[ai + 1] || '') : '';
    ok(ai >= 0, '(e) Claude spawn carries --append-system-prompt (argv len ' + argv.length + ')');
    ok(appendVal.includes(USER_APPEND_MARKER), '(e) append value keeps the user config.appendSystemPrompt marker');
    ok(/已启用的技能/.test(appendVal) && appendVal.includes('demo-skill'), '(e) append value also carries the skill index (demo-skill)');
    ok(appendVal.length <= 8000, '(e) combined append length ≤ 8000 (got ' + appendVal.length + ')');

    // ---------- (e2) P3-8: a ~7900-char user append leaves ~no room → skill section dropped/truncated, marker kept, ≤8000 ----------
    const longAppend = 'Q'.repeat(3950) + USER_APPEND_MARKER + 'Q'.repeat(3950); // ~7921 chars (config clamps to 8000)
    writeConfig('', longAppend); // still Claude engine, but with a near-max user append
    await sleep(200);
    try { fs.rmSync(ARGV_CAP, { force: true }); } catch { /* ignore */ }
    await postStream(WB_PORT, { sessionId: S1.id, message: 'hello claude long append', cwd: CWD });
    let argv2 = [];
    for (let i = 0; i < 20 && !fs.existsSync(ARGV_CAP); i++) await sleep(100);
    try { argv2 = JSON.parse(fs.readFileSync(ARGV_CAP, 'utf8')); } catch { /* left empty */ }
    const ai2 = argv2.indexOf('--append-system-prompt');
    const appendVal2 = ai2 >= 0 ? String(argv2[ai2 + 1] || '') : '';
    ok(appendVal2.includes(USER_APPEND_MARKER), '(e2) long append keeps the user marker');
    ok(appendVal2.length <= 8000, '(e2) long append total still ≤ 8000 (got ' + appendVal2.length + ')');
    ok(!/<\/skill-index>/.test(appendVal2), '(e2) long append leaves ~no room → skill index dropped/truncated (no closing <skill-index> fence)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    await stopFake();
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSKILLS-REGISTRY E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
