require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(第 129 波 129b · 49 号文 §3):管家的三张「有哪些可选」只读清单。
//
// 补的是同一个形状的缺口 —— **管家能改的东西,它看不见清单,只能猜**:
//   · steward_skill_toggle 能整份替换一条线程的技能,却没有工具列得出技能注册表
//     (它自己的 schema 写着「不存在的 id 会被静默丢掉」);
//   · activeProvider / model / compactModel / asrModel 等八个键是 confirm 档可改,而 providers
//     在 forbidden 档读不到(清单与 apiKey 装在同一个对象里);
//   · steward_playbook_draft 能起草 playbook,用户问「有哪些预置流程」它答不上来。
//
// 本件的重头戏是 (B) 的【字段白名单】:掩码不是「删掉敏感字段」,是「只给名字写出来的那几个」。
// 前者的失败方向是「以后谁给 provider 加一个新字段,它就默认泄漏出去」;后者 fail-closed
// (与管家记忆导出字段白名单那把锁同一个模具 —— 那把锁已经按设计拦住过三次)。
//
// 覆盖:
//  (A) steward_skills:列得出、带 id 与可用性、q 能筛、坏 sessionId 当场 not_found、**绝对路径不出现**。
//  (B) steward_providers:key / baseUrl / audioBaseUrl / extraHeaders 一个字都不出现;hasKey 只给布尔;
//      hiddenModels 里的模型不列;active 回显;**字段白名单**(多一个字段就红)。
//  (C) steward_playbooks:列得出、描述非空(第一版把字段名写成 description 而非 desc,整列全空)、q 能筛。
//  (D) 三件都是 read 档、都进了管家的工具面(回环由 steward-tools.static ①/⑤ 钉,这里只钉「真调得动」)。
//
// 进程内直调 TOOL_HANDLERS(合成管家 ctx),零模型请求、零网络。
// 判定行:`STEWARD CATALOGS E2E: ALL PASS`。
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-catalogs-'));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// 密钥与地址用可识别的哨兵串,泄漏了一眼看得出是哪一样。
const KEY_SENTINEL = 'sk-NOT-A-REAL-CREDENTIAL-zzz111';
const URL_SENTINEL = 'http://127.0.0.1:9/fence-only-base-url';
const AUDIO_SENTINEL = 'http://127.0.0.1:9/fence-only-audio-url';
const HEADER_SENTINEL = 'NOT-A-REAL-HEADER-VALUE';

fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [], subagentMaxPerTurn: 0,
  stewardEnabledV1: true, stewardPollMs: 120000,
  activeProvider: 'alpha', model: 'alpha-pro',
  providers: [
    {
      id: 'alpha', label: 'Alpha 端点', type: 'openai-compat',
      baseUrl: URL_SENTINEL, apiKey: KEY_SENTINEL, audioBaseUrl: AUDIO_SENTINEL,
      extraHeaders: { 'x-secret': HEADER_SENTINEL },
      models: [
        { id: 'alpha-pro', label: 'Alpha Pro' },
        { id: 'alpha-voice', label: 'Alpha Voice', caps: ['asr'] },
        { id: 'alpha-retired', label: 'Alpha Retired' },
      ],
      hiddenModels: ['alpha-retired'],
    },
    { id: 'beta', label: 'Beta 没配密钥', type: 'openai-compat', baseUrl: URL_SENTINEL, apiKey: '', models: [] },
  ],
}, null, 2), 'utf8');
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

const stewardCtx = { session: { id: 'steward', kind: 'steward', providerHistory: [] } };
const call = (name, args) => srv.toolCall(name, args || {}, stewardCtx);

