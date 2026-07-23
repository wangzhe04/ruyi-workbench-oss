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
ok(/tool_search/.test(full) && /按需装载/.test(full), 'L2 工具协议:tool_search 按需装载');
ok(/工具选用优先级/.test(full), 'L2 工具协议:选用优先级(现成工具优先,终端兜底)');
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
ok(/本地 AI 工作台/.test(stable) && /先读后改/.test(stable), 'D1 stable 含身份+工具协议(稳定层)');
ok(!/当前能力/.test(stable) && !/桌面操控/.test(stable) && !/<skill-index>/.test(stable) && !/任务账本/.test(stable), 'D2 stable 不含 volatile 标记(能力/桌面/技能/账本)');
ok(stable.length < 800, 'D3 stable 长度 < 800(稳定层轻量,身份+工具协议+provider,got ' + stable.length + ')');
// buildVolatileParts 含 volatile 标记
const volatile = srv.buildVolatileParts(provider, tools, caps, config, '', skillEntries, [], null);
ok(/当前能力/.test(volatile) && /在线/.test(volatile), 'D4 volatile 含能力层');
ok(/<skill-index>/.test(volatile), 'D5 volatile 含技能索引围栏');
ok(volatile.length > 100 && volatile.length < 5000, 'D6 volatile 长度合理(got ' + volatile.length + ')');
// 向后兼容:buildProviderSystemPrompt(包装) = stable + volatile(文本不变)
ok(full.length >= stable.length + volatile.length - 5, 'D7 包装=stable+volatile(向后兼容,full ' + full.length + ' >= stable ' + stable.length + ' + volatile ' + volatile.length + ')');

console.log('\nPROMPT SNAPSHOT STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
