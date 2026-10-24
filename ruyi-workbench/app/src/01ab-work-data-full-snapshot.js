// Full base snapshot host for a fresh, exclusively owned maintenance worker.
// No warm global paths/cache mutation; no source repair or implicit writer drain.
// Native original-object capsules and unresolved staging require their own owner.
const WorkDataFullSnapshot = ((io, p, cryptoApi, zlibApi) => {
  const fail = (suffix, details = {}) => { throw Object.assign(Error('work_data_full.' + suffix), {
    code: 'work_data_full.' + suffix, apiCode: 'work_data_full.' + suffix, statusCode: 409, ...details,
  }); };
  const hash = bytes => cryptoApi.createHash('sha256').update(bytes).digest('hex');
  const decode = bytes => { const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) fail('utf8_invalid'); return text; };
  const json = bytes => { try { return JSON.parse(decode(bytes)); } catch { fail('source_invalid'); } };
  const copy = value => JSON.parse(JSON.stringify(value));
  const workMarker = /"(?:w|\\u0077)(?:o|\\u006[fF])(?:r|\\u0072)(?:k|\\u006[bB])(?:D|\\u0044)(?:a|\\u0061)(?:t|\\u0074)(?:a|\\u0061)"\s*:/;
  const keyName = (purpose, id) => purpose + ':' + id;
  const ownerPath = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const keyOfPath = value => process.platform === 'win32' ? p.resolve(value).toUpperCase() : p.resolve(value);
  const PROFILE=Object.freeze({ordinaryFiles:'default-stream-bytes',directories:'names-only',nativeMetadata:'not-captured',
    nativeStreams:'not-enumerated; no full-native-backup claim',originalObjectCapsules:'special-owner-required',
    destinationSecurity:'fresh-target inherited defaults; no source ACL/SACL/aliases/object-ID replay'});
  const contains = (root, value) => { const rel = p.relative(keyOfPath(root), keyOfPath(value)); return rel === '' || rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel); };
  function namespace(relative) {
    const found = new RegExp('^\\.work-data/generations/([a-f0-9]{48})/(.+)$',process.platform==='win32'?'i':'').exec(relative);
    return found ? { prefix: '.work-data/generations/' + found[1] + '/', logical: found[2] } : { prefix: '', logical: relative };
  }
  function special(relative){const raw=namespace(relative).logical,logical=process.platform==='win32'?raw.toLowerCase():raw;
    const rootName=process.platform==='win32'?relative.toLowerCase():relative;
    if(rootName.startsWith('.work-data/generations/')&&!/^\.work-data\/generations\/[a-f0-9]{48}(?:\/|$)/.test(rootName))return 'control-owner-required';
    if(rootName!==logical&&(logical==='.work-data'||logical.startsWith('.work-data/')))return 'control-owner-required';
    if(logical.startsWith('.work-data/')&&logical!=='.work-data/generations'&&!logical.startsWith('.work-data/generations/')&&logical!=='.work-data/active-v1.json')return 'control-owner-required';
    if(/^migrations\/skill-backups(?:\/|$)|^\.work-data\/skill-backups(?:\/|$)|(?:^|\/)\.ruyi-capsule-v1$/.test(logical)
      ||/(?:\.corrupt(?:[.-]|$)|\.tmp(?:[.-]|$)|\.sealed-stage-|\.work-data-stage-|\.migration-codec-|(?:^|\/)\.ruyi-copy-)/.test(logical))return 'native-or-uncommitted-owner-required';
    return '';
  }
  function create({ base, ownership, assertExclusive, protector, externalOwner, skillBackupOwner, maintenanceResultOwner, limits = {} } = {}) {
    if (typeof base !== 'string' || !p.isAbsolute(base) || !ownership || !Array.isArray(ownership.roots)
        || !ownership.roots.some(root => keyOfPath(root) === keyOfPath(base)) || typeof assertExclusive !== 'function'
        || !protector || typeof protector.run !== 'function' || typeof protector.supported !== 'function'
        || typeof externalOwner !== 'function') fail('host_invalid');
    base = p.resolve(base);
    const tree = WorkDataTree.create(limits), recovery = WorkDataRecovery.create({ limits: Object.fromEntries(Object.entries(limits).filter(([key]) => ['bytes','files','directories'].includes(key))) });
    const admission = async () => { if (await assertExclusive(ownership) !== true) fail('ownership_required'); };
    const disposable = []; let busy = false;
    async function run(work) {
      if (busy) fail('busy'); busy = true;
      let failed=false;
      try { await admission(); return await work(); } catch(error){failed=true;throw error;}
      finally {let releaseFailed=false;for (const value of disposable.splice(0).reverse()) { try { await value.release?.(); value.clear?.(); } catch {releaseFailed=true;} }busy=false;if(!failed&&releaseFailed)fail('release_failed');}
    }
    function capturedVault(state, protectorApi, size) {
      return CredentialVault.create({ core: PrivacyCore, protector: protectorApi, size: async () => size,
        store: { read: async () => copy(state), write: async () => fail('source_write_forbidden'), invalidate() {} } });
    }
    function boundProtector(state, purpose, supplied) {
      if (!supplied) return protector;
      const id = keyName(purpose, state.instanceId), entry = supplied.get(id); if (!entry) fail('key_missing', { keyId: id });
      const domain = Buffer.from((purpose === 'work-data' ? 'ruyi.work-data.v1:' : 'ruyi.credential-vault.v1:') + state.instanceId);
      return { supported: () => true, run: async (op, bytes, entropy) => {
        if (op !== 'unprotect' || bytes.toString('base64') !== state.protectedKey || !entropy.equals(domain)) fail('source_write_forbidden');
        return Buffer.from(entry.master);
      } };
    }
    const lastResult = name => ownerPath(name)==='.work-data/maintenance-result-v1.json';
    function nativeSource(files,directories){if(typeof skillBackupOwner!=='function')return null;try{return recovery.skillBackupSource(files,directories);}catch(error){if(error?.code==='work_data_recovery.auxiliary_invalid')return null;throw error;}}
    async function analyze(files, auxiliaries, supplied, directories, native) {
      const masters = new Map(), headers = new Map(), vaults = new Map(), refs = new Map(), aux = [], domains = new Map(), resultFiles=new Set(), nativeFiles=new Set(native?.files.map(row=>row.path)||[]);let nativePlan=null;
      const addMaster = (purpose, state, lease) => {
        disposable.push(lease); const id = keyName(purpose, state.instanceId), previous = masters.get(id);
        if (previous && !cryptoApi.timingSafeEqual(previous.master, lease.key)) fail('key_collision');
        if (!previous) masters.set(id, { id, purpose, instanceId: state.instanceId, protectedKey: state.protectedKey, master: lease.key });
        return id;
      };
      const requireKey = (id, purpose, instance) => { const name = keyName(purpose, instance), value = masters.get(name); if (!value) fail('key_missing', { file: id }); refs.get(id).add(name); return value; };
      for (const file of files) {
        refs.set(file.path, new Set()); const logical = ownerPath(namespace(file.path).logical);
        if(lastResult(file.path)){if(typeof maintenanceResultOwner?.decode!=='function')fail('control_owner_required');maintenanceResultOwner.decode(file.data);resultFiles.add(file.path);continue;}
        if(special(file.path)){if(nativeFiles.has(file.path))continue;fail('special_owner_required',{file:file.path,reason:special(file.path)});}
        if (/^work-data-key-v1\.json(?:$|[.-])/.test(logical)) {
          const state = json(file.data); if (!WorkDataKeys.validate(state)) fail('key_header_invalid', { file: file.path });
          headers.set(file.path, { purpose: 'work-data', state });
          if (state.instanceId) {
            const keys = WorkDataKeys.create({ protector: boundProtector(state, 'work-data', supplied), enabled: () => false,
              store: { read: async () => copy(state), write: async () => fail('source_write_forbidden') } }); disposable.push(keys);
            refs.get(file.path).add(addMaster('work-data', state, await keys.snapshot()));
          }
        } else if (/^credential-vault-v1\.json(?:$|[.-])/.test(logical)) {
          const state = json(file.data); if (!CredentialVault.validate(state)) fail('vault_invalid', { file: file.path });
          const vault = capturedVault(state, boundProtector(state, 'credential', supplied), file.data.length); disposable.push(vault);
          const snapshot = await vault.snapshotForWorkDataRecovery(); headers.set(file.path, { purpose: 'credential', state });
          vaults.set(ownerPath(file.path), { vault, state });
          if (snapshot) refs.get(file.path).add(addMaster('credential', state, snapshot.lease));
        }
      }
      if (supplied && (supplied.size !== masters.size || [...supplied.keys()].some(id => !masters.has(id)))) fail('key_closure');
      const openedText = async (file, descriptor, data = file.data) => {
        const text = decode(data); let first; try { first = JSON.parse(text.split('\n',1)[0]); } catch {}
        let parsed; try { parsed = JSON.parse(text); } catch {}
        const marker = parsed && typeof parsed === 'object' && Object.hasOwn(parsed,'workData') ? parsed : first?.workData === 3 ? first : null;
        if (!marker) {
          if (text.trimStart().startsWith('{') && workMarker.test(text)) fail('carrier_invalid', { file: file.path });
          return text;
        }
        const key = requireKey(file.path,'work-data',marker.instanceId), match = /^work-data-v2\.k([1-9][0-9]?)$/.exec(marker.keyId || '');
        if (!match) fail('carrier_invalid');
        const binding = { purpose: descriptor.purpose, instanceId: key.instanceId, schema: descriptor.schema, scopeId: descriptor.scopeId,
          recordId: descriptor.recordId, seq: marker.workData === 3 ? 1 : marker.seq, generation: Number(match[1]) };
        if (marker.workData === 3) {
          if (!descriptor.chunked || !text.endsWith('\n')) fail('carrier_invalid');
          return WorkDataChunks.openLines((async function* () { for (const line of text.slice(0,-1).split('\n')) yield line; })(), key.master, binding, recovery.LIMITS.bytes);
        }
        if (marker.workData !== 2 || !parsed) fail('carrier_invalid');
        const { workData, ...container } = parsed; return WorkDataCrypto.open(container, key.master, binding);
      };
      const recordText = async (file, descriptor, data) => {
        const text = decode(data); if (!text) return '';
        if (!text.endsWith('\n')) fail('special_owner_required', { file: file.path, reason: 'uncommitted-journal-tail' });
        const result = [];
        for (const [ordinal,line] of text.slice(0,-1).split('\n').entries()) {
          if (!line.trim()) fail('special_owner_required', { file: file.path, reason:'blank-physical-journal-row' });
          const probe = WorkDataRecords.lineProbe(); probe.feed(Buffer.from(line)); let plain = line;
          if (probe.reserved()) {
            const row = JSON.parse(line), envelope = row.w === 3 ? row.h : row.e, key = requireKey(file.path,'work-data',envelope?.instanceId);
            const context = { instanceId:key.instanceId,sessionId:descriptor.scopeId,kind:descriptor.kind,runId:descriptor.runId,ordinal };
            plain = descriptor.codec === 'session-records' ? WorkDataRecords.decodeLine(line,key.master,context)
              : await WorkDataRecords.decodeRecordLine(line,key.master,context,recovery.LIMITS.bytes);
          }
          const value = JSON.parse(plain); if (!value || typeof value !== 'object' || Array.isArray(value)) fail('source_invalid'); result.push(plain);
        }
        return result.join('\n')+'\n';
      };
      if(native){
        const pointer=files.find(row=>ownerPath(row.path)==='.work-data/active-v1.json'),raw=pointer?decode(pointer.data):null,state=pointer?json(pointer.data):null,expected={id:state?.id||null,root:state? p.join(base,'.work-data','generations',state.id):base,generation:state?.generation||0,mode:state?.mode||'plain',proof:{raw,sha256:raw===null?null:hash(pointer.data)}};
        const forbidden={snapshot:async()=>fail('source_write_forbidden')},owner=await skillBackupOwner({base,readActive:async()=>expected,sourceKeys:forbidden,targetKeys:forbidden});
        if(!owner||['capturePortable','validatePortable','stagePortable','installPortable','verifyPortableInstalled'].some(name=>typeof owner[name]!=='function'))fail('special_owner_required');
        const readCaptured=async(file,descriptor)=>{const text=await openedText(file,descriptor),physical=decode(file.data);let first,value;try{first=JSON.parse(physical.split('\n',1)[0]);}catch{}try{value=JSON.parse(physical);}catch{}return{text,authenticated:value?.workData===2||first?.workData===3};};
        const request={files,directories,source:native,readCaptured,expected};let portable;
        if(supplied){const found=auxiliaries.filter(row=>row.type==='skill-backup-portable');if(found.length!==1||found[0].sourcePath!==native.sourcePath||found[0].sourceSha256!==native.sourceSha256)fail('auxiliary_closure');portable=found[0];await owner.validatePortable({...request,data:portable.data});}
        else{portable=await owner.capturePortable(request);disposable.push(portable);}
        aux.push({type:'skill-backup-portable',schema:1,sourcePath:native.sourcePath,sourceSha256:native.sourceSha256,data:portable.data});nativePlan={owner,request,portable};
      }
      for (const file of files) {
        if (headers.has(file.path)||nativeFiles.has(file.path)||resultFiles.has(file.path)) continue;
        const { prefix, logical } = namespace(file.path);
        if (/^external-bot-credentials\.json(?:$|[.-])/.test(ownerPath(logical))) {
          const owner = externalOwner({ file: p.join(base,...file.path.split('/')) }); let portable;
          if (supplied) {
            const found = auxiliaries.filter(row=>row.type==='external-bot-credentials'&&row.sourcePath===file.path);
            if (found.length!==1 || found[0].sourceSha256!==hash(file.data)) fail('auxiliary_missing'); portable=found[0].data;
          } else {
            const captured = await owner.snapshotForWorkDataRecovery(); disposable.push(captured);
            if (!captured.present || !captured.source.data.equals(file.data)) fail('source_changed'); portable=captured.portable;
          }
          aux.push({type:'external-bot-credentials',schema:1,sourcePath:file.path,sourceSha256:hash(file.data),data:portable}); continue;
        }
        const canonical = logical.replace(new RegExp('\\.prevbody$|\\.prev$',process.platform==='win32'?'i':''),''); let descriptor;
        try { descriptor = WorkDataMigrationCodecs.describe(canonical); }
        catch (error) { if (error.code!=='work_data_migration.path_unmapped') throw error; }
        let text, value;
        if (descriptor) {
          if (descriptor.codec==='special-owner-required') fail('special_owner_required',{file:file.path});
          if (descriptor.codec==='session-records'||descriptor.codec==='aux-records'&&!descriptor.archive) text=await recordText(file,descriptor,file.data);
          else if (descriptor.codec==='gzip'||descriptor.archive) {
            let compressed=file.data;
            if (!(compressed[0]===31&&compressed[1]===139&&compressed[2]===8)) {
              const outer=JSON.parse(await openedText(file,{...descriptor,chunked:true}));
              if (Object.keys(outer).sort().join(',')!=='data,encoding'||outer.encoding!=='gzip-base64-v1') fail('carrier_invalid');
              compressed=Buffer.from(outer.data,'base64'); if(compressed.toString('base64')!==outer.data)fail('carrier_invalid');
            }
            let inner;try{inner=zlibApi.gunzipSync(compressed,{maxOutputLength:recovery.LIMITS.bytes});text=descriptor.archive?await recordText(file,descriptor,inner):decode(inner);}
            finally{inner?.fill(0);if(compressed!==file.data)compressed.fill(0);}
          } else text=await openedText(file,descriptor);
          if (descriptor.codec==='text'&&!descriptor.markdown) { value=JSON.parse(text.replace(/^\uFEFF/,'')); if(!value||typeof value!=='object'||(descriptor.shape==='array'?!Array.isArray(value):Array.isArray(value)))fail('source_invalid'); }
        } else {
          try { text=decode(file.data); value=JSON.parse(text.replace(/^\uFEFF/,'')); } catch { /* Opaque media and arbitrary non-JSON user content remain exact bytes. */ }
          if(text!==undefined){const fullProbe=WorkDataRecords.lineProbe();fullProbe.feed(file.data);if(fullProbe.reserved()||text.trimStart().startsWith('{')&&workMarker.test(text))fail('special_owner_required',{file:file.path});}
          if(text!==undefined)for(const line of text.split('\n')){
            const probe=WorkDataRecords.lineProbe();probe.feed(Buffer.from(line));let first;try{first=JSON.parse(line);}catch{}
            if(probe.reserved()||first&&typeof first==='object'&&Object.hasOwn(first,'workData')
              ||line.trimStart().startsWith('{')&&workMarker.test(line))fail('special_owner_required',{file:file.path});
          }
          if (value && typeof value==='object' && (Object.hasOwn(value,'workData')||Object.hasOwn(value,'w')&&Object.hasOwn(value,'e')
              || WorkDataKeys.validate(value)&&value.instanceId || CredentialVault.validate(value)&&value.instanceId)) fail('special_owner_required',{file:file.path});
          if (/^privacy-scopes\/[a-f0-9]{64}\.json(?:\.[^/]+)?$/.test(ownerPath(logical))) {
            value=json(file.data); const key=requireKey(file.path,'credential',value.instanceId), recordId=ownerPath(logical).slice('privacy-scopes/'.length).split('.')[0];
            if(value.version!==1||!value.envelope)fail('privacy_mapping_invalid');
            const state=JSON.parse(PrivacyCore.open(value.envelope,key.master,{instanceId:key.instanceId,purpose:'privacy-mapping',recordId},'master-v1'));
            if(typeof state.scopeId!=='string'||hash(state.scopeId)!==recordId)fail('privacy_mapping_invalid');
            const scope=PrivacyCore.createScope({scopeId:state.scopeId,detector:{detect:()=>[]},ttlMs:365*86400000});try{scope.importState(state);}finally{scope.clear();}
          } else if (value?.version===1 && value.envelope && value.instanceId) fail('special_owner_required',{file:file.path});
        }
        if (value?.credentialRefsV1) {
          const candidate = vaults.get(ownerPath(prefix+'credential-vault-v1.json')); if(!candidate)fail('credential_reference_missing',{file:file.path});
          await candidate.vault.hydrateConfig(value); requireKey(file.path,'credential',candidate.state.instanceId);
        }
        domains.set(file.path,{family:descriptor?.family||'opaque-byte-file',logicalSha256: text===undefined?hash(file.data):hash(text)});
      }
      if (supplied && (aux.length!==auxiliaries.length || auxiliaries.some(row=>!aux.some(found=>found.sourcePath===row.sourcePath))))fail('auxiliary_closure');
      return {masters,headers,aux,domains,nativePlan,files:files.map(file=>({path:file.path,data:file.data,keyRefs:[...refs.get(file.path)].sort()}))};
    }
    function checkAuthority(files,directories,generation,native){
      for(const directory of directories)if(special(directory)&&!native?.directories.includes(directory))fail('special_owner_required',{file:directory,reason:special(directory)});
      if(files.some(file=>{const name=process.platform==='win32'?file.path.toLowerCase():file.path;return name==='.work-data'||name==='.work-data/generations'||/^\.work-data\/generations\/[a-f0-9]{48}$/.test(name);})||directories.some(directory=>keyOfPath(directory)===keyOfPath('.work-data/active-v1.json')))fail('authority_mismatch');
      const pointer=files.find(file=>keyOfPath(file.path)===keyOfPath('.work-data/active-v1.json'));
      if(!pointer){if(generation!==0)fail('authority_mismatch');return;}
      const value=json(pointer.data);
      if(!value||Object.keys(value).sort().join(',')!=='activeRoot,generation,id,mode,schema'||value.schema!==1
        ||!Number.isSafeInteger(value.generation)||value.generation<1||value.generation!==generation
        ||!/^[a-f0-9]{48}$/.test(value.id||'')||!['plain','encrypted'].includes(value.mode)
        ||value.activeRoot!=='generations/'+value.id||!directories.some(relative=>keyOfPath(relative)===keyOfPath('.work-data/'+value.activeRoot)))fail('authority_mismatch');
      if(value.mode==='encrypted'&&!files.some(file=>keyOfPath(file.path)===keyOfPath('.work-data/'+value.activeRoot+'/work-data-key-v1.json')&&json(file.data).instanceId))fail('key_missing');
    }
    async function seal({ password, appVersion, generation, createdAt=new Date().toISOString() }={}) {
      return run(async()=>{
        const captured=await tree.capture(base);disposable.push(captured);
        const native=nativeSource(captured.files,captured.directories);checkAuthority(captured.files,captured.directories,generation,native);
        const analyzed=await analyze(captured.files,[],null,captured.directories,native);await admission();await tree.verify(captured);
        const serialized=await recovery.seal({appVersion,generation,createdAt,directories:[...captured.directories],keys:[...analyzed.masters.values()],files:analyzed.files,auxiliaries:analyzed.aux},password);
        await admission();const proof=await tree.verify(captured);
        const sourceIdentity=async relative=>{const stat=await io.lstat(p.join(base,...relative.split('/')),{bigint:true});return Object.freeze({path:relative,identity:String(stat.dev)+':'+String(stat.ino),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs)});};
        const sourceFiles=[];for(const file of captured.files)sourceFiles.push(Object.freeze({...await sourceIdentity(file.path),sha256:file.sha256}));
        const sourceDirectories=[];for(const relative of ['',...captured.directories])sourceDirectories.push(await sourceIdentity(relative));await tree.verify(captured);
        // Source proof ends here. Caller-owned additions may be written only after this return.
        // No glob exclusions or permission to ignore later source changes is issued.
        return Object.freeze({serialized,sourceProof:proof,sourceFiles:Object.freeze(sourceFiles),sourceDirectories:Object.freeze(sourceDirectories),
          profile:PROFILE,specialCoverage:analyzed.nativePlan?Object.freeze({type:'skill-backup-portable',sourcePath:analyzed.nativePlan.request.source.sourcePath,sourceSha256:analyzed.nativePlan.request.source.sourceSha256,originalObjects:'refused',terminalSnapshots:'source-history-only'}):null,keyIds:Object.freeze([...analyzed.masters.keys()]),files:captured.files.length,directories:captured.directories.length});
      });
    }
    async function realDirectory(directory) {
      const absolute=p.resolve(directory),parsed=p.parse(absolute);let current=parsed.root;
      for(const part of ['',...absolute.slice(parsed.root.length).split(p.sep).filter(Boolean)]){if(part)current=p.join(current,part);const stat=await io.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink()||keyOfPath(await io.realpath(current))!==keyOfPath(current))fail('target_alias');}
    }
    async function restore({ serialized,password,target,targetOwnership=ownership }={}) {
      return run(async()=>{
        if(typeof target!=='string'||!p.isAbsolute(target)||contains(base,target)||contains(target,base))fail('target_invalid');
        target=p.resolve(target);
        const targetAdmission=async()=>{await admission();if(!targetOwnership||!Array.isArray(targetOwnership.roots)||!targetOwnership.roots.some(root=>keyOfPath(root)===keyOfPath(target))||await assertExclusive(targetOwnership)!==true)fail('target_ownership_required');};
        await targetAdmission();await realDirectory(p.dirname(target));
        const absent=async()=>{try{await io.lstat(target);}catch(error){if(error.code==='ENOENT')return;throw error;}fail('target_exists');};await absent();
        const opened=await recovery.open(serialized,password);disposable.push(opened);const snapshot=opened.snapshot,supplied=new Map(snapshot.keys.map(key=>[key.id,key]));
        const native=nativeSource(snapshot.files,snapshot.directories);checkAuthority(snapshot.files,snapshot.directories,snapshot.generation,native);
        const analyzed=await analyze(snapshot.files,snapshot.auxiliaries,supplied,snapshot.directories,native);
        for(const file of snapshot.files){const expected=analyzed.files.find(row=>row.path===file.path);if(JSON.stringify([...file.keyRefs].sort())!==JSON.stringify(expected.keyRefs))fail('key_reference_mismatch',{file:file.path});}
        const replacements=new Map();disposable.push({release(){for(const bytes of replacements.values())bytes.fill(0);}});
        for(const [file,header]of analyzed.headers){if(!header.state.instanceId)continue;const key=analyzed.masters.get(keyName(header.purpose,header.state.instanceId));let result;
          if(header.purpose==='work-data'){
            const targetKeys=WorkDataKeys.create({protector,store:{read:async()=>fail('source_write_forbidden')},enabled:()=>false});disposable.push(targetKeys);
            result=await targetKeys.stageRecovered({instanceId:key.instanceId,key:key.master});disposable.push(result.lease);replacements.set(file,Buffer.from(JSON.stringify(result.header)));
          }else{
            const vault=capturedVault(header.state,protector,0);disposable.push(vault);result=await vault.stageRecoveredForWorkData({state:header.state,key:key.master});disposable.push(result.lease);replacements.set(file,Buffer.from(JSON.stringify(result.state)));
          }
        }
        for(const row of analyzed.aux.filter(row=>row.type==='external-bot-credentials')){const source=snapshot.files.find(file=>file.path===row.sourcePath),owner=externalOwner({file:p.join(target,...row.sourcePath.split('/'))});
          const result=await owner.stageRecoveredForWorkData({state:json(source.data),portable:row.data});replacements.set(row.sourcePath,Buffer.from(JSON.stringify(result.state)));
        }
        let nativeStage=null;
        const nativeProof=proof=>{if(!proof||proof.target!==target||proof.readOnly!==true||proof.originalObjects!=='refused'||proof.terminalSnapshots!=='source-history-only')fail('special_owner_proof');return proof;};
        if(analyzed.nativePlan){const plan=analyzed.nativePlan,keysFor=async relative=>{const file=snapshot.files.find(row=>row.path===relative);if(!file)fail('key_missing');const text=decode(file.data);let marker;try{marker=JSON.parse(text.split('\n',1)[0]);}catch{}if(!marker)try{marker=JSON.parse(text);}catch{}const key=analyzed.masters.get(keyName('work-data',marker?.instanceId));if(!key)fail('key_missing');return{snapshot:async()=>{const bytes=Buffer.from(key.master);return{key:bytes,instanceId:key.instanceId,release(){bytes.fill(0);}};}};};
          nativeStage=await plan.owner.stagePortable({...plan.request,data:plan.portable.data,target,keysFor,assertTargetExclusive:async()=>{await targetAdmission();return true;}});disposable.push(nativeStage);
          for(const row of nativeStage.files){if(replacements.has(row.path))fail('special_owner_conflict');replacements.set(row.path,Buffer.from(row.data));}
        }
        const skipDirectory=name=>nativeStage?.skipDirectories.some(root=>ownerPath(name)===ownerPath(root)||ownerPath(name).startsWith(ownerPath(root)+'/'))===true;
        // Every source/master/reference/auxiliary validation and native roundtrip precedes mkdir.
        await targetAdmission();await absent();let created=false;
        try{
          await io.mkdir(target,{mode:0o700});created=true;await realDirectory(target);
          for(const relative of [...snapshot.directories].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b))){if(skipDirectory(relative))continue;await io.mkdir(p.join(target,...relative.split('/')),{mode:0o700});}
          for(const file of snapshot.files){if(nativeStage?.skipFiles.includes(file.path))continue;const destination=p.join(target,...file.path.split('/')),data=replacements.get(file.path)||file.data;await realDirectory(p.dirname(destination));
            const handle=await io.open(destination,'wx',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
          }
          if(nativeStage){const stat=await io.lstat(target,{bigint:true});nativeProof(await analyzed.nativePlan.owner.installPortable(nativeStage,{targetIdentity:{dev:String(stat.dev),ino:String(stat.ino)}}));}
          const verified=await tree.capture(target);disposable.push(verified);if(verified.files.length!==snapshot.files.length||verified.directories.length!==snapshot.directories.length)fail('target_verification');
          if(JSON.stringify([...verified.directories].sort())!==JSON.stringify([...snapshot.directories].sort()))fail('target_verification');
          const actual=new Map(verified.files.map(file=>[file.path,file]));for(const file of snapshot.files)if(actual.get(file.path)?.sha256!==hash(replacements.get(file.path)||file.data))fail('target_verification');
          const stagedStates=Object.freeze([...replacements].map(([relative,bytes])=>Object.freeze({path:relative,sourceSha256:hash(snapshot.files.find(file=>file.path===relative).data),stagedSha256:hash(bytes)})));
          if(nativeStage)nativeProof(await analyzed.nativePlan.owner.verifyPortableInstalled(nativeStage));
          await targetAdmission();return Object.freeze({target,files:snapshot.files.length,directories:snapshot.directories.length,manifestSha256:opened.manifestSha256,stagedStates,profile:PROFILE,
            mode:'restored-full-base',publication:'fresh-process-required',nativeMetadata:nativeStage?'new-default-files plus verified new native store identity; original-object-capsules-refused':'new-default-files; original-object-capsules-require-special-owner',specialProfile:nativeStage?.profile||null});
        }catch(cause){fail('restore_failed',{cause,targetRetained:created});}
      });
    }
    return Object.freeze({seal,restore});
  }
  return Object.freeze({create});
})(require('node:fs/promises'),require('node:path'),require('node:crypto'),require('node:zlib'));
