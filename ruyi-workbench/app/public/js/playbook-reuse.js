'use strict';

// Existing modal, API and form styles; recognition never writes until the user saves the editor.
export function createPlaybookReuseUi({ api, apiErrText, el, buildModal, t, toast, refreshPlaybooks = () => {}, isCurrent = () => true }) {
  const field = (body, label, value, rows = 1) => {
    const wrap = el('label', 'pb-field'); wrap.append(el('span', 'pb-field-label', label));
    const input = el(rows > 1 ? 'textarea' : 'input', 'pb-field-input');
    if (rows > 1) input.rows = rows; else input.type = 'text';
    input.value = value || ''; wrap.append(input); body.append(wrap); return input;
  };
  const parameters = (body, initial) => {
    const host = el('div', 'pb-form'); body.append(el('p', 'pb-field-label', t('playbook.reuse.inputs')), host);
    let next = 1;
    const add = item => {
      const row = el('div', 'pb-field'); row.dataset.reuse = 'input';
      const key = field(row, t('playbook.reuse.key'), item.key), label = field(row, t('playbook.reuse.label'), item.label);
      const typeWrap = el('label', 'pb-field'); typeWrap.append(el('span', 'pb-field-label', t('playbook.reuse.type')));
      const type = el('select', 'pb-field-input');
      for (const value of ['file', 'folder', 'text']) { const option = el('option', '', t('playbook.reuse.type.' + value)); option.value = value; type.append(option); }
      type.value = item.type || 'text'; typeWrap.append(type); row.append(typeWrap);
      const remove = el('button', '', t('common.delete')); remove.type = 'button'; remove.onclick = () => row.remove(); row.append(remove); host.append(row);
      row.readInput = () => ({ key: key.value.trim(), label: label.value.trim(), type: type.value, required: true });
    };
    const button = el('button', '', t('playbook.reuse.addInput')); button.type = 'button'; button.onclick = () => { if (host.children.length < 12) add({ key: 'input' + next++, label: '', type: 'text' }); }; body.append(button);
    const reset = items => { host.replaceChildren(); items.forEach(add); };
    reset(initial); return { read: () => [...host.children].map(row => row.readInput()), reset };
  };
  function edit(draft, copy = false) {
    const original = structuredClone(draft);
    if (copy) original.id = 'pb-' + crypto.randomUUID().replaceAll('-', '');
    const body = el('div', 'pb-form'); body.dataset.reuse = 'editor';
    body.append(el('p', 'pb-form-desc', t('playbook.reuse.unverified')));
    const title = field(body, t('playbook.create.fieldTitle'), original.title);
    const desc = field(body, t('playbook.create.fieldDescription'), original.desc, 2);
    const template = field(body, t('playbook.create.fieldTemplate'), original.promptTemplate.split('\n\n<playbook-reuse-checks>')[0], 8);
    const inputs = parameters(body, original.inputs || []);
    const checks = field(body, t('playbook.reuse.checks'), (original.reuse?.checks || []).join('\n'), 4); checks.dataset.reuse = 'checks';
    if (original.reuse) {
      const details = el('details', 'pb-guide'); details.append(el('summary', '', t('playbook.reuse.provenance')));
      details.append(el('p', '', t('playbook.reuse.sourceTurn', { turn: original.reuse.source.turnSeq })));
      for (const correction of original.reuse.corrections) details.append(el('pre', 'pb-guide-text', correction.text));
      body.append(details);
    }
    const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    const cancel = el('button', '', t('common.cancel')), reset = el('button', '', t('playbook.reuse.reset')), save = el('button', 'primary', t('common.save'));
    foot.append(cancel, reset, save); const modal = buildModal(t('playbook.create.modalTitle'), body, foot);
    cancel.onclick = () => modal.close();
    reset.onclick = () => { title.value = original.title; desc.value = original.desc; template.value = original.promptTemplate.split('\n\n<playbook-reuse-checks>')[0]; inputs.reset(original.inputs); checks.value = original.reuse.checks.join('\n'); };
    save.onclick = async () => {
      const pb = { ...original, title: title.value.trim(), desc: desc.value.trim(), promptTemplate: template.value, inputs: inputs.read(), reuse: { ...original.reuse, checks: checks.value.split('\n').map(x => x.trim()).filter(Boolean) } };
      if (!pb.title || !pb.promptTemplate.trim() || !pb.inputs.length || !pb.reuse.checks.length) { toast(t('playbook.reuse.required'), 'err'); return; }
      save.disabled = true;
      try {
        const r = await api('/api/playbooks', { method: 'POST', body: JSON.stringify({ playbook: pb }) });
        if (!r?.ok) throw new Error(apiErrText(r?.error));
        modal.close(); toast(t('playbook.create.saved'), 'ok'); refreshPlaybooks();
      } catch (error) { toast(t('playbook.create.saveFailed', { reason: apiErrText(error) }), 'err'); }
      finally { save.disabled = false; }
    };
    return modal;
  }
  async function select(sessionId, message, onDraft) {
    const data = await api('/api/playbooks/draft', { method: 'POST', body: JSON.stringify({ sessionId, mode: 'sources' }) });
    if (!isCurrent()) return;
    if (!data?.ok || !data.results.length) { toast(t('playbook.reuse.noSources'), 'err'); return; }
    const preferred = message ? data.results.find(r => r.turnSeq === Number(message.turnSeq ?? message.turnSummary?.turnSeq) && !r.truncated && r.text === message.content) : null;
    if (message && !preferred) { toast(t('playbook.reuse.changed'), 'err'); return; }
    const body = el('div', 'pb-form'); body.dataset.reuse = 'selection';
    body.append(el('p', 'pb-form-desc', t('playbook.reuse.explain')));
    const resultWrap = el('label', 'pb-field'); resultWrap.append(el('span', 'pb-field-label', t('playbook.reuse.result')));
    const results = el('select', 'pb-field-input');
    for (const row of data.results) { const option = el('option', '', '#' + row.turnSeq + ' · ' + row.text.slice(0, 70)); option.value = row.ref; option.disabled = row.truncated; results.append(option); }
    results.value = preferred?.ref || data.results.find(r => !r.truncated)?.ref || ''; resultWrap.append(results); body.append(resultWrap);
    const preview = el('pre', 'pb-guide-text'); body.append(preview);
    body.append(el('p', 'pb-field-label', t('playbook.reuse.corrections')));
    const corrections = el('div', 'pb-form'); body.append(corrections);
    const drawCorrections = () => {
      const selected = data.results.find(r => r.ref === results.value); preview.textContent = selected?.text || ''; corrections.replaceChildren();
      for (const row of data.corrections.filter(c => selected && !c.truncated && c.text.length <= 4000)) {
        const label = el('label', 'pb-field'), box = document.createElement('input'); box.type = 'checkbox'; box.value = row.ref;
        label.append(box, el('span', '', '#' + row.turnSeq + ' · ' + row.text)); corrections.append(label);
      }
    }; results.onchange = drawCorrections; drawCorrections();
    const inputs = parameters(body, [{ key: 'material', label: t('playbook.reuse.material'), type: 'file' }, { key: 'output', label: t('playbook.reuse.output'), type: 'file' }]);
    const checks = field(body, t('playbook.reuse.checks'), '', 4); checks.dataset.reuse = 'checks';
    if (!data.canDraft) body.append(el('p', 'pb-form-desc', t('playbook.reuse.providerRequired')));
    const foot = el('div'); foot.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    const cancel = el('button', '', t('common.cancel')), go = el('button', 'primary', t('playbook.reuse.draft')); go.disabled = !data.canDraft; foot.append(cancel, go);
    const modal = buildModal(t('playbook.reuse.title'), body, foot); cancel.onclick = () => modal.close();
    go.onclick = async () => {
      const selection = { resultRef: results.value, correctionRefs: [...corrections.querySelectorAll('input:checked')].map(x => x.value), inputs: inputs.read(), checks: checks.value.split('\n').map(x => x.trim()).filter(Boolean) };
      if (!selection.resultRef || !selection.checks.length || !selection.inputs.length || selection.inputs.some(i => !i.key || !i.label)) { toast(t('playbook.reuse.required'), 'err'); return; }
      go.disabled = true; go.textContent = t('playbook.create.drafting');
      try {
        const r = await api('/api/playbooks/draft', { method: 'POST', body: JSON.stringify({ sessionId, selection }) });
        if (!body.isConnected || !isCurrent()) return;
        if (!r?.ok || !r.draft) throw new Error(apiErrText(r?.error));
        modal.close(); onDraft(r.draft);
      } catch (error) { if (body.isConnected) toast(t('playbook.create.draftFailed', { reason: apiErrText(error) }), 'err'); }
      finally { go.disabled = !data.canDraft; go.textContent = t('playbook.reuse.draft'); }
    };
    return modal;
  }
  return { select, edit };
}
