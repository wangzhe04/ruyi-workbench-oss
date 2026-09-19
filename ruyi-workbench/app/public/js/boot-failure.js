// boot-failure.js — 启动故障卡（v1.5 §1.3 起住在 app.js；128f-① 用户首启走查改造后搬出来，
// 组合根行数护栏见 frontend-domains D45）。
//
// 显式故障卡：大标题 + 可能原因 +「重试」（重跑 bootData，不重复 bindEvents）+「查看诊断」（展开可整段复制的原文）。
// 主卡不暴露英文栈 —— 原文收进折叠的诊断面板。DOM 全 createElement／textContent（err 内容不可信，永不 innerHTML
// 拼它）。可键盘操作：重试是真 <button> 且自动聚焦，诊断按钮带 aria-expanded／aria-controls。
//
// 用户首启走查（2026-09-19）：「首次启动显示连接错误、连接不上，但实际是连上了，新开个线程就好」；追问后第二句
// 「查看日志诊断似乎显示不出具体原因」。修前这张卡有这几处不对：
//   ① 画在 #messages 里 —— 那是工作台视角的对话区，出厂默认的管家视角里整个不显示，用户只看得到一个 2 秒的 toast
//      「无法连接本地服务，请点『重试连接』」，却找不到任何「重试」；现在挂在外框之上的浮层里（#bootFailureHost）；
//   ② 对 boot 里【任何】一步抛错都说「无法连接本地服务」、列端口／服务没起／安全软件三条原因 —— 可大半步骤是在服务
//      【已经应答】之后才跑的，那种错说连不上是假话。判据：fetch 在传输层失败（TypeError 一族）才是连不上；拿到了
//      HTTP 响应（api() 抛的是响应正文）或前端自己的异常，说「本地服务是通的，但启动时有一步没走通」，不列那三条；
//   ③ 一抛就整段中止 —— boot 的最后一步是起推送连接，前面随便哪步抛了推送就再也不起（改在 app.js 的 boot()）；
//   ④ 诊断框只有 apiErrText(err) 一行：服务端 500 被按码译成「服务发生内部错误。」、它写在 message 里的真原因被扔掉；
//      前端异常只剩一句 message，不知道是哪一步、没有栈；下面那行提示是半句「常见原因：」，后面什么也没有。
//      现在给一份能整段发给开发者的原文：哪一步（bootStep 贴的）、哪一类、状态码与路径（net.js api() 贴的）、服务端
//      原话、错误码、栈、时刻、页面；多一枚「复制诊断」；
//   ⑤ 点「重试」后状态行原样写着「已尝试 {n} 次」（单花括号不插值、也没传参）。
// boot-failure-kind.browser 在管家视角里用 CDP Fetch 造几种失败逐条钉住。
import { el, setStatus, toast } from './util.js';
import { apiErrorInfo } from './net.js';
import { t } from './i18n.js';

