'use strict';
// E2E:记忆预检/显式检索的快照令牌回验(150 号文 S2 / S12 / S16;151 号文阶段 2「记忆预检提速」)。
// 真 06d/06hc 源码(按 manifest 拼接)、真记忆文件、临时 HOME、合成编码器、断网可跑。
//
//   [R] 回合内全量读注册表 ≤1 次:语义开且模型 ready(走重排)、语义关、模型加载中三种条件下,一次预检只读一次注册表目录;
//       预热窗口内未就绪时交基线。
//   [V] 廉价令牌比对没有放过任何一种撤回/变化(每条都在编码期间发生):同尺寸且 mtime 还原的进程外改写、进程外删除、
//       到期时刻越过、用量变动挤动核心席位、取代边确认、同尺寸改写配置文件。被合并掉的回验点由保留点兜住的证据。
//   [X] 显式检索:最旧的目标在一次调用内找到(S16 连续翻页),这一次调用只读一次注册表;同尺寸 mtime 还原的改写照样拒绝。
//
// 反向验证:RUYI_MEMORY_SNAPSHOT_SRC=<修前 src 目录> 跑同一份断言,[R]/[X1] 应红、[V]/[X2] 应绿(不变量在修前就成立)。
require('./lib/self-isolate-home');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
const { createRunner } = require('./lib/harness');
const t = createRunner('MEMORY PREFLIGHT SNAPSHOT'), { ok } = t;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-snapshot-'));
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home; process.env.RUYI_DISABLE_SEMANTIC = '1';
const config = { configSchema: 9, permissionMode: 'bypass', semanticRetrievalV1: true, runtimeMemoryVectorRecallV1: true, memoryRelevanceMaxV1: 8, autoImportClaudeCodeMcp: false };
const configFile = path.join(home, 'config.json');
fs.writeFileSync(configFile, JSON.stringify(config));
const app = path.resolve(__dirname, '../ruyi-workbench/app');
const srcDir = process.env.RUYI_MEMORY_SNAPSHOT_SRC ? path.resolve(process.env.RUYI_MEMORY_SNAPSHOT_SRC) : path.join(app, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
const source = manifest.modules.map(m => fs.readFileSync(path.join(srcDir, typeof m === 'string' ? m : m.file), 'utf8')).join('\n');
// 计数:注册表的每次全量读都会 readdir 项目记忆目录一次。
const fsp = require('node:fs/promises'), realReaddir = fsp.readdir;
let projectDir = '', projectReads = 0;
fsp.readdir = function (target, ...rest) { if (projectDir && path.resolve(String(target)) === projectDir) projectReads++; return realReaddir.call(this, target, ...rest); };
const mod = new Module(path.join(app, 'server.js'), module); mod.filename = path.join(app, 'server.js'); mod.paths = Module._nodeModulePaths(app);
mod._compile(source + '\nmodule.exports.__test={resolveMemoryPreflight,loadMemoryRegistry,resolveCoreMemoryState,touchMemoryUsage,memoryProjectDir,proposeMemoryRelation,confirmMemoryRelation,activeChildren,setAuthority:fn=>{const old=memoryBodyAuthority;memoryBodyAuthority=fn;return old;},setRuntime:hooks=>Object.assign(SemanticRuntimeHooks,hooks),clearSemantic:()=>MemorySemanticHooks.clear()};', mod.filename);
const srv = mod.exports, a = srv.__test;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ids = entries => entries.map(entry => entry.id).sort().join(',');
// 先把 mtime 钉到整秒(utimes 精度到不了 100 ns,钉整秒才能原样还原),注册表读到的就是这个值。
function pinMtime(file) { const st = fs.statSync(file), whole = new Date(Math.floor(st.mtimeMs / 1000) * 1000); fs.utimesSync(file, whole, whole); }
// 进程外同尺寸改写并把 mtime 还原:size 与 mtime 都不变,只有 ctime 推进(utimes 改不回 ctime)。
function rewriteSameSize(file, from, to) {
  if (from.length !== to.length) throw Error('fixture: same-size rewrite needs equal lengths');
  const st = fs.statSync(file), text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) throw Error('fixture: rewrite anchor missing');
  fs.writeFileSync(file, text.replace(from, to)); fs.utimesSync(file, st.atime, st.mtime);
  const after = fs.statSync(file);
  return after.size === st.size && after.mtimeMs === st.mtimeMs;
}
(async () => {
  try {
    const cwd = path.join(home, 'project'); fs.mkdirSync(cwd);
    projectDir = path.resolve(a.memoryProjectDir(cwd));
    const session = await srv.createSession({ title: 'memory snapshot test', cwd }); session.turnSeq = 1;
    const save = async (id, name, extra = {}) => {
      const result = await srv.saveMemory({ id, scope: 'project', type: 'reference', name, description: name, body: 'body ' + id, ...extra }, cwd);
      if (!result.ok) throw Error('fixture save failed: ' + id); return result.memory;
    };
    await save('alpha-one', 'alpha first'); await save('alpha-two', 'alpha beta second'); await save('alpha-three', 'alpha third note');
    await save('core-rule', 'house style core', { type: 'preference', core: true });
    for (let i = 0; i < 40; i++) await save('filler-' + i, 'unrelated filler ' + i);
    // 刚写过的文件在时间戳粒度窗口内不当快照基线(复核 F3),读次数类断言要在窗口过后量。
    await sleep(2700);
    let onEncode = null, encodeCalls = 0, prepareCalls = 0, prewarmCalls = 0;
    const ready = () => ({ available: true, state: 'ready', modelFingerprint: 'synthetic-snapshot-model', modelId: 'synthetic-scalar-model', retrievalThresholds: { search: .34, automatic: null } });
    const encodeLog = []; let onDocEncode = null;
    const encode = async (texts, { role }) => {
      encodeCalls++; encodeLog.push({ role, texts: texts.slice() });
      if (onEncode) { const action = onEncode; onEncode = null; await action(); }
      if (role === 'document' && onDocEncode) { const action = onDocEncode; onDocEncode = null; await action(); }
      return { ok: true, modelFingerprint: 'synthetic-snapshot-model', vectors: texts.map(text => role === 'query' || /beta|证书/.test(text) ? [1, 0] : [0, 1]), truncated: texts.map(() => false) };
    };
    const normal = () => a.setRuntime({ prepare: async () => { prepareCalls++; return ready(); }, encode, descriptor: () => ready(), prewarm: async () => { prewarmCalls++; return ready(); } });
    normal();
    const preflight = async (query, cfg = config, options = {}) => { a.clearSemantic(); const before = projectReads; const result = await a.resolveMemoryPreflight(session, cwd, query, null, cfg, options); return { result, reads: projectReads - before }; };

    // ── [R] 读次数与 S12 ──
    let r = await preflight('alpha');
    ok(r.result.status.semantic?.status === 'reranked' && r.result.entries[0]?.id === 'alpha-two', `R1a 语义开、模型 ready:照常重排(${r.result.status.semantic?.status})`);
    ok(r.reads === 1, `R1b 走重排的一次预检只全量读一次注册表(实际 ${r.reads} 次;修前 6 次)`);
    r = await preflight('alpha', { ...config, semanticRetrievalV1: false });
    ok(r.result.status.semantic?.status === 'disabled' && r.reads === 1, `R2 语义关:一次预检只读一次注册表(实际 ${r.reads} 次;修前 4 次)`);
    prepareCalls = 0; prewarmCalls = 0;
    a.setRuntime({ descriptor: () => ({ available: false, state: 'loading', modelFingerprint: '' }),
      prepare: async () => { prepareCalls++; await sleep(250); return { available: false, reason: 'unavailable', state: 'loading' }; } });
    const t0 = Date.now(); r = await preflight('alpha'); const loadingMs = Date.now() - t0;
    ok(r.result.status.semantic?.status === 'loading' && r.result.status.semantic?.fallback?.reason === 'loading', `R3a 模型加载中:回执 loading、按基线交付(${r.result.status.semantic?.status})`);
    ok(prepareCalls === 1 && prewarmCalls === 0, `R3b 加载中等待一次 prepare(prepare=${prepareCalls}, prewarm=${prewarmCalls})`);
    ok(r.reads === 1, `R3c 也只读一次注册表(${r.reads};本次 ${loadingMs} ms)`);
    normal();

    // ── [V] 令牌比对不放过任何变化 ──
    // V0(复核 F3):刚写过的文件在粒度窗口内只认内容。写完立刻预检,编码期间同尺寸改写它 —— 不靠 stat 也认得出。
    await save('alpha-fresh', 'alpha fresh note');
    const freshFile = path.join(projectDir, 'alpha-fresh.md');
    let v0Fired = false; onEncode = () => { v0Fired = true; fs.writeFileSync(freshFile, fs.readFileSync(freshFile, 'utf8').replace('alpha fresh note', 'alpha FRESH note')); };
    r = await preflight('alpha fresh'); onEncode = null;
    ok(v0Fired && r.result.status.recovered === 'stale' && r.result.entries.find(entry => entry.id === 'alpha-fresh')?.name === 'alpha FRESH note',
      `V0 粒度窗口内的同尺寸改写:按内容摘要认出,按当前库重算(recovered=${r.result.status.recovered})`);
    // 每条都先钉「变化确实发生在编码期间」(编码确实被调到):修前大库/负载下重排常在编码前就 timeout,那样的轮次不算证据。
    const race = async (label, query, action, cfg = config) => {
      let fired = false; onEncode = async () => { fired = true; await action(); };
      const out = await preflight(query, cfg); onEncode = null;
      ok(fired, label + ' 夹具:变化发生在编码期间(编码确实被调到)'); return out;
    };
    const one = (await a.resolveMemoryPreflight(session, cwd, 'alpha', null, config)).entries.find(entry => entry.id === 'alpha-one');
    pinMtime(one.file);
    r = await race('V1', 'alpha same-size', () => { ok(rewriteSameSize(one.file, 'alpha first', 'alpha FIRST'), 'V1a 夹具:同尺寸改写后 size 与 mtime 都没变'); });
    const v1 = r.result.entries.find(entry => entry.id === 'alpha-one');
    ok(r.result.status.recovered === 'stale' && v1?.name === 'alpha FIRST' && !r.result.entries.some(entry => entry.name === 'alpha first'),
      `V1b 编码期间进程外同尺寸改写(mtime 还原):逐文件 stat(ctime)认出,按当前库重算(recovered=${r.result.status.recovered}, name=${v1?.name})`);
    const three = r.result.entries.find(entry => entry.id === 'alpha-three');
    r = await race('V2', 'alpha delete', () => { fs.rmSync(three.file); });
    ok(r.result.status.recovered === 'stale' && !r.result.entries.some(entry => entry.id === 'alpha-three'), `V2 编码期间进程外删掉一条即将披露的记忆:不披露(recovered=${r.result.status.recovered})`);
    const expiry = new Date(Date.now() + 1500).toISOString();
    await save('alpha-soon', 'alpha soon expiring', { expiresAt: expiry });
    r = await race('V3', 'alpha soon', () => sleep(Math.max(0, Date.parse(expiry) - Date.now() + 60)));
    ok(!r.result.entries.some(entry => entry.id === 'alpha-soon') && r.result.status.recovered === 'stale',
      `V3 编码期间越过到期时刻:过期条目不披露(recovered=${r.result.status.recovered}, related=${ids(r.result.entries)})`);
    // V4 用量变动挤动核心席位(席位 1):候补核心被别处记一次使用 → 晋升 → 核心集合变 → 重算。
    await save('core-standby', 'old standby core', { type: 'preference', core: true });
    const standbyFile = path.join(projectDir, 'core-standby.md');
    fs.writeFileSync(standbyFile, fs.readFileSync(standbyFile, 'utf8').replace(/^updatedAt: .*$/m, 'updatedAt: 2010-01-01T00:00:00.000Z').replace(/^createdAt: .*$/m, 'createdAt: 2010-01-01T00:00:00.000Z'));
    const seatCfg = { ...config, coreMemoryMaxItemsV1: 1 };
    const seats = await a.resolveCoreMemoryState(cwd, null, seatCfg);
    ok(ids(seats.active) === 'core-rule' && seats.standby.some(entry => entry.id === 'core-standby'), `V4a 夹具:席位 1,core-rule 在席、core-standby 候补(${ids(seats.active)})`);
    r = await race('V4', 'alpha usage', () => a.touchMemoryUsage([seats.standby.find(entry => entry.id === 'core-standby')], cwd, 'relevant'), seatCfg);
    ok(r.result.status.recovered === 'stale' && ids(r.result.coreEntries) === 'core-standby',
      `V4b 编码期间用量变动挤动核心席位:只重算核心就认出,按当前席位交付(core=${ids(r.result.coreEntries)}, recovered=${r.result.status.recovered})`);
    const relation = await a.proposeMemoryRelation({ type: 'supersedes', from: 'alpha-two', to: 'alpha-one', scope: 'project' }, cwd);
    ok(relation.ok, 'V5a 夹具:待确认的取代边');
    r = await race('V5', 'alpha relation', () => a.confirmMemoryRelation(relation.relation.id, cwd));
    ok(r.result.status.recovered === 'stale', `V5b 编码期间确认取代边:库令牌认出,按当前库重算(recovered=${r.result.status.recovered})`);
    const sameSize = JSON.stringify({ ...config, memoryRelevanceMaxV1: 7 });
    ok(sameSize.length === JSON.stringify(config).length, 'V6a 夹具:改写后的配置与原配置同尺寸');
    r = await race('V6', 'alpha config', () => { fs.writeFileSync(configFile, sameSize); });
    ok(r.result.status.recovered === 'stale', `V6b 编码期间同尺寸改写配置文件:配置戳认出并按内容重比(recovered=${r.result.status.recovered})`);
    fs.writeFileSync(configFile, JSON.stringify(config));

    // ── [X] 显式检索 ──
    const reg = { state: 'running', session }; a.activeChildren.set(session.id, reg);
    const ctx = () => ({ session, sessionId: session.id, workingDir: cwd, turnSeq: session.turnSeq, config });
    const list = query => srv.toolCall('workbench_memory_list', { query }, ctx());
    await sleep(20);
    for (let i = 0; i < 160; i++) await save('bulk-' + String(i).padStart(3, '0'), 'bulk record ' + i);
    // 目标是全库最旧的一条(按 createdAt 倒序排在最后一页)。
    const targetFile = path.join(projectDir, 'cert-oldest.md');
    await save('cert-oldest', 'signing gate', { description: '证书签署应先经过人工核准' });
    fs.writeFileSync(targetFile, fs.readFileSync(targetFile, 'utf8').replace(/^createdAt: .*$/m, 'createdAt: 2001-01-01T00:00:00.000Z'));
    await sleep(2700);
    a.clearSemantic();
    // 空闲机器上一次调用就翻完 205 头;负载下 1 s 调用期限可能只够一两页,所以按「几次调用内找到 + 每次至少推进一页」判,
    // 修前是每次最多一页、且回验把期限吃光(同一夹具修前 11 次以上)。
    let found = null, calls = 0, readsPerCall = [], firstExamined = 0;
    while (calls < 4) {
      const before = projectReads; found = await list('credential approval'); calls++; readsPerCall.push(projectReads - before);
      if (calls === 1) firstExamined = found.semantic?.coverage?.examinedHeaders || 0;
      if (!found.ok || found.memories.some(row => row.id === 'cert-oldest') || found.semantic?.coverage?.canContinue !== true) break;
    }
    ok(found.ok && found.memories.some(row => row.id === 'cert-oldest' && row.retrieval?.kind === 'semantic') && found.semantic?.coverage?.complete === true && calls <= 3 && firstExamined >= 64,
      `X1a 最旧的目标在 ${calls} 次显式检索调用内找到(连续翻页;首次调用推进 ${firstExamined} 头;coverage.complete=${found.semantic?.coverage?.complete}, ${found.semantic?.coverage?.examinedHeaders}/${found.semantic?.coverage?.candidateHeaders})`);
    ok(readsPerCall.every(n => n === 1), `X1b 每次调用只全量读一次注册表(实际 ${readsPerCall.join(',')} 次)`);
    const plain = await list('bulk record'), victim = plain.ok && plain.memories.find(row => /^bulk-/.test(row.id));
    ok(!!victim, 'X2a 夹具:找到一条会被返回的条目');
    pinMtime(path.join(projectDir, victim.id + '.md'));
    a.clearSemantic();
    onEncode = () => { ok(rewriteSameSize(path.join(projectDir, victim.id + '.md'), 'name: ' + victim.name, 'name: ' + victim.name.replace('bulk', 'BULK')), 'X2b 夹具:同尺寸改写后 size 与 mtime 都没变'); };
    const raced = await list('bulk record'); const x2Fired = onEncode === null; onEncode = null;
    ok(x2Fired, 'X2c 夹具:变化发生在编码期间');
    ok(!raced.ok, 'X2 编码期间对即将返回的条目做同尺寸、mtime 还原的改写:显式检索照样拒绝(由返回前的逐文件 stat 认出)');
    // X3 被编码但不在返回名单里的条目(第一页的较新条目)在编码期间被进程外改写:编码前后的逐页 stat 认出(独立复核 P1)。
    const returned = new Set(plain.memories.map(row => row.id)), hidden = Array.from({ length: 50 }, (_, i) => 'bulk-' + String(159 - i).padStart(3, '0')).find(id => !returned.has(id));
    ok(!!hidden, 'X3a 夹具:找到一条第一页会被编码、但不在返回名单里的条目');
    const hiddenFile = path.join(projectDir, hidden + '.md'); pinMtime(hiddenFile);
    const hiddenName = 'bulk record ' + Number(hidden.slice(5));
    a.clearSemantic(); let x3Fired = false;
    onEncode = () => { x3Fired = true; ok(rewriteSameSize(hiddenFile, 'name: ' + hiddenName, 'name: ' + hiddenName.replace('bulk', 'BULK')), 'X3b 夹具:同尺寸改写后 size 与 mtime 都没变'); };
    const hiddenRace = await list('bulk record'); onEncode = null;
    ok(x3Fired && !hiddenRace.ok, `X3c 编码中的未返回条目被改写:显式检索拒绝,不拿旧表头继续编码(ok=${hiddenRace.ok})`);
    // X4(复核 F2,keyrevoke2 edit):第一批文档编码时,同页靠后一批要编的条目被进程外原地改写 —— 目录 stat 不变、令牌不变,
    // 由「每批编码前只 stat 这一批的文件」拦住:改写后那条(新旧文本都)不再送去编码,本次检索拒绝。
    await sleep(2700);
    const order = await a.loadMemoryRegistry(cwd), late = order.slice(30, 60).find(entry => /^bulk-/.test(entry.id) && entry.id !== hidden);
    ok(!!late, 'X4a 夹具:找到第一页靠后批次里的一条');
    const lateFile = late.file, lateName = late.name; a.clearSemantic(); let x4At = -1;
    onDocEncode = () => { x4At = encodeLog.length; fs.writeFileSync(lateFile, fs.readFileSync(lateFile, 'utf8').replace('name: ' + lateName, 'name: ' + lateName.replace('bulk', 'BULK'))); };
    const lateRace = await list('bulk record'); onDocEncode = null;
    const after = x4At < 0 ? [] : encodeLog.slice(x4At).filter(row => row.role === 'document').flatMap(row => row.texts);
    const leaked = after.filter(text => text.includes(late.id));
    ok(x4At >= 0 && !lateRace.ok && leaked.length === 0, `X4b 改写之后被改的那条不再进编码器、检索拒绝(改写后又编码 ${after.length} 段,其中该条 ${leaked.length} 段;ok=${lateRace.ok})`);
    // [E] 加密时披露前确认钥匙没换:钥匙在编码期间失效 → work_data 错误照常上抛(不降级、不交旧结果)。
    fs.writeFileSync(configFile, JSON.stringify({ ...config, workDataEncryptionV1: true }));
    const keyFail = () => { throw Object.assign(Error('work_data_key.absent'), { code: 'work_data_key.absent' }); };
    let authorityValue = 'synthetic-authority-a'; const realAuthority = a.setAuthority(async () => { if (authorityValue === null) keyFail(); return authorityValue; });
    try {
      const docsAfter = at => encodeLog.slice(at).filter(row => row.role === 'document').reduce((n, row) => n + row.texts.length, 0);
      let fired = false, at = -1; onEncode = () => { fired = true; at = encodeLog.length; authorityValue = null; };
      let code = ''; try { await preflight('alpha key'); } catch (error) { code = error.code; } onEncode = null;
      ok(fired && code === 'work_data_key.absent' && docsAfter(at) === 0, `E1 预检:编码期间钥匙失效 → 下一次回验就以 work_data 错误上抛,之后 0 段文档进编码器(${code || '未抛'}, 之后编码 ${docsAfter(at)} 段)`);
      authorityValue = 'synthetic-authority-a'; a.clearSemantic(); fired = false; code = '';
      onEncode = () => { fired = true; at = encodeLog.length; authorityValue = null; };
      try { const out = await list('credential approval'); code = out.ok ? 'ok' : 'refused'; } catch (error) { code = error.code; } onEncode = null;
      ok(fired && code === 'work_data_key.absent' && docsAfter(at) === 0, `E2 显式检索:编码期间钥匙失效 → work_data 错误上抛,之后 0 段文档进编码器(${code}, 之后编码 ${docsAfter(at)} 段)`);
    } finally { a.setAuthority(realAuthority); onEncode = null; fs.writeFileSync(configFile, JSON.stringify(config)); }
    // [L1] Exercise the automatic Gemma selection path with a cold document cache.
    // The synthetic codec handles queries. Any foreground document call records the regression.
    const baseline = await preflight('bulk record', { ...config, semanticRetrievalV1: false });
    let foregroundDocuments = 0, foregroundQueries = 0;
    a.setRuntime({ encode: async (texts, options) => {
      if (options.role === 'document' && options.priority !== 'background') foregroundDocuments += texts.length;
      if (options.role === 'query') foregroundQueries++;
      return encode(texts, options);
    } });
    delete process.env.RUYI_DISABLE_SEMANTIC;
    try {
      const began = Date.now();
      const cold = await preflight('bulk record');
      const elapsed = Date.now() - began;
      const receipt = cold.result.status.semantic;
      ok(foregroundQueries === 1 && foregroundDocuments === 0 && elapsed <= 500,
        `L1a cold send costs ${elapsed} ms, queries ${foregroundQueries}, foreground documents ${foregroundDocuments}`);
      ok(receipt?.fallback?.method === 'existing-recall' && receipt.fallback.reason === receipt.status
        && JSON.stringify(cold.result.entries.map(e => e.id)) === JSON.stringify(baseline.result.entries.map(e => e.id)),
        `L1b cold send returns the keyword baseline and its fallback receipt (${receipt?.status})`);
    } finally { process.env.RUYI_DISABLE_SEMANTIC = '1'; }
    a.activeChildren.delete(session.id);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    fsp.readdir = realReaddir;
    a.clearSemantic();
    if (path.dirname(home) !== path.resolve(os.tmpdir()) || !path.basename(home).startsWith('ruyi-memory-snapshot-')) throw Error('fixture cleanup outside owned temp');
    fs.rmSync(home, { recursive: true, force: true });
  }
  t.done();
})().catch(error => { t.fail(error.stack || error.message); t.done(); });
