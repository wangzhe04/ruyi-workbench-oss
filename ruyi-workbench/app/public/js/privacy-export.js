import { api, apiErrorInfo } from './net.js';
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
  const key = /(?:changed|dirty|revoked|unknown|expired|missing)/.test(code) ? 'changed'
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
