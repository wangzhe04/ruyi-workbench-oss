'use strict';

// 118a: shell-agnostic welcome wizard.
//
// Why a zero-import factory: both shells (classic `session-experience.js` and preview `preview-shell.js`)
// and the settings page must be able to open the SAME wizard, and the 117 steward line has to be able to
// replay the same step definitions as a conversation. So every environment dependency (state / api / el /
// t / toast / picker / settings opener) is injected, and the pure parts (step list, shape validators,
// first-run gate) are plain named exports that a test or the steward can call without a DOM.
//
// Discipline: zero innerHTML (DOM is built with the injected el() + textContent), the API key is never
// stored in module state beyond the live form nor echoed back into the UI after the save, and provider
// serialization is NOT reimplemented here: providerDraftFromPreset() is injected from provider-settings.js
// so the settings page and the wizard write byte-identical provider entries.

export const ONBOARDING_VERSION = 1;

// Step ids in presentation order. The steward (117) drives the same list conversationally.
export const ONBOARDING_STEP_IDS = Object.freeze(['language', 'engine', 'provider', 'workspace', 'safety', 'done']);
// Engine choice on step 2. 'cloud' = a hosted preset, 'local' = any OpenAI-compatible endpoint (Ollama /
// LM Studio / an intranet gateway), 'cli' = an already installed Claude Code / Kimi Code binary.
export const ONBOARDING_ENGINE_CHOICES = Object.freeze(['cloud', 'local', 'cli']);
// Human-worded safety profiles on step 5, mapped 1:1 to config.permissionMode values.
export const ONBOARDING_SAFETY_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto']);
// The three most universal built-in playbooks offered on the completion page.
export const ONBOARDING_PLAYBOOK_IDS = Object.freeze(['clean-downloads', 'meeting-minutes', 'translate-document']);
// Example only. The wizard prefills it for the local choice but the user must confirm/edit it before saving.
export const LOCAL_ENDPOINT_EXAMPLE = 'http://127.0.0.1:11434/v1';
// 118a-fix: the manual is read INSIDE Ruyi. The completion page used to print a relative file location
// plus a button that put it on the system pasteboard, i.e. it sent the user off to a file manager;
// the product owner ruled that out. The button now calls the injected openHelpViewer(), which fetches
// GET /api/help/doc and renders the markdown in-app. Only this document id crosses the wire.
export const ONBOARDING_MANUAL_DOC_ID = 'user-guide';

// 118d: 全应用共用的向导实例登记处(与 help-viewer.js 的 registerHelpViewer 完全同一口径)。
// 帮助菜单住在 navigation-controls(popover 原语在那里),但向导实例由经典壳持有:经典壳建好后登记
// 在这里,菜单只调 openSharedOnboarding(),于是仍然只有一个向导实例,组合根一行不加。
// 没有登记(例如预览壳单独跑)时返回 null,调用方按「没有这个入口」处理。
let sharedOnboardingWizard = null;
export function registerOnboardingWizard(instance) { sharedOnboardingWizard = instance || null; return instance; }
export function openSharedOnboarding(options) {
  return sharedOnboardingWizard && typeof sharedOnboardingWizard.openOnboardingWizard === 'function'
    ? sharedOnboardingWizard.openOnboardingWizard(options)
    : null;
}
export function hasSharedOnboarding() { return Boolean(sharedOnboardingWizard); }

const STEP_META = Object.freeze({
  language: { titleKey: 'onboarding.wizard.language.title', shortKey: 'onboarding.wizard.step.language' },
  engine: { titleKey: 'onboarding.wizard.engine.title', shortKey: 'onboarding.wizard.step.engine' },
  provider: { titleKey: 'onboarding.wizard.provider.title', shortKey: 'onboarding.wizard.step.provider' },
  workspace: { titleKey: 'onboarding.wizard.workspace.title', shortKey: 'onboarding.wizard.step.workspace' },
  safety: { titleKey: 'onboarding.wizard.safety.title', shortKey: 'onboarding.wizard.step.safety' },
  done: { titleKey: 'onboarding.wizard.done.title', shortKey: 'onboarding.wizard.step.done' },
});

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

// The pure first-run gate. It is the classic isFirstRun() derivation (no sessions AND no remembered
// workspaces) narrowed by the persisted record: once the user finished OR explicitly said 「以后再说」,
// the wizard stops offering itself and only the explicit settings entry reopens it.
export function shouldShowOnboarding(config, sessions) {
  const record = asObject(asObject(config).onboarding);
  if (record.completedAt) return false;
  if (record.skipped === true) return false;
  const noSessions = !asArray(sessions).length;
  const noWorkspaces = !asArray(asObject(config).recentWorkspaces).length;
  return noSessions && noWorkspaces;
}

