'use strict';

// EC-D：技能、命令、Playbook 与记忆库领域。
import { state } from './state.js';
import { api } from './net.js';
import { $, el, escapeHtml, autoGrow, toast } from './util.js';
import { icon } from './icons.js';
import { t, tCount } from './i18n.js';
import { agentCliMeta } from './agent-cli-registry.js';

// 点选一条命令时往输入框里插什么。内置命令(随包 offline-toolkit)两种引擎都插展开后的任务模板:Claude Code 里
// 它们只以插件命令 `/offline-toolkit:<id>` 存在,而且只有跑过 install-workbench.ps1 装上插件才有;裸 `/<id>` 永远
// 解析不了(2026-10 走查实测:「no command with that name」)。用户自己的 ~/.claude/commands 只在认得它们的 Agent CLI
// (agent-cli-registry 的 claudeUserCommands:Claude Code 是,Kimi Code 不是)下插 `/name`,由 CLI 自己展开;其余插正文。
// unit/offline-plugin-bundle.test.js 钉着。
export function commandInsertionText(entry, providerMode, agentCliType) {
  const expand = providerMode || entry.source === 'builtin' || !agentCliMeta(agentCliType).claudeUserCommands;
  return expand ? (entry.prompt || entry.description || entry.name || '') : (entry.insert || ('/' + entry.id));
}

