'use strict';

// 设置页「技能与模板」（2026-10 设置补全）。
//
// 修前：技能库只在输入栏的按钮里、存下来的一键任务（playbook）只能在首页任务卡上看到且没有删除口、
// 提示词模板（localStorage wcw.templates）只能经命令面板存进去、插进来，存了什么、怎么删、怎么改名没有任何地方可看。
// 这一页把三样东西摆在一起管：
//   ① 技能          —— 列 GET /api/skills 的技能；「常驻」开关（≤8 个，写 residentSkills）；用户技能可删；段尾打开技能库。
//   ② 一键任务      —— 用户存下来的 playbook：改名（POST /api/playbooks 同 id 覆盖）、删除（DELETE /api/playbooks/:id）。
//   ③ 提示词模板    —— wcw.templates：改名、改内容、删除；只在这台电脑的这个浏览器里。
//
// 分层与 settings-catalog.js 同一套路：上半是零 DOM 的纯函数（unit/settings-skills.test.js 直接 import 钉），
// 下半是 DOM 渲染，一切依赖由 app.js 注入，本模块不 import 任何兄弟模块（不进依赖环，不因别处挂掉而整条 import 失败）。
// 技能的显示名／来源／常驻判据／删除确认全部取自 skills-memory.js 的同一份实现（settingsSkillsApi），这里不另写判据。

/* ═══════════════ 纯函数 ═══════════════ */

export const PLAYBOOK_TITLE_MAX = 120;   // 与服务端 normalizePlaybook 的 title 上限一致
export const TEMPLATE_NAME_MAX = 80;
export const TEMPLATE_TEXT_MAX = 20000;  // 与 playbook 的 promptTemplate 上限同量级；再长的「模板」不是模板

// 技能库里的「技能」一族（命令与一键任务在别的段）。
export function skillRows(registry) {
  return (Array.isArray(registry) ? registry : []).filter(entry => entry && entry.kind === 'skill' && entry.id);
}

