// ── 04f · ruyi-toolbox 服务类组件:拉起、探活、接成能力端点、回收 ─────────────────────────────────────────
// 用户 2026-09-21:「如意启动时自动探测本机上是否有这个 asr shim,有的话自动拉起并自动配置好,开箱即用」,
// 随后扩成「toolbox 下的都是这样」。对接面只有 ruyi-toolbox 仓的 docs/00-component-registry.md;登记文件的读取与
// 校验住 04(scanToolboxComponents),MCP 类组件也在 04 并进外部 MCP 清单 —— 本模块只管 kind:'service'。
// 这是 26 号文 114d 后半(「本地 HTTP 助手进程」管理器)的落地,形状比当时写的更一般:不再是 provider 上的
// localCommand 字段,而是一份住在用户主目录下的登记文件 —— 命令【只来自磁盘】,没有任何 HTTP 途径写它。
//
// 纪律:
//   ① 绝不阻塞启动。startServer 里 void 调用;探活用 fetch(异步),拉起用 spawn(异步),一发 spawnSync 都没有
//      (128f-⑬ 的教训:同步探测会把整个服务钉住)。只有进程退出那一刻的收尾用同步 taskkill —— 那时已经没有请求要服务了。
//   ② 已经有人起好了就不起第二个:端口上站着的 /health 回 component 对得上 → 直接用(owned:false,退出时也不杀它)。
//   ③ 端口被【别人】占了 → 另挑空闲端口经 portEnv 告诉组件。component 对不上的端口绝不配成端点。
//   ④ 不经 shell、不拼接参数、不展开变量;windowsHide;stdin 忽略;stderr 只留尾巴给设置页看,不进日志正文。
//   ⑤ 自动选成语音识别端点【每个组件只发生一次】(config.toolbox.seen),且只在用户还没配过语音识别时;
//      用户后来关掉或换走,绝不再替他选回来。已经配了别的 → 只列为候选。
//   ⑥ 自动生成的服务商 id 一律 `toolbox-<id>`,这个前缀归自动发现所有:组件被停用／卸载,条目跟着撤。
//      组件只是【这次没起来】不撤条目 —— 否则一次偶发失败就会把用户的语音识别选择永久清掉(⑤ 不会再选回来)。
//   ⑦ 每次拉起／接管／失败／停止都记审计日志(组件 id、pid、端口、结果),不是悄悄的。
const TOOLBOX_HEALTH_DEADLINE_MS = 20000;   // 约定 §2.2 第 4 条:健康轮询 ≤ 20 秒
const TOOLBOX_HEALTH_POLL_MS = 400;
const TOOLBOX_PROBE_TIMEOUT_MS = 1500;
const TOOLBOX_STDERR_TAIL = 2000;
const toolboxServices = new Map();          // id → { component, state, port, owned, child, pid, error, stderrTail, starting, stopping, startedAt }

function toolboxProviderId(componentId) { return 'toolbox-' + componentId; }

// 'ours' = 端口上站着的就是这个组件;'other' = 有人占着但不是它;'down' = 端口空着。
async function toolboxProbe(port, healthPath, componentTag) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + healthPath, { signal: AbortSignal.timeout(TOOLBOX_PROBE_TIMEOUT_MS) });
    const text = (await res.text()).slice(0, 4096);
    const body = safeJsonParse(text, null);
    if (res.ok && body && typeof body === 'object' && body.component === componentTag) return 'ours';
    return 'other';
  } catch {
    return (await toolboxPortFree(port)) ? 'down' : 'other';
  }
}
function toolboxListenOnce(port) {
  return new Promise(resolve => {
    const probe = http.createServer();
    probe.once('error', () => resolve(0));
    probe.listen(port, '127.0.0.1', () => { const got = probe.address().port; probe.close(() => resolve(got)); });
  });
}
async function toolboxPortFree(port) { return (await toolboxListenOnce(port)) === port; }
async function toolboxFreePort() { return toolboxListenOnce(0); }

// 整棵树:Windows 上 venv 的 python.exe 是个启动器,真正的解释器是它的子进程 —— 只 kill 启动器会留下孤儿(还占着显存)。
function toolboxKillTree(child, sync) {
  if (!child || !child.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    const args = ['/PID', String(child.pid), '/T', '/F'];
    try {
      if (sync) cp.spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      else cp.spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } catch { /* taskkill 不在也别抛:下面再补一刀 */ }
  }
  try { child.kill(); } catch { /* 已经没了 */ }
}