// Data-driven step list. Always the same six steps in the same order (the wizard may fast-forward through
// one at runtime, e.g. the provider step when the user already has a CLI, but the definition never shrinks
// so 117 can render the identical checklist). `done` is derived from config only, never from live UI state.
export function onboardingStepsFor(config) {
  const c = asObject(config);
  const providers = asArray(c.providers);
  const engineReady = providers.length > 0 || Boolean(c.claudePath) || Boolean(c.kimiPath);
  const workspaceReady = asArray(c.recentWorkspaces).length > 0 || Boolean(c.defaultWorkspace);
  const doneFlag = {
    language: typeof c.locale === 'string' && c.locale !== '' && c.locale !== 'auto',
    engine: engineReady,
    provider: providers.length > 0,
    workspace: workspaceReady,
    safety: typeof c.permissionMode === 'string' && c.permissionMode !== '',
    done: Boolean(asObject(c.onboarding).completedAt),
  };
  return ONBOARDING_STEP_IDS.map((id, index) => ({
    id,
    index,
    titleKey: STEP_META[id].titleKey,
    shortKey: STEP_META[id].shortKey,
    optional: id === 'provider',
    done: doneFlag[id] === true,
  }));
}

// Front-of-the-line API key shape check. It never talks to the network: it only catches the mistakes that
// otherwise turn into an opaque HTTP 401 (empty paste, a copied line break, half a key, the masked value
// read back from /api/status). `presetId === 'local'` means a local endpoint, where a blank key is normal.
export function validateApiKeyShape(presetId, key) {
  const preset = String(presetId || '');
  const raw = key == null ? '' : String(key);
  const allowsEmpty = preset === 'local';
  if (!raw.trim()) return allowsEmpty ? { ok: true, code: '', warn: '' } : { ok: false, code: 'keyEmpty', warn: '' };
  if (/[\s]/.test(raw)) return { ok: false, code: 'keyWhitespace', warn: '' };
  if (raw.startsWith('•')) return { ok: false, code: 'keyMasked', warn: '' };
  if (raw.length < 8) return { ok: false, code: 'keyTooShort', warn: '' };
  if (raw.length > 512) return { ok: false, code: 'keyTooLong', warn: '' };
  // Non-blocking nudge: most hosted OpenAI-compatible vendors issue sk-prefixed keys. A local or
  // custom endpoint may legitimately use anything, so this never blocks the flow.
  const wantsSkPrefix = preset === 'deepseek' || preset === 'openai' || preset === 'openai-compatible';
  const warn = wantsSkPrefix && !raw.startsWith('sk-') ? 'keyPrefixWarning' : '';
  return { ok: true, code: '', warn };
}

