#!/usr/bin/env node
'use strict';
// 静态锁:第 116 波 116f(27 号文 §11.2 分层布局 / §11.3 模块落点纪律)—— 管家回合运行器的
// 「零入边、分层预算、开关关零变化」三条机械判据。判定行:`STEWARD RUNNER STATIC E2E: ALL PASS`。
//
// 断言五个方向:
//   ① 模块落点:13h-steward-runner.js 在 manifest 中位于 13g 之后、14 之前(transport 层内部顺序);
//   ② 零前向边的机器判据:06/09/10/13g 四个消费者的源码里【不含】13h 的任何函数名 —— 它们只写
//      StewardHooks.<键>;反过来 13h 填充的键必须真的被这些文件消费(挂了没人用 = 死代码);
//   ③ 06b 的 steward 段中英双包齐全,稳定层 ≤2500 字符(§11.2 稳定层预算),记忆块与总览的上限
//      引用的是 06i 的同一份常量(不另立第二套数字);
//   ④ 普通会话的提示词包文本未变(PROMPT_PACK_VERSION 不动 + 普通包关键标记仍在),新增 steward 段
//      不影响任何普通会话;
//   ⑤ 三条新路由在 01b ROUTE_AUTH 里是 token 级,且 durable-state-inventory 登记了 visits 面。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'ruyi-workbench', 'app');
const SRC = path.join(APP, 'src');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const src06 = read('06-provider-engine.js');
const src06b = read('06b-prompt-registry.js');
const src06i = read('06i-steward-core.js');
const src09 = read('09-workflow.js');
const src10 = read('10-context-governance.js');
const src12 = read('12-tool-dispatch.js');
const src13 = read('13-http-router.js');
const src13d = read('13d-core-domain-routes.js');
const src13g = read('13g-steward.js');
// 116-2e:收件箱轮询与游标前移到 13i-steward-inbox.js(零行为搬家),⑤ 的收件箱断言随之改读 13i。
const src13i = read('13i-steward-inbox.js');
const src13h = read('13h-steward-runner.js');
const src01b = read('01b-route-auth.js');

/* ═════════════ ① 模块落点 ═════════════ */
{
  const files = manifest.modules.map(m => m.file);
  const iRunner = files.indexOf('13h-steward-runner.js');
  ok(iRunner > 0, '① manifest 收录 13h-steward-runner.js');
  ok(iRunner === files.indexOf('13g-steward.js') + 1, '① 13h 紧跟 13g 之后(同为 transport 层)');
  ok(iRunner === files.indexOf('14-main.js') - 1, '① 13h 在 14-main.js 之前(组合根仍是最后一个)');
  // 13g 不得继续膨胀(SPEC §2 目标 2000 行;116c 交付记录已把 116f 另起 13h 的理由写在案)。
  const lines13g = src13g.split('\n').length;
  ok(lines13g < 2000, `① 13g 不超过 SPEC 目标 2000 行(got ${lines13g};116f 另起 13h 就是为了这条)`);
  // 117l companion:这条预算不是靠少写注释守住的,而是靠「新判定不往 13g 堆」。本波三个新判据
  // 一个都不在 13g 里 —— 递话通道的判定与执行在 13h,id 人话化 / 模型分档 / 「它在问你」在 06i。
  for (const symbol of ['stewardRelayChannelFor', 'stewardHumanizeIds', 'stewardThreadEngineRoute', 'stewardAsksYou']) {
    ok(!new RegExp('function ' + symbol + '\\s*\\(').test(src13g), `① 117l companion: ${symbol} 的实现不在 13g(新判定往 13h/06i 放)`);
  }
}