export function createBootFailure({
  apiErrText,                 // 组合根那一份（按码本地化、兜底码保留原话）
  bootData,                   // 重试时重跑的那一段
  afterRecover = async () => {},  // 重试拉起来之后要补的事（组合根：按用户设的语言重应用一次）
  documentRef = globalThis.document,
} = {}) {
  const doc = documentRef;

  function bootFailureKind(err) {
    const msg = String((err && err.message) || err || '');
    if (typeof TypeError === 'function' && err instanceof TypeError && /fetch|network|load failed/i.test(msg)) return 'unreachable';
    if (/Failed to fetch|NetworkError|ERR_CONNECTION|ECONNREFUSED/i.test(msg)) return 'unreachable';
    return 'step';
  }
  function clearBootFailure() {
    const host = doc.getElementById('bootFailureHost');
    if (host) { host.hidden = true; host.innerHTML = ''; }
  }
  // 诊断要说清【哪一步】：bootData 每一步抛错时给错误贴上步骤名（只贴一次 —— 最里层那一步说了算）。
  function tagBootStep(err, step) {
    const e = err instanceof Error ? err : new Error(String(err));
    if (!e.bootStep) { try { e.bootStep = step; } catch { /* 冻结的错误对象:不贴 */ } }
    return e;
  }
  async function bootStep(step, fn) {
    try { return await fn(); } catch (err) { throw tagBootStep(err, step); }
  }
  function bootStepSync(step, fn) {
    try { return fn(); } catch (err) { throw tagBootStep(err, step); }
  }
  function bootDiagText(err) {
    const e = err && typeof err === 'object' ? err : {};
    const info = apiErrorInfo(err);
    const clip = (s, n) => { const v = String(s || ''); return v.length > n ? v.slice(0, n) + '…' : v; };
    const kindLine = bootFailureKind(err) === 'unreachable' ? t('bootFailure.diag.kindUnreachable')
      : e.status ? t('bootFailure.diag.kindHttp', { status: e.status, path: e.path || '' })
        : t('bootFailure.diag.kindClient', { name: e.name || typeof err });
    const lines = [`${t('bootFailure.diag.step')}: ${e.bootStep || '—'}`, `${t('bootFailure.diag.kind')}: ${kindLine}`];
    const human = apiErrText(err);
    if (human) lines.push(`${t('bootFailure.diag.summary')}: ${clip(human, 600)}`);
    if (info.message && info.message !== human) lines.push(`${t('bootFailure.diag.raw')}: ${clip(info.message, 2000)}`);
    if (info.code) lines.push(`${t('bootFailure.diag.code')}: ${info.code}`);
    // 栈只给前端异常（拿到了 HTTP 响应的，栈只会指向 api() 自己，没信息量）；首行就是「名字: 消息」，去掉。
    const stack = !e.status && typeof e.stack === 'string'
      ? e.stack.split('\n').map(s => s.trim()).filter(s => s && s !== `${e.name || ''}: ${e.message || ''}`).slice(0, 8) : [];
    if (stack.length) { lines.push(`${t('bootFailure.diag.stack')}:`); stack.forEach(s => lines.push('  ' + s)); }
    let since = '';
    try { since = (performance.now() / 1000).toFixed(1); } catch { /* ignore */ }
    lines.push(`${t('bootFailure.diag.when')}: ${new Date().toISOString()}${since ? ' · ' + t('bootFailure.diag.sinceLoad', { s: since }) : ''}`);
    try { lines.push(`${t('bootFailure.diag.page')}: ${location.origin} · ${doc.documentElement.lang || '-'} · ${navigator.userAgent}`); } catch { /* ignore */ }
    return lines.join('\n');
  }

  let retryCount = 0;
  function buildBootFailureCard(err) {
    const unreachable = bootFailureKind(err) === 'unreachable';
    const wrap = el('div', 'boot-failure');
    wrap.dataset.kind = unreachable ? 'unreachable' : 'step';
    wrap.setAttribute('role', 'alert');
    wrap.appendChild(el('div', 'boot-failure-icon', '⚠'));
    // 每一支都写成字面的 t('键') —— 键的使用扫描与 uimode-style (S2) 都按字面认。
    wrap.appendChild(el('h2', 'boot-failure-title', unreachable ? t('bootFailure.title') : t('bootFailure.stepTitle')));
    wrap.appendChild(el('p', 'boot-failure-lead', unreachable ? t('bootFailure.lead') : t('bootFailure.stepLead')));
    if (unreachable) {
      const ul = el('ul', 'boot-failure-reasons');
      [
        [t('connection.reason.portOccupied'), t('connection.reason.portOccupiedDesc')],
        [t('connection.reason.serverNotStarted'), t('connection.reason.serverNotStartedDesc')],
        [t('connection.reason.securityBlock'), t('connection.reason.securityBlockDesc')],
      ].forEach(([title, desc]) => {
        const li = el('li', 'boot-failure-reason');
        li.appendChild(el('span', 'boot-failure-reason-t', title));
        li.appendChild(el('span', 'boot-failure-reason-d', desc));
        ul.appendChild(li);
      });
      wrap.appendChild(ul);
    }
    const actions = el('div', 'boot-failure-actions');
    const retry = el('button', 'primary boot-retry', unreachable ? t('bootFailure.retry') : t('bootFailure.stepRetry'));
    retry.type = 'button';
    retry.setAttribute('aria-label', unreachable ? t('bootFailure.retryAria') : t('bootFailure.stepRetryAria'));
    retry.onclick = async () => {
      retry.disabled = true; retry.textContent = t('bootFailure.reconnecting');
      retryCount += 1;
      setStatus(t('bootFailure.reconnectingStatus', { n: retryCount }));
      try {
        await bootData();   // 成功后 bootData 重绘界面、这张浮层卡收起
        clearBootFailure();
        try { await afterRecover(); } catch { /* 补的事没成不影响已拉起的界面 */ }
      } catch (e) { renderBootFailure(e); }
    };
    actions.appendChild(retry);
    // 服务是通的那一种：界面其实能用，给一个「先继续用」把卡收起。
    if (!unreachable) {
      const dismiss = el('button', 'ghost boot-dismiss', t('bootFailure.stepDismiss'));
      dismiss.type = 'button';
      dismiss.onclick = () => { clearBootFailure(); };
      actions.appendChild(dismiss);
    }
    // 诊断面板：默认折叠；原文（可能含英文栈）只在这里出现。
    const panel = el('div', 'boot-failure-diag');
    panel.id = 'bootDiagPanel'; panel.hidden = true;
    const diagText = bootDiagText(err);
    const pre = el('pre', 'boot-failure-diag-pre', diagText);
    panel.appendChild(pre);
    panel.appendChild(el('p', 'boot-failure-hint', t('bootFailure.diagHint')));
    const copy = el('button', 'ghost boot-diag-copy', t('bootFailure.diagCopy'));
    copy.type = 'button';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(diagText); copy.textContent = t('common.copied'); }
      catch {
        // 剪贴板不给用（非安全上下文／权限）：把原文整段选中，用户按 Ctrl+C 即可
        try { const r = doc.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch { /* ignore */ }
        copy.textContent = t('bootFailure.diagCopyFailed');
      }
      setTimeout(() => { copy.textContent = t('bootFailure.diagCopy'); }, 2000);
    };
    panel.appendChild(copy);
    const diag = el('button', 'ghost boot-diag', t('bootFailure.diagButton'));
    diag.type = 'button';
    diag.setAttribute('aria-controls', 'bootDiagPanel');
    diag.setAttribute('aria-expanded', 'false');
    diag.onclick = () => { panel.hidden = !panel.hidden; diag.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true'); };
    actions.appendChild(diag);
    wrap.appendChild(actions);
    wrap.appendChild(panel);
    return wrap;
  }
  function renderBootFailure(err) {
    const unreachable = bootFailureKind(err) === 'unreachable';
    try { console.error('[ruyi boot]', (err && err.bootStep) || '', err); } catch { /* ignore */ } // 开发者工具里也留一份带栈的
    try { setStatus(unreachable ? t('connection.cannotConnect') : t('bootFailure.stepStatus')); } catch { /* ignore */ }
    try { toast(unreachable ? t('toast.connectFail') : t('bootFailure.stepToast'), 'err'); } catch { /* ignore */ }
    // 挂在外框之上（body 的直接孩子、定位 fixed）—— 两个视角都看得见；修前画在 #messages 里，管家视角看不见。
    let box = doc.getElementById('bootFailureHost');
    if (!box) {
      box = el('div', 'boot-failure-host');
      box.id = 'bootFailureHost';
      doc.body.appendChild(box);
    }
    box.hidden = false;
    box.innerHTML = '';
    box.appendChild(buildBootFailureCard(err));
    const retry = box.querySelector('.boot-retry');
    if (retry) setTimeout(() => { try { retry.focus(); } catch { /* ignore */ } }, 0);
  }

  return { bootFailureKind, clearBootFailure, tagBootStep, bootStep, bootStepSync, renderBootFailure };
}