// 常驻名单里有、技能清单里找不到的 id（被删了、改名了、或是别的工作文件夹里的项目技能）。
// 它们仍占着 8 个名额却在清单里没有对应行 —— 单独列出来让人能摘掉。
export function residentGhostIds(rows, residentIds) {
  const known = new Set((Array.isArray(rows) ? rows : []).map(entry => entry.id));
  const seen = new Set();
  const out = [];
  for (const id of Array.isArray(residentIds) ? residentIds : []) {
    const key = String(id || '');
    if (!key || known.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// 一行常驻开关该是什么样：on=当前是否常驻；locked=不能再开（名额满了且这行本来没开）；unavailable=技能当下用不了
// （技能库里同一口径：不可用的技能不让动常驻开关）。disabled = 二者任一。
export function residentSwitchState(entry, residentIds, max) {
  const ids = Array.isArray(residentIds) ? residentIds : [];
  const on = ids.includes(entry && entry.id);
  const unavailable = Boolean(entry) && entry.available === false;
  const locked = !on && ids.length >= max;
  return { on, unavailable, locked, disabled: unavailable || locked };
}

// 「内置」与「用户存的」一键任务分开。服务端给每条标了 builtin（true=只来自内置、没有用户文件）；
// 覆盖了内置 id 的用户文件是 builtin:false，也算用户的（可删，删了回到内置）。
export function splitPlaybooks(list) {
  const user = [];
  const builtin = [];
  for (const pb of Array.isArray(list) ? list : []) {
    if (!pb || typeof pb !== 'object' || !pb.id) continue;
    (pb.builtin === true ? builtin : user).push(pb);
  }
  return { user, builtin };
}

const PLAYBOOK_BODY_KEYS = ['id', 'title', 'icon', 'desc', 'inputs', 'promptTemplate', 'requires', 'engineHint', 'uiMode', 'service'];

// 改名：把这条 playbook 的可存字段原样带回、只换 title，POST /api/playbooks（服务端同 id 覆盖，并再清洗一遍）。
// 新名为空 → null（调用方提示「名字不能空」）。可用性等运行时字段（available/status/builtin…）不带，服务端本来就丢。
export function playbookRenameBody(pb, title) {
  const next = String(title == null ? '' : title).trim().slice(0, PLAYBOOK_TITLE_MAX);
  if (!pb || typeof pb !== 'object' || !next) return null;
  const body = {};
  for (const key of PLAYBOOK_BODY_KEYS) if (pb[key] !== undefined) body[key] = pb[key];
  body.title = next;
  return body;
}

// localStorage 里读出来的东西不可信：只认「有名字有正文」的对象，保留它在原数组里的下标（改名/删除按原下标动手）。
export function cleanTemplates(raw) {
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const name = typeof item.name === 'string' ? item.name : '';
    const text = typeof item.text === 'string' ? item.text : '';
    if (!name.trim() || !text.trim()) return;
    out.push({ index, name, text });
  });
  return out;
}

// 删掉原数组里 index 那一条，返回新数组；下标越界/不是数组 → null。其余条目（含不合规的）原样保留，不替人清数据。
export function templatesWithout(raw, index) {
  if (!Array.isArray(raw) || !Number.isInteger(index) || index < 0 || index >= raw.length) return null;
  return raw.filter((_, i) => i !== index);
}

// 改 index 那一条的名称与内容。reason：range 越界｜name 名字空｜text 内容空。
export function templatesWithEdit(raw, index, patch) {
  if (!Array.isArray(raw) || !Number.isInteger(index) || index < 0 || index >= raw.length || !raw[index] || typeof raw[index] !== 'object') {
    return { ok: false, reason: 'range' };
  }
  const name = String(patch && patch.name != null ? patch.name : '').trim().slice(0, TEMPLATE_NAME_MAX);
  const text = String(patch && patch.text != null ? patch.text : '');
  if (!name) return { ok: false, reason: 'name' };
  if (!text.trim()) return { ok: false, reason: 'text' };
  const list = raw.map((item, i) => (i === index ? { ...item, name, text: text.slice(0, TEMPLATE_TEXT_MAX) } : item));
  return { ok: true, list };
}

// 列表里的一句预览：折叠空白、截断。
export function previewText(text, max = 90) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/* ═══════════════ DOM 层 ═══════════════ */

function make(doc, tag, cls, text) {
  const node = doc.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export const SETTINGS_SKILLS_SECTIONS = Object.freeze([
  { id: 'setskillSkills', kind: 'skills', titleKey: 'settings.skills.section.skills', hintKey: 'settings.skills.skills.hint' },
  { id: 'setskillPlaybooks', kind: 'playbooks', titleKey: 'settings.skills.section.playbooks', hintKey: 'settings.skills.playbooks.hint' },
  { id: 'setskillTemplates', kind: 'templates', titleKey: 'settings.skills.section.templates', hintKey: 'settings.skills.templates.hint' },
]);

export function createSettingsSkillsDomain({
  doc = (typeof document !== 'undefined' ? document : null),
  t = key => key,
  api = async () => ({}),
  toast = () => {},
  apiErrText = error => String(error && error.message || error || ''),
  confirmDanger = async () => false,
  skills = {},                       // skills-memory.js 的 settingsSkillsApi
  getTemplates = () => [],
  saveTemplates = () => {},
  refreshPlaybooks = async () => {},
  openSkillPanel = () => {},
} = {}) {
  let registry = null;               // null = 还没读到
  let registryError = '';
  let playbooks = null;
  let playbooksError = '';
  let editingPlaybook = '';          // 正在改名的 playbook id
  let editingTemplate = -1;          // 正在编辑的模板在 wcw.templates 里的原下标
  let seq = 0;                       // open() 的代号：迟到的旧回包不覆盖新页面
  const busy = new Set();            // 在途动作（防双击）

  const residentMax = () => Number(skills.RESIDENT_SKILL_MAX) || 8;
  const residentIds = () => (typeof skills.residentSkillIds === 'function' ? skills.residentSkillIds() : []);

  function body(kind) {
    const node = doc && doc.getElementById(`setskill-body-${kind}`);
    return node || null;
  }

  function mount() {
    if (!doc) return false;
    const host = doc.getElementById('settingsSkillsHost');
    if (!host) return false;
    if (host.querySelector('#setskillSkills')) { retitle(); return true; }
    for (const section of SETTINGS_SKILLS_SECTIONS) {
      const node = make(doc, 'section', 'settings-section setskill-section');
      node.id = section.id;
      const headingId = `${section.id}Heading`;
      node.setAttribute('aria-labelledby', headingId);
      const heading = make(doc, 'h4', 'settings-subhead', t(section.titleKey));
      heading.id = headingId;
      node.appendChild(heading);
      node.appendChild(make(doc, 'p', 'muted prov-hint', t(section.hintKey)));
      const inner = make(doc, 'div', 'setskill-body');
      inner.id = `setskill-body-${section.kind}`;
      node.appendChild(inner);
      host.appendChild(node);
    }
    renderAll();
    return true;
  }

  // 语言切换后再进这一页：段标题与说明跟着换（静态部分只画一次，不能留在旧语言）。
  function retitle() {
    for (const section of SETTINGS_SKILLS_SECTIONS) {
      const node = doc.getElementById(section.id);
      if (!node) continue;
      const heading = node.querySelector('.settings-subhead');
      if (heading) heading.textContent = t(section.titleKey);
      const hint = node.querySelector('.prov-hint');
      if (hint) hint.textContent = t(section.hintKey);
    }
  }

  function note(text, extra) {
    return make(doc, 'p', 'muted setskill-note' + (extra ? ' ' + extra : ''), text);
  }
  function empty(text) {
    return make(doc, 'p', 'setcat-empty muted', text);
  }
  function button(text, cls, onClick, label) {
    const node = make(doc, 'button', cls, text);
    node.type = 'button';
    if (label) node.setAttribute('aria-label', label);
    node.addEventListener('click', onClick);
    return node;
  }
  function row(extraClass) {
    const node = make(doc, 'div', 'setskill-row' + (extraClass ? ' ' + extraClass : ''));
    return node;
  }
  function textBlock(title, sub, tag) {
    const block = make(doc, 'div', 'setskill-text');
    const head = make(doc, 'div', 'setskill-name');
    head.appendChild(make(doc, 'span', 'setskill-title', title));
    if (tag) head.appendChild(make(doc, 'span', 'setskill-tag', tag));
    block.appendChild(head);
    if (sub) block.appendChild(make(doc, 'p', 'setskill-desc', sub));
    return block;
  }

  /* ───────── ① 技能 ───────── */

  function renderSkills() {
    const host = body('skills');
    if (!host) return;
    host.replaceChildren();
    if (registry === null) {
      host.appendChild(note(registryError ? t('settings.skills.skills.loadFailed', { reason: registryError }) : t('settings.skills.loading'), registryError ? 'setskill-error' : ''));
      host.appendChild(skillsActions());
      return;
    }
    const rows = skillRows(registry);
    const ids = residentIds();
    const ghosts = residentGhostIds(rows, ids);
    const max = residentMax();
    host.appendChild(note(t('settings.skills.skills.residentCount', { count: ids.length, max }), 'setskill-count'));
    if (!rows.length && !ghosts.length) {
      host.appendChild(empty(t('settings.skills.skills.empty')));
    } else {
      const list = make(doc, 'div', 'setskill-list');
      for (const entry of rows) list.appendChild(skillRow(entry, ids, max));
      for (const id of ghosts) list.appendChild(ghostRow(id));
      host.appendChild(list);
    }
    host.appendChild(skillsActions());
  }

  function skillRow(entry, ids, max) {
    const name = skills.skillDisplayName(entry);
    const node = row(entry.available === false ? 'is-unavailable' : '');
    node.dataset.skillId = entry.id;
    const description = skills.skillDisplayDescription(entry);
    const reason = entry.available === false ? (skills.skillDisplayUnavailableReason(entry) || t('skills.unavailable')) : '';
    node.appendChild(textBlock(name, [description, reason].filter(Boolean).join(' · '), skills.skillDisplaySource(entry)));
    const actions = make(doc, 'div', 'setskill-actions');
    if (entry.source === 'user') {
      actions.appendChild(button(t('skills.delete'), 'mini danger setskill-del', () => {
        void skills.confirmDeleteSkill(entry, { afterDelete: fresh => { if (Array.isArray(fresh)) { registry = fresh; registryError = ''; } else { void reloadSkills(); } renderSkills(); } });
      }, t('settings.skills.skills.deleteLabel', { name })));
    }
    const sw0 = residentSwitchState(entry, ids, max);
    const label = make(doc, 'label', 'setskill-switchlabel');
    label.appendChild(make(doc, 'span', '', t('settings.skills.skills.resident')));
    const sw = make(doc, 'input', 'setskill-switch setcat-switch');   // setcat-switch：与设置页其他拨钮同一个样子
    sw.type = 'checkbox';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', t('settings.skills.skills.residentLabel', { name }));
    sw.checked = sw0.on;
    sw.disabled = sw0.disabled;
    if (sw0.locked) label.title = t('settings.skills.skills.residentFull', { max });
    sw.addEventListener('change', async () => {
      sw.disabled = true;
      try { await skills.toggleResidentSkill(entry); } finally { renderSkills(); }
    });
    label.appendChild(sw);
    actions.appendChild(label);
    node.appendChild(actions);
    return node;
  }

  // 常驻名单里还留着、清单里已经没有的技能：占着名额却没有开关，给一个「移除」。
  function ghostRow(id) {
    const node = row('is-ghost');
    node.dataset.skillId = id;
    node.appendChild(textBlock(id, t('settings.skills.skills.ghostDesc'), t('skills.group.unavailable')));
    const actions = make(doc, 'div', 'setskill-actions');
    actions.appendChild(button(t('common.remove'), 'mini', async () => {
      try { await skills.toggleResidentSkill({ id, source: '' }); } finally { renderSkills(); }
    }, t('settings.skills.skills.ghostRemoveLabel', { id })));
    node.appendChild(actions);
    return node;
  }

  function skillsActions() {
    const actions = make(doc, 'div', 'setskill-footer');
    actions.appendChild(button(t('settings.skills.skills.openLibrary'), 'mini setskill-open-library', () => openSkillPanel()));
    return actions;
  }

  async function reloadSkills() {
    try { registry = await skills.refreshSkillRegistry(); registryError = ''; }
    catch (error) { registryError = apiErrText(error) || t('common.unknownError'); if (!Array.isArray(registry)) registry = null; }
    renderSkills();
  }

  /* ───────── ② 一键任务 ───────── */

  function renderPlaybooks() {
    const host = body('playbooks');
    if (!host) return;
    host.replaceChildren();
    if (playbooks === null) {
      host.appendChild(note(playbooksError ? t('settings.skills.playbooks.loadFailed', { reason: playbooksError }) : t('settings.skills.loading'), playbooksError ? 'setskill-error' : ''));
      return;
    }
    const { user, builtin } = splitPlaybooks(playbooks);
    if (!user.length) {
      host.appendChild(empty(t('settings.skills.playbooks.empty')));
    } else {
      const list = make(doc, 'div', 'setskill-list');
      for (const pb of user) list.appendChild(playbookRow(pb));
      host.appendChild(list);
    }
    if (builtin.length) host.appendChild(note(t('settings.skills.playbooks.builtinNote', { count: builtin.length })));
  }

  function playbookRow(pb) {
    const node = row();
    node.dataset.playbookId = pb.id;
    const name = String(pb.title || pb.id);
    const icon = make(doc, 'span', 'setskill-icon', pb.icon || '📄');
    icon.setAttribute('aria-hidden', 'true');
    node.appendChild(icon);
    if (editingPlaybook === pb.id) {
      node.classList.add('is-editing');
      const form = make(doc, 'div', 'setskill-edit');
      const input = make(doc, 'input', 'setskill-input');
      input.type = 'text';
      input.maxLength = PLAYBOOK_TITLE_MAX;
      input.value = name;
      input.setAttribute('aria-label', t('settings.skills.playbooks.nameLabel'));
      const save = () => void renamePlaybook(pb, input);
      input.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return; // 输入法选字中:回车/Esc 归输入法
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save(); }
        else if (event.key === 'Escape') { event.preventDefault(); editingPlaybook = ''; renderPlaybooks(); }
      });
      const bar = make(doc, 'div', 'setskill-actions');
      bar.appendChild(button(t('common.save'), 'mini primary setskill-save', save));
      bar.appendChild(button(t('common.cancel'), 'mini', () => { editingPlaybook = ''; renderPlaybooks(); }));
      form.appendChild(input);
      node.appendChild(form);
      node.appendChild(bar);
      setTimeout(() => { try { input.focus(); input.select(); } catch { /* 没有焦点能力就算了 */ } }, 0);
      return node;
    }
    node.appendChild(textBlock(name, pb.desc || t('settings.skills.playbooks.noDesc')));
    const actions = make(doc, 'div', 'setskill-actions');
    actions.appendChild(button(t('settings.skills.rename'), 'mini setskill-rename', () => { editingPlaybook = pb.id; renderPlaybooks(); }, t('settings.skills.playbooks.renameLabel', { name })));
    actions.appendChild(button(t('common.delete'), 'mini danger setskill-del', () => void deletePlaybook(pb), t('settings.skills.playbooks.deleteLabel', { name })));
    node.appendChild(actions);
    return node;
  }

  async function renamePlaybook(pb, input) {
    const key = `pb-rename:${pb.id}`;
    if (busy.has(key)) return;
    const payload = playbookRenameBody(pb, input.value);
    if (!payload) { toast(t('settings.skills.playbooks.nameRequired'), 'err'); try { input.focus(); } catch { /* ignore */ } return; }
    if (payload.title === String(pb.title || '')) { editingPlaybook = ''; renderPlaybooks(); return; }
    busy.add(key);
    try {
      const result = await api('/api/playbooks', { method: 'POST', body: JSON.stringify({ playbook: payload }) });
      if (!result || !result.ok) throw new Error((result && result.error) || t('common.unknownError'));
      toast(t('settings.skills.playbooks.renamed', { name: payload.title }), 'ok');
      editingPlaybook = '';
      await reloadPlaybooks();
      void refreshPlaybooks();
    } catch (error) {
      toast(t('settings.skills.playbooks.renameFailed', { reason: apiErrText(error) }), 'err');
    } finally { busy.delete(key); }
  }

  async function deletePlaybook(pb) {
    const key = `pb-delete:${pb.id}`;
    if (busy.has(key)) return;
    const name = String(pb.title || pb.id);
    const confirmed = await confirmDanger({
      titleKey: 'settings.skills.playbooks.deleteTitle',
      bodyKey: 'settings.skills.playbooks.deleteBody',
      bodyParams: { name },
      okKey: 'common.delete',
      cancelKey: 'common.cancel',
    });
    if (!confirmed) return;
    busy.add(key);
    try {
      const result = await api('/api/playbooks/' + encodeURIComponent(pb.id), { method: 'DELETE' });
      if (result && result.ok === false) throw new Error(result.error || t('common.unknownError'));
      toast(t('settings.skills.playbooks.deleted', { name }), 'ok');
      if (editingPlaybook === pb.id) editingPlaybook = '';
      await reloadPlaybooks();
      void refreshPlaybooks();
    } catch (error) {
      toast(t('settings.skills.playbooks.deleteFailed', { reason: apiErrText(error) }), 'err');
    } finally { busy.delete(key); }
  }

  async function reloadPlaybooks() {
    try {
      const result = await api('/api/playbooks');
      playbooks = (result && Array.isArray(result.playbooks)) ? result.playbooks : [];
      playbooksError = '';
    } catch (error) {
      playbooksError = apiErrText(error) || t('common.unknownError');
      if (!Array.isArray(playbooks)) playbooks = null;
    }
    renderPlaybooks();
  }

  /* ───────── ③ 提示词模板 ───────── */

  function renderTemplates() {
    const host = body('templates');
    if (!host) return;
    host.replaceChildren();
    const items = cleanTemplates(getTemplates());
    if (!items.length) {
      host.appendChild(empty(t('settings.skills.templates.empty')));
    } else {
      const list = make(doc, 'div', 'setskill-list');
      for (const item of items) list.appendChild(templateRow(item));
      host.appendChild(list);
    }
    host.appendChild(note(t('settings.skills.templates.localOnly'), 'setskill-local'));
  }

  function templateRow(item) {
    const node = row();
    node.dataset.templateIndex = String(item.index);
    if (editingTemplate === item.index) {
      node.classList.add('is-editing');
      const form = make(doc, 'div', 'setskill-edit');
      const name = make(doc, 'input', 'setskill-input setskill-tpl-name');
      name.type = 'text';
      name.maxLength = TEMPLATE_NAME_MAX;
      name.value = item.name;
      name.setAttribute('aria-label', t('settings.skills.templates.nameLabel'));
      const text = make(doc, 'textarea', 'setskill-input setskill-tpl-text');
      text.rows = 5;
      text.maxLength = TEMPLATE_TEXT_MAX;
      text.value = item.text;
      text.setAttribute('aria-label', t('settings.skills.templates.textLabel'));
      form.append(name, text);
      const bar = make(doc, 'div', 'setskill-actions');
      bar.appendChild(button(t('common.save'), 'mini primary setskill-save', () => saveTemplate(item.index, name, text)));
      bar.appendChild(button(t('common.cancel'), 'mini', () => { editingTemplate = -1; renderTemplates(); }));
      node.append(form, bar);
      setTimeout(() => { try { name.focus(); } catch { /* ignore */ } }, 0);
      return node;
    }
    node.appendChild(textBlock(item.name, previewText(item.text)));
    const actions = make(doc, 'div', 'setskill-actions');
    actions.appendChild(button(t('common.edit'), 'mini setskill-edit-btn', () => { editingTemplate = item.index; renderTemplates(); }, t('settings.skills.templates.editLabel', { name: item.name })));
    actions.appendChild(button(t('common.delete'), 'mini danger setskill-del', () => void deleteTemplate(item), t('settings.skills.templates.deleteLabel', { name: item.name })));
    node.appendChild(actions);
    return node;
  }

  // 写回后重读一遍：浏览器禁了本地存储时 saveTemplates 会静默失败，这里要让人知道没存上。
  function persistTemplates(next) {
    saveTemplates(next);
    const back = getTemplates();
    return Array.isArray(back) && JSON.stringify(back) === JSON.stringify(next);
  }

  function saveTemplate(index, nameInput, textInput) {
    const result = templatesWithEdit(getTemplates(), index, { name: nameInput.value, text: textInput.value });
    if (!result.ok) {
      if (result.reason === 'name') { toast(t('settings.skills.templates.nameRequired'), 'err'); try { nameInput.focus(); } catch { /* ignore */ } }
      else if (result.reason === 'text') { toast(t('settings.skills.templates.textRequired'), 'err'); try { textInput.focus(); } catch { /* ignore */ } }
      else { editingTemplate = -1; renderTemplates(); }
      return;
    }
    if (!persistTemplates(result.list)) { toast(t('settings.skills.templates.saveFailed'), 'err'); return; }
    editingTemplate = -1;
    toast(t('toast.templateSaved'), 'ok');
    renderTemplates();
  }

  async function deleteTemplate(item) {
    const confirmed = await confirmDanger({
      titleKey: 'settings.skills.templates.deleteTitle',
      bodyKey: 'settings.skills.templates.deleteBody',
      bodyParams: { name: item.name },
      okKey: 'common.delete',
      cancelKey: 'common.cancel',
    });
    if (!confirmed) return;
    // 确认期间列表可能变过（别的标签页改了）：按下标再核一次是不是还是这一条。
    const current = getTemplates();
    const same = Array.isArray(current) && current[item.index] && current[item.index].name === item.name && current[item.index].text === item.text;
    const next = same ? templatesWithout(current, item.index) : null;
    if (!next) { renderTemplates(); return; }
    if (!persistTemplates(next)) { toast(t('settings.skills.templates.saveFailed'), 'err'); renderTemplates(); return; }
    if (editingTemplate === item.index) editingTemplate = -1;
    toast(t('settings.skills.templates.deleted', { name: item.name }), 'ok');
    renderTemplates();
  }

  /* ───────── 入口 ───────── */

  function renderAll() {
    renderSkills();
    renderPlaybooks();
    renderTemplates();
  }

  // 切到「技能与模板」页签时调：先用手上有的画一遍（模板是本地的，立刻就有），再并行重拉技能与一键任务。
  async function open() {
    if (!mount()) return;
    const mine = ++seq;
    editingPlaybook = '';
    editingTemplate = -1;
    renderAll();
    const [skillResult, playbookResult] = await Promise.allSettled([skills.refreshSkillRegistry(), api('/api/playbooks')]);
    if (mine !== seq) return;   // 又切了一次页签，这一轮的回包作废
    if (skillResult.status === 'fulfilled') { registry = skillResult.value; registryError = ''; }
    else { registryError = apiErrText(skillResult.reason) || t('common.unknownError'); if (!Array.isArray(registry)) registry = null; }
    if (playbookResult.status === 'fulfilled') {
      const value = playbookResult.value;
      playbooks = (value && Array.isArray(value.playbooks)) ? value.playbooks : [];
      playbooksError = '';
    } else { playbooksError = apiErrText(playbookResult.reason) || t('common.unknownError'); if (!Array.isArray(playbooks)) playbooks = null; }
    renderAll();
  }

  return Object.freeze({ mount, open, renderAll });
}
