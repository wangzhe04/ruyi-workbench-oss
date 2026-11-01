// Bounded diagnostic metadata only. No lifecycle authority or control message.
const DesktopLifetimeDiagnostic = (() => {
  const stages = new Set(["setup","begin","cancel","infrastructure","settlers","first-idle","first-helper-check","http-close","second-idle","second-helper-check","retire","retired","finished-request","deferred-request"]);
  const reasons = new Set(["unclassified","desktop_lifetime.uncertain","desktop_lifetime.helper_uncertain","desktop_lifetime.listener_changed","desktop_lifetime.channel_unavailable","desktop_lifetime.response_timeout","desktop_lifetime.owner_refused","desktop_lifetime.protocol","desktop_lifetime.channel_closed","desktop_lifetime.exit_returned","work_data.maintenance_busy","work_data.maintenance_nested","work_data.maintenance_cancelled","work_data.maintenance_stale_continuation","work_data.maintenance_owner_unavailable","work_data.maintenance_lease_expired","work_data.maintenance_not_idle","work_data.maintenance_infrastructure_unavailable","work_data.maintenance_infrastructure_uncertain"]);
  const names = new Set(['Error','TypeError','RangeError','SyntaxError','AbortError','TimeoutError']);
  let stage='setup',kind='close',seq=0,emitted=false;
  const own=(error,key)=>{try{const row=error&&Object.getOwnPropertyDescriptor(error,key);return row&&Object.hasOwn(row,'value')?row.value:undefined;}catch{return undefined;}};
  return Object.freeze({
    stage(value){if(stages.has(value))stage=value;},
    request(value,number){if(['close','finished','deferred'].includes(value))kind=value;seq=Number.isSafeInteger(number)&&number>=0&&number<=2147483647?number:0;},
    failure(error){
      if(emitted)return;emitted=true;
      const code=own(error,'code'),message=own(error,'message');let name=own(error,'name');
      if(!names.has(name))try{name=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error),'name')?.value;}catch{}
      if(!names.has(name))name='unknown';
      const reason=reasons.has(code)?code:reasons.has(message)?message:'unclassified';
      const marker='RUYI_DESKTOP_DIAG_V1 stage='+stage+' reason='+reason+' name='+name+' kind='+kind+' seq='+seq+'\n';
      try{fs.writeSync(2,marker);}catch{ /* Diagnostic output never replaces the original error. */ }
    },
  });
})();

