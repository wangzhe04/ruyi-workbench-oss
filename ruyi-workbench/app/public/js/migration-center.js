'use strict';

import { api, apiErrorInfo } from './net.js';
import { el, fmtBytes, fmtTime, toast } from './util.js';
import { t } from './i18n.js';
import { confirmDanger } from './confirm-panel.js';

// ─────────────────────────────────────────────────────────────────────────────
// migration-center.js — 迁移中心（W2，56 号文 §3）。
//
// 两块，一个面：
//   ① 「从 Claude Code / Codex / Kimi 导入」：全局指令文件（导成核心记忆）、MCP、技能，逐项状态 + 一键导入；
//   ② 「老版本如意」：检测到的老包（版本 / 大小 / 最后启动）、还指着老包的引用（逐项勾选，默认全勾）、
//      「全部改到新版」「撤销上次迁移」「移到回收站」。
// 后端全在 /api/migration/*（13u，经 MigrationHooks 迟绑定）；本文件只渲染与转发，判据一个都不在这里。
//
// 挂点：设置弹窗「集成」页签 #stab-integrations 的末尾，运行时追加 <section id="migrationCenter">。
// 设置页的标记由 W6 重组，这里【不改】index.html，只认这个面板 id（W6 知道这个挂点）。
// 首启提示：scan 回 prompt.show（有用户没看过的候选键）→ 两个视角都在右上角起一张一次性、非模态的卡
// （沿用安静卡的外观类 .quiet-card*），「查看并迁移」「以后再说」都会记「看过了」（apply markSeen）。
// 零 innerHTML：全部 el()/textContent 拼装。
// ─────────────────────────────────────────────────────────────────────────────

export const MIGRATION_CENTER_ID = 'migrationCenter';
export const MIGRATION_CARD_HOST_ID = 'migrationCardHost';
export const MIGRATION_MOUNT_PANEL_ID = 'stab-integrations';

// 状态 → 文案键。未知状态落回原样（服务端新加了状态也不至于空白）。
const STATUS_KEYS = Object.freeze({
  imported: 'migration.status.imported',
  importable: 'migration.status.importable',
  dismissed: 'migration.status.dismissed',
  'source-updated': 'migration.status.sourceUpdated',
  absent: 'migration.status.absent',
  'too-large': 'migration.status.tooLarge',
  skipped: 'migration.status.skipped',
  live: 'migration.status.live',
  running: 'migration.status.running',
});
const REASON_KEYS = Object.freeze({
  reserved: 'migration.reason.reserved',
  toolbox: 'migration.reason.toolbox',
  'ruyi-managed': 'migration.reason.ruyiManaged',
  'ruyi-self': 'migration.reason.ruyiSelf',
  unsupported: 'migration.reason.unsupported',
  invalid: 'migration.reason.invalid',
});
const SOURCE_KEYS = Object.freeze({
  'claude-code': 'migration.source.claudeCode',
  codex: 'migration.source.codex',
  kimi: 'migration.source.kimi',
  'claude-plugin': 'migration.source.claudePlugin',
});

export function migrationStatusText(status) {
  const key = STATUS_KEYS[status];
  return key ? t(key) : String(status || '');
}
export function migrationReasonText(reason) {
  const key = REASON_KEYS[reason];
  return key ? t(key) : String(reason || '');
}
export function migrationSourceText(source) {
  const key = SOURCE_KEYS[source];
  return key ? t(key) : String(source || '');
}
// 引用项一行话：「args.0: 旧 → 新」或「移除这一条」。
export function migrationRefSummary(ref) {
  if (!ref) return '';
  if (ref.action === 'remove') return t('migration.ref.remove');
  if (ref.action === 'manual') return t('migration.ref.manual');
  const first = (ref.changes || [])[0];
  if (!first) return '';
  return t('migration.ref.rewrite', { field: first.field, to: String(first.to || '') }) + ((ref.changes || []).length > 1 ? ' ' + t('migration.ref.more', { count: ref.changes.length - 1 }) : '');
}
// 服务端稳定码 migration.<原因> → 人话。只翻登记过的码(t() 对缺键会告警),其余退回服务端原文。
const ERROR_CODES = new Set(['confirm_mismatch', 'root_required', 'current_package', 'contains_data', 'contains_home', 'not_an_old_package',
  'running', 'referenced', 'recycle_failed', 'unsupported_platform', 'nothing_applied', 'nothing_to_apply', 'no_migration_to_undo', 'already_undone']);