/* ═════════════ ② 零前向边:消费者只认 StewardHooks ═════════════ */
{
  // 13h 里所有顶层 function 名(它们是「13h 的符号」)。任何消费者源码里出现其中之一 = 前向边。
  const runnerSymbols = [...new Set((src13h.match(/^(?:async )?function ([A-Za-z0-9_]+)/gm) || [])
    .map(m => m.replace(/^(?:async )?function /, '')))];
  ok(runnerSymbols.length >= 15, `② 13h 顶层函数抽取到 ${runnerSymbols.length} 个(锁的样本足够大)`);
  // 116h 重钉:消费者面从 06/09/10/13g 扩到 06/09/10/12/13/13d/13g —— 仲裁的钩子多了三个新消费者
  // (12 的工具 handler、13 的 /api/stop、13d 的事项聚合行)。加入样本让「零前向边」的判据【更严】
  // (这三个文件同样不许出现 13h 的符号),同时让下面反向的 unused 判据仍然覆盖全部消费者。
  const consumers = [['06-provider-engine.js', src06], ['09-workflow.js', src09], ['10-context-governance.js', src10],
    ['12-tool-dispatch.js', src12], ['13-http-router.js', src13], ['13d-core-domain-routes.js', src13d], ['13g-steward.js', src13g],
    ['13i-steward-inbox.js', src13i]];
  const leaks = [];
  for (const [name, text] of consumers) {
    for (const symbol of runnerSymbols) {
      if (new RegExp('(^|[^A-Za-z0-9_.])' + symbol + '\\s*\\(').test(text)) leaks.push(`${name}:${symbol}`);
    }
  }
  ok(leaks.length === 0, '② 06/09/10/13g 源码里零 13h 符号(前向边的机器判据)' + (leaks.length ? ' → ' + leaks.join(',') : ''));
  // 文件名可以出现在【注释】里(13g 的转交处就要写清楚去了哪儿),但不得出现在任何一行代码里。
  const nameInCode = [];
  for (const [name, text] of consumers) {
    for (const line of text.split('\n')) {
      if (!line.includes('13h-steward-runner')) continue;
      if (!/^\s*(\/\/|\*|\/\*)/.test(line)) nameInCode.push(name + ': ' + line.trim().slice(0, 60));
    }
  }
  ok(nameInCode.length === 0, '② 13h 的文件名只出现在注释里,不出现在任何代码行' + (nameInCode.length ? ' → ' + nameInCode.join(' | ') : ''));

  // 反向:13h 填充的每个键都必须真的有人消费(挂了没人用 = 死代码)。
  const filled = [...new Set((src13h.match(/^\s{2}([a-zA-Z]+): /gm) || []).map(m => m.trim().replace(':', '')))];
  const assignBlock = src13h.slice(src13h.indexOf('Object.assign(StewardHooks, {'));
  const hookKeys = [...new Set((assignBlock.match(/^\s{2}([a-zA-Z]+): /gm) || []).map(m => m.trim().replace(':', '')))];
  // 14 = 116f 的 8 个 + 116-pre 的 preroute + 116h 的 4 个仲裁键(acquireTurnSlot / arbiterWait /
  // cancelQueuedTurn / arbiterRefresh)+ 116h 的第 21 个工具键 threadPrioritize(它的实现要直接调 13h 的
  // 仲裁器原语,故与其余 20 个工具不同、由 13h 填充)。插队原语与仲裁器快照【不】上命名空间——它们的
  // 消费者全在 13h 内部,挂上去会被下面的 unused 判据判成死代码。重钉来源:27 号文 §3.1 116h 行。
  //
  // 【117l 重钉 14 -> 16】旧断言钉的是 116h 那一刻的键集大小 —— 那是一个「当时有几个」的快照,不是
  // 契约本身。117l 新增两个实现键,两个都是因为「够不着」才落在 13h:
  //   · relayDeliver —— 递话四通道的判定与执行,要同时够到 04 的三张待决表、13b 的 steerSessionCore、
  //     13d 的 decideIntervention 与 09 的 activeChildren;
  //   · applyThreadTier —— 把 06i 判出的那一档落成 session.engineRoute,要 02 的 normalizeSessionEngineRoute
  //     与 04 的 logEvent(06i 不能引用 00/02/04:103b 的依赖债务上限会把它拖进强连通分量)。
  // 真正的约束是下面两条(每个键都有消费者 + 每个键都登记在 06i 的契约注释里),故同时补一条
  // companion:新增的必须【就是】这两个,而不是"随便多了两个钩子";通道判定 stewardRelayChannelFor
  // 仍不上命名空间(消费者全在 13h 内)。
  // 117m-A4 重钉 16 -> 17。理由与 116h/117l 那两次同款:本波真的多了一个【够不着才落在 13h】的实现键 ——
  // threadStop 要直接调本文件的仲裁器原语 stewardCancelQueuedTurn,而 13g 已经顶到 SPEC §2 的 2000 行目标
  // (steward-runner.static ① 那道闸:HEAD 上是 1998 行)。这条断言本身仍是等号,没有被放宽。
  // 同款 companion 一起补:新增的必须【就是】threadStop,而不是「随便又多了一个钩子」。
  // 117s-G 重钉 17 -> 18。这一次多出来的不是「够不着才落在 13h」的新实现,而是一个【本来就在 13h、
  // 现在多了一个 13h 外消费者】的既有判定:relayChannel(= stewardRelayChannelFor)。13d 的
  // GET /api/sessions/:id 要把「这条线程此刻该走哪条递话通道」投影成信封上的 relay 键下发给经典壳,
  // 而 13d -> 13h 是前向边,只能经 06i 的延迟绑定命名空间取(与 arbiterWait 同款)。
  // 上一版那条「它不上命名空间,挂上去就是死代码」的理由随第一个外部消费者出现而失效 ——
  // 下面的 unused 判据仍然逐键看着「每个键都真的有人用」,纪律没有被放宽。
  ok(hookKeys.length === 18, `② 13h 填充 18 个实现键(116f 8 + 116-pre 1 + 116h 5 + 117l 2 + 117m-A4 1 + 117s-G 1;got ${hookKeys.length}: ${hookKeys.join(',')})`);
  ok(hookKeys.includes('threadStop') && /async function stewardImplThreadStop/.test(src13h) && !/async function stewardImplThreadStop/.test(src13g),
    '② 117m-A4 companion:新增的键是 threadStop,且它的实现真的在 13h、不在 13g(13g 的 2000 行闸就是这么守住的)');
  ok(hookKeys.includes('relayDeliver') && hookKeys.includes('applyThreadTier'),
    '② 117l companion:117l 那两个键 relayDeliver 与 applyThreadTier 都还在');
  // 117s-G companion:通道判定上了命名空间,但【只能】这么用 —— 13d 经 StewardHooks.relayChannel 取,
  // 源码里不许出现 13h 的符号(上面那条零前向边的机械判据已经在看着,这里再把「真的有这个消费者」
  // 正面钉一遍:哪天有人把它改回直接引用 13h,两条一起红)。
  ok(hookKeys.includes('relayChannel') && /StewardHooks\.relayChannel/.test(src13d) && /relayChannel: stewardRelayChannelFor/.test(src13h),
    '② 117s-G companion:relayChannel 上了命名空间,且 13d 只经 StewardHooks.relayChannel 消费它');
  // 116-2e:onInboxBatch / stopRunner / resumeRunner 的消费者在收件箱侧,随拆分搬进了 13i。
  const consumedText = src09 + src10 + src12 + src13 + src13d + src13g + src13i;
  const unused = hookKeys.filter(k => !new RegExp('StewardHooks\\.' + k + '\\b').test(consumedText));
  ok(unused.length === 0, '② 每个钩子键都被 09/10/12/13/13d/13g 之一消费' + (unused.length ? ' → 无人用: ' + unused.join(',') : ''));
  ok(filled.length >= hookKeys.length, '② 键集抽取自 Object.assign 块(样本自洽)');
  // 06i 的契约注释必须把这些键写下来(注释不是装饰品:steward-tools.static 用它对账填充完整性)。
  const contract = src06i.slice(src06i.indexOf('// 预留键名契约'), src06i.indexOf('const StewardHooks = {};'));
  const undocumented = hookKeys.filter(k => !contract.includes(k + '('));
  ok(undocumented.length === 0, '② 每个键都登记在 06i 的契约注释里' + (undocumented.length ? ' → 漏登: ' + undocumented.join(',') : ''));
}

