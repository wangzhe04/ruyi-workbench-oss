'use strict';
/*
 * E2E (第48波48a): 提示词护栏 04 Phase A -- buildProviderSystemPrompt 分层快照 + 预算断言。
 *
 * 04 Phase A 核心:"提示词快照测试 -- 改动清单自动生成器,任何提示词 diff 必须体现在快照更新里"。
 * 本件对 buildProviderSystemPrompt 在固定假配置下的输出做分层快照(每层关键标记 + 总长闸),
 * 并钉 identityOnly/无工具/mission/skills/provider.systemPrompt 各分支。提示词文本一旦删改标记 -> 红,
 * 强制 intentional 快照更新(review 可见 diff)。
 *
 * 51 波(04 Phase B/C)会在护栏之上做外置/i18n/缓存分层;此处只立"当前文本基线"的机械锁。
 *
 * Run: node dev-harness/prompt-snapshot.static.e2e.js
 */
const fs = require('fs'), path = require('path');
const SERVER = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js');
const srv = require(SERVER);
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// 固定假输入(快照基线--改这里=改基线,需同步更新断言)。
const provider = { id: 'fake', label: 'Fake端点', model: 'fake-model', systemPrompt: '【provider 自定义尾】测试用。' };
const model = 'fake-model';
const cwd = 'C:\\proj';
const tools = [
  { function: { name: 'file_read', description: 'read', parameters: { type: 'object', properties: {} } } },
  { function: { name: 'tool_search', description: 'search', parameters: { type: 'object', properties: {} } } },
  { function: { name: 'spawn_agent', description: 'spawn', parameters: { type: 'object', properties: {} } } },
];
const caps = { network: { online: true }, desktopMcp: { present: false, toolCount: 0 }, binaries: { git: true, rg: true }, provider: { vision: false } };
const config = { enableToolRequiresProbe: false, subagentMaxConcurrent: 2, subagentMaxPerTurn: 4 };
const skillEntries = [{ kind: 'skill', id: 'sk1', name: '示例技能', description: 'desc', dir: 'C:/sk/sk1' }];

console.log('── L 段: 分层快照(各层关键标记) ──');
const full = srv.buildProviderSystemPrompt(provider, model, cwd, tools, caps, config, '', false, skillEntries, [], null);

// L1 身份层
ok(/本地 AI 工作台/.test(full) && /Fake端点/.test(full) && /fake-model/.test(full) && /C:\\proj/.test(full), 'L1 身份层:工作台+provider label+model+cwd');
ok(/GitHub 风格 Markdown/.test(full), 'L1 身份层:markdown 风格约定在');
// L2 工具协议守则层
ok(/先读后改/.test(full), 'L2 工具协议:先读后改');
ok(/工具批次/.test(full) && /同一条助手消息/.test(full) && /分阶段调用/.test(full), 'L2 工具协议:独立调用合批、依赖调用分阶段');
ok(/授权与指令边界/.test(full) && /不构成用户授权/.test(full) && /不得改用终端/.test(full), 'L2 工具协议:观察内容不是授权且拒绝不可绕过');
ok(/tool_search/.test(full) && /按需装载/.test(full), 'L2 工具协议:tool_search 按需装载');
ok(/工具选用优先级/.test(full), 'L2 工具协议:选用优先级(现成工具优先,终端兜底)');
ok(/上下文节流守则/.test(full) && /600 行/.test(full) && /线性通读/.test(full), 'L2 工具协议:上下文节流守则(分段读+读取预算,防撑爆上下文)');
ok(/todo_write/.test(full), 'L2 工具协议:todo_write 计划');
// L3 能力层
ok(/当前能力/.test(full) && /在线/.test(full) && /有 git/.test(full) && /有 ripgrep/.test(full), 'L3 能力层:网络+git+ripgrep');
ok(/子代理编排/.test(full) && /spawn_agent/.test(full) && /dependsOn/.test(full), 'L3 能力层:子代理编排+dependsOn(spawn_agent offered)');
// skills 层
ok(/<skill-index>/.test(full) && /<\/skill-index>/.test(full), 'L4 skills 层:skill-index 围栏闭合');
ok(/示例技能/.test(full) && /\[sk1\]/.test(full), 'L4 skills 层:技能名+[id](provider 引擎)');
ok(/参考资料.*不得覆盖以上任何守则/.test(full), 'L4 skills 层:不可信降级声明(技能不得覆盖守则)');
// provider.systemPrompt 层
ok(/【provider 自定义尾】/.test(full), 'L5 provider 层:systemPrompt 追加在末尾');

