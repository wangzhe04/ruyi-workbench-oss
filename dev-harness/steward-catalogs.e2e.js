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
//  (E) 129h 按 playbook 办事:清单回答「有哪些可选」,这一段回答「拿它去办」——
//      查不到 / 跑不了 / 参数不齐各自回得对且【不开线程】,参数齐了真的开出来、正文带着填好的值
//      进了首条消息、行动流水看得出是按哪一个流程起的。纯函数那一半在 unit/steward-playbook-run.test.js。
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

/* ═════════ (E) 129h:按 playbook 办事(31 号文 §2.7 放①)═════════
   清单(C 段)只回答「有哪些可选」;这一段回答「拿它去办」。**有意不新加工具** ——
   「跑一个 playbook」= 按模板组装一段话 + 开一条线程,后半截早就在 steward_thread_new 里,
   带着工作区表、权限档、分档、事项、undoRef、决策账本一整套闸。所以它长在 brief.playbook 上。
   纯函数那一半(组装口径与前端逐字一致、缺参数、正文不被裁)在 unit/steward-playbook-run.test.js;
   这一段钉【真调用】那一半:查不到、不可用、参数不齐各自回得对,齐了真的开出线程并留痕。 */
console.log('── (E) 按 playbook 办事 ──');
{
  const pbDir = path.join(HOME, 'playbooks');
  fs.mkdirSync(pbDir, { recursive: true });
  fs.writeFileSync(path.join(pbDir, 'pbrun-ok.json'), JSON.stringify({
    id: 'pbrun-ok', title: '整理月度报表', desc: '把某个文件夹里某个月的表整理成一份汇总',
    inputs: [{ key: 'folder', label: '报表文件夹', type: 'folder' }, { key: 'month', label: '月份', type: 'text' }],
    promptTemplate: '请把 {folder} 里 {month} 的所有表格整理成一份汇总,列出每一项的金额与合计。完成后把文件名告诉我。',
  }), 'utf8');
  fs.writeFileSync(path.join(pbDir, 'pbrun-blocked.json'), JSON.stringify({
    // 用 vision 而不是 desktopMcp:夹具的判据必须【在夹具里成立】。第一版写的是 desktopMcp,
    // 而这台开发机真的装了桌面 MCP —— 那个 playbook 于是是【可用】的,三条断言一起红,
    // 红的理由是「对照组不成立」,不是「代码不对」。vision 看的是当前端点的模型有没有视觉能力,
    // 本夹具的 alpha-pro 没声明 caps,必然为假。
    id: 'pbrun-blocked', title: '要视觉模型才能跑的流程', desc: '需要视觉',
    requires: ['vision'], inputs: [], promptTemplate: '看一下这张图里写了什么。',
  }), 'utf8');

  const newThread = (playbook, extra) => call('steward_thread_new', {
    title: '跑一个 playbook',
    brief: { userText: '像上次那样再来一遍', ...(playbook ? { playbook } : {}), ...(extra || {}) },
  });

  const miss = await newThread({ id: 'pbrun-does-not-exist' });
  ok(miss && miss.ok === false && miss.error === 'not_found' && miss.reason === 'playbook_not_found',
    `E1 猜一个不存在的 id -> not_found(got ${miss && (miss.reason || miss.error)})`);

  const short = await newThread({ id: 'pbrun-ok', inputs: { folder: 'D:/报表' } });
  ok(short && short.error === 'invalid_request' && short.reason === 'playbook_inputs_missing',
    `E2 参数没给全 -> 不开线程(got ${short && (short.reason || short.error)})`);
  ok(short && Array.isArray(short.missing) && short.missing.length === 1
    && short.missing[0].key === 'month' && short.missing[0].label === '月份',
    `E2b 回执里点名缺哪一项、带人话标签(管家拿它去问用户,不是自己编;got ${short && JSON.stringify(short.missing)})`);

  const blank = await newThread({ id: 'pbrun-ok', inputs: { folder: 'D:/报表', month: '   ' } });
  ok(blank && blank.reason === 'playbook_inputs_missing',
    `E2c 只填空白也算没给(空串跑进模板 = 在错的地方动手;got ${blank && (blank.reason || blank.error)})`);

  const blocked = await newThread({ id: 'pbrun-blocked' });
  ok(blocked && blocked.error === 'invalid_request' && blocked.reason === 'playbook_unavailable',
    `E3 跑不了的 playbook -> 不开线程(got ${blocked && (blocked.reason || blocked.error)})`);
  ok(blocked && typeof blocked.message === 'string' && !/所需能力没就绪/.test(blocked.message),
    `E3b 说得出【真】原因,不是兜底那句(字段名是 unavailableReason 不是 reason;got ${blocked && blocked.message})`);
  ok(blocked && Array.isArray(blocked.missingCaps) && blocked.missingCaps.includes('vision'),
    `E3c 结构化地说缺哪个能力(got ${blocked && JSON.stringify(blocked.missingCaps)})`);

  const okRun = await newThread({ id: 'pbrun-ok', inputs: { folder: 'D:/报表', month: '9月' } });
  ok(okRun && okRun.ok === true && okRun.sessionId, `E4 参数齐了 -> 真的开出线程(got ${okRun && (okRun.error || okRun.sessionId)})`);
  ok(okRun && okRun.playbook && okRun.playbook.id === 'pbrun-ok' && okRun.playbook.chars > 0,
    `E4b 回执说清按的是哪一个、正文多长(got ${okRun && JSON.stringify(okRun.playbook)})`);

  if (okRun && okRun.sessionId) {
    const head = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', okRun.sessionId + '.json'), 'utf8'));
    ok(head.brief && head.brief.playbookId === 'pbrun-ok',
      `E5 落盘的委托书记着按的是哪一个(got ${head.brief && head.brief.playbookId})`);
    // 组装结果必须【真的】带着用户填的值进到线程的首条消息里 —— 单测钉的是拼接函数,
    // 这一条钉的是「那段话确实沿着 thread_new 这条路送出去了」。回合会因为端点是哨兵地址而失败,
    // 但用户消息在那之前就落盘了。
    let body = '';
    for (let i = 0; i < 100; i++) {
      try { body = fs.readFileSync(path.join(HOME, 'sessions', okRun.sessionId + '.messages.ndjson'), 'utf8'); } catch { body = ''; }
      if (body.includes('D:/报表')) break;
      await new Promise(r => setTimeout(r, 50));
    }
    ok(body.includes('D:/报表') && body.includes('9月'),
      'E6 填好参数的正文真的进了线程的首条消息(占位没留在那儿)');
    ok(!body.includes('{folder}') && !body.includes('{month}'),
      'E6b 占位符一个都没剩下(留着 = 线程会照着 {folder} 去找一个叫这个名字的目录)');
    ok(body.includes('像上次那样再来一遍'), 'E6c 用户原话仍然在里面(§3.5 铁律)');
  }

  const rows = fs.readFileSync(path.join(HOME, 'steward', 'decisions-v1.ndjson'), 'utf8')
    .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const row = rows.reverse().find(r => r.tool === 'steward_thread_new' && r.args && r.args.playbookId === 'pbrun-ok');
  ok(Boolean(row), 'E7 行动流水里看得出这一条是【按你存下的那个流程】起的,不是管家自己编的');
  ok(row && row.basis && row.basis.playbookId === 'pbrun-ok', `E7b 依据栏记着那个 id(got ${row && JSON.stringify(row.basis)})`);
  ok(rows.every(r => !(r.tool === 'steward_thread_new' && r.args && r.args.playbookId && r.args.playbookId !== 'pbrun-ok')),
    'E7c 被挡下的那三次零决策账本(没开线程就没有决定可记)');

  // 对照:不给 playbook 字段时,既有行为一个字节都不变。
  const plain = await call('steward_thread_new', { title: '普通一条', brief: { userText: '帮我看看这个' } });
  ok(plain && plain.ok === true && !plain.playbook, `E8 不给 playbook 时回执里没有那一格(既有行为不变;got ${plain && JSON.stringify(plain.playbook)})`);
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* Windows 句柄未放开时留给系统清 */ }
console.log(fail === 0 ? 'STEWARD CATALOGS E2E: ALL PASS' : `STEWARD CATALOGS E2E: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
})();
