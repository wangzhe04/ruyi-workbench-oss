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
// 117 波 T1(32 号文 §2.1):13g 的工具实现与共享原语拆到了三个新文件(纯搬家)。它们与 13g 同属
// 「13g 族」,同样是 13h 的【消费者】—— 下面 ② 的零前向边判据与 unused 判据都必须覆盖它们,
// 否则一条 13h 符号只要搬进新文件就能绕过这把锁。
const src13j = read('13j-steward-tool-base.js');
const src13k = read('13k-steward-threads.js');
const src13l = read('13l-steward-ops.js');
// 116-2e:收件箱轮询与游标前移到 13i-steward-inbox.js(零行为搬家),⑤ 的收件箱断言随之改读 13i。
const src13i = read('13i-steward-inbox.js');
const src13h = read('13h-steward-runner.js');
// 117 波 T2(32 号文 §5):13h 已 2522 行(比 T1 拆之前的 13g 还长),按「谁被谁引用」拆成六个文件
// (纯搬家,拼接顺序即依赖方向)。这六个合起来才是原来那个「13h」,故下面凡是钉【运行器里有这件事】
// 的判据一律改读整族 —— 事实一个字没变,只是它现在住在族里的哪个文件由拆分决定;钉【落点】的那几条
// (① 的顺序链、② 的注册表与 threadStop 实现)仍各自钉到确切的那个文件。
const STEWARD_RUNNER_FAMILY = ['13m-steward-runner-base.js', '13n-steward-arbiter.js', '13o-steward-runner-prompt.js',
  '13p-steward-runner-actions.js', '13q-steward-runner-turn.js', '13h-steward-runner.js'];
const srcRunnerFamily = STEWARD_RUNNER_FAMILY.map(read).join('\n');
const src01b = read('01b-route-auth.js');

/* ═════════════ ① 模块落点 ═════════════ */
{
  const files = manifest.modules.map(m => m.file);
  const iRunner = files.indexOf('13h-steward-runner.js');
  ok(iRunner > 0, '① manifest 收录 13h-steward-runner.js');
  // 117 波 T2 重钉:13g 与 13h 之间插入了 T2 拆出的五个文件(纯搬家)。原来钉的是「下标差 1」,
  // 那钉的是当时的排布长什么样;这条判据的用意是「运行器族整段待在 13g 之后、组合根 14-main 之前,
  // 且顺序即依赖方向」。故改钉整条链本身 —— 比原来那个探针更严:族里任何一个被挪出这段连续区间、
  // 或顺序被换,这条都红。
  const iFam = files.indexOf('13g-steward.js') + 1;
  ok(iFam > 0 && STEWARD_RUNNER_FAMILY.every((f, k) => files[iFam + k] === f),
    '① 13g 之后是 T2 拆出的运行器族、以 13h 收尾(' + STEWARD_RUNNER_FAMILY.join(' -> ') + ';实得 '
    + JSON.stringify(files.slice(iFam, iFam + STEWARD_RUNNER_FAMILY.length)) + ')');
  // 121 波 K2a 重钉:13h 与 14-main 之间插进了 13r-event-stream.js(事件流,同为 transport 层;
  // 它必须排在【所有】管家模块之后 —— 它订阅总线、读五态与未决计数,排在前面全是前向边)。原来
  // 钉的是「下标恰好差 1」,那钉的是当时的排布长什么样;这条判据的【用意】写在上一行注释里 ——
  // 「运行器族整段待在组合根 14-main 之前」。故改钉这条用意本身:14-main 仍是最后一个模块,
  // 且 13h 在它之前。反向验证:把 14-main.js 挪到 manifest 中间 -> 这两条同时红。
  ok(files[files.length - 1] === '14-main.js', '① 14-main.js 仍是组合根(manifest 最后一个模块)');
  ok(iRunner < files.indexOf('14-main.js'), '① 13h 在 14-main.js 之前');
  // 13g 不得继续膨胀(SPEC §2 目标 2000 行;116c 交付记录已把 116f 另起 13h 的理由写在案)。
  const lines13g = src13g.split('\n').length;
  ok(lines13g < 2000, `① 13g 不超过 SPEC 目标 2000 行(got ${lines13g};116f 另起 13h 就是为了这条)`);
  // 117 波 T1:这条闸在 HEAD 上红了很久(2089 行)。T1 把 13g 按工具族拆成四个文件后它自然绿了 ——
  // 但只钉 13g 一个文件等于把债推到新文件里而锁看不见。故同时钉整族每个文件都在目标线以内。
  // 117 波 T2 重钉:上一版这里写着「13h 本身 2523 行已经超了,是既有债,不在这里新钉一条红」——
  // T2 已经把那笔债还了(13h 拆成六个文件,纯搬家)。故那条豁免删掉,运行器族六个文件与工具族三个
  // 一起进这道闸:以后再往管家回合层加东西,超线的是哪个文件当场就看得见。
  for (const [name, text] of [['13j-steward-tool-base.js', src13j], ['13k-steward-threads.js', src13k],
    ['13l-steward-ops.js', src13l], ...STEWARD_RUNNER_FAMILY.map(f => [f, read(f)])]) {
    const n = text.split('\n').length;
    ok(n < 2000, `① ${name} 也在 SPEC 目标 2000 行以内(got ${n};拆分不许把债换个文件放)`);
  }
  // 117l companion:这条预算不是靠少写注释守住的,而是靠「新判定不往 13g 堆」。本波三个新判据
  // 一个都不在 13g 里 —— 递话通道的判定与执行在 13h,id 人话化 / 模型分档 / 「它在问你」在 06i。
  // 117 波 T1:判据面从 13g 一个文件扩到整个 13g 族 —— 否则拆完之后把新判定塞进 13k/13l 就绕过去了。
  const famText = src13g + src13j + src13k + src13l;
  for (const symbol of ['stewardRelayChannelFor', 'stewardHumanizeIds', 'stewardThreadEngineRoute', 'stewardAsksYou']) {
    ok(!new RegExp('function ' + symbol + '\\s*\\(').test(famText), `① 117l companion: ${symbol} 的实现不在 13g 族(新判定往 13h/06i 放)`);
  }
}