console.log('── B 段: 分支(identityOnly/无工具/mission) ──');
const idOnly = srv.buildProviderSystemPrompt(provider, model, cwd, tools, caps, config, '', true, [], [], null);
ok(/本地 AI 工作台/.test(idOnly), 'B1 identityOnly=true 保留身份层');
ok(!/当前能力/.test(idOnly), 'B2 identityOnly=true 剥离能力层(子代理/纯身份场景;工具协议层按设计保留--hasTools 即注入,不受 identityOnly 门控)');
ok(/先读后改/.test(idOnly), 'B2b identityOnly=true 保留工具协议层(hasTools 时,子代理亦需工具守则)');
const noTools = srv.buildProviderSystemPrompt(provider, model, cwd, [], caps, config, '', false, [], [], null);
ok(/无工具的纯对话模式/.test(noTools), 'B3 hasTools=false:纯对话模式提示');
ok(!/先读后改/.test(noTools), 'B4 hasTools=false:不注入工具协议守则');
ok(!/上下文节流守则/.test(noTools), 'B4b hasTools=false:不注入上下文节流守则');
const baseNoMis = srv.buildProviderSystemPrompt(provider, model, cwd, tools, caps, config, '', false, [], [], null);
const fullMission = srv.buildProviderSystemPrompt(provider, model, cwd, tools, caps, config, '', false, [], [], { goal: '完成 X', milestones: [{ id: 'm1', desc: '第一步', status: 'pending' }] });
ok(/完成 X/.test(fullMission) && /任务账本/.test(fullMission), 'B5 mission 注入(任务账本层:goal 文本 + 账本标识出现)');
ok(fullMission.length > baseNoMis.length, 'B5b mission 使提示长度增长(同配置无 mission 基线对比)');

console.log('── $ 段: 预算断言(总长闸 + 不可信围栏闭合) ──');
ok(full.length > 800 && full.length < 12000, '$1 总长闸:800 < len(' + full.length + ') < 12000(最小配置基线,提示词膨胀即红)');
// 不可信带围栏闭合(skill-index)防伪造:开标签数 == 闭标签数。
const openCount = (full.match(/<skill-index>/g) || []).length;
const closeCount = (full.match(/<\/skill-index>/g) || []).length;
ok(openCount === closeCount && openCount >= 1, '$2 skill-index 围栏开/闭数相等(防悬空围栏,伪造中和防线前提) got ' + openCount + '/' + closeCount);
// 04 Phase A "预算断言":每层预算的静态存在(技能 3000 字上限在 buildSkillsPromptSection)。
const src = fs.readFileSync(SERVER, 'utf8');
ok(/整段上限 3000 字符/.test(src) || /budget = 3000/.test(src), '$3 技能索引预算 3000 字上限在(buildSkillsPromptSection)');

