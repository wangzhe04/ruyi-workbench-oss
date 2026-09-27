// 01e-permission-modes.js - 架构还债批 3·B: 从 01-config.js 搬出的权限档表、三层权限解析与 Agent 角色归一(纯搬家,零行为变更)。
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypass'];
const AGENT_ROLE_PERMISSION_MODES = ['inherit', 'default', 'acceptEdits', 'dontAsk', 'bypass', 'plan', 'auto'];
// v1.4.3: Canonical mapping from workbench-internal mode names to Claude CLI mode names.
// 'bypass' -> 'bypassPermissions'; 'auto' is a CLI-native name (no alias needed).
// Used by BOTH the --permission-mode flag construction AND syncClaudeCliSettings (single source of truth).
const CLAUDE_PERMISSION_MODE_MAP = { bypass: 'bypassPermissions', default: 'default', acceptEdits: 'acceptEdits', plan: 'plan', auto: 'auto', dontAsk: 'dontAsk' };
// Accept these CLI-native names as aliases when loading config (so users / external tools that write
// 'bypassPermissions' directly into config.json are not silently reset to 'bypass').
const PERMISSION_MODE_ALIASES = { bypassPermissions: 'bypass' };
// 116-2a(27 号文 §8.6「任何地方切到全自动都要二次确认」):需要二次确认才能【切到】的档。
// 这是「服务端的那一半」——UI 弹窗是另一半,但服务端不能只信 UI:任何调用方(含脚本/管家/117 壳)
// 想把某条线程放到全自动,都必须显式带 confirm:true。收紧与清除不在此列(二次确认防的是「不知不觉
// 被放开」,不是防止用户收紧)。含 CLI 原生内部名 bypassPermissions,即使它不在 PERMISSION_MODES 里
// (白名单会先把它挡成 400)——名单按语义列全,不依赖另一张表的取值范围。
const PERMISSION_MODES_REQUIRING_CONFIRM = Object.freeze(['auto', 'bypass', 'bypassPermissions']);

