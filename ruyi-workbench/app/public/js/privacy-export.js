import { api, apiErrorInfo } from './net.js';
import { beginClipboardWrite, disclosureSourceFor, assertDisclosureSource } from './disclosure-source.js';
import { state } from './state.js';
import { t } from './i18n.js';
import { toast } from './util.js';

// Shared prepare/derive/validate loop for local copies. The proof attests the
// host's complete source, not arbitrary browser-generated SVG/PNG bytes.
async function validatedCopy(request, { unchanged, create, dispose, commit }) {
  let prepared;
  try {
    unchanged();
    let artifact = await api('/api/privacy/export', { method: 'POST', body: JSON.stringify(request) });
    for (let attempt = 0; attempt < 3; attempt++) {
      unchanged();
      prepared = await create(artifact);
      unchanged();
      const result = await api('/api/privacy/export', { method: 'POST', body: JSON.stringify({ op: 'validate', proof: artifact.proof, hash: artifact.hash }) });
      unchanged();
      if (result.proof) { dispose(prepared); prepared = null; artifact = result; continue; }
      // No await between the final browser guard and OS/clipboard submission.
      const completion = commit(prepared, artifact);
      if (completion) await completion;
      return artifact;
    }
    throw new Error(t('privacy.export.changed'));
  } catch (error) { if (prepared) dispose(prepared); throw error; }
}
function exportFailure(error) {
  const code = apiErrorInfo(error).code;
  const key = code === 'privacy.export_media_unsupported' ? 'mediaUnsupported' : code === 'privacy.export_source_missing' ? 'sourceMissing'
    : code === 'privacy.export_clipboard_unavailable' ? 'clipboardUnavailable' : /(?:changed|dirty|revoked|unknown|expired|missing)/.test(code) ? 'changed'
    : /(?:limit|capacity)/.test(code) ? 'limit' : /(?:busy)/.test(code) ? 'busy' : 'failed';
  toast(t('privacy.export.' + key), 'err');
}
// One click prepares the final file. A deliberate plaintext action is per copy.
export async function downloadPrivacyExport(request) {
  const sessionId = state.currentSession?.id;
  const sourceSnapshot = request.kind === 'session' ? JSON.stringify(state.currentSession) : null;
  const configSnapshot = JSON.stringify(state.config);
  const unchanged = () => {
    if (sessionId !== state.currentSession?.id || configSnapshot !== JSON.stringify(state.config)
      || (sourceSnapshot !== null && sourceSnapshot !== JSON.stringify(state.currentSession))) throw new Error(t('privacy.export.changed'));
  };
  try {
    const expectedPrivacy = { mode: state.config?.privacyModeV1 || 'off', technical: state.config?.privacyTechnicalV1 === true, rules: state.config?.privacyRulesV1 || [] };
    const artifact = await validatedCopy({ ...request, expectedPrivacy }, {
      unchanged,
      create: value => ({ url: URL.createObjectURL(new Blob([value.content], { type: value.mime })) }),
      dispose: value => URL.revokeObjectURL(value.url),
      commit: (value, artifact) => {
        const link = document.createElement('a'); link.href = value.url; link.download = artifact.filename; link.click();
        setTimeout(() => URL.revokeObjectURL(value.url), 1000);
      },
    });
    toast(t(artifact.contentWithheld ? 'privacy.export.withheld' : artifact.protected ? 'privacy.export.protected' : 'privacy.export.saved'), 'ok');
    return artifact;
  } catch (error) { exportFailure(error); return null; }
}
export async function mermaidDocumentHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function exportMermaidDocument({ record, localDocument, format, plaintext, assertCurrent, create, clipboard, intent }) {
  const sessionId = intent?.sessionId, configSnapshot = JSON.stringify(state.config);
  const unchanged = () => {
    assertCurrent();
    if (!intent || JSON.stringify(intent.privacy) !== JSON.stringify({ mode: state.config?.privacyModeV1 || 'off', technical: state.config?.privacyTechnicalV1 === true, rules: state.config?.privacyRulesV1 || [] })) throw new Error(t('privacy.export.changed'));
    if (sessionId !== state.currentSession?.id || configSnapshot !== JSON.stringify(state.config)) throw new Error(t('privacy.export.changed'));
    if (record) {
      const locator = record.locator, message = state.currentSession?.messages?.[locator.messageIndex];
      const identity = message && { id: message.id || '', role: message.role, createdAt: message.createdAt || '', turnSeq: message.turnSeq ?? null };
      const source = locator.slot === 'content' ? message?.content : message?.segments?.[locator.segmentIndex]?.[locator.slot === 'segment-text' ? 'text' : 'markdown'];
      if (state.currentSession?.id !== locator.sessionId || JSON.stringify(identity) !== JSON.stringify(locator.messageIdentity) || source !== record.document) throw new Error(t('privacy.export.changed'));
    }
  };
  try {
    unchanged();
    const expectedPrivacy = intent.privacy;
    const request = { kind: 'mermaid-document', ...(record ? record.locator : { localDocument }), format, ...(plaintext ? { plaintext: true } : {}), expectedPrivacy, expectedDocumentHash: await mermaidDocumentHash(record ? record.document : localDocument) };
    unchanged();
    const artifact = await validatedCopy(request, {
      unchanged,
      create: async artifact => {
        const value = await create(artifact.content);
        try {
          unchanged(); return value;
        } catch (error) { if (value.url) URL.revokeObjectURL(value.url); throw error; }
      },
      dispose: value => { if (value.url) URL.revokeObjectURL(value.url); },
      commit: (value, artifact) => {
        if (clipboard) { clipboard.resolve(value.blob); return clipboard.pending; }
        const link = document.createElement('a'); link.href = value.url; link.download = artifact.filename; link.click();
        setTimeout(() => URL.revokeObjectURL(value.url), 1000);
      },
    });
    toast(t(artifact.protected ? 'privacy.export.protected' : 'privacy.export.saved'), 'ok');
    return artifact;
  } catch (error) { if (clipboard) clipboard.reject(error); exportFailure(error); return null; }
}