/* ═════════════ ③ 06b steward 段与分层预算 ═════════════ */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-runner-static-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = tmpHome;
process.env.RUYI_HOME = tmpHome;
const srv = require(path.join(APP, 'server.js'));
{
  const zh = srv.getPromptPack('zh-CN').steward;
  const en = srv.getPromptPack('en-US').steward;
  ok(zh && en && typeof zh.stable === 'string' && typeof en.stable === 'string', '③ 06b 新增 steward 段且中英双包齐全');
  ok(JSON.stringify(Object.keys(zh)) === JSON.stringify(Object.keys(en)), '③ 中英两包键集逐条对齐(与 PROMPT_ZH/PROMPT_EN 其余段同纪律)');
  ok(zh.stable.length <= 2500, `③ 中文稳定层 ≤2500 字符(§11.2 稳定层预算;got ${zh.stable.length})`);
  ok(en.stable.length <= 2500, `③ 英文稳定层 ≤2500 字符(got ${en.stable.length})`);
  for (const [label, pack] of [['中文', zh], ['英文', en]]) {
    ok(/say/.test(pack.stable) && /acts/.test(pack.stable) && /actions/.test(pack.stable) && /why/.test(pack.stable),
      `③ ${label}稳定层写明四字段输出契约`);
    ok(typeof pack.visitNotes === 'string' && pack.visitNotes.length > 40, `③ ${label}包有 visitNotes 摘要 prompt(到访内 L2 压缩用)`);
    ok(typeof pack.overviewFolded === 'function' && typeof pack.inboxHeader === 'function', `③ ${label}包的折叠行与收件箱表头是模板函数`);
  }
  // 上限数字只有一份:13h 引用 06i 的 STEWARD_DIGEST_LIMITS,不自带 40/12000。
  ok(/STEWARD_DIGEST_LIMITS\.maxThreads/.test(src13h) && /STEWARD_DIGEST_LIMITS\.totalChars/.test(src13h),
    '③ 总览上限取 06i 的 STEWARD_DIGEST_LIMITS(不另立第二套数字)');
  ok(/buildStewardDigestLine\(/.test(src13h), '③ 总览行由 06i 的 buildStewardDigestLine 生成(与 116a 同一口径)');
  ok(/STEWARD_MEMORY_BLOCK_CHARS = 3000/.test(src13h), '③ 记忆块 ≤3000 字符(§11.2 半稳定层预算)');
  ok(/STEWARD_INBOX_EVENTS_PER_TURN = 30/.test(src13h) && /STEWARD_INBOX_EVENT_CHARS = 400/.test(src13h),
    '③ 回合层:收件箱事件 ≤30 条、每条 ≤400 字');
}

/* ═════════════ ④ 普通会话包零变化 ═════════════ */
{
  ok(srv.PROMPT_PACK_VERSION === '2026-w108-1', `④ PROMPT_PACK_VERSION 未 bump(新增 steward 段不改普通包;got ${srv.PROMPT_PACK_VERSION})`);
  const provider = { id: 'fake', label: 'Fake端点', model: 'fake-model' };
  const tools = [{ function: { name: 'file_read' } }, { function: { name: 'tool_search' } }];
  const stable = srv.buildStableSystemPrompt(provider, 'fake-model', 'C:\\proj', tools, false, {});
  ok(/本地 AI 工作台/.test(stable) && /先读后改/.test(stable), '④ 普通会话稳定层仍是普通包(身份层 + 工具协议层)');
  ok(!/我是如意,这台电脑上的工作台管家/.test(stable), '④ 管家稳定层绝不泄漏进普通会话');
  const volatile = srv.buildVolatileParts(provider, tools, null, {}, '', [], [], null);
  ok(!/我记得的关于用户的事/.test(volatile) && !/线程总览/.test(volatile), '④ 管家记忆块与总览绝不泄漏进普通会话易变层');
  // 分叉入口在源码里就是「session.kind === 'steward'」这一条判据(不经 sessionKind 归一)。
  ok(/const isStewardTurn = session\.kind === 'steward';/.test(src09), "④ 09 的分叉读【原始】 session.kind === 'steward'");
  ok(/session && session\.kind === 'steward' && typeof StewardHooks\.contextBudget === 'function'/.test(src10),
    '④ 10 的预算分叉同样读原始 kind,且经 StewardHooks 延迟绑定');
  ok(/stewardSession\) return out\.filter\(t => isStewardToolName/.test(srv.buildOpenAiTools.toString()),
    '④ 07 的管家工具面收口在唯一出口(管家会话只拿 steward_*)');
  ok(/activePacks\.add\('steward'\)/.test(read('07-autonomy.js')),
    '④ 按需装载对管家豁免收口在 07 内部(09 的 createToolLoadingState 调用点逐字节不变)');
}

/* ═════════════ ⑤ 路由与持久化面登记 ═════════════ */
{
  for (const p of ['/api/steward/visit', '/api/steward/message', '/api/steward/act']) {
    ok(new RegExp(`\\{ m: 'POST', p: '${p.replace(/\//g, '\\/')}', auth: 'token' \\}`).test(src01b), `⑤ ${p} 在 ROUTE_AUTH 里是 token 级`);
  }
  const inventory = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'architecture', 'durable-state-inventory.json'), 'utf8'));
  const rows = Array.isArray(inventory) ? inventory : (inventory.surfaces || inventory.entries || []);
  ok(rows.some(r => (r.id || r.name) === 'steward-visits'), '⑤ 到访归档面已登记进 durable-state-inventory');
  ok(/stewardEnabledV1 !== true/.test(src13h), '⑤ 13h 有开关 fail-closed 判据(开关关时三条路由 409、零写入)');
  ok(/STEWARD_SESSION_ID = 'steward'/.test(src06i), '⑤ 管家会话固定 id 定在 06i(13g 与 13h 共用同一常量)');
  ok(/if \(sid === STEWARD_SESSION_ID\) continue;/.test(src13i), '⑤ 收件箱轮询排除管家会话自己(防回合自激励成环)');
}

console.log(`\nSTEWARD RUNNER STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