function toolboxEntry(component) {
  let entry = toolboxServices.get(component.id);
  if (!entry) {
    entry = { component, state: 'idle', port: component.service.port, owned: false, child: null, pid: 0, error: '', stderrTail: '', starting: null, stopping: false, startedAt: 0 };
    toolboxServices.set(component.id, entry);
  }
  entry.component = component;
  return entry;
}

// 起一个服务(幂等、并发互斥:同一个组件同时只有一趟在起 —— 55 波「getMcpClient 必须并发互斥防孤儿」同一条教训)。
function startToolboxService(component) {
  const entry = toolboxEntry(component);
  if (entry.starting) return entry.starting;
  entry.starting = (async () => {
    const svc = component.service;
    const t0 = Date.now();
    // 还活着就不动:自己起的看子进程,接管来的再探一次。
    if (entry.state === 'running') {
      if (entry.owned ? (entry.child && entry.child.exitCode === null) : (await toolboxProbe(entry.port, svc.health, svc.component)) === 'ours') return entry;
    }
    entry.error = ''; entry.stderrTail = ''; entry.stopping = false;
    const first = await toolboxProbe(svc.port, svc.health, svc.component);
    if (first === 'ours') {
      Object.assign(entry, { state: 'running', port: svc.port, owned: false, child: null, pid: 0, startedAt: Date.now() });
      logEvent({ kind: 'toolbox_service', action: 'adopt', id: component.id, port: svc.port });
      return entry;
    }
    const port = first === 'down' ? svc.port : await toolboxFreePort();
    if (!port) { Object.assign(entry, { state: 'failed', error: 'no-free-port' }); logEvent({ kind: 'toolbox_service', action: 'fail', id: component.id, reason: 'no-free-port' }); return entry; }
    let child = null;
    try {
      child = cp.spawn(component.run.command, component.run.args, {
        cwd: component.run.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1', ...component.run.env, [svc.portEnv]: String(port), RUYI_TOOLBOX_PARENT_PID: String(process.pid) },
      });
    } catch (err) {
      Object.assign(entry, { state: 'failed', error: 'spawn: ' + String(err && err.message || err).slice(0, 200) });
      logEvent({ kind: 'toolbox_service', action: 'fail', id: component.id, reason: 'spawn' });
      return entry;
    }
    Object.assign(entry, { state: 'starting', port, owned: true, child, pid: child.pid || 0 });
    let spawnError = '';
    child.on('error', err => { spawnError = String(err && err.message || err).slice(0, 200); });
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { entry.stderrTail = (entry.stderrTail + chunk).slice(-TOOLBOX_STDERR_TAIL); });
    }
    child.on('exit', (code, signal) => {
      if (entry.child !== child) return;
      const was = entry.state;
      entry.state = entry.stopping ? 'stopped' : (was === 'starting' ? 'failed' : 'exited');
      if (!entry.stopping) entry.error = 'exit ' + (code === null ? String(signal || '') : code);
      logEvent({ kind: 'toolbox_service', action: entry.stopping ? 'stop' : 'exit', id: component.id, pid: entry.pid, code, signal: signal || '' });
    });
    logEvent({ kind: 'toolbox_service', action: 'spawn', id: component.id, pid: entry.pid, port, command: path.basename(component.run.command) });
    const deadline = t0 + TOOLBOX_HEALTH_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null || child.signalCode) break;
      if (entry.stopping) return entry;
      if ((await toolboxProbe(port, svc.health, svc.component)) === 'ours') {
        Object.assign(entry, { state: 'running', startedAt: Date.now() });
        logEvent({ kind: 'toolbox_service', action: 'ready', id: component.id, pid: entry.pid, port, ms: Date.now() - t0 });
        return entry;
      }
      await new Promise(r => setTimeout(r, TOOLBOX_HEALTH_POLL_MS));
    }
    // 没起来:不重试到天荒地老。杀掉、记一笔、把 stderr 的尾巴留给设置页。
    entry.stopping = true;
    toolboxKillTree(child, false);
    Object.assign(entry, { state: 'failed', error: spawnError || (child.exitCode !== null ? 'exit ' + child.exitCode : 'health-timeout') });
    logEvent({ kind: 'toolbox_service', action: 'fail', id: component.id, pid: entry.pid, reason: entry.error });
    return entry;
  })().finally(() => { entry.starting = null; });
  return entry.starting;
}

