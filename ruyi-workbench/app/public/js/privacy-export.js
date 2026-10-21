import { api, apiErrorInfo } from './net.js';
import { state } from './state.js';
import { t } from './i18n.js';
import { toast } from './util.js';

// One click prepares the final file. A deliberate plaintext action is per copy.
export async function downloadPrivacyExport(request) {
  const sessionId = state.currentSession?.id;
  const sourceSnapshot = request.kind === 'session' ? JSON.stringify(state.currentSession) : null;
  const configSnapshot = JSON.stringify(state.config);
  const unchanged = () => {
    if (sessionId !== state.currentSession?.id || configSnapshot !== JSON.stringify(state.config)
      || (sourceSnapshot !== null && sourceSnapshot !== JSON.stringify(state.currentSession))) throw new Error(t('privacy.export.changed'));
  };
  let url = '';
  try {
    let artifact = await api('/api/privacy/export', { method: 'POST', body: JSON.stringify(request) });
    let validated = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      unchanged();
      if (url) URL.revokeObjectURL(url);
      const blob = new Blob([artifact.content], { type: artifact.mime });
      url = URL.createObjectURL(blob);
      const result = await api('/api/privacy/export', { method: 'POST', body: JSON.stringify({ op: 'validate', proof: artifact.proof, hash: artifact.hash }) });
      if (!result.proof) { validated = true; break; }
      artifact = result;
    }
    if (!validated) throw new Error(t('privacy.export.changed'));
    unchanged();
    const link = document.createElement('a'); link.href = url; link.download = artifact.filename; link.click();
    toast(t(artifact.contentWithheld ? 'privacy.export.withheld' : artifact.protected ? 'privacy.export.protected' : 'privacy.export.saved'), 'ok');
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return artifact;
  } catch (error) {
    if (url) URL.revokeObjectURL(url);
    const code = apiErrorInfo(error).code;
    const key = /(?:changed|dirty|revoked|unknown|expired|missing)/.test(code) ? 'changed'
      : /(?:limit|capacity)/.test(code) ? 'limit' : /(?:busy)/.test(code) ? 'busy' : 'failed';
    toast(t('privacy.export.' + key), 'err');
    return null;
  }
}
