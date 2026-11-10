// Isolated sealed-reader draft. The composition must supply the authenticated
// catalog authority. These leases grant plaintext access only, never deletion.
const WorkDataAttachmentReader = ((io, syncIo, nodePath, cryptoApi) => {
  const fill = Function.prototype.call.bind(Buffer.prototype.fill);
  const sha = value => cryptoApi.createHash('sha256').update(value).digest('hex');
  const proxy = value => require('node:util').types.isProxy(value);
  const fail = suffix => { throw Object.assign(Error('work_data_blob.' + suffix), { code:'work_data_blob.' + suffix, statusCode:409 }); };
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const sameFile = (a,b) => ['dev','ino','size','mtimeNs','ctimeNs'].every(key => a[key] === b[key]);
  const sameObject = (a,b) => a.dev === b.dev && a.ino === b.ino;
  const uncertainCloseErrors=new WeakSet();
  function cleanupFailure(primary, failed, errors, openUncertain = false) {
    const unknown=openUncertain || [primary,...errors].some(error => uncertainCloseErrors.has(error));
    const result=Object.assign(new AggregateError([...(failed ? [primary] : []), ...errors], 'work_data_blob.cleanup', { cause: failed ? primary : errors[0] }), {
      code:'work_data_blob.cleanup', cleanupFailed:true, ownershipRetained:true, resourceMayStillBeOpen:unknown,
    });
    if (unknown) uncertainCloseErrors.add(result);return result;
  }
  function cleared(bytes,work) {
    let result,failed=false,primary;const errors=[];
    try { result=work(); } catch (error) { failed=true;primary=error; }
    try { fill(bytes,0); } catch (error) { errors.push(error); }
    if (errors.length) throw cleanupFailure(primary,failed,errors);
    if (failed) throw primary;return result;
  }
  function descriptor(value) {
    const names=['opaque','revision','manifestSha256','manifestBytes','generation','purpose','scopeId','recordId'];
    if (!value || typeof value !== 'object' || proxy(value) || Array.isArray(value)) fail('selection');
    const ds=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(ds);
    if (keys.some(key => typeof key !== 'string') || keys.slice().sort().join(',') !== names.slice().sort().join(',')
      || keys.some(key => !Object.hasOwn(ds[key],'value'))) fail('selection');
    const selected=Object.fromEntries(names.map(key => [key,ds[key].value]));
    for (const key of ['opaque','revision']) if (typeof selected[key] !== 'string' || !/^[a-f0-9]{32}$/.test(selected[key])) fail('selection');
    if (typeof selected.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(selected.manifestSha256)
      || !Number.isSafeInteger(selected.manifestBytes) || selected.manifestBytes < 1 || selected.manifestBytes > WorkDataAttachmentChunks.MAX_CARRIER
      || !Number.isSafeInteger(selected.generation) || selected.generation < 1 || selected.generation > 99
      || !['session','cache'].includes(selected.purpose)) fail('selection');
    for (const key of ['scopeId','recordId']) if (typeof selected[key] !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(selected[key])) fail('selection');
    return Object.freeze(selected);
  }
  function create({root,keys,authority,maxReadBytes=8*1024*1024}={}) {
    if (typeof root !== 'string' || !nodePath.isAbsolute(root) || !keys || typeof keys.snapshot !== 'function'
      || !authority || ['capture','describe','assert'].some(name => typeof authority[name] !== 'function')
      || !Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > WorkDataAttachmentChunks.MAX_BYTES) fail('host');
    root=nodePath.resolve(root);
    const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
    function cancellation(signal) { if (signal !== undefined && aborted.call(signal)) fail('cancelled'); }
    async function directories(dir,check) {
      const parsed=nodePath.parse(dir),rows=[];let cursor=parsed.root;
      for (const part of ['',...dir.slice(parsed.root.length).split(nodePath.sep).filter(Boolean)]) {
        if (part) cursor=nodePath.join(cursor,part);check();
        const st=await io.lstat(cursor,{bigint:true});check();
        if (!st.isDirectory() || st.isSymbolicLink() || fold(await io.realpath(cursor)) !== fold(cursor)) fail('path');check();
        rows.push({path:cursor,stat:st});
      }
      return rows;
    }
    async function verifyDirectories(rows,check) {
      for (const row of rows) {
        check();const st=await io.lstat(row.path,{bigint:true});check();
        if (!st.isDirectory() || st.isSymbolicLink() || !sameObject(row.stat,st) || fold(await io.realpath(row.path)) !== fold(row.path)) fail('path');check();
      }
    }
    async function physical(file,expected,check,parents,witnesses) {
      let handle,bytes,visible,failed=false,primary;const errors=[];
      try {
        check();await verifyDirectories(parents,check);
        const before=await io.lstat(file,{bigint:true});check();
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(expected.bytes)
          || fold(await io.realpath(file)) !== fold(file)) fail('physical');check();
        handle=await io.open(file,'r');check();
        const held=await handle.stat({bigint:true});check();
        if (!held.isFile() || held.nlink !== 1n || !sameFile(before,held)) fail('physical');
        bytes=Buffer.alloc(expected.bytes);let position=0;
        while (position < bytes.length) {
          const read=await handle.read(bytes,position,bytes.length-position,position);check();
          if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead < 1 || read.bytesRead > bytes.length-position) fail('physical');
          position+=read.bytesRead;
        }
        const after=await handle.stat({bigint:true});check();
        if (!sameFile(held,after) || after.nlink !== 1n || sha(bytes) !== expected.sha256) fail('physical');
        visible=await io.lstat(file,{bigint:true});check();
        if (!visible.isFile() || visible.isSymbolicLink() || visible.nlink !== 1n || !sameFile(after,visible)) fail('physical');
        await verifyDirectories(parents,check);
      } catch (error) { failed=true;primary=error; }
      let openUncertain=false;
      if (handle) try { await handle.close(); } catch (error) { openUncertain=true;errors.push(error); }
      // A return is admitted only after actual FD close and a final authority check.
      if (!failed) try { check(); } catch (error) { failed=true;primary=error; }
      if (failed || errors.length) {
        if (bytes) try { fill(bytes,0); } catch (error) { errors.push(error); }
        if (errors.length) throw cleanupFailure(primary,failed,errors,openUncertain);throw primary;
      }
      witnesses?.push({path:file,stat:visible});
      return bytes;
    }
    function assertPhysical(parents,witnesses) {
      try {
        for (const {path,stat} of parents) {
          const current=syncIo.lstatSync(path,{bigint:true});
          if (!current.isDirectory() || current.isSymbolicLink() || !sameObject(stat,current)) fail('physical_changed');
        }
        for (const {path,stat} of witnesses) {
          const current=syncIo.lstatSync(path,{bigint:true});
          if (!current.isFile() || current.isSymbolicLink() || current.nlink!==1n || !sameFile(stat,current)) fail('physical_changed');
        }
      } catch (error) {
        if (error?.code==='work_data_blob.physical_changed') throw error;
        fail('physical_changed');
      }
    }
    async function census(dir,names,check) {
      let handle,failed=false,primary;const errors=[],actual=[];
      try {
        check();handle=await io.opendir(dir,{bufferSize:1});check();
        for (;;) {
          const entry=await handle.read();check();if (entry === null) break;
          if (typeof entry.name !== 'string' || entry.name.length > 64 || actual.length >= names.length) fail('namespace');
          actual.push(entry.name);
        }
        if (actual.slice().sort().join('\0') !== names.slice().sort().join('\0')) fail('namespace');
      } catch (error) { failed=true;primary=error; }
      if (handle) try { await handle.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw cleanupFailure(primary,failed,errors,true);
      if (failed) throw primary;check();
    }
    async function operation(id,signal,work,trackPhysical=false) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(id)) fail('id');cancellation(signal);
      const ticket=await authority.capture(id);cancellation(signal);
      const check=() => { cancellation(signal);if (authority.assert(ticket,id) !== true) fail('revoked'); };
      check();const selected=descriptor(authority.describe(ticket,id));check();
      let lease,manifest,result,failed=false,primary,assertCurrent=check;const errors=[];
      try {
        lease=await WorkDataStore.acquireSnapshot(keys);check();
        const binding={purpose:selected.purpose,instanceId:lease.instanceId,schema:1,scopeId:selected.scopeId,recordId:selected.recordId,seq:0,generation:selected.generation};
        const dir=nodePath.join(root,selected.opaque,selected.revision),parents=await directories(dir,check);
        const witnesses=trackPhysical ? [] : null;
        if (witnesses) assertCurrent=()=>{check();assertPhysical(parents,witnesses);};
        const data=await physical(nodePath.join(dir,'manifest.json'),{bytes:selected.manifestBytes,sha256:selected.manifestSha256},check,parents,witnesses);
        cleared(data,() => { manifest=WorkDataAttachmentChunks.openManifest({data,key:lease.key,binding,revision:selected.revision,maxBytes:WorkDataAttachmentChunks.MAX_BYTES}); });
        const names=['manifest.json',...Array.from({length:manifest.count},(_,index)=>WorkDataAttachmentChunks.partName(index))];
        await census(dir,names,check);
        const read=async ordinal => {
          const row=manifest.chunks[ordinal];let encrypted=await physical(nodePath.join(dir,WorkDataAttachmentChunks.partName(ordinal)),{bytes:row.physicalBytes,sha256:row.physicalSha256},check,parents,witnesses);
          let bytes,failed=false,primary;const errors=[];
          try { bytes=WorkDataAttachmentChunks.openChunk({manifest,ordinal,data:encrypted,key:lease.key});check(); }
          catch (error) { failed=true;primary=error; }
          try { fill(encrypted,0); } catch (error) { errors.push(error); } finally { encrypted=null; }
          if (failed || errors.length) {
            if (bytes) try { fill(bytes,0); } catch (error) { errors.push(error); }
            if (errors.length) throw cleanupFailure(primary,failed,errors);throw primary;
          }
          return bytes;
        };
        const sourceRevision=witnesses && (()=>sha(JSON.stringify([selected.opaque,selected.revision,selected.manifestSha256,
          witnesses.map(({stat})=>['dev','ino','size','mtimeNs','ctimeNs'].map(key=>String(stat[key])))])));
        result=await work({manifest,read,check,assertCurrent,sourceRevision});check();
        await census(dir,names,check);await verifyDirectories(parents,check);check();
      } catch (error) { failed=true;primary=error; }
      if (manifest) try { WorkDataAttachmentChunks.release(manifest); } catch (error) { errors.push(error); }
      if (lease) try { await lease.release(); } catch (error) { errors.push(error); }
      if (!failed && !errors.length) try { assertCurrent(); } catch (error) { failed=true;primary=error; }
      if (failed || errors.length) {
        if (result) try { result.release(); } catch (error) { errors.push(error); }
        if (errors.length) throw cleanupFailure(primary,failed,errors);throw primary;
      }
      return result;
    }
    function memoryLease(bytes,manifest,check,complete,sourceRevision) {
      const expected=sha(bytes);let released=false,cleanupCarrier;
      const release=() => {
        if (!released) { released=true;try { fill(bytes,0); } catch (error) { cleanupCarrier=cleanupFailure(undefined,false,[error]); } }
        if (cleanupCarrier) throw cleanupCarrier;
      };
      return Object.freeze({bytes,metadata:manifest.metadata,totalBytes:manifest.totalBytes,sha256:manifest.sha256,revision:manifest.revision,complete,
        ...(sourceRevision ? {sourceRevision} : {}),
        assert() { if (cleanupCarrier) throw cleanupCarrier;if (released) fail('released');try { check();if (sha(bytes) !== expected) fail('lease_changed');return true; } catch (primary) { try { release(); } catch (error) { throw cleanupFailure(primary,true,[error]); } throw primary; } },release});
    }
    async function readRange(id,start=0,end,{signal,originalName,sourceLimit}={}) {
      const guarded=originalName!==undefined;
      if (guarded && (!Number.isSafeInteger(sourceLimit) || sourceLimit<1)) fail('read_limit');
      const limit=guarded ? Math.min(sourceLimit,maxReadBytes) : maxReadBytes;
      return operation(id,signal,async({manifest,read,check,assertCurrent,sourceRevision}) => {
        if (end === undefined) end=manifest.totalBytes;
        if (guarded && (manifest.metadata.kind!=='original' || manifest.metadata.logicalName!==originalName
          || start!==0 || end!==manifest.totalBytes)) fail('source_mismatch');
        const indices=WorkDataAttachmentChunks.selectChunks(manifest,start,end);if (end-start > limit) fail('read_limit');
        let result=Buffer.alloc(end-start),written=0;const full=start===0&&end===manifest.totalBytes,digest=full?cryptoApi.createHash('sha256'):null;
        try {
          for (const ordinal of indices) {
            const bytes=await read(ordinal);
            cleared(bytes,() => { if (digest) digest.update(bytes);const offset=ordinal*WorkDataAttachmentChunks.CHUNK_BYTES,from=Math.max(0,start-offset),to=Math.min(bytes.length,end-offset);written+=bytes.copy(result,written,from,to);check(); });
          }
          if (written !== result.length || full&&digest.digest('hex') !== manifest.sha256) fail('whole_changed');
          assertCurrent();const lease=memoryLease(result,manifest,assertCurrent,full,sourceRevision?.());result=null;return lease;
        } catch (primary) { const errors=[];if (result) try { fill(result,0); } catch (error) { errors.push(error); }if (errors.length) throw cleanupFailure(primary,true,errors);throw primary; }
      },guarded);
    }
    async function verifyWhole(id,{signal}={}) {
      return operation(id,signal,async({manifest,read,check}) => {
        const digest=cryptoApi.createHash('sha256');let count=0;
        for (let ordinal=0;ordinal<manifest.count;ordinal++) { const bytes=await read(ordinal);cleared(bytes,() => { digest.update(bytes);count+=bytes.length;check(); }); }
        if (count !== manifest.totalBytes || digest.digest('hex') !== manifest.sha256) fail('whole_changed');
        // Metadata only. No filesystem/remove capability is attached to this value.
        return Object.freeze({verified:true,totalBytes:manifest.totalBytes,sha256:manifest.sha256,revision:manifest.revision,release(){}});
      });
    }
    return Object.freeze({readRange,verifyWhole});
  }
  return Object.freeze({create});
})(require('node:fs/promises'),require('node:fs'),require('node:path'),require('node:crypto'));