function stopToolboxService(id, sync) {
  const entry = toolboxServices.get(id);
  if (!entry) return;
  entry.stopping = true;
  if (entry.owned && entry.child) toolboxKillTree(entry.child, sync === true);   // 接管来的(用户自己起的)不杀
  if (entry.state !== 'failed') entry.state = 'stopped';
}
// 进程退出那一刻(13 cleanupMcp):同步杀干净自己拉起的。如意被强杀时走不到这里 —— 那种情况靠组件自己的父进程看门狗。
function stopAllToolboxServicesSync() {
  for (const id of toolboxServices.keys()) { try { stopToolboxService(id, true); } catch { /* 收尾绝不抛 */ } }
}

// 把启用的服务类组件的 provides 落成配置。只在真有变化时才写盘(mutateConfig 的 abort 支)。
// 130(51 号文 §2.3):一个组件可以同时提供 asr(整段)与 asr-stream(流式),落成同一条服务商、两个带不同标记的模型;
// 两种能力各自有一对配置键(asrProviderId/asrModel 与 asrStreamProviderId/asrStreamModel),自动选中各算各的。
function toolboxDesiredProviders(config) {
  const out = [];
  for (const c of enabledToolboxComponents(config)) {
    if (c.kind !== 'service') continue;
    const asr = c.provides.find(p => p.type === 'asr') || null;
    const stream = c.provides.find(p => p.type === 'asr-stream') || null;
    if (!asr && !stream) continue;
    const entry = toolboxServices.get(c.id);
    const port = entry && entry.port ? entry.port : c.service.port;
    const base = 'http://127.0.0.1:' + port + ((asr || stream).basePath || '');
    const models = [];
    if (asr) models.push({ id: asr.model, label: asr.model, caps: ['asr'] });
    if (stream && !(asr && asr.model === stream.model)) models.push({ id: stream.model, label: stream.model, caps: ['asr-stream'] });
    else if (stream) models[0].caps.push('asr-stream');
    out.push({
      componentId: c.id,
      asrModel: asr ? asr.model : '',
      streamModel: stream ? stream.model : '',
      provider: {
        id: toolboxProviderId(c.id), label: c.name, baseUrl: base, apiKey: '', model: (asr || stream).model, models,
        ...(asr && asr.protocol === 'chat-audio' ? { asrProtocol: 'chat-audio' } : {}),
      },
    });
  }
  return out;
}
async function syncToolboxProviders() {
  return mutateConfig(current => {
    const desired = toolboxDesiredProviders(current);
    const wanted = new Map(desired.map(d => [d.provider.id, d.provider]));
    let changed = false;
    const providers = [];
    for (const p of (Array.isArray(current.providers) ? current.providers : [])) {
      if (!p || !String(p.id || '').startsWith('toolbox-')) { providers.push(p); continue; }
      const want = wanted.get(p.id);
      if (!want) { changed = true; continue; }   // 组件被停用／卸载 → 条目跟着撤(01 的归一化会把指向它的语音识别选择一并清空)
      wanted.delete(p.id);
      const sameModels = JSON.stringify(Array.isArray(p.models) ? p.models : []) === JSON.stringify(want.models);
      if (p.baseUrl !== want.baseUrl || p.label !== want.label || !sameModels || (p.asrProtocol || '') !== (want.asrProtocol || '')) {
        const next = { ...p, label: want.label, baseUrl: want.baseUrl, model: want.model, models: want.models };
        if (want.asrProtocol) next.asrProtocol = want.asrProtocol; else delete next.asrProtocol;
        providers.push(next); changed = true;
      } else providers.push(p);
    }
    // 这一趟【补回】的条目:配置里本来没有它。两种来路 —— 组件刚被重新启用(04f 自己在停用时撤的),或条目被别的
    // 什么弄丢了(2026-09-21 真机:设置页整份保存把它撤掉,13 现已挡住这条路)。两种都不是「用户换走／关掉了语音识别」
    // (那种情况条目还在、只是选择为空,C1 那条),所以下面的自动选中对它们再做一次 —— 否则用户停用再启用之后
    // 语音输入就没了,得自己去设置里再选一次。
    const readded = new Set([...wanted.keys()]);
    for (const want of wanted.values()) { providers.push(want); changed = true; }
    const tb = current.toolbox || { autoDiscover: true, disabled: [], seen: [] };
    const seen = new Set(Array.isArray(tb.seen) ? tb.seen : []);
    let asrProviderId = String(current.asrProviderId || ''), asrModel = String(current.asrModel || '');
    let asrStreamProviderId = String(current.asrStreamProviderId || ''), asrStreamModel = String(current.asrStreamModel || '');
    for (const d of desired) {
      if (seen.has(d.componentId) && !readded.has(d.provider.id)) continue;
      if (!seen.has(d.componentId)) { seen.add(d.componentId); changed = true; }
      if (d.asrModel && !asrProviderId && !asrModel) {
        asrProviderId = d.provider.id; asrModel = d.asrModel;
        logEvent({ kind: 'toolbox_service', action: 'asr-auto-select', id: d.componentId, model: asrModel });
      }
      if (d.streamModel && !asrStreamProviderId && !asrStreamModel) {
        asrStreamProviderId = d.provider.id; asrStreamModel = d.streamModel;
        logEvent({ kind: 'toolbox_service', action: 'asr-stream-auto-select', id: d.componentId, model: asrStreamModel });
      }
    }
    if (!changed) return { abort: 'unchanged' };
    return { next: { ...current, providers, asrProviderId, asrModel, asrStreamProviderId, asrStreamModel, toolbox: { ...tb, seen: [...seen] } } };
  });
}

