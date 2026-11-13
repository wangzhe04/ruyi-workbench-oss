'use strict';

// The native handler independently verifies the main frame, exact origin and message schema.
export function isMacHost(env = globalThis) {
  return env.__ruyiDesktopPlatform === 'darwin'
    && typeof env.webkit?.messageHandlers?.ruyiHost?.postMessage === 'function';
}

export async function hostRequest(method, params = {}, { signal } = {}) {
  if (!isMacHost()) throw new Error('Native Mac host is unavailable');
  if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
  const id = crypto.randomUUID();
  const handler = globalThis.webkit.messageHandlers.ruyiHost;
  let timer;
  let abort;
  const waiting = new Promise((resolve, reject) => {
    const cancel = () => {
      if (method === 'pickFolder' || method === 'pickFile') {
        void handler.postMessage({ version: 1, id: crypto.randomUUID(), method: 'cancelPicker', params: { id } }).catch(() => {});
      }
    };
    timer = setTimeout(() => {
      cancel();
      reject(Object.assign(new Error('host.timeout'), { code: 'host.timeout' }));
    }, 125000);
    abort = () => { cancel(); reject(new DOMException('The operation was aborted', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(handler.postMessage({ version: 1, id, method, params })).then(resolve, reject);
  });
  try { return await waiting; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

const PICKER_METHODS = Object.freeze({ '/api/pick-folder': 'pickFolder', '/api/pick-file': 'pickFile' });
function pickerMethod(path, options = {}) {
  if (!isMacHost() || String(options.method || 'GET').toUpperCase() !== 'POST' || !Object.hasOwn(PICKER_METHODS, path)) return null;
  return PICKER_METHODS[path];
}

// Domain modules also import net.api directly. Register on the shared function so all
// existing entry points participate, while net.js retains its dependency-free transport.
export function installHostPickers(api, translate) {
  api.hostAdapter = { handles: (path, options) => Boolean(pickerMethod(path, options)), request: withHostPickers(api, translate) };
}

export function bindHostActions(actions) {
  void refreshHostPermissions().catch(() => {});
  globalThis.addEventListener('focus', () => { void refreshHostPermissions().catch(() => {}); });
  globalThis.addEventListener('ruyi:host-wake', () => { void refreshHostPermissions().catch(() => {}); });
  globalThis.addEventListener('ruyi:host-action', event => {
    if (typeof event.detail === 'string' && Object.hasOwn(actions, event.detail)) void actions[event.detail]();
  });
}

export function withHostPickers(api, translate = code => code) {
  const wrapped = async (path, options = {}) => {
    const method = pickerMethod(path, options);
    if (!method) return api(path, options);
    try {
      const params = options.body ? JSON.parse(options.body) : {};
      const result = await hostRequest(method, params, { signal: options.signal });
      if (result?.ok !== false) return result;
      const code = result.error?.code || 'host.unavailable';
      return { ...result, error: { ...result.error, code, message: translate(code) }, hint: translate('host.picker_hint') };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      const code = error?.code === 'host.timeout' ? 'host.timeout' : 'host.unavailable';
      throw new Error(JSON.stringify({ error: { code, message: translate(code) } }));
    }
  };
  return Object.assign(wrapped, api);
}

let notificationPermission = 'default';
let permissionGeneration = 0;
let permissionRequest = null;
export function macNotificationPermission() { return notificationPermission; }

export async function refreshHostPermissions() {
  if (!isMacHost()) return;
  if (permissionRequest) return permissionRequest;
  const generation = ++permissionGeneration;
  const result = await hostRequest('notificationStatus');
  if (generation !== permissionGeneration) return notificationPermission;
  notificationPermission = result?.ok ? result.permission : 'unsupported';
  globalThis.dispatchEvent?.(new Event('ruyi:host-permission'));
  return notificationPermission;
}

export async function requestHostNotifications() {
  if (permissionRequest) return permissionRequest;
  ++permissionGeneration;
  permissionRequest = (async () => {
    const result = await hostRequest('requestNotifications');
    notificationPermission = result?.ok ? result.permission : 'denied';
    globalThis.dispatchEvent?.(new Event('ruyi:host-permission'));
    return notificationPermission;
  })();
  try { return await permissionRequest; }
  finally { permissionRequest = null; }
}

export async function sendHostNotification({ id, title, body }) {
  const result = await hostRequest('notify', { id, title, body });
  return result?.ok === true;
}