console.log('── D 段: 51d C1a 稳定/易变层拆分(prefix-cache 分层基础) ──');
// buildStableSystemPrompt 不含 volatile 标记(身份+工具协议+provider,逐字节稳定)
const stable = srv.buildStableSystemPrompt(provider, model, cwd, tools, false);
ok(/本地 AI 工作台/.test(stable) && /先读后改/.test(stable) && /工具批次/.test(stable), 'D1 stable 含身份+工具协议及合批规则(稳定层)');
ok(!/当前能力/.test(stable) && !/桌面操控/.test(stable) && !/<skill-index>/.test(stable) && !/任务账本/.test(stable), 'D2 stable 不含 volatile 标记(能力/桌面/技能/账本)');
ok(stable.length < 1800, 'D3 stable 长度 < 1800(稳定层轻量:身份+工具协议+provider;在 contextBudget 后新增授权边界并按 intentional snapshot 上调;108a 身份块新增运行时身份层后再次上调 1500->1800;145-W3 加 mermaid 成图一句后约 1640,闸不动,got ' + stable.length + ')');
// 145-W3(引擎运行环境说明,intentional snapshot 更新):为什么改——用户要求各引擎的线程都知道自己在如意里、
// 有什么能力;provider 这一路身份层/运行时身份层早已有,只缺「界面会把 mermaid 画成图」(版本级常量 -> 稳定层)
// 与「当前权限档含义」(随配置变 -> 易变层),rg 那一格改为说清终端里能否直接敲 rg。三件都从 06 buildEngineEnvBrief
// 同一张事实表出,Claude/Kimi 的 <ruyi-environment> 用的也是它(那两个变体由 engine-env-brief.static 钉)。
ok(stable.includes('```mermaid') && /画成图/.test(stable), 'D3b 145-W3 stable 含 mermaid 成图一句(版本级常量,稳定层)');
ok(!/<ruyi-environment>/.test(stable) && !/<ruyi-environment>/.test(full), 'D3c 145-W3 provider 不拿 CLI 的整段 <ruyi-environment>(身份不重复)');
// buildVolatileParts 含 volatile 标记
const volatile = srv.buildVolatileParts(provider, tools, caps, config, '', skillEntries, [], null);
ok(/当前能力/.test(volatile) && /在线/.test(volatile), 'D4 volatile 含能力层');
ok(/<skill-index>/.test(volatile), 'D5 volatile 含技能索引围栏');
ok(/权限：当前是「每步都问」模式/.test(volatile) && !/权限：当前是/.test(stable), 'D5b 145-W3 当前权限档含义进易变层(夹具无 permissionMode -> 默认档),不进稳定层');
ok(volatile.length > 100 && volatile.length < 5000, 'D6 volatile 长度合理(got ' + volatile.length + ')');
// 向后兼容:buildProviderSystemPrompt(包装) = stable + volatile(文本不变)
ok(full.length >= stable.length + volatile.length - 5, 'D7 包装=stable+volatile(向后兼容,full ' + full.length + ' >= stable ' + stable.length + ' + volatile ' + volatile.length + ')');
// C1b 请求装配:易变层用真实换行注入,且上下文治理预算必须包含 stable+volatile。
ok(src.includes("turnVolatile + '\\n\\n'") && !src.includes("turnVolatile + '\\\\n\\\\n'"), 'D8 volatile 前缀使用真实换行,不向模型发送字面量 \\\\n');
ok(typeof srv.PROMPT_PACK_VERSION === 'string' && /^20\d\d-w\d+-\d+$/.test(srv.PROMPT_PACK_VERSION), 'D9 PROMPT_PACK_VERSION 语义化版本(52d, got ' + srv.PROMPT_PACK_VERSION + ')');
ok(/const budgetPrompt = turnVolatile \? sys \+ '\\n\\n' \+ turnVolatile : sys;/.test(src), 'D9 上下文预算提示包含 stable+volatile');
ok(/maybeAutoCompact\(session, provider, budgetPrompt,/.test(src) && /estimateHistoryTokens\(session\.providerHistory, budgetPrompt\)/.test(src), 'D10 自动压缩与 fallback 估算均使用完整预算提示');
// 108a 运行时身份层:产品名/版本/启动模式进 stable(自我认知),且必须逐字节稳定、identityOnly 不注入。
// 108a-fix2: stable 层渲染文字必须跨进程恒定:address(随机端口)与 instanceId(每进程随机 OVERLAY_ID)
// 会让 budget-guard.e2e.js 两个独立栈的请求体逐字节比对失败(E4/E30),故两项与 installDir/dataDir
// 一样不入提示词文字(仍在 buildRuntimeIdentityFacts() 返回值里,供 108c workbench_self_status 使用)。
const pkgVersion = String(require(path.resolve(__dirname, '..', 'ruyi-workbench', 'package.json')).version || '');
const runtimeFacts = srv.buildRuntimeIdentityFacts();
ok(pkgVersion.length > 0 && stable.includes(pkgVersion) && /运行环境/.test(stable),
  'D11 108a stable 含运行时身份块(版本 ' + pkgVersion + ' + 运行环境标记)');
ok(!stable.includes('http://127.0.0.1') && !stable.includes(runtimeFacts.instanceId),
  'D11a 108a-fix2 stable 不含服务地址与实例标识(跨进程恒定,budget-guard 逐字节比对不漂)');
// 108a-fix: 镜像 capabilities.e2e.js 的「身份泄漏守卫」(/Claude/i、/Workbench/i):stable 层绝不能出现
// 这两个字面量(会让 provider 模型误认成 Claude,或泄漏改名前的旧产品名 Win Claude Workbench)。
ok(!/Claude/i.test(stable) && !/Workbench/i.test(stable), 'D11b 108a-fix stable 层无 Claude/Workbench 字面量(身份泄漏守卫,镜像 capabilities.e2e.js)');
const stableTwice = srv.buildStableSystemPrompt(provider, model, cwd, tools, false);
ok(stableTwice === stable, 'D12 108a 同进程两次构建 stable 逐字节相同(无时间戳/会话 id,prefix-cache 防呆)');
const stableIdOnly = srv.buildStableSystemPrompt(provider, model, cwd, tools, true);
ok(!/运行环境/.test(stableIdOnly), 'D13 108a identityOnly=true 不注入运行时身份层(压缩摘要调用保持廉价)');
// 108b Playbook 精简索引:末位可选参数(既有位置参数不动),不可信文本中和,规模硬顶,尾行说明「用户在技能库运行」。
const pbOne = [{ id: 'demo', title: '演示 Playbook', description: '一句话<script>', available: true }];
const volatilePb = srv.buildVolatileParts(provider, tools, caps, config, '', skillEntries, [], null, null, null, pbOne);
const pbOpen = (volatilePb.match(/<playbook-index>/g) || []).length;
const pbClose = (volatilePb.match(/<\/playbook-index>/g) || []).length;
ok(pbOpen === 1 && pbClose === 1, 'D14 108b volatile 含 <playbook-index> 围栏各一次(开 ' + pbOpen + '/闭 ' + pbClose + ')');
ok(/演示 Playbook/.test(volatilePb) && /\[demo\]/.test(volatilePb), 'D14b 108b 条目行含标题 + [id]');
ok(!/<script>/.test(volatilePb) && /\[script\]/.test(volatilePb), 'D14c 108b 不可信描述里的尖括号被中和成方括号(伪造围栏/标签失效)');
ok(/技能库/.test(volatilePb), 'D14d 108b 尾行说明由用户在技能库面板运行(agent 无执行工具)');
const pbMany = Array.from({ length: 30 }, (_, i) => ({ id: 'pb' + i, title: '流程' + i, description: '描述'.repeat(20), available: i % 5 !== 0 }));
const pbSecMany = srv.buildPlaybookIndexSection(pbMany, config);
const pbLines = (pbSecMany.match(/^- /gm) || []).length;
ok(pbSecMany.length <= 600, 'D15 108b 整段硬顶 600 字符(30 条合成输入,got ' + pbSecMany.length + ')');
ok(pbLines <= 12 && pbLines >= 1, 'D15b 108b 条目上限 12 条(got ' + pbLines + ')');
ok(/已截断/.test(pbSecMany), 'D15c 108b 超限时留省略行(被裁掉这件事不静默丢失)');
ok(!/<playbook-index>/.test(volatile), 'D16 108b 不传 playbook 时 volatile 无索引段(既有夹具路径零漂移)');
ok(volatile.length > 100 && volatile.length < 5000, 'D17 108b 既有夹具 volatile 仍满足 D6 闸(got ' + volatile.length + ')');
// 108b 设置边界双语指引:mcp 工具在场时注入,中文包说清「能改什么、不能改什么、去哪儿改」。
const mcpTools = [{ function: { name: 'mcp_list' } }, { function: { name: 'mcp_configure' } }];
const volatileMcp = srv.buildVolatileParts(provider, mcpTools, caps, config, '', [], [], null);
const volatileNoMcp = srv.buildVolatileParts(provider, [{ function: { name: 'file_read' } }], caps, config, '', [], [], null);
const hintZh = srv.buildToolCustomizationHint(config);
ok(/设置面板/.test(hintZh) && /mcp_configure/.test(hintZh) && /mcp_list/.test(hintZh), 'D17b 108b 中文设置边界指引含 mcp_list/mcp_configure 与「设置面板」引导');
ok(hintZh.length <= 700, 'D17c 108b 中文指引 ≤700 字符(got ' + hintZh.length + ')');
ok(volatileMcp.includes(hintZh) && volatileMcp.length - volatileNoMcp.length <= 700, 'D17d 108b mcp 工具在场时注入该段且增量 ≤700(got ' + (volatileMcp.length - volatileNoMcp.length) + ')');
ok(/settings panel/.test(srv.buildToolCustomizationHint({ locale: 'en-US' })), 'D17e 108b 英文包同步含设置面板边界(双语对齐)');
// 108c: workbench_self_status 在场时注入自查提示,不在场则不注入(offeredNames 门控)。
const selfStatusTools = [{ function: { name: 'workbench_self_status' } }];
const volatileSelfStatus = srv.buildVolatileParts(provider, selfStatusTools, caps, config, '', [], [], null);
const volatileNoSelfStatus = srv.buildVolatileParts(provider, [{ function: { name: 'file_read' } }], caps, config, '', [], [], null);
ok(/workbench_self_status/.test(volatileSelfStatus), 'D18 108c volatile 含 workbench_self_status 时注入自查提示');
ok(!/workbench_self_status/.test(volatileNoSelfStatus), 'D18b 108c 不含该工具时 volatile 无此提示');

console.log('── E 段: 子代理任务漏斗上下文节流注入(2.2,唯一漏斗 09-workflow effectiveTask) ──');
ok(/【上下文节流守则】/.test(src), 'E1 子代理任务漏斗含上下文节流守则(09 effectiveTask 注入,spawn/orchestrate 全路径)');
ok(/reliabilityInstruction \+ throttlingInstruction \+ toolEvidenceInstruction/.test(src), 'E2 拼接顺序:可靠性约束 → 节流守则 → 工具证据(指令层级正确,节流紧随可靠性)');

console.log('── S 段: 116f 管家包(只加) ──');
// 116f: steward 段是【第二个包】,与普通包并存;它整段替换管家会话的提示词,绝不进普通会话。
// 本段只加断言:上面 L/B/$/D/E 段的普通包快照一条未改,即「新增 steward 段不算改普通包」。
const stewardPack = srv.getPromptPack('zh-CN').steward;
ok(stewardPack && typeof stewardPack.stable === 'string' && stewardPack.stable.length <= 2500,
  'S1 116f 06b 新增 steward 段,稳定层 ≤2500 字符(got ' + (stewardPack && stewardPack.stable.length) + ')');
ok(/say/.test(stewardPack.stable) && /acts/.test(stewardPack.stable) && /actions/.test(stewardPack.stable) && /why/.test(stewardPack.stable),
  'S2 116f 稳定层写明 {say, acts, actions, why} 输出契约');
const stewardMark = stewardPack.stable.slice(0, 8);
ok(!full.includes(stewardMark) && !stable.includes(stewardMark) && !volatile.includes(stewardMark),
  'S3 116f 管家包绝不泄漏进普通会话的任何一层(身份/稳定层/易变层)');
ok(typeof stewardPack.visitNotes === 'string' && stewardPack.visitNotes.length > 40,
  'S4 116f 管家包带 visitNotes 摘要 prompt(到访内 L2 压缩换用它,不动普通会话的 SUMMARY_PROMPT)');

console.log('── V 段: 117v-V3 结论先行(27 号文 §11.16.2 V3 行) ──');
// 钉的是【事实】不是字面量:规则可以被润色、可以换词,但下面五条必须仍然成立 ——
//   V1 中英两包在同一层都有这条规则(结构对齐 + 两个语义要素:「结论」与「第一/首段」);
//   V2 每条真正干活的会话都拿得到(!identityOnly 门控,且【不】看 hasTools);
//   V3 identity-only 探针拿不到(压缩摘要保持廉价,身份泄漏守卫那条路径不变);
//   V4 它够不到的两个既有替代品确实够不着 —— 研究型任务不进 softwareEngineering 包、
//      不带 mission 账本,所以这一层是那种会话唯一的载体(这条一红 = 有人把规则挪回那两处了);
//   V5 文字是常量(不是模板函数、不含插值),跨进程逐字节恒定 —— 前缀缓存与 budget-guard 的前提。
const zhPack = srv.getPromptPack('zh-CN');
const enPack = srv.getPromptPack('en-US');
ok(typeof zhPack.answerShape === 'string' && typeof enPack.answerShape === 'string'
  && zhPack.answerShape.length > 20 && enPack.answerShape.length > 20,
  'V1 中英两包同一层都有 answerShape(结构对齐)');
ok(/结论/.test(zhPack.answerShape) && /第一段|首段|开头/.test(zhPack.answerShape),
  'V1b 中文规则含「结论」与「第一/首段」两个语义要素(容许润色)');
ok(/conclusion/i.test(enPack.answerShape) && /first paragraph|lead/i.test(enPack.answerShape),
  'V1c 英文规则是同义翻译(conclusion + first paragraph/lead),不是另写一条规则');
const answerShapeMark = zhPack.answerShape.slice(0, 12);
ok(stable.includes(answerShapeMark), 'V2 有工具的会话在稳定层拿到结论先行');
const stableNoTools = srv.buildStableSystemPrompt(provider, model, cwd, [], false);
ok(stableNoTools.includes(answerShapeMark),
  'V2b 纯对话(无工具)的会话【也】拿得到 —— 门控只有 !identityOnly,不看 hasTools(管家开的研究型线程就是这一种)');
ok(!stableIdOnly.includes(answerShapeMark), 'V3 identityOnly=true 不注入(压缩摘要/身份探针廉价)');
// V4:两个既有替代品对「分析英伟达」这种研究型任务确实够不着 —— 判据取自真实路由函数,不是推断。
const researchTask = '帮我分析一下英伟达最近的业绩和股价走势';
ok(srv.softwareEngineeringTaskProfile(researchTask).relevant === false
  && srv.buildSoftwareEngineeringPolicy(researchTask, { locale: 'zh-CN' }) === '',
  'V4 研究型任务不进 softwareEngineering 包(它那句「先给结果」够不到这种会话)');
const volatileNoMission = srv.buildVolatileParts(provider, tools, caps, config, '', [], [], null);
ok(!/任务账本/.test(volatileNoMission),
  'V4b 无 mission 账本时易变层无账本层(steward_thread_new 只竖 kind、不建账本,故 mission 层也够不到)');
ok(!/\$\{|（）/.test(zhPack.answerShape) && !/\$\{/.test(enPack.answerShape),
  'V5 规则是常量文字,不含模板插值(跨进程逐字节恒定,前缀缓存与 budget-guard 的前提)');

console.log('\nPROMPT SNAPSHOT STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