// 对账:该起的起、该停的停、配置跟上。启动时调一次,全局配置保存之后再调一次(设置页里停用／启用某个组件)。
let toolboxReconcileChain = Promise.resolve();
function reconcileToolbox() {
  const run = toolboxReconcileChain.then(async () => {
    const config = await readConfig();
    invalidateToolboxCache();
    const enabled = enabledToolboxComponents(config).filter(c => c.kind === 'service');
    const keep = new Set(enabled.map(c => c.id));
    for (const [id, entry] of toolboxServices) {
      if (!keep.has(id) && entry.state !== 'stopped') stopToolboxService(id, false);
    }
    await Promise.all(enabled.map(c => startToolboxService(c).catch(() => null)));
    await syncToolboxProviders().catch(err => { logEvent({ kind: 'toolbox_service', action: 'config-sync-failed', error: String(err && err.message || err).slice(0, 200) }); });
  });
  toolboxReconcileChain = run.catch(() => {});
  return run;
}

// 转写之前:语音识别指着的是 toolbox 组件、而它这会儿没在跑(崩了／上次没起来)→ 就地再起一次,而不是让用户去重启如意。
async function ensureToolboxServiceForProvider(providerId) {
  const id = String(providerId || '');
  if (!id.startsWith('toolbox-')) return;
  const config = await readConfig();
  const component = enabledToolboxComponents(config).find(c => c.kind === 'service' && toolboxProviderId(c.id) === id);
  if (!component) return;
  const before = toolboxServices.get(component.id);
  const portBefore = before ? before.port : component.service.port;
  const entry = await startToolboxService(component).catch(() => null);
  if (entry && entry.state === 'running' && entry.port !== portBefore) await syncToolboxProviders().catch(() => {});
}

// /api/status 用的只读视图:设置页据此画「扩展组件」一栏。命令只给文件名(不给全路径、不给参数、不给 env)。
function toolboxStatusView(config) {
  const tb = (config && config.toolbox) || {};
  const disabled = new Set(Array.isArray(tb.disabled) ? tb.disabled : []);
  const components = scanToolboxComponents().map(c => {
    const entry = toolboxServices.get(c.id);
    const off = tb.autoDiscover === false || disabled.has(c.id);
    return {
      id: c.id, kind: c.kind, name: c.name, version: c.version, enabled: !off,
      provides: c.kind === 'service' ? c.provides.map(p => p.type) : ['mcp'],
      state: off ? 'disabled' : (c.kind === 'mcp' ? 'registered' : (entry ? entry.state : 'idle')),
      ...(c.kind === 'service' ? { port: entry ? entry.port : c.service.port, owned: Boolean(entry && entry.owned) } : {}),
      ...(entry && entry.error ? { error: entry.error, stderrTail: redact(entry.stderrTail).slice(-600) } : {}),
    };
  });
  return { autoDiscover: tb.autoDiscover !== false, components };
}
// 消费点经 04 的 ToolboxHooks 调进来(见那里的头注:本模块零入边)。
ToolboxHooks.reconcile = reconcileToolbox;
ToolboxHooks.stopAllSync = stopAllToolboxServicesSync;
ToolboxHooks.ensureForProvider = ensureToolboxServiceForProvider;
ToolboxHooks.statusView = toolboxStatusView;
