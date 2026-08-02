'use strict';

// EC-D：技能、命令、Playbook 与记忆库领域。
import { state } from './state.js';
import { api } from './net.js';
import { $, el, escapeHtml, autoGrow, toast } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

export function createSkillsMemoryDomain({
  apiErrText = error => String(error && error.message || error || ''),
  currentWorkspace = () => '',
  closeModal = () => {},
  openModal = () => {},
  buildModal = () => null,
  isProviderMode = () => false,
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
  const key = ({ project: 'skills.source.project', user: 'skills.source.user', builtin: 'skills.source.builtin' })[entry?.source];
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
async function openSkillPanel() {
  openModal('skillModal');
  const s = $('skillSearch'); s.value = ''; skillIndex = 0; s.focus();
  $('skillList').innerHTML = `<div class="muted">${escapeHtml(t('skills.loading'))}</div>`;
  // 每次打开都刷新:项目级技能随 cwd 变、可用性随能力矩阵变、启用状态随会话变。cwd 传当前会话工作目录。
  try { skillRegistry = (await api('/api/skills?cwd=' + encodeURIComponent(currentWorkspace() || ''))).skills || []; }
  catch { skillRegistry = []; }
  renderSkillList();
}
function renderSkillList() {
  const q = $('skillSearch').value.trim().toLowerCase();
  const all = skillRegistry || [];
  const match = s => skillMatchesQuery(s, q);
  const skills = all.filter(s => s.kind === 'skill' && match(s));
  const commands = all.filter(s => s.kind === 'command' && match(s));
  const playbooks = all.filter(s => s.kind === 'playbook' && match(s));
  skillFiltered = [...skills, ...commands, ...playbooks]; // 拍平的显示顺序(与 .skill-item DOM 顺序一致)
  if (skillIndex >= skillFiltered.length) skillIndex = Math.max(0, skillFiltered.length - 1);
  const list = $('skillList'); list.innerHTML = '';
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

let residentSkillTogglePending = false;
async function toggleResidentSkill(entry) {
  if (residentSkillTogglePending || entry.available === false) return;
  const current = residentSkillEntries();
  const on = current.some(x => (typeof x === 'string' ? x : x && x.id) === entry.id);
  let next = current.filter(x => (typeof x === 'string' ? x : x && x.id) !== entry.id);
  if (!on) {
    if (next.length >= 8) { toast(t('skills.toast.maxResident', { count: 8 }), 'err'); return; }
    next.push({ id: entry.id, source: entry.source || '' });
  }
  residentSkillTogglePending = true;
  const ok = await saveConfigPartial({ residentSkills: next });
  residentSkillTogglePending = false;
  if (ok) toast(on ? t('skills.toast.residentDisabled', { name: skillDisplayName(entry) }) : t('skills.toast.residentEnabled', { name: skillDisplayName(entry) }));
  renderSkillList(); updateSkillBadge();
}
// 命令卡(仅 Claude 模式):中文名主显 + mono /insert 小字。点击插入 /name 到输入框(保留旧行为)。
function buildCommandRow(s, i) {
  const it = el('div', `skill-item sk-card${i === skillIndex ? ' sel' : ''}`);
  const head = el('div', 'sk-card-h');
  head.appendChild(skillCardIco('command', s));
  head.appendChild(el('span', 'sk-name', skillDisplayName(s)));
  it.appendChild(head);
  it.appendChild(el('code', 'sk-id', s.insert || ('/' + s.id)));
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
  return isProviderMode() ? (entry.prompt || entry.description || entry.name || '') : (entry.insert || ('/' + entry.id));
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
  if (unavailable && unavailableReason) it.appendChild(el('div', 'sk-reason', unavailableReason));
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
let memoryToggleChain = Promise.resolve();
const memoryTogglePending = new Set();
// 会话有效启用集(effectiveMemorySelection 的前端镜像):显式设置过 → session.memories;否则默认——当前项目记忆全启用。
function enabledMemoryKeySet() {
  const session = state.currentSession;
  if (session && session.memoriesExplicit === true) {
    const arr = Array.isArray(session.memories) ? session.memories : [];
    return new Set(arr.map(m => ((m && m.scope === 'global') ? 'global' : 'project') + ':' + (m && m.id)).filter(k => !k.endsWith(':')));
  }
  return new Set((memoryRegistry || []).filter(e => e.scope === 'project').slice(0, 8).map(e => 'project:' + e.id));
}
async function openMemoryPanel() {
  openModal('memoryModal');
  $('memoryList').innerHTML = '<div class="muted">' + t('common.loading') + '</div>';
  try {
    const r = await api('/api/memory?cwd=' + encodeURIComponent(currentWorkspace() || ''));
    memoryRegistry = (r && r.memories) || [];
    memoryOtherProjects = (r && r.otherProjects) || [];
    memoryCurrentProjectKey = (r && r.projectKey) || '';
  } catch { memoryRegistry = []; memoryOtherProjects = []; memoryCurrentProjectKey = ''; }
  renderMemoryList();
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
  list.appendChild(actions);
  if (!session) list.appendChild(el('div', 'muted', t('memory.needSessionHint')));
  const explicit = session && session.memoriesExplicit === true;
  if (session && !explicit) list.appendChild(el('div', 'memory-hint muted', t('memory.defaultPolicyHint')));
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
      list.appendChild(el('div', 'skill-group-title', `已失效 · ${ghosts.length}`));
      for (const g of ghosts) list.appendChild(buildMemoryGhostRow(g));
    }
  }
  // 其它项目组(迁移到当前项目)
  if ((memoryOtherProjects || []).length) {
    list.appendChild(el('div', 'skill-group-title', t('memory.otherProjects')));
    for (const p of memoryOtherProjects) list.appendChild(buildOtherProjectRow(p));
  }
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
  const typeLabel = m.type === 'convention' ? t('memory.type.convention') : (m.type === 'lesson' ? t('memory.type.lesson') : t('memory.type.reference'));
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
  head.appendChild(el('span', 'skill-type', `${p.count} 条`));
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
  renderMemoryList();
  memoryToggleChain = memoryToggleChain.then(() => doToggleMemory(m)).catch(() => {}).then(() => {
    memoryTogglePending.delete(key);
    renderMemoryList();
  });
}
async function doToggleMemory(m) {
  const session = state.currentSession;
  if (!session) return;
  const enabled = enabledMemoryKeySet();
  const key = m.scope + ':' + m.id;
  // P3-3: 重建启用集时保留各 project 条目锁定的 projectKey(服务端会以 session.cwd 权威重盖,前端如实回传避免丢字段)。
  const pkByKey = new Map((Array.isArray(session.memories) ? session.memories : []).filter(x => x && x.id).map(x => [((x.scope === 'global') ? 'global' : 'project') + ':' + x.id, x.projectKey]));
  const cur = [...enabled].map(k => { const i = k.indexOf(':'); const scope = k.slice(0, i), id = k.slice(i + 1); const o = { scope, id }; if (scope === 'project' && pkByKey.get(k)) o.projectKey = pkByKey.get(k); return o; });
  let next;
  if (enabled.has(key)) next = cur.filter(x => (x.scope + ':' + x.id) !== key);
  else { if (cur.length >= 8) { toast(t("toast.memoryMax8"), 'err'); return; } next = cur.concat({ scope: m.scope, id: m.id }); }
  try {
    const r = await api('/api/session/memories', { method: 'POST', body: JSON.stringify({ sessionId: session.id, memories: next }) });
    session.memories = (r && Array.isArray(r.memories)) ? r.memories : next;
    session.memoriesExplicit = true;
    toast(enabled.has(key) ? t('memory.toast.disabled', { name: m.name || m.id }) : t('memory.toast.enabled', { name: m.name || m.id }));
  } catch (e) { toast(t('toast.memorySetFail', { err: apiErrText(e) }), 'err'); }
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
  renderMemoryList();
}
async function deleteMemoryRow(m) {
  if (!confirm(t('memory.deleteConfirm', { name: m.name || m.id }))) return;
  try {
    const r = await api('/api/memory/' + encodeURIComponent(m.id), { method: 'POST', headers: { 'x-http-method': 'DELETE' }, body: JSON.stringify({ scope: m.scope, cwd: currentWorkspace() || '' }) });
    if (!r || !r.ok) { toast(t("toast.deleteFail", { p1: (r && r.error) || t('common.unknownError') }), 'err'); return; }
    toast(t("toast.memoryDeleted"), 'ok');
  } catch (e) { toast(t("toast.deleteFail", { p1: apiErrText(e) }), 'err'); return; }
  openMemoryPanel();
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
  if (okCount) parts.push(`迁移 ${okCount} 条`);
  if (conflictCount) parts.push(`${conflictCount} 条冲突跳过`);
  if (errCount) parts.push(`${errCount} 条失败`);
  toast(parts.length ? parts.join('，') : t('memory.noMigratable'), okCount ? 'ok' : 'err');
  openMemoryPanel();
}
// 从当前会话起草(provider 引擎):draft → 编辑弹窗 → 保存。
async function saveAsMemory(btn, sessionId = '') {
  const sid = String(sessionId || (state.currentSession && state.currentSession.id) || '');
  if (!sid) { toast(t("toast.noSessionToSave"), 'err'); return; }
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = t('common.drafting'); }
  try {
    const r = await api('/api/memory/draft', { method: 'POST', body: JSON.stringify({ sessionId: sid }) });
    if (!r || !r.ok || !r.draft) { toast(t("toast.draftFail", { p1: (r && r.error) || t('common.unknownError') }), 'err'); return; }
    openMemoryEditModal({ ...r.draft, scope: 'project', _isDraft: true });
  } catch (e) { toast(t("toast.draftFail", { p1: apiErrText(e) }), 'err'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
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
  for (const [v, t] of [['convention', t('memory.edit.typeConvention')], ['lesson', t('memory.edit.typeLesson')], ['reference', t('memory.edit.typeReference')]]) { const o = el('option', '', t); o.value = v; if (full && full.type === v) o.selected = true; typeSel.appendChild(o); }
  typeField.appendChild(typeSel); body.appendChild(typeField);
  const scopeField = el('div', 'pb-field'); scopeField.appendChild(el('label', 'pb-field-label', t('memory.edit.scope')));
  const scopeSel = el('select', 'pb-field-input');
  for (const [v, t] of [['project', t('memory.edit.scopeProject')], ['global', t('memory.edit.scopeGlobal')]]) { const o = el('option', '', t); o.value = v; if (((full && full.scope) || 'project') === v) o.selected = true; scopeSel.appendChild(o); }
  if (editing) scopeSel.disabled = true; // 编辑不改范围(改范围=另存,请新建)
  scopeField.appendChild(scopeSel); body.appendChild(scopeField);
  const bodyTa = mkField(t('memory.edit.body'), full ? full.body : '', 8);
  const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
  const cancel = el('button', '', t('common.cancel'));
  const save = el('button', 'primary', t('common.save'));
  foot.append(cancel, save);
  const modal = buildModal(editing ? t('memory.edit.title') : t('memory.edit.create.title'), body, foot);
  cancel.onclick = () => modal.close();
  save.onclick = async () => {
    const memory = { name: nameEl.value.trim(), description: descEl.value.trim(), type: typeSel.value, body: bodyTa.value, scope: scopeSel.value };
    if (editing) memory.id = m.id;
    if (full && full.sourceSessionId) memory.sourceSessionId = full.sourceSessionId;
    if (!memory.name || !memory.body.trim()) { toast(t("toast.memoryFieldsRequired"), 'err'); return; }
    save.disabled = true; save.textContent = t('common.saving');
    try {
      const r = await api('/api/memory', { method: 'POST', body: JSON.stringify({ memory, cwd: currentWorkspace() || '' }) });
      modal.close();
      if (!r || !r.ok) { toast(t("toast.saveFail", { p1: (r && r.error) || t('common.unknownError') }), 'err'); return; }
      toast(t("toast.memorySaved"), 'ok');
      if (!$('memoryModal').classList.contains('hidden')) openMemoryPanel();
    } catch (e) { modal.close(); toast(t("toast.saveFail", { p1: apiErrText(e) }), 'err'); }
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
        if (event.key === 'ArrowDown') { event.preventDefault(); moveSkillSel(1); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); moveSkillSel(-1); }
        else if (event.key === 'Enter') { event.preventDefault(); pickSkill(skillIndex); }
      });
    }
  }

  return Object.freeze({
    bindSkillsMemory,
    builtinPlaybookTextKey,
    openMemoryPanel,
    openSkillPanel,
    pickSkill,
    playbookDisplayDescription,
    playbookDisplayName,
    playbookDisplayUnavailableReason,
    playbookInputLabel,
    renderSkillList,
    saveAsMemory,
    updateSkillBadge,
  });
}
