'use strict';

export function createChatRenderPrimitives(deps = {}) {
  const {
    $,
    api,
    apiErrText,
    autoGrow,
    buildModal,
    currentEngineMeta,
    currentModelId,
    el,
    engineVisual,
    escapeHtml,
    fmtTime,
    fmtTokens,
    hljs,
    humanizeToolName,
    icon,
    isProviderMode,
    marked,
    refreshPlaybooks,
    refreshSessions,
    renderCurrentSession,
    renderResumeBanner,
    saveAsMemory,
    sendPrompt,
    state,
    t,
    tCount,
    toast,
  } = deps;

  function iconTextBtn(btn, name, label, size = 16) {
    if (!btn) return;
    btn.textContent = '';
    const ic = icon(name, size);
    if (ic) btn.appendChild(ic);
    if (label) btn.appendChild(document.createTextNode(label));
  }

  /* ---------------- markdown rendering (XSS-safe) ---------------- */
  const ALLOWED_TAGS = new Set(['A','P','BR','HR','STRONG','B','EM','I','DEL','S','CODE','PRE','BLOCKQUOTE','UL','OL','LI','H1','H2','H3','H4','H5','H6','TABLE','THEAD','TBODY','TR','TH','TD','IMG','SPAN','DIV']);
  function sanitizeNode(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    const toRemove = [];
    let node = walker.nextNode();
    while (node) {
      if (!ALLOWED_TAGS.has(node.tagName)) {
        toRemove.push(node);
      } else {
        for (const attr of [...node.attributes]) {
          const name = attr.name.toLowerCase();
          const val = attr.value;
          if (name.startsWith('on')) { node.removeAttribute(attr.name); continue; }
          if (name === 'href' || name === 'src') {
            // Strip control/whitespace chars (browsers ignore them in schemes, e.g. "java\tscript:")
            // then allowlist protocols: http/https/mailto + relative/fragment. Everything else out.
            const v = val.replace(/[\u0000-\u0020]+/g, '');
            let ok = false;
            try {
              const u = new URL(v, location.href);
              ok = ['http:', 'https:', 'mailto:'].includes(u.protocol);
            } catch { ok = false; }
            // allow pure relative/fragment refs (no scheme)
            if (!ok && /^[#/.?]/.test(v) && !/^[a-z][a-z0-9+.-]*:/i.test(v)) ok = true;
            if (!ok) { node.removeAttribute(attr.name); continue; }
          } else if (name !== 'class' && name !== 'alt' && name !== 'title') {
            node.removeAttribute(attr.name);
          }
        }
      }
      node = walker.nextNode();
    }
    for (const n of toRemove) { while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n); n.remove(); }
  }
  function renderMarkdown(text) {
    try {
      if (typeof marked === 'undefined') return `<div class="plain">${escapeHtml(text)}</div>`;
      const html = marked.parse(String(text || ''), { gfm: true, breaks: true });
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      sanitizeNode(tpl.content);
      return tpl.innerHTML;
    } catch { return `<div class="plain">${escapeHtml(text)}</div>`; }
  }
  function highlightIn(container) {
    if (typeof hljs === 'undefined') return;
    container.querySelectorAll('pre code').forEach(block => {
      if (block.dataset.hl) return;
      try { hljs.highlightElement(block); } catch { /* ignore */ }
      block.dataset.hl = '1';
      const pre = block.parentElement;
      if (pre && !pre.querySelector('.copy-code')) {
        const btn = el('button', 'copy-code', t('common.copy'));
        btn.onclick = () => { navigator.clipboard?.writeText(block.textContent).then(() => toast(t("toast.copyCode"), 'ok')); };
        pre.appendChild(btn);
      }
    });
  }

  /* ---------------- theme ---------------- */
  // 第50波(UI-DESIGN-V4 §5):主题三态 —— light/dark/system(跟随系统)。wcw.theme 存偏好值;
  // data-theme 落有效值(system 经 matchMedia 解析并监听变更)。切换循环 dark→light→system→dark。
  // themeToggle 由 emoji(🌙/☀️)换 SVG(icons.js theme/monitor,emoji 清零目标的高频控件首例)。
  function messageShell(role, whenIso, meta) {
    const row = document.createElement(role === 'assistant' ? 'article' : 'div');
    row.className = `message ${role}`;
    if (role === 'assistant') row.setAttribute('aria-label', t('chat.assistantTurnAria'));
    // v3 (§C4): 头像从字母方块升级为品牌 SVG —— 用户=中性人形剪影 / 助手=如意云头(引擎色底白标) / 系统=无底色 ⚙。
    const avatar = el('div', 'avatar');
    buildMsgAvatar(avatar, role);
    const main = el('div', 'msg-main');
    const head = el('div', 'msg-head');
    if (role === 'assistant') {
      const vis = engineVisual(meta);
      // 云头底色沿用引擎色(Claude=青花蓝 via --accent,Provider 各品牌色),多引擎会话一眼识别归属。
      avatar.style.background = vis.colorVar;
      // Badge = colored dot + engine name; the dot/tint color comes from --eng-color set inline here.
      const badge = el('span', 'eng-badge', vis.label);
      badge.style.setProperty('--eng-color', vis.colorVar);
      head.appendChild(badge);
      const model = meta && meta.model;
      if (model) head.append(el('span', 'eng-model', model));
    } else {
      head.append(el('span', 'who', role === 'user' ? t('chat.roleUser') : t('chat.roleSystem')));
    }
    if (whenIso) head.append(el('span', 'when', fmtTime(whenIso)));
    main.appendChild(head);
    row.append(avatar, main);
    return { row, main, head };
  }
  // v3 (§C4): 消息头像 SVG 构建器。全 createElementNS(不用 innerHTML,守 XSS 纪律)。图形为常量,无用户数据注入。
  function buildMsgAvatar(box, role) {
    const NS = 'http://www.w3.org/2000/svg';
    if (role === 'assistant') {
      // 如意云头(与 --ruyi-cloud 同一三瓣路径),fill=currentColor(=--accent-ink 白);底色由调用处按引擎色设。
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 120 70'); svg.setAttribute('width', '22'); svg.setAttribute('height', '13');
      svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('fill', 'currentColor');
      const cloud = document.createElementNS(NS, 'path');
      cloud.setAttribute('d', 'M60 62 C46 55 30 44 30 32 A13 13 0 0 1 53 24 A7.5 7.5 0 1 1 67 24 A13 13 0 0 1 90 32 C90 44 74 55 60 62 Z');
      svg.appendChild(cloud); box.appendChild(svg);
    } else if (role === 'user') {
      // 中性人形剪影(头 + 肩),fill=currentColor(=--ink)。
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
      svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('fill', 'currentColor');
      const head = document.createElementNS(NS, 'circle');
      head.setAttribute('cx', '12'); head.setAttribute('cy', '8.5'); head.setAttribute('r', '3.9');
      const body = document.createElementNS(NS, 'path');
      body.setAttribute('d', 'M12 13.4c-4.3 0-7.6 2.7-7.6 6.3V21h15.2v-1.3c0-3.6-3.3-6.3-7.6-6.3Z');
      svg.append(head, body); box.appendChild(svg);
    } else {
      // 系统:无底色 ⚙ 弱化(CSS 把 .message.system .avatar 去底、着 --muted)。
      box.textContent = '⚙';
    }
  }
  // Derive an engine meta from a stored message. New messages carry engine/providerId/providerLabel/model
  // directly; older ones only have `source` ('provider:xxx' | 'claude-cli' | 'aborted'|…) — fall back to
  // that, resolving the provider label from the current config when possible.
  function metaFromMessage(msg) {
    if (!msg) return null;
    if (msg.engine === 'openai' || msg.providerId) {
      const pid = msg.providerId || '';
      const p = (state.config.providers || []).find(x => x.id === pid);
      return { engine: 'openai', providerId: pid, providerLabel: msg.providerLabel || (p && p.label) || pid, model: msg.model || '' };
    }
    if (msg.engine === 'claude') return { engine: 'claude', model: msg.model || '' };
    const src = String(msg.source || '');
    if (src.startsWith('provider:')) {
      const pid = src.slice('provider:'.length);
      const p = (state.config.providers || []).find(x => x.id === pid);
      return { engine: 'openai', providerId: pid, providerLabel: (p && p.label) || pid, model: msg.model || '' };
    }
    // 'claude-cli', 'fallback', 'aborted', 'stderr', or missing -> treat as Claude (the historical default).
    return { engine: 'claude', model: msg.model || '' };
  }
  // Count characters in a thinking transcript for the collapsed summary "思考过程 · N 字" (C2). Pure so
  // it can be unit-tested; counts JS string length (code units), which is fine for a rough CJK-ish size.
  function thinkingCharCount(text) { return String(text || '').length; }
  // The summary label for a SETTLED thinking panel: "思考过程 · N 字" (N = char count), or plain "思考过程"
  // when empty. The mid-stream "思考中…" + shimmer state is chosen by the caller (thinkingPanel/setLive),
  // not here. Pure helper for testing the collapsed-state text.
  function thinkingSummaryLabel(text) { const n = thinkingCharCount(text); return n > 0 ? `${t('chat.thinkingProcessCount', {count: n})}` : t('chat.thinkingProcess'); }
  // text (optional) seeds the body; `live` renders the streaming "思考中…" shimmer summary. Returns the
  // <details>, the body element, and setLive(on)/refreshLabel() so the streaming path can settle it.
  function thinkingPanel(text, live) {
    const d = el('details', 'thinking');
    const sum = el('summary', 'thinking-summary');
    const iconWrap = el('span', 'thinking-icon'); iconWrap.appendChild(icon('trace', 13));
    const label = el('span', 'thinking-label', live ? t('chat.thinkingLive') : thinkingSummaryLabel(text));
    const caret = el('span', 'thinking-caret');
    sum.append(iconWrap, label, caret);
    if (live) sum.classList.add('thinking-live');
    d.appendChild(sum);
    const body = el('div', 'think-body', text); d.appendChild(body);
    const setLive = on => {
      if (on) { sum.classList.add('thinking-live'); label.textContent = t('chat.thinkingLive'); }
      else { sum.classList.remove('thinking-live'); label.textContent = thinkingSummaryLabel(body.textContent); }
    };
    return { d, body, summary: sum, label, setLive, userToggled: false };
  }
  function settleLiveThinking(live) {
    if (!live) return;
    const panel = live.thinkingPanelObj;
    if (panel) {
      panel.setLive(false);
      if (!panel.userToggled) panel.d.open = false;
    }
    if (live.thinkingFollowTimer) clearTimeout(live.thinkingFollowTimer);
    live.thinkingFollowTimer = 0;
    live.followThinkingPanel = false;
    live.thinkingActive = false;
    live.thinkingEl = null;
    live.thinkingNode = null;
  }
  // Pick the first present string field from a tool's input for the header summary (C1), in priority
  // order, then middle-ellipsize to ≤44 chars keeping head+tail. Returns '' when nothing usable. Pure.
  const TC_ARG_KEYS = ['path', 'url', 'command', 'pattern', 'root', 'query', 'title', 'text'];
  function toolArgSummary(input, max = 44) {
    if (!input || typeof input !== 'object') return '';
    let raw = '';
    for (const k of TC_ARG_KEYS) { const v = input[k]; if (typeof v === 'string' && v.trim() !== '') { raw = v; break; } }
    return middleEllipsis(raw.replace(/\s+/g, ' ').trim(), max);
  }
  // Middle-ellipsize a string to at most `max` chars, keeping the head and tail (so long paths/urls stay
  // recognizable at both ends). Uses a single '…' in the middle. Pure.
  function middleEllipsis(s, max = 44) {
    s = String(s || '');
    if (s.length <= max) return s;
    if (max <= 1) return '…';
    const keep = max - 1; // room for the ellipsis
    const head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
    return s.slice(0, head) + '…' + (tail > 0 ? s.slice(s.length - tail) : '');
  }
  // Attach a floating "复制" button (reusing .copy-code) to a <pre>, wrapped so hover reveals it. Returns
  // the wrapper to append. copies the pre's textContent to the clipboard.
  function wrapPreWithCopy(pre) {
    const wrap = el('div', 'tc-pre-wrap');
    const btn = el('button', 'copy-code', t('common.copy')); btn.type = 'button';
    btn.onclick = e => { e.preventDefault(); e.stopPropagation(); navigator.clipboard?.writeText(pre.textContent || '').then(() => toast(t("toast.copied"), 'ok')); };
    wrap.append(pre, btn);
    return wrap;
  }
  // v1.0-S4: pull the unified-diff text out of a git_diff tool result (accepts an object with `.diff`, or a
  // JSON string, or an MCP content-array wrapper). Returns '' when there is no usable diff text.
  function gitDiffText(result) {
    let obj = result;
    if (Array.isArray(obj)) { obj = obj.map(p => (p && typeof p.text === 'string') ? p.text : '').join(''); }
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return obj.trim() ? obj : ''; } }
    if (obj && typeof obj === 'object' && typeof obj.diff === 'string') return obj.diff;
    return '';
  }
  // v1.0-S4: colorized unified-diff view. Builds a `.diff-view` block: one <div> per line, classed by the
  // first char (+ add / - del / @@ hunk / else default). SECURITY: every line goes in via textContent — NEVER
  // innerHTML (a diff can contain arbitrary source, including markup). Over 800 lines → collapse behind a
  // 「展开全部」 button (only the first 800 render until expanded), keeping huge diffs from freezing the DOM.
  const DIFF_COLLAPSE_LINES = 800;
  function renderDiffView(diffText) {
    const view = el('div', 'diff-view');
    const lines = String(diffText || '').split('\n');
    const total = lines.length;
    const collapsed = total > DIFF_COLLAPSE_LINES;
    const appendLines = (from, to) => {
      for (let i = from; i < to; i++) {
        const line = lines[i];
        let cls = 'diff-line';
        // File headers (+++/---) must be checked before the +/- add/del classes so they don't miscolor.
        if (line.startsWith('+++') || line.startsWith('---')) cls += ' diff-file';
        else if (line.startsWith('@@')) cls += ' diff-hunk';
        else if (line.startsWith('+')) cls += ' diff-add';
        else if (line.startsWith('-')) cls += ' diff-del';
        const row = el('div', cls);
        row.textContent = line.length ? line : ' '; // keep blank lines a visible height
        view.appendChild(row);
      }
    };
    appendLines(0, collapsed ? DIFF_COLLAPSE_LINES : total);
    if (collapsed) {
      const btn = el('button', 'diff-expand', `t('chat.expandAll', { total })`); btn.type = 'button';
      btn.onclick = e => {
        e.preventDefault(); e.stopPropagation();
        appendLines(DIFF_COLLAPSE_LINES, total);
        btn.remove();
      };
      view.appendChild(btn);
    }
    return view;
  }
  // tc: { name, input, result?, isError?, durationMs? }. Builds the upgraded card (C1): left status bar
  // (running/ok/err), arg summary, optional duration, copy buttons on both <pre>. All states stay collapsed
  // by default; failures remain visible through their red status and can be opened on demand.
  // Returns handles the streaming path uses to fill the result + timing + status bar post-render.
  function toolCard(tc) {
    const d = el('details', 'tool-card');
    const done = tc.result !== undefined;
    const statusbar = el('div', 'tc-statusbar' + (done ? (tc.isError ? ' err' : ' ok') : ' running'));
    d.appendChild(statusbar);
    const sum = el('summary');
    // v0.7d: bridged desktop-control tools carry the ai_computer_control__ prefix — badge them with 🖥.
    const isDesktopTool = typeof tc.name === 'string' && tc.name.startsWith('ai_computer_control__'); // v3 (§2.15): tc-icon emoji → 线性 SVG(monitor/wrench)
    // v0.9-S1 (C1): both a raw name (pro) and a plain-language verb (simple) ship; CSS shows one per uiMode
    // via [data-ui-mode]. The verb reuses humanizeToolName (the shared 人话 map, also used by permission popups).
    const tcIconEl = el('span', 'tc-icon'); tcIconEl.appendChild(icon(isDesktopTool ? 'monitor' : 'wrench', 13));
    sum.append(
      tcIconEl,
      el('span', 'tc-name', tc.name || 'tool'),
      el('span', 'tc-verb', humanizeToolName(tc.name)),
    );
    const arg = toolArgSummary(tc.input);
    const argEl = el('span', 'tc-arg', arg); if (arg) argEl.title = arg;
    sum.appendChild(argEl);
    // Duration slot: filled now for static cards that carry durationMs; streaming fills it on tool_result.
    const dur = el('span', 'tc-dur'); if (done && Number.isFinite(tc.durationMs)) dur.textContent = `· ${(tc.durationMs / 1000).toFixed(1)}s`;
    sum.appendChild(dur);
    const status = el('span', 'tc-status', done ? (tc.isError ? t('status.error') : t('status.done')) : t('status.running'));
    if (done) status.classList.add(tc.isError ? 'err' : 'ok');
    sum.appendChild(status);
    sum.appendChild(el('span', 'tc-caret'));
    d.appendChild(sum);
    const body = el('div', 'tc-body');
    // v1.0-S4: git_diff gets a colorized diff view at the TOP of the body (the 「改了什么」 primary view, useful
    // even in simple mode). The raw JSON still lives in the 详情 block below. diffHost is returned so the
    // streaming tool_result path can fill it once the result arrives.
    const diffHost = el('div', 'tc-diff-host');
    body.appendChild(diffHost);
    if (done && !tc.isError) renderGitDiffInto(diffHost, tc.name, tc.result);
    // v0.9-S1 (C1): the input/result JSON lives in a nested <details class="tc-detail"> (open by default). In
    // pro mode CSS hides the nested summary so it reads as a plain always-open body (unchanged look); in simple
    // mode the 「详情」summary shows so a 人人可用 user can collapse the raw JSON. It starts open either way,
    // so content is never hidden by default — simple users opt INTO folding.
    const detail = el('details', 'tc-detail'); detail.open = true;
    const detailSum = el('summary', 'tc-detail-sum'); detailSum.textContent = t('chat.details'); detail.appendChild(detailSum);
    detail.appendChild(el('div', 'tc-label', t('chat.input')));
    const inp = el('pre'); inp.textContent = safeStringify(tc.input); detail.appendChild(wrapPreWithCopy(inp));
    const resLabel = el('div', 'tc-label', t('chat.result')); detail.appendChild(resLabel);
    const resPre = el('pre'); resPre.textContent = done ? safeStringify(tc.result) : t('chat.waitingResult'); detail.appendChild(wrapPreWithCopy(resPre));
    body.appendChild(detail);
    d.appendChild(body);
    return { d, status, resPre, statusbar, dur, argEl, diffHost, name: tc.name };
  }
  // v1.0-S4: fill a tool card's diff-host with the colorized diff view IFF this is a git_diff result carrying
  // non-empty diff text. Idempotent (clears the host first) so the streaming path can call it after the result
  // lands. No-op for every other tool / empty diff — the host stays empty and collapses.
  function renderGitDiffInto(host, name, result) {
    if (!host) return;
    host.textContent = '';
    if (name !== 'git_diff') return;
    const text = gitDiffText(result);
    if (!text || !text.trim()) return;
    host.appendChild(el('div', 'tc-label', t('chat.changes')));
    host.appendChild(renderDiffView(text));
  }
  function safeStringify(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }
  /* ---------------- v1.0.2 (G4): 同回合多工具卡折叠成组 ---------------- */
  function toolGroupSummaryText(n) { return tCount('tool.group.completed', n); }
  // Static re-render (history): given an array of top-level tool-card elements, if there are >3, wrap them
  // ALL into a collapsed <details.tool-group> (summary = 「N 个工具调用」). Returns the group element, or null
  // when ≤3 (caller appends the cards individually). Sub-agent cards are handled by their own path and are
  // NOT passed here.
  function buildStaticToolGroup(cardEls) {
    if (!Array.isArray(cardEls) || cardEls.length <= 3) return null;
    const det = el('details', 'tool-group');
    const sum = el('summary', 'tool-group-sum');
    sum.append(el('span', 'tg-caret', '▸'), el('span', 'tg-label', tCount('tool.group.count', cardEls.length)));
    det.appendChild(sum);
    const body = el('div', 'tool-group-body');
    for (const c of cardEls) body.appendChild(c);
    det.appendChild(body);
    return det;
  }
  // meta (optional): engine identity so the line ends with a muted engine name (C3). Tokens go through
  // fmtTokens (↑in ↓out); duration/cost only appear when present (provider turns usually lack cost).
  function usageLine(u, meta) {
    const line = el('div', 'usage-line');
    const parts = [];
    const inp = u.usage?.input_tokens, out = u.usage?.output_tokens;
    // E4: providers that never send a usage frame get a server-side estimate flagged estimated:true — prefix
    // it with 约 (approx.) so the number does not read as an exact provider-reported count.
    if (inp != null || out != null) parts.push(`<b>${u.estimated ? t('common.about') : ''}↑${fmtTokens(inp ?? 0)} ↓${fmtTokens(out ?? 0)}</b>`);
    if (u.durationMs != null) parts.push(`<b>${(u.durationMs / 1000).toFixed(1)}s</b>`);
    if (u.costUsd != null) parts.push(`<b>$${Number(u.costUsd).toFixed(4)}</b>`);
    if (u.numTurns != null) parts.push(`${u.numTurns} 轮`);
    let html = parts.join(' · ');
    // Trailing muted engine name from the message meta, or the current engine when rendered live.
    const engName = engineVisual(meta || currentEngineMeta()).label;
    if (engName) html += `${html ? ' · ' : ''}<span class="usage-eng">${escapeHtml(engName)}</span>`;
    line.innerHTML = html;
    return line;
  }
  /* ---------------- context-window meter (client-only; fed by per-turn usage) ---------------- */
  // v1.3-FE1:fmtTokens 已搬入 ./js/util.js(纯格式化,顶部 import 取回);此处 ctx-meter 族仍用同名调用。
  // Best-effort context limit by model name — LAST-RESORT fallback only (server's contextWindowResolved is
  // preferred, see ctxWindow). v1.0.2 返修三:此前 deepseek 一律 65536 —— 电量表分母恒为 64K,deepseek-v4(1M)
  // 被当 64K,「12K/64K·18%」而非真实「12K/1M·1%」,正是用户看到的 65.5k。表已与服务端 MODEL_CONTEXT_TABLE 对齐。
  function ctxWindowGuess(model) {
    const m = String(model || '').toLowerCase();
    if (/haiku/.test(m)) return 200000;
    if (/opus-4|sonnet-5|sonnet-4|fable|mythos/.test(m)) return 1000000;
    if (/deepseek-v4/.test(m)) return 1000000;   // deepseek-v4 = 1M(此前被并入 65536)
    if (/deepseek/.test(m)) return 131072;        // 其余 deepseek(v3/chat/reasoner)= 128K
    if (/kimi|moonshot/.test(m)) return 262144;
    if (/glm/.test(m)) return 131072;
    if (/qwen.*(turbo|long)/.test(m)) return 1000000;
    if (/qwen|qwq/.test(m)) return 131072;
    if (/gpt-4o|gpt-4\.1/.test(m)) return 128000;
    if (/o3|o4/.test(m)) return 200000;
    return 200000;
  }
  // v1.0.2 返修三:上下文窗口的优先级 —— ①用户在电量表上手动设的上限(localStorage,最高优先);②服务端三级解析
  // contextWindowResolved(manual>接口探测>名称表,权威;但 source==='fallback' 说明服务端也没辙——多为 Claude 引擎
  // 或未知模型——此时【不】用它的 65536 兜底,落到客户端名称猜测,让 claude/opus 等仍走各自 heuristic);③客户端猜测。
  // v1.4.1: 手动锁定的上下文上限改为【按模型】存(键名带 model id),避免一个模型的锁串到另一个模型
  // (真机 foot-gun:在 qwen 上点过 128K,切到 deepseek-v4 也显示 128K)。旧的全局键 `wcw.ctxWindow` 首次读到时
  // 一次性迁移进当前模型的键并删除,兼容存量。
  function ctxWindowKey(model) { const m = String(model || currentModelId() || '').trim(); return m ? 'wcw.ctxWindow::' + m : 'wcw.ctxWindow'; }
  function ctxWindowManual(model) {
    try {
      const k = parseInt(localStorage.getItem(ctxWindowKey(model)) || '0', 10);
      if (Number.isFinite(k) && k > 0) return k;
      const g = parseInt(localStorage.getItem('wcw.ctxWindow') || '0', 10); // 存量全局锁 → 迁移
      if (Number.isFinite(g) && g > 0) {
        try { localStorage.setItem(ctxWindowKey(model), String(g)); localStorage.removeItem('wcw.ctxWindow'); } catch { /* ignore */ }
        return g;
      }
    } catch { /* ignore */ }
    return 0;
  }
  function setCtxWindowManual(n, model) {
    try { if (n > 0) localStorage.setItem(ctxWindowKey(model), String(n)); else localStorage.removeItem(ctxWindowKey(model)); localStorage.removeItem('wcw.ctxWindow'); } catch { /* ignore */ }
  }
  function ctxWindow() {
    const o = ctxWindowManual();
    if (o > 0) return o;
    const r = state.status && state.status.contextWindowResolved;
    if (r && r.source && r.source !== 'fallback' && Number.isFinite(r.value) && r.value > 0) return r.value;
    return ctxWindowGuess(currentModelId());
  }
  // 当前上限读数的来源人话标签(供电量表 tooltip + 弹层)。「按名称推测」= 端点未报告真实上限、只能按模型名猜,可能不准。
  function ctxWindowSourceLabel() {
    if (ctxWindowManual() > 0) return t('ctx.sourceLabel.manual');
    const r = state.status && state.status.contextWindowResolved;
    if (r && r.source === 'probe' && r.value > 0) return t('ctx.sourceLabel.probe');
    if (r && r.source === 'manual' && r.value > 0) return t('ctx.sourceLabel.settingsFixed');
    return t('ctx.sourceLabel.guessed');
  }
  // Context "in play" after a turn. Prefer the server's accurate per-call figure (contextTokens);
  // fall back to summing raw usage fields only for older payloads that lack it.
  function ctxTokensOf(u) {
    if (u && Number.isFinite(u.contextTokens) && u.contextTokens > 0) return u.contextTokens;
    const g = u && u.usage;
    if (!g) return null;
    const n = (g.input_tokens || 0) + (g.cache_read_input_tokens || 0) + (g.cache_creation_input_tokens || 0) + (g.output_tokens || 0);
    return n > 0 ? n : null;
  }
  function latestUsage(session) {
    const msgs = session && session.messages;
    if (!Array.isArray(msgs)) return null;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].usage) return msgs[i].usage;
    return null;
  }
  function renderContextMeter(u) {
    const box = $('contextMeter');
    if (!box) return;
    const n = ctxTokensOf(u);
    if (n == null) { state.shownUsage = null; box.classList.add('hidden'); return; }
    state.shownUsage = u;
    const win = ctxWindow(), pct = win > 0 ? n / win : 0;
    // Keep this visible in both UI modes once usage exists. The manual compact action lives in this
    // meter's popover, so hiding low usage also made context occupancy and compaction disappear.
    // Battery drains as context fills: fill width = remaining capacity (1 - pct) of the 17.8px interior.
    const fill = box.querySelector('.batt-fill');
    if (fill) fill.setAttribute('width', (Math.max(0, Math.min(1, 1 - pct)) * 17.8).toFixed(2));
    // v1.0.2 返修三跟进:上限若被【手动锁定】(localStorage 覆盖),在读数后标一个 🔒 —— 否则用户看不出上限是
    // 手动固定的,一次误点 128K 预设就永久盖过自动探测(deepseek-v4-pro 真机撞出:显示 131k 而非 1M,查明是
    // 早先手动设过 128K)。有锁时提示可点「自动」解锁。
    const manual = ctxWindowManual();
    const locked = manual > 0;
    box.querySelector('.ctx-text').textContent = `${fmtTokens(n)} / ${fmtTokens(win)}${locked ? ' 🔒' : ''} · ${Math.round(pct * 100)}%`;
    box.classList.remove('warn', 'crit');
    if (pct >= 0.9) box.classList.add('crit'); else if (pct >= 0.7) box.classList.add('warn');
    const g = u.usage || {};
    const srcLabel = ctxWindowSourceLabel();
    const srcHint = locked
      ? t('ctx.tooltip.locked', { win: win.toLocaleString() })
      : t('ctx.tooltip.srcAuto', { src: srcLabel }) + (srcLabel === t('ctx.sourceLabel.guessed') ? ' ' + t('ctx.tooltip.srcGuessed') : '');
    box.title = t('ctx.tooltip.summary', { n: n.toLocaleString(), win: win.toLocaleString() }) + '\n' +
      t('ctx.tooltip.usageLine', { input: g.input_tokens || 0, cacheRead: g.cache_read_input_tokens || 0, cacheWrite: g.cache_creation_input_tokens || 0, output: g.output_tokens || 0 }) + '\n' + srcHint;
    box.classList.remove('hidden');
  }
  function updateContextMeter() { renderContextMeter(state.shownUsage || latestUsage(state.currentSession)); }

  function msgActions(msg) {
    const bar = el('div', 'msg-actions');
    const copy = el('button', '', t('common.copy'));
    copy.onclick = () => { navigator.clipboard?.writeText(msg.content || '').then(() => toast(t("toast.copied"), 'ok')); };
    bar.appendChild(copy);
    if (msg.role === 'user') {
      const edit = el('button', '', t('chat.editResend'));
      edit.onclick = () => { $('promptInput').value = msg.content || ''; autoGrow($('promptInput')); $('promptInput').focus(); };
      const retry = el('button', '', t('chat.retry'));
      retry.onclick = () => sendPrompt(msg.content || '');
      bar.append(edit, retry);
      // v0.8-S4b B2: 「⏪ 回溯到此处」— rewind the conversation to just before this message.
      const rewind = el('button', '', t('chat.rewindHere'));
      rewind.onclick = () => openRewindModal(msg);
      bar.append(rewind);
    } else if (msg.role === 'assistant') {
      // v0.9-S2 (C2): 「存为 playbook」— turn this completed task into a reusable template. Provider engine
      // only (the draft uses the active provider). Hidden when no session or a turn is streaming.
      if (isProviderMode()) {
        const save = el('button', '', t('playbook.create.action'));
        save.onclick = () => saveAsPlaybook(save);
        bar.append(save);
        // v2 跨会话记忆: 「存为记忆」(draft→编辑弹窗→保存)。draft 用 provider,故与「存为 playbook」同处 provider 分支。
        const mem = el('button', '', t('chat.saveMemory'));
        mem.onclick = () => saveAsMemory(mem);
        bar.append(mem);
      }
    }
    return bar;
  }

  /* ---------------- v0.9-S2: 存为 playbook ---------------- */
  // Ask the server to draft a playbook from the current session (most-recent user msg + turn_summary), then
  // open an edit modal (title/desc/promptTemplate editable) → confirm → POST /api/playbooks.
  async function saveAsPlaybook(btn) {
    const sid = state.currentSession && state.currentSession.id;
    if (!sid) { toast(t('playbook.create.noSession'), 'err'); return; }
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = t('playbook.create.drafting'); }
    try {
      const r = await api('/api/playbooks/draft', { method: 'POST', body: JSON.stringify({ sessionId: sid }) });
      if (!r || !r.ok || !r.draft) { toast(t('playbook.create.draftFailed', { reason: (r && r.error) || t('common.unknown') }), 'err'); return; }
      openPlaybookEditModal(r.draft);
    } catch (e) { toast(t('playbook.create.draftFailed', { reason: apiErrText(e) }), 'err'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
  }
  // Edit modal for a drafted playbook: title / desc / promptTemplate are editable; on confirm, POST the
  // normalized object to /api/playbooks (server re-normalizes). XSS-safe — values via el/value, never innerHTML.
  function openPlaybookEditModal(draft) {
    const body = el('div', 'pb-form');
    const mkField = (label, value, rows) => {
      const field = el('div', 'pb-field');
      field.appendChild(el('label', 'pb-field-label', label));
      const ta = el(rows > 1 ? 'textarea' : 'input', 'pb-field-input');
      if (rows > 1) ta.rows = rows; else ta.type = 'text';
      ta.value = value || '';
      field.appendChild(ta);
      body.appendChild(field);
      return ta;
    };
    const titleEl = mkField(t('playbook.create.fieldTitle'), draft.title, 1);
    const descEl = mkField(t('playbook.create.fieldDescription'), draft.desc, 2);
    const tmplEl = mkField(t('playbook.create.fieldTemplate'), draft.promptTemplate, 8);
    // Show the detected input parameters read-only (they come from the draft; folder/file types preserved).
    if ((draft.inputs || []).length) {
      const info = el('div', 'pb-field-hint', t('playbook.create.inputs', { inputs: draft.inputs.map(i => `{${i.key}}` + (i.type !== 'text' ? `(${i.type})` : '')).join('  ') }));
      body.appendChild(info);
    }
    const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
    const cancel = el('button', '', t('common.cancel'));
    const save = el('button', 'primary', t('common.save'));
    foot.append(cancel, save);
    const modal = buildModal(t('playbook.create.modalTitle'), body, foot);
    cancel.onclick = () => modal.close();
    save.onclick = async () => {
      const pb = { ...draft, title: titleEl.value.trim(), desc: descEl.value.trim(), promptTemplate: tmplEl.value };
      if (!pb.title || !pb.promptTemplate.trim()) { toast(t('playbook.create.required'), 'err'); return; }
      save.disabled = true; save.textContent = t('playbook.create.saving');
      try {
        const r = await api('/api/playbooks', { method: 'POST', body: JSON.stringify({ playbook: pb }) });
        modal.close();
        if (!r || !r.ok) { toast(t('playbook.create.saveFailed', { reason: (r && r.error) || t('common.unknown') }), 'err'); return; }
        toast(t('playbook.create.saved'), 'ok');
        refreshPlaybooks(); // reflect the new card in the empty state
      } catch (e) { modal.close(); toast(t('playbook.create.saveFailed', { reason: apiErrText(e) }), 'err'); }
    };
  }

  /* ---------------- v0.8-S4b: conversation rewind ---------------- */
  // Resolve the turnSeq to rewind to for a user message. Primary: the message's own turnSeq (S4b stamps it).
  // Fallback for legacy messages: the turnSummary.turnSeq of the FOLLOWING assistant; else the 1-based
  // ordinal among user messages (matches the server's fallback ladder).
  function turnSeqForUserMessage(msg) {
    const session = state.currentSession;
    const msgs = (session && session.messages) || [];
    if (Number.isFinite(Number(msg.turnSeq))) return Number(msg.turnSeq);
    const idx = msgs.indexOf(msg);
    if (idx >= 0) {
      for (let j = idx + 1; j < msgs.length; j++) {
        const m = msgs[j];
        if (m && m.role === 'assistant' && m.turnSummary && Number.isFinite(Number(m.turnSummary.turnSeq))) return Number(m.turnSummary.turnSeq);
      }
    }
    // ordinal
    let n = 0; for (const m of msgs) { if (m && m.role === 'user') { n++; if (m === msg) return n; } }
    return null;
  }
  // Count the turns (user messages) and revertible files at/after the cut point, for the confirm modal.
  function rewindImpact(msg) {
    const session = state.currentSession;
    const msgs = (session && session.messages) || [];
    const idx = msgs.indexOf(msg);
    let turns = 0; const filePaths = new Set();
    if (idx >= 0) {
      for (let i = idx; i < msgs.length; i++) {
        const m = msgs[i];
        if (!m) continue;
        if (m.role === 'user') turns++;
        if (m.role === 'assistant' && m.turnSummary && Array.isArray(m.turnSummary.filesChanged)) {
          for (const f of m.turnSummary.filesChanged) { if (f && f.revertible && f.path) filePaths.add(f.path); }
        }
      }
    }
    return { turns, fileCount: filePaths.size };
  }
  function openRewindModal(msg) {
    if (state.streaming) { toast(t("toast.rewindStopTurn"), ''); return; }
    const sid = state.currentSession?.id;
    const targetTurnSeq = turnSeqForUserMessage(msg);
    if (!sid || targetTurnSeq == null) { toast(t("toast.rewindNoTurn"), 'err'); return; }
    const { turns, fileCount } = rewindImpact(msg);
    const body = el('div');
    body.append(el('p', '', `回到这条消息之前?将删除之后的 ${turns} 轮对话。`));
    const preview = el('div', 'rewind-preview'); preview.textContent = (msg.content || '').slice(0, 300);
    body.append(preview);
    let fileBox = null;
    if (fileCount > 0) {
      const wrap = el('label', 'check');
      fileBox = document.createElement('input'); fileBox.type = 'checkbox'; fileBox.checked = true; // default-on when M>0
      wrap.append(fileBox, document.createTextNode(` 同时撤销这些轮次的文件改动(${fileCount} 个文件)`));
      body.append(wrap);
    }
    const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px';
    const cancel = el('button', '', t('common.cancel'));
    const go = el('button', 'danger', t('chat.rewind'));
    foot.append(cancel, go);
    const modal = buildModal(t('chat.rewindTitle'), body, foot);
    cancel.onclick = () => modal.close();
    go.onclick = async () => {
      go.disabled = true; go.textContent = t('chat.rewinding');
      try {
        const r = await api('/api/session/rewind', { method: 'POST', body: JSON.stringify({ sessionId: sid, targetTurnSeq, rollbackFiles: !!(fileBox && fileBox.checked) }) });
        modal.close();
        if (!r || !r.ok) { toast(t("toast.rewindFail", { p1: (r && r.error) || t('common.unknownError') }), 'err'); return; }
        // Reload the truncated session and re-render; refill the composer with the removed user text.
        // v1.0-S7 (perf): reset the window cursor so the shrunken conversation re-windows from its new tail.
        if (state.currentSession?.id === sid) { const s = await api(`/api/sessions/${sid}`); state.currentSession = s.session; state.resumable = s.resumable || null; state.msgWindowStart = null; renderCurrentSession(); renderResumeBanner(); }
        await refreshSessions();
        if (r.lastUserText != null) { $('promptInput').value = r.lastUserText; autoGrow($('promptInput')); $('promptInput').focus(); }
        const reverted = (r.filesReverted || []).length;
        const failed = (r.filesFailed || []).length;
        let m = `已回溯,删除 ${r.removedTurns || 0} 条消息`;
        if (reverted) m += ` · 撤销 ${reverted} 个文件`;
        if (failed) m += ` · ${failed} 个未能撤销`;
        toast(m, failed ? '' : 'ok');
      } catch (e) { modal.close(); toast(t("toast.rewindFail", { p1: apiErrText(e) }), 'err'); }
    };
  }
  return {
    buildStaticToolGroup,
    ctxTokensOf,
    ctxWindow,
    ctxWindowManual,
    ctxWindowSourceLabel,
    highlightIn,
    iconTextBtn,
    latestUsage,
    messageShell,
    metaFromMessage,
    msgActions,
    renderContextMeter,
    renderGitDiffInto,
    renderMarkdown,
    safeStringify,
    setCtxWindowManual,
    settleLiveThinking,
    thinkingPanel,
    toolCard,
    toolGroupSummaryText,
    updateContextMeter,
    usageLine,
    wrapPreWithCopy,
  };
}