// Private desktop lifetime transport. It conveys no data-root or maintenance authority.
const DesktopLifetime = (() => {
  const MAX_FRAME = 8192, HEX = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{48}$/;
  const fail = suffix => Object.assign(Error('desktop_lifetime.' + suffix), { code: 'desktop_lifetime.' + suffix });
  const shape = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === names.split(',').sort().join(',');
  const pipeName = value => typeof value==='string'&&/^ruyi-desktop-[a-f0-9]{64}$/.test(value);
  function descriptor(raw) {
    let value; try { value = typeof raw === 'string' && raw.length <= 1024 ? JSON.parse(raw) : null; } catch { throw fail('bootstrap_invalid'); }
    if (!shape(value, 'schema,pipe,cap,role') || value.schema !== 1 || !pipeName(value.pipe)
      || !HEX.test(value.cap) || !['serve', 'cold', 'successor'].includes(value.role)) throw fail('bootstrap_invalid');
    return Object.freeze({ ...value });
  }
  function create({ bootstrap, proc, connect, clock, stop }) {
    const config = descriptor(bootstrap), pending = new Map(), retained = new Set(), issued = new Map(), endpoints = new Set([config.pipe]);
    let socket = null, connected = null, sequence = 0, buffer = '', closing = false, active = false, stopPromise = null, unknownSet = false, unknown = null, holdAttempted = false;
    function retain(error) {
      if (!unknownSet) { unknownSet = true; unknown = error; }
      if (!holdAttempted) { holdAttempted = true; try { const hold = clock.setInterval(() => {}, 60000); hold?.ref?.(); retained.add(hold); }
        catch (error) { retained.add({ error, primary: unknown, socket }); } }
      for (const row of pending.values()) { clock.clearTimeout(row.timer); row.reject(unknown); } pending.clear();
      return unknown;
    }
    function send(value) {
      const bytes = Buffer.from(JSON.stringify(value) + '\n');
      if (bytes.length > MAX_FRAME || !socket || socket.destroyed) throw retain(fail('channel_unavailable'));
      socket.write(bytes, error => { if (error) retain(error); });
    }
    function request(kind, fields = {}) {
      if (unknownSet) return Promise.reject(unknown);
      const seq = ++sequence;
      if(closing&&(kind==='finished'||kind==='deferred')){DesktopLifetimeDiagnostic.stage(kind+'-request');DesktopLifetimeDiagnostic.request(kind,seq);}
      return new Promise((resolve, reject) => {
        const timer = clock.setTimeout(() => retain(fail('response_timeout')), 15000);
        pending.set(seq, { resolve, reject, timer, kind });
        try { send({ schema: 1, seq, kind, ...fields }); } catch (error) { retain(error); }
      });
    }
    function receive(value) {
      if (!value || typeof value !== 'object' || value.schema !== 1 || !Number.isSafeInteger(value.seq)) throw fail('protocol');
      if(shape(value,'schema,seq,kind')&&value.seq===0&&value.kind==='active'){
        if(active)throw fail('protocol');active=true;return;
      }
      if (shape(value, 'schema,seq,kind') && value.seq === 0 && value.kind === 'close') {
        closing = true;
        DesktopLifetimeDiagnostic.request('close',0);
        if (!stopPromise) stopPromise = Promise.resolve().then(stop).then(async result => {
          // A committed takeover keeps the same desktop request pending for the successor.
          if (result === false) { await request('deferred'); return; }
          await request('finished');
          proc.exit(0);
          throw fail('exit_returned');
        }).catch(error => { retain(error); DesktopLifetimeDiagnostic.failure(error); try { send({ schema: 1, seq: 0, kind: 'uncertain' }); } catch {} });
        return;
      }
      const row = pending.get(value.seq);
      if (!row || !(shape(value, 'schema,seq,kind') || row.kind === 'issue' && shape(value, 'schema,seq,kind,cap,pipe'))
        || !['ok', 'error'].includes(value.kind) || row.kind === 'issue' && value.kind === 'ok' && (!HEX.test(value.cap)||!pipeName(value.pipe)||endpoints.has(value.pipe)||issued.has(value.cap))) throw fail('protocol');
      if(row.kind==='issue'&&value.kind==='ok')endpoints.add(value.pipe);
      pending.delete(value.seq); clock.clearTimeout(row.timer);
      if (value.kind === 'error') row.reject(retain(fail('owner_refused'))); else row.resolve(value);
    }
    function open() {
      if (connected) return connected;
      connected = new Promise((resolve, reject) => {
        try { socket = connect('\\\\.\\pipe\\' + config.pipe); } catch (error) { reject(retain(error)); return; }
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
          try {
            buffer += chunk;
            let at;
            while ((at = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
              if (!line || line.includes('\r') || Buffer.byteLength(line) >= MAX_FRAME) throw fail('protocol');
              receive(JSON.parse(line));
            }
            if (Buffer.byteLength(buffer) >= MAX_FRAME) throw fail('frame_budget');
          } catch (error) { retain(error); socket.destroy(); }
        });
        socket.on('error', error => { reject(retain(error)); });
        socket.on('close', () => { reject(retain(fail('channel_closed'))); });
        // C# creates this unique role endpoint with FIRST_PIPE_INSTANCE and max=1
        // before publishing its descriptor, and never reopens its name. That
        // exclusive live endpoint authenticates the server before this bearer.
        socket.once('connect', () => { request('hello', { cap: config.cap, pid: proc.pid }).then(resolve, reject); });
      });
      return connected;
    }
    return Object.freeze({ open, role: config.role, active: () => active, closing: () => closing, unknown: () => unknownSet,
      async serving(listener) { await open(); if (!shape(listener, 'host,port') || !['127.0.0.1', '::1', 'localhost'].includes(listener.host)
        || !Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65535) throw retain(fail('listener_invalid'));
        return request('serving', listener); },
      async issue(role, id, nonce) { await open(); if(!active)throw fail('role_pending');if (!['cold', 'successor'].includes(role) || !ID.test(id) || !HEX.test(nonce)) throw fail('grant_invalid');
        const result = await request('issue', { role, id, nonce });
        const grant=Object.freeze({ schema: 1, pipe: result.pipe, cap: result.cap, role });issued.set(grant.cap,grant);return grant; },
      async transfer(grant) { if (!grant || issued.get(grant.cap)!==grant) throw fail('grant_invalid'); const result=await request('transfer', { cap: grant.cap });issued.delete(grant.cap);return result; },
      async reportUncertain(){await open();return request('uncertain');},
    });
  }
  return Object.freeze({ create, descriptor, MAX_FRAME });
})();

