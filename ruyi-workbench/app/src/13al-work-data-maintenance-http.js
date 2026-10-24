// Cold worker progress transport only. Its caller proves parent death and current
// exclusive OS ownership. It neither opens the data root nor starts maintenance.
const WorkDataMaintenanceHttp = ((httpApi, cryptoApi) => {
  const ID = /^[a-f0-9]{48}$/, SHA = /^[a-f0-9]{64}$/;
  const fail = suffix => Object.assign(Error('work_data_setup.' + suffix), {code:'work_data_setup.' + suffix});
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
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
