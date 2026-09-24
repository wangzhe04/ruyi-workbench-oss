#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(require server.js 只读不写真机配置,仍照纪律装上)

// 145-W3 静态/单元件:按引擎的「如意运行环境说明」(06 buildEngineEnvBrief,文字在 06b engineBrief)。
//
// 用户 2026-09-24:「根据不同引擎的线程设计不同的提示词,让 claude code 知道它是在如意工作台中、有什么能力」。
// 修前只有 provider 引擎有「你在如意里」的说明,Claude/Kimi 只有零散提示。本件钉住:
//   A  Claude 变体:引擎专属标记(Claude Code / 原生工具名 / CLAUDE.md 原生读取 / mcp__win-claude-workbench__ 前缀 /
//      request_user_input 与交互模式禁原生 AskUserQuestion)+ 能力事实(桌面开/关两组、终端 rg 来源、mermaid 成图、
//      权限档含义、管家代开);只提 orchestrate_agents,绝不出现 spawn_agent;中文 ≤ 1800 字;
//      文字里没有 % 与 !(claude.cmd 启动时整段过 cmd.exe),除自身围栏外没有尖括号标签(fenceSafeSlice 会当悬空围栏切)。
//   B  Kimi 变体:Kimi Code / 原生 AskUserQuestion 落到如意提问卡 / Bash 由如意代执行;不提 CLAUDE.md 与 request_user_input。
//   C  provider 变体:不重复身份层 —— 稳定层只多 mermaid 成图一句(且无 Claude/Workbench 字样,身份泄漏守卫),
//      易变层补权限档/提问弹窗/管家代开,rg 并进既有能力行(「终端里也可直接用 rg」)。
//   D  缓存纪律:同一能力集两次装配逐字节相同、指纹相同;能力集之外的东西(模型名、会话 id、cwd)变了不影响;
//      能力集里的东西(桌面、rg、权限档、管家代开)变了指纹就变。
//   E  英文包同构。
//   F  接线:runClaudeTurn 在用户 append 之后、四层协议之前注入(无条件前缀,降级从尾部切);
//      并进这段的两句旧提示(request_user_input / 自适应工具加载)不再重复注入。
//   G  rg:服务进程启动时已把随包 vendor-bin 前置进 PATH;probeRgAsync 报出来源与 shell 位。
//
// 判定行:`ENGINE ENV BRIEF STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const srv = require(SERVER);
const pkgVersion = String(require(path.join(ROOT, 'ruyi-workbench', 'package.json')).version || '');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};
const tagsOf = text => [...String(text).matchAll(/<\/?[a-zA-Z][a-zA-Z0-9-]*>/g)].map(m => m[0]);

const baseConfig = (extra = {}) => ({
  locale: 'zh-CN', includeWorkbenchMcp: true, engineMode: 'interactive', toolLoadingMode: 'auto',
  permissionMode: 'default', subagentMaxPerTurn: 4, allowDesktopTools: true, desktopMcp: { enabled: true }, ...extra,
});
const RG_BUNDLED = { path: 'C:\\x\\vendor-bin\\rg.exe', source: 'bundled', shell: 'bundled' };
const brief = (engine, config, session, rg) => srv.buildEngineEnvBrief({ engine, config, session, rg });

