// 02e-session-engine-route.js - 架构还债批 3·B: 从 02-session-store.js 搬出的会话引擎路由归一与推断(纯函数;123-N2 的「记/读上一次用的引擎」仍在 02;纯搬家,零行为变更)。
// Conversation engine/model selection belongs to the session, not to whichever global selector was
// touched most recently. The global config remains the default for NEW sessions; existing sessions keep
// this compact route descriptor and the turn dispatcher overlays it onto a request-local config copy.
function normalizeSessionEngineRoute(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = String(raw.model || '').trim().slice(0, 256);
  if (raw.engine === 'openai') {
    const providerId = String(raw.providerId || '').trim().slice(0, 128);
    return providerId ? { engine: 'openai', providerId, model } : null;
  }
  if (raw.engine === 'agent' || raw.engine === 'claude') {
    // 登记过的 CLI 类型原样保留,其余归 claude(01f normalizeAgentCliType;修前是 `=== 'kimi' ? 'kimi' : 'claude'`)。
    const agentCliType = normalizeAgentCliType(raw.agentCliType);
    return { engine: 'agent', agentCliType, model };
  }
  return null;
}

function sessionEngineRouteFromConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const providerId = String(cfg.activeProvider || '').trim();
  if (providerId && providerId !== 'claude-cli') {
    const provider = (cfg.providers || []).find(item => item && item.id === providerId);
    return normalizeSessionEngineRoute({ engine: 'openai', providerId, model: provider && provider.model });
  }
  return normalizeSessionEngineRoute({ engine: 'agent', agentCliType: cfg.agentCliType, model: cfg.model });
}

function inferSessionEngineRoute(session) {
  const explicit = normalizeSessionEngineRoute(session && session.engineRoute);
  if (explicit) return explicit;
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const inferred = message.engine === 'openai' || message.providerId
      ? normalizeSessionEngineRoute({ engine: 'openai', providerId: message.providerId, model: message.model })
      : normalizeSessionEngineRoute({ engine: 'agent', agentCliType: message.agentCliType, model: message.model });
    if (inferred) return inferred;
  }
  return null;
}

function configForSessionEngineRoute(config, session) {
  const route = inferSessionEngineRoute(session);
  if (!route) return config;
  if (route.engine === 'openai') {
    const providers = (config.providers || []).map(provider => provider && provider.id === route.providerId
      ? { ...provider, model: route.model || provider.model || '' }
      : provider);
    return { ...config, activeProvider: route.providerId, providers };
  }
  return {
    ...config,
    activeProvider: '',
    agentCliType: route.agentCliType,
    model: route.model,
  };
}