// 116-2a(27 号文 §3.3「线程权限即管家边界」):权限档的三层解析。纯函数,零副作用,零 I/O。
// 优先级【固定】,高 → 低:
//   ① 请求级临时覆盖(第 78 波:交办确认卡为「这一单当前执行链」收紧,绝不回写任何持久化);
//   ② 会话级 session.permissionMode(116-2a 新增的会话头可选字段;不写 = 跟随全局,故没有「显式
//      等于全局」与「未设」之分的歧义 —— UI 的权限 chip 靠这个区分「这条线程自己定了档」与「跟着走」);
//   ③ 全局 config.permissionMode(§3.3「新线程用全局默认权限」)。
// 每一层都【只认 PERMISSION_MODES 白名单】,非法/缺失一律【静默】回落到下一层(与第 78 波的原语义
// 逐字一致:不报错、不回写、不影响其余层)。三层全空 → 'default'(normalizeConfig 已保证全局档合法,
// 这个兜底只在传了个裸对象/半截 config 的调用方身上生效)。
// 入参三项都既接受「对象」(读它的 .permissionMode)也接受「字符串」(就是档本身),这样测试可以直接
// 喂三个字符串,而 runSessionTurn 可以直接喂 body.permissionMode / session / config。
function permissionModeFrom(value) {
  if (value == null) return '';
  const raw = (typeof value === 'object') ? value.permissionMode : value;
  const mode = raw == null ? '' : String(raw);
  return PERMISSION_MODES.includes(mode) ? mode : '';
}
function resolvePermissionMode(input) {
  const src = (input && typeof input === 'object') ? input : {};
  return permissionModeFrom(src.request)
    || permissionModeFrom(src.session)
    || permissionModeFrom(src.config)
    || 'default';
}
const BUILTIN_AGENT_ROLES = Object.freeze([
  { id: 'explorer', label: 'Explorer', description: '快速探索代码、文档和现状，不修改文件。', prompt: '你是 Explorer。先建立准确的项目地图，查找相关文件、约束和风险；只读，不修改，不执行有副作用的操作。输出简洁、可引用的发现。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'blue' },
  { id: 'worker', label: 'Worker', description: '按明确任务实现改动并完成基础验证。', prompt: '你是 Worker。严格围绕交办任务实施，先理解现状再修改；保持改动聚焦，运行必要验证，最后报告改动、验证和遗留风险。', toolTier: 'exec', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: [], mcpServers: [], permissionMode: 'inherit', budgets: { openai: 100, claude: 100 }, color: 'green' },
  { id: 'coder', label: 'Coder', description: '面向代码实现、调试和测试闭环的工程角色。', prompt: '你是 Coder。负责把明确的软件任务落实为可验证的代码：先阅读相关实现、测试和项目约束，定位最小且完整的改动面；遵循现有架构与风格实施，不做无关重构；补充或更新能复现问题、证明行为的测试，运行与风险相称的检查。遇到失败先诊断根因并迭代修复，不把未验证的改动宣称为完成。最后报告修改、测试结果与仍存在的风险。', toolTier: 'exec', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: [], mcpServers: [], permissionMode: 'inherit', budgets: { openai: 150, claude: 150 }, color: 'green' },
  { id: 'reviewer', label: 'Reviewer', description: '独立审查实现的正确性、安全性和回归风险。', prompt: '你是 Reviewer。以证据为准独立审查，不代替实现者辩护。优先找会导致错误、数据损坏、安全问题和缺失测试的具体缺陷；给出文件位置和可执行建议。默认不改文件。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'orange' },
  { id: 'verifier', label: 'Verifier', description: '运行测试并核验结果，不擅自修改产品代码。', prompt: '你是 Verifier。根据验收标准运行测试、检查日志和产物，区分已验证事实与推断。不要修改产品代码；若失败，给出最小复现、实际结果和预期结果。', toolTier: 'exec', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'inherit', budgets: { openai: 100, claude: 100 }, color: 'purple' },
  // 第23波: 新增 5 个角色,覆盖「规划 → 研究 → 批判 → 综合 → 数据分析」的常见协作分工,并据此拓宽内置模板。
  { id: 'planner', label: 'Planner', description: '把复杂任务拆解为清晰的计划/设计，不实现。', prompt: '你是 Planner。把交办的复杂目标拆解成可执行的计划或设计：明确目标与非目标、硬约束、分步方案及其依赖顺序、每步的交付物与验收点、主要风险与应对。只规划不实现，也不执行有副作用的操作。输出结构化、可直接据以行动的计划。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'teal' },
  { id: 'researcher', label: 'Researcher', description: '联网检索并阅读来源，产出有来源支撑的发现。', prompt: '你是 Researcher。围绕问题联网检索、阅读来源，就每个子问题给出有来源支撑的发现：结论 + 来源(标题/URL) + 置信度，区分事实与观点，主动寻找反面证据。只记录有来源支撑的内容，查不到就如实说明，绝不编造来源或数据。只读不改。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'cyan' },
  { id: 'critic', label: 'Critic', description: '对抗式审查：主动找漏洞、反例和无据主张。', prompt: '你是 Critic（红队）。对交办的内容做对抗式审查：主动寻找漏洞、反例、未覆盖的场景、逻辑跳跃和无证据支撑的主张；默认怀疑，写不出具体触发/反例的疑点予以降级或剔除。区分「确证的问题」与「存疑」，给出可执行的反驳或修正建议。默认不改文件。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'red' },
  { id: 'synthesizer', label: 'Synthesizer', description: '把多个上游结果综合成连贯、结构化的成稿。', prompt: '你是 Synthesizer。把多个上游节点的结果综合成一份连贯、结构化的输出（报告/结论/文档）：合并重复、消解冲突、按主题组织、保留关键依据与出处。只依据上游【已确认】的内容，不引入未经核验的新主张；证据不足处如实标注。默认只产出文本，不改文件（需要落盘时按节点指派的工具面执行）。', toolTier: 'read', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob'], mcpServers: [], permissionMode: 'plan', budgets: { openai: 100, claude: 100 }, color: 'amber' },
  { id: 'analyst', label: 'Analyst', description: '分析数据/日志/指标，跑必要脚本，产出发现。', prompt: '你是 Analyst。对交办的数据、日志或指标做分析：必要时运行只读查询或脚本来统计、聚合、交叉验证；区分已验证的观察与推断，给出关键发现、异常点及其证据。不修改源数据；产出结论时说明口径与不确定性。', toolTier: 'exec', models: { openai: '', claude: 'inherit' }, openaiTools: [], claudeTools: ['Read', 'Grep', 'Glob', 'Bash'], mcpServers: [], permissionMode: 'inherit', budgets: { openai: 100, claude: 100 }, color: 'indigo' },
]);

function normalizeAgentRole(raw, opts = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || raw.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (!id) return null;
  const strArr = (value, max = 64) => [...new Set((Array.isArray(value) ? value : []).filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean))].slice(0, max);
  const models0 = raw.models && typeof raw.models === 'object' ? raw.models : {};
  const budgets0 = raw.budgets && typeof raw.budgets === 'object' ? raw.budgets : {};
  const permissionMode = AGENT_ROLE_PERMISSION_MODES.includes(raw.permissionMode) ? raw.permissionMode : 'inherit';
  const role = {
    id,
    label: String(raw.label || raw.name || id).trim().slice(0, 80) || id,
    description: String(raw.description || '').trim().slice(0, 500),
    prompt: String(raw.prompt || raw.systemPrompt || '').trim().slice(0, 8000),
    toolTier: ['read', 'edit', 'exec'].includes(raw.toolTier) ? raw.toolTier : 'read',
    models: {
      openai: String(models0.openai != null ? models0.openai : (raw.openaiModel || '')).trim().slice(0, 160),
      claude: String(models0.claude != null ? models0.claude : (raw.claudeModel || 'inherit')).trim().slice(0, 160) || 'inherit',
    },
    openaiTools: strArr(raw.openaiTools || (raw.tools && raw.driver !== 'claude' ? raw.tools : []), 128),
    claudeTools: strArr(raw.claudeTools || (raw.driver === 'claude' ? raw.tools : []), 128),
    mcpServers: strArr(raw.mcpServers, 32),
    permissionMode,
    budgets: {
      openai: Math.min(300, Math.max(1, Math.round(Number(budgets0.openai != null ? budgets0.openai : (raw.maxIters || 100))) || 100)),
      claude: Math.min(300, Math.max(1, Math.round(Number(budgets0.claude != null ? budgets0.claude : (raw.maxTurns || 100))) || 100)),
    },
    isolation: raw.isolation === 'worktree' ? 'worktree' : 'none',
    color: String(raw.color || '').trim().slice(0, 32),
  };
  if (opts.source) role.source = opts.source;
  if (opts.builtin) role.builtin = true;
  return role;
}
function mergeAgentRole(base, override, source) {
  const merged = normalizeAgentRole({ ...base, ...override, models: { ...(base.models || {}), ...(override.models || {}) }, budgets: { ...(base.budgets || {}), ...(override.budgets || {}) } }, { source: source || override.source || base.source, builtin: !!base.builtin });
  if (merged && base.builtin) merged.builtin = true;
  return merged;
}