export function migrationErrorText(e) {
  let src = e;
  if (src && typeof src === 'object' && !(src instanceof Error) && typeof src.error === 'string') src = { error: { code: 'migration.' + src.error.replace(/-/g, '_'), message: src.error } };
  const info = apiErrorInfo(src);
  const code = String(info.code || '').replace(/^migration\./, '');
  return ERROR_CODES.has(code) ? t('migration.error.' + code) : (info.message || String(e || ''));
}
const errorText = migrationErrorText;
function statusChip(status) {
  const chip = el('span', 'migration-chip migration-chip-' + String(status || 'unknown'), migrationStatusText(status));
  chip.dataset.status = String(status || '');
  return chip;
}
function button(text, className, onClick) {
  const b = el('button', className || 'mini', text);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

export function bindMigrationCenter({ openIntegrations = () => {}, promptDelayMs = 1200, doc = document } = {}) {
  let busy = false;
  let lastScan = null;
  const unchecked = new Set(); // 用户在预览里取消勾选的引用 id（默认全勾）

  const panel = () => doc.getElementById(MIGRATION_MOUNT_PANEL_ID);
  function ensureMounted() {
    let root = doc.getElementById(MIGRATION_CENTER_ID);
    if (root) return root;
    const host = panel();
    if (!host) return null;
    root = el('section', 'migration-center');
    root.id = MIGRATION_CENTER_ID;
    root.setAttribute('aria-labelledby', MIGRATION_CENTER_ID + 'Title');
    host.appendChild(el('hr', 'settings-sep'));
    host.appendChild(root);
    return root;
  }

  async function scan() {
    return api('/api/migration/scan');
  }
  async function apply(body, okText) {
    if (busy) return null;
    busy = true;
    try {
      const res = await api('/api/migration/apply', { method: 'POST', body: JSON.stringify(body) });
      if (okText) toast(okText, 'ok');
      return res;
    } catch (e) {
      toast(errorText(e), 'error');
      return null;
    } finally {
      busy = false;
    }
  }

  function renderHead(root) {
    const head = el('div', 'settings-section-head');
    const text = el('div');
    const title = el('h4', 'settings-subhead', t('migration.title'));
    title.id = MIGRATION_CENTER_ID + 'Title';
    text.append(title, el('p', 'muted prov-hint', t('migration.hint')));
    const refresh = button(t('common.refresh'), 'mini', () => { void refresh_(); });
    refresh.dataset.migration = 'refresh';
    head.append(text, refresh);
    root.appendChild(head);
  }

  function renderSettings(root, s) {
    const box = el('div', 'migration-settings');
    for (const [key, labelKey] of [['importAgentInstructions', 'migration.setting.instructions'], ['autoImportClaudeCodeMcp', 'migration.setting.mcp']]) {
      const label = el('label', 'check');
      const input = el('input');
      input.type = 'checkbox';
      input.checked = Boolean(s.settings && s.settings[key]);
      input.dataset.migrationSetting = key;
      input.onchange = async () => {
        const res = await apply({ settings: { [key]: input.checked } }, t('migration.toast.saved'));
        if (!res) input.checked = !input.checked;
      };
      label.append(input, el('span', '', ' ' + t(labelKey)));
      box.appendChild(label);
    }
    root.appendChild(box);
  }

  function row(className) { return el('div', 'migration-row ' + (className || '')); }
  function rowText(title, detail) {
    const wrap = el('div', 'migration-row-text');
    wrap.appendChild(el('div', 'migration-row-title', title));
    if (detail) wrap.appendChild(el('div', 'migration-row-detail muted', detail));
    return wrap;
  }

  function renderImports(root, s) {
    root.appendChild(el('h5', 'migration-subhead', t('migration.import.title')));
    // 指令文件
    const instr = el('div', 'migration-group');
    instr.dataset.group = 'instructions';
    instr.appendChild(el('div', 'migration-group-title', t('migration.import.instructions')));
    const present = (s.instructions || []).filter(x => x.status !== 'absent');
    if (!present.length) instr.appendChild(el('p', 'field-help muted', t('migration.import.noInstructions')));
    for (const x of present) {
      const r = row('migration-row-instruction');
      r.dataset.key = x.key;
      const detail = x.displayPath + (x.entries ? ' · ' + t('migration.import.entries', { count: x.entries, core: x.coreEntries }) : '')
        + (x.userModified ? ' · ' + t('migration.import.userModified') : '');
      r.append(rowText(x.label, detail), statusChip(x.status));
      const actions = el('div', 'migration-row-actions');
      if (x.status === 'importable' || x.status === 'dismissed' || x.status === 'source-updated') {
        const b = button(x.status === 'source-updated' ? t('migration.action.overwrite') : t('migration.action.import'), 'mini primary', async () => {
          const res = await apply({ importInstructions: [x.key] }, t('migration.toast.imported'));
          if (res) void refresh_();
        });
        b.dataset.migrationAction = 'import-instruction';
        actions.appendChild(b);
      }
      if (x.status === 'imported' || x.status === 'source-updated') {
        const b = button(t('migration.action.remove'), 'mini', async () => {
          const res = await apply({ dismissInstructions: [x.key] }, t('migration.toast.removed'));
          if (res) void refresh_();
        });
        b.dataset.migrationAction = 'dismiss-instruction';
        actions.appendChild(b);
      }
      r.appendChild(actions);
      instr.appendChild(r);
    }
    root.appendChild(instr);

    // MCP
    const mcp = el('div', 'migration-group');
    mcp.dataset.group = 'mcp';
    mcp.appendChild(el('div', 'migration-group-title', t('migration.import.mcp', { used: s.mcp ? s.mcp.used : 0, limit: s.mcp ? s.mcp.limit : 10 })));
    const servers = (s.mcp && s.mcp.servers) || [];
    if (!servers.length) mcp.appendChild(el('p', 'field-help muted', t('migration.import.noMcp')));
    const importable = servers.filter(x => x.status === 'importable' || x.status === 'dismissed');
    for (const x of servers) {
      const r = row('migration-row-mcp');
      r.dataset.key = x.key;
      const detail = migrationSourceText(x.origin) + ' · ' + x.summary + (x.reason ? ' · ' + migrationReasonText(x.reason) : '');
      r.append(rowText(x.id, detail), statusChip(x.status));
      const actions = el('div', 'migration-row-actions');
      if (x.status === 'importable' || x.status === 'dismissed') {
        const b = button(t('migration.action.import'), 'mini', async () => {
          const res = await apply({ importMcp: [{ origin: x.origin, id: x.id }] });
          if (res) { toast(res.mcp && res.mcp.added && res.mcp.added.length ? t('migration.toast.imported') : t('migration.toast.nothing'), res.mcp && res.mcp.added && res.mcp.added.length ? 'ok' : ''); void refresh_(); }
        });
        b.dataset.migrationAction = 'import-mcp';
        actions.appendChild(b);
      }
      r.appendChild(actions);
      mcp.appendChild(r);
    }
    if (importable.length > 1) {
      const all = button(t('migration.action.importAllMcp', { count: importable.length }), 'mini primary', async () => {
        const res = await apply({ importMcp: importable.map(x => ({ origin: x.origin, id: x.id })) });
        if (res) { toast(t('migration.toast.importedCount', { count: (res.mcp && res.mcp.added || []).length }), 'ok'); void refresh_(); }
      });
      all.dataset.migrationAction = 'import-mcp-all';
      mcp.appendChild(all);
    }
    root.appendChild(mcp);

    // 技能（活读，只报状态）
    const skills = el('div', 'migration-group');
    skills.dataset.group = 'skills';
    skills.appendChild(el('div', 'migration-group-title', t('migration.import.skills')));
    if (!(s.skills || []).length) skills.appendChild(el('p', 'field-help muted', t('migration.import.noSkills')));
    else skills.appendChild(el('p', 'field-help muted', t('migration.import.skillsHint')));
    for (const x of s.skills || []) {
      const r = row('migration-row-skill');
      r.dataset.key = x.key;
      r.append(rowText(x.name || x.id, migrationSourceText(x.source) + (x.plugin ? ' · ' + x.plugin : '')), statusChip('live'));
      skills.appendChild(r);
    }
    root.appendChild(skills);
  }

  function renderPackages(root, s) {
    root.appendChild(el('h5', 'migration-subhead', t('migration.old.title')));
    root.appendChild(el('p', 'field-help muted', t('migration.old.hint', { version: s.current ? s.current.version : '' })));
    const pk = el('div', 'migration-group');
    pk.dataset.group = 'packages';
    if (!(s.packages || []).length) pk.appendChild(el('p', 'field-help muted', t('migration.old.none')));
    for (const p of s.packages || []) {
      const r = row('migration-row-package');
      r.dataset.root = p.root;
      const bits = [p.root];
      if (p.sizeBytes != null) bits.push((p.sizeCapped ? '≥ ' : '') + fmtBytes(p.sizeBytes));
      bits.push(p.lastLaunchedAt ? t('migration.old.lastLaunched', { time: fmtTime(p.lastLaunchedAt) }) : t('migration.old.neverLaunched'));
      if (p.refCount) bits.push(t('migration.old.refs', { count: p.refCount }));
      r.appendChild(rowText(t('migration.old.version', { version: p.version || '?' }), bits.join(' · ')));
      if (p.running) r.appendChild(statusChip('running'));
      const actions = el('div', 'migration-row-actions');
      const recycle = button(t('migration.action.recycle'), 'mini', async () => {
        const yes = await confirmDanger({ titleKey: 'migration.recycle.title', bodyKey: 'migration.recycle.body', bodyParams: { root: p.root, version: p.version || '?' }, okKey: 'migration.action.recycle' });
        if (!yes || busy) return;
        busy = true;
        try {
          await api('/api/migration/recycle', { method: 'POST', body: JSON.stringify({ root: p.root, confirm: p.root }) });
          toast(t('migration.toast.recycled', { version: p.version || '?' }), 'ok');
        } catch (e) { toast(errorText(e), 'error'); }
        finally { busy = false; }
        void refresh_();
      });
      recycle.dataset.migrationAction = 'recycle';
      recycle.disabled = Boolean(p.running || p.refCount || p.containsCurrent);
      if (recycle.disabled) recycle.title = p.running ? t('migration.error.running') : (p.refCount ? t('migration.error.referenced') : t('migration.error.current_package'));
      actions.appendChild(recycle);
      r.appendChild(actions);
      pk.appendChild(r);
    }
    root.appendChild(pk);

    const refs = s.refs || [];
    const refBox = el('div', 'migration-group');
    refBox.dataset.group = 'refs';
    refBox.appendChild(el('div', 'migration-group-title', t('migration.refs.title', { count: refs.length })));
    if (!refs.length) refBox.appendChild(el('p', 'field-help muted', t('migration.refs.none')));
    for (const ref of refs) {
      const r = row('migration-row-ref');
      r.dataset.refId = ref.id;
      const label = el('label', 'check migration-ref-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.dataset.refId = ref.id;
      cb.disabled = ref.action === 'manual';
      cb.checked = ref.action !== 'manual' && !unchecked.has(ref.id);
      cb.onchange = () => { if (cb.checked) unchecked.delete(ref.id); else unchecked.add(ref.id); };
      label.append(cb, rowText(ref.displayFile + ' · ' + ref.entryLabel, migrationRefSummary(ref)));
      r.appendChild(label);
      refBox.appendChild(r);
    }
    const actions = el('div', 'migration-actions');
    const applyBtn = button(t('migration.action.applyAll'), 'mini primary', async () => {
      const ids = refs.filter(x => x.action !== 'manual' && !unchecked.has(x.id)).map(x => x.id);
      if (!ids.length) { toast(t('migration.toast.nothing')); return; }
      const res = await apply({ rewriteRefs: ids });
      if (res && res.refs && res.refs.ok) toast(t('migration.toast.applied', { count: res.refs.items }), 'ok');
      else if (res) toast(errorText(res.refs || res), 'error');
      void refresh_();
    });
    applyBtn.dataset.migrationAction = 'apply-refs';
    applyBtn.disabled = !refs.some(x => x.action !== 'manual');
    actions.appendChild(applyBtn);
    const undoBtn = button(s.lastMigration ? t('migration.action.undo', { time: fmtTime(s.lastMigration.createdAt) }) : t('migration.action.undoNone'), 'mini', async () => {
      if (busy) return;
      busy = true;
      try {
        const res = await api('/api/migration/undo', { method: 'POST', body: JSON.stringify({}) });
        toast(t('migration.toast.undone', { count: res.restored || 0 }), 'ok');
      } catch (e) { toast(errorText(e), 'error'); }
      finally { busy = false; }
      void refresh_();
    });
    undoBtn.dataset.migrationAction = 'undo';
    undoBtn.disabled = !s.lastMigration;
    actions.appendChild(undoBtn);
    refBox.appendChild(actions);
    root.appendChild(refBox);
  }

  function render(s) {
    const root = ensureMounted();
    if (!root) return;
    while (root.firstChild) root.removeChild(root.firstChild);
    renderHead(root);
    if (!s || !s.ok) {
      root.appendChild(el('p', 'field-help muted', t('migration.loadFailed')));
      return;
    }
    renderSettings(root, s);
    renderImports(root, s);
    renderPackages(root, s);
    root.dataset.loaded = '1';
  }

  async function refresh_() {
    try { lastScan = await scan(); }
    catch (e) { lastScan = null; }
    render(lastScan);
    return lastScan;
  }

  // ── 首启卡 ──
  function cardHost() {
    let host = doc.getElementById(MIGRATION_CARD_HOST_ID);
    if (!host) {
      host = el('div');
      host.id = MIGRATION_CARD_HOST_ID;
      host.setAttribute('aria-live', 'polite');
      doc.body.appendChild(host);
    }
    return host;
  }
  function removeCard() {
    const host = doc.getElementById(MIGRATION_CARD_HOST_ID);
    if (host) while (host.firstChild) host.removeChild(host.firstChild);
  }
  function cardLine(counts) {
    const parts = [];
    if (counts.instructions || counts.instructionsImportable) parts.push(t('migration.card.instructions', { count: counts.instructions + counts.instructionsImportable }));
    if (counts.mcpImported || counts.mcpImportable) parts.push(t('migration.card.mcp', { count: counts.mcpImported + counts.mcpImportable }));
    if (counts.skills) parts.push(t('migration.card.skills', { count: counts.skills }));
    if (counts.packages) parts.push(t('migration.card.packages', { count: counts.packages }));
    return parts.join(t('migration.card.sep'));
  }
  function showCard(s) {
    const host = cardHost();
    removeCard();
    const card = el('div', 'quiet-card migration-card');
    card.setAttribute('role', 'status');
    card.appendChild(el('span', 'quiet-card-dot migration-card-dot'));
    const body = el('div', 'quiet-card-body');
    body.appendChild(el('div', 'quiet-card-title', t('migration.card.title')));
    body.appendChild(el('div', 'quiet-card-line', cardLine((s.prompt && s.prompt.counts) || {}) || t('migration.card.generic')));
    const actions = el('div', 'quiet-card-actions');
    const go = button(t('migration.card.go'), 'quiet-card-btn quiet-card-btn-go', async () => {
      removeCard();
      void apply({ markSeen: true });
      openIntegrations();
      await refresh_();
      const root = doc.getElementById(MIGRATION_CENTER_ID);
      if (root && typeof root.scrollIntoView === 'function') root.scrollIntoView({ block: 'start' });
    });
    go.dataset.migrationCard = 'go';
    const later = button(t('migration.card.later'), 'quiet-card-btn quiet-card-btn-later', () => {
      removeCard();
      void apply({ markSeen: true });
    });
    later.dataset.migrationCard = 'later';
    actions.append(go, later);
    body.appendChild(actions);
    card.appendChild(body);
    host.appendChild(card);
  }
  // 弹窗开着（例如首启引导）时先不出卡：等它关了再说。最多等 10 分钟。
  function modalOpen() {
    // 静态弹窗关着时带 .hidden;动态弹窗(buildModal / 首启引导)关掉即移出文档 —— 在文档里且没 .hidden 就是开着。
    return [...doc.querySelectorAll('.modal-backdrop')].some(node => !node.classList.contains('hidden'));
  }
  async function maybePrompt() {
    let s = null;
    try { s = await scan(); } catch { return; }
    lastScan = s;
    if (doc.getElementById(MIGRATION_CENTER_ID)) render(s);
    if (!s || !s.prompt || !s.prompt.show) return;
    const deadline = Date.now() + 10 * 60 * 1000;
    const tick = () => {
      if (modalOpen() && Date.now() < deadline) { setTimeout(tick, 2000); return; }
      showCard(s);
    };
    tick();
  }

  // ── 接线 ──
  ensureMounted();
  const p = panel();
  if (p && typeof MutationObserver === 'function') {
    // 页签被切到（.settings-tab.active）时现扫一次 —— 不在启动期为一个没人看的面板付扫描。
    let wasActive = p.classList.contains('active');
    new MutationObserver(() => {
      const active = p.classList.contains('active');
      if (active && !wasActive) void refresh_();
      wasActive = active;
    }).observe(p, { attributes: true, attributeFilter: ['class'] });
  }
  setTimeout(() => { void maybePrompt(); }, Math.max(0, Number(promptDelayMs) || 0));
  return { refresh: refresh_, showCard, removeCard, get lastScan() { return lastScan; } };
}
