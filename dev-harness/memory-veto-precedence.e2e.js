require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(第 128 波 128h · 41 号文 J12／J13;47 号文 §4.2 A 表第 2/3 行与 B 表第 1/3 条):
// 「被否决的旧偏好不换说法复活」与「本次显式要求优先于存下来的偏好」。
//
// 修前这两条各缺一半(46 号文 D2 取证):
//   · J12:服务端有一道【词面】闸(Jaccard ≥0.8)挡同义写回,但**换个说法就能写回来**;而且被否决的条目
//     对模型**完全不可见**(记忆块 filter 掉 vetoed、memorySearch 默认 includeVetoed:false)——
//     于是「别再写回去」这条纪律没有任何人在执行,连知道都不知道。
//   · J13:「本次显式要求优先」在提示词里**一个字都没有**。三处记忆抬头的口径只有「不得覆盖以上守则」,
//     那说的是「记忆不能盖过系统守则」,**不是**「用户这次的话能盖过记忆」——两件事。
//
// 本刀的判断依据是一次实测(见 (E) 段,常驻在本件里):词面重合度在「换说法」这个距离上根本分不开 ——
//   换说法(同一条偏好)  中位 0.176
//   无关(不同的事)      中位 0.059
//   相反(该写进去的新偏好)中位 0.556  ← 最高
// 序是**反的**:任何中间阈值都会把「用户改主意后的新偏好」拦得最狠,而把真正的换说法放过去。
// ⇒ 结论:语义只有模型有。修法不是调阈值,是**把否决清单送到模型面前**,再给一条「用户真改主意了」的
// 显式通道(supersedesVetoed 指名 id),而不是靠换说法偷渡。
//
// 覆盖:
//  (A) J12 提示词:否决清单真的进了管家回合的易变层,排在生效清单之后,自带预算与折叠。
//  (B) J13 提示词:「本次显式要求优先」这一句在管家侧与工作台侧都送到了模型面前,且四个入口
//      **共用一个常量**(手攒的名单要配机械锁:将来加第五个入口,锁会红)。
//  (C) J12 写回闸:换说法今天照样写得进(如实钉住「服务端没有语义」)、近乎同一句仍硬拒、
//      指名道姓才复活、复活是原地复活(不新增条目)、复活之后否决清单里不再有它。
//  (D) J12 压缩:摘要提示词要求「被推翻的偏好不进【已确认的决定】」(中英两份)。
//      **真请求体上的连线**由 provider-compact.e2e.js 钉(那件本来就做一次真压缩)。
//  (E) 上面那次实测:三类样本的中位数序,常驻成判据 —— 谁要再来加「中间相似度带」,先看这一段。
//
// 全程进程内直调(与 steward-memory.e2e.js 同一个模具:合成管家 ctx + 真实存储),零模型请求。
// 判定行:`MEMORY VETO PRECEDENCE E2E: ALL PASS`。
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const SRC = path.join(WB, 'app', 'src');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-veto-precedence-'));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [], subagentMaxPerTurn: 0,
  stewardEnabledV1: true, stewardPollMs: 120000,
}, null, 2), 'utf8');
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

