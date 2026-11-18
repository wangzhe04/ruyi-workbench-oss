// Cold worker progress transport only. Its caller proves parent death and current
// exclusive OS ownership. It neither opens the data root nor starts maintenance.
const WorkDataMaintenanceHttp = ((httpApi, cryptoApi) => {
  const ID = /^[a-f0-9]{48}$/, SHA = /^[a-f0-9]{64}$/;
  const fail = suffix => Object.assign(Error('work_data_setup.' + suffix), {code:'work_data_setup.' + suffix});
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  // 维护页的全部文字都是这里的常量；插进页面的只有这两张表按枚举键取出的值，没有任何来自请求或状态文件的字符串。
  const PAGE_OPERATION = {enable:['启用工作数据加密','Turning on work data encryption'],disable:['转为明文存储','Switching work data to plain-text storage'],
    export:['导出完整恢复包','Exporting a full recovery package'],restore:['恢复到新目录','Restoring work data to a new folder']};
  const PAGE_STATE = {
    handoff:['工作台正在交接给新进程。请稍候，不要关闭如意；新的工作台就绪后，这一页会自动回到正常界面。若超过几分钟仍停在这里，请完全退出并重新启动如意。',
      'Ruyi is handing off to a new process. Please wait and keep Ruyi open; this page returns to the normal workspace once the new process is ready. If it stays here for more than a few minutes, quit Ruyi completely and start it again.'],
    uncertain:['操作结果尚未确认。请完全退出并重新启动如意，启动后在设置的「工作数据加密与迁移」中核对当前数据根；不要重复提交同一操作。',
      'The result of the operation is not confirmed yet. Quit Ruyi completely and start it again, then check the current data root under Settings, Work data encryption and migration. Do not submit the same operation again.'],
    failed:['维护操作没有完成，这个维护进程不会再继续。请完全退出并重新启动如意，启动后在设置的「工作数据加密与迁移」中核对当前数据根；不要重复提交同一操作。',
      'The maintenance operation did not finish and this maintenance process will not continue. Quit Ruyi completely and start it again, then check the current data root under Settings, Work data encryption and migration. Do not submit the same operation again.'],
    unknown:['暂时读不到维护进度。请稍候，这一页会自动刷新；长时间没有变化时，请完全退出并重新启动如意。',
      'Maintenance progress cannot be read right now. Please wait, this page refreshes by itself; if nothing changes for a long time, quit Ruyi completely and start it again.']};
  function maintenancePage(operation, jobState) {
    const op = Object.hasOwn(PAGE_OPERATION, operation || '') ? PAGE_OPERATION[operation] : ['工作数据维护','Work data maintenance'];
    const help = Object.hasOwn(PAGE_STATE, jobState || '') ? PAGE_STATE[jobState] : PAGE_STATE.unknown;
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<meta http-equiv="refresh" content="10"><title>如意 · 维护中 / Ruyi maintenance</title>'
      + '<style>body{margin:0;font:15px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#1d2430}'
      + 'main{max-width:640px;margin:10vh auto;padding:24px 28px;background:#fff;border:1px solid #d9dde5;border-radius:10px}'
      + 'h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:20px 0 8px}p{margin:8px 0}section+section{border-top:1px solid #e3e6ec;margin-top:20px}'
      + '@media (prefers-color-scheme:dark){body{background:#11161f;color:#e6e9ef}main{background:#1a2230;border-color:#33425e}section+section{border-color:#33425e}}</style></head><body><main>'
      + '<section lang="zh-CN"><h1>如意正在进行工作数据维护</h1><p>正在进行：' + op[0] + '。</p><p>' + help[0] + '</p>'
      + '<p>维护期间不能发送消息或修改设置。这一页每 10 秒自动刷新一次。</p></section>'
      + '<section lang="en"><h2>Ruyi is running work data maintenance</h2><p>In progress: ' + op[1] + '.</p><p>' + help[1] + '</p>'
      + '<p>Messages and settings are unavailable during maintenance. This page refreshes every 10 seconds.</p></section>'
      + '</main></body></html>';
  }
  function authority(value) {
    if (!object(value) || !Number.isSafeInteger(value.generation) || value.generation < 0 || !['plain','encrypted'].includes(value.mode)
      || (value.generation === 0 ? value.id !== null || value.sha256 !== null : !ID.test(value.id || '') || !SHA.test(value.sha256 || ''))) throw fail('status_unavailable');
    return {generation:value.generation,id:value.id,mode:value.mode,sha256:value.sha256};
  }
  function create(host) {
    if (!host || typeof host.id !== 'string' || !ID.test(host.id) || !Number.isInteger(host.port) || host.port < 1 || host.port > 65535
      || host.bindHost !== undefined && !['127.0.0.1','::1','localhost'].includes(host.bindHost)
      || typeof host.assertColdOwner !== 'function' || typeof host.readStatus !== 'function') throw fail('http_host_invalid');
    // Capture identity before any callback. No mutable caller field selects a route.
    const id = host.id, port = host.port, bindHost = host.bindHost === undefined ? '127.0.0.1' : host.bindHost;
    const assertColdOwner = host.assertColdOwner, readStatus = host.readStatus;
    const token = cryptoApi.randomBytes(32), sockets = new Set();
    let state = 'new', starting = null, closing = null;
    const assertOwner = () => {if (assertColdOwner() !== true) throw fail('ownership_required');};
    const snapshot = () => {
      const value = readStatus();
      if (!object(value) || !object(value.job)) throw fail('status_unavailable');
      const source = value.job;
      if (source.id !== id || !['enable','disable','export','restore'].includes(source.operation)
        || !['handoff','uncertain','failed'].includes(source.state) || !Number.isSafeInteger(source.createdAt) || source.createdAt < 0
        || source.phase !== undefined && (typeof source.phase !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(source.phase))
        || source.error != null && (typeof source.error !== 'string' || !/^work_data(?:_[a-z0-9]+)*\.[a-z0-9_.-]{1,96}$/.test(source.error))
        || source.backupPath != null && (typeof source.backupPath !== 'string' || !source.backupPath.length || source.backupPath.length > 4096 || /[\0\r\n]/.test(source.backupPath))) throw fail('status_unavailable');
      const job = {id,operation:source.operation,state:source.state,createdAt:source.createdAt,cancellable:false,takeover:true,retry:false,
        error:source.error || null,operationMayHaveExecuted:true};
      if (source.phase !== undefined) job.phase = source.phase;
      if (source.backupPath != null) job.backupPath = source.backupPath;
      return {ok:true,authority:authority(value.authority),configMirror:null,maintenance:{phase:'retired',accepting:false},job,lastResult:null,
        capabilities:{worker:false,upload:false,download:false},processRestartRequired:true};
    };
    function send(res, status, value) {
      if (res.destroyed || state !== 'listening') return;
      const body = JSON.stringify(value);
      res.writeHead(status, {'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),
        'cache-control':'no-store','x-content-type-options':'nosniff','connection':'close'});
      res.end(body);
    }
    const denied = (res,status,code) => send(res,status,{ok:false,error:{code},retry:false});
    // 151 阶段 1 · U3/W10：交接期刷新页面，修前浏览器只拿到 403 auth.token_invalid 的 JSON。现在 GET/HEAD / 回一页
    // 静态、无脚本、中英双语的「维护中」页：只读已校验的 operation/state 两个枚举（读不到就给通用版），不含令牌、
    // 备份路径、错误码或任何数据路径；鉴权不变 —— 仍先过 Host/Origin/Sec-Fetch 与请求体检查，页面本身不发令牌。
    function sendPage(res, method) {
      if (res.destroyed || state !== 'listening') return;
      let view = null;
      // 只取 operation/state 两个枚举（maintenancePage 按白名单查表），不依赖 authority 校验：hold/preflight 失败时
      // current 会被置空，若走 snapshot() 就只能显示「读不到进度」而不是「失败，请重启」（1D 审查）。
      try {assertOwner();const raw = readStatus();view = object(raw) && object(raw.job) ? raw.job : null;} catch {view = null;}
      const body = maintenancePage(view ? view.operation : null, view ? view.state : null);
      res.writeHead(503, {'content-type':'text/html; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store',
        'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'x-frame-options':'DENY','referrer-policy':'no-referrer','retry-after':'10','connection':'close'});
      res.end(method === 'HEAD' ? undefined : body);
    }
    function request(req,res) {
      try {
        assertOwner();
        const peer = String(req.socket.remoteAddress || '').toLowerCase();
        const name = req.headers.host;
        if (!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(peer)
          || typeof name !== 'string' || ![`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`].includes(name.toLowerCase())) return denied(res,403,'auth.host_invalid');
        if (req.headers.origin !== undefined) {
          let origin;
          try {origin = new URL(req.headers.origin);} catch {return denied(res,403,'auth.origin_invalid');}
          if (origin.protocol !== 'http:' || origin.host.toLowerCase() !== name.toLowerCase() || origin.origin !== req.headers.origin) return denied(res,403,'auth.origin_invalid');
        }
        if (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])) return denied(res,403,'auth.origin_invalid');
        // No route consumes a body. Reject before attaching data listeners, so an
        // unexpected upload cannot consume memory or trigger any base operation.
        if (req.headers['transfer-encoding'] !== undefined || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0') return denied(res,413,'work_data_setup.body_not_allowed');
        if (req.url === '/health' && req.method === 'GET') return send(res,200,{ok:true,maintenance:true,ready:false});
        if ((req.url === '/' || req.url === '/index.html') && (req.method === 'GET' || req.method === 'HEAD')) return sendPage(res,req.method);
        if (req.url === '/api/bootstrap' && req.method === 'POST') return send(res,200,{ok:true,token:token.toString('hex')});
        const candidate = req.headers['x-wcw-token'];
        const bytes = typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate) ? Buffer.from(candidate,'hex') : Buffer.alloc(0);
        if (bytes.length !== token.length || !cryptoApi.timingSafeEqual(bytes,token)) return denied(res,403,'auth.token_invalid');
        if (req.method !== 'GET') return denied(res,409,'work_data_setup.takeover_committed');
        if (req.url !== '/api/work-data/status' && req.url !== '/api/work-data/jobs/' + id) return denied(res,404,'work_data_setup.job_not_found');
        const result = snapshot();assertOwner();
        return send(res,200,req.url === '/api/work-data/status' ? result : {ok:true,job:result.job});
      } catch {return denied(res,503,'work_data_setup.status_unavailable');}
    }
    const server = httpApi.createServer({maxHeaderSize:16384,requestTimeout:5000,headersTimeout:5000},request);
    server.on('connection', socket => {sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
    server.on('clientError', (_error,socket) => socket.destroy());
    async function close() {
      if (closing) return closing;
      state = 'closed';token.fill(0);
      closing = (async()=>{
        if (starting) {try {await starting;} catch { /* Failed bind owns no listener. */ }}
        for (const socket of sockets) socket.destroy();
        if (!server.listening) return;
        await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
      })();
      return closing;
    }
    function listen() {
      if (state !== 'new') return Promise.reject(fail('http_already_started'));
      try {assertOwner();} catch(error) {return Promise.reject(error);}
      state = 'starting';
      starting = new Promise((resolve,reject)=>{
        const failed = error => {server.removeListener('listening',ready);if(state!=='closed')state='failed';reject(error);};
        const ready = () => {
          server.removeListener('error',failed);
          if (state === 'closed') return resolve();
          try {assertOwner();state='listening';resolve();}
          catch(error) {state='failed';server.close(()=>reject(error));}
        };
        server.once('error',failed);server.once('listening',ready);
        server.listen({host:bindHost,port,exclusive:true});
      });
      return starting;
    }
    return Object.freeze({listen,close});
  }
  return Object.freeze({create});
})(http,crypto);