// Front-of-the-line base URL shape check. Same intent: catch 「粘贴了控制台首页地址」 before the request.
export function validateBaseUrlShape(url) {
  const raw = url == null ? '' : String(url);
  if (!raw.trim()) return { ok: false, code: 'urlEmpty' };
  if (/\s/.test(raw)) return { ok: false, code: 'urlSpace' };
  if (!/^https?:\/\//i.test(raw)) return { ok: false, code: 'urlScheme' };
  if (!/^https?:\/\/[^/\s?#]+/i.test(raw)) return { ok: false, code: 'urlScheme' };
  return { ok: true, code: '' };
}

// A failed API response carries `error` either as a plain sentence or as the structured
// {code, params, message} envelope the server wraps strings into. Read the human sentence out of
// both shapes so the wizard never shows "[object Object]" on the most common first-run failure.
export function errorMessageOf(payload) {
  const raw = payload && payload.error;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof raw.message === 'string') return raw.message;
  return '';
}

// Module-level singleton guard. Two shells may each build a domain instance; only one wizard may be open.
let openBackdrop = null;

export function createOnboardingWizardDomain({
  state = { config: {}, sessions: [], status: null, playbooks: [] },
  api = async () => ({}),
  el = (tag) => ({ tag }),
  t = key => key,
  toast = () => {},
  apiErrText = error => String((error && error.message) || error || ''),
  getLocale = () => 'zh-CN',
  setLocale = async locale => locale,
  providerDraftFromPreset = null,
  pickWorkspace = async () => {},
  openSettings = () => {},
  openPlaybook = () => {},
  onConfigChanged = () => {},
  doc = globalThis.document,
  // 118a-fix: 应用内手册阅读器入口(help-viewer.js)。组合根注入,向导本身仍壳无关。
  openHelpViewer = () => {},
} = {}) {

  /* ---------------- persistence ---------------- */
  // The single config write path used by every step. Mirrors provider-settings' saveConfigPartial (POST
  // /api/config merges a partial patch, the response is the normalized config) so the wizard never keeps
  // a divergent copy of the config.
  async function persist(patch) {
    try {
      const res = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
      if (res && res.config) state.config = res.config;
      try { onConfigChanged(); } catch { /* host redraw is best-effort */ }
      return true;
    } catch (error) {
      toast(t('onboarding.wizard.saveFailed', { reason: apiErrText(error) }), 'err');
      return false;
    }
  }

  function markOnboarding(record) {
    return persist({ onboarding: { completedAt: record.completedAt || null, version: ONBOARDING_VERSION, skipped: record.skipped === true } });
  }

  /* ---------------- modal frame ---------------- */
  function focusableIn(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    const selector = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    try { return [...root.querySelectorAll(selector)]; } catch { return []; }
  }

  function buildFrame(onCancel) {
    const backdrop = el('div', 'modal-backdrop dynamic onboard-wizard-backdrop');
    const trigger = doc && doc.activeElement;
    let closed = false;
    const finish = cancelled => {
      if (closed) return;
      closed = true;
      if (openBackdrop === backdrop) openBackdrop = null;
      if (cancelled && onCancel) { try { onCancel(); } catch { /* ignore */ } }
      try { backdrop.remove(); } catch { /* already detached */ }
      if (trigger && typeof trigger.focus === 'function') { try { trigger.focus(); } catch { /* ignore */ } }
    };
    // The global Esc handler in app.js calls __cancel on every open backdrop, so Esc means 「以后再说」.
    backdrop.__cancel = () => finish(true);
    backdrop.__close = () => finish(false);

    const modal = el('div', 'modal onboard-wizard');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', t('onboarding.wizard.title'));

    const head = el('div', 'modal-head');
    const heading = el('div', 'onboard-wiz-heading');
    const title = el('h3', '', t('onboarding.wizard.title'));
    const counter = el('div', 'onboard-wiz-counter muted', '');
    heading.append(title, counter);
    const closeBtn = el('button', 'icon-btn onboard-wiz-close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', t('common.close'));
    closeBtn.onclick = () => finish(true);
    head.append(heading, closeBtn);

    const rail = el('div', 'onboard-wiz-rail');
    rail.setAttribute('aria-hidden', 'true');
    const body = el('div', 'modal-body onboard-wiz-body');
    const status = el('div', 'onboard-wiz-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const foot = el('div', 'modal-foot onboard-wiz-foot');

    modal.append(head, rail, body, status, foot);
    backdrop.appendChild(modal);
    if (typeof backdrop.addEventListener === 'function') {
      backdrop.addEventListener('mousedown', e => { if (e && e.target === backdrop) finish(true); });
      // Focus trap: Tab/Shift+Tab cycle inside the dialog, matching interaction-prompts' installFocusTrap.
      backdrop.addEventListener('keydown', e => {
        if (!e || e.key !== 'Tab') return;
        const nodes = focusableIn(modal).filter(n => n && n.offsetParent !== null);
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = doc && doc.activeElement;
        const inside = typeof modal.contains === 'function' ? modal.contains(active) : true;
        if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); if (typeof last.focus === 'function') last.focus(); }
        else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); if (typeof first.focus === 'function') first.focus(); }
      });
    }
    if (doc && doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(backdrop);
    return { backdrop, modal, counter, rail, body, status, foot, close: () => finish(false), cancel: () => finish(true) };
  }

  /* ---------------- small builders ---------------- */
  function fieldBlock(labelText, control) {
    const block = el('div', 'field-block onboard-wiz-field');
    block.append(el('label', '', labelText), control);
    return block;
  }

  function choiceCard({ selected, title, description, onSelect, extra }) {
    const card = el('button', 'onboard-wiz-card' + (selected ? ' selected' : ''));
    card.type = 'button';
    card.setAttribute('aria-pressed', selected ? 'true' : 'false');
    card.append(el('div', 'onboard-wiz-card-title', title));
    if (description) card.append(el('div', 'onboard-wiz-card-desc', description));
    if (extra) card.append(el('div', 'onboard-wiz-card-extra', extra));
    card.onclick = () => onSelect();
    return card;
  }

  /* ---------------- the wizard ---------------- */
  function openOnboardingWizard(options = {}) {
    if (openBackdrop) return openBackdrop; // never stack two wizards
    const config = asObject(state.config);
    const wiz = {
      step: 0,
      engineChoice: 'cloud',
      presetId: '',
      apiKey: '',
      baseUrl: '',
      model: '',
      models: [],
      testing: false,
      tested: false,
      saving: false,
      message: '',
      messageKind: '',
      permissionMode: ONBOARDING_SAFETY_MODES.includes(config.permissionMode) ? config.permissionMode : 'default',
    };
    const presets = asArray(state.status && state.status.providerPresets);
    if (presets.length) {
      wiz.presetId = presets[0].id;
      wiz.baseUrl = presets[0].baseUrl || '';
      wiz.model = presets[0].defaultModel || '';
    }
    // opts.startStep opens directly on one step id (a settings deep link, or 117 resuming a conversation
    // mid-checklist). An unknown id simply starts at the beginning.
    const requestedStep = ONBOARDING_STEP_IDS.indexOf(String(options.startStep || ''));
    if (requestedStep > 0) wiz.step = requestedStep;

    const frame = buildFrame(async () => { await markOnboarding({ skipped: true }); toast(t('onboarding.wizard.skipped'), ''); });
    openBackdrop = frame.backdrop;

    const setMessage = (text, kind) => { wiz.message = String(text || ''); wiz.messageKind = kind || ''; paintStatus(); };
    function paintStatus() {
      frame.status.className = 'onboard-wiz-status' + (wiz.messageKind ? ' ' + wiz.messageKind : '');
      frame.status.textContent = wiz.message;
    }

    // Runtime step order: choosing an installed CLI skips the API-key step (the definition still has six).
    function activeStepIds() {
      return ONBOARDING_STEP_IDS.filter(id => !(id === 'provider' && wiz.engineChoice === 'cli'));
    }
    function currentStepId() {
      const ids = activeStepIds();
      return ids[Math.max(0, Math.min(wiz.step, ids.length - 1))];
    }
    function goto(delta) {
      const ids = activeStepIds();
      wiz.step = Math.max(0, Math.min(wiz.step + delta, ids.length - 1));
      wiz.message = '';
      wiz.messageKind = '';
      render();
    }

    function render() {
      const ids = activeStepIds();
      const stepId = currentStepId();
      const steps = onboardingStepsFor(state.config);
      const meta = STEP_META[stepId];
      frame.modal.setAttribute('aria-label', t('onboarding.wizard.title'));
      frame.counter.textContent = t('onboarding.wizard.stepCounter', {
        current: wiz.step + 1, total: ids.length, title: t(meta.titleKey),
      });
      // Step rail (decorative; the counter carries the same information for screen readers).
      const railItems = ids.map(id => {
        const def = steps.find(s => s.id === id);
        const dot = el('span', 'onboard-wiz-rail-item' + (id === stepId ? ' current' : '') + (def && def.done ? ' done' : ''), t(STEP_META[id].shortKey));
        return dot;
      });
      frame.rail.replaceChildren(...railItems);
      frame.body.replaceChildren(buildStep(stepId));
      frame.foot.replaceChildren(...buildFoot(stepId));
      paintStatus();
      // Focus the first control of the new step so keyboard users land inside the dialog.
      const first = focusableIn(frame.body)[0];
      if (first && typeof first.focus === 'function') setTimeout(() => { try { first.focus(); } catch { /* ignore */ } }, 0);
    }

    function buildFoot(stepId) {
      const nodes = [];
      const skip = el('button', 'ghost onboard-wiz-skip', t('onboarding.wizard.skip'));
      skip.type = 'button';
      skip.onclick = () => frame.cancel();
      nodes.push(skip);
      nodes.push(el('span', 'onboard-wiz-foot-spacer'));
      if (wiz.step > 0) {
        const back = el('button', 'file-label onboard-wiz-back', t('onboarding.wizard.back'));
        back.type = 'button';
        back.onclick = () => goto(-1);
        nodes.push(back);
      }
      if (stepId === 'done') {
        const finishBtn = el('button', 'primary onboard-wiz-finish', t('onboarding.wizard.finish'));
        finishBtn.type = 'button';
        finishBtn.onclick = async () => {
          finishBtn.disabled = true;
          const saved = await markOnboarding({ completedAt: new Date().toISOString(), skipped: false });
          finishBtn.disabled = false;
          if (!saved) return;
          toast(t('onboarding.wizard.completed'), 'ok');
          frame.close();
        };
        nodes.push(finishBtn);
      } else if (stepId !== 'provider') {
        const next = el('button', 'primary onboard-wiz-next', t('onboarding.wizard.next'));
        next.type = 'button';
        next.onclick = () => goto(1);
        nodes.push(next);
      }
      if (stepId === 'provider') {
        // A user with no key yet must still be able to reach the folder/safety steps and the task cards,
        // otherwise the wizard becomes a wall. The engine stays unconfigured and the first-run card keeps
        // pointing at settings, which is the honest state.
        const skipStep = el('button', 'file-label onboard-wiz-skipstep', t('onboarding.wizard.provider.skipStep'));
        skipStep.type = 'button';
        skipStep.onclick = () => goto(1);
        nodes.push(skipStep);
        const save = el('button', 'primary onboard-wiz-save', t('onboarding.wizard.provider.saveAndNext'));
        save.type = 'button';
        save.disabled = wiz.saving;
        save.onclick = () => saveProvider();
        nodes.push(save);
      }
      return nodes;
    }

    function buildStep(stepId) {
      if (stepId === 'language') return buildLanguageStep();
      if (stepId === 'engine') return buildEngineStep();
      if (stepId === 'provider') return buildProviderStep();
      if (stepId === 'workspace') return buildWorkspaceStep();
      if (stepId === 'safety') return buildSafetyStep();
      return buildDoneStep();
    }

    /* ① language */
    function buildLanguageStep() {
      const wrap = el('div', 'onboard-wiz-step onboard-wiz-language');
      wrap.append(el('h4', 'onboard-wiz-step-title', t('onboarding.wizard.language.title')));
      wrap.append(el('p', 'onboard-wiz-step-hint muted', t('onboarding.wizard.language.hint')));
      const select = el('select', 'onboard-wiz-locale');
      for (const [value, key] of [['auto', 'settings.language.auto'], ['zh-CN', 'settings.language.zhCN'], ['en-US', 'settings.language.enUS']]) {
        const option = el('option', '', t(key));
        option.value = value;
        select.appendChild(option);
      }
      const configured = String(asObject(state.config).locale || 'auto');
      select.value = ['auto', 'zh-CN', 'en-US'].includes(configured) ? configured : 'auto';
      select.onchange = async () => {
        const value = select.value;
        await persist({ locale: value });
        const resolved = await setLocale(value);
        // 'auto' persists the resolved locale exactly like boot() does, so a later launch stays put.
        if (value === 'auto' && resolved) await persist({ locale: resolved });
        render();
      };
      wrap.append(fieldBlock(t('settings.language'), select));
      wrap.append(el('p', 'onboard-wiz-note muted', t('onboarding.wizard.language.current', { locale: getLocale() })));
      return wrap;
    }

    /* ② engine */
    function buildEngineStep() {
      const wrap = el('div', 'onboard-wiz-step onboard-wiz-engine');
      wrap.append(el('h4', 'onboard-wiz-step-title', t('onboarding.wizard.engine.title')));
      wrap.append(el('p', 'onboard-wiz-step-hint muted', t('onboarding.wizard.engine.hint')));
      const cards = el('div', 'onboard-wiz-cards');
      const pick = choice => {
        wiz.engineChoice = choice;
        wiz.tested = false;
        wiz.models = [];
        if (choice === 'local') {
          wiz.presetId = 'local';
          wiz.baseUrl = wiz.baseUrl && !presets.some(p => p.baseUrl === wiz.baseUrl) ? wiz.baseUrl : LOCAL_ENDPOINT_EXAMPLE;
          wiz.apiKey = '';
          wiz.model = '';
        } else if (choice === 'cloud') {
          const preset = presets[0];
          wiz.presetId = preset ? preset.id : '';
          wiz.baseUrl = preset ? (preset.baseUrl || '') : '';
          wiz.model = preset ? (preset.defaultModel || '') : '';
        }
        render();
      };
      cards.append(choiceCard({
        selected: wiz.engineChoice === 'cloud',
        title: t('onboarding.wizard.engine.cloud.title'),
        description: t('onboarding.wizard.engine.cloud.description'),
        onSelect: () => pick('cloud'),
      }));
      cards.append(choiceCard({
        selected: wiz.engineChoice === 'local',
        title: t('onboarding.wizard.engine.local.title'),
        description: t('onboarding.wizard.engine.local.description'),
        onSelect: () => pick('local'),
      }));
      cards.append(choiceCard({
        selected: wiz.engineChoice === 'cli',
        title: t('onboarding.wizard.engine.cli.title'),
        description: t('onboarding.wizard.engine.cli.description'),
        onSelect: () => pick('cli'),
      }));
      wrap.append(cards);
      // The CLI path is folded away: it points at the existing settings tab instead of duplicating it.
      const details = el('details', 'onboard-wiz-details');
      const summary = el('summary', '', t('onboarding.wizard.engine.cli.summary'));
      details.append(summary);
      details.append(el('p', 'muted', t('onboarding.wizard.engine.cli.hint')));
      const cliBtn = el('button', 'file-label', t('onboarding.wizard.engine.cli.action'));
      cliBtn.type = 'button';
      cliBtn.onclick = () => { openSettings('claude'); };
      details.append(cliBtn);
      details.open = wiz.engineChoice === 'cli';
      wrap.append(details);
      return wrap;
    }

    /* ③ provider (API key only, advanced folded) */
    function buildProviderStep() {
      const wrap = el('div', 'onboard-wiz-step onboard-wiz-provider');
      wrap.append(el('h4', 'onboard-wiz-step-title', t('onboarding.wizard.provider.title')));
      wrap.append(el('p', 'onboard-wiz-step-hint muted', wiz.engineChoice === 'local'
        ? t('onboarding.wizard.provider.localHint')
        : t('onboarding.wizard.provider.hint')));

      if (wiz.engineChoice !== 'local') {
        const cards = el('div', 'onboard-wiz-presets');
        for (const preset of presets) {
          cards.append(choiceCard({
            selected: wiz.presetId === preset.id,
            title: preset.label || preset.id,
            description: preset.baseUrl || t('onboarding.wizard.provider.noBaseUrl'),
            extra: preset.defaultModel || '',
            onSelect: () => {
              wiz.presetId = preset.id;
              wiz.baseUrl = preset.baseUrl || '';
              wiz.model = preset.defaultModel || '';
              wiz.models = [];
              wiz.tested = false;
              render();
            },
          }));
        }
        if (!presets.length) cards.append(el('div', 'muted', t('onboarding.wizard.provider.noPresets')));
        wrap.append(cards);
      }

      // The only always-visible field: the API key. Password type, with an explicit reveal toggle.
      const keyWrap = el('div', 'prov-key-wrap onboard-wiz-keywrap');
      const keyInput = el('input', 'onboard-wiz-key');
      keyInput.type = 'password';
      keyInput.autocomplete = 'off';
      keyInput.spellcheck = false;
      keyInput.value = wiz.apiKey;
      keyInput.placeholder = t('onboarding.wizard.provider.apiKeyPlaceholder');
      keyInput.oninput = () => { wiz.apiKey = keyInput.value; wiz.tested = false; };
      const eye = el('button', 'prov-key-eye onboard-wiz-key-eye', '\u{1F441}');
      eye.type = 'button';
      eye.setAttribute('aria-label', t('onboarding.wizard.provider.showKey'));
      eye.onclick = () => {
        const reveal = keyInput.type === 'password';
        keyInput.type = reveal ? 'text' : 'password';
        eye.classList.toggle('on', reveal);
      };
      keyWrap.append(keyInput, eye);
      wrap.append(fieldBlock(t('onboarding.wizard.provider.apiKey'), keyWrap));
      wrap.append(el('p', 'onboard-wiz-note muted', t('onboarding.wizard.provider.keyPrivacy')));

      // Advanced: base URL + model. Auto-open for the local choice, where the address IS the decision.
      const advanced = el('details', 'onboard-wiz-details onboard-wiz-advanced');
      advanced.open = wiz.engineChoice === 'local';
      advanced.append(el('summary', '', t('onboarding.wizard.provider.advanced')));
      const urlInput = el('input', 'onboard-wiz-baseurl');
      urlInput.type = 'text';
      urlInput.value = wiz.baseUrl;
      urlInput.placeholder = LOCAL_ENDPOINT_EXAMPLE;
      urlInput.oninput = () => { wiz.baseUrl = urlInput.value.trim(); wiz.tested = false; };
      advanced.append(fieldBlock(t('onboarding.wizard.provider.baseUrl'), urlInput));
      const modelHost = el('div', 'onboard-wiz-model-host');
      modelHost.appendChild(buildModelControl());
      advanced.append(fieldBlock(t('onboarding.wizard.provider.model'), modelHost));
      wrap.append(advanced);

      const testBtn = el('button', 'file-label onboard-wiz-test', wiz.testing ? t('onboarding.wizard.provider.testing') : t('onboarding.wizard.provider.test'));
      testBtn.type = 'button';
      testBtn.disabled = wiz.testing;
      testBtn.onclick = () => testConnection();
      wrap.append(testBtn);
      return wrap;
    }

    // A datalist-backed text input before a successful probe; a real <select> once the endpoint returned a
    // model list (same enrichment idea as provider-settings' testProvider, minus the settings-only chrome).
    function buildModelControl() {
      if (wiz.models.length) {
        const select = el('select', 'onboard-wiz-model');
        for (const model of wiz.models) {
          const option = el('option', '', model.label || model.id);
          option.value = model.id;
          select.appendChild(option);
        }
        if (wiz.models.some(m => m.id === wiz.model)) select.value = wiz.model;
        else { wiz.model = wiz.models[0].id; select.value = wiz.model; }
        select.onchange = () => { wiz.model = select.value; };
        return select;
      }
      const input = el('input', 'onboard-wiz-model');
      input.type = 'text';
      input.value = wiz.model;
      input.placeholder = t('onboarding.wizard.provider.modelPlaceholder');
      input.oninput = () => { wiz.model = input.value.trim(); };
      return input;
    }

    function currentPreset() {
      if (wiz.engineChoice === 'local') {
        return { id: 'local', label: t('onboarding.wizard.engine.local.title'), baseUrl: wiz.baseUrl, defaultModel: wiz.model, models: [] };
      }
      return presets.find(p => p.id === wiz.presetId) || presets[0] || { id: 'openai-compatible', label: 'OpenAI', baseUrl: wiz.baseUrl, defaultModel: wiz.model, models: [] };
    }

    // Build the provider entry with the SAME serializer the settings page uses, then overlay the three
    // fields the wizard collected. No second provider shape lives here.
    function buildDraft() {
      const preset = currentPreset();
      const existing = asArray(asObject(state.config).providers).map(p => p && p.id).filter(Boolean);
      const draft = typeof providerDraftFromPreset === 'function'
        ? providerDraftFromPreset(preset, existing)
        : null;
      if (!draft) return null;
      draft.baseUrl = wiz.baseUrl;
      draft.apiKey = wiz.apiKey;
      if (wiz.model) draft.model = wiz.model;
      if (wiz.models.length) {
        const seen = new Set(asArray(draft.models).map(m => m && m.id));
        for (const model of wiz.models) if (model.id && !seen.has(model.id)) { seen.add(model.id); draft.models.push({ id: model.id, label: model.label || model.id }); }
      }
      return draft;
    }

    function validateForm() {
      const presetKey = wiz.engineChoice === 'local' ? 'local' : wiz.presetId;
      const url = validateBaseUrlShape(wiz.baseUrl);
      if (!url.ok) { setMessage(t('onboarding.wizard.validate.' + url.code), 'err'); return null; }
      const key = validateApiKeyShape(presetKey, wiz.apiKey);
      if (!key.ok) { setMessage(t('onboarding.wizard.validate.' + key.code), 'err'); return null; }
      if (key.warn) setMessage(t('onboarding.wizard.validate.' + key.warn), 'warn');
      return buildDraft();
    }

    async function testConnection() {
      const draft = validateForm();
      if (!draft) return;
      wiz.testing = true;
      render();
      try {
        const result = await api('/api/provider/test', { method: 'POST', body: JSON.stringify({ provider: draft }) });
        if (result && result.ok) {
          wiz.tested = true;
          wiz.models = asArray(result.models).map(m => ({ id: String((m && m.id) || ''), label: String((m && (m.label || m.id)) || '') })).filter(m => m.id);
          if (wiz.models.length && !wiz.models.some(m => m.id === wiz.model)) wiz.model = wiz.model || wiz.models[0].id;
          wiz.testing = false;
          render();
          setMessage(wiz.models.length
            ? t('onboarding.wizard.provider.testSuccess', { count: wiz.models.length })
            : t('onboarding.wizard.provider.testSuccessNoModels'), 'ok');
          return;
        }
        wiz.testing = false;
        render();
        // The server already returns a human sentence; errorClass adds the 「怎么办」 line from the same
        // catalog the error cards use, so the wizard never invents its own diagnosis.
        const detail = errorMessageOf(result) || t('provider.testFailure');
        const nextKey = result && result.errorClass === 'network_down' ? 'error.networkDown.next'
          : result && result.errorClass === 'provider_misconfigured' ? 'error.providerMisconfigured.next' : '';
        setMessage(nextKey ? detail + ' ' + t('onboarding.wizard.provider.whatNow', { next: t(nextKey) }) : detail, 'err');
      } catch (error) {
        wiz.testing = false;
        render();
        setMessage(apiErrText(error), 'err');
      }
    }

    async function saveProvider() {
      const draft = validateForm();
      if (!draft) return;
      wiz.saving = true;
      render();
      const providers = asArray(asObject(state.config).providers).filter(p => p && p.id !== draft.id);
      const saved = await persist({ providers: [...providers, draft], activeProvider: draft.id });
      wiz.saving = false;
      if (!saved) { render(); return; }
      // The plaintext key leaves the browser once and is never held for redraw.
      wiz.apiKey = '';
      toast(t('onboarding.wizard.provider.saved', { name: draft.label || draft.id }), 'ok');
      goto(1);
    }

    /* ④ workspace */
    function buildWorkspaceStep() {
      const wrap = el('div', 'onboard-wiz-step onboard-wiz-workspace');
      wrap.append(el('h4', 'onboard-wiz-step-title', t('onboarding.wizard.workspace.title')));
      wrap.append(el('p', 'onboard-wiz-step-hint muted', t('onboarding.wizard.workspace.hint')));
      const zone = el('button', 'onboard-drop onboard-wiz-drop');
      zone.type = 'button';
      zone.append(el('div', 'onboard-drop-icon', '\u{1F4C1}'));
      zone.append(el('div', 'onboard-drop-title', t('onboarding.drop.title')));
      zone.append(el('div', 'onboard-drop-sub', t('onboarding.drop.description')));
      zone.onclick = async () => { await pickWorkspace(); render(); };
      if (typeof zone.addEventListener === 'function') {
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragging'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
        zone.addEventListener('drop', () => zone.classList.remove('dragging'));
      }
      wrap.append(zone);
      const chooseBtn = el('button', 'file-label onboard-wiz-pick', t('onboarding.wizard.workspace.choose'));
      chooseBtn.type = 'button';
      chooseBtn.onclick = async () => { await pickWorkspace(); render(); };
      wrap.append(chooseBtn);
      const current = String(asObject(state.config).defaultWorkspace || '');
      wrap.append(el('p', 'onboard-wiz-note muted', current
        ? t('onboarding.wizard.workspace.current', { path: current })
        : t('onboarding.wizard.workspace.none')));
      return wrap;
    }

    /* ⑤ safety */
    function buildSafetyStep() {
      const wrap = el('div', 'onboard-wiz-step onboard-wiz-safety');
      wrap.append(el('h4', 'onboard-wiz-step-title', t('onboarding.wizard.safety.title')));
      wrap.append(el('p', 'onboard-wiz-step-hint muted', t('onboarding.wizard.safety.hint')));
      const group = el('div', 'onboard-wiz-cards onboard-wiz-safety-cards');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', t('onboarding.wizard.safety.title'));
      for (const mode of ONBOARDING_SAFETY_MODES) {
        const selected = wiz.permissionMode === mode;
        const card = choiceCard({
          selected,
          title: t('onboarding.wizard.safety.' + mode + '.title'),
          description: t('onboarding.wizard.safety.' + mode + '.description'),
          onSelect: async () => {
            wiz.permissionMode = mode;
            await persist({ permissionMode: mode });
            render();
            setMessage(t('onboarding.wizard.safety.saved', { name: t('onboarding.wizard.safety.' + mode + '.title') }), 'ok');
          },
        });
        card.setAttribute('role', 'radio');
        card.setAttribute('aria-checked', selected ? 'true' : 'false');
        group.append(card);
      }
      wrap.append(group);
      return wrap;
    }

    /* ⑥ done */
    function buildDoneStep() {
      const wrap = el('div', 'onboard-wiz-step onboard-wiz-done');
      wrap.append(el('h4', 'onboard-wiz-step-title', t('onboarding.wizard.done.title')));
      wrap.append(el('p', 'onboard-wiz-step-hint muted', t('onboarding.wizard.done.hint')));
      const grid = el('div', 'onboard-wiz-playbooks');
      const all = asArray(state.playbooks);
      for (const id of ONBOARDING_PLAYBOOK_IDS) {
        const playbook = all.find(p => p && p.id === id);
        const card = el('button', 'onboard-wiz-card onboard-wiz-playbook');
        card.type = 'button';
        card.append(el('div', 'onboard-wiz-card-title', (playbook && (playbook.title || playbook.name)) || t('onboarding.wizard.done.playbook.' + id)));
        card.append(el('div', 'onboard-wiz-card-desc', (playbook && playbook.desc) || t('onboarding.wizard.done.playbookHint.' + id)));
        card.onclick = () => {
          if (!playbook) { setMessage(t('onboarding.wizard.done.playbookMissing'), 'warn'); return; }
          frame.close();
          openPlaybook(playbook);
        };
        grid.append(card);
      }
      wrap.append(grid);
      // 118a-fix: manual entry. One button, and it opens the manual right here in the app.
      // The wizard stays open underneath: the reader consumes Esc itself, so closing the manual
      // returns the user to the completion page instead of cancelling the wizard.
      const manual = el('div', 'onboard-wiz-manual');
      manual.append(el('div', 'onboard-wiz-manual-title', t('onboarding.wizard.done.manual')));
      manual.append(el('p', 'muted', t('onboarding.wizard.done.manualHint')));
      const readBtn = el('button', 'file-label onboard-wiz-manual-open', t('help.doc.open'));
      readBtn.type = 'button';
      readBtn.onclick = () => { openHelpViewer({ docId: ONBOARDING_MANUAL_DOC_ID }); };
      manual.append(readBtn);
      wrap.append(manual);
      return wrap;
    }

    render();
    return frame.backdrop;
  }

  return Object.freeze({
    ONBOARDING_VERSION,
    onboardingStepsFor,
    openOnboardingWizard,
    shouldShowOnboarding: (config, sessions) => shouldShowOnboarding(config === undefined ? state.config : config, sessions === undefined ? state.sessions : sessions),
    validateApiKeyShape,
    validateBaseUrlShape,
  });
}