const stewardDir = path.join(HOME, 'steward');
const memoryFile = path.join(stewardDir, 'memory-v1.json');
const stewardCtx = { session: { id: 'steward', kind: 'steward', providerHistory: [] } };
const call = (name, args) => srv.toolCall(name, args, stewardCtx);
const readStore = () => { try { return JSON.parse(fs.readFileSync(memoryFile, 'utf8')); } catch { return null; } };
const readDecisions = () => {
  try {
    return fs.readFileSync(path.join(stewardDir, 'decisions-v1.ndjson'), 'utf8')
      .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

// 记忆写入的来源必须指向一条【用户自己的】消息(source_not_user 那道闸)。造真会话满足它。
async function makeUserTurn(text) {
  const session = await srv.createSession({ title: '来源会话', cwd: HOME });
  session.messages = [{ role: 'user', content: text, turnSeq: 1, createdAt: new Date().toISOString() }];
  session.turnSeq = 1;
  await srv.saveSession(session);
  return { sessionId: session.id, turnSeq: 1 };
}

// 直接落一份库(比逐条调工具快,且能精确摆出「已过期」「八条以上」这类形状)。
function seedStore(entries) {
  fs.mkdirSync(stewardDir, { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(memoryFile, JSON.stringify({
    schema: 1,
    updatedAt: at,
    entries: entries.map((e, i) => ({
      id: e.id || `smem_seed${i}`,
      kind: e.kind || 'preference',
      text: e.text,
      confidence: 0.6,
      sourceSessionId: e.sourceSessionId || '',
      sourceSeq: 0,
      createdAt: at,
      updatedAt: e.updatedAt || at,
      lastUsedAt: '',
      useCount: 0,
      state: e.state || 'active',
      mergedFrom: [],
      expiresAt: e.expiresAt || '',
      scope: '',
    })),
  }, null, 2), 'utf8');
}

// 管家回合的提示词(stable 进 system、volatile 拼在第一条 user 消息前缀)。走真装配器。
const stewardPrompt = async (config) => srv.buildStewardSystemPrompt(
  { id: 'steward', kind: 'steward', providerHistory: [] },
  { stewardEnabledV1: true, defaultWorkspace: HOME, ...(config || {}) },
  {});

/* ═════════ (A) J12 提示词:否决清单进得去 ═════════ */
console.log('── (A) J12 否决清单进提示词 ──');
{
  seedStore([
    { id: 'smem_live1', kind: 'preference', text: '用户偏好报告用中文书写', state: 'active' },
    { id: 'smem_veto1', kind: 'preference', text: '用户喜欢深色主题', state: 'vetoed' },
  ]);
  const { volatile } = await stewardPrompt();
  ok(/我记得的关于用户的事/.test(volatile) && volatile.includes('用户偏好报告用中文书写'),
    'A1 生效清单照旧(抬头 + 那条 active 的正文)');
  ok(/用户【否决过】的记忆/.test(volatile), 'A2 否决清单的抬头在提示词里');
  ok(volatile.includes('用户喜欢深色主题') && volatile.includes('smem_veto1'),
    'A3 被否决那条的【正文与 id】都在(id 是复活通道要用的钥匙,只在这里出现)');
  const liveAt = volatile.indexOf('用户偏好报告用中文书写');
  const vetoHeadAt = volatile.indexOf('用户【否决过】的记忆');
  ok(liveAt >= 0 && vetoHeadAt > liveAt, 'A4 否决清单排在生效清单【之后】(它是「别做什么」,不该抢在前面)');
  const liveSection = volatile.slice(0, vetoHeadAt);
  ok(!liveSection.includes('用户喜欢深色主题'), 'A5 被否决的条目【不】混进生效清单');
}
{
  // 过期口径:生效侧滤过期(126-M02 原口径),否决侧【不滤】—— 与 13l 那道写回闸一致
  // (它拦 vetoed 时也不看 expiresAt)。两处不一致就会出现「闸拦得住、提示词里却没有它」。
  const past = new Date(Date.now() - 86400000).toISOString();
  seedStore([
    { id: 'smem_live2', kind: 'focus', text: '用户这两周在赶甲项目', state: 'active', expiresAt: past },
    { id: 'smem_veto2', kind: 'focus', text: '用户这两周在赶乙项目', state: 'vetoed', expiresAt: past },
    { id: 'smem_live3', kind: 'preference', text: '用户偏好报告用中文书写', state: 'active' },
  ]);
  const { volatile } = await stewardPrompt();
  ok(!volatile.includes('用户这两周在赶甲项目'), 'A6 已过期的生效条目不进生效清单(126-M02 口径不变)');
  ok(volatile.includes('用户这两周在赶乙项目'), 'A7 已过期的【被否决】条目仍进否决清单(与写回闸同口径)');
}
{
  // 折叠:否决清单最多 8 条,超出给一句「另有 N 条」。updatedAt 新的在前。
  const entries = [{ id: 'smem_live4', text: '用户偏好报告用中文书写', state: 'active' }];
  for (let i = 0; i < 11; i++) {
    entries.push({
      id: `smem_v${i}`, state: 'vetoed', text: `用户否决过的第${i}条偏好`,
      updatedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    });
  }
  seedStore(entries);
  const { volatile } = await stewardPrompt();
  const listed = [...Array(11).keys()].filter(i => volatile.includes(`用户否决过的第${i}条偏好`));
  ok(listed.length === 8, `A8 否决清单封顶 8 条(实得 ${listed.length})`);
  ok(listed.every(i => i >= 3), `A9 留下的是 updatedAt 最近的 8 条(实得 ${JSON.stringify(listed)})`);
  ok(/另有 3 条被否决的条目未列出/.test(volatile), 'A10 超出部分给一句折叠说明(不是静默吞掉)');
}
{
  seedStore([]);
  const { volatile } = await stewardPrompt();
  ok(/还没有记下关于用户的任何事/.test(volatile), 'A11 空库照旧走 memoryEmpty');
  ok(!/用户【否决过】的记忆/.test(volatile), 'A12 一条否决都没有时不出这个抬头(不给模型看空清单)');
}

/* ═════════ (B) J13 本次显式要求优先 ═════════ */
console.log('── (B) J13 本次显式要求优先 ──');
const PRECEDENCE_MARK = '用户在本次对话里明确提出的要求，优先于以上记下的任何偏好';
{
  seedStore([{ id: 'smem_live5', kind: 'preference', text: '用户偏好报告用中文书写', state: 'active' }]);
  const { volatile } = await stewardPrompt();
  ok(volatile.includes(PRECEDENCE_MARK), 'B1 管家侧:「本次显式要求优先」这一句在易变层里');
  const markAt = volatile.indexOf(PRECEDENCE_MARK);
  ok(markAt > volatile.indexOf('用户偏好报告用中文书写'),
    'B2 它排在条目【之后】(读完偏好紧接着就看到「这次说的更大」)');
  ok(/steward_memory_veto/.test(volatile.slice(markAt, markAt + 400)) && /steward_memory_write/.test(volatile.slice(markAt, markAt + 400)),
    'B3 管家侧多一句「怎么落」:先否掉旧的再记新的(否则模型会照新的做、旧条目却留着)');
}
{
  seedStore([]);
  const { volatile } = await stewardPrompt();
  ok(!volatile.includes(PRECEDENCE_MARK), 'B4 一条生效偏好都没有时不出这句(没有偏好可被盖过)');
}
{
  // 工作台侧:同一句要出现在记忆索引抬头里(两个引擎共用 06d 的 buildMemoryPromptSection)。
  const entries = [{ id: 'mem1', name: '示例记忆', description: '一条偏好', file: path.join(HOME, 'm1.md') }];
  const full = srv.buildProviderSystemPrompt(
    { id: 'fake', label: 'Fake', model: 'fake-model' }, 'fake-model', HOME,
    [{ function: { name: 'file_read', description: 'read', parameters: { type: 'object', properties: {} } } }],
    { network: { online: true }, desktopMcp: { present: false, toolCount: 0 }, binaries: {}, provider: {} },
    { enableToolRequiresProbe: false }, '', false, [], entries, null);
  ok(full.includes(PRECEDENCE_MARK), 'B5 工作台侧:记忆索引抬头带同一句(两引擎共用这一处装配)');
}
{
  const en = srv.buildProviderSystemPrompt(
    { id: 'fake', label: 'Fake', model: 'fake-model' }, 'fake-model', HOME,
    [{ function: { name: 'file_read', description: 'read', parameters: { type: 'object', properties: {} } } }],
    { network: { online: true }, desktopMcp: { present: false, toolCount: 0 }, binaries: {}, provider: {} },
    { enableToolRequiresProbe: false, locale: 'en-US' }, '', false, [],
    [{ id: 'mem1', name: 'sample', description: 'a preference', file: path.join(HOME, 'm1.md') }], null);
  ok(/outranks every preference recorded above/.test(en), 'B6 英文包也接了同一句(不是只改了中文那一份)');
}
{
  // 机械锁:四个入口【共用一个常量】。加第五个入口而忘了接这一句 -> 这里数不上,红。
  // 判据钉「引用次数」而不是「字出现过」:把常量改成各写一遍,数也会变。
  const pack = fs.readFileSync(path.join(SRC, '06b-prompt-registry.js'), 'utf8');
  const defsZh = (pack.match(/^const MEMORY_PRECEDENCE_ZH = /gm) || []).length;
  const defsEn = (pack.match(/^const MEMORY_PRECEDENCE_EN = /gm) || []).length;
  ok(defsZh === 1 && defsEn === 1, `B7 中英各恰好【一处】定义(实得 ${defsZh}/${defsEn};两处定义 = 又开始各写各的)`);
  const usesZh = (pack.match(/MEMORY_PRECEDENCE_ZH/g) || []).length - defsZh;
  const usesEn = (pack.match(/MEMORY_PRECEDENCE_EN/g) || []).length - defsEn;
  // 四个入口 = 项目记忆文件 / 工作台记忆索引 / 核心记忆摘要 / 管家记忆块。
  ok(usesZh === 4 && usesEn === 4, `B8 恰好四个入口引用它(实得 中文 ${usesZh} / 英文 ${usesEn});加了新的偏好入口就要回来登记`);
  // 逐个入口再钉一遍,**中英两个包分开扫**。第一版写成了「全文里 <key>: 后面 1200 字内有这个常量」——
  // 反向验证当场证明它不成立:把中文 memoryHeader 那一处摘掉,正则跑去命中了英文包的同名键,这一条照绿
  // (只有 B8 的计数红了)。这就是「对照组不在屏上」那种错法,判据必须锁死在它该看的那半边。
  const zhAt = pack.indexOf('const PROMPT_ZH = {');
  const enAt = pack.indexOf('const PROMPT_EN = {');
  ok(zhAt >= 0 && enAt > zhAt, 'B8-尺子 两个包的边界都找得到(找不到 = 下面几条在比空气)');
  const REGIONS = [['中文', pack.slice(zhAt, enAt), 'MEMORY_PRECEDENCE_ZH'], ['英文', pack.slice(enAt), 'MEMORY_PRECEDENCE_EN']];
  // 自带尺子:把【那个键自己的值】整段切出来,而不是「往后数 N 个字符」。
  // 第二版用的是窗口,反向验证又把它证伪了一次:`memoryHeader` 在同一个包里出现两次(顶层一处、
  // 管家块里一处),顶层那处的引用摘掉之后,窗口跑去命中了管家块里 memoryPrecedence 的那一处。
  // 于是判据改成:按缩进定位到这一个键,切到【同缩进的下一个键】为止,在这一段里找常量。
  const valueOf = (region, key, indent) => {
    const head = new RegExp(`^ {${indent}}${key}:`, 'm');
    const at = region.search(head);
    if (at < 0) return '';
    const rest = region.slice(at);
    const next = rest.slice(1).search(new RegExp(`^ {${indent}}[A-Za-z_]\\w*:`, 'm'));
    return next < 0 ? rest : rest.slice(0, next + 1);
  };
  // 键 -> 它所在的层级缩进(顶层 2 格;管家块里的 4 格)。
  const ENTRIES = [['projectMemory', 2], ['memoryHeader', 2], ['memoryCoreHeader', 2], ['memoryPrecedence', 4]];
  for (const [label, region, constName] of REGIONS) {
    for (const [key, indent] of ENTRIES) {
      const value = valueOf(region, key, indent);
      ok(value.startsWith(' '.repeat(indent) + key + ':'), `B8-${label}-${key}-尺子 切得出这个键自己的那一段(切不出 = 下面那条在比空气)`);
      ok(value.includes(constName), `B8-${label}-${key} 这个入口真的接了本包的那个常量`);
    }
  }
}

/* ═════════ (C) J12 写回闸:换说法、硬拒、指名复活 ═════════ */
console.log('── (C) J12 写回闸与复活通道 ──');
seedStore([]);
let vetoedId = '';
{
  const src = await makeUserTurn('报告都给我写成中文');
  const w = await call('steward_memory_write', { kind: 'preference', text: '用户偏好报告用中文书写', sourceRef: src });
  ok(w && w.ok === true, 'C0 先写一条再否决它(布景)');
  vetoedId = w.id;
  const v = await call('steward_memory_veto', { id: vetoedId });
  ok(v && v.ok === true && v.state === 'vetoed', 'C0b 否决成功');
}
{
  // 如实钉住今天的能力边界:换个说法(实测重合度 0.176)服务端【拦不住】—— 这不是本刀的缺口,
  // 是「语义不在服务端」这件事本身。挡它的是 (A) 段那份送到模型面前的否决清单。
  // 这一条哪天变绿(= 有人真上了语义判据),回来把 (E) 段一起重议。
  const src = await makeUserTurn('文档也用中文吧');
  const w = await call('steward_memory_write', { kind: 'preference', text: '用户希望报告以中文呈现', sourceRef: src });
  ok(w && w.ok === true, 'C1 换说法今天照样写得进去(服务端只有词面闸,没有语义)');
  if (w && w.ok) await call('steward_memory_veto', { id: w.id }); // 清场,免得影响后面的近似判定
}
{
  const before = JSON.stringify(readStore());
  const src = await makeUserTurn('报告要中文的');
  const w = await call('steward_memory_write', { kind: 'preference', text: '用户偏好报告用中文书写', sourceRef: src });
  ok(w && w.ok === false && w.error === 'vetoed_duplicate', `C2 近乎同一句仍然硬拒(稳定信封 ${w && w.error})`);
  ok(w && String(w.message || '').includes(vetoedId) && /supersedesVetoed/.test(String(w.message || '')),
    'C2b 拒绝时把【那条的 id】与【怎么办】一起告诉模型(否则它只会换说法再试一遍)');
  ok(JSON.stringify(readStore()) === before, 'C2c 拒写是零写入(库逐字节不变)');
}
{
  const src = await makeUserTurn('报告要中文的');
  const w = await call('steward_memory_write', {
    kind: 'preference', text: '用户偏好报告用中文书写', sourceRef: src, supersedesVetoed: 'smem_not_a_real_id',
  });
  ok(w && w.ok === false && w.error === 'not_found', `C3 supersedesVetoed 指错 id 当场拒(不是「带了这个参数就放行」,也不是静默当普通写入;got ${w && w.error})`);
}
{
  // 复活【按 id 认,不按相似度认】—— 用户改主意时说的那句话通常与当初否决的那条不一样。
  // 这一条是写件时测出来的真缺口:只在词面闸命中时才认这个参数的话,旧条目会一直留在否决清单里,
  // 同时又多出一条生效的新条目,提示词自相矛盾。
  const far = srv.stewardTermJaccard('用户偏好报告用中文书写', '用户偏好报告一律用中文书写');
  ok(far < 0.8, `C3b(前提)这次的说法与被否决那条的词面重合度只有 ${far.toFixed(3)},词面闸根本不会命中`);
}
{
  const countBefore = readStore().entries.length;
  const src = await makeUserTurn('算了,还是记着吧:报告都写中文');
  const w = await call('steward_memory_write', {
    kind: 'preference', text: '用户偏好报告一律用中文书写', sourceRef: src, supersedesVetoed: vetoedId,
  });
  ok(w && w.ok === true && w.revived === true && w.id === vetoedId, `C4 指名道姓才复活,且复活的是【同一条】(id ${w && w.id})`);
  ok(readStore().entries.length === countBefore, 'C4b 复活【不新增条目】(与合并同一条纪律:旧 id 上的引用不失效)');
  const entry = readStore().entries.find(e => e.id === vetoedId);
  ok(entry && entry.state === 'active' && entry.text === '用户偏好报告一律用中文书写',
    'C4c 状态回 active、正文取这一次的说法');
  ok(entry && entry.revivedFrom === 'vetoed', 'C4d 条目上留下「它曾被否决过」的痕迹(面板与导出都看得见)');
  // 再从【读库那一口】过一遍:落盘的对象自带这个字段,真正决定它活不活得过一次重启的是归一化白名单。
  // 只看盘上那份的话,把归一化里那一行删掉也照样绿(这一条是反向验证当场证伪出来的)。
  const readBack = await call('steward_memory_search', { q: '中文', includeVetoed: true });
  const seen = readBack && Array.isArray(readBack.entries) ? readBack.entries.find(e => e.id === vetoedId) : null;
  ok(seen && seen.revivedFrom === 'vetoed', 'C4d2 这个痕迹过得了归一化(重启之后还在,不是只活在这一次的内存对象上)');
  ok(w && w.undoRef && w.undoRef.prev === 'vetoed', 'C4e undo 的落点是「放回 vetoed」(与面板恢复同源)');
  // 决策日志是即发即忘的(stewardAppendDecision 走自己的链,与 usage ledger 同款纪律),
  // 工具返回时那一行还没落盘 —— 等它,别改成「读不到就算了」。
  let decision = null;
  for (let i = 0; i < 40 && !(decision && decision.args && decision.args.supersedesVetoed); i++) {
    await new Promise(r => setTimeout(r, 25));
    decision = readDecisions().filter(d => d && d.tool === 'steward_memory_write').pop();
  }
  ok(decision && decision.args && decision.args.supersedesVetoed === vetoedId,
    'C4f 决策日志记下了这是一次复活(用户回看时不是一次静默的翻盘)');
}
{
  const { volatile } = await stewardPrompt();
  ok(volatile.includes('用户偏好报告一律用中文书写'), 'C5 复活之后它回到生效清单');
  const vetoHeadAt = volatile.indexOf('用户【否决过】的记忆');
  ok(vetoHeadAt < 0 || !volatile.slice(vetoHeadAt).includes(vetoedId),
    'C5b 否决清单里不再有它(提示词不会一边说「否决过」一边又把它当生效偏好)');
}
{
  // 复活不放松来源闸:助手消息当来源仍然拒。
  const session = await srv.createSession({ title: '助手来源', cwd: HOME });
  session.messages = [{ role: 'assistant', content: '用户偏好报告用中文书写', turnSeq: 1, createdAt: new Date().toISOString() }];
  session.turnSeq = 1;
  await srv.saveSession(session);
  const w = await call('steward_memory_write', {
    kind: 'preference', text: '用户偏好报告用中文书写', sourceRef: { sessionId: session.id, turnSeq: 1 }, supersedesVetoed: vetoedId,
  });
  ok(w && w.ok === false && w.error === 'source_not_user',
    'C6 复活通道【不】放松来源闸:必须是用户本人这一回合说的话');
}

/* ═════════ (D) J12 压缩:被推翻的偏好不进【已确认的决定】 ═════════ */
console.log('── (D) J12 压缩回注 ──');
{
  const zh = srv.summaryPromptWithGuidance({});
  ok(/偏好与决定只保留【最后一次】那个版本/.test(zh) && /不得写进【已确认的决定】/.test(zh),
    'D1 中文摘要提示词要求「被推翻的旧偏好不进【已确认的决定】」');
  ok(/不许与现行偏好并列/.test(zh), 'D1b 也不许把新旧两条并列成都有效(这正是回注会带旧偏好的那条路)');
  const en = srv.summaryPromptWithGuidance({ runtimeSummaryPromptI18nV1: true, locale: 'en-US' });
  ok(/Preferences and decisions: keep only the LAST version/.test(en) && /must not appear under Decisions/.test(en),
    'D2 英文那份有对应的一句(111d 翻默认开之后英文界面走的是它)');
  // 内置 fallback 与 JSON 的逐项相同由 unit/context-governance-fallback.test.js 钉,这里不重复。
}

/* ═════════ (E) 为什么没有「中间相似度带」:三类样本的实测 ═════════ */
console.log('── (E) 词面重合度分不开「换说法」 ──');
{
  const J = (a, b) => srv.stewardTermJaccard(a, b);
  const median = xs => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const REPHRASE = [
    ['用户偏好报告用中文书写', '用户希望报告以中文呈现'],
    ['用户偏好报告用中文书写', '交付的文档请使用中文'],
    ['用户不想被主动提醒', '用户不喜欢收到主动的提醒推送'],
    ['用户习惯周一整理上周任务', '用户每个星期一会梳理上一周的活'],
    ['用户偏好深色主题', '用户喜欢暗色界面'],
    ['用户不想被主动提醒', '别给用户发主动提醒'],
    ['用户要求先给结论再给过程', '用户希望结论放在最前面'],
    ['user prefers reports in Chinese', 'user likes the report written in Chinese'],
  ].map(([a, b]) => J(a, b));
  const UNRELATED = [
    ['用户偏好报告用中文书写', '用户在用 Windows 11'],
    ['用户偏好报告用中文书写', '用户每周一整理上周任务'],
    ['用户不想被主动提醒', '用户偏好深色主题'],
    ['用户习惯周一整理上周任务', '用户的主力编辑器是 VS Code'],
    ['用户要求先给结论再给过程', '用户家里有两只猫'],
    ['用户偏好深色主题', '用户在赶一个叫如意的项目'],
    ['用户偏好报告用中文书写', '用户周末不看工作消息'],
    ['user prefers reports in Chinese', 'user runs Windows 11'],
  ].map(([a, b]) => J(a, b));
  const OPPOSITE = [
    ['用户偏好深色主题', '用户偏好浅色主题'],
    ['用户偏好报告用中文书写', '用户偏好报告用英文书写'],
    ['用户不想被主动提醒', '用户想要主动提醒'],
    ['用户习惯周一整理上周任务', '用户习惯周五整理本周任务'],
    ['user prefers reports in Chinese', 'user prefers reports in English'],
  ].map(([a, b]) => J(a, b));
  const mRe = median(REPHRASE), mUn = median(UNRELATED), mOp = median(OPPOSITE);
  console.log(`   中位数:换说法 ${mRe.toFixed(3)} / 无关 ${mUn.toFixed(3)} / 相反 ${mOp.toFixed(3)}`);
  ok(mOp > mRe, `E1 「相反的偏好」重合度【高于】「换说法」——序是反的(相反 ${mOp.toFixed(3)} > 换说法 ${mRe.toFixed(3)})`);
  ok(Math.min(...REPHRASE) < Math.max(...UNRELATED),
    `E2 换说法的下界【低于】无关内容的上界,两类重叠(${Math.min(...REPHRASE).toFixed(3)} < ${Math.max(...UNRELATED).toFixed(3)})`);
  ok(Math.max(...REPHRASE) < Math.min(...OPPOSITE),
    `E3 任何能罩住换说法的阈值都会把「相反的新偏好」全挡掉(换说法上界 ${Math.max(...REPHRASE).toFixed(3)} < 相反下界 ${Math.min(...OPPOSITE).toFixed(3)})`);
  // E1–E3 合起来就是「不许加中间相似度带」的判据:拦得住换说法的阈值,一定先把用户改主意后的
  // 新偏好拦死,还会顺手误伤无关内容。哪天有人上了语义判据,这三条会红,那时候正该回来重议。
  ok(srv.stewardTermJaccard('用户偏好报告用中文书写', '用户偏好报告用中文书写') === 1,
    'E4 尺子自检:同一句话重合度为 1(判据本身没坏)');
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* Windows 句柄未放开时留给系统清 */ }
console.log(fail === 0 ? 'MEMORY VETO PRECEDENCE E2E: ALL PASS' : `MEMORY VETO PRECEDENCE E2E: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
})();
