// A bounded completion record is metadata, never manifest authority. Snapshot
// decoding is pure; normal readback separately verifies the actual backup and
// current manifest. Only the cold owner with an issued durable backup can write.
const WorkDataMaintenanceResult = ((io,p,c) => {
  const NAME='maintenance-result-v1.json',STAGE='.maintenance-result-v1.stage-',LIMIT=16384,ID=/^[a-f0-9]{48}$/,SHA=/^[a-f0-9]{64}$/;
  const fail=suffix=>Object.assign(Error('work_data_result.'+suffix),{code:'work_data_result.'+suffix,apiCode:'work_data_result.'+suffix,statusCode:409,retry:false});
  const keys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().join(','):'';
  const fold=value=>process.platform==='win32'?value.toLowerCase():value;
  const absolute=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\0\r\n]/.test(value)
    &&Buffer.from(value).toString('utf8')===value&&p.isAbsolute(value)&&p.resolve(value)===value;
  const inside=(root,file)=>{const rel=p.relative(fold(root),fold(file));return rel===''||rel!=='..'&&!rel.startsWith('..'+p.sep)&&!p.isAbsolute(rel);};
  const hash=bytes=>c.createHash('sha256').update(bytes).digest('hex');
  const identity=stat=>({dev:String(stat.dev),ino:String(stat.ino)});
  const sameIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
  const authority=value=>keys(value)==='generation,id,mode,sha256'&&Number.isSafeInteger(value.generation)&&value.generation>=0
    &&['plain','encrypted'].includes(value.mode)&&(value.generation===0?value.id===null&&value.sha256===null:ID.test(value.id||'')&&SHA.test(value.sha256||''));
  const sameAuthority=(a,b)=>a.generation===b.generation&&a.id===b.id&&a.mode===b.mode&&a.sha256===b.sha256;
  function validate(value) {
    try {
      const restore=value?.operation==='restore';
      if(keys(value)!==(restore?'authority,backup,finishedAt,id,operation,restored,schema,sourceAuthority,state':'authority,backup,finishedAt,id,operation,schema,sourceAuthority,state')
        ||value.schema!==1||typeof value.id!=='string'||!ID.test(value.id)||!['enable','disable','export','restore'].includes(value.operation)
        ||typeof value.finishedAt!=='string'||new Date(value.finishedAt).toISOString()!==value.finishedAt||!authority(value.sourceAuthority)||!authority(value.authority)
        ||keys(value.backup)!=='bytes,identity,path,sha256'||!absolute(value.backup.path)||!SHA.test(value.backup.sha256||'')
        ||!Number.isSafeInteger(value.backup.bytes)||value.backup.bytes<1||value.backup.bytes>1024*1024*1024
        ||keys(value.backup.identity)!=='dev,ino'||!['dev','ino'].every(name=>typeof value.backup.identity[name]==='string'&&/^\d{1,40}$/.test(value.backup.identity[name]))
        ||p.basename(value.backup.path)!=='ruyi-work-data-'+value.id+'.ruyi-backup') return false;
      if(['enable','disable'].includes(value.operation)){
        if(value.state!=='published'||value.authority.generation!==value.sourceAuthority.generation+1
          ||value.authority.mode!==(value.operation==='enable'?'encrypted':'plain')||value.sourceAuthority.mode===value.authority.mode) return false;
      } else if(value.state!=='verified'||!sameAuthority(value.sourceAuthority,value.authority)) return false;
      if(restore&&(keys(value.restored)!=='activation,target'||value.restored.activation!=='separate-fresh-root'||!absolute(value.restored.target))) return false;
      return true;
    } catch {return false;}
  }
  const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
  function decode(bytes) {
    if(!Buffer.isBuffer(bytes)||bytes.length>LIMIT)throw fail('record_invalid');
    try {const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))throw fail('record_invalid');const value=JSON.parse(text);if(!validate(value))throw fail('record_invalid');return freeze(value);}
    catch {throw fail('record_invalid');}
  }
  async function directory(root,missing=false) {
    const parsed=p.parse(root);let cursor=parsed.root;
    for(const part of ['',...root.slice(parsed.root.length).split(p.sep).filter(Boolean)]){
      if(part)cursor=p.join(cursor,part);let stat;
      try {stat=await io.lstat(cursor);}catch(error){if(missing&&error.code==='ENOENT')return false;throw error;}
      if(!stat.isDirectory()||stat.isSymbolicLink()||fold(await io.realpath(cursor))!==fold(cursor))throw fail('path_alias');
    }return true;
  }
  async function capture(file,maximum,retain) {
    await directory(p.dirname(file));const before=await io.lstat(file,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size>BigInt(maximum))throw fail('record_changed');
    const handle=await io.open(file,'r'),digest=c.createHash('sha256'),chunks=[],scratch=Buffer.alloc(65536);let count=0;
    try {
      const opened=await handle.stat({bigint:true});if(!sameIdentity(identity(opened),identity(before))||!opened.isFile()||opened.nlink!==1n)throw fail('record_changed');
      for(;;){const part=await handle.read(scratch,0,Math.min(scratch.length,maximum-count+1),null);if(!part.bytesRead)break;
        count+=part.bytesRead;if(count>maximum)throw fail('record_changed');const bytes=scratch.subarray(0,part.bytesRead);digest.update(bytes);if(retain)chunks.push(Buffer.from(bytes));}
      const after=await handle.stat({bigint:true}),current=await io.lstat(file,{bigint:true});
      if(!sameIdentity(identity(after),identity(before))||!sameIdentity(identity(current),identity(before))||current.isSymbolicLink()
        ||after.nlink!==1n||current.nlink!==1n||after.size!==before.size||current.size!==before.size||count!==Number(before.size)
        ||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs||current.mtimeNs!==after.mtimeNs||current.ctimeNs!==after.ctimeNs)throw fail('record_changed');
      return {bytes:retain?Buffer.concat(chunks,count):null,sha256:digest.digest('hex'),size:count,identity:identity(after)};
    }finally{scratch.fill(0);for(const chunk of chunks)chunk.fill(0);await handle.close();}
  }
  function create({base,ownership,assertExclusive,readAuthority,assertDurableBackup,flush}={}) {
    if(!absolute(base)||p.parse(base).root===base||typeof assertExclusive!=='function'||typeof readAuthority!=='function')throw fail('host_invalid');
    const root=p.join(base,'.work-data'),file=p.join(root,NAME),issued=new WeakMap();let writing=false;
    const admission=async()=>{if(!ownership||!Array.isArray(ownership.roots)||!ownership.roots.some(value=>fold(value)===fold(base))||await assertExclusive(ownership)!==true)throw fail('ownership_required');await directory(base);};
    const selected=async()=>{const actual=await readAuthority(),value={generation:actual?.generation,id:actual?.id,mode:actual?.mode,sha256:actual?.sha256===undefined?actual?.proof?.sha256:actual.sha256};if(!authority(value))throw fail('authority_invalid');return value;};
    async function inspect() {await admission();if(!await directory(root,true))return {present:false};const names=await io.readdir(root);if(names.some(name=>fold(name).startsWith(STAGE)))throw fail('stage_pending');
      if(!names.some(name=>fold(name)===NAME))return {present:false};const captured=await capture(file,LIMIT,true);return {present:true,captured,value:decode(captured.bytes)};}
    async function backup(value) {
      if(inside(base,value.path))throw fail('backup_invalid');const captured=await capture(value.path,value.bytes,false);
      if(captured.size!==value.bytes||captured.sha256!==value.sha256||!sameIdentity(captured.identity,value.identity))throw fail('backup_changed');
    }
    const sameRecord=(a,b)=>a.sha256===b.sha256&&sameIdentity(a.identity,b.identity);
    async function read() {
      const found=await inspect();if(!found.present)return null;
      if(!sameAuthority(found.value.authority,await selected()))return null;
      await backup(found.value.backup);if(!sameAuthority(found.value.authority,await selected()))throw fail('record_changed');
      const final=await inspect();if(!final.present||!sameRecord(found.captured,final.captured))throw fail('record_changed');
      return freeze({...found.value,proof:{sha256:found.captured.sha256,identity:found.captured.identity}});
    }
    async function verify(receipt) {
      const known=issued.get(receipt);if(!known)throw fail('receipt_invalid');const current=await inspect();
      if(!current.present||!sameRecord(current.captured,known.proof)||!sameAuthority(known.value.authority,await selected()))throw fail('record_changed');
      await backup(known.value.backup);if(!sameAuthority(known.value.authority,await selected()))throw fail('record_changed');
      const final=await inspect();if(!final.present||!sameRecord(final.captured,known.proof))throw fail('record_changed');return true;
    }
    async function write(value) {
      // Capture private parsed state before the first await. Callback/caller
      // mutation cannot upgrade an export/restore into an activated result.
      let bytes,privateValue;try{bytes=Buffer.from(JSON.stringify(value));privateValue=decode(bytes);}catch{throw fail('record_invalid');}
      if(writing)throw fail('busy');if(typeof assertDurableBackup!=='function'||typeof flush!=='function')throw fail('writer_unavailable');writing=true;
      try {
        const previous=await inspect();if(!sameAuthority(privateValue.authority,await selected()))throw fail('authority_changed');
        if(inside(base,privateValue.backup.path)||privateValue.restored&&(inside(base,privateValue.restored.target)||inside(privateValue.restored.target,base)))throw fail('backup_invalid');
        if(await assertDurableBackup(privateValue.backup)!==true)throw fail('backup_unverified');await backup(privateValue.backup);await admission();
        if(!await directory(root,true)){await io.mkdir(root);await directory(root);}
        const stage=p.join(root,STAGE+c.randomBytes(24).toString('hex')+'.json'),handle=await io.open(stage,'wx',0o600);
        try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
        await flush([root,base]);await admission();if(!sameAuthority(privateValue.authority,await selected()))throw fail('authority_changed');
        if(previous.present){if(!sameRecord(previous.captured,await capture(file,LIMIT,true)))throw fail('record_changed');}
        else {try{await io.lstat(file);throw fail('record_changed');}catch(error){if(error.code!=='ENOENT')throw error;}}
        await io.rename(stage,file);await flush([root,base]);await admission();
        const proof=await capture(file,LIMIT,true);if(proof.sha256!==hash(bytes))throw fail('record_changed');
        const receipt=freeze({name:'.work-data/'+NAME,sha256:proof.sha256,identity:proof.identity});issued.set(receipt,{proof,value:privateValue});
        await verify(receipt);return receipt;
      }finally{writing=false;}
    }
    return Object.freeze({write,verify,read,inspect});
  }
  return Object.freeze({NAME,STAGE,validate,decode,create});
})(require('node:fs/promises'),require('node:path'),require('node:crypto'));