(async () => {
  ok(typeof srv.buildEngineEnvBrief === 'function' && typeof srv.resolveEngineEnvBrief === 'function'
    && typeof srv.probeRgAsync === 'function' && typeof srv.peekRgProbe === 'function', 'A0 导出面齐(buildEngineEnvBrief / resolveEngineEnvBrief / probeRgAsync / peekRgProbe)');

  /* ═══════════ A Claude 变体 ═══════════ */
  const claudeOn = brief('claude', baseConfig(), { id: 'sess_a', createdBy: 'steward' }, RG_BUNDLED);
  const cOn = claudeOn.text;
  ok(cOn.startsWith('<ruyi-environment>\n') && cOn.endsWith('\n</ruyi-environment>'), 'A1 Claude 版是整段 <ruyi-environment> 围栏');
  ok(cOn.includes('Claude Code') && cOn.includes('如意 Ruyi') && pkgVersion && cOn.includes('v' + pkgVersion),
    'A2 身份:担任线程引擎的 Claude Code + 产品名 + 版本 v' + pkgVersion);
  ok(/Read、Edit、Write、Bash、Grep、Glob、Agent/.test(cOn) && cOn.includes('CLAUDE.md') && /原生方式读取/.test(cOn),
    'A3 原生工具分工 + CLAUDE.md 由 CLI 原生读取');
  ok(cOn.includes('mcp__win-claude-workbench__') && ['workbench_memory_propose', 'request_user_input', 'tool_search', 'tool_invoke_exec', 'orchestrate_agents', 'workbench_self_status'].every(n => cOn.includes(n)),
    'A4 如意 MCP 工具按组列名(真实前缀 mcp__win-claude-workbench__)');
  ok(/不要用原生 AskUserQuestion/.test(cOn), 'A5 交互模式:提问走 request_user_input,禁原生 AskUserQuestion(与 --disallowedTools 一致)');
  ok(!/spawn_agent/.test(cOn), 'A6 只提 orchestrate_agents,不出现 spawn_agent(W1 正在退役它)');
  ok(/桌面控制：已开启/.test(cOn) && !/桌面控制：未开启/.test(cOn), 'A7 桌面开:如实写已开启');
  ok(/ripgrep 可用（如意随包自带/.test(cOn) && /直接用 rg/.test(cOn), 'A8 终端 rg:随包来源 + 可直接用 rg');
  ok(cOn.includes('```mermaid') && /画成图/.test(cOn), 'A9 界面渲染:mermaid 代码块画成图');
  ok(/「每步都问」模式/.test(cOn) && /不要换工具或换写法绕过去/.test(cOn), 'A10 权限档含义 + 拒绝不可绕过');
  ok(/管家会看着各条线程/.test(cOn) && /这条线程是管家替用户开的/.test(cOn), 'A11 管家看管 + 管家代开(createdBy=steward)时补一句交付会被转述');
  ok(cOn.length <= 1800, 'A12 中文 Claude 版 ≤ 1800 字(实 ' + cOn.length + ')');
  ok(!/[%!]/.test(cOn), 'A13 没有 % 与 !(claude.cmd 经 cmd.exe 展开)');
  ok(tagsOf(cOn).join(',') === '<ruyi-environment>,</ruyi-environment>', 'A14 除自身围栏外没有尖括号标签(' + tagsOf(cOn).join(',') + ')');

  const claudeOff = brief('claude', baseConfig({ desktopMcp: { enabled: false } }), { id: 'sess_b' }, null);
  const cOff = claudeOff.text;
  ok(/桌面控制：未开启/.test(cOff) && !/桌面控制：已开启/.test(cOff), 'A15 桌面关(desktopMcp.enabled=false):如实写未开启');
  ok(/没有可用的 ripgrep/.test(cOff) && !/直接用 rg/.test(cOff), 'A16 无 rg:告诉模型别在命令行调用 rg');
  ok(!/这条线程是管家替用户开的/.test(cOff), 'A17 不是管家开的线程:不补管家代开那句');
  const deskSessionOff = brief('claude', baseConfig(), { id: 'sess_c', desktopTools: false }, RG_BUNDLED).text;
  ok(/桌面控制：未开启/.test(deskSessionOff), 'A18 会话级桌面覆盖(session.desktopTools=false)压过全局开关');
  const printMode = brief('claude', baseConfig({ engineMode: 'print' }), {}, RG_BUNDLED).text;
  ok(printMode.includes('request_user_input') && !/不要用原生 AskUserQuestion/.test(printMode), 'A19 非交互模式不写「禁原生 AskUserQuestion」(那条 --disallowedTools 只在交互模式加)');
  const noMcp = brief('claude', baseConfig({ includeWorkbenchMcp: false }), {}, RG_BUNDLED).text;
  ok(!noMcp.includes('mcp__win-claude-workbench__') && noMcp.includes('Claude Code'), 'A20 没接如意 MCP 时不列 MCP 工具(不许许诺不存在的工具)');
  const noOrch = brief('claude', baseConfig({ subagentMaxPerTurn: 0 }), {}, RG_BUNDLED).text;
  ok(!noOrch.includes('orchestrate_agents'), 'A21 编排关(subagentMaxPerTurn=0)时不提 orchestrate_agents');
  const modes = ['default', 'acceptEdits', 'plan', 'auto', 'bypass'];
  const modeTexts = modes.map(m => brief('claude', baseConfig({ permissionMode: m }), {}, RG_BUNDLED).text);
  ok(new Set(modeTexts).size === modes.length && modeTexts.every(t => /权限：当前是「[^」]+」模式/.test(t)), 'A22 五个权限档各有自己的含义句');

  /* ═══════════ B Kimi 变体 ═══════════ */
  const kimi = brief('kimi', baseConfig(), { id: 'sess_k' }, { path: 'x', source: 'system', shell: 'system' }).text;
  ok(kimi.includes('Kimi Code') && !kimi.includes('Claude Code'), 'B1 Kimi 版身份是 Kimi Code');
  ok(/用原生 AskUserQuestion，如意界面会弹出提问卡/.test(kimi) && !kimi.includes('request_user_input'), 'B2 Kimi 提问走原生 AskUserQuestion(经 ACP 落到如意提问卡),不提 request_user_input');
  ok(/Bash 命令由如意代为执行/.test(kimi) && !kimi.includes('CLAUDE.md'), 'B3 Kimi 原生 Bash 由如意代执行;不提 CLAUDE.md');
  ok(/ripgrep 可用（本机已安装）/.test(kimi) && kimi.includes('mcp__win-claude-workbench__') && kimi.includes('```mermaid'), 'B4 Kimi 版同样带能力事实(系统 rg / 如意 MCP / mermaid)');
  ok(kimi.length <= 1800 && !/[%!]/.test(kimi), 'B5 中文 Kimi 版 ≤ 1800 字且无 % !(实 ' + kimi.length + ')');

  /* ═══════════ C provider 变体 ═══════════ */
  const provider = { id: 'fake', label: 'Fake端点', model: 'fake-model' };
  const tools = [{ function: { name: 'file_read' } }, { function: { name: 'request_user_input' } }];
  const caps = { network: { online: true }, desktopMcp: { present: false, toolCount: 0 }, binaries: { rg: true, rgSource: 'bundled', rgShell: 'bundled' }, provider: { vision: false } };
  const pb = brief('provider', baseConfig(), { createdBy: 'steward' }, { shell: 'bundled' });
  ok(pb.text === '' && Array.isArray(pb.lines) && pb.lines.length >= 1, 'C1 provider 变体不出整段围栏(身份在稳定层),只给易变层几行');
  const stable = srv.buildStableSystemPrompt(provider, 'fake-model', 'C:\\proj', tools, false, baseConfig());
  ok(stable.includes('```mermaid') && !/Claude/i.test(stable) && !/Workbench/i.test(stable), 'C2 稳定层补 mermaid 成图一句,且无 Claude/Workbench 字样(身份泄漏守卫)');
  ok(!stable.includes('<ruyi-environment>') && !/权限：当前是/.test(stable), 'C3 稳定层不含易变事实(权限档等)');
  const vol = srv.buildVolatileParts(provider, tools, caps, baseConfig(), '', [], [], null, null, null, null, { session: { createdBy: 'steward' } });
  ok(/有 ripgrep 快搜（终端里也可直接用 rg）/.test(vol), 'C4 能力行说清终端里也能直接用 rg(rgShell=bundled)');
  ok(/权限：当前是「每步都问」模式/.test(vol) && /request_user_input：如意界面会弹出提问卡/.test(vol) && /这条线程是管家替用户开的/.test(vol),
    'C5 易变层:权限档 + 提问弹窗(工具在场) + 管家代开(envContext.session)');
  const volNoCtx = srv.buildVolatileParts(provider, [{ function: { name: 'file_read' } }], { ...caps, binaries: { rg: true, rgSource: 'env', rgShell: '' } }, baseConfig(), '', [], [], null);
  ok(!/管家替用户开的/.test(volNoCtx) && !/弹出提问卡/.test(volNoCtx) && /有 ripgrep 快搜。?/.test(volNoCtx) && !/终端里也可直接用 rg/.test(volNoCtx),
    'C6 不传会话/工具不在场/rg 只在 RUYI_RG_PATH(不进 PATH)时,对应几句都不出现');
  ok((vol.match(/本地 AI 工作台/g) || []).length === 0, 'C7 易变层不重复身份层(没有第二份「本地 AI 工作台」自我介绍)');

  /* ═══════════ D 缓存纪律 ═══════════ */
  const again = brief('claude', baseConfig(), { id: 'sess_a', createdBy: 'steward' }, RG_BUNDLED);
  ok(again.text === cOn && again.fingerprint === claudeOn.fingerprint, 'D1 同一能力集两次装配逐字节相同、指纹相同(' + claudeOn.fingerprint + ')');
  const otherTurn = brief('claude', baseConfig({ model: 'another-model', defaultWorkspace: 'D:\\elsewhere' }), { id: 'sess_zzz', createdBy: 'steward', title: 'x', turnSeq: 99 }, { ...RG_BUNDLED, path: 'D:\\other\\rg.exe', source: 'env' });
  ok(otherTurn.text === cOn && otherTurn.fingerprint === claudeOn.fingerprint, 'D2 能力集之外的东西(模型名/会话 id/cwd/rg 绝对路径)变了,文字逐字节不变');
  const flips = [
    ['桌面', brief('claude', baseConfig({ desktopMcp: { enabled: false } }), { createdBy: 'steward' }, RG_BUNDLED)],
    ['rg', brief('claude', baseConfig(), { createdBy: 'steward' }, null)],
    ['权限档', brief('claude', baseConfig({ permissionMode: 'plan' }), { createdBy: 'steward' }, RG_BUNDLED)],
    ['管家代开', brief('claude', baseConfig(), {}, RG_BUNDLED)],
    ['引擎', brief('kimi', baseConfig(), { createdBy: 'steward' }, RG_BUNDLED)],
  ];
  ok(flips.every(([, b]) => b.fingerprint !== claudeOn.fingerprint && b.text !== cOn), 'D3 能力集里任一项变了(桌面/rg/权限档/管家代开/引擎),指纹与文字都跟着变');
  const pbAgain = brief('provider', baseConfig(), { createdBy: 'steward' }, { shell: 'bundled' });
  ok(JSON.stringify(pbAgain.lines) === JSON.stringify(pb.lines) && pbAgain.fingerprint === pb.fingerprint, 'D4 provider 易变层几行同一能力集两次相同');
  ok(srv.buildStableSystemPrompt(provider, 'fake-model', 'C:\\proj', tools, false, baseConfig()) === stable, 'D5 provider 稳定层两次构建逐字节相同(prefix-cache)');

  /* ═══════════ E 英文包 ═══════════ */
  const en = brief('claude', baseConfig({ locale: 'en-US' }), { createdBy: 'steward' }, RG_BUNDLED).text;
  ok(en.startsWith('<ruyi-environment>') && /You are Claude Code/.test(en) && /mcp__win-claude-workbench__/.test(en) && /```mermaid/.test(en)
    && /Desktop control: enabled/.test(en) && /The steward opened this thread/.test(en) && !/spawn_agent/.test(en) && !/[%!]/.test(en)
    && tagsOf(en).length === 2, 'E1 英文 Claude 版同构(身份/MCP/mermaid/桌面/管家代开;无 spawn_agent、无 % !、只有自身围栏)');
  const enKimi = brief('kimi', baseConfig({ locale: 'en-US', desktopMcp: { enabled: false } }), {}, null).text;
  ok(/You are Kimi Code/.test(enKimi) && /native AskUserQuestion/.test(enKimi) && /Desktop control: disabled/.test(enKimi) && /no usable ripgrep/.test(enKimi), 'E2 英文 Kimi 版(原生提问/桌面关/无 rg)');

  /* ═══════════ F 接线(源码) ═══════════ */
  const src = fs.readFileSync(SERVER, 'utf8');
  const claudeStart = src.indexOf('async function runClaudeTurn(');
  const claudeEnd = src.indexOf('async function runOpenAiTurn(');
  const region = claudeStart >= 0 && claudeEnd > claudeStart ? src.slice(claudeStart, claudeEnd) : '';
  const codeOnly = region.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const iUser = codeOnly.indexOf("appendSys = String(config.appendSystemPrompt || '');");
  const iBrief = codeOnly.indexOf('if (envBrief && envBrief.text) appendSys +=');
  const iBatching = codeOnly.indexOf('toolProtocol.batching}`;');
  const iSection = codeOnly.indexOf('const sectionLimit =');
  ok(/await resolveEngineEnvBrief\(\{ engine: agentCliType, config, session \}\)/.test(codeOnly), 'F1 runClaudeTurn 经 resolveEngineEnvBrief 装配(按 agentCliType 出 Claude/Kimi 变体)');
  ok(iUser >= 0 && iBrief > iUser && iBatching > iBrief && iSection > iBrief, 'F2 注入位置:用户 append 之后、四层协议之前、sectionLimit 之前(无条件前缀,降级从尾部切)');
  ok(/if \(!envBrief && interactive && config\.includeWorkbenchMcp\)/.test(codeOnly) && /if \(!envBrief && config\.includeWorkbenchMcp && config\.toolLoadingMode === 'auto'\)/.test(codeOnly),
    'F3 并进环境说明的两句旧提示只在没有环境说明时(管家会话)才注入,不重复');
  ok(/session\.kind === 'steward' \? null/.test(codeOnly), 'F4 管家会话不拿这段(它有自己的整套身份)');
  ok(/envBrief: envBrief \? envBrief\.fingerprint : undefined/.test(codeOnly), 'F5 meta 事件带环境说明指纹(可观测)');
  ok(!/Win Claude Workbench/.test(src.slice(src.indexOf('function renderCliEnvBrief('), src.indexOf('function providerEnvLines('))), 'F6 装配器里不出现旧产品名');

  /* ═══════════ G rg:PATH 前置 + 来源探测 ═══════════ */
  const vendorDir = path.join(ROOT, 'ruyi-workbench', 'app', 'vendor-bin');
  const hasVendorRg = fs.existsSync(path.join(vendorDir, process.platform === 'win32' ? 'rg.exe' : 'rg'));
  const firstPath = String(process.env.PATH || '').split(path.delimiter)[0] || '';
  ok(!hasVendorRg || path.resolve(firstPath).toLowerCase() === path.resolve(vendorDir).toLowerCase(),
    'G1 require server.js 后进程 PATH 第一项就是随包 vendor-bin(子进程全继承;实 ' + firstPath + ')');
  const info = await srv.probeRgAsync();
  if (hasVendorRg && !String(process.env.RUYI_RG_PATH || '').trim()) {
    ok(info && info.source === 'bundled' && info.shell === 'bundled' && path.resolve(path.dirname(info.path)).toLowerCase() === path.resolve(vendorDir).toLowerCase(),
      'G2 随包 rg 在时:来源 bundled、shell 位 bundled、路径在 vendor-bin (' + JSON.stringify(info) + ')');
  } else {
    ok(info === null || ['env', 'bundled', 'system'].includes(info.source), 'G2 来源只会是 env/bundled/system 之一或 null (' + JSON.stringify(info) + ')');
  }
  ok(srv.peekRgProbe() === info, 'G3 探测结果进程级缓存(peek 不触发探测,拿到同一个对象)');
  const caps2 = await srv.getCapabilities(null, true).catch(() => null);
  ok(caps2 && caps2.binaries && typeof caps2.binaries.rg === 'boolean' && (caps2.binaries.rg ? typeof caps2.binaries.rgSource === 'string' : caps2.binaries.rgSource === null)
    && typeof caps2.binaries.rgShell === 'string', 'G4 能力矩阵 binaries 加法字段 rgSource/rgShell (' + JSON.stringify(caps2 && caps2.binaries) + ')');
  const boot = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '00-boot.js'), 'utf8');
  ok(/st\.isDirectory\(\) && !st\.isSymbolicLink\(\)/.test(boot) && !/USE_BUILTIN_RIPGREP\s*=/.test(src),
    'G5 只前置锚定的真目录(联接/符号链接不算),且不改 USE_BUILTIN_RIPGREP(Claude Code 自带 rg 行为不动)');

  console.log('');
  if (fail) { console.log(`ENGINE ENV BRIEF STATIC E2E: ${fail} FAILURE(S)`); process.exit(1); }
  console.log('ENGINE ENV BRIEF STATIC E2E: ALL PASS');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