/* ═════════ (A) steward_skills ═════════ */
console.log('── (A) 技能注册表 ──');
let anySkillId = '';
{
  const r = await call('steward_skills');
  ok(r && r.ok === true && Array.isArray(r.skills), 'A1 列得出技能(稳定信封 {ok,total,skills})');
  ok(r.skills.length > 0 && r.skills.every(s => s.id && s.name), 'A2 每条都带 id 与名字(id 就是 steward_skill_toggle 要的那个)');
  anySkillId = r.skills[0] ? r.skills[0].id : '';
  ok(r.skills.every(s => typeof s.available === 'boolean'), 'A3 每条都说得出现在能不能用');
  const dumped = JSON.stringify(r);
  ok(!/[A-Za-z]:\\\\|[A-Za-z]:\//.test(dumped) && !dumped.includes('SKILL.md'),
    'A4 清单里【不出现】技能目录的绝对路径(管家要的是「有哪些」,不是「在哪个文件夹」)');
  ok(!('detail' in (r.skills[0] || {})), 'A5 不夹带技能正文(那是线程该读的东西,不是目录)');
}
{
  const r = await call('steward_skills', { q: anySkillId });
  ok(r && r.ok === true && r.skills.some(s => s.id === anySkillId), 'A6 q 能按 id 筛到那一条');
  const none = await call('steward_skills', { q: '这个关键词不可能命中任何技能' });
  ok(none && none.ok === true && none.total === 0, 'A7 筛不到就是空清单(不是报错)');
}
{
  const r = await call('steward_skills', { sessionId: 'sess_definitely_not_here' });
  ok(r && r.ok === false && r.error === 'not_found',
    `A8 坏 sessionId 当场 not_found(不静默回落到默认工作区 —— 那会让模型以为自己问的是那条线程;got ${r && r.error})`);
}
{
  // 项目技能跟着线程的工作目录走:给那条线程的 cwd 放一条项目技能,只有带上它的 sessionId 才看得到。
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-proj-'));
  const skillDir = path.join(projectDir, '.ruyi', 'skills', 'only-in-this-project');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: 只在这个项目里\ndescription: 项目级技能\n---\n正文\n', 'utf8');
  const session = await srv.createSession({ title: '项目线程', cwd: projectDir });
  const withSid = await call('steward_skills', { sessionId: session.id });
  const withoutSid = await call('steward_skills');
  ok(withSid.skills.some(s => s.id === 'only-in-this-project'),
    'A9 带 sessionId 时看得到那条线程目录下的项目技能');
  ok(!withoutSid.skills.some(s => s.id === 'only-in-this-project'),
    'A10 不带 sessionId 时看不到(它本来就只在那个目录里成立)');
  ok(withSid.sessionId === session.id, 'A11 回显问的是哪条线程(模型能确认自己问对了)');
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
}