function clipboardIntent(bindSession = true) {
  return { ...(bindSession ? { sessionId: state.currentSession?.id } : {}), config: JSON.stringify(state.config),
    knownUsableOff: Object.hasOwn(state.config || {}, 'privacyModeV1') && state.config.privacyModeV1 === 'off' && state.config.privacyPolicyRecoveryRequiredV1 !== true,
    privacy: {
    mode: Object.hasOwn(state.config || {}, 'privacyModeV1') ? state.config.privacyModeV1 : 'unknown',
    technical: state.config?.privacyTechnicalV1 === true, rules: structuredClone(state.config?.privacyRulesV1 || []),
  } };
}
function assertClipboardIntent(intent) {
  if ((Object.hasOwn(intent, 'sessionId') && intent.sessionId !== state.currentSession?.id) || intent.config !== JSON.stringify(state.config)) throw Object.assign(new Error('privacy.export_source_changed'), { code: 'privacy.export_source_changed' });
}
export async function copyPrivacyExport(request) {
  const intent = clipboardIntent(false); let clipboard;
  try {
    clipboard = beginClipboardWrite();
    const unchanged = () => assertClipboardIntent(intent);
    const artifact = await validatedCopy({ ...request, expectedPrivacy: intent.privacy }, {
      unchanged, create: artifact => ({ blob: new Blob([artifact.content], { type: 'text/plain' }) }), dispose: () => {},
      commit: value => { clipboard.resolve(value.blob); return clipboard.pending; },
    });
    toast(t(artifact.contentWithheld ? 'privacy.copy.withheld' : artifact.protected ? 'privacy.copy.protected' : 'toast.copied'), 'ok');
    return artifact;
  } catch (error) { clipboard?.reject(error); exportFailure(error); return null; }
}
export async function copyDisclosureSource(node, { kind, plaintext = false, renderMarkdownInto, localText } = {}) {
  const intent = clipboardIntent(); let clipboard;
  try {
    clipboard = beginClipboardWrite();
    if (node?.isConnected === false) throw Object.assign(new Error('privacy.export_source_changed'), { code: 'privacy.export_source_changed' });
    const record = disclosureSourceFor(node);
    const expectedSlot = kind === 'tool' ? record?.locator.slot?.startsWith('tool-')
      : kind === 'message' ? record?.locator.slot === 'content'
        : ['content', 'segment-text', 'segment-markdown'].includes(record?.locator.slot);
    const canonical = record && expectedSlot;
    let unchanged, request, visibleText;
    if (!canonical) {
      if (!intent.knownUsableOff) throw Object.assign(new Error('privacy.export_source_missing'), { code: 'privacy.export_source_missing' });
      const readText = () => String((typeof localText === 'function' ? localText() : typeof localText === 'string' ? localText : node?.textContent) ?? '');
      const text = readText();
      unchanged = () => {
        assertClipboardIntent(intent);
        if (!node || node.isConnected === false || readText() !== text) throw Object.assign(new Error('privacy.export_source_changed'), { code: 'privacy.export_source_changed' });
      };
      unchanged(); const expectedTextHash = await mermaidDocumentHash(text); unchanged();
      request = { kind: 'clipboard-local', text, expectedTextHash, expectedPrivacy: intent.privacy, ...(plaintext ? { plaintext: true } : {}) };
    } else {
      visibleText = kind === 'code' ? String(node.textContent || '') : record.document;
      unchanged = () => {
        assertClipboardIntent(intent); assertDisclosureSource(record);
        const locator = record.locator, message = state.currentSession?.messages?.[locator.messageIndex];
        if (!record.messageSnapshot || JSON.stringify(message) !== record.messageSnapshot) throw Object.assign(new Error('privacy.export_source_changed'), { code: 'privacy.export_source_changed' });
        const identity = message && { id: message.id || '', role: message.role, createdAt: message.createdAt || '', turnSeq: message.turnSeq ?? null };
        let source = locator.slot === 'content' ? message?.content : locator.slot === 'segment-text' ? message?.segments?.[locator.segmentIndex]?.text
          : locator.slot === 'segment-markdown' ? message?.segments?.[locator.segmentIndex]?.markdown : undefined;
        if (locator.slot?.startsWith('tool-')) {
          const tool = message?.toolCalls?.[locator.toolIndex];
          if (!tool || tool.id !== locator.toolId || tool.name !== locator.toolName) throw Object.assign(new Error('privacy.export_source_changed'), { code: 'privacy.export_source_changed' });
          source = tool[locator.slot === 'tool-input' ? 'input' : 'result'];
        }
        const current = source == null ? '' : typeof source === 'string' ? source : JSON.stringify(source, null, 2);
        if (current !== record.document) throw Object.assign(new Error('privacy.export_source_changed'), { code: 'privacy.export_source_changed' });
        if (intent.sessionId !== locator.sessionId || JSON.stringify(identity) !== JSON.stringify(locator.messageIdentity)) throw Object.assign(new Error('privacy.export_source_changed'), { code: 'privacy.export_source_changed' });
        if (kind === 'code' && node.textContent !== visibleText) throw Object.assign(new Error('privacy.export_source_changed'), { code: 'privacy.export_source_changed' });
      };
      unchanged();
      const expectedDocumentHash = await mermaidDocumentHash(record.document); unchanged();
      const expectedMessageHash = await mermaidDocumentHash(JSON.parse(record.messageSnapshot)); unchanged();
      request = { kind: 'clipboard-source', ...record.locator, expectedDocumentHash, expectedMessageHash, expectedPrivacy: intent.privacy, ...(plaintext ? { plaintext: true } : {}) };
    }
    const artifact = await validatedCopy(request, {
      unchanged,
      create: artifact => {
        let text = artifact.content;
        if (canonical && kind === 'code') {
          if (typeof renderMarkdownInto !== 'function') throw Object.assign(new Error('privacy.export_source_missing'), { code: 'privacy.export_source_missing' });
          const original = document.createElement('template'), projected = document.createElement('template');
          renderMarkdownInto(original, record.document); renderMarkdownInto(projected, text);
          const blocks = root => Array.from((root.content || root).querySelectorAll('pre > code'));
          const oldBlocks = blocks(original), newBlocks = blocks(projected), visible = blocks(record.node);
          const ordinal = visible.indexOf(node);
          if (ordinal < 0 || oldBlocks.length !== visible.length || newBlocks.length !== oldBlocks.length || oldBlocks[ordinal]?.textContent !== visibleText) throw Object.assign(new Error('privacy.export_source_changed'), { code: 'privacy.export_source_changed' });
          text = String(newBlocks[ordinal].textContent || '');
        }
        return { blob: new Blob([text], { type: 'text/plain' }) };
      },
      dispose: () => {}, commit: value => { clipboard.resolve(value.blob); return clipboard.pending; },
    });
    toast(t(artifact.protected ? 'privacy.copy.protected' : 'toast.copied'), 'ok'); return artifact;
  } catch (error) { clipboard?.reject(error); exportFailure(error); return null; }
}
