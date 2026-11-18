// 151 阶段 1 · U3：工作数据维护期的输入框闸门。
// 维护（启用/停用加密、导出、恢复）期间后台不接新回合：修前输入框照常可用，发出去的话得到原始 JSON；
// 交接给冷端维护进程后更是只剩 403/409。现在：维护期禁用 #promptInput 与管家壳的 #stewardComposerInput（151 阶段 1E），
// 并在各自输入框上方说明为什么、该怎么做。
// 状态来源只有 /api/work-data/status（与加密面板同一个接口、同一份已校验字段）：
//   - 加密面板每次读到状态就派 workdata:status 事件，这里直接用，不另起一路轮询；
//   - 发消息失败且码属于维护族时主动查一次；闸门关着时每 pollMs 复查（面板刚报过就跳过），恢复 open 即放开。
// 不在开机时查（status 会整包读取并哈希备份包，见 150 号文 W11）；不改发送按钮（维护期仍要能停止进行中的回合）。
const OPERATIONS = new Set(['enable', 'disable', 'export', 'restore']);
const MAINTENANCE_CODE = /^(?:work_data\.maintenance_[a-z_]+|work_data_setup\.(?:busy|takeover_committed|job_not_found|status_unavailable)|work_data_store\.switch_unavailable)$/;

export function maintenanceGateState(status) {
  const phase = status && status.maintenance && typeof status.maintenance.phase === 'string' ? status.maintenance.phase : '';
  if (!phase || phase === 'open') return null;
  const job = status.job && typeof status.job === 'object' ? status.job : null;
  const operation = job && OPERATIONS.has(job.operation) ? job.operation : '';
  const state = job ? job.state : '';
  if (phase === 'retired') return { reason: state === 'uncertain' ? 'uncertain' : state === 'failed' ? 'failed' : 'handoff', operation };
  if (phase === 'waiting' || phase === 'idle') return { reason: state === 'handoff' ? 'handoff' : state === 'uncertain' ? 'uncertain' : 'draining', operation };
  return null;
}

export function maintenanceGateText(gate, t) {
  if (!gate) return '';
  const operation = gate.operation ? t('workData.operation.' + gate.operation) : t('maintenance.composer.unknownOperation');
  return t('maintenance.composer.' + gate.reason, { operation });
}

export function isMaintenanceFailureCode(code) {
  return typeof code === 'string' && MAINTENANCE_CODE.test(code);
}

// 151 阶段 1E：闸门管两只输入框 —— 工作台 #promptInput 与管家壳 #stewardComposerInput，各自在自己的输入区顶上放一条说明。
const TARGETS = Object.freeze([
  Object.freeze({ input: 'promptInput', host: '.composer', notice: 'maintenanceComposerNotice' }),
  Object.freeze({ input: 'stewardComposerInput', host: '.steward-composer', notice: 'stewardMaintenanceComposerNotice' }),
]);

// 输入框的 disabled 不只归闸门管（管家壳的「先接模型」、进壳绑定也会写它）。闸门关着时，别的主人写进来的意愿先记在
// data-maintenance-prior 里，闸门放开时按它恢复 —— 既不会被别人提前放开，也不会在放开时把「先接模型」的置灰抹掉。
export function setComposerDisabled(input, disabled) {
  if (!input) return;
  if (input.dataset && input.dataset.maintenance) { input.dataset.maintenancePrior = disabled ? '1' : '0'; return; }
  input.disabled = Boolean(disabled);
}
export function maintenanceBlocked(input) {
  return Boolean(input && input.dataset && input.dataset.maintenance);
}
// 管家壳没有主输入框那条 noteMaintenanceFailure 注入线；它发送失败时派这个事件，闸门照样主动复查一次。
export function reportMaintenanceFailure(error, win = globalThis.window) {
  if (!win || typeof win.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return false;
  win.dispatchEvent(new CustomEvent('workdata:failure', { detail: { error } }));
  return true;
}

export function createMaintenanceGate({ api, apiErrorInfo, t, doc = globalThis.document, win = globalThis.window, pollMs = 3000, now = () => Date.now() } = {}) {
  let gate = null, timer = null, checking = null, lastEventAt = 0;
  const input = target => doc && doc.getElementById(target.input);
  function notice(target) {
    let node = doc.getElementById(target.notice);
    if (node) return node;
    const box = input(target);
    const composer = box && typeof box.closest === 'function' ? box.closest(target.host) : null;
    if (!composer) return null;
    node = doc.createElement('div');
    node.id = target.notice;
    node.className = 'maintenance-composer-notice';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    node.hidden = true;
    composer.insertBefore(node, composer.firstChild);
    return node;
  }
  function paint() {
    for (const target of TARGETS) {
      const box = input(target);
      if (box) {
        if (gate) {
          if (!box.dataset.maintenance) box.dataset.maintenancePrior = box.disabled ? '1' : '0';
          box.disabled = true; box.dataset.maintenance = gate.reason;
        } else if (box.dataset.maintenance) {
          box.disabled = box.dataset.maintenancePrior === '1';
          delete box.dataset.maintenance; delete box.dataset.maintenancePrior;
        }
      }
      const node = gate || doc.getElementById(target.notice) ? notice(target) : null;
      if (node) { node.textContent = maintenanceGateText(gate, t); node.hidden = !gate; }
    }
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    // failed / uncertain 只有重启才能解除：退避到 20 s，避免对 status（每次整包读取并哈希备份包，150 W11）持续轮询。
    const delay = gate && (gate.reason === 'failed' || gate.reason === 'uncertain') ? Math.max(pollMs, 20000) : pollMs;
    timer = gate ? setTimeout(() => { timer = null; void check(true); }, delay) : null;
  }
  function apply(status) { gate = maintenanceGateState(status); paint(); schedule(); return gate; }
  async function check(fromTimer = false) {
    if (fromTimer && now() - lastEventAt < pollMs) { schedule(); return gate; }
    if (checking) return checking;
    checking = (async () => {
      try { return apply(await api('/api/work-data/status')); }
      catch { schedule(); return gate; } // 交接期间连接会断一下：保持当前判断，闸门关着就继续复查
      finally { checking = null; }
    })();
    return checking;
  }
  function noteFailure(error) {
    const info = apiErrorInfo ? apiErrorInfo(error) : { code: '', message: '' };
    // 抛错方只带 code 不带 apiCode 时服务端落成 api.internal_error，维护码在 message 里。
    // 151 阶段 1E 复审：只有「没有码 / 兜底码」时才看 message。服务端已经给了具体码（如桌面关闭的 desktop_lifetime.closing，
    // 其 message 仍是内部的 work_data.maintenance_busy）就按码判，不再被 message 拉去查维护状态。
    const generic = !info.code || info.code === 'api.internal_error' || info.code === 'api.request_failed';
    const hit = isMaintenanceFailureCode(info.code) || (generic && isMaintenanceFailureCode(String(info.message || '').trim()));
    if (hit) void check();
    return hit;
  }
  if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('workdata:status', event => { lastEventAt = now(); apply(event && event.detail); });
    win.addEventListener('workdata:failure', event => { noteFailure(event && event.detail ? event.detail.error : null); });
    win.addEventListener('i18n:change', paint);
  }
  return Object.freeze({ apply, check, noteFailure, state: () => gate });
}