let desktopLifetimeClient = null, desktopLifetimeServer = null, desktopLifetimeStopping = false, desktopLifetimeFailure = null, desktopLifetimeFailureSet = false;
function desktopLifetimeAdmit() {
  if (desktopLifetimeStopping || desktopLifetimeFailureSet) throw Object.assign(Error('work_data.maintenance_busy'), { code: 'work_data.maintenance_busy', apiCode:'work_data.maintenance_busy', statusCode: 409 });
}
async function desktopLifetimeStopInfrastructure() {
  if (typeof ExternalBotHooks.stop === 'function') ExternalBotHooks.stop();
  if (typeof StewardHooks.stopInbox === 'function') StewardHooks.stopInbox();
  stopScheduler();
  const ticket=WorkDataMaintenanceHooks.prepareInfrastructure({normalClose:true});
  await WorkDataMaintenanceHooks.closeInfrastructure(ticket);
}
async function desktopLifetimeStop() {
  DesktopLifetimeDiagnostic.stage('setup');
  if(desktopLifetimeFailureSet||desktopLifetimeClient?.unknown())throw Error('desktop_lifetime.uncertain');
  desktopLifetimeStopping = true;
  // Setup serializes a pending submit/upload before cancelling its own uncommitted job.
  if (await WorkDataSetupHooks.closeForDesktop() === false) return false;
  DesktopLifetimeDiagnostic.stage('begin');
  const lease = WorkDataMaintenanceHooks.begin();
  const settlers = [...turnSettlers.values()];
  DesktopLifetimeDiagnostic.stage('cancel');
  for (const row of settlers) if (typeof row.cancel === 'function') row.cancel('shutdown');
  for (const [runId, row] of activeAgentRuns) await agentRunActionCommand({ sessionId: row.run.sessionId, runId, action: 'stop' });
  stopAllActiveTurnsSync('shutdown');
  DesktopLifetimeDiagnostic.stage('infrastructure');
  await desktopLifetimeStopInfrastructure();
  DesktopLifetimeDiagnostic.stage('settlers');
  await Promise.all(settlers.map(row => row.promise));
  DesktopLifetimeDiagnostic.stage('first-idle');
  await lease.idle();
  lease.assertIdle();
  DesktopLifetimeDiagnostic.stage('first-helper-check');
  if (LocalSecretCrypto.helperMayStillRun?.() !== false || MigrationHooks.helperMayStillRun?.() !== false
    || WorkDataMaintenanceRuntimeHooks.helperMayStillRun?.() !== false) throw Error('desktop_lifetime.helper_uncertain');
  DesktopLifetimeDiagnostic.stage('http-close');
  if (!desktopLifetimeServer?.listening) throw Error('desktop_lifetime.listener_changed');
  await new Promise((resolve, reject) => { desktopLifetimeServer.close(error => error ? reject(error) : resolve()); desktopLifetimeServer.closeAllConnections(); });
  DesktopLifetimeDiagnostic.stage('second-idle');
  await lease.idle();
  DesktopLifetimeDiagnostic.stage('second-helper-check');
  if (LocalSecretCrypto.helperMayStillRun?.() !== false || MigrationHooks.helperMayStillRun?.() !== false
    || WorkDataMaintenanceRuntimeHooks.helperMayStillRun?.() !== false) throw Error('desktop_lifetime.helper_uncertain');
  DesktopLifetimeDiagnostic.stage('retire');
  lease.assertIdle(); lease.retire();
  DesktopLifetimeDiagnostic.stage('retired');
  return true;
}
Object.assign(DesktopLifetimeHooks, {
  async connect() {
    if (desktopLifetimeBootstrap === null) return false;
    if (!desktopLifetimeClient) desktopLifetimeClient = DesktopLifetime.create({ bootstrap: desktopLifetimeBootstrap, proc: process,
      connect: name => require('node:net').createConnection(name), clock: { setTimeout, clearTimeout, setInterval },
      stop: () => desktopLifetimeStop().catch(error => { desktopLifetimeFailureSet = true; desktopLifetimeFailure = error; throw error; }) });
    await desktopLifetimeClient.open(); return true;
  },
  admit: desktopLifetimeAdmit,
  canAdmit:()=>!desktopLifetimeStopping&&!desktopLifetimeFailureSet&&desktopLifetimeClient?.unknown()!==true,
  normalCloseRequested:()=>desktopLifetimeStopping,
  closing: () => desktopLifetimeStopping||desktopLifetimeFailureSet,
  admissionOpen: () => !desktopLifetimeClient || desktopLifetimeClient.active(),
  helperMayStillRun: () => desktopLifetimeFailureSet || desktopLifetimeClient?.unknown() === true,
  async reportUncertain(){if(desktopLifetimeClient)await desktopLifetimeClient.reportUncertain();},
  capture({ server, listener }) { desktopLifetimeServer = server; desktopLifetimeServer.desktopListener = listener; },
  async serving() { if (desktopLifetimeClient) { if (!desktopLifetimeServer) throw Error('desktop_lifetime.listener_missing'); await desktopLifetimeClient.serving(desktopLifetimeServer.desktopListener); } },
  async issue(role, id, nonce) { return desktopLifetimeClient ? desktopLifetimeClient.issue(role, id, nonce) : null; },
  async transfer(grant) { if (grant) { if (!desktopLifetimeClient) throw Error('desktop_lifetime.owner_missing'); await desktopLifetimeClient.transfer(grant); } },
  environment(env, grant) {
    const clean={};for(const[key,value]of Object.entries(env))if(!['NODE_OPTIONS','NODE_PATH','NODE_DEBUG','NODE_DEBUG_NATIVE'].includes(key.toUpperCase())&&!/^RUYI_DESKTOP_CONTROL_/i.test(key))clean[key]=value;
    return grant ? { ...clean, RUYI_DESKTOP_CONTROL_V1: JSON.stringify(grant) } : clean;
  },
});