/* ═════════════ ② 零前向边:消费者只认 StewardHooks ═════════════ */
{
  // 13h 族里所有顶层 function 名(它们是「13h 的符号」)。任何消费者源码里出现其中之一 = 前向边。
  // 117 波 T2 重钉:样本从「13h 一个文件」扩到整族 —— 否则一条符号只要搬进 13m/13n/13o/13p/13q
  // 就能绕过这把锁。判据一字未变,样本比原来大(判得更严)。
  const runnerSymbols = [...new Set((srcRunnerFamily.match(/^(?:async )?function ([A-Za-z0-9_]+)/gm) || [])
    .map(m => m.replace(/^(?:async )?function /, '')))];
  ok(runnerSymbols.length >= 15, `② 13h 顶层函数抽取到 ${runnerSymbols.length} 个(锁的样本足够大)`);
  // 116h 重钉:消费者面从 06/09/10/13g 扩到 06/09/10/12/13/13d/13g —— 仲裁的钩子多了三个新消费者
  // (12 的工具 handler、13 的 /api/stop、13d 的事项聚合行)。加入样本让「零前向边」的判据【更严】
  // (这三个文件同样不许出现 13h 的符号),同时让下面反向的 unused 判据仍然覆盖全部消费者。
  // 117 波 T1 再扩:13g 拆出的三个新文件同属 13g 族,同样不许出现 13h 的符号(判据更严,不是放宽)。
  const consumers = [['06-provider-engine.js', src06], ['09-workflow.js', src09], ['10-context-governance.js', src10],
    ['12-tool-dispatch.js', src12], ['13-http-router.js', src13], ['13d-core-domain-routes.js', src13d], ['13g-steward.js', src13g],
    ['13j-steward-tool-base.js', src13j], ['13k-steward-threads.js', src13k], ['13l-steward-ops.js', src13l],
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
  ok(hookKeys.length === 19, `② 13h 填充 19 个实现键(116f 8 + 116-pre 1 + 116h 5 + 117l 2 + 117m-A4 1 + 117s-G 1 + 121-K5 1;got ${hookKeys.length}: ${hookKeys.join(',')})`);
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
  // 117 波 T1:relayDeliver / applyThreadTier 的消费者随线程族工具搬进了 13k-steward-threads.js,
  // 故消费面同样扩到整个 13g 族(13g/13j/13k/13l)。判据一字未变:每个键都必须真的有人用。
  const consumedText = src09 + src10 + src12 + src13 + src13d + src13g + src13j + src13k + src13l + src13i;
  const unused = hookKeys.filter(k => !new RegExp('StewardHooks\\.' + k + '\\b').test(consumedText));
  ok(unused.length === 0, '② 每个钩子键都被 09/10/12/13/13d/13g 族之一消费' + (unused.length ? ' → 无人用: ' + unused.join(',') : ''));
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
  // 117v-V3(27 号文 §11.16.6):约束【开线程类 act】的措辞。琥珀色那枚按钮的词是模型自己现编的
  // (13h:673 `String(row.label || '').slice(...) || stewardActLabel(...)`),仓里没有对应的 i18n 键 ——
  // 所以「看…全文」这类内容词只能从提示词里管住,改前端文案管不到它。钉的是事实不是字面量:
  //   · 规则住在【易变层 rules】而不是 stable(stable 有 ≤2500 硬闸,英文已到 2453),两包都如此
  //     —— 判据用「撞车理由」这个语义要素定位它,不能用 open_thread 这个 token:输出契约那一行
  //     ("kind": "tool"|"open_thread"|"dismiss")本来就在 stable 里,拿它判会永远假红;
  //   · 规则里同时出现 open_thread(代码 token,稳定)与「和交付卡那枚全文按钮撞车」这个理由。
  const openThreadRuleZh = zh.rules.split('\n').find(l => /open_thread/.test(l)) || '';
  const openThreadRuleEn = en.rules.split('\n').find(l => /open_thread/.test(l)) || '';
  ok(/全文/.test(openThreadRuleZh) && /打开线程|去处/.test(openThreadRuleZh),
    '③ 117v-V3 中文 steward.rules 里有约束 open_thread 措辞的一条(写去处、别写「看…全文」)');
  ok(/full[- ]?text|full text/i.test(openThreadRuleEn) && /open the thread|destination/i.test(openThreadRuleEn),
    '③ 117v-V3 英文包同步一条同义规则(destination 而非 "See the full ...")');
  ok(!/全文/.test(zh.stable) && !/full[- ]?text/i.test(en.stable),
    '③ 117v-V3 这条在易变层 rules、没有塞进 stable(≤2500 硬闸没被顶破;英文 stable 现在 ' + en.stable.length + ')');
  // 117 波 T2 重钉:下面五条钉的都是【运行器里有这件事】,不是【它住哪个文件】,故一律改读整族
  // (拆分把 label 兜底搬进 13p、总览搬进 13o、三个数值口径搬进 13m)。期望值一个字没改。
  ok(/label: String\(row\.label \|\| ''\)[\s\S]{0,80}stewardActLabel\(/.test(srcRunnerFamily),
    '③ 117v-V3 那枚 act 的 label 确实由模型给(13h 族是 row.label 优先、仓里的 stewardActLabel 只兜底),故只能靠提示词管');
  // 上限数字只有一份:13h 族引用 06i 的 STEWARD_DIGEST_LIMITS,不自带 40/12000。
  ok(/STEWARD_DIGEST_LIMITS\.maxThreads/.test(srcRunnerFamily) && /STEWARD_DIGEST_LIMITS\.totalChars/.test(srcRunnerFamily),
    '③ 总览上限取 06i 的 STEWARD_DIGEST_LIMITS(不另立第二套数字)');
  ok(/buildStewardDigestLine\(/.test(srcRunnerFamily), '③ 总览行由 06i 的 buildStewardDigestLine 生成(与 116a 同一口径)');
  ok(/STEWARD_MEMORY_BLOCK_CHARS = 3000/.test(srcRunnerFamily), '③ 记忆块 ≤3000 字符(§11.2 半稳定层预算)');
  ok(/STEWARD_INBOX_EVENTS_PER_TURN = 30/.test(srcRunnerFamily) && /STEWARD_INBOX_EVENT_CHARS = 400/.test(srcRunnerFamily),
    '③ 回合层:收件箱事件 ≤30 条、每条 ≤400 字');

  // ── 117y-S1/S2(27 号文 §11.18):say 的长度由【提示词】管,运行期只剩一道病态载荷天花板。──
  // 钉四件事实,一条一条都可证伪:
  //   (a) 600 已经不是运行期的刀 —— 13o 里再没有任何 `slice(0, STEWARD_SAY…)`,旧名 STEWARD_SAY_MAX
  //       全族绝迹(留着它 = 留着第二套语义,谁都不知道该信哪个);
  //   (b) 两条解析路径(JSON 解析失败的兜底 / 解析成功的 say)走【同一个函数、同一个天花板】,
  //       不许只改一处 —— 数出现次数,不是「至少有一处」;
  //   (c) 句界裁剪那个纯函数住在 06i(纯函数与常量的归宿),不在运行器族里另抄一份;
  //   (d) 06b 输出契约里写给模型看的那个数字与 STEWARD_SAY_TARGET 是同一个 600(不另立第二套数字)。
  const src13o = read('13o-steward-runner-prompt.js');
  const src13m = read('13m-steward-runner-base.js');
  const sayMaxHits = (srcRunnerFamily.match(/STEWARD_SAY_MAX/g) || []).length;
  ok(sayMaxHits === 0, `③ 117y-S1(a) 旧名 STEWARD_SAY_MAX 在运行器族里绝迹(got ${sayMaxHits} 处)`);
  const bareSliceHits = (src13o.match(/slice\(0, STEWARD_SAY/g) || []).length;
  ok(bareSliceHits === 0, `③ 117y-S1(a) 13o 里再没有按 say 常量裸 slice 的写法(got ${bareSliceHits} 处)`);
  const trimHits = (src13o.match(/stewardTrimSayAtSentence\(/g) || []).length;
  ok(trimHits === 2, `③ 117y-S1(b) 13o 恰有两处走句界裁剪 = 兜底那条 + say 那条(got ${trimHits} 处)`);
  // 注意别写成 `\([^)]*STEWARD_SAY_CEILING\)`:兜底那一处的实参是 `raw.trim()`,里面自带一对括号,
  // 那种写法只数得到一处并给出一条假红(本刀实测)。按「同一行内」定界。
  const ceilingHits = (src13o.match(/stewardTrimSayAtSentence\([^\n;]*STEWARD_SAY_CEILING\)/g) || []).length;
  ok(ceilingHits === 2, `③ 117y-S1(b) 两处用的是同一个天花板常量 STEWARD_SAY_CEILING(got ${ceilingHits} 处)`);
  ok(/const STEWARD_SAY_TARGET = 600;/.test(src13m) && /const STEWARD_SAY_CEILING = 4000;/.test(src13m),
    '③ 117y-S1 两个常量拆开定在 13m(TARGET 600 只是提示词目标 / CEILING 4000 只防病态载荷)');
  ok(/function stewardTrimSayAtSentence\(/.test(src06i) && !/function stewardTrimSayAtSentence\(/.test(srcRunnerFamily),
    '③ 117y-S1(c) 句界裁剪的纯函数只在 06i 定义一份,运行器族不另抄');
  // (d) 契约里那句 ≤600 与常量同源:中英两包都写着 600,且 13m 的 TARGET 也是 600。
  ok(new RegExp('<=' + srv.STEWARD_SAY_TARGET + ' chars').test(en.stable)
    && new RegExp('≤' + srv.STEWARD_SAY_TARGET + ' 字').test(zh.stable),
    `③ 117y-S1(d) 06b 输出契约里的字数与 STEWARD_SAY_TARGET 同源(${srv.STEWARD_SAY_TARGET})`);
  // 反向保护(§11.18.5 第 4 条)的源码面:总览行那把 200 字 + 省略号的刀没被这一刀误伤。
  // 行为面在 unit/steward-core.test.js ⑤ 段;这里钉的是「它没有被改写成走天花板那条路」。
  ok(/STEWARD_LAST_SAY_CHARS = STEWARD_DIGEST_LIMITS\.lastSayChars/.test(src06i)
    && /raw\.slice\(0, STEWARD_LAST_SAY_CHARS\) \+ '…'/.test(src06i)
    && !/function stewardClipSay\(value\) \{[\s\S]{0,200}stewardTrimSayAtSentence/.test(src06i),
    '③ 117y 反向保护:stewardClipSay 仍是 200 字 + 省略号,没被并进天花板那条路');

  // ── 117y-S2:rules 的字数闸(还 117v-V3 登记的那笔债)────────────────────────────────
  // rules 每回合拼在第一条 user 消息【前缀】里,**不吃前缀缓存** —— 它比 stable 更该被看住,
  // 而修前 stable 有 ≤2500 硬闸、rules 一个数字都没人看着(117l 4 条 -> 117s 5 条 -> 117y 7 条)。
  // 闸的理由:**必须低于 stable 的 2500** —— 否则「stable 塞不下就往 rules 挪」就成了
  // 绕开稳定层预算、把每回合不缓存的开销做大的后门。
  // 123-N1(34 号文;2026-09-13):2200 → 2480,并把上面那行陈述改成实测值。**这不是一次无痛调参,
  // 记清楚它为什么发生**:
  //   · 原注释写「2200 对英文包当前 1747 字还留 ~450 字(约两三条规则)的余量」——**这个数早就过期了**。
  //     117z-E2 又往英文 rules 里加了 226 字(桌面权限那条)却没回来改这行字,于是它承诺的余量
  //     早已花光;本刀派单稿据它写「中英各加 ≤400 字符有余量」,实测下来只剩 226。
  //   · 本刀新增两条(分档 / 开线程前澄清),英文写成电报体之后仍要 470 字,只能抬闸。
  //   · **英文包现在 2444/2480,是满的**:下一条英文规则塞不进来。再要加规则,修法【不是】再抬这个
  //     数字(2500 是死顶:rules 不许比 stable 贵),而是先压缩英文行 —— 英文各行普遍是对应中文行的
  //     2.5~4 倍(如「把话说完整」那条 en 362 / zh 122),压缩空间在那里,或者退役一条。
  const RULES_BUDGET = 2480;
  ok(RULES_BUDGET < 2500, '③ 117y-S2 rules 闸严于 stable 闸(不缓存的那一层不许比缓存层更贵)');
  ok(typeof zh.rules === 'string' && zh.rules.length <= RULES_BUDGET,
    `③ 117y-S2 中文 rules ≤${RULES_BUDGET} 字符(got ${zh.rules && zh.rules.length})`);
  ok(typeof en.rules === 'string' && en.rules.length <= RULES_BUDGET,
    `③ 117y-S2 英文 rules ≤${RULES_BUDGET} 字符(got ${en.rules && en.rules.length})`);
  ok(zh.rules.split('\n').length === en.rules.split('\n').length,
    `③ 117y-S2 中英 rules 条数逐条对齐(zh ${zh.rules.split('\n').length} / en ${en.rules.split('\n').length})`);
  // 第 7 条本身:钉语义要素不钉字面量(容许润色),中英各一条。
  const finishRuleZh = zh.rules.split('\n').find(l => /说完整|说半句/.test(l)) || '';
  const finishRuleEn = en.rules.split('\n').find(l => /finish every sentence|half a sentence/i.test(l)) || '';
  ok(/说完整/.test(finishRuleZh) && /半句/.test(finishRuleZh) && /话题/.test(finishRuleZh),
    '③ 117y-S2 中文 rules 有「把话说完整/不说半句/砍话题不砍句子」这一条');
  ok(/finish every sentence/i.test(finishRuleEn) && /half a sentence/i.test(finishRuleEn) && /topic/i.test(finishRuleEn),
    '③ 117y-S2 英文包同步一条同义规则(finish every sentence + drop a topic)');
  ok(!/说完整/.test(zh.stable) && !/finish every sentence/i.test(en.stable),
    `③ 117y-S2 这条同样落在易变层 rules、没塞进 stable(英文 stable 仍 ${en.stable.length}/2500)`);

  // ── 123-N1 ②③(34 号文;用户 2026-09-13 真机走查「管家话有点密」「不用急着自己判断直接开线程」)──
  // 两条新规则各钉一条,钉的是【语义要素】不是字面量(容许润色):
  //   ② 分档那条最贵的半句是「不复述委托书」—— 开线程那一轮 350 字里绝大多数是把刚发出去的
  //      委托书又念一遍,而它就印在线程卡上。中英各用自己的关键词定位。
  //   ③ 澄清那条的【度】只有两个要素:歧义有先例就不问、要问也只问一次。少任何一个都会退化成
  //      「每次都问」(啰嗦)或「从不问」(修前那样)。
  const tierRuleZh = zh.rules.split('\n').find(l => /篇幅按场景分档/.test(l)) || '';
  const tierRuleEn = en.rules.split('\n').find(l => /length by situation/i.test(l)) || '';
  ok(/不复述委托书/.test(tierRuleZh) && /线程卡/.test(tierRuleZh) && /追问/.test(tierRuleZh),
    '③ 123-N1 ② 中文 rules 有「篇幅按场景分档」这一条,且写明【不复述委托书】(它在线程卡上)');
  ok(/never restating the brief/i.test(tierRuleEn) && /thread card/i.test(tierRuleEn) && /follow-up/i.test(tierRuleEn),
    '③ 123-N1 ② 英文包同步一条同义规则(never restating the brief + it is on the thread card)');
  const askRuleZh = zh.rules.split('\n').find(l => /开线程前/.test(l)) || '';
  const askRuleEn = en.rules.split('\n').find(l => /before opening a thread/i.test(l)) || '';
  ok(/先例/.test(askRuleZh) && /只问一次/.test(askRuleZh) && /这一轮不开线程/.test(askRuleZh),
    '③ 123-N1 ③ 中文 rules 有「开线程前先澄清」这一条,且两个要素齐全(有先例就不问 + 只问一次)');
  ok(/precedent/i.test(askRuleEn) && /ask once/i.test(askRuleEn) && /open nothing this turn/i.test(askRuleEn),
    '③ 123-N1 ③ 英文包同步一条同义规则(no precedent + ask once + open nothing this turn)');
  ok(!/篇幅按场景分档/.test(zh.stable) && !/length by situation/i.test(en.stable)
    && !/开线程前/.test(zh.stable) && !/before opening a thread/i.test(en.stable),
    `③ 123-N1 两条新规则同样落在易变层 rules、没塞进 stable(英文 stable 仍 ${en.stable.length}/2500)`);
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
  // 123-N1 ①(34 号文;用户 2026-09-13 真机走查「同一段对话出现两遍」):回执带落盘时刻。
  // 钉的是三件必须同时成立的事实,不是某一行的写法:
  //   · 取值来自【最后一条助手消息的 createdAt】—— 与 stewardStampReply 盖章的是同一条消息,
  //     也与 13d 那段 `?since=` 过滤用的是同一个字段(否则水位与增量不是一把尺,又会重画);
  //   · 它进的是回执对象本身(前端 finishReply 从 steward_reply 帧上读它);
  //   · 读不到就【不下发这个键】,老回执逐字节不变、前端自己走「对齐一发」的退路。
  const src13q = read('13q-steward-runner-turn.js');
  ok(/async function stewardLastAssistantCreatedAt\(\)/.test(src13q)
    && /role === 'assistant'\) return String\(messages\[i\]\.createdAt \|\| ''\)/.test(src13q),
    '⑤ 123-N1 ① 13q 有「最后一条助手消息的 createdAt」这个取数口径(与 stewardStampReply 同一条消息)');
  ok(/const stampedAt = await stewardLastAssistantCreatedAt\(\);/.test(src13q)
    && /\.\.\.\(stampedAt \? \{ createdAt: stampedAt \} : \{\}\)/.test(src13q),
    '⑤ 123-N1 ① 回执带 createdAt,且读不到时【不下发这个键】(老回执逐字节不变)');
  ok(/return Number\.isFinite\(at\) && at > sinceMs;/.test(src13d),
    '⑤ 123-N1 ① 服务端 ?since= 是【严格大于】—— 水位停在本回合末尾正好把这一回合两条消息一起盖住');
}

console.log(`\nSTEWARD RUNNER STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