/* ═════════ (B) steward_providers ═════════ */
console.log('── (B) 端点与模型目录(掩码) ──');
{
  const r = await call('steward_providers');
  const dumped = JSON.stringify(r);
  ok(r && r.ok === true && Array.isArray(r.providers) && r.providers.length === 2, 'B1 两个端点都列出来了');
  for (const [what, sentinel] of [['密钥', KEY_SENTINEL], ['baseUrl', URL_SENTINEL], ['audioBaseUrl', AUDIO_SENTINEL], ['自定义请求头', HEADER_SENTINEL]]) {
    ok(!dumped.includes(sentinel), `B2-${what} 一个字都不出现在回包里`);
  }
  ok(!/apiKey|baseUrl|extraHeaders|audioBaseUrl/.test(dumped), 'B3 连【字段名】都不出现(不暗示它存在、也不暗示形状)');
  const alpha = r.providers.find(p => p.id === 'alpha');
  const beta = r.providers.find(p => p.id === 'beta');
  ok(alpha && alpha.hasKey === true && beta && beta.hasKey === false,
    'B4 配没配密钥只给布尔(「这个端点还没配」是管家该说得出的一句有用的话)');
  ok(alpha && alpha.models.some(m => m.id === 'alpha-pro') && alpha.models.some(m => m.id === 'alpha-voice'),
    'B5 模型清单在(这才是它改 model/asrModel 之前要看的那份)');
  ok(alpha && !alpha.models.some(m => m.id === 'alpha-retired'),
    'B6 用户在菜单里删掉的模型(hiddenModels)不列 —— 列了等于把删掉的又还回来');
  const voice = alpha.models.find(m => m.id === 'alpha-voice');
  ok(voice && Array.isArray(voice.caps) && voice.caps.includes('asr'),
    'B7 模型能力标签原样转述(asr:这条能拿来做语音识别)');
  ok(r.active && r.active.provider === 'alpha' && r.active.model === 'alpha-pro',
    'B8 回显现在用的是哪个(省一次 steward_config_get 往返)');
  // ── 字段白名单:掩码是「只给写出来的那几个」,不是「删掉敏感的那几个」──────────────────
  // 反向方向:以后谁给 provider 加一个新字段,这一条会红,逼他回来表态该不该给管家看。
  const PROVIDER_FIELDS = new Set(['id', 'label', 'type', 'hasKey', 'models']);
  const MODEL_FIELDS = new Set(['id', 'label', 'caps']);
  const extraProvider = [];
  const extraModel = [];
  for (const p of r.providers) {
    for (const k of Object.keys(p)) if (!PROVIDER_FIELDS.has(k)) extraProvider.push(k);
    for (const m of p.models) for (const k of Object.keys(m)) if (!MODEL_FIELDS.has(k)) extraModel.push(k);
  }
  ok(extraProvider.length === 0, `B9 端点只给白名单里那几个字段${extraProvider.length ? ' → 多出: ' + [...new Set(extraProvider)].join(',') : ''}`);
  ok(extraModel.length === 0, `B9b 模型只给白名单里那几个字段${extraModel.length ? ' → 多出: ' + [...new Set(extraModel)].join(',') : ''}`);
}

/* ═════════ (C) steward_playbooks ═════════ */
console.log('── (C) 预置流程清单 ──');
{
  const r = await call('steward_playbooks');
  ok(r && r.ok === true && Array.isArray(r.playbooks) && r.playbooks.length > 0, 'C1 列得出 playbook');
  ok(r.playbooks.every(p => p.id && p.title), 'C2 每条都带 id 与标题');
  // 第一版把字段名写成 description(真实字段是 desc),整列全空 —— 冒烟时捞出来的,钉住它。
  ok(r.playbooks.some(p => String(p.description || '').trim().length > 0),
    'C3 描述【不是空的】(字段名写错时整列会空,而清单本身仍然「有 16 条」看着像对的)');
  ok(r.playbooks.every(p => typeof p.available === 'boolean'), 'C4 每条都说得出现在能不能用');
  const dumped = JSON.stringify(r);
  ok(!/[A-Za-z]:\\\\|promptTemplate/.test(dumped), 'C5 不夹带模板正文与文件路径(管家只负责建议,执行在用户手里)');
  const first = r.playbooks[0].id;
  const filtered = await call('steward_playbooks', { q: first });
  ok(filtered.playbooks.some(p => p.id === first), 'C6 q 能筛');
}

/* ═════════ (D) 档位与可调用性 ═════════ */
console.log('── (D) 档位 ──');
{
  // 三件都必须是 read 档:它们只读如意自己的状态。归成 edit/exec 会让「智能自动」以外的线程
  // 平白多一道确认,归错档比少一个工具更难发现。
  for (const name of ['steward_skills', 'steward_providers', 'steward_playbooks']) {
    ok(srv.NATIVE_TOOL_TIER[name] === 'read', `D1-${name} 是 read 档(got ${srv.NATIVE_TOOL_TIER[name]})`);
  }
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* Windows 句柄未放开时留给系统清 */ }
console.log(fail === 0 ? 'STEWARD CATALOGS E2E: ALL PASS' : `STEWARD CATALOGS E2E: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
})();