export function createSkillsMemoryDomain({
  apiErrText = error => String(error && error.message || error || ''),
  currentWorkspace = () => '',
  closeModal = () => {},
  openModal = () => {},
  buildModal = () => null,
  isProviderMode = () => false,
  currentAgentCliType = () => '',
  openPlaybookModal = () => {},
  renderMarkdown = text => String(text || ''),
  saveConfigPartial = async () => false,
  iconTextBtn = () => {},
} = {}) {
let skillRegistry = [];
let skillFiltered = [];
let skillIndex = 0;
// Built-in registry metadata ships with the offline toolkit in Chinese. Keep the server payload
// canonical and translate it at the UI boundary; user/project SKILL.md content is deliberately
// left untouched because it is authored content rather than product chrome.
const BUILTIN_SKILL_I18N_IDS = Object.freeze({
  'skill:api-debugger': 'apiDebugger',
  'skill:office-automation': 'officeAutomation',
  'skill:windows-control': 'windowsControl',
  'skill:code-simplifier': 'codeSimplifier',
  'skill:frontend-design-craft': 'frontendDesignCraft',
  'skill:feature-development': 'featureDevelopment',
  'skill:security-guidance': 'securityGuidance',
  'skill:commit-workflow': 'commitWorkflow',
  'skill:plugin-development': 'pluginDevelopment',
  'skill:devops-ci-local': 'devopsCiLocal',
  'skill:local-docs-context': 'localDocsContext',
  'skill:lsp-local-setup': 'lspLocalSetup',
  'skill:code-review-offline': 'codeReviewOffline',
  'skill:offline-packaging': 'offlinePackaging',
  'skill:browser-debug': 'browserDebug',
  'skill:claude-md-management': 'claudeMdManagement',
  'skill:document-workflow': 'documentWorkflow',
  'skill:spreadsheet-analysis': 'spreadsheetAnalysis',
  'skill:research-synthesis': 'researchSynthesis',
  'skill:structured-writing': 'structuredWriting',
  'command:api-probe': 'command.apiProbe',
  'command:claude-md-audit': 'command.claudeMdAudit',
  'command:commit-message': 'command.commitMessage',
  'command:dependency-inventory': 'command.dependencyInventory',
  'command:frontend-audit': 'command.frontendAudit',
  'command:offline-code-review': 'command.offlineCodeReview',
  'command:workbench-doctor': 'command.workbenchDoctor',
  'command:explain-project': 'command.explainProject',
  'command:fix-tests': 'command.fixTests',
  'command:test-changes': 'command.testChanges',
  'command:summarize-changes': 'command.summarizeChanges',
  'command:security-check': 'command.securityCheck',
  'command:release-checklist': 'command.releaseChecklist',
  'playbook:pb:pdf-summarize': 'playbook.pdfSummarize',
  'playbook:pb:weekly-report': 'playbook.weeklyReport',
  'playbook:pb:merge-excel': 'playbook.mergeExcel',
  'playbook:pb:desktop-open-app': 'playbook.desktopOpenApp',
  'playbook:pb:web-form-fill': 'playbook.webFormFill',
  'playbook:pb:ocr-scan': 'playbook.ocrScan',
  'playbook:pb:batch-rename': 'playbook.batchRename',
  'playbook:pb:archive-by-content': 'playbook.archiveByContent',
  'playbook:pb:clean-downloads': 'playbook.cleanDownloads',
  'playbook:pb:folder-inventory': 'playbook.folderInventory',
  'playbook:pb:compare-documents': 'playbook.compareDocuments',
  'playbook:pb:meeting-minutes': 'playbook.meetingMinutes',
  'playbook:pb:clean-csv': 'playbook.cleanCsv',
  'playbook:pb:translate-document': 'playbook.translateDocument',
  'playbook:pb:presentation-outline': 'playbook.presentationOutline',
  'playbook:pb:scheduled-digest': 'playbook.scheduledDigest',
});
const BUILTIN_SKILL_AVAILABILITY_I18N_KEYS = Object.freeze({
  '需要联网(当前离线)': 'skills.requirements.networkOffline',
  '需要桌面控制(未检测到 ai-computer-control)': 'skills.requirements.desktopControl',
  '需要视觉模型(当前引擎未开启视觉)': 'skills.requirements.vision',
});
const BUILTIN_PLAYBOOK_INPUT_I18N_KEYS = Object.freeze({
  'archive-by-content:folder': 'skills.playbook.inputs.archiveByContent.folder',
  'batch-rename:folder': 'skills.playbook.inputs.batchRename.folder',
  'batch-rename:rule': 'skills.playbook.inputs.batchRename.rule',
  'clean-downloads:folder': 'skills.playbook.inputs.cleanDownloads.folder',
  'desktop-open-app:app': 'skills.playbook.inputs.desktopOpenApp.app',
  'desktop-open-app:goal': 'skills.playbook.inputs.desktopOpenApp.goal',
  'folder-inventory:folder': 'skills.playbook.inputs.folderInventory.folder',
  'folder-inventory:output': 'skills.playbook.inputs.folderInventory.output',
  'merge-excel:folder': 'skills.playbook.inputs.mergeExcel.folder',
  'merge-excel:output': 'skills.playbook.inputs.mergeExcel.output',
  'ocr-scan:folder': 'skills.playbook.inputs.ocrScan.folder',
  'ocr-scan:output': 'skills.playbook.inputs.ocrScan.output',
  'pdf-summarize:folder': 'skills.playbook.inputs.pdfSummarize.folder',
  'pdf-summarize:output': 'skills.playbook.inputs.pdfSummarize.output',
  'web-form-fill:url': 'skills.playbook.inputs.webFormFill.url',
  'web-form-fill:fields': 'skills.playbook.inputs.webFormFill.fields',
  'weekly-report:notes': 'skills.playbook.inputs.weeklyReport.notes',
  'weekly-report:output': 'skills.playbook.inputs.weeklyReport.output',
  'compare-documents:fileA': 'skills.playbook.inputs.compareDocuments.fileA',
  'compare-documents:fileB': 'skills.playbook.inputs.compareDocuments.fileB',
  'compare-documents:output': 'skills.playbook.inputs.compareDocuments.output',
  'meeting-minutes:notes': 'skills.playbook.inputs.meetingMinutes.notes',
  'meeting-minutes:output': 'skills.playbook.inputs.meetingMinutes.output',
  'clean-csv:file': 'skills.playbook.inputs.cleanCsv.file',
  'clean-csv:rules': 'skills.playbook.inputs.cleanCsv.rules',
  'clean-csv:output': 'skills.playbook.inputs.cleanCsv.output',
  'translate-document:file': 'skills.playbook.inputs.translateDocument.file',
  'translate-document:language': 'skills.playbook.inputs.translateDocument.language',
  'translate-document:output': 'skills.playbook.inputs.translateDocument.output',
  'presentation-outline:topic': 'skills.playbook.inputs.presentationOutline.topic',
  'presentation-outline:materials': 'skills.playbook.inputs.presentationOutline.materials',
  'presentation-outline:output': 'skills.playbook.inputs.presentationOutline.output',
  'scheduled-digest:folder': 'skills.playbook.inputs.scheduledDigest.folder',
  'scheduled-digest:output': 'skills.playbook.inputs.scheduledDigest.output',
});
function builtinSkillTextKey(entry, field) {
  if (!entry || entry.source !== 'builtin') return '';
  const id = BUILTIN_SKILL_I18N_IDS[`${entry.kind}:${entry.id}`];
  return id ? `skills.builtin.${id}.${field}` : '';
}
function skillDisplayText(entry, field) {
  const raw = String(entry?.[field] || '');
  const key = builtinSkillTextKey(entry, field);
  return key ? t(key) : raw;
}
function skillDisplayName(entry) {
  return skillDisplayText(entry, 'name') || String(entry?.id || '');
}
function skillDisplayDescription(entry) {
  return skillDisplayText(entry, 'description');
}
function skillDisplaySource(entry) {
  // W2 迁移中心:其它 Agent CLI 的技能同样活读进来,来源标签要看得见(codex / kimi / Claude Code 插件)。
  const key = ({ project: 'skills.source.project', user: 'skills.source.user', builtin: 'skills.source.builtin', 'claude-code': 'skills.source.claude-code',
    codex: 'skills.source.codex', kimi: 'skills.source.kimi', 'claude-plugin': 'skills.source.claude-plugin' })[entry?.source];
  // W8:经迁移中心「复制到如意」的技能已归如意所有(source=user),只多一句「复制自 …」说明出处。
  const from = entry?.source === 'user' ? ({ 'claude-code': 'skills.source.claude-code', codex: 'skills.source.codex', kimi: 'skills.source.kimi',
    'claude-plugin': 'skills.source.claude-plugin' })[entry?.copiedFrom] : '';
  if (from) return t('skills.source.copiedFrom', { source: t(from) });
  return key ? t(key) : t('common.unknown');
}
function skillDisplayUnavailableReason(entry) {
  const raw = String(entry?.unavailableReason || '');
  return BUILTIN_SKILL_AVAILABILITY_I18N_KEYS[raw] ? t(BUILTIN_SKILL_AVAILABILITY_I18N_KEYS[raw]) : raw;
}
function builtinPlaybookTextKey(playbook, field) {
  if (!playbook?.builtin) return '';
  const id = BUILTIN_SKILL_I18N_IDS[`playbook:pb:${playbook.id}`];
  return id ? `skills.builtin.${id}.${field}` : '';
}
function playbookDisplayText(playbook, field) {
  const raw = String(playbook?.[field] || '');
  const key = builtinPlaybookTextKey(playbook, field === 'title' ? 'name' : 'description');
  return key ? t(key) : raw;
}
function playbookDisplayName(playbook) {
  return playbookDisplayText(playbook, 'title') || String(playbook?.id || '');
}
function playbookDisplayDescription(playbook) {
  return playbookDisplayText(playbook, 'desc');
}
function playbookDisplayUnavailableReason(playbook) {
  const raw = String(playbook?.unavailableReason || '');
  return BUILTIN_SKILL_AVAILABILITY_I18N_KEYS[raw] ? t(BUILTIN_SKILL_AVAILABILITY_I18N_KEYS[raw]) : raw;
}
// 127-⑧ A-F01(41 号文 §5.9):服务状态一句话 —— 未知就说未知,绝不经文案升级成「可用」。
// available → ''(不建节点,可用卡逐字节不变);needs_config/unknown 各一句;unavailable 今天只由离线产生
// (06 evalPlaybookAvailability),缺的是 network 就给离线降级文案,否则回落那条原因。缺 status 也当未知。
function playbookStatusText(entry) {
  const status = entry?.status;
  if (status === 'available') return '';
  if (status === 'needs_config') return t('skills.status.needsConfig');
  if (status !== 'unavailable') return t('skills.status.unknown');
  const caps = Array.isArray(entry.missingCaps) ? entry.missingCaps : (Array.isArray(entry.requires) ? entry.requires : []);
  return caps.includes('network') ? t('skills.status.offline') : (playbookDisplayUnavailableReason(entry) || t('skills.unavailable'));
}
function playbookInputLabel(pb, input) {
  const raw = String(input?.label || input?.key || '');
  if (!pb?.builtin) return raw;
  const key = BUILTIN_PLAYBOOK_INPUT_I18N_KEYS[`${pb.id}:${input?.key}`];
  return key ? t(key) : raw;
}
function skillMatchesQuery(entry, query) {
  if (!query) return true;
  const fields = [skillDisplayName(entry), skillDisplayDescription(entry), entry?.name, entry?.description, entry?.id];
  return fields.some(value => String(value || '').toLowerCase().includes(query));
}
// P3-5: 技能开关串行化 —— 模块级单飞 promise 链(并发点击按序落盘,避免读改写竞态覆盖)+ 在途 id 集合(禁用对应行开关)。
let skillToggleChain = Promise.resolve();
const skillTogglePending = new Set();
// P2-2: session.skills 元素为 {id, source}(或旧裸字符串);统一取出 id 列表。
function enabledSkillIds() {
  const arr = (state.currentSession && Array.isArray(state.currentSession.skills)) ? state.currentSession.skills : [];
  return arr.map(x => (typeof x === 'string' ? x : (x && x.id))).filter(Boolean);
}
function residentSkillEntries() {
  return Array.isArray(state.config && state.config.residentSkills) ? state.config.residentSkills : [];
}
function residentSkillIds() {
  return residentSkillEntries().map(x => (typeof x === 'string' ? x : (x && x.id))).filter(Boolean);
}
// 重拉 /api/skills 进注册表并返回它(失败照抛:技能库弹窗自己兜成空表,设置页「技能与模板」要把失败说出来)。
async function refreshSkillRegistry() {
  skillRegistry = (await api('/api/skills?cwd=' + encodeURIComponent(currentWorkspace() || ''))).skills || [];
  return skillRegistry;
}
async function openSkillPanel() {
  openModal('skillModal');
  const s = $('skillSearch'); s.value = ''; skillIndex = 0; s.focus();
  $('skillList').innerHTML = `<div class="muted">${escapeHtml(t('skills.loading'))}</div>`;
  // 每次打开都刷新:项目级技能随 cwd 变、可用性随能力矩阵变、启用状态随会话变。cwd 传当前会话工作目录。
  try { await refreshSkillRegistry(); }
  catch { skillRegistry = []; }
  renderSkillList();
}
// ── 127-A-S02(41 号文 §5.9「将自然语言与既有模板入口接通」):技能库搜索框兼做服务入口 ——
// 查询命中六类服务时,列表顶部给一条服务条(可用数 / 一次配置引导 / 暂无模板)。不常驻、
// 无匹配不建节点(① 模具);「≤1 次引导」的硬顶在后端 matchServiceEntry,这里只渲染结论。
let svcMatchCache = { query: '', match: null };
let svcMatchTimer = 0;
function scheduleServiceMatch(q) {
  if (svcMatchCache.query === q) return;
  svcMatchCache = { query: q, match: null };
  clearTimeout(svcMatchTimer);
  if (q.length < 2) return;
  svcMatchTimer = setTimeout(async () => {
    try {
      const r = await api('/api/playbooks/service-match', { method: 'POST', body: JSON.stringify({ query: q }) });
      if (svcMatchCache.query !== q) return; // 查询已改,丢弃过期响应
      svcMatchCache = { query: q, match: (r && r.match) || null };
    } catch { /* 拉取失败 = 无服务条,零行为 */ }
    renderSkillList();
  }, 220);
}
function serviceMatchStrip() {
  const m = svcMatchCache.match;
  if (!m || !m.service) return null;
  const service = t('skills.service.' + m.service);
  let text = '';
  if (m.state === 'available') {
    // 127-⑧:可用数只数 status==='available' —— 状态未知的模板 available 照旧为 true,按它数就把未知说成「可直接用」。
    const n = (m.playbooks || []).filter(p => p.status === 'available').length;
    text = t('skills.serviceMatch.available', { service, count: n });
    const unknown = (m.playbooks || []).filter(p => p.status === 'unknown').length;
    if (unknown > 0) text += t('skills.serviceMatch.unknownMore', { count: unknown });
  } else if (m.state === 'unknown') {
    text = t('skills.serviceMatch.unknown', { service, count: (m.playbooks || []).length });
  } else if (m.state === 'needs_config') {
    const cap = (m.guidance || [])[0] || '';
    text = t('skills.serviceMatch.needsConfig', { service, guidance: cap ? t('skills.serviceMatch.guidance.' + cap) : '' });
    if (m.guidanceDropped > 0) text += ' ' + t('skills.serviceMatch.more', { count: m.guidanceDropped });
  } else if (m.state === 'no_template') {
    text = t('skills.serviceMatch.noTemplate', { service });
  }
  if (!text) return null;
  // sk-reason 既有样式(灰底小字),sk-svc-match 只做稳定选择器 —— 零 CSS 新增。
  const strip = el('div', 'sk-reason sk-svc-match');
  strip.setAttribute('role', 'note');
  strip.textContent = text;
  return strip;
}
function renderSkillList() {
  const q = $('skillSearch').value.trim().toLowerCase();
  scheduleServiceMatch(q);
  const all = skillRegistry || [];
  const match = s => skillMatchesQuery(s, q);
  const skills = all.filter(s => s.kind === 'skill' && match(s));
  const commands = all.filter(s => s.kind === 'command' && match(s));
  const playbooks = all.filter(s => s.kind === 'playbook' && match(s));
  skillFiltered = [...skills, ...commands, ...playbooks]; // 拍平的显示顺序(与 .skill-item DOM 顺序一致)
  if (skillIndex >= skillFiltered.length) skillIndex = Math.max(0, skillFiltered.length - 1);
  const list = $('skillList'); list.innerHTML = '';
  // 127-A-S02:服务条永远排在列表最前(它不是一条技能,不进 skillFiltered,键盘导航自然够不到)。
  const svcStrip = serviceMatchStrip();
  if (svcStrip) list.appendChild(svcStrip);
  const enabledIds = enabledSkillIds();
  const enabled = new Set(enabledIds);
  const resident = new Set(residentSkillIds());
  // P3-6: 幽灵启用项 —— session.skills 里但注册表已无对应技能(被删/改名/随 cwd 丢失)。收集以便渲染「已失效」行。
  const regSkillIds = new Set(all.filter(s => s.kind === 'skill').map(s => s.id));
  const ghosts = enabledIds.filter(id => !regSkillIds.has(id) && (!q || id.toLowerCase().includes(q)));
  if (!skillFiltered.length && !ghosts.length) {
    list.appendChild(el('div', 'muted', all.length ? t('skills.noMatch') : t('skills.empty')));
    return;
  }
  // v3 (§2.12 P2 r2):分段控件锚点导航 + 两列卡片网格。分组顺序与 skillFiltered 拍平顺序一致(键盘导航 flatIdx 对齐)。
  const groups = [
    { id: 'skill', label: t('skills.group.skills'), sub: t('skills.group.skillsDescription'), items: skills, builder: (s, i) => buildSkillRow(s, i, enabled, resident) },
    { id: 'cmd', label: t('skills.group.commands'), sub: t('skills.group.commandsDescription'), items: commands, builder: buildCommandRow },
    { id: 'play', label: t('skills.group.playbooks'), sub: t('skills.group.playbooksDescription'), items: playbooks, builder: buildPlaybookRow },
  ].filter(g => g.items.length);
  if (groups.length > 1) list.appendChild(buildSkAnchorNav(groups.map(g => ({ id: 'g-' + g.id, label: g.label, count: g.items.length }))));
  let flatIdx = 0;
  for (const g of groups) {
    const grp = el('div', 'sk-group'); grp.id = 'g-' + g.id;
    grp.appendChild(buildSkGroupTitle(g.label, g.sub, g.items.length));
    const grid = el('div', 'sk-grid');
    for (const s of g.items) grid.appendChild(g.builder(s, flatIdx++));
    grp.appendChild(grid);
    list.appendChild(grp);
  }
  if (ghosts.length) {
    const grp = el('div', 'sk-group');
    grp.appendChild(buildSkGroupTitle(t('skills.group.unavailable'), '', ghosts.length));
    const grid = el('div', 'sk-grid');
    for (const gid of ghosts) grid.appendChild(buildGhostRow(gid)); // 不带 .skill-item → 键盘导航忽略
    grp.appendChild(grid);
    list.appendChild(grp);
  }
}
// 分段控件式锚点子导航(§2.12):chips 置顶,点击/回车滚动到对应组并高亮。容器可复用(技能库/记忆同构)。
function buildSkAnchorNav(entries) {
  const seg = el('nav', 'sk-seg'); seg.setAttribute('aria-label', t('skills.groupNavigation'));
  entries.forEach((en, i) => {
    const a = el('a', i === 0 ? 'active' : '');
    a.append(el('span', '', en.label), el('span', 'n num', String(en.count)));
    a.tabIndex = 0; a.setAttribute('role', 'button');
    const go = () => {
      seg.querySelectorAll('a').forEach(x => x.classList.remove('active')); a.classList.add('active');
      const target = document.getElementById(en.id); if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    a.onclick = e => { e.preventDefault(); go(); };
    a.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    seg.appendChild(a);
  });
  return seg;
}
// 分组题(§2.12):字距标题 + 副标 + 计数 + 渐隐发丝线 + 云纹端符。
function buildSkGroupTitle(label, sub, count) {
  const t = el('h3', 'sk-group-t');
  t.appendChild(el('span', 't', label));
  if (sub) t.appendChild(el('span', 'sub', sub));
  t.appendChild(el('span', 'cnt num', String(count)));
  t.appendChild(el('span', 'line'));
  const cloud = el('span', 'cloud'); cloud.setAttribute('aria-hidden', 'true'); t.appendChild(cloud);
  return t;
}
// 卡片图标块(§2.12):技能→青花 sparkles SVG;命令→斜杠;一键任务→ playbook emoji(用户数据,保留)/兜底 sparkles。
function skillCardIco(kind, s) {
  const ico = el('span', 'sk-ico');
  const pb = s && s.playbook;
  if (kind === 'playbook' && pb && pb.icon) { ico.textContent = pb.icon; return ico; }
  if (kind === 'command') { ico.textContent = '/'; return ico; }
  const svg = icon('sparkles', 16); if (svg) ico.appendChild(svg); else ico.textContent = '✦';
  return ico;
}
// P3-6: 已失效技能行 —— 展示 id + 移除按钮(POST 过滤后由服务端自动清掉该无效 id)。不带 .skill-item 类,不参与键盘选中。
function buildGhostRow(id) {
  const it = el('div', 'skill-ghost');
  const head = el('div', 'skill-head');
  head.appendChild(el('span', 'skill-name', id));
  head.appendChild(el('span', 'skill-src', t('skills.group.unavailable')));
  const rm = el('button', 'skill-toggle', t('skills.removeUnavailable'));
  rm.onclick = e => { e.stopPropagation(); removeGhostSkill(id); };
  head.appendChild(rm);
  it.appendChild(head);
  it.appendChild(el('div', 'skill-reason', t('skills.unavailableReason')));
  return it;
}
// P3-6: 移除一个失效技能 —— 从启用集里剔除该 id 并落盘(服务端只保留注册表里存在的技能,失效 id 自然被清)。
async function removeGhostSkill(id) {
  const session = state.currentSession;
  if (!session) return;
  const next = enabledSkillIds().filter(x => x !== id);
  try {
    const r = await api('/api/session/skills', { method: 'POST', body: JSON.stringify({ sessionId: session.id, skills: next }) });
    session.skills = (r && Array.isArray(r.skills)) ? r.skills : next.map(x => ({ id: x, source: '' }));
    toast(t('skills.toast.removedUnavailable', { id }));
  } catch (e) { toast(t('skills.toast.removeFailed', { reason: apiErrText(e) }), 'err'); return; }
  renderSkillList();
  updateSkillBadge();
}
// 技能卡(§2.12 r2):中文名主显 + mono id 小字 + 来源标签 + 描述 + 启用开关。启用态 .on 触发青花描边/渗透洗。
// 保留 .skill-item 类以复用键盘导航(updateSkillSel 查 .skill-item);.sk-card 承载卡片视觉。不可用置灰。
function buildSkillRow(s, i, enabled, resident) {
  const unavailable = s.available === false;
  const sessionOn = enabled.has(s.id);
  const residentOn = resident.has(s.id);
  const on = sessionOn || residentOn;
  const pending = skillTogglePending.has(s.id); // P3-5: 该行有在途请求 → 开关禁用 + 显示「…」
  const it = el('div', `skill-item sk-card${on ? ' on' : ''}${i === skillIndex ? ' sel' : ''}${unavailable ? ' unavailable' : ''}`);
  const head = el('div', 'sk-card-h');
  head.appendChild(skillCardIco('skill', s));
  head.appendChild(el('span', 'sk-name', skillDisplayName(s)));
  head.appendChild(el('span', 'sk-src', skillDisplaySource(s)));
  it.appendChild(head);
  it.appendChild(el('div', 'sk-id', s.id)); // mono id 降为小字
  const description = skillDisplayDescription(s);
  if (description) it.appendChild(el('div', 'sk-desc', description));
  const unavailableReason = skillDisplayUnavailableReason(s);
  if (unavailable && unavailableReason) it.appendChild(el('div', 'sk-reason', unavailableReason));
  const foot = el('div', 'sk-foot');
  if (s.detail) {
    const detail = el('button', 'skill-detail-btn', t('skills.details'));
    detail.onclick = e => { e.stopPropagation(); openSkillDetail(s); };
    foot.appendChild(detail);
  }
  const toggle = el('button', 'skill-toggle' + (sessionOn ? ' on' : ''), unavailable ? t('skills.unavailable') : (pending ? '…' : (sessionOn ? t('skills.enabledForSession') : t('skills.enableForSession'))));
  if (unavailable || pending) toggle.disabled = true;
  toggle.onclick = e => { e.stopPropagation(); toggleSkill(s); };
  foot.appendChild(toggle);
  const keep = el('button', 'skill-toggle resident' + (residentOn ? ' on' : ''), residentOn ? t('skills.resident') : t('skills.keepResident'));
  if (unavailable) keep.disabled = true;
  keep.onclick = e => { e.stopPropagation(); toggleResidentSkill(s); };
  foot.appendChild(keep);
  // v2.5: 用户技能可删(快速删除 + 确认摩擦)。仅 source==='user' 显示;builtin/project/claude-code 不显示删除键。
  if (s.source === 'user') {
    const del = el('button', 'skill-toggle danger', t('skills.delete'));
    del.title = t('skills.delete');
    del.setAttribute('aria-label', t('skills.delete'));
    del.onclick = e => { e.stopPropagation(); confirmDeleteSkill(s); };
    foot.appendChild(del);
  }
  it.appendChild(foot);
  it.onmouseenter = () => { skillIndex = i; updateSkillSel(); };
  it.onclick = () => { if (!unavailable && !pending) toggleSkill(s); };
  return it;
}

function openSkillDetail(entry) {
  const body = el('div', 'skill-detail md');
  body.innerHTML = renderMarkdown(entry.detail || entry.description || '');
  const close = el('button', 'primary', t('common.close'));
  const modal = buildModal(skillDisplayName(entry), body, close);
  close.onclick = () => modal.close();
}

// v2.5: 删除用户技能的确认弹窗。「不要太简单」的摩擦:二次点击确认 --
// 第一次点「确认删除」只 arm(按钮文案变为「再次点击确认删除」,3 秒内不点自动收回),第二次点击才真删。
// 仅 source==='user' 可达此入口(buildSkillRow 只为 user 源渲染删除键);服务端仍独立校验 confirm===id。
// 设置页「技能与模板」也走这一个确认件:afterDelete 给了就用它刷新自己那一页(先重拉注册表),不再弹开技能库。
let skillDeletePending = false;
async function confirmDeleteSkill(entry, { afterDelete = null } = {}) {
  if (skillDeletePending || !entry || entry.source !== 'user') return;
  const id = String(entry.id || '');
  const name = skillDisplayName(entry);
  const body = el('div', 'skill-delete-confirm');
  body.appendChild(el('p', '', t('skills.deleteConfirm.body', { name })));
  body.appendChild(el('div', 'sk-del-id', t('skills.deleteConfirm.idLabel') + ': ' + id));
  body.appendChild(el('p', 'muted sm', t('skills.deleteConfirm.warning')));
  const foot = el('div', 'modal-foot-row');
  const cancel = el('button', 'mini', t('common.cancel'));
  const confirm = el('button', 'mini danger', t('skills.deleteConfirm.confirm'));
  foot.append(cancel, confirm);
  let armed = false;
  let disarmTimer = null;
  const initialText = t('skills.deleteConfirm.confirm');
  const clearDisarm = () => { if (disarmTimer) { clearTimeout(disarmTimer); disarmTimer = null; } };
  const disarm = () => { armed = false; confirm.classList.remove('armed'); confirm.textContent = initialText; clearDisarm(); };
  const modal = buildModal(t('skills.deleteConfirm.title'), body, foot, clearDisarm); // ESC/点背景关闭时也清计时器
  cancel.onclick = () => { clearDisarm(); modal.close(); };
  confirm.onclick = () => {
    if (skillDeletePending) return;
    if (!armed) { // 第一次点击:arm,等第二次
      armed = true;
      confirm.classList.add('armed');
      confirm.textContent = t('skills.deleteConfirm.armed');
      disarmTimer = setTimeout(disarm, 3000); // 3 秒内不点第二次 -> 自动收回,防误删
      return;
    }
    clearDisarm();
    doDelete();
  };
  setTimeout(() => { try { confirm.focus(); } catch { /* ignore */ } }, 0);
  async function doDelete() {
    if (skillDeletePending) return;
    skillDeletePending = true;
    confirm.disabled = true;
    confirm.textContent = '…';
    try {
      await api('/api/skills', { method: 'DELETE', body: JSON.stringify({ id, confirm: id }) });
      toast(t('skills.toast.deleted', { name }));
      modal.close();
      if (typeof afterDelete === 'function') { // 设置页:只重拉注册表并让它重画自己,不打开技能库弹窗
        let fresh = null; // 重拉失败给 null,调用方自己决定怎么办
        try { fresh = await refreshSkillRegistry(); } catch { /* 交给调用方 */ }
        await afterDelete(fresh);
      } else {
        await openSkillPanel(); // 重拉 /api/skills 刷新注册表(被删技能自然消失)
      }
      updateSkillBadge();
    } catch (e) {
      toast(t('skills.toast.deleteFailed', { reason: apiErrText(e) }), 'err');
      confirm.disabled = false;
      disarm(); // 失败 -> 回到初始态,允许重试
    } finally {
      skillDeletePending = false;
    }
  }
}

const RESIDENT_SKILL_MAX = 8; // 常驻技能上限(设置页「技能与模板」的开关锁也读它)
let residentSkillTogglePending = false;
async function toggleResidentSkill(entry) {
  if (residentSkillTogglePending || entry.available === false) return;
  const current = residentSkillEntries();
  const on = current.some(x => (typeof x === 'string' ? x : x && x.id) === entry.id);
  let next = current.filter(x => (typeof x === 'string' ? x : x && x.id) !== entry.id);
  if (!on) {
    if (next.length >= RESIDENT_SKILL_MAX) { toast(t('skills.toast.maxResident', { count: RESIDENT_SKILL_MAX }), 'err'); return; }
    next.push({ id: entry.id, source: entry.source || '' });
  }
  residentSkillTogglePending = true;
  const ok = await saveConfigPartial({ residentSkills: next });
  residentSkillTogglePending = false;
  if (ok) toast(on ? t('skills.toast.residentDisabled', { name: skillDisplayName(entry) }) : t('skills.toast.residentEnabled', { name: skillDisplayName(entry) }));
  renderSkillList(); updateSkillBadge();
}
// 命令卡:中文名主显 + mono 小字标识。点击按 commandInsertionText 插 /name 或命令正文。内置命令在 Claude Code 里
// 只有插件名下的 /offline-toolkit:<id>(装了插件才有),小字照实写这个,不印一个打不出来的 /<id>。
function buildCommandRow(s, i) {
  const it = el('div', `skill-item sk-card${i === skillIndex ? ' sel' : ''}`);
  const head = el('div', 'sk-card-h');
  head.appendChild(skillCardIco('command', s));
  head.appendChild(el('span', 'sk-name', skillDisplayName(s)));
  it.appendChild(head);
  it.appendChild(el('code', 'sk-id', s.source === 'builtin' ? `/offline-toolkit:${s.id}` : (s.insert || ('/' + s.id))));
  const description = skillDisplayDescription(s);
  if (description) it.appendChild(el('div', 'sk-desc', description));
  if (s.detail) {
    const foot = el('div', 'sk-foot');
    const detail = el('button', 'skill-detail-btn', t('skills.viewTemplate'));
    detail.onclick = e => { e.stopPropagation(); openSkillDetail(s); };
    foot.appendChild(detail); it.appendChild(foot);
  }
  it.onmouseenter = () => { skillIndex = i; updateSkillSel(); };
  it.onclick = () => { insertSkill(commandInsertion(s)); closeModal('skillModal'); };
  return it;
}
function commandInsertion(entry) {
  return commandInsertionText(entry, isProviderMode(), currentAgentCliType());
}
// 一键任务卡(Playbook):中文名主显 + playbook emoji 图标。点击走既有 openPlaybookModal。不可用置灰 + 原因。
function buildPlaybookRow(s, i) {
  const unavailable = s.available === false;
  const pb = s.playbook || null;
  const it = el('div', `skill-item sk-card${i === skillIndex ? ' sel' : ''}${unavailable ? ' unavailable' : ''}`);
  const head = el('div', 'sk-card-h');
  head.appendChild(skillCardIco('playbook', s));
  head.appendChild(el('span', 'sk-name', skillDisplayName(s)));
  it.appendChild(head);
  it.appendChild(el('div', 'sk-id', s.id));
  const description = skillDisplayDescription(s);
  if (description) it.appendChild(el('div', 'sk-desc', description));
  const unavailableReason = skillDisplayUnavailableReason(s);
  // 127-⑧:状态行(未知/需配置/离线降级)在原因之上;离线那句已含「需要联网」,不再叠一行同义原因。
  const statusText = playbookStatusText(s);
  if (statusText) it.appendChild(el('div', 'sk-reason sk-status', statusText)).dataset.status = s.status || 'unknown';
  if (unavailable && unavailableReason && s.status !== 'unavailable') it.appendChild(el('div', 'sk-reason', unavailableReason));
  it.onmouseenter = () => { skillIndex = i; updateSkillSel(); };
  it.onclick = () => {
    if (unavailable) { toast(unavailableReason || t('skills.toast.unavailable'), 'err'); return; }
    if (!pb) { toast(t('skills.toast.playbookMissing'), 'err'); return; }
    closeModal('skillModal'); openPlaybookModal(pb);
  };
  return it;
}
// 启用/停用一个技能:更新 session.skills 并 POST 落盘。上限 8;不可用技能拒启用。
// P3-5: 串行化 —— 接到模块级单飞链尾,并把该 id 记为在途(禁用其开关),避免快速连点产生读改写竞态/覆盖。
function toggleSkill(entry) {
  const session = state.currentSession;
  if (!session) { toast(t('skills.toast.selectSession'), 'err'); return; }
  if (entry.available === false) { toast(skillDisplayUnavailableReason(entry) || t('skills.toast.unavailable'), 'err'); return; }
  if (skillTogglePending.has(entry.id)) return; // 该行已有在途请求 → 忽略重复点击
  skillTogglePending.add(entry.id);
  renderSkillList(); // 立刻反映 disabled 态
  skillToggleChain = skillToggleChain.then(() => doToggleSkill(entry)).catch(() => {}).then(() => {
    skillTogglePending.delete(entry.id);
    renderSkillList();
    updateSkillBadge();
  });
}
async function doToggleSkill(entry) {
  const session = state.currentSession;
  if (!session) return;
  const cur = enabledSkillIds(); // 链上串行执行,每次读取最新启用集(以 id 列表比较)
  const on = cur.includes(entry.id);
  let next;
  if (on) next = cur.filter(x => x !== entry.id);
  else { if (cur.length >= 8) { toast(t('skills.toast.maxEnabled', { count: 8 }), 'err'); return; } next = cur.concat(entry.id); }
  try {
    const r = await api('/api/session/skills', { method: 'POST', body: JSON.stringify({ sessionId: session.id, skills: next }) });
    session.skills = (r && Array.isArray(r.skills)) ? r.skills : next.map(id => ({ id, source: '' }));
    const name = skillDisplayName(entry);
    toast(on ? t('skills.toast.disabled', { name }) : t('skills.toast.enabled', { name }));
  } catch (e) { toast(t('skills.toast.updateFailed', { reason: apiErrText(e) }), 'err'); }
}
// composer 技能按钮的数量徽标(已启用技能数)。会话切换/启用变更时刷新。
function updateSkillBadge() {
  const btn = $('skillBtn'); if (!btn) return;
  const n = new Set([...enabledSkillIds(), ...residentSkillIds()]).size;
  iconTextBtn(btn, 'sparkles', n > 0 ? t('skills.badgeWithCount', { count: n }) : t('skills.badge')); // v3 (§B1/§2.15): ✨→sparkles 线性 SVG(⌘ 曾是 Mac 心智,已弃)
}
function updateSkillSel() {
  const items = [...$('skillList').querySelectorAll('.skill-item')];
  items.forEach((it, i) => it.classList.toggle('sel', i === skillIndex));
  items[skillIndex]?.scrollIntoView({ block: 'nearest' });
}
function moveSkillSel(d) {
  if (!skillFiltered.length) return;
  skillIndex = Math.max(0, Math.min(skillFiltered.length - 1, skillIndex + d));
  updateSkillSel();
}
// Enter/点选:技能→切换启用(不关面板,便于连续操作);命令→插入并关;一键任务→关面板并打开输入表单。
function pickSkill(i) {
  const s = skillFiltered[i]; if (!s) return;
  if (s.kind === 'skill') { toggleSkill(s); return; }
  if (s.kind === 'command') { insertSkill(commandInsertion(s)); closeModal('skillModal'); return; }
  if (s.kind === 'playbook') {
    if (s.available === false) { toast(skillDisplayUnavailableReason(s) || t('skills.toast.unavailable'), 'err'); return; }
    if (!s.playbook) { toast(t('skills.toast.playbookMissing'), 'err'); return; }
    closeModal('skillModal'); openPlaybookModal(s.playbook);
  }
}
function insertSkill(cmd) {
  const ta = $('promptInput');
  const cur = ta.value;
  const sep = (!cur || /\s$/.test(cur)) ? '' : ' ';
  ta.value = cur + sep + cmd + ' ';
  autoGrow(ta); ta.focus();
}

/* ---------------- workbench memory panel (v2 跨会话记忆) ---------------- */
// 「工作台记忆」面板:global / 当前项目两组,启停 toggle(POST /api/session/memories,串行化仿 toggleSkill)、
// 删除(confirm)、编辑、「迁移到当前项目」、手写新建、「从当前会话起草」(provider 才显示)。幽灵启用项可移除。
let memoryRegistry = [];
let memoryOtherProjects = [];
let memoryCurrentProjectKey = '';
let memoryCoreStats = null;
let memoryLimits = null;   // GET /api/memory 回的 { relevanceMax, fixedSelectionMax }(来自配置;设置页「每回合带几条相关记忆」「会话固定选择上限」可调)
let memoryToolboxFilter = 'all';
let memoryToggleChain = Promise.resolve();
const memoryTogglePending = new Set();
// 会话有效候选集:显式设置过 → 固定选择；否则项目 + 全局全部参与元数据检索，再扣除会话排除项。
function enabledMemoryKeySet() {
  const session = state.currentSession;
  if (session && session.memoriesExplicit === true) {
    const arr = Array.isArray(session.memories) ? session.memories : [];
    return new Set(arr.map(m => ((m && m.scope === 'global') ? 'global' : 'project') + ':' + (m && m.id)).filter(k => !k.endsWith(':')));
  }
  const excluded = new Set((Array.isArray(session && session.memoryExclusions) ? session.memoryExclusions : [])
    .filter(m => m && m.id && (m.scope === 'global' || !m.projectKey || !memoryCurrentProjectKey || m.projectKey === memoryCurrentProjectKey))
    .map(m => ((m.scope === 'global') ? 'global' : 'project') + ':' + m.id));
  return new Set((memoryRegistry || []).filter(e => e && e.id && !excluded.has(e.scope + ':' + e.id)).map(e => e.scope + ':' + e.id));
}
async function loadMemoryData() {
  try {
    const r = await api('/api/memory?cwd=' + encodeURIComponent(currentWorkspace() || ''));
    memoryRegistry = (r && r.memories) || [];
    memoryOtherProjects = (r && r.otherProjects) || [];
    memoryCurrentProjectKey = (r && r.projectKey) || '';
    memoryCoreStats = (r && r.core) || null;
    memoryLimits = (r && r.limits) || null;
  } catch { memoryRegistry = []; memoryOtherProjects = []; memoryCurrentProjectKey = ''; memoryCoreStats = null; memoryLimits = null; }
}
// 面板里出现的记忆数量上限一律读配置,不再各写一份旧常量(修前文案写死「每轮最多补充 3 条」「最多同时启用 12 条」、
// 核心预算兜底 4200/24,而后端默认早已是 8 / 64 / 16000 / 200 且设置页都能调)。优先用后端随 /api/memory 回的值,
// 其次前端已有的配置,最后才是与后端默认一致的兜底。
function memoryLimitValue(serverKey, configKey, fallback) {
  const pick = value => (value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
  const fromServer = memoryLimits ? pick(memoryLimits[serverKey]) : null;
  if (fromServer !== null) return fromServer;
  const fromConfig = pick(state.config && state.config[configKey]);
  return fromConfig !== null ? fromConfig : fallback;
}
function renderMemoryViews() {
  renderMemoryList();
  renderMemoryToolbox();
}
async function refreshMemoryViews() {
  await loadMemoryData();
  renderMemoryViews();
}
async function openMemoryPanel() {
  openModal('memoryModal');
  $('memoryList').innerHTML = '<div class="muted">' + t('common.loading') + '</div>';
  await refreshMemoryViews();
}
async function openMemoryToolbox() {
  const list = $('memoryToolboxList');
  if (list) list.innerHTML = '<div class="memory-empty"><span class="memory-empty-mark">◌</span>' + t('common.loading') + '</div>';
  await refreshMemoryViews();
}
function renderMemoryList() {
  const list = $('memoryList'); if (!list) return; list.innerHTML = '';
  const session = state.currentSession;
  // 顶部动作:手写新建 + (provider)从当前会话起草
  const actions = el('div', 'memory-actions');
  const newBtn = el('button', 'mini', t('memory.createNew'));
  newBtn.onclick = () => openMemoryEditModal(null);
  actions.appendChild(newBtn);
  if (isProviderMode() && session) {
    const draftBtn = el('button', 'mini', t('memory.draftFromSession'));
    draftBtn.onclick = () => saveAsMemory(draftBtn);
    actions.appendChild(draftBtn);
  }
  if (session) {
    const policyBtn = el('button', 'mini', session.memoriesExplicit === true ? t('memory.restoreDefaults') : t('memory.disableForSession'));
    policyBtn.onclick = () => session.memoriesExplicit === true ? restoreDefaultMemoryPolicy(policyBtn) : disableMemoryForSession(policyBtn);
    actions.appendChild(policyBtn);
  }
  list.appendChild(actions);
  if (!session) list.appendChild(el('div', 'muted', t('memory.needSessionHint')));
  const explicit = session && session.memoriesExplicit === true;
  if (session && !explicit) {
    const relevanceMax = memoryLimitValue('relevanceMax', 'memoryRelevanceMaxV1', 8);
    list.appendChild(el('div', 'memory-hint muted', relevanceMax > 0 ? t('memory.defaultPolicyHint', { count: relevanceMax }) : t('memory.defaultPolicyHintNoRelated')));
  }
  if (session && explicit) list.appendChild(el('div', 'memory-hint muted', (session.memories || []).length ? t('memory.fixedPolicyHint') : t('memory.sessionDisabledHint')));
  const enabled = enabledMemoryKeySet();
  const globals = (memoryRegistry || []).filter(e => e.scope === 'global');
  const projects = (memoryRegistry || []).filter(e => e.scope === 'project');
  // v3 (§2.12 P2 r2):记忆面板与技能库同构 —— 分段控件锚点导航 + 两列卡片网格(复用 buildSkAnchorNav/buildSkGroupTitle)。
  const memGroups = [
    { id: 'global', label: t('memory.groupGlobal'), sub: t('memory.groupGlobalSub'), items: globals },
    { id: 'project', label: t('memory.groupProject'), sub: t('memory.groupProjectSub'), items: projects },
  ];
  if (memGroups.some(g => g.items.length)) list.appendChild(buildSkAnchorNav(memGroups.map(g => ({ id: 'm-' + g.id, label: g.label, count: g.items.length }))));
  for (const g of memGroups) {
    const grp = el('div', 'sk-group'); grp.id = 'm-' + g.id;
    grp.appendChild(buildSkGroupTitle(g.label, g.sub, g.items.length));
    if (!g.items.length) { grp.appendChild(el('div', 'muted', t('common.none'))); }
    else { const grid = el('div', 'sk-grid'); for (const m of g.items) grid.appendChild(buildMemoryRow(m, enabled)); grp.appendChild(grid); }
    list.appendChild(grp);
  }
  // 幽灵项:显式启用集里但注册表已无对应文件(被删/改名/随 cwd 丢失)。
  if (explicit && session) {
    const regKeys = new Set((memoryRegistry || []).map(e => e.scope + ':' + e.id));
    const arr = Array.isArray(session.memories) ? session.memories : [];
    const ghosts = arr.filter(m => m && m.id && !regKeys.has(((m.scope === 'global') ? 'global' : 'project') + ':' + m.id));
    if (ghosts.length) {
      list.appendChild(el('div', 'skill-group-title', t('memory.ghostGroup', { count: ghosts.length })));
      for (const g of ghosts) list.appendChild(buildMemoryGhostRow(g));
    }
  }
  // 其它项目组(迁移到当前项目)
  if ((memoryOtherProjects || []).length) {
    list.appendChild(el('div', 'skill-group-title', t('memory.otherProjects')));
    for (const p of memoryOtherProjects) list.appendChild(buildOtherProjectRow(p));
  }
}
function memoryTypeLabel(type) {
  if (type === 'preference') return t('memory.type.preference');
  if (type === 'convention') return t('memory.type.convention');
  if (type === 'lesson') return t('memory.type.lesson');
  return t('memory.type.reference');
}
function memoryStatusLabel(status) {
  if (status === 'active') return t('memory.toolbox.status.active');
  if (status === 'standby') return t('memory.toolbox.status.standby');
  if (status === 'expired') return t('memory.toolbox.status.expired');
  return t('memory.toolbox.status.library');
}
function memoryShortDate(value) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return '';
  try { return new Intl.DateTimeFormat(document.documentElement.lang || undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ms)); }
  catch { return String(value).slice(0, 10); }
}
function renderMemoryToolbox() {
  const host = $('memoryToolboxList'), overview = $('memoryToolboxOverview');
  if (!host || !overview) return;
  const coreCharFallback = memoryLimitValue('coreCharBudget', 'coreMemoryCharBudgetV1', 16000), coreItemFallback = memoryLimitValue('coreItemMax', 'coreMemoryMaxItemsV1', 200);
  const stats = memoryCoreStats || { total: memoryRegistry.length, active: 0, standby: 0, reviewDue: 0, charsUsed: 0, charLimit: coreCharFallback, itemLimit: coreItemFallback };
  const pct = Math.min(100, Math.round((Number(stats.charsUsed) || 0) / Math.max(1, Number(stats.charLimit) || coreCharFallback) * 100));
  overview.innerHTML = '';
  const overviewTop = el('div', 'memory-overview-top');
  for (const [value, label, cls] of [
    [stats.total || 0, t('memory.toolbox.metric.total'), ''],
    [stats.active || 0, t('memory.toolbox.metric.active'), 'is-core'],
    [stats.standby || 0, t('memory.toolbox.metric.standby'), ''],
    [stats.reviewDue || 0, t('memory.toolbox.metric.review'), Number(stats.reviewDue) ? 'is-review' : ''],
  ]) {
    const metric = el('div', 'memory-metric ' + cls);
    metric.append(el('strong', '', String(value)), el('span', '', label));
    overviewTop.appendChild(metric);
  }
  const budget = el('div', 'memory-budget');
  const budgetLine = el('div', 'memory-budget-line');
  budgetLine.append(el('span', '', t('memory.toolbox.budget')), el('span', '', `${stats.charsUsed || 0} / ${stats.charLimit || coreCharFallback}`));
  const track = el('div', 'memory-budget-track');
  const fill = el('span', 'memory-budget-fill'); fill.style.width = pct + '%'; track.appendChild(fill);
  budget.append(budgetLine, track, el('p', '', t('memory.toolbox.lruHint', { count: stats.itemLimit || coreItemFallback })));
  overview.append(overviewTop, budget);

  const query = String($('memoryToolboxSearch')?.value || '').normalize('NFKC').toLowerCase().trim();
  let items = (memoryRegistry || []).filter(m => {
    if (memoryToolboxFilter === 'core' && !m.core) return false;
    if (memoryToolboxFilter === 'review' && !m.reviewDue && !m.expired) return false;
    if (!query) return true;
    return [m.name, m.description, m.id, m.type, m.scope].filter(Boolean).join(' ').normalize('NFKC').toLowerCase().includes(query);
  });
  const statusOrder = { active: 0, standby: 1, expired: 2, library: 3 };
  items.sort((a, b) => (statusOrder[a.coreStatus] ?? 4) - (statusOrder[b.coreStatus] ?? 4)
    || String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  host.innerHTML = '';
  if (!items.length) {
    const empty = el('div', 'memory-empty');
    empty.append(el('span', 'memory-empty-mark', '◌'), el('strong', '', t('memory.toolbox.empty')), el('p', '', t('memory.toolbox.emptyHint')));
    host.appendChild(empty); return;
  }
  for (const m of items) host.appendChild(buildMemoryToolboxCard(m));
}
function buildMemoryToolboxCard(m) {
  const card = el('article', `memory-card status-${m.coreStatus || 'library'}${m.importance === 'important' ? ' important' : ''}`);
  const head = el('div', 'memory-card-head');
  const titleWrap = el('div', 'memory-card-title');
  titleWrap.append(el('span', 'memory-card-scope', m.scope === 'global' ? t('memory.scope.global') : t('memory.scope.project')), el('h4', '', m.name || m.id));
  const badges = el('div', 'memory-card-badges');
  badges.append(el('span', 'memory-badge type', memoryTypeLabel(m.type)));
  if (m.core) badges.append(el('span', 'memory-badge status', memoryStatusLabel(m.coreStatus)));
  if (m.importance === 'important') badges.append(el('span', 'memory-badge important', t('memory.toolbox.important')));
  if (m.reviewDue && !m.expired) badges.append(el('span', 'memory-badge review', t('memory.toolbox.reviewDue')));
  head.append(titleWrap, badges); card.appendChild(head);
  const summary = m.core && m.coreSummary ? m.coreSummary : m.description;
  if (summary) card.appendChild(el('p', 'memory-card-summary', summary));
  const meta = el('div', 'memory-card-meta');
  const updated = memoryShortDate(m.updatedAt || m.createdAt);
  const used = memoryShortDate(m.lastUsedAt);
  if (updated) meta.appendChild(el('span', '', t('memory.toolbox.updated', { date: updated })));
  if (used) meta.appendChild(el('span', '', t('memory.toolbox.used', { date: used })));
  if (m.expiresAt) meta.appendChild(el('span', m.expired ? 'expired' : '', t('memory.toolbox.expires', { date: memoryShortDate(m.expiresAt) })));
  card.appendChild(meta);
  const actions = el('div', 'memory-card-actions');
  const coreBtn = el('button', 'mini memory-core-toggle' + (m.core ? ' on' : ''), m.core ? t('memory.toolbox.removeCore') : t('memory.toolbox.makeCore'));
  coreBtn.onclick = () => updateMemoryMetadata(m, { core: !m.core }, coreBtn);
  const importantBtn = el('button', 'mini memory-important-toggle' + (m.importance === 'important' ? ' on' : ''), m.importance === 'important' ? '★' : '☆');
  importantBtn.title = m.importance === 'important' ? t('memory.toolbox.unmarkImportant') : t('memory.toolbox.markImportant');
  importantBtn.setAttribute('aria-label', importantBtn.title);
  importantBtn.onclick = () => updateMemoryMetadata(m, { importance: m.importance === 'important' ? 'normal' : 'important' }, importantBtn);
  const editBtn = el('button', 'mini', t('common.edit')); editBtn.onclick = () => openMemoryEditModal(m);
  const deleteBtn = el('button', 'mini danger', t('common.delete')); deleteBtn.onclick = () => deleteMemoryRow(m);
  actions.append(coreBtn, importantBtn, editBtn, deleteBtn); card.appendChild(actions);
  return card;
}
async function updateMemoryMetadata(memory, patch, button) {
  if (button) button.disabled = true;
  try {
    const result = await api('/api/memory/metadata', { method: 'POST', body: JSON.stringify({ id: memory.id, scope: memory.scope, patch, cwd: currentWorkspace() || '' }) });
    if (!result || !result.ok) throw new Error(apiErrText(result && result.error) || t('common.unknownError'));
    await refreshMemoryViews();
  } catch (error) { toast(t('memory.toolbox.updateFailed', { err: apiErrText(error) }), 'err'); if (button) button.disabled = false; }
}
function buildMemoryRow(m, enabled) {
  const key = m.scope + ':' + m.id;
  const on = enabled.has(key);
  const pending = memoryTogglePending.has(key);
  // P3-3: 已启用但会话锁定的 projectKey 与当前项目组不符 → 服务端实际会跳过注入,给用户一个失配提示。
  let stale = false;
  if (on && m.scope === 'project' && memoryCurrentProjectKey) {
    const session = state.currentSession;
    const ent = (session && Array.isArray(session.memories) ? session.memories : []).find(x => x && x.id === m.id && x.scope !== 'global');
    if (ent && ent.projectKey && ent.projectKey !== memoryCurrentProjectKey) stale = true;
  }
  // v3 (§2.12 r2):记忆卡同构 —— 名称主显 + 类型标 + 描述 + 元信息,底部 启用/编辑/删除。启用态 .on 触发青花描边。
  const it = el('div', `skill-item sk-card${on ? ' on' : ''}`);
  const head = el('div', 'sk-card-h');
  head.appendChild(skillCardIco('skill', null));
  head.appendChild(el('span', 'sk-name', m.name || m.id));
  const typeLabel = memoryTypeLabel(m.type);
  head.appendChild(el('span', 'sk-src', typeLabel));
  it.appendChild(head);
  if (m.description) it.appendChild(el('div', 'sk-desc', m.description));
  const meta = el('div', 'sk-reason');
  meta.textContent = (m.createdAt ? String(m.createdAt).slice(0, 10) + ' · ' : '') + (m.scope === 'global' ? t('memory.scope.global') : t('memory.scope.project'));
  it.appendChild(meta);
  if (stale) it.appendChild(el('div', 'sk-reason', t('memory.sourceChanged')));
  const foot = el('div', 'sk-foot');
  const toggle = el('button', 'skill-toggle' + (on ? ' on' : ''), pending ? t('memory.togglePending') : (on ? t('memory.enabled') : t('memory.enable')));
  if (pending) toggle.disabled = true;
  toggle.onclick = e => { e.stopPropagation(); toggleMemory(m); };
  const editB = el('button', 'mini', t('common.edit'));
  editB.onclick = e => { e.stopPropagation(); openMemoryEditModal(m); };
  const delB = el('button', 'mini danger', t('common.delete'));
  delB.onclick = e => { e.stopPropagation(); deleteMemoryRow(m); };
  foot.append(toggle, editB, delB);
  it.appendChild(foot);
  return it;
}
// 幽灵行:显示 id + 移除(POST 过滤后由服务端清掉该无效 id)。
function buildMemoryGhostRow(m) {
  const it = el('div', 'skill-ghost');
  const head = el('div', 'skill-head');
  head.appendChild(el('span', 'skill-name', m.id));
  head.appendChild(el('span', 'skill-src', t('memory.ghostLabel')));
  const rm = el('button', 'skill-toggle', t('common.remove'));
  rm.onclick = e => { e.stopPropagation(); removeGhostMemory(m); };
  head.appendChild(rm);
  it.appendChild(head);
  it.appendChild(el('div', 'skill-reason', t('memory.notInRepo')));
  return it;
}
// 其它项目组行:显示 label/path/条目数 + 「全部迁移到当前项目」。
function buildOtherProjectRow(p) {
  const it = el('div', 'skill-item');
  const head = el('div', 'skill-head');
  head.appendChild(el('span', 'skill-name', p.label || p.projectKey));
  head.appendChild(el('span', 'skill-type', tCount('memory.otherProjectCount', p.count)));
  const btn = el('button', 'skill-toggle', t('memory.migrateToCurrent'));
  btn.onclick = e => { e.stopPropagation(); migrateGroupToCurrent(p); };
  head.appendChild(btn);
  it.appendChild(head);
  if (p.path) it.appendChild(el('div', 'skill-reason', p.path));
  return it;
}
function toggleMemory(m) {
  const session = state.currentSession;
  if (!session) { toast(t("toast.needSession"), 'err'); return; }
  const key = m.scope + ':' + m.id;
  if (memoryTogglePending.has(key)) return;
  memoryTogglePending.add(key);
  renderMemoryViews();
  memoryToggleChain = memoryToggleChain.then(() => doToggleMemory(m)).catch(() => {}).then(() => {
    memoryTogglePending.delete(key);
    renderMemoryViews();
  });
}
async function doToggleMemory(m) {
  const session = state.currentSession;
  if (!session) return;
  const enabled = enabledMemoryKeySet();
  const key = m.scope + ':' + m.id;
  if (session.memoriesExplicit !== true) {
    const current = (Array.isArray(session.memoryExclusions) ? session.memoryExclusions : []).filter(x => x && x.id);
    const nextExcluded = enabled.has(key)
      ? current.concat(m.scope === 'project' ? { scope: 'project', id: m.id, projectKey: memoryCurrentProjectKey } : { scope: 'global', id: m.id })
      : current.filter(x => ((x.scope === 'global') ? 'global' : 'project') + ':' + x.id !== key);
    try {
      const r = await api('/api/session/memories', { method: 'POST', body: JSON.stringify({ sessionId: session.id, useDefault: true, memoryExclusions: nextExcluded }) });
      session.memories = [];
      session.memoriesExplicit = false;
      session.memoryExclusions = (r && Array.isArray(r.memoryExclusions)) ? r.memoryExclusions : nextExcluded;
      toast(enabled.has(key) ? t('memory.toast.excluded', { name: m.name || m.id }) : t('memory.toast.included', { name: m.name || m.id }));
    } catch (e) { toast(t('toast.memorySetFail', { err: apiErrText(e) }), 'err'); }
    return;
  }
  // P3-3: 重建启用集时保留各 project 条目锁定的 projectKey(服务端会以 session.cwd 权威重盖,前端如实回传避免丢字段)。
  const pkByKey = new Map((Array.isArray(session.memories) ? session.memories : []).filter(x => x && x.id).map(x => [((x.scope === 'global') ? 'global' : 'project') + ':' + x.id, x.projectKey]));
  const cur = [...enabled].map(k => { const i = k.indexOf(':'); const scope = k.slice(0, i), id = k.slice(i + 1); const o = { scope, id }; if (scope === 'project' && pkByKey.get(k)) o.projectKey = pkByKey.get(k); return o; });
  let next;
  if (enabled.has(key)) next = cur.filter(x => (x.scope + ':' + x.id) !== key);
  else { const fixedMax = memoryLimitValue('fixedSelectionMax', 'memoryFixedSelectionMaxV1', 64); if (cur.length >= fixedMax) { toast(t("toast.memoryMax8", { count: fixedMax }), 'err'); return; } next = cur.concat({ scope: m.scope, id: m.id }); }
  try {
    const r = await api('/api/session/memories', { method: 'POST', body: JSON.stringify({ sessionId: session.id, memories: next }) });
    session.memories = (r && Array.isArray(r.memories)) ? r.memories : next;
    session.memoriesExplicit = true;
    session.memoryExclusions = [];
    toast(enabled.has(key) ? t('memory.toast.disabled', { name: m.name || m.id }) : t('memory.toast.enabled', { name: m.name || m.id }));
  } catch (e) { toast(t('toast.memorySetFail', { err: apiErrText(e) }), 'err'); }
}
async function disableMemoryForSession(btn) {
  const session = state.currentSession; if (!session) return;
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/session/memories', { method: 'POST', body: JSON.stringify({ sessionId: session.id, memories: [] }) });
    session.memories = (r && Array.isArray(r.memories)) ? r.memories : [];
    session.memoriesExplicit = true;
    session.memoryExclusions = [];
    toast(t('memory.toast.sessionDisabled'));
    renderMemoryViews();
  } catch (e) { toast(t('toast.memorySetFail', { err: apiErrText(e) }), 'err'); if (btn) btn.disabled = false; }
}
async function restoreDefaultMemoryPolicy(btn) {
  const session = state.currentSession; if (!session) return;
  if (btn) btn.disabled = true;
  try {
    const r = await api('/api/session/memories', { method: 'POST', body: JSON.stringify({ sessionId: session.id, useDefault: true, memoryExclusions: [] }) });
    session.memories = [];
    session.memoriesExplicit = false;
    session.memoryExclusions = (r && Array.isArray(r.memoryExclusions)) ? r.memoryExclusions : [];
    toast(t('memory.toast.defaultsRestored'));
    renderMemoryViews();
  } catch (e) { toast(t('toast.memorySetFail', { err: apiErrText(e) }), 'err'); if (btn) btn.disabled = false; }
}
async function removeGhostMemory(m) {
  const session = state.currentSession;
  if (!session) return;
  const cur = (Array.isArray(session.memories) ? session.memories : []).filter(x => x && x.id);
  const next = cur.filter(x => !(x.id === m.id && ((x.scope === 'global') ? 'global' : 'project') === ((m.scope === 'global') ? 'global' : 'project')));
  try {
    const r = await api('/api/session/memories', { method: 'POST', body: JSON.stringify({ sessionId: session.id, memories: next }) });
    session.memories = (r && Array.isArray(r.memories)) ? r.memories : next;
    session.memoriesExplicit = true;
    toast(t("toast.memoryPruned", { p1: m.id }));
  } catch (e) { toast(t('toast.removeFail', { err: apiErrText(e) }), 'err'); return; }
  renderMemoryViews();
}
async function deleteMemoryRow(m) {
  if (!confirm(t('memory.deleteConfirm', { name: m.name || m.id }))) return;
  try {
    const r = await api('/api/memory/' + encodeURIComponent(m.id), { method: 'POST', headers: { 'x-http-method': 'DELETE' }, body: JSON.stringify({ scope: m.scope, cwd: currentWorkspace() || '' }) });
    if (!r || !r.ok) { toast(t("toast.deleteFail", { p1: apiErrText(r && r.error) || t('common.unknownError') }), 'err'); return; }
    toast(t("toast.memoryDeleted"), 'ok');
  } catch (e) { toast(t("toast.deleteFail", { p1: apiErrText(e) }), 'err'); return; }
  await refreshMemoryViews();
}
async function migrateGroupToCurrent(p) {
  if (!(p.items || []).length) return;
  if (!confirm(t('memory.migrateConfirm', { label: p.label || p.projectKey, count: p.count }))) return;
  // P2-4: 逐条结果上浮,不静默——迁移 N 条、M 条冲突(目标已有同名 → 409）跳过、K 条其它失败。
  let okCount = 0, conflictCount = 0, errCount = 0;
  for (const item of p.items) {
    try {
      const r = await api('/api/memory/migrate', { method: 'POST', body: JSON.stringify({ id: item.id, fromKey: p.projectKey, cwd: currentWorkspace() || '' }) });
      if (r && r.ok) okCount++; else errCount++;
    } catch (e) {
      // api() 对非 2xx 抛错,错误体(JSON)带 conflict 标记 → 归入「冲突跳过」,其它失败单列。
      let conflict = false; try { const j = JSON.parse((e && e.message) || ''); conflict = j && j.conflict === true; } catch { /* not json */ }
      if (conflict) conflictCount++; else errCount++;
    }
  }
  const parts = [];
  if (okCount) parts.push(t('memory.migrateResult.migrated', { count: okCount }));
  if (conflictCount) parts.push(t('memory.migrateResult.conflicts', { count: conflictCount }));
  if (errCount) parts.push(t('memory.migrateResult.failed', { count: errCount }));
  toast(parts.length ? parts.join(t('memory.migrateResult.separator')) : t('memory.noMigratable'), okCount ? 'ok' : 'err');
  await refreshMemoryViews();
}
// 从当前会话起草(provider 引擎):draft → 编辑弹窗 → 保存。
async function saveAsMemory(btn, sessionId = '') {
  const sid = String(sessionId || (state.currentSession && state.currentSession.id) || '');
  if (!sid) { toast(t("toast.noSessionToSave"), 'err'); return; }
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = t('common.drafting'); }
  try {
    const r = await api('/api/memory/draft', { method: 'POST', body: JSON.stringify({ sessionId: sid }) });
    if (!r || !r.ok || !r.draft) { toast(t("toast.draftFail", { p1: apiErrText(r && r.error) || t('common.unknownError') }), 'err'); return; }
    openMemoryEditModal({ ...r.draft, scope: 'project', _isDraft: true });
  } catch (e) { toast(t("toast.draftFail", { p1: apiErrText(e) }), 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
}
async function settleMemoryProposal(sessionId, proposalId, decision) {
  if (!sessionId || !proposalId) return;
  try {
    await api('/api/memory/proposal/decision', { method: 'POST', body: JSON.stringify({ sessionId, proposalId, decision }) });
  } catch { /* 候选状态是降噪元数据；失败不能阻断保存或把安静提示升级成报错 */ }
}

// 回合结束后的低打扰入口。服务端已经完成“信号预筛 → 同模型严格裁决 → 冷却/去重/敏感过滤”；
// proposal:null 是最常见且完全安静的结果。卡片只提供审阅入口，绝不自动写入记忆库。
async function suggestMemoryFromTurn(sessionId, host) {
  if (!sessionId || !host || !host.isConnected || state.currentSession?.id !== sessionId) return;
  let result;
  try { result = await api('/api/memory/proposal', { method: 'POST', body: JSON.stringify({ sessionId }) }); }
  catch { return; }
  if (!result || !result.ok || !result.proposal || !result.proposalId) return;
  if (!host.isConnected || state.currentSession?.id !== sessionId) return;
  renderMemoryProposalResult(sessionId, host, result);
}
// 打开线程 / 刷新页面后,把服务端仍待确认的候选卡画回来。修前卡片只在回合刚结束那一刻画一次(全前端唯一调用点是
// suggestMemoryFromTurn),刷新、切线程、回合被中断之后卡就没了,候选却在服务端一直 pending 到下一回合被顶掉。
// 走 replay:true 的只读回放(服务端不跑自动审稿、不写状态);卡挂在最后一条助手消息上,与回合刚结束时画的位置一致。
// 不重复画:同一个 proposalId 的卡已经在对话里了就什么都不做;回合刚结束再画新卡时,renderMemoryProposalResult 会先摘掉旧卡。
async function restoreMemoryProposalCard(sessionId) {
  if (!sessionId || state.currentSession?.id !== sessionId) return;
  let result;
  try { result = await api('/api/memory/proposal', { method: 'POST', body: JSON.stringify({ sessionId, replay: true }) }); }
  catch { return; }
  if (!result || !result.ok || !result.proposal || !result.proposalId) return;
  if (state.currentSession?.id !== sessionId) return;
  const box = $('messages');
  if (!box) return;
  const hosts = box.querySelectorAll('article.message.assistant .msg-main');
  const host = hosts[hosts.length - 1];
  if (!host || !host.isConnected) return;
  for (const card of box.querySelectorAll('.memory-proposal-card')) if (card.dataset.proposalId === String(result.proposalId)) return;
  renderMemoryProposalResult(sessionId, host, result);
}
function memoryScopeText(scope) { return scope === 'global' ? t('memory.scope.global') : t('memory.scope.project'); }
// 候选卡上的作用域下拉(单条卡与批量卡每一条共用):用户保存前随时能在「全局 / 项目」之间改。
function buildMemoryScopeSelect(scope) {
  const sel = el('select', 'memory-proposal-scope');
  sel.setAttribute('aria-label', t('memory.proposal.scopeAria'));
  for (const v of ['global', 'project']) { const o = el('option', '', memoryScopeText(v)); o.value = v; sel.appendChild(o); }
  sel.value = scope === 'global' ? 'global' : 'project';
  return sel;
}
// 「AI 建议全局、被保守原则改成了项目」的人话。没被改过的候选返回空串;chosen = 下拉当前值(用户改回全局后换一句)。
function memoryScopeNoteText(item, chosen) {
  if (!item || item.scopeAdjusted !== true || item.requestedScope !== 'global') return '';
  if (chosen === 'global') return t('memory.proposal.scopeRestored', { requested: memoryScopeText('global') });
  return t('memory.proposal.scopeAdjusted', { requested: memoryScopeText('global'), final: memoryScopeText(item.scope) });
}
// 画一张候选卡(回合刚结束与回放共用)。同一会话界面最多保留一张候选卡；跨多轮未处理的旧卡不会和新卡堆叠。
function renderMemoryProposalResult(sessionId, host, result) {
  const messages = host.closest && host.closest('#messages');
  for (const old of (messages ? messages.querySelectorAll('.memory-proposal-card') : [])) old.remove();
  const proposal = result.proposal;
  const kind = proposal.kind || 'memory';
  // C3:一次提议里 2–3 条新记忆 → 一张批量卡(逐条勾选)。其余 kind 仍是下面这张单条卡,形状不变。
  if (kind === 'memory_batch') { host.appendChild(buildMemoryBatchProposalCard(sessionId, result)); return; }
  const card = el('section', 'memory-proposal-card');
  card.dataset.proposalId = String(result.proposalId);
  card.setAttribute('aria-label', t('memory.proposal.aria'));
  const head = el('div', 'memory-proposal-head');
  if (kind === 'relation_propose') head.append(el('span', 'memory-proposal-kicker', t('memory.proposal.kickerRelation')));
  else if (kind === 'relation_revoke') head.append(el('span', 'memory-proposal-kicker', t('memory.proposal.kickerRevoke')));
  else if (kind === 'memory_revise') head.append(el('span', 'memory-proposal-kicker', t('memory.proposal.kickerRevise')));
  else head.append(el('span', 'memory-proposal-kicker', t('memory.proposal.kicker')));
  const tags = el('span', 'memory-proposal-tags');
  let scopeSelect = null;
  let reviseFrom = '', reviseTo = '';
  if (kind === 'relation_propose') {
    tags.append(
      el('span', 'memory-proposal-tag', memoryScopeText(proposal.scope)),
      el('span', 'memory-proposal-tag', proposal.relationType || ''),
    );
  } else if (kind === 'relation_revoke') {
    tags.append(el('span', 'memory-proposal-tag', memoryScopeText(proposal.scope)));
  } else if (kind === 'memory_revise') {
    // 修订建议只有 targetScope(没有 scope):修前这里读 proposal.scope,恒为 undefined → 标签永远是「项目」,哪怕目标是全局记忆。
    // 带 newScope = 提议换作用域,标签写「项目 → 全局」。
    reviseFrom = (proposal.scope || proposal.targetScope) === 'global' ? 'global' : 'project';
    reviseTo = proposal.newScope === 'global' || proposal.newScope === 'project' ? proposal.newScope : reviseFrom;
    tags.append(
      el('span', 'memory-proposal-tag', reviseTo !== reviseFrom ? t('memory.proposal.scopeMove', { from: memoryScopeText(reviseFrom), to: memoryScopeText(reviseTo) }) : memoryScopeText(reviseFrom)),
      el('span', 'memory-proposal-tag', memoryTypeLabel(proposal.type)),
    );
  } else {
    scopeSelect = buildMemoryScopeSelect(proposal.scope);
    tags.append(scopeSelect, el('span', 'memory-proposal-tag', memoryTypeLabel(proposal.type)));
  }
  head.appendChild(tags);
  let title = proposal.name || '';
  let desc = proposal.description || '';
  if (kind === 'relation_propose') { title = (proposal.from || '') + ' ' + (proposal.relationType || '') + ' ' + (proposal.to || ''); desc = proposal.note || proposal.description || ''; }
  else if (kind === 'relation_revoke') { title = proposal.relation ? (proposal.relation.type + ' ' + proposal.relation.from + ' → ' + proposal.relation.to) : (proposal.relationId || ''); desc = proposal.note || ''; }
  card.append(head, el('div', 'memory-proposal-title', title), el('div', 'memory-proposal-desc', desc));
  if (scopeSelect) {
    const note = el('div', 'memory-proposal-scope-note', memoryScopeNoteText(proposal, scopeSelect.value));
    note.hidden = !note.textContent;
    scopeSelect.onchange = () => { note.textContent = memoryScopeNoteText(proposal, scopeSelect.value); note.hidden = !note.textContent; };
    card.appendChild(note);
  } else if (reviseTo !== reviseFrom) {
    card.appendChild(el('div', 'memory-proposal-scope-note', t('memory.proposal.moveNote', { from: memoryScopeText(reviseFrom), to: memoryScopeText(reviseTo) })));
  }
  if (proposal.reason) card.appendChild(el('div', 'memory-proposal-reason', t('memory.proposal.reason', { reason: proposal.reason })));
  const actions = el('div', 'memory-proposal-actions');
  const dismiss = el('button', 'mini', t('memory.proposal.dismiss'));
  const review = el('button', 'mini primary', kind === 'memory' ? t('memory.proposal.review') : t('memory.proposal.apply'));
  actions.append(dismiss, review); card.appendChild(actions);
  const removeCard = () => { card.classList.add('settled'); setTimeout(() => card.remove(), 160); };
  dismiss.onclick = () => {
    dismiss.disabled = true; review.disabled = true;
    settleMemoryProposal(sessionId, result.proposalId, 'dismissed');
    removeCard();
  };
  review.onclick = async () => {
    if (review.disabled) return;
    review.disabled = true;
    if (kind === 'memory') {
      openMemoryEditModal({ ...proposal, scope: scopeSelect ? scopeSelect.value : (proposal.scope || 'project'), _isDraft: true, _proposalId: result.proposalId, _onProposalSaved: removeCard, _onProposalEditCancelled: () => { if (card.isConnected) review.disabled = false; } });
      return;
    }
    // 维护提议(改记忆/建边/撤边)：确认后由后端 apply 落盘，模型不直接写。
    try {
      const r = await api('/api/memory/proposal/apply', { method: 'POST', body: JSON.stringify({ sessionId, proposalId: result.proposalId, cwd: currentWorkspace() || '' }) });
      if (!r || !r.ok) throw new Error(apiErrText(r && r.error) || t('common.unknownError'));
      if (r.applied && r.applied.moved) toast(memoryMovedToast(r.applied), 'ok');
      else toast(t('memory.proposal.applied'), 'ok');
      removeCard();
      await refreshMemoryViews();   // 128f-⑫（审计 D）：修前工具箱／记忆弹窗开着的话还是应用之前那一份
    } catch (error) {
      toast(t('memory.proposal.applyFailed', { err: apiErrText(error) }), 'err');
      if (card.isConnected) review.disabled = false;
    }
  };
  host.appendChild(card);
}
// 换作用域落盘后的提示(服务端回 moved:{ to, relationsDropped });不是换作用域返回空串,调用方走原来的「已保存/已应用」。
function memoryMovedToast(res) {
  const moved = res && res.moved;
  if (!moved) return '';
  const scope = memoryScopeText(moved.to);
  const dropped = Math.max(0, Math.floor(Number(moved.relationsDropped) || 0));
  return dropped ? tCount('memory.proposal.movedDropped', dropped, { scope }) : t('memory.proposal.moved', { scope });
}
// C3 批量候选卡:模型一次提议的 2–3 条相互独立的新记忆。每条一行(勾选框默认勾上、名称、作用域下拉/类型、何时有用、
// 提议原因、「加入核心」开关,正文收在「正文(N 字)」折叠里);「保存选中」只存勾上的(后端按 accept 逐条落盘,其余记成忽略),
// 「全部忽略」整张丢弃。和单条卡一样:不点就什么都不写。保存失败时卡片留着、勾选不丢,再点只重试还没存上的。
// 每条的作用域与「加入核心」都在卡上可见可改(修前批量卡没有作用域控件,保存直接落 project,偏好/惯例还悄悄进核心 = 每轮注入)。
// 默认仍全勾:这些是模型已筛过的 ≤3 条,逐条可见可改,且不点「保存选中」什么都不写 —— 默认全不勾只会让常见的 2–3 条多点 3 下。
function buildMemoryBatchProposalCard(sessionId, result) {
  const proposal = result.proposal || {};
  const items = Array.isArray(proposal.items) ? proposal.items : [];
  // 回放时可能已有几条存/忽略过(部分保存后失败):只画还待确认的,下标仍是 proposal.items 里的原位置(apply 的 accept 按它)。
  const entries = items.map((item, index) => ({ item, index })).filter(e => e.item && (!e.item.status || e.item.status === 'pending'));
  const card = el('section', 'memory-proposal-card memory-proposal-batch');
  card.dataset.proposalId = String(result.proposalId);
  card.setAttribute('aria-label', t('memory.proposal.aria'));
  const head = el('div', 'memory-proposal-head');
  head.append(el('span', 'memory-proposal-kicker', t('memory.proposal.kickerBatch', { count: entries.length })));
  card.appendChild(head);
  const list = el('div', 'memory-proposal-items');
  const rows = entries.map(({ item, index }) => {
    const row = el('div', 'memory-proposal-item');
    row.dataset.index = String(index);
    const top = el('div', 'memory-proposal-item-head');
    const pick = el('label', 'check memory-proposal-pick');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = true;
    box.setAttribute('aria-label', t('memory.proposal.batchPick', { name: item.name || '' }));
    pick.append(box, el('span', 'memory-proposal-title', item.name || ''));
    const scopeSel = buildMemoryScopeSelect(item.scope);
    const tags = el('span', 'memory-proposal-tags');
    tags.append(scopeSel, el('span', 'memory-proposal-tag', memoryTypeLabel(item.type)));
    top.append(pick, tags);
    row.append(top, el('div', 'memory-proposal-desc', item.description || ''));
    const note = el('div', 'memory-proposal-scope-note', memoryScopeNoteText(item, scopeSel.value));
    note.hidden = !note.textContent;
    scopeSel.onchange = () => { note.textContent = memoryScopeNoteText(item, scopeSel.value); note.hidden = !note.textContent; };
    row.appendChild(note);
    if (item.reason) row.appendChild(el('div', 'memory-proposal-reason', t('memory.proposal.reason', { reason: item.reason })));
    // 「加入核心」= 这条的 description 会成为每轮注入的核心摘要:默认与单条弹窗一致(偏好/惯例开,其余关),卡上可见可改。
    // 用 aria-pressed 的开关按钮而不是复选框:这一行里的 input[type=checkbox] 只留「保存这条」那一个。
    let coreOn = item.type === 'preference' || item.type === 'convention';
    const coreBtn = el('button', 'memory-proposal-core');
    coreBtn.type = 'button';
    const paintCore = () => { coreBtn.setAttribute('aria-pressed', coreOn ? 'true' : 'false'); coreBtn.textContent = coreOn ? t('memory.proposal.coreOn') : t('memory.proposal.coreOff'); };
    paintCore();
    coreBtn.onclick = () => { coreOn = !coreOn; paintCore(); };
    const opts = el('div', 'memory-proposal-opts');
    opts.appendChild(coreBtn);
    row.appendChild(opts);
    const more = el('details', 'memory-proposal-body');
    more.append(el('summary', '', t('memory.proposal.batchBody') + t('memory.proposal.batchBodyCount', { count: String(item.body || '').length })), el('div', 'memory-proposal-body-text', item.body || ''));
    row.appendChild(more);
    list.appendChild(row);
    return { index, box, scopeSel, coreBtn, core: () => coreOn, scope0: scopeSel.value, core0: coreOn };
  });
  card.appendChild(list);
  const actions = el('div', 'memory-proposal-actions');
  const dismiss = el('button', 'mini', t('memory.proposal.dismissAll'));
  const save = el('button', 'mini primary', '');
  actions.append(dismiss, save);
  card.appendChild(actions);
  let busy = false;
  const picked = () => rows.filter(r => r.box.checked).map(r => r.index);
  const sync = () => {
    const count = picked().length;
    save.textContent = t('memory.proposal.saveSelected', { count });
    save.disabled = busy || count === 0;   // 一条都不勾 = 用「全部忽略」
    dismiss.disabled = busy;
    for (const r of rows) { r.box.disabled = busy; r.scopeSel.disabled = busy; r.coreBtn.disabled = busy; }
  };
  for (const r of rows) r.box.onchange = sync;
  sync();
  const removeCard = () => { card.classList.add('settled'); setTimeout(() => card.remove(), 160); };
  dismiss.onclick = () => {
    if (busy) return;
    busy = true; sync();
    settleMemoryProposal(sessionId, result.proposalId, 'dismissed');
    removeCard();
  };
  save.onclick = async () => {
    const accept = picked();
    if (busy || !accept.length) return;
    busy = true; sync();
    // 用户在卡上改过的才交给后端(后端只认 scope / core 两个字段;没改的条目按提议原值,与卡上画的默认一致)。
    // 一条都没改时不带 overrides —— 请求体与修前逐字相同。
    const overrides = {};
    for (const r of rows) {
      if (!r.box.checked) continue;
      const change = {};
      if (r.scopeSel.value !== r.scope0) change.scope = r.scopeSel.value;
      if (r.core() !== r.core0) change.core = r.core();
      if (Object.keys(change).length) overrides[r.index] = change;
    }
    const body = { sessionId, proposalId: result.proposalId, cwd: currentWorkspace() || '', accept };
    if (Object.keys(overrides).length) body.overrides = overrides;
    try {
      const r = await api('/api/memory/proposal/apply', { method: 'POST', body: JSON.stringify(body) });
      if (!r || !r.ok) throw new Error((r && r.error) || t('common.unknownError'));
      toast(tCount('memory.proposal.batchSaved', Array.isArray(r.saved) ? r.saved.length : accept.length), 'ok');
      removeCard();
      await refreshMemoryViews();
    } catch (error) {
      toast(t('memory.proposal.applyFailed', { err: apiErrText(error) }), 'err');
      busy = false;
      if (card.isConnected) sync();
    }
  };
  return card;
}
// 编辑/新建弹窗。编辑现有项时先拉全文回填正文(注册表不带 body)。
async function openMemoryEditModal(m) {
  let full = m;
  if (m && m.id && !m._isDraft && m.body == null) {
    try {
      const r = await api(`/api/memory/item?id=${encodeURIComponent(m.id)}&scope=${m.scope}&cwd=${encodeURIComponent(currentWorkspace() || '')}`);
      if (r && r.ok && r.memory) full = { ...m, ...r.memory };
    } catch { /* 回填失败则空正文 */ }
  }
  const editing = !!(m && m.id && !m._isDraft);
  const body = el('div', 'pb-form');
  const mkField = (label, value, rows) => {
    const field = el('div', 'pb-field');
    field.appendChild(el('label', 'pb-field-label', label));
    const ta = el(rows > 1 ? 'textarea' : 'input', 'pb-field-input');
    if (rows > 1) ta.rows = rows; else ta.type = 'text';
    ta.value = value || '';
    field.appendChild(ta); body.appendChild(field);
    return ta;
  };
  const nameEl = mkField(t('memory.edit.name'), full ? full.name : '', 1);
  const descEl = mkField(t('memory.edit.description'), full ? full.description : '', 2);
  const typeField = el('div', 'pb-field'); typeField.appendChild(el('label', 'pb-field-label', t('memory.edit.type')));
  const typeSel = el('select', 'pb-field-input');
  for (const [v, label] of [['preference', t('memory.edit.typePreference')], ['convention', t('memory.edit.typeConvention')], ['lesson', t('memory.edit.typeLesson')], ['reference', t('memory.edit.typeReference')]]) { const o = el('option', '', label); o.value = v; if (full && full.type === v) o.selected = true; typeSel.appendChild(o); }
  typeField.appendChild(typeSel); body.appendChild(typeField);
  const scopeField = el('div', 'pb-field'); scopeField.appendChild(el('label', 'pb-field-label', t('memory.edit.scope')));
  const scopeSel = el('select', 'pb-field-input');
  for (const [v, label] of [['project', t('memory.edit.scopeProject')], ['global', t('memory.edit.scopeGlobal')]]) { const o = el('option', '', label); o.value = v; if (((full && full.scope) || 'project') === v) o.selected = true; scopeSel.appendChild(o); }
  // 编辑态也能改范围(项目 ↔ 全局):实现为「另存到新范围 + 删旧的」,服务端一步做完、失败回滚(POST /api/memory 的 moveFromScope)。
  // 修前这里是灰的,项目记忆一旦存成项目就升不了全局,唯一出路是手工删了重建。
  const originalScope = editing ? ((m && m.scope) === 'global' ? 'global' : 'project') : '';
  const scopeHint = el('p', 'field-help muted', t('memory.edit.scopeMoveHint'));
  scopeHint.hidden = true;
  scopeSel.onchange = () => { scopeHint.hidden = !(editing && scopeSel.value !== originalScope); };
  scopeField.append(scopeSel, scopeHint); body.appendChild(scopeField);
  const corePanel = el('div', 'memory-edit-core');
  const coreLabel = el('label', 'check memory-core-check');
  const coreCheck = el('input'); coreCheck.type = 'checkbox';
  const hasCoreChoice = !!(full && Object.prototype.hasOwnProperty.call(full, 'core'));
  coreCheck.checked = hasCoreChoice ? full.core === true : ['preference', 'convention'].includes(typeSel.value);
  coreLabel.append(coreCheck, el('span', '', t('memory.edit.core')));
  corePanel.append(coreLabel, el('p', 'field-help muted', t('memory.edit.coreHint')));
  body.appendChild(corePanel);
  let coreTouched = hasCoreChoice;
  coreCheck.onchange = () => { coreTouched = true; };
  typeSel.onchange = () => { if (!coreTouched) coreCheck.checked = ['preference', 'convention'].includes(typeSel.value); };
  const coreSummaryEl = mkField(t('memory.edit.coreSummary'), full ? full.coreSummary : '', 3);
  coreSummaryEl.maxLength = 520;
  // 核心摘要每轮注入,说明改了摘要却还停在旧文字就是在注入旧内容。摘要还只是「说明的副本」(没单独写过)时,说明一改它就跟着改;
  // 一旦用户自己动过摘要(与说明不同了)就不再自动跟。服务端 saveMemory 对同一情形有同口径兜底。
  let summaryFollows = !!(full && full.coreSummary) && String(full.coreSummary).trim() === String(full.description || '').trim();
  descEl.addEventListener('input', () => { if (summaryFollows) coreSummaryEl.value = descEl.value.trim().slice(0, 520); });
  coreSummaryEl.addEventListener('input', () => { summaryFollows = coreSummaryEl.value.trim() === descEl.value.trim(); });
  const importanceField = el('div', 'pb-field'); importanceField.appendChild(el('label', 'pb-field-label', t('memory.edit.importance')));
  const importanceSel = el('select', 'pb-field-input');
  for (const [v, label] of [['normal', t('memory.edit.importanceNormal')], ['important', t('memory.edit.importanceImportant')]]) { const o = el('option', '', label); o.value = v; if (((full && full.importance) || 'normal') === v) o.selected = true; importanceSel.appendChild(o); }
  importanceField.appendChild(importanceSel); body.appendChild(importanceField);
  const dates = el('div', 'memory-edit-dates');
  const dateField = (label, value) => { const field = el('div', 'pb-field'); field.appendChild(el('label', 'pb-field-label', label)); const input = el('input', 'pb-field-input'); input.type = 'date'; input.value = String(value || '').slice(0, 10); field.appendChild(input); dates.appendChild(field); return input; };
  const reviewEl = dateField(t('memory.edit.reviewAfter'), full ? full.reviewAfter : '');
  const expiresEl = dateField(t('memory.edit.expiresAt'), full ? full.expiresAt : '');
  body.appendChild(dates);
  const bodyTa = mkField(t('memory.edit.body'), full ? full.body : '', 8);
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', t('common.cancel'));
  const save = el('button', 'primary', t('common.save'));
  foot.append(cancel, save);
  let editSettled = false;
  const settleEditCancel = () => {
    if (editSettled) return;
    editSettled = true;
    if (full && typeof full._onProposalEditCancelled === 'function') full._onProposalEditCancelled();
  };
  // 点背影／Esc／✕ 关弹层前问一句：表单与打开时不一样就算「有没存的改动」（一段记忆正文可能敲了好几分钟）。
  const editSnapshot = () => JSON.stringify([nameEl.value, descEl.value, typeSel.value, scopeSel.value, coreCheck.checked,
    coreSummaryEl.value, importanceSel.value, reviewEl.value, expiresEl.value, bodyTa.value]);
  const editBaseline = editSnapshot();
  const modal = buildModal(editing ? t('memory.edit.title') : t('memory.edit.create.title'), body, foot, settleEditCancel,
    { dirty: () => editSnapshot() !== editBaseline });
  cancel.onclick = () => { settleEditCancel(); modal.close(); };
  save.onclick = async () => {
    const memory = { name: nameEl.value.trim(), description: descEl.value.trim(), type: typeSel.value, body: bodyTa.value, scope: scopeSel.value,
      core: coreCheck.checked, coreSummary: coreSummaryEl.value.trim(), importance: importanceSel.value,
      reviewAfter: reviewEl.value || '', expiresAt: expiresEl.value || '' };
    if (editing) memory.id = m.id;
    if (full && full.sourceSessionId) memory.sourceSessionId = full.sourceSessionId;
    if (!memory.name || !memory.body.trim()) { toast(t("toast.memoryFieldsRequired"), 'err'); return; }
    save.disabled = true; save.textContent = t('common.saving');
    const restoreSave = () => { save.disabled = false; save.textContent = t('common.save'); };
    try {
      const payload = { memory, cwd: currentWorkspace() || '' };
      if (editing && scopeSel.value !== originalScope) payload.moveFromScope = originalScope;
      if (full && full._proposalId && full.sourceSessionId) { payload.proposalId = full._proposalId; payload.sourceSessionId = full.sourceSessionId; }
      const r = await api('/api/memory', { method: 'POST', body: JSON.stringify(payload) });
      // 存失败时弹层【不关】：修前先 close 再判 r.ok，一次失败就把用户刚敲的整段正文一起扔掉。
      // 失败 = 报原因 + 把「保存」还给用户，改一改或稍后再点即可。
      if (!r || !r.ok) { toast(t("toast.saveFail", { p1: apiErrText(r && r.error) || t('common.unknownError') }), 'err'); restoreSave(); return; }
      modal.close();
      toast(memoryMovedToast(r) || t("toast.memorySaved"), 'ok');
      editSettled = true;
      if (full && full._proposalId && full.sourceSessionId) {
        // The save route settles this server-side; this idempotent best-effort call is
        // a fallback for metadata write failures and older backends.
        settleMemoryProposal(full.sourceSessionId, full._proposalId, 'saved');
        if (typeof full._onProposalSaved === 'function') full._onProposalSaved();
      }
      await refreshMemoryViews();
    } catch (e) { toast(t("toast.saveFail", { p1: apiErrText(e) }), 'err'); restoreSave(); }
  };
}

/* ---------------- command palette ---------------- */

  function bindSkillsMemory() {
    const skillButton = $('skillBtn');
    if (skillButton) skillButton.onclick = openSkillPanel;
    const search = $('skillSearch');
    if (search) {
      search.addEventListener('input', () => { skillIndex = 0; renderSkillList(); });
      search.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return; // 输入法选字中:回车/方向键归输入法
        if (event.key === 'ArrowDown') { event.preventDefault(); moveSkillSel(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); moveSkillSel(-1); }
        else if (event.key === 'Enter') { event.preventDefault(); pickSkill(skillIndex); }
      });
    }
    const memoryAdd = $('memoryToolboxAddBtn');
    if (memoryAdd) memoryAdd.onclick = () => openMemoryEditModal(null);
    const memoryRefresh = $('memoryToolboxRefreshBtn');
    if (memoryRefresh) memoryRefresh.onclick = () => openMemoryToolbox();
    const memorySearch = $('memoryToolboxSearch');
    if (memorySearch) memorySearch.addEventListener('input', renderMemoryToolbox);
    document.querySelectorAll('[data-memory-filter]').forEach(button => {
      button.onclick = () => {
        memoryToolboxFilter = button.dataset.memoryFilter || 'all';
        document.querySelectorAll('[data-memory-filter]').forEach(item => {
          const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        renderMemoryToolbox();
      };
    });
  }

  // 设置页「技能与模板」(settings-skills.js)要用的那几件:显示名/说明/来源、常驻判据与开关、删除确认,都是上面同一份实现。
  const settingsSkillsApi = Object.freeze({
    RESIDENT_SKILL_MAX,
    confirmDeleteSkill,
    refreshSkillRegistry,
    residentSkillIds,
    skillDisplayDescription,
    skillDisplayName,
    skillDisplaySource,
    skillDisplayUnavailableReason,
    toggleResidentSkill,
  });

  return Object.freeze({
    settingsSkillsApi,
    bindSkillsMemory,
    builtinPlaybookTextKey,
    openMemoryPanel,
    openMemoryToolbox,
    openSkillPanel,
    pickSkill,
    playbookDisplayDescription,
    playbookDisplayName,
    playbookDisplayUnavailableReason,
    playbookInputLabel,
    playbookStatusText,
    renderSkillList,
    restoreMemoryProposalCard,
    saveAsMemory,
    suggestMemoryFromTurn,
    updateSkillBadge,
  });
}
